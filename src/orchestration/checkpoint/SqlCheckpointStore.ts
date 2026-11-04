/**
 * @file SqlCheckpointStore.ts
 * @description {@link ICheckpointStore} over a `@framers/sql-storage-adapter` store: SQLite (better-sqlite3, or sql.js
 * in a browser and the tests) for one process, Postgres for several. A run's checkpoints outlive the process that saved
 * them, so a run a human node halted, or one a crash stopped, resumes in the next process by its run id.
 *
 * Each checkpoint is one row of one table. The columns a read filters and orders by hold the checkpoint's identifiers
 * and its `timestamp`; `state_json` holds the rest of the snapshot, and `metadata_json` the figures
 * {@link SqlCheckpointStore.list} returns beside the identifiers, so a listing reads no snapshot.
 *
 * The snapshot is stored as JSON. What `JSON.stringify` cannot hold does not come back as it was saved: a key whose
 * value is `undefined` or a function is dropped, a `Date` comes back as its ISO string, a `Map` or a `Set` as `{}`, and
 * `NaN` or an infinity as `null`. A save of a cycle or of a `BigInt` rejects with the error `JSON.stringify` throws.
 *
 * The store imports only types from the adapter: it runs the statements of the adapter it is given.
 *
 * @module orchestration/checkpoint/SqlCheckpointStore
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { retryLostCreate } from '../../cognition/memory/retrieval/store/migrations/lost-create.js';
import type { GraphState } from '../ir/types.js';
import type { Checkpoint, CheckpointMetadata, ICheckpointStore } from './ICheckpointStore.js';

/** The table's name when `tablePrefix` is left out. */
const DEFAULT_TABLE_PREFIX = 'agentos_checkpoints';

/**
 * The prefixes a store takes: a lower-case letter, then at most 52 lower-case letters, digits or underscores. The
 * prefix is the table's name and part of its indexes' names, so it is checked before any statement is built. At 53
 * characters the longest name the store gives, `idx_<prefix>_graph`, takes the 63 bytes Postgres keeps of an
 * identifier; Postgres cuts a longer name short, and its catalogue would then hold a name other than the one
 * {@link checkpointDdl} gives.
 */
const TABLE_PREFIX = /^[a-z][a-z0-9_]{0,52}$/;

/** The table a prefix names, once the prefix is checked; any other value throws before a statement is built. */
function tableOf(tablePrefix: string | undefined): string {
  const prefix = tablePrefix ?? DEFAULT_TABLE_PREFIX;
  if (typeof prefix !== 'string' || !TABLE_PREFIX.test(prefix)) {
    throw new Error(
      `A checkpoint store's tablePrefix is a lower-case letter and at most 52 more lower-case letters, digits or underscores, so that every name it gives fits the 63 bytes of a Postgres identifier; got ${JSON.stringify(prefix)}.`,
    );
  }
  return prefix;
}

/**
 * The store's table and its indexes under a prefix: the table `<prefix>` and the indexes `idx_<prefix>_run`,
 * `idx_<prefix>_graph` and `idx_<prefix>_seq`. A product that runs its own migrations copies this text for the prefix
 * it gives its store into one of them and passes `ensureSchema: false`. The prefix is checked before the text is built,
 * and one that {@link SqlCheckpointStoreOptions.tablePrefix} refuses throws. `checkpointDdl()` gives the text for the
 * default prefix, `agentos_checkpoints`.
 *
 * The columns:
 * - `id`, `graph_id`, `run_id`, `node_id`: the checkpoint's identifiers.
 * - `parent_id`: the checkpoint a {@link SqlCheckpointStore.fork} was made from; NULL for a checkpoint saved.
 * - `created_at`: the checkpoint's `timestamp`, in epoch milliseconds.
 * - `save_seq`: the order of the saves, which decides between checkpoints of the same `timestamp`.
 * - `state_json`: the rest of the checkpoint (`state`, `memorySnapshot`, `nodeResults`, `visitedNodes`,
 *   `skippedNodes`, `pendingEdges`) as JSON.
 * - `metadata_json`: the `stateSize` and `hasMemorySnapshot` that {@link SqlCheckpointStore.list} returns, as JSON.
 *
 * Every time is epoch milliseconds in a BIGINT. The text holds no question mark: the Postgres adapter rewrites each
 * one to a numbered parameter. The table's and the indexes' names are quoted, here and in every statement of the
 * store, so a prefix that is an SQL keyword (`order`, `check`) names a table; a quoted lower-case name is the same
 * name unquoted, on SQLite and on Postgres.
 *
 * @param tablePrefix - The table's name; default `agentos_checkpoints`.
 * @returns The `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements, separated by semicolons.
 * @throws When the prefix is not a lower-case letter followed by at most 52 lower-case letters, digits or underscores.
 */
