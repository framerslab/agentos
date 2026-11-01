/**
 * @fileoverview Universal streaming migration engine between vector store backends.
 * @module rag/migration/MigrationEngine
 *
 * Streams data in configurable batches between any pair of supported backends
 * (SQLite, Postgres, Qdrant). Never loads the entire dataset into memory.
 *
 * Usage:
 * ```typescript
 * import { MigrationEngine } from '@framers/agentos';
 *
 * await MigrationEngine.migrate({
 *   from: { type: 'sqlite', path: './brain.sqlite' },
 *   to: { type: 'postgres', connectionString: 'postgresql://...' },
 *   batchSize: 1000,
 *   onProgress: (done, total, table) => console.log(`${table}: ${done}/${total}`),
 * });
 * ```
 */

import type {
  MigrationOptions,
  MigrationResult,
  IMigrationSource,
  IMigrationTarget,
  BackendConfig,
} from './types.js';
import {
  ABSENT_BRAIN,
  ENCODED_SCOPE_ID_FORM,
  SCOPE_ID_FORM_KEY,
  scopeIdFormHandshake,
} from '../../memory/retrieval/store/scopeIdForm.js';

/** Why a source that names no brain is refused into a target brain that holds the encoded form and traces. */
function unreadSourceRefusal(brainId: string): string {
  return (
    `brain '${brainId}': the target holds the encoded scope-id form ('${SCOPE_ID_FORM_KEY}' = '${ENCODED_SCOPE_ID_FORM}' in ` +
    `brain_meta) and traces, and the source names no brain whose scope ids the handshake can read. Copy it into a ` +
    `target without the record, then open that target under a learning layer, which re-files it.`
  );
}

/** Why a source brain that holds the record is refused into a target that cannot report its forms. */
function unreadTargetRefusal(brainId: string): string {
  return (
    `brain '${brainId}': the source holds the encoded scope-id form ('${SCOPE_ID_FORM_KEY}' = '${ENCODED_SCOPE_ID_FORM}' in ` +
    `brain_meta), and the target cannot report the form of what it holds. Copy it into a SQLite or Postgres target, or ` +
    `a Qdrant target with a sidecar.`
  );
}

// ---------------------------------------------------------------------------
// MigrationEngine
// ---------------------------------------------------------------------------

