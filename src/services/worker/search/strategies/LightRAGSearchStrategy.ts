/**
 * LightRAGSearchStrategy — semantic search через LightRAG.
 *
 * LightRAG — критическая зависимость для нашей системы памяти.
 * Эта стратегия НЕ имеет fallback на Chroma/SQLite.
 *
 * При недоступности LightRAG бросаем LightRAGUnavailableError, чтобы:
 * 1. Caller сразу узнал о проблеме (не теряем данные молча)
 * 2. UI/CLI показал внятное сообщение с инструкцией восстановления
 * 3. Не было раздвоения данных между LightRAG и Chroma при разной нагрузке
 *
 * Если LightRAG возвращает пустой результат (запрос валидный, но ничего
 * не найдено) — это нормальное состояние, отдаём пустой результат.
 *
 * Если LightRAG offline или возвращает 5xx — это ошибка инфраструктуры,
 * её нужно показать.
 */

import { BaseSearchStrategy } from './SearchStrategy.js';
import type { StrategySearchOptions, StrategySearchResult } from '../types.js';
import type { ObservationSearchResult } from '../../../sqlite/types.js';
import { LightRAGClient } from '../../knowledge/LightRAGClient.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Бросается, когда LightRAG offline или вернул серверную ошибку.
 * Это не "пустой результат" — это поломанная инфраструктура.
 */
export class LightRAGUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LightRAGUnavailableError';
  }
}

export class LightRAGSearchStrategy extends BaseSearchStrategy {
  readonly name = 'lightrag';
  private readonly client: LightRAGClient;

  constructor(client?: LightRAGClient) {
    super();
    this.client = client ?? new LightRAGClient();
  }

  /**
   * Стратегия handle любые query с текстом. Filter-only пусть берёт SQLite
   * (это не fallback, а нормальный путь — у LightRAG нет filter-only режима).
   */
  canHandle(options: StrategySearchOptions): boolean {
    return !!options.query && options.query.length > 0;
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const startMs = Date.now();

    // Health-check — если LightRAG offline, бросаем ошибку явно.
    const healthy = await this.client.health();
    if (!healthy) {
      const url = this.client.getBaseUrl();
      throw new LightRAGUnavailableError(
        `LightRAG недоступен по адресу ${url}. ` +
          `Проверь, что Docker-контейнер lightrag-mac запущен (docker ps), ` +
          `и что Ollama отвечает на http://localhost:11434. ` +
          `Память сейчас не работает — это критическая зависимость.`
      );
    }

    const filter = this.buildFilter(options);

    let lightragResult;
    try {
      lightragResult = await this.client.query({
        query: options.query!,
        mode: 'hybrid',
        only_need_context: false,
        top_k: options.limit ?? 10,
        rerank: true,
        filter,
        max_token_for_global_context: 512,
        max_token_for_local_context: 512,
        max_token_for_text_unit: 256,
      });
    } catch (err) {
      // Ошибка во время самого запроса (после успешного health check) —
      // тоже критическая, бросаем дальше
      const errObj = err instanceof Error ? err : new Error(String(err));
      throw new LightRAGUnavailableError(
        `LightRAG query failed: ${errObj.message}`,
        errObj
      );
    }

    const items = lightragResult.results ?? [];

    // Пустой результат — НОРМАЛЬНО (запрос валидный, ничего не нашлось).
    // Это не повод бросать ошибку и не повод fallback'ить.
    if (items.length === 0) {
      logger.debug('SEARCH', 'LightRAG returned 0 results (valid query, nothing matched)', {
        query: options.query?.slice(0, 80),
      });
      return {
        results: { observations: [], sessions: [], prompts: [] },
        usedChroma: false,
        strategy: 'lightrag',
      };
    }

    const observations: ObservationSearchResult[] = items.map((item, index) =>
      this.mapToObservation(item, index)
    );

    const elapsedMs = Date.now() - startMs;
    logger.debug('SEARCH', 'LightRAG search completed', {
      results: observations.length,
      elapsedMs,
    });

    return {
      results: {
        observations,
        sessions: [],
        prompts: [],
      },
      usedChroma: false,
      strategy: 'lightrag',
    };
  }

  /**
   * Построение фильтра для LightRAG из опций search.
   * Сейчас — только по project. В будущем расширим (по type, по date range).
   */
  private buildFilter(
    options: StrategySearchOptions
  ): { tags?: { $contains?: string } } | undefined {
    const project = (options as any).project;
    if (typeof project === 'string' && project.length > 0) {
      return { tags: { $contains: `project:${project.toLowerCase()}` } };
    }
    return undefined;
  }

  /**
   * Маппинг ответа LightRAG в формат ObservationSearchResult, ожидаемый
   * форматтером claude-mem.
   */
  private mapToObservation(
    item: { content: string; metadata: Record<string, any>; score: number; id?: string },
    rank: number
  ): ObservationSearchResult {
    const meta = item.metadata ?? {};
    const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];

    // Извлекаем структурированные поля из тегов
    const projectTag = tags.find((t) => t.startsWith('project:'));
    const typeTag = tags.find((t) => t.startsWith('type:'));
    const dateTag = tags.find((t) => t.startsWith('date:'));

    const project = projectTag ? projectTag.slice('project:'.length) : 'unknown';
    const obsType = this.parseObsType(typeTag ? typeTag.slice('type:'.length) : 'episode');
    const createdAt = dateTag
      ? `${dateTag.slice('date:'.length)}T00:00:00.000Z`
      : new Date().toISOString();

    // Парсим title / subtitle / narrative из content (markdown).
    const lines = item.content.split('\n');
    let title: string | null = null;
    let subtitle: string | null = null;
    const bodyLines: string[] = [];

    for (const line of lines) {
      if (title === null && line.startsWith('# ')) {
        title = line.slice(2).trim();
      } else if (subtitle === null && title !== null && line.trim() && !line.startsWith('#')) {
        subtitle = line.trim();
      } else {
        bodyLines.push(line);
      }
    }

    const narrative = bodyLines.join('\n').trim() || null;
    const numericId = item.id ? this.hashStringToInt(item.id) : rank;

    return {
      id: numericId,
      memory_session_id: meta.session_id ?? '',
      project,
      text: item.content,
      type: obsType,
      title,
      subtitle,
      facts: null,
      narrative,
      concepts: null,
      files_read: null,
      files_modified: null,
      prompt_number: null,
      discovery_tokens: 0,
      created_at: createdAt,
      created_at_epoch: Date.parse(createdAt) || Date.now(),
      score: item.score,
      rank,
    };
  }

  private parseObsType(value: string): ObservationSearchResult['type'] {
    const valid: ObservationSearchResult['type'][] = [
      'decision',
      'bugfix',
      'feature',
      'refactor',
      'discovery',
      'change',
    ];
    return (valid as string[]).includes(value)
      ? (value as ObservationSearchResult['type'])
      : 'discovery';
  }

  private hashStringToInt(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return Math.abs(hash);
  }
}