export function checkpointDdl(tablePrefix?: string): string {
  const table = tableOf(tablePrefix);
  return `
CREATE TABLE IF NOT EXISTS "${table}" (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  created_at BIGINT NOT NULL,
  save_seq BIGINT NOT NULL,
  state_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_${table}_run" ON "${table}" (run_id, created_at, save_seq, id);
CREATE INDEX IF NOT EXISTS "idx_${table}_graph" ON "${table}" (graph_id, created_at, save_seq, id);
CREATE INDEX IF NOT EXISTS "idx_${table}_seq" ON "${table}" (save_seq);
`;
}

/** Options of {@link SqlCheckpointStore}. */
export interface SqlCheckpointStoreOptions {
  /**
   * The store the table lives in: an adapter of its own or the product's own, never AgentOS's provenance-wrapped
   * storage adapter, whose write hooks can turn a `run()` into a no-op. A save the adapter reports writing no row
   * rejects.
   */
  db: StorageAdapter;
  /**
   * The table's name, and the start of its indexes' names (`idx_<prefix>_*`). Default `agentos_checkpoints`. Stores
   * under different prefixes keep their checkpoints apart in one database; stores under one prefix share them.
   *
   * A lower-case letter, then at most 52 lower-case letters, digits or underscores, so that `idx_<prefix>_graph` fits
   * the 63 bytes of a Postgres identifier. The constructor checks the prefix before any statement is built and throws
   * on any other value, so nothing unchecked reaches the SQL text. {@link checkpointDdl} makes the table for a prefix.
   */
  tablePrefix?: string;
  /**
   * Create the table and its indexes when the table is missing (see {@link SqlCheckpointStore.ensureSchema}). Default
   * true. With false the store runs no DDL: the product's own migrations make the table from {@link checkpointDdl}.
   */
  ensureSchema?: boolean;
}

/** The part of a checkpoint `state_json` holds: all but the identifiers and the timestamp, which have columns. */
type CheckpointSnapshot = Omit<Checkpoint, 'id' | 'graphId' | 'runId' | 'nodeId' | 'timestamp'>;

/** The figures `metadata_json` holds: those of {@link CheckpointMetadata} no column holds. */
type StoredMetadata = Pick<CheckpointMetadata, 'stateSize' | 'hasMemorySnapshot'>;

/** A row as {@link SqlCheckpointStore.get} and {@link SqlCheckpointStore.load} read it. Postgres answers a BIGINT as a string. */
interface CheckpointRow {
  id: string;
  graph_id: string;
  run_id: string;
  node_id: string;
  created_at: number | string;
  state_json: string;
}

/** A row as {@link SqlCheckpointStore.list} reads it. */
interface MetadataRow {
  id: string;
  graph_id: string;
  run_id: string;
  node_id: string;
  created_at: number | string;
  metadata_json: string;
}

/** The columns a checkpoint is read back from. */
const CHECKPOINT_COLUMNS = 'id, graph_id, run_id, node_id, created_at, state_json';

/**
 * The order of {@link ICheckpointStore}: the latest `timestamp` first and, of equal timestamps, the checkpoint saved
 * last. `id` orders saves that overlap and took the same `save_seq`, so every read gives one order.
 */
const MOST_RECENT_FIRST = 'ORDER BY created_at DESC, save_seq DESC, id DESC';