export class MigrationEngine {
  /**
   * Migrate data between any two backends.
   *
   * The engine:
   * 1. Connects to source and target, and runs the scope-id form handshake for
   *    each brain the source holds (`brain_meta.scope_id_form`, which a learning
   *    layer writes): where the two sides disagree in a way a copy of the rows
   *    as they are cannot keep, it refuses the whole migration, naming the
   *    record, before it copies any table. A source brain with the record
   *    whose `user` and `persona` scope ids read the same in both forms is
   *    copied as a plain one, and a target without the record gets none.
   * 2. Lists the source's tables and, for each one, reads rows in streaming batches.
   * 3. Creates the table in the target (if it doesn't exist).
   * 4. Writes each batch to the target.
   * 5. Reports progress after each batch.
   *
   * @param options - Source, target, batch size, and progress callback.
   * @returns Migration result with counts, duration, and any errors.
   */
  static async migrate(options: MigrationOptions): Promise<MigrationResult> {
    const startTime = Date.now();
    const batchSize = options.batchSize ?? 1000;
    const errors: string[] = [];
    const tablesProcessed: string[] = [];
    let totalRows = 0;

    // Create source and target adapters via dynamic import (lazy loading).
    const source = await MigrationEngine._createSource(options.from);
    const target = await MigrationEngine._createTarget(options.to);

    try {
      // The scope-id form handshake, before any table is copied: a brain whose two sides disagree in a way the copy
      // cannot keep refuses the whole migration, naming the record.
      const handshake = await MigrationEngine._scopeIdFormHandshake(source, target);
      if (handshake.refused.length > 0) {
        errors.push(...handshake.refused);
        return { tablesProcessed: [], totalRows: 0, durationMs: Date.now() - startTime, verified: false, errors };
      }

      const tables = await source.listTables();

      for (const table of tables) {
        try {
          const count = await source.countRows(table);
          if (count === 0) {
            tablesProcessed.push(table);
            continue;
          }

          // Dry run: just count and report progress.
          if (options.dryRun) {
            options.onProgress?.(count, count, table);
            totalRows += count;
            tablesProcessed.push(table);
            continue;
          }

          // Read first batch to get a sample row for schema inference.
          const firstBatch = await source.readBatch(table, 0, batchSize);
          if (firstBatch.length === 0) {
            tablesProcessed.push(table);
            continue;
          }

          // Ensure target table exists (creates schema from sample row).
          await target.ensureTable(table, firstBatch[0]);

          // Write first batch.
          let written = await target.writeBatch(table, firstBatch);
          totalRows += written;
          options.onProgress?.(written, count, table);

          // Stream remaining batches.
          let offset = firstBatch.length;
          while (offset < count) {
            const batch = await source.readBatch(table, offset, batchSize);
            if (batch.length === 0) break;

            const w = await target.writeBatch(table, batch);
            written += w;
            totalRows += w;
            offset += batch.length;
            options.onProgress?.(Math.min(offset, count), count, table);
          }

          tablesProcessed.push(table);
        } catch (err) {
          // Per-table errors are collected, not thrown — other tables still migrate.
          errors.push(`[${table}] ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!options.dryRun) {
        for (const brainId of handshake.clear) await target.clearScopeIdForm?.(brainId);
      }
    } catch (err) {
      // Fatal error (e.g. source connection failed).
      errors.push(err instanceof Error ? err.message : String(err));
    } finally {
      await source.close().catch(() => {});
      await target.close().catch(() => {});
    }

    return {
      tablesProcessed,
      totalRows,
      durationMs: Date.now() - startTime,
      verified: errors.length === 0,
      errors,
    };
  }

  /**
   * Runs the scope-id form handshake for every brain the source holds. A source brain with the record whose `user` and
   * `persona` scope ids read the same in both forms (none holds a `/`, a `%` or a `:`) is copied as a plain one: the
   * copy of `brain_meta` brings its record, which is removed from a target that did not hold one, so a target a host
   * with no learning layer serves keeps its plain form.
   *
   * A side that cannot report its forms takes part as far as it can. A source that names no brain (a Pinecone index,
   * a Qdrant source with no sidecar) copies scope ids the handshake cannot read: it is refused into a target that holds
   * the encoded form and traces, and a target that holds the record and no trace loses the record, as it does from a
   * plain source. A target that cannot report its forms (a Qdrant target with no sidecar) takes no source brain that
   * holds the record.
   */
  private static async _scopeIdFormHandshake(
    source: IMigrationSource,
    target: IMigrationTarget,
  ): Promise<{ refused: string[]; clear: string[] }> {
    if (!source.scopeIdForms) {
      if (!target.scopeIdForms) return { refused: [], clear: [] };
      const refused: string[] = [];
      const clear: string[] = [];
      for (const [brainId, held] of await target.scopeIdForms()) {
        if (!held.encoded) continue;
        if (!held.rows) clear.push(brainId);
        else refused.push(`scope_id_form: ${unreadSourceRefusal(brainId)}`);
      }
      return { refused, clear };
    }
    const from = await source.scopeIdForms();
    if (!target.scopeIdForms) {
      const refused = [...from]
        .filter(([, form]) => form.encoded)
        .map(([brainId]) => `scope_id_form: ${unreadTargetRefusal(brainId)}`);
      return { refused, clear: [] };
    }
    const to = await target.scopeIdForms([...from.keys()]);
    const refused: string[] = [];
    const clear: string[] = [];
    for (const [brainId, form] of from) {
      const held = to.get(brainId) ?? ABSENT_BRAIN;
      const copied = form.encoded && !form.reserved ? { ...form, encoded: false } : form;
      const decision = scopeIdFormHandshake(brainId, copied, held, { encodeOnWrite: false });
      if (decision.action === 'refuse') refused.push(`scope_id_form: ${decision.reason}`);
      else if (decision.action === 'clear' || (form.encoded && !copied.encoded && !held.encoded)) clear.push(brainId);
    }
    return { refused, clear };
  }

  // ---------------------------------------------------------------------------
  // Adapter factories (dynamic import for tree-shaking)
  // ---------------------------------------------------------------------------

  /**
   * Create a source adapter for the given backend type.
   * Uses dynamic imports so unused adapters don't bloat the bundle.
   */
  private static async _createSource(config: BackendConfig): Promise<IMigrationSource> {
    switch (config.type) {
      case 'sqlite': {
        const { SqliteSourceAdapter } = await import('./adapters/SqliteSourceAdapter.js');
        return new SqliteSourceAdapter(config.path!);
      }
      case 'postgres': {
        const { PostgresSourceAdapter } = await import('./adapters/PostgresSourceAdapter.js');
        return new PostgresSourceAdapter(config.connectionString!);
      }
      case 'qdrant': {
        const { QdrantSourceAdapter } = await import('./adapters/QdrantSourceAdapter.js');
        return new QdrantSourceAdapter(config.url!, config.apiKey, config.sidecarPath);
      }
      case 'pinecone': {
        const { PineconeSourceAdapter } = await import('./adapters/PineconeSourceAdapter.js');
        return new PineconeSourceAdapter(config.url!, config.apiKey!, config.collectionPrefix);
      }
      default:
        throw new Error(`Unsupported migration source type: ${(config as BackendConfig).type}`);
    }
  }

  /**
   * Create a target adapter for the given backend type.
   * Uses dynamic imports so unused adapters don't bloat the bundle.
   */
  private static async _createTarget(config: BackendConfig): Promise<IMigrationTarget> {
    switch (config.type) {
      case 'sqlite': {
        const { SqliteTargetAdapter } = await import('./adapters/SqliteTargetAdapter.js');
        return new SqliteTargetAdapter(config.path!);
      }
      case 'postgres': {
        const { PostgresTargetAdapter } = await import('./adapters/PostgresTargetAdapter.js');
        return new PostgresTargetAdapter(config.connectionString!);
      }
      case 'qdrant': {
        const { QdrantTargetAdapter } = await import('./adapters/QdrantTargetAdapter.js');
        return new QdrantTargetAdapter(config.url!, config.apiKey, config.sidecarPath);
      }
      case 'pinecone': {
        // Pinecone as a target: upsert vectors via the same PineconeVectorStore.
        // For now, use the source adapter pattern — Pinecone is typically a source
        // for migration TO self-hosted backends, not a target.
        throw new Error('Pinecone as migration target is not yet supported. Migrate FROM Pinecone to SQLite/Postgres/Qdrant.');
      }
      default:
        throw new Error(`Unsupported migration target type: ${(config as BackendConfig).type}`);
    }
  }
}
