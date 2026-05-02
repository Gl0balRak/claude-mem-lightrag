/**
 * CorpusStore - File I/O for corpus JSON files
 *
 * MODIFIED FOR LIGHTRAG FORK:
 * - On write/delete, additionally syncs to LightRAG (fire-and-forget)
 * - When LightRAG is offline, the local JSON file is still written (no data loss),
 *   but the LightRAGCorpusSync writes a pending entry to outbox and logs a
 *   visible warning. Outbox is drained on next start when LightRAG is back.
 * - This is NOT a fallback — local JSON is the canonical write path inside
 *   claude-mem (always written), LightRAG is an additional indexing layer.
 *
 * Manages reading, writing, listing, and deleting corpus files
 * stored in ~/.claude-mem/corpora/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../../../utils/logger.js';
import type { CorpusFile, CorpusStats } from './types.js';
import { getLightRAGCorpusSync } from './LightRAGCorpusSync.js';

const CORPORA_DIR = path.join(os.homedir(), '.claude-mem', 'corpora');

export class CorpusStore {
  private readonly corporaDir: string;

  constructor() {
    this.corporaDir = CORPORA_DIR;
    if (!fs.existsSync(this.corporaDir)) {
      fs.mkdirSync(this.corporaDir, { recursive: true });
      logger.debug('WORKER', `Created corpora directory: ${this.corporaDir}`);
    }
  }

  /**
   * Write a corpus file to disk as {name}.corpus.json
   * Additionally syncs to LightRAG asynchronously (fire-and-forget with
   * VISIBLE error logging — not silent).
   */
  write(corpus: CorpusFile): void {
    const filePath = this.getFilePath(corpus.name);
    fs.writeFileSync(filePath, JSON.stringify(corpus, null, 2), 'utf-8');
    logger.debug('WORKER', `Wrote corpus file: ${filePath} (${corpus.observations.length} observations)`);

    // LightRAG sync — fire-and-forget. If LightRAG is offline, the sync method
    // throws LightRAGUnavailableError, which writes the corpus to outbox.
    // We log the error visibly so user knows memory indexing is degraded.
    getLightRAGCorpusSync().syncCorpus(corpus).catch((err) => {
      logger.error(
        'WORKER',
        `LightRAG corpus sync FAILED for "${corpus.name}". ` +
          `Local JSON is saved, but semantic search will not see this corpus until ` +
          `LightRAG is back online and outbox is drained.`,
        { corpus: corpus.name },
        err instanceof Error ? err : new Error(String(err))
      );
    });
  }

  /**
   * Read a corpus file by name, return null if not found
   */
  read(name: string): CorpusFile | null {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CorpusFile;
    } catch (error) {
      if (error instanceof Error) {
        logger.error('WORKER', `Failed to read corpus file: ${filePath}`, {}, error);
      } else {
        logger.error('WORKER', `Failed to read corpus file: ${filePath} (non-Error thrown)`, { thrownValue: String(error) });
      }
      return null;
    }
  }

  /**
   * List all corpora metadata
   */
  list(): Array<{ name: string; description: string; stats: CorpusStats; session_id: string | null }> {
    if (!fs.existsSync(this.corporaDir)) {
      return [];
    }

    const files = fs.readdirSync(this.corporaDir).filter(f => f.endsWith('.corpus.json'));
    const results: Array<{ name: string; description: string; stats: CorpusStats; session_id: string | null }> = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.corporaDir, file), 'utf-8');
        const corpus = JSON.parse(raw) as CorpusFile;
        results.push({
          name: corpus.name,
          description: corpus.description,
          stats: corpus.stats,
          session_id: corpus.session_id,
        });
      } catch (error) {
        if (error instanceof Error) {
          logger.error('WORKER', `Failed to parse corpus file: ${file}`, {}, error);
        } else {
          logger.error('WORKER', `Failed to parse corpus file: ${file} (non-Error thrown)`, { thrownValue: String(error) });
        }
      }
    }

    return results;
  }

  /**
   * Delete a corpus file, return true if it existed.
   * Additionally deletes corresponding documents from LightRAG.
   */
  delete(name: string): boolean {
    const filePath = this.getFilePath(name);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    logger.debug('WORKER', `Deleted corpus file: ${filePath}`);

    // LightRAG sync delete
    getLightRAGCorpusSync().deleteCorpus(name).catch((err) => {
      logger.error(
        'WORKER',
        `LightRAG corpus delete FAILED for "${name}". ` +
          `Local file removed, but LightRAG documents may persist until ` +
          `LightRAG is online and outbox drains.`,
        { corpus: name },
        err instanceof Error ? err : new Error(String(err))
      );
    });

    return true;
  }

  /**
   * Validate corpus name to prevent path traversal
   */
  private validateCorpusName(name: string): string {
    const trimmed = name.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
      throw new Error('Invalid corpus name: only alphanumeric characters, dots, hyphens, and underscores are allowed');
    }
    return trimmed;
  }

  /**
   * Resolve the full file path for a corpus by name
   */
  private getFilePath(name: string): string {
    const safeName = this.validateCorpusName(name);
    const resolved = path.resolve(this.corporaDir, `${safeName}.corpus.json`);
    if (!resolved.startsWith(path.resolve(this.corporaDir) + path.sep)) {
      throw new Error('Invalid corpus name');
    }
    return resolved;
  }
}
