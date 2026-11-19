/**
 * @fileoverview A store of embedding vectors by the hash of their exact input, on `@framers/sql-storage-adapter`.
 * One row per tenant, model, vector size and input hash holds the vector and the input's token count, never the
 * input's text, on PostgreSQL, better-sqlite3, sql.js and the adapter's other SQLite engines. A host that embedded an
 * input once reads its vector back instead of sending the input to the embedding model again.
 * @module agentos/cognition/rag/embeddings/SqlEmbeddingStore
 */

import {
  PostgresDialect,
  createStorageFeatures,
  type SqlDialect,
  type StorageAdapter,
  type StorageFeatures,
} from '@framers/sql-storage-adapter';
import { sha256Hex } from '../../../core/utils/sha256.js';

/** The part of the store a call reads or writes: one tenant's rows. Every call names one. */
export interface EmbeddingStoreScope {
  /** The tenant the rows belong to. A row is answered only to its own tenant. */
  readonly tenant: string;
}

/** The model a vector was made with, and its size. A row is answered only for the model and size it was stored under. */
export interface EmbeddingStoreModel {
  readonly model: string;
  readonly dimensions: number;
}

/** One vector to store. */
export interface EmbeddingStoreRow {
  /** The SHA-256 hex of the exact input, as {@link embeddingInputHash} gives it. */
  readonly hash: string;
  /** The vector, one number per dimension. It is stored as four-byte floats. */
  readonly vector: readonly number[];
  /** The input's token count, when the embedder reported one. */
  readonly tokens?: number;
}

/** How a {@link SqlEmbeddingStore} reaches its table, and how long a row stays readable. */
export interface SqlEmbeddingStoreOptions {
  /** The database. Its kind picks the SQL dialect and the blob codec. */
  readonly adapter: StorageAdapter;
  /** Prefix of the store's table, `<prefix>_vectors`; the one given to {@link embeddingStoreSchema}. `agentos_embedding` unless given. */
  readonly prefix?: string;
  /**
   * Create the table on first use, when it is missing. True unless given; pass false when the host's migration runs
   * {@link embeddingStoreSchema} itself.
   */
  readonly manageSchema?: boolean;
  /**
   * How long a row stays readable after its last recorded use, in milliseconds. An older row is absent from `get`,
   * and `get` does not refresh it; `removeUnusedSince` deletes it. A use is recorded at most once a day, so a row can
   * become unreadable up to a day before `maxIdleMs` has passed since it was last read. More than a day; no limit
   * unless given.
   */
  readonly maxIdleMs?: number;
  /** The time, as integer UTC epoch milliseconds; `Date.now` unless given. */
  readonly clock?: () => number;
}

/** A day, in milliseconds: the longest a row's recorded last use lags its last read. */
const DAY_MS = 86_400_000;

/** The most hashes one statement asks for. A longer list is read in parts. */
const HASHES_PER_STATEMENT = 1_000;

/** The columns a row has, in the order `put` writes them. None of them holds an input's text. */
const COLUMNS = ['tenant_id', 'model', 'dimensions', 'input_sha256', 'vector', 'tokens', 'created_at', 'last_used_at'];

/** The columns that name a row: its tenant, model, size and input hash. */
const KEY = ['tenant_id', 'model', 'dimensions', 'input_sha256'];

/**
 * The hash a vector is stored and found by: the SHA-256 hex of the model, NUL, the dimensions, NUL and the exact
 * input the embedder is sent. It is the `inputHash` the library index gives a passage, so a vector stored under it
 * is found for the same input, model and size, and never for another.
 *
 * @param embedding - The model and the vector size.
 * @param input - The exact text the embedder is sent, after the host's own redaction and cut.
 * @returns 64 lower-case hex digits.
 */
export function embeddingInputHash(embedding: EmbeddingStoreModel, input: string): string {
  return sha256Hex(`${embedding.model}\u0000${embedding.dimensions}\u0000${input}`);
}

/**
 * The quoted names of the store's table and index.
 *
 * @param prefix - A lower-case letter, then at most 39 lower-case letters, digits or underscores.
 * @throws {Error} `invalid_embedding_table_prefix` when the prefix does not have that form.
 */
