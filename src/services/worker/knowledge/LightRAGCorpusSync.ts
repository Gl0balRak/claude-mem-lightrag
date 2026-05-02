/**
 * LightRAGCorpusSync — синхронизация corpora из claude-mem в LightRAG.
 *
 * LightRAG — критическая зависимость памяти. Sync НЕ молчит при недоступности —
 * бросает LightRAGUnavailableError.
 *
 * Caller сам решает, как обработать:
 * - В CorpusStore.write() — мы вызываем sync асинхронно с .catch(),
 *   но catch ЛОГИРУЕТ ОШИБКУ ВИДИМО (не игнорирует). Также пишем
 *   pending записи в outbox — чтобы при восстановлении LightRAG их догнать.
 *
 * Каждое observation становится отдельным документом в LightRAG.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LightRAGClient, serializeTags, type LightRAGTags } from './LightRAGClient.js';
import { LightRAGUnavailableError } from '../search/strategies/LightRAGSearchStrategy.js';
import type { CorpusFile } from './types.js';
import { logger } from '../../../utils/logger.js';

const OUTBOX_DIR = path.join(os.homedir(), '.claude-mem', 'lightrag-outbox');

interface OutboxEntry {
  type: 'sync-corpus' | 'delete-corpus';
  timestamp: string;
  payload: any; // CorpusFile или { name: string }
}

export class LightRAGCorpusSync {
  private readonly client: LightRAGClient;
  private readonly project: string;

  constructor(client?: LightRAGClient, projectOverride?: string) {
    this.client = client ?? new LightRAGClient();
    this.project = projectOverride ?? this.detectProject();

    if (!fs.existsSync(OUTBOX_DIR)) {
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    }
  }

  private detectProject(): string {
    const cwd = process.cwd();
    const normalized = cwd.replace(/\\/g, '/');
    const match = normalized.match(/\/Projects\/([^/]+)/i);
    return match ? match[1].toLowerCase() : 'cross-cutting';
  }

  /**
   * Sync целого corpus в LightRAG.
   * Если LightRAG недоступен — записывает в outbox и бросает ошибку.
   */
  async syncCorpus(corpus: CorpusFile): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    const healthy = await this.client.health();
    if (!healthy) {
      // Записываем в outbox для последующего drain
      this.writeOutboxEntry({
        type: 'sync-corpus',
        timestamp: new Date().toISOString(),
        payload: corpus,
      });

      throw new LightRAGUnavailableError(
        `LightRAG недоступен по адресу ${this.client.getBaseUrl()}. ` +
          `Corpus "${corpus.name}" сохранён в outbox (${OUTBOX_DIR}). ` +
          `Когда LightRAG поднимется — запустить drainOutbox() для синка отложенных записей.`
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const observations = corpus.observations ?? [];

    for (const obs of observations) {
      const obsId = (obs as any).id ?? Math.random().toString(36).slice(2);
      const obsContent = this.formatObservationContent(obs);

      const tags: LightRAGTags = {
        project: this.project,
        type: this.mapObservationType((obs as any).type),
        source: 'claude-mem',
        date: today,
        confidence: 'medium',
        corpus: corpus.name,
      };

      const ok = await this.client.insertDocument({
        id: `claude-mem-${corpus.name}-${obsId}`,
        content: obsContent,
        metadata: {
          tags: serializeTags(tags),
          session_id: corpus.session_id ?? undefined,
          original_id: obsId,
          corpus_name: corpus.name,
          observation_type: (obs as any).type,
        },
      });

      if (ok) synced++;
      else failed++;
    }

    if (failed > 0) {
      throw new LightRAGUnavailableError(
        `LightRAG sync неполный: ${synced} OK, ${failed} failed для corpus "${corpus.name}". ` +
          `Проверь статус LightRAG.`
      );
    }

    if (synced > 0) {
      logger.info('WORKER', 'LightRAG corpus sync done', {
        corpus: corpus.name,
        synced,
      });
    }

    return { synced, failed };
  }

  /**
   * Удалить corpus из LightRAG (по тегу corpus:<name>).
   */
  async deleteCorpus(name: string): Promise<number> {
    const healthy = await this.client.health();
    if (!healthy) {
      this.writeOutboxEntry({
        type: 'delete-corpus',
        timestamp: new Date().toISOString(),
        payload: { name },
      });
      throw new LightRAGUnavailableError(
        `LightRAG недоступен. Запрос на удаление corpus "${name}" сохранён в outbox.`
      );
    }
    const deleted = await this.client.deleteByTag(`corpus:${name}`);
    logger.info('WORKER', 'LightRAG corpus deleted', { corpus: name, deleted });
    return deleted;
  }

  /**
   * Drain — обработать накопленные в outbox записи.
   * Вызывается при старте процесса или из CLI команды.
   */
  async drainOutbox(): Promise<{ drained: number; failed: number }> {
    if (!fs.existsSync(OUTBOX_DIR)) return { drained: 0, failed: 0 };

    if (!await this.client.health()) {
      throw new LightRAGUnavailableError(
        'LightRAG всё ещё недоступен — drainOutbox прерван.'
      );
    }

    const files = fs.readdirSync(OUTBOX_DIR).filter((f) => f.endsWith('.json')).sort();
    let drained = 0;
    let failed = 0;

    for (const file of files) {
      const filePath = path.join(OUTBOX_DIR, file);
      try {
        const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as OutboxEntry;
        if (entry.type === 'sync-corpus') {
          await this.syncCorpus(entry.payload as CorpusFile);
        } else if (entry.type === 'delete-corpus') {
          await this.deleteCorpus(entry.payload.name);
        }
        fs.unlinkSync(filePath);
        drained++;
      } catch (err) {
        logger.error('WORKER', `Failed to drain outbox entry ${file}`, {}, err as Error);
        failed++;
      }
    }

    logger.info('WORKER', 'Outbox drained', { drained, failed });
    return { drained, failed };
  }

  private writeOutboxEntry(entry: OutboxEntry): void {
    const fileName = `${entry.timestamp.replace(/[:.]/g, '-')}-${entry.type}.json`;
    const filePath = path.join(OUTBOX_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    logger.warn('WORKER', `LightRAG offline — outbox entry written: ${filePath}`);
  }

  private mapObservationType(
    obsType: string | undefined
  ): 'fact' | 'episode' | 'decision' | 'hypothesis' | 'insight' {
    if (!obsType) return 'episode';
    const lower = obsType.toLowerCase();
    if (lower.includes('decision')) return 'decision';
    if (lower.includes('discovery')) return 'insight';
    if (lower === 'fact') return 'fact';
    if (lower === 'hypothesis') return 'hypothesis';
    return 'episode';
  }

  private formatObservationContent(obs: any): string {
    const parts: string[] = [];

    if (obs.title) parts.push(`# ${obs.title}`);
    if (obs.subtitle) parts.push(obs.subtitle);
    if (obs.narrative) parts.push(obs.narrative);
    else if (obs.text) parts.push(obs.text);

    if (Array.isArray(obs.facts) && obs.facts.length) {
      parts.push('\n**Facts:**');
      parts.push(...obs.facts.map((f: string) => `- ${f}`));
    }

    if (Array.isArray(obs.concepts) && obs.concepts.length) {
      parts.push(`\n**Concepts:** ${obs.concepts.join(', ')}`);
    }

    if (Array.isArray(obs.files_read) && obs.files_read.length) {
      parts.push(`**Files read:** ${obs.files_read.join(', ')}`);
    }
    if (Array.isArray(obs.files_modified) && obs.files_modified.length) {
      parts.push(`**Files modified:** ${obs.files_modified.join(', ')}`);
    }

    return parts.join('\n');
  }
}

let singleton: LightRAGCorpusSync | null = null;

export function getLightRAGCorpusSync(): LightRAGCorpusSync {
  if (!singleton) {
    singleton = new LightRAGCorpusSync();
  }
  return singleton;
}