/** The checkpoint a row holds, its identifiers and timestamp from their columns and the rest from `state_json`. */
function checkpointOf(row: CheckpointRow): Checkpoint {
  const snapshot = JSON.parse(row.state_json) as CheckpointSnapshot;
  return {
    ...snapshot,
    id: row.id,
    graphId: row.graph_id,
    runId: row.run_id,
    nodeId: row.node_id,
    timestamp: Number(row.created_at),
  };
}

/** The metadata a row holds, as `InMemoryCheckpointStore` derives it from a checkpoint. */
function metadataOf(row: MetadataRow): CheckpointMetadata {
  const stored = JSON.parse(row.metadata_json) as StoredMetadata;
  return {
    id: row.id,
    runId: row.run_id,
    graphId: row.graph_id,
    nodeId: row.node_id,
    timestamp: Number(row.created_at),
    stateSize: stored.stateSize,
    hasMemorySnapshot: stored.hasMemorySnapshot,
  };
}

/**
 * {@link ICheckpointStore} over a `@framers/sql-storage-adapter` store, with the behaviour of
 * `InMemoryCheckpointStore`: a checkpoint saved again under its id is overwritten, the most recent checkpoint has the
 * latest `timestamp` and, of checkpoints with the same `timestamp`, was saved last, and `fork()` merges each
 * `patchState` partition into a copy of the source.
 *
 * Every save takes the next `save_seq`, one more than the largest in the table, in the statement that writes the row,
 * and a save under an id that exists takes a new one, so a save that starts after another has finished takes the
 * larger number. A store runs its own saves one after another, in the order they were called, so saves of one store
 * that overlap, as a parallel batch's branches make them, take numbers in that order, as `InMemoryCheckpointStore`
 * keeps them: the save called last is the most recent, and a resume from it skips every branch it records. Saves of
 * two stores, or two processes, that overlap can take the same number on Postgres; `id` orders them.
 *
 * Each statement is one statement, so the store needs no transaction. A read, a save and a delete make the table first
 * unless `ensureSchema` is false.
 *
 * @example
 * ```ts
 * import { resolveStorageAdapter } from '@framers/sql-storage-adapter';
 * import { SqlCheckpointStore } from '@framers/agentos/orchestration/checkpoint';
 *
 * const db = await resolveStorageAdapter({ filePath: './checkpoints.sqlite' });
 * const graph = new AgentGraph(state).compile({ checkpointStore: new SqlCheckpointStore({ db }) });
 * ```
 */
export class SqlCheckpointStore implements ICheckpointStore {
  private readonly db: StorageAdapter;
  /** The table's name, from the checked prefix; {@link checkpointDdl} takes it. */
  private readonly table: string;
  /** The table's name quoted, which every statement reads here. */
  private readonly quoted: string;
  private readonly createSchema: boolean;
  private schemaReady: Promise<void> | null = null;
  /** The last save queued; the next waits for it to settle, so the store's saves run in the order they were called. */
  private lastWrite: Promise<void> = Promise.resolve();

  /**
   * @param options - The adapter, the table's prefix and whether the store makes its table.
   * @throws When `tablePrefix` is not a lower-case letter followed by at most 52 lower-case letters, digits or
   *   underscores.
   */
  constructor(options: SqlCheckpointStoreOptions) {
    this.table = tableOf(options.tablePrefix);
    this.quoted = `"${this.table}"`;
    this.db = options.db;
    this.createSchema = options.ensureSchema !== false;
  }