export function embeddingStoreTables(prefix = 'agentos_embedding'): { readonly vectors: string; readonly unusedIndex: string } {
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(prefix)) throw new Error('invalid_embedding_table_prefix');
  return { vectors: `"${prefix}_vectors"`, unusedIndex: `"${prefix}_vectors_unused"` };
}

/**
 * The statements that create the store's table and its index when they are missing, for a host's migration. The
 * table holds a tenant, a model, a vector size, an input hash, the vector as a blob of four-byte floats, a token
 * count and two times in epoch milliseconds; its primary key is the first four. It has no column for text.
 *
 * @param prefix - Table-name prefix, as {@link embeddingStoreTables} takes it.
 * @param dialect - The database's dialect; PostgreSQL unless given. `createStorageFeatures(adapter).dialect` gives an
 *   adapter's.
 * @returns The statements, in the order they run.
 * @throws {Error} `invalid_embedding_table_prefix` for a malformed prefix.
 */
export function embeddingStoreSchema(prefix = 'agentos_embedding', dialect: SqlDialect = new PostgresDialect()): readonly string[] {
  const t = embeddingStoreTables(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.vectors} (
      tenant_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
      vector ${dialect.columnType('blob')} NOT NULL,
      tokens INTEGER CHECK (tokens IS NULL OR tokens >= 0),
      created_at ${dialect.columnType('bigint')} NOT NULL,
      last_used_at ${dialect.columnType('bigint')} NOT NULL,
      PRIMARY KEY (tenant_id, model, dimensions, input_sha256))`,
    `CREATE INDEX IF NOT EXISTS ${t.unusedIndex} ON ${t.vectors} (tenant_id, last_used_at)`,
  ];
}

/** A row as `get` reads it. */
interface VectorRow {
  input_sha256: string;
  vector: unknown;
  last_used_at: string | number | bigint;
}

function checkedTenant(scope: EmbeddingStoreScope): string {
  const tenant = scope?.tenant;
  if (typeof tenant !== 'string' || tenant.length === 0 || tenant.length > 512) throw new Error('invalid_embedding_scope');
  return tenant;
}

function checkedModel(embedding: EmbeddingStoreModel): EmbeddingStoreModel {
  const model = embedding?.model;
  const dimensions = embedding?.dimensions;
  if (typeof model !== 'string' || model.length === 0 || model.length > 256) throw new Error('invalid_embedding_model');
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65_536) throw new Error('invalid_embedding_model');
  return { model, dimensions };
}

function checkedHash(hash: string): string {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid_embedding_hash');
  return hash;
}

function checkedTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_embedding_time');
  return value;
}

function parts<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Embedding vectors by the hash of their exact input, kept per tenant, model and vector size, on any database
 * `@framers/sql-storage-adapter` opens. The store keeps no text: a host computes each input's hash with
 * {@link embeddingInputHash}, asks for the hashes it is about to embed, embeds only the ones not answered, and stores
 * those.
 *
 * - A call always names its tenant, and a row is answered only to its own tenant, model and size.
 * - A row whose vector is not `dimensions` four-byte floats counts as absent, and `get` deletes it.
 * - `get` records a row's use at most once a day. With `maxIdleMs`, a row unused that long is absent and is not
 *   refreshed; `removeUnusedSince` deletes such rows, on a timer the host runs.
 *
 * @example
 * ```ts
 * const store = new SqlEmbeddingStore({ adapter, prefix: 'shared_sentence', manageSchema: false, maxIdleMs: 31 * 86_400_000 });
 * const model = { model: 'text-embedding-3-small', dimensions: 1536 };
 * const hashes = inputs.map((input) => embeddingInputHash(model, input));
 * const known = await store.get({ tenant }, model, hashes);
 * const missing = inputs.filter((_, i) => !known.has(hashes[i]));
 * const made = await embed(missing);
 * await store.put({ tenant }, model, made.map((vector, i) => ({ hash: embeddingInputHash(model, missing[i]), vector })));
 * ```
 */
export class SqlEmbeddingStore {
  private readonly adapter: StorageAdapter;
  private readonly features: StorageFeatures;
  private readonly prefix: string;
  private readonly table: string;
  private readonly manageSchema: boolean;
  private readonly maxIdleMs?: number;
  private readonly clock: () => number;
  private ready?: Promise<void>;

  /**
   * @param options - The adapter, the table prefix, whether to create the table, the idle limit and the clock.
   * @throws {Error} `invalid_embedding_table_prefix` for a malformed prefix, and `invalid_embedding_max_idle` for a
   *   `maxIdleMs` that is not an integer of more than a day.
   */
  constructor(options: SqlEmbeddingStoreOptions) {
    this.adapter = options.adapter;
    this.features = createStorageFeatures(options.adapter);
    this.prefix = options.prefix ?? 'agentos_embedding';
    this.table = embeddingStoreTables(this.prefix).vectors;
    this.manageSchema = options.manageSchema !== false;
    if (options.maxIdleMs !== undefined && (!Number.isSafeInteger(options.maxIdleMs) || options.maxIdleMs <= DAY_MS)) {
      throw new Error('invalid_embedding_max_idle');
    }
    this.maxIdleMs = options.maxIdleMs;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * The stored vectors of these input hashes, for one tenant, model and size. A hash with no row, a row of another
   * tenant, model or size, a row unused for longer than `maxIdleMs`, and a row whose vector is not `dimensions`
   * numbers are all left out; the last kind is deleted. A row answered whose last recorded use is more than a day
   * old has its use recorded now.
   *
   * @param scope - The tenant.
   * @param embedding - The model and vector size.
   * @param hashes - Input hashes, as {@link embeddingInputHash} gives them. Repeats are read once.
   * @returns Each answered hash with its vector, at four-byte precision.
   * @throws {Error} `invalid_embedding_scope`, `invalid_embedding_model` or `invalid_embedding_hash` for a malformed
   *   argument, before anything is read; the adapter's error when a statement fails.
   */
  async get(scope: EmbeddingStoreScope, embedding: EmbeddingStoreModel, hashes: readonly string[]): Promise<Map<string, number[]>> {
    const tenant = checkedTenant(scope);
    const { model, dimensions } = checkedModel(embedding);
    const wanted = [...new Set(hashes.map(checkedHash))];
    const found = new Map<string, number[]>();
    if (wanted.length === 0) return found;
    await this.ensure();
    const now = this.now();
    const dialect = this.features.dialect;
    const floor = this.maxIdleMs === undefined ? undefined : now - this.maxIdleMs;
    const malformed: string[] = [];
    const stale: string[] = [];
    for (const part of parts(wanted, HASHES_PER_STATEMENT)) {
      const params: unknown[] = [tenant, model, dimensions, part];
      let statement = `SELECT input_sha256, vector, last_used_at FROM ${this.table}
        WHERE tenant_id = $1 AND model = $2 AND dimensions = $3 AND ${dialect.inArray('input_sha256', '$4')}`;
      if (floor !== undefined) {
        statement += ' AND last_used_at >= $5';
        params.push(floor);
      }
      for (const row of await this.adapter.all<VectorRow>(statement, params)) {
        const vector = this.decode(row.vector, dimensions);
        if (!vector) {
          malformed.push(row.input_sha256);
          continue;
        }
        found.set(row.input_sha256, vector);
        if (Number(row.last_used_at) < now - DAY_MS) stale.push(row.input_sha256);
      }
    }
    for (const part of parts(malformed, HASHES_PER_STATEMENT)) {
      await this.adapter.run(
        `DELETE FROM ${this.table} WHERE tenant_id = $1 AND model = $2 AND dimensions = $3 AND ${dialect.inArray('input_sha256', '$4')}`,
        [tenant, model, dimensions, part],
      );
    }
    for (const part of parts(stale, HASHES_PER_STATEMENT)) {
      await this.adapter.run(
        `UPDATE ${this.table} SET last_used_at = $5
          WHERE tenant_id = $1 AND model = $2 AND dimensions = $3 AND ${dialect.inArray('input_sha256', '$4')} AND last_used_at < $6`,
        [tenant, model, dimensions, part, now, now - DAY_MS],
      );
    }
    return found;
  }

  /**
   * Stores vectors for one tenant, model and size. A hash already stored there gets the new vector and token count,
   * and its use is recorded now; its creation time stays. Every row is checked before anything is written, and the
   * rows are written in one transaction where the adapter has transactions. A repeated hash is written once, with
   * its last vector.
   *
   * @param scope - The tenant.
   * @param embedding - The model and vector size.
   * @param rows - The input hashes with their vectors and token counts.
   * @returns How many rows were written.
   * @throws {Error} `invalid_embedding_scope`, `invalid_embedding_model`, `invalid_embedding_hash`,
   *   `invalid_embedding_vector` (not `dimensions` finite numbers) or `invalid_embedding_tokens` (not an integer of 0
   *   or more), before anything is written; the adapter's error when a statement fails.
   */
  async put(scope: EmbeddingStoreScope, embedding: EmbeddingStoreModel, rows: readonly EmbeddingStoreRow[]): Promise<number> {
    const tenant = checkedTenant(scope);
    const { model, dimensions } = checkedModel(embedding);
    const unique = new Map<string, { vector: number[]; tokens: number | null }>();
    for (const row of rows) {
      const hash = checkedHash(row?.hash);
      const vector = Array.isArray(row.vector) || ArrayBuffer.isView(row.vector) ? Array.from(row.vector as ArrayLike<number>) : [];
      if (vector.length !== dimensions || !vector.every((value) => typeof value === 'number' && Number.isFinite(Math.fround(value)))) {
        throw new Error('invalid_embedding_vector');
      }
      if (row.tokens !== undefined && (!Number.isSafeInteger(row.tokens) || row.tokens < 0)) throw new Error('invalid_embedding_tokens');
      unique.set(hash, { vector, tokens: row.tokens ?? null });
    }
    if (unique.size === 0) return 0;
    await this.ensure();
    const now = this.now();
    const statement = this.features.dialect.upsert(
      this.table,
      COLUMNS,
      COLUMNS.map((_, i) => `$${i + 1}`),
      KEY,
      ['vector', 'tokens', 'last_used_at'],
    );
    const write = async (db: StorageAdapter): Promise<void> => {
      for (const [hash, { vector, tokens }] of unique) {
        await db.run(statement, [tenant, model, dimensions, hash, this.features.blobCodec.encode(vector), tokens, now, now]);
      }
    };
    if (this.adapter.capabilities.has('transactions')) await this.adapter.transaction(write);
    else await write(this.adapter);
    return unique.size;
  }

  /**
   * Deletes every row of one tenant, whatever its model or size.
   *
   * @param scope - The tenant.
   * @returns How many rows were deleted.
   * @throws {Error} `invalid_embedding_scope` for a malformed scope; the adapter's error when the statement fails.
   */
  async remove(scope: EmbeddingStoreScope): Promise<number> {
    const tenant = checkedTenant(scope);
    await this.ensure();
    const result = await this.adapter.run(`DELETE FROM ${this.table} WHERE tenant_id = $1`, [tenant]);
    return result.changes;
  }

  /**
   * Deletes one tenant's rows whose last recorded use is before `before`. A host with `maxIdleMs` runs it on a timer
   * of its own with `now - maxIdleMs`, so rows `get` no longer answers go whether or not anything is written again.
   *
   * @param before - A time, as epoch milliseconds or a Date.
   * @param scope - The tenant.
   * @returns How many rows were deleted.
   * @throws {Error} `invalid_embedding_time` for a time that is not an integer of 0 or more, and
   *   `invalid_embedding_scope` for a malformed scope; the adapter's error when the statement fails.
   */
  async removeUnusedSince(before: number | Date, scope: EmbeddingStoreScope): Promise<number> {
    const at = checkedTime(before instanceof Date ? before.getTime() : before);
    const tenant = checkedTenant(scope);
    await this.ensure();
    const result = await this.adapter.run(`DELETE FROM ${this.table} WHERE tenant_id = $1 AND last_used_at < $2`, [tenant, at]);
    return result.changes;
  }

  /** Creates the table on first use when `manageSchema` is on; a failed attempt is tried again on the next call. */
  private ensure(): Promise<void> {
    if (!this.manageSchema) return Promise.resolve();
    this.ready ??= (async () => {
      for (const statement of embeddingStoreSchema(this.prefix, this.features.dialect)) await this.adapter.run(statement);
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_embedding_time');
    return value;
  }

  /** A stored vector as numbers, or undefined when it is not `dimensions` four-byte floats. */
  private decode(value: unknown, dimensions: number): number[] | undefined {
    const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
    if (!bytes || bytes.byteLength !== dimensions * 4) return undefined;
    const vector = this.features.blobCodec.decode(bytes);
    return vector.length === dimensions && vector.every(Number.isFinite) ? vector : undefined;
  }
}
