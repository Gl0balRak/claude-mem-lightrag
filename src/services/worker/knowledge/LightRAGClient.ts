/**
 * LightRAGClient — HTTP клиент к локальному LightRAG-серверу.
 *
 * По умолчанию ходит на http://localhost:9621 (LightRAG в Docker на Mac).
 * Можно переопределить через ENV `LIGHTRAG_URL`.
 *
 * Все методы — fire-and-forget по умолчанию: если LightRAG offline,
 * возвращают пустые результаты или null без бросания исключений.
 * Это критично, потому что хук UserPromptSubmit не должен падать,
 * если LightRAG временно недоступен.
 */

import { logger } from '../../../utils/logger.js';

export interface LightRAGTags {
  project?: string;
  area?: string;
  type?: 'fact' | 'episode' | 'decision' | 'hypothesis' | 'insight' | 'outdated';
  source?: 'claude-mem' | 'vault-sync' | 'reflexion' | 'manual';
  date?: string; // YYYY-MM-DD
  confidence?: 'high' | 'medium' | 'low';
  [key: string]: any;
}

export interface LightRAGInsertParams {
  id: string;
  content: string;
  metadata: {
    tags: string[];
    source_file?: string;
    session_id?: string;
    original_id?: string | number;
    [key: string]: any;
  };
}

export interface LightRAGQueryParams {
  query: string;
  mode?: 'naive' | 'local' | 'global' | 'hybrid';
  only_need_context?: boolean;
  top_k?: number;
  rerank?: boolean;
  filter?: { tags?: { $contains?: string } };
  max_token_for_global_context?: number;
  max_token_for_local_context?: number;
  max_token_for_text_unit?: number;
}

export interface LightRAGQueryResultItem {
  content: string;
  metadata: Record<string, any>;
  score: number;
  id?: string;
}

export interface LightRAGQueryResult {
  context?: string;
  results?: LightRAGQueryResultItem[];
}

const DEFAULT_TIMEOUT_MS = 5000;

export class LightRAGClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private healthCache: { value: boolean; checkedAt: number } | null = null;
  private readonly HEALTH_CACHE_TTL_MS = 30_000;

  constructor(baseUrl?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl ?? process.env.LIGHTRAG_URL ?? 'http://localhost:9621';
    this.timeoutMs = timeoutMs;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Cached health check — экономит round-trips при частых вызовах из hooks.
   */
  async health(): Promise<boolean> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.checkedAt < this.HEALTH_CACHE_TTL_MS) {
      return this.healthCache.value;
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      const ok = res.ok;
      this.healthCache = { value: ok, checkedAt: now };
      return ok;
    } catch {
      this.healthCache = { value: false, checkedAt: now };
      return false;
    }
  }

  /**
   * Insert document. Тихий fail при ошибке — caller получает false.
   */
  async insertDocument(params: LightRAGInsertParams): Promise<boolean> {
    if (!await this.health()) return false;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.baseUrl}/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch (err) {
      logger.warn('WORKER', 'LightRAG insertDocument failed (non-critical)', {
        id: params.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Delete document by ID. Тихий fail.
   */
  async deleteDocument(id: string): Promise<boolean> {
    if (!await this.health()) return false;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.baseUrl}/documents/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch (err) {
      logger.warn('WORKER', 'LightRAG deleteDocument failed (non-critical)', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Delete documents matching tag filter. Используется для cleanup corpus
   * при удалении / переименовании.
   */
  async deleteByTag(tag: string): Promise<number> {
    if (!await this.health()) return 0;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.baseUrl}/documents/by-tag`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return 0;
      const json = await res.json() as { deleted_count?: number };
      return json.deleted_count ?? 0;
    } catch (err) {
      logger.warn('WORKER', 'LightRAG deleteByTag failed (non-critical)', { tag });
      return 0;
    }
  }

  /**
   * Query LightRAG. Возвращает пустой результат, если LightRAG offline.
   * Это позволяет search orchestrator плавно переключиться на fallback.
   */
  async query(params: LightRAGQueryParams): Promise<LightRAGQueryResult> {
    if (!await this.health()) return { results: [] };

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs * 2); // query может быть медленным
      const res = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        logger.warn('WORKER', `LightRAG query returned ${res.status}`);
        return { results: [] };
      }

      return await res.json() as LightRAGQueryResult;
    } catch (err) {
      logger.warn('WORKER', 'LightRAG query failed (non-critical)', {
        query: params.query.slice(0, 100),
        error: err instanceof Error ? err.message : String(err),
      });
      return { results: [] };
    }
  }

  /**
   * Получить общее количество документов в индексе.
   */
  async getDocumentsCount(): Promise<number> {
    if (!await this.health()) return 0;

    try {
      const res = await fetch(`${this.baseUrl}/documents/count`);
      if (!res.ok) return 0;
      const json = await res.json() as { count: number };
      return json.count;
    } catch {
      return 0;
    }
  }
}

/**
 * Сериализация структурированных тегов в плоский массив для LightRAG.
 * Пример: { project: 'labpf', type: 'episode' } → ['project:labpf', 'type:episode']
 */
export function serializeTags(tags: LightRAGTags): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        result.push(`${key}:${v}`);
      }
    } else {
      result.push(`${key}:${value}`);
    }
  }
  return result;
}