  /**
   * Creates the table and its indexes unless the table answers a read already, so a store over a table that exists
   * runs no DDL: on Postgres each `CREATE INDEX` takes a SHARE lock on the table, which holds back its writes, before
   * it looks for the index's name. Called before the first statement; safe to call again. Does nothing with
   * `ensureSchema: false`.
   *
   * Another session can make the table between the read and the DDL: two stores starting on an empty database both
   * find it missing. On Postgres the DDL of the one that loses then fails once the other commits, `IF NOT EXISTS`
   * notwithstanding, on the catalogue's unique index or as a duplicate table. The DDL runs again on such a failure, as
   * the memory and learning stores run their schema steps, and finds what the other made, so the table and every
   * index exist when it completes. Any other failure rejects, and the next call tries again.
   */
  ensureSchema(): Promise<void> {
    if (!this.createSchema) return Promise.resolve();
    this.schemaReady ??= (async () => {
      if (await this.tableAnswers()) return;
      await retryLostCreate(() => this.db.exec(checkpointDdl(this.table)));
    })().catch((error: unknown) => {
      this.schemaReady = null;
      throw error;
    });
    return this.schemaReady;
  }

  /** Whether the table answers a read; any error, a missing table's among them, counts as no. */
  private async tableAnswers(): Promise<boolean> {
    try {
      await this.db.get(`SELECT 1 FROM ${this.quoted} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * {@inheritDoc ICheckpointStore.save}
   *
   * @throws A `TypeError` when the checkpoint's `timestamp` is not a whole number of milliseconds, which `created_at`
   *   holds as a BIGINT; the error `JSON.stringify` throws on a cycle or a `BigInt`; an error when the database reports
   *   writing no row.
   */
  async save(checkpoint: Checkpoint): Promise<void> {
    await this.write(checkpoint, null);
  }

  /** {@inheritDoc ICheckpointStore.get} */
  async get(checkpointId: string): Promise<Checkpoint | null> {
    await this.ensureSchema();
    const row = await this.db.get<CheckpointRow>(`SELECT ${CHECKPOINT_COLUMNS} FROM ${this.quoted} WHERE id = ?`, [checkpointId]);
    return row ? checkpointOf(row) : null;
  }

  /** {@inheritDoc ICheckpointStore.load} */
  async load(runId: string, nodeId?: string): Promise<Checkpoint | null> {
    await this.ensureSchema();
    const row =
      nodeId === undefined
        ? await this.db.get<CheckpointRow>(
            `SELECT ${CHECKPOINT_COLUMNS} FROM ${this.quoted} WHERE run_id = ? ${MOST_RECENT_FIRST} LIMIT 1`,
            [runId],
          )
        : await this.db.get<CheckpointRow>(
            `SELECT ${CHECKPOINT_COLUMNS} FROM ${this.quoted} WHERE run_id = ? AND node_id = ? ${MOST_RECENT_FIRST} LIMIT 1`,
            [runId, nodeId],
          );
    return row ? checkpointOf(row) : null;
  }

  /** {@inheritDoc ICheckpointStore.latest} */
  async latest(runId: string): Promise<Checkpoint | null> {
    return this.load(runId);
  }

  /**
   * {@inheritDoc ICheckpointStore.list}
   *
   * As in `InMemoryCheckpointStore`, a `limit` above zero caps the list at its whole part, and any other leaves the
   * list whole. So does one above `Number.MAX_SAFE_INTEGER`, which no table's rows reach: SQLite refuses a `LIMIT` it
   * cannot hold as a 64-bit integer, and Postgres a `BIGINT` out of range.
   */
  async list(graphId: string, options?: { limit?: number; runId?: string }): Promise<CheckpointMetadata[]> {
    await this.ensureSchema();
    const params: Array<string | number> = [graphId];
    let statement = `SELECT id, graph_id, run_id, node_id, created_at, metadata_json FROM ${this.quoted} WHERE graph_id = ?`;
    if (options?.runId !== undefined) {
      statement += ' AND run_id = ?';
      params.push(options.runId);
    }
    statement += ` ${MOST_RECENT_FIRST}`;
    const limit = options?.limit;
    if (limit !== undefined && limit > 0 && limit <= Number.MAX_SAFE_INTEGER) {
      statement += ' LIMIT ?';
      params.push(Math.trunc(limit));
    }
    const rows = await this.db.all<MetadataRow>(statement, params);
    return rows.map(metadataOf);
  }

  /** {@inheritDoc ICheckpointStore.delete} */
  async delete(checkpointId: string): Promise<void> {
    await this.ensureSchema();
    await this.db.run(`DELETE FROM ${this.quoted} WHERE id = ?`, [checkpointId]);
  }

  /**
   * {@inheritDoc ICheckpointStore.fork}
   *
   * The new checkpoint records the source's id in `parent_id`, and its `timestamp` is the time of the fork.
   */
  async fork(checkpointId: string, patchState?: Partial<GraphState>): Promise<string> {
    // Read back from the table, the checkpoint is a copy: changing it changes nothing stored.
    const forked = await this.get(checkpointId);
    if (!forked) {
      throw new Error(`SqlCheckpointStore.fork: checkpoint "${checkpointId}" not found`);
    }

    // Fresh identifiers, so the fork is a distinct run.
    forked.runId = crypto.randomUUID();
    forked.id = crypto.randomUUID();
    forked.timestamp = Date.now();

    // Each partition is merged independently, as InMemoryCheckpointStore merges it.
    if (patchState !== undefined) {
      if (patchState.input !== undefined) {
        Object.assign(forked.state.input as object, patchState.input);
      }
      if (patchState.scratch !== undefined) {
        Object.assign(forked.state.scratch as object, patchState.scratch);
      }
      if (patchState.artifacts !== undefined) {
        Object.assign(forked.state.artifacts as object, patchState.artifacts);
      }
      if (patchState.diagnostics !== undefined) {
        Object.assign(forked.state.diagnostics, patchState.diagnostics);
      }
    }

    await this.write(forked, checkpointId);
    return forked.runId;
  }

  /** Redacts the adapter and its connection details. */
  toJSON(): string {
    return '[SqlCheckpointStore]';
  }

  /**
   * Writes a checkpoint in one statement: a new row, or the row of its id overwritten. Either takes the next
   * `save_seq`. A row a fork wrote keeps its `parent_id` when it is saved again.
   *
   * The checkpoint is checked and serialised when the save is called, and its statement queued behind the store's
   * earlier saves; a save that fails does not stop the next.
   */
  private write(checkpoint: Checkpoint, parentId: string | null): Promise<void> {
    const { id, graphId, runId, nodeId, timestamp, ...snapshot } = checkpoint;
    if (!Number.isSafeInteger(timestamp)) {
      throw new TypeError(
        `SqlCheckpointStore.save: checkpoint "${id}" has timestamp ${timestamp}; a timestamp is a whole number of epoch milliseconds, which created_at holds as a BIGINT.`,
      );
    }
    const metadata: StoredMetadata = {
      stateSize: JSON.stringify(checkpoint.state).length,
      hasMemorySnapshot: checkpoint.memorySnapshot !== undefined,
    };
    const parameters = [id, graphId, runId, nodeId, parentId, timestamp, JSON.stringify(snapshot), JSON.stringify(metadata)];
    const queued = this.lastWrite.then(() => this.insert(id, parameters));
    this.lastWrite = queued.catch(() => undefined);
    return queued;
  }

  /** Runs one queued save's statement, once the table is there, and rejects when the database reports no row. */
  private async insert(id: string, parameters: Array<string | number | null>): Promise<void> {
    await this.ensureSchema();
    const t = this.quoted;
    const result = await this.db.run(
      `INSERT INTO ${t} (id, graph_id, run_id, node_id, parent_id, created_at, save_seq, state_json, metadata_json)
VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(save_seq), 0) + 1 FROM ${t}), ?, ?)
ON CONFLICT (id) DO UPDATE SET
  graph_id = excluded.graph_id,
  run_id = excluded.run_id,
  node_id = excluded.node_id,
  parent_id = COALESCE(excluded.parent_id, ${t}.parent_id),
  created_at = excluded.created_at,
  save_seq = excluded.save_seq,
  state_json = excluded.state_json,
  metadata_json = excluded.metadata_json`,
      parameters,
    );
    if (result.changes !== 1) {
      throw new Error(
        `SqlCheckpointStore.save: the database reported writing no row for checkpoint "${id}" (${result.changes} changed); a store whose writes are dropped cannot resume the run.`,
      );
    }
  }
}
