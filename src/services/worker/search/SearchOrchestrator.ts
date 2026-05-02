/**
 * SearchOrchestrator - Coordinates search strategies
 *
 * MODIFIED FOR LIGHTRAG FORK (Gl0balRak/claude-mem-lightrag):
 * - LightRAG is the primary semantic search backend (replaces Chroma)
 * - NO fallback to Chroma/SQLite for semantic queries — if LightRAG is offline,
 *   we throw LightRAGUnavailableError with clear instructions
 * - SQLite remains used ONLY for filter-only queries (no query text), which is
 *   not a "fallback" but a separate path that LightRAG doesn't handle
 * - findByConcept / findByType / findByFile use SQLite for metadata-only;
 *   semantic enrichment via Hybrid is currently disabled in this fork
 *   (re-enable if LightRAG metadata-search supports it)
 *
 * Why no fallback for LightRAG:
 * - LightRAG is the single source of truth for our agent memory
 * - Falling back to Chroma would split data between backends, leading to
 *   silent divergence and lost memories at recovery time
 * - An explicit error is preferred over degraded behavior
 */

import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';

import { LightRAGSearchStrategy, LightRAGUnavailableError } from './strategies/LightRAGSearchStrategy.js';
import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';

import { ResultFormatter } from './ResultFormatter.js';
import { TimelineBuilder } from './TimelineBuilder.js';
import type { TimelineItem, TimelineData } from './TimelineBuilder.js';

import {
  SEARCH_CONSTANTS,
} from './types.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  SearchResults,
  ObservationSearchResult
} from './types.js';
import { logger } from '../../../utils/logger.js';

interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

export class SearchOrchestrator {
  private lightragStrategy: LightRAGSearchStrategy;
  private sqliteStrategy: SQLiteSearchStrategy;
  private resultFormatter: ResultFormatter;
  private timelineBuilder: TimelineBuilder;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync | null  // unused now, kept for upstream API compat
  ) {
    this.lightragStrategy = new LightRAGSearchStrategy();
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);
    this.resultFormatter = new ResultFormatter();
    this.timelineBuilder = new TimelineBuilder();
  }

  /**
   * Main search entry point
   */
  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);
    return await this.executeSearch(options);
  }

  /**
   * Execute search:
   * - Filter-only (no query) → SQLite (separate code path, not a fallback)
   * - Semantic (with query) → LightRAG ONLY, error on offline
   */
  private async executeSearch(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query → SQLite path', {});
      return await this.sqliteStrategy.search(options);
    }

    logger.debug('SEARCH', 'Orchestrator: Semantic query → LightRAG (no fallback)', {});
    // LightRAGSearchStrategy throws LightRAGUnavailableError if offline.
    // We let it propagate to caller — explicit error is correct behavior here.
    return await this.lightragStrategy.search(options);
  }

  /**
   * Find by concept — currently uses SQLite metadata-only.
   * To restore semantic enrichment: query LightRAG with concept as tag filter.
   */
  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);
    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by type — SQLite metadata-only.
   */
  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);
    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by file — SQLite metadata-only.
   */
  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
    usedChroma: boolean;
  }> {
    const options = this.normalizeParams(args);
    const results = this.sqliteStrategy.findByFile(filePath, options);
    return { ...results, usedChroma: false };
  }

  /**
   * Get timeline around anchor
   */
  getTimeline(
    timelineData: TimelineData,
    anchorId: number | string,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number
  ): TimelineItem[] {
    const items = this.timelineBuilder.buildTimeline(timelineData);
    return this.timelineBuilder.filterByDepth(items, anchorId, anchorEpoch, depthBefore, depthAfter);
  }

  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    options: { query?: string; depthBefore?: number; depthAfter?: number; } = {}
  ): string {
    return this.timelineBuilder.formatTimeline(items, anchorId, options);
  }

  formatSearchResults(
    results: SearchResults,
    query: string,
    chromaFailed: boolean = false
  ): string {
    return this.resultFormatter.formatSearchResults(results, query, chromaFailed);
  }

  getFormatter(): ResultFormatter {
    return this.resultFormatter;
  }

  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }

  /**
   * Normalize query parameters from URL-friendly format
   */
  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }

  /**
   * @deprecated kept for upstream API compatibility — returns false, we use LightRAG.
   */
  isChromaAvailable(): boolean {
    return false;
  }

  /**
   * Check if LightRAG is reachable.
   */
  async isLightRAGAvailable(): Promise<boolean> {
    try {
      await this.lightragStrategy.search({ query: '__health_probe__', limit: 1 } as any);
      return true;
    } catch (err) {
      if (err instanceof LightRAGUnavailableError) return false;
      throw err;
    }
  }
}
