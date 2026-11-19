/**
 * @fileoverview The cases every engine of `SqlEmbeddingStore` passes: rows answered only to their own tenant, model
 * and size at four-byte precision, no column for text, a vector of the wrong length absent and deleted, deletions
 * that take only their own rows, a use recorded at most once a day, and the idle limit. Each engine's test file runs
 * them on its own database.
 */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createStorageFeatures, type StorageAdapter } from '@framers/sql-storage-adapter';

import {
  SqlEmbeddingStore,
  embeddingInputHash,
  embeddingStoreSchema,
  embeddingStoreTables,
  type SqlEmbeddingStoreOptions,
} from '../SqlEmbeddingStore.js';

/** One database the cases run on. */
export interface EmbeddingStoreEngine {
  /** The adapter's kind, checked so a case never runs on a fallback engine. */
  readonly kind: string;
  /** An open adapter. */
  open(): Promise<StorageAdapter>;
  /** A table prefix no other case uses. */
  prefix(): string;
  /** The names of a table's columns; `table` is unquoted. */
  columns(db: StorageAdapter, table: string): Promise<string[]>;
  /** Closes the adapter and drops what the case made. */
  close(db: StorageAdapter, prefix: string): Promise<void>;
}

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const MODEL = { model: 'text-embedding-small', dimensions: 4 };
const INPUTS = ['the budget passed in March', 'the vote was 7 to 2', 'the board meets on Tuesdays'];
/** Values a four-byte float cannot hold exactly, so a read-back shows the stored precision. */
const VECTORS = [
  [0.1, -0.2, 0.30000001, 1 / 3],
  [Math.PI, -Math.E, 1e-7, 0.5],
  [-1, 2.25, 123.456789, -0.000123],
];
const HASHES = INPUTS.map((input) => embeddingInputHash(MODEL, input));
const four = (vector: number[]) => vector.map((value) => Math.fround(value));

/** The store's statements, recorded on their way to the database. */
function recording(db: StorageAdapter, statements: string[]): StorageAdapter {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'run' || property === 'all' || property === 'get') {
        return (statement: string, params?: unknown) => {
          statements.push(statement);
          return Reflect.apply(Reflect.get(target, property) as (...args: unknown[]) => unknown, target, [statement, params]);
        };
      }
      if (property === 'transaction') {
        return (work: (tx: StorageAdapter) => Promise<unknown>) => target.transaction((tx) => work(recording(tx, statements)));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The run a statement takes through `db`, so a case can do something just before it and then send it on. */
function beforeRun(db: StorageAdapter, before: (statement: string) => Promise<void>): StorageAdapter {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'run') {
        return async (statement: string, params?: unknown) => {
          await before(statement);
          return Reflect.apply(Reflect.get(target, 'run') as (...args: unknown[]) => unknown, target, [statement, params]);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Registers the cases on `engine`: each engine's test file calls it once, inside its own `describe`, with how it opens,
 * names, reads and closes its database.
 */
export function embeddingStoreCases(engine: EmbeddingStoreEngine): void {
  /** Runs `body` on a fresh database and prefix, with a clock the case moves. */
  async function withStore(
    options: Partial<SqlEmbeddingStoreOptions>,
    body: (context: {
      store: SqlEmbeddingStore;
      db: StorageAdapter;
      table: string;
      statements: string[];
      clock: { now: number };
      count: (where?: string, params?: unknown[]) => Promise<number>;
      lastUsed: (hash: string) => Promise<number>;
    }) => Promise<void>,
  ): Promise<void> {
    const db = await engine.open();
    const prefix = engine.prefix();
    try {
      expect(db.kind).toBe(engine.kind);
      const statements: string[] = [];
      const clock = { now: T0 };
      const store = new SqlEmbeddingStore({ adapter: recording(db, statements), prefix, clock: () => clock.now, ...options });
      const table = embeddingStoreTables(prefix).vectors;
      const count = async (where = '1 = 1', params: unknown[] = []) =>
        Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params))?.n ?? 0);
      const lastUsed = async (hash: string) =>
        Number((await db.get<{ at: number | string }>(`SELECT last_used_at AS at FROM ${table} WHERE input_sha256 = $1`, [hash]))?.at);
      await body({ store, db, table, statements, clock, count, lastUsed });
    } finally {
      await engine.close(db, prefix);
    }
  }

  const rows = () => HASHES.map((hash, i) => ({ hash, vector: VECTORS[i], tokens: 6 + i }));

  it('answers three stored vectors to their own tenant, model and size at four-byte precision, and nothing to any other', async () => {
    const db = await engine.open();
    const prefix = engine.prefix();
    try {
      // The host's migration makes the table; the store does not.
      for (const statement of embeddingStoreSchema(prefix, createStorageFeatures(db).dialect)) await db.run(statement);
      const store = new SqlEmbeddingStore({ adapter: db, prefix, manageSchema: false });
      expect(await store.put({ tenant: 'tenant-a' }, MODEL, rows())).toBe(3);

      const found = await store.get({ tenant: 'tenant-a' }, MODEL, [...HASHES, embeddingInputHash(MODEL, 'never stored')]);
      expect([...found.keys()].sort()).toEqual([...HASHES].sort());
      HASHES.forEach((hash, i) => expect(found.get(hash)).toEqual(four(VECTORS[i])));

      expect((await store.get({ tenant: 'tenant-b' }, MODEL, HASHES)).size).toBe(0);
      expect((await store.get({ tenant: 'tenant-a' }, { ...MODEL, model: 'another-model' }, HASHES)).size).toBe(0);
      expect((await store.get({ tenant: 'tenant-a' }, { ...MODEL, dimensions: 8 }, HASHES)).size).toBe(0);
      expect((await store.get({ tenant: 'tenant-a' }, MODEL, [])).size).toBe(0);
    } finally {
      await engine.close(db, prefix);
    }
  });

  it('holds no column for the input text, and no stored value carries it', async () => {
    await withStore({}, async ({ store, db, table }) => {
      await store.put({ tenant: 'tenant-a' }, MODEL, rows());
      const unquoted = table.replaceAll('"', '');
      expect((await engine.columns(db, unquoted)).sort()).toEqual(
        ['created_at', 'dimensions', 'input_sha256', 'last_used_at', 'model', 'tenant_id', 'tokens', 'vector'],
      );
      const stored = await db.all<Record<string, unknown>>(`SELECT tenant_id, model, input_sha256 FROM ${table}`);
      expect(stored).toHaveLength(3);
      for (const row of stored) for (const value of Object.values(row)) for (const input of INPUTS) expect(String(value)).not.toContain(input);
    });
  });

  it('treats a stored vector of the wrong length as absent and deletes it', async () => {
    await withStore({}, async ({ store, db, table, count }) => {
      await store.put({ tenant: 'tenant-a' }, MODEL, rows().slice(0, 1));
      const short = createStorageFeatures(db).blobCodec.encode([0.5, 0.25, 0.125]);
      await db.run(
        `INSERT INTO ${table} (tenant_id, model, dimensions, input_sha256, vector, tokens, created_at, last_used_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['tenant-a', MODEL.model, MODEL.dimensions, HASHES[1], short, 3, T0, T0],
      );
      expect(await count()).toBe(2);
      const found = await store.get({ tenant: 'tenant-a' }, MODEL, HASHES);
      expect([...found.keys()]).toEqual([HASHES[0]]);
      expect(await count('input_sha256 = $1', [HASHES[1]])).toBe(0);
      expect(await count('input_sha256 = $1', [HASHES[0]])).toBe(1);
    });
  });

  it('deletes a vector of the wrong length only while it holds what was read, so a vector stored meanwhile stays', async () => {
    const db = await engine.open();
    const prefix = engine.prefix();
    try {
      const writer = new SqlEmbeddingStore({ adapter: db, prefix, clock: () => T0 });
      await writer.put({ tenant: 'tenant-a' }, MODEL, rows().slice(0, 1));
      const table = embeddingStoreTables(prefix).vectors;
      const short = createStorageFeatures(db).blobCodec.encode([0.5, 0.25, 0.125]);
      await db.run(
        `INSERT INTO ${table} (tenant_id, model, dimensions, input_sha256, vector, tokens, created_at, last_used_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['tenant-a', MODEL.model, MODEL.dimensions, HASHES[1], short, 3, T0, T0],
      );
      // Between the read and its cleanup, another call stores a good vector under the same key.
      let repaired = false;
      const racing = beforeRun(db, async (statement) => {
        if (repaired || !/^\s*DELETE\b/.test(statement)) return;
        repaired = true;
        await writer.put({ tenant: 'tenant-a' }, MODEL, [{ hash: HASHES[1], vector: VECTORS[1] }]);
      });
      const reader = new SqlEmbeddingStore({ adapter: racing, prefix, clock: () => T0 });
      expect([...(await reader.get({ tenant: 'tenant-a' }, MODEL, HASHES)).keys()]).toEqual([HASHES[0]]);
      expect(repaired).toBe(true);
      expect((await writer.get({ tenant: 'tenant-a' }, MODEL, [HASHES[1]])).get(HASHES[1])).toEqual(four(VECTORS[1]));
    } finally {
      await engine.close(db, prefix);
    }
  });

  it('runs a schema statement again when another session made its object first', async () => {
    const db = await engine.open();
    const prefix = engine.prefix();
    try {
      let lost = 0;
      // The first two creates find another session's object committed after their check, and fail as Postgres fails
      // a create that lost that race.
      const racing = beforeRun(db, async (statement) => {
        if (lost >= 2 || !/^\s*CREATE\b/.test(statement)) return;
        lost += 1;
        await db.run(statement);
        throw Object.assign(new Error('relation already exists'), { code: '42P07' });
      });
      const store = new SqlEmbeddingStore({ adapter: racing, prefix, clock: () => T0 });
      expect(await store.put({ tenant: 'tenant-a' }, MODEL, rows())).toBe(3);
      expect(lost).toBe(2);
      expect((await store.get({ tenant: 'tenant-a' }, MODEL, HASHES)).size).toBe(3);
    } finally {
      await engine.close(db, prefix);
    }
  });

  it('removes with remove and removeUnusedSince only the rows of the tenant named', async () => {
    await withStore({}, async ({ store, clock, count }) => {
      await store.put({ tenant: 'tenant-a' }, MODEL, rows());
      await store.put({ tenant: 'tenant-b' }, MODEL, rows());
      await store.put({ tenant: 'tenant-c' }, { ...MODEL, model: 'another-model' }, rows());
      expect(await count()).toBe(9);

      expect(await store.remove({ tenant: 'tenant-a' })).toBe(3);
      expect((await store.get({ tenant: 'tenant-a' }, MODEL, HASHES)).size).toBe(0);
      expect((await store.get({ tenant: 'tenant-b' }, MODEL, HASHES)).size).toBe(3);

      clock.now = T0 + 10 * DAY;
      expect(await store.removeUnusedSince(T0 + DAY, { tenant: 'tenant-c' })).toBe(3);
      expect(await count("tenant_id = 'tenant-b'")).toBe(3);
      expect(await count("tenant_id = 'tenant-c'")).toBe(0);
    });
  });

  it('records a use at most once a day, and keeps the creation time when a vector is stored again', async () => {
    await withStore({}, async ({ store, db, table, statements, clock, lastUsed }) => {
      await store.put({ tenant: 'tenant-a' }, MODEL, rows());
      const writes = () => statements.filter((statement) => /^\s*UPDATE\b/i.test(statement)).length;

      clock.now = T0 + 60 * 60_000;
      await store.get({ tenant: 'tenant-a' }, MODEL, HASHES);
      await store.get({ tenant: 'tenant-a' }, MODEL, HASHES);
      expect(writes()).toBe(0);
      expect(await lastUsed(HASHES[0])).toBe(T0);

      clock.now = T0 + DAY + 1;
      await store.get({ tenant: 'tenant-a' }, MODEL, HASHES.slice(0, 2));
      expect(writes()).toBe(1);
      expect(await lastUsed(HASHES[0])).toBe(T0 + DAY + 1);
      expect(await lastUsed(HASHES[1])).toBe(T0 + DAY + 1);
      expect(await lastUsed(HASHES[2])).toBe(T0);

      clock.now = T0 + DAY + 3 * 60 * 60_000;
      await store.get({ tenant: 'tenant-a' }, MODEL, HASHES.slice(0, 2));
      expect(writes()).toBe(1);

      clock.now = T0 + 5 * DAY;
      await store.put({ tenant: 'tenant-a' }, MODEL, [{ hash: HASHES[2], vector: VECTORS[0] }]);
      const row = await db.get<{ created_at: number | string; last_used_at: number | string; tokens: number | null }>(
        `SELECT created_at, last_used_at, tokens FROM ${table} WHERE input_sha256 = $1`, [HASHES[2]],
      );
      expect(Number(row?.created_at)).toBe(T0);
      expect(Number(row?.last_used_at)).toBe(T0 + 5 * DAY);
      expect(row?.tokens ?? null).toBeNull();
      expect((await store.get({ tenant: 'tenant-a' }, MODEL, [HASHES[2]])).get(HASHES[2])).toEqual(four(VECTORS[0]));
    });
  });

  it('with maxIdleMs answers no row unused that long, does not refresh it, and removeUnusedSince deletes it', async () => {
    const maxIdleMs = 31 * DAY;
    await withStore({ maxIdleMs }, async ({ store, clock, count, lastUsed }) => {
      await store.put({ tenant: 'tenant-a' }, MODEL, rows().slice(0, 1));
      clock.now = T0 + 31 * DAY;
      await store.put({ tenant: 'tenant-a' }, MODEL, rows().slice(1, 2));

      clock.now = T0 + 32 * DAY;
      const found = await store.get({ tenant: 'tenant-a' }, MODEL, HASHES.slice(0, 2));
      expect([...found.keys()]).toEqual([HASHES[1]]);
      expect(await lastUsed(HASHES[0])).toBe(T0);

      expect(await store.removeUnusedSince(clock.now - maxIdleMs, { tenant: 'tenant-a' })).toBe(1);
      expect(await count('input_sha256 = $1', [HASHES[0]])).toBe(0);
      expect(await count('input_sha256 = $1', [HASHES[1]])).toBe(1);
    });
  });

  it('checks every argument before it reads or writes', async () => {
    await withStore({}, async ({ store, db, statements }) => {
      const before = statements.length;
      await expect(store.put({ tenant: 'tenant-a' }, MODEL, [...rows(), { hash: HASHES[0], vector: [1, 2, 3] }])).rejects.toThrow('invalid_embedding_vector');
      await expect(store.put({ tenant: 'tenant-a' }, MODEL, [{ hash: HASHES[0], vector: [1, 2, 3, Number.NaN] }])).rejects.toThrow('invalid_embedding_vector');
      await expect(store.put({ tenant: 'tenant-a' }, MODEL, [{ hash: HASHES[0], vector: [1, 2, 3, 4], tokens: -1 }])).rejects.toThrow('invalid_embedding_tokens');
      await expect(store.put({ tenant: 'tenant-a' }, MODEL, [{ hash: 'ABC', vector: [1, 2, 3, 4] }])).rejects.toThrow('invalid_embedding_hash');
      await expect(store.get({ tenant: '' }, MODEL, HASHES)).rejects.toThrow('invalid_embedding_scope');
      await expect(store.get({ tenant: 'tenant-a' }, { model: 'm', dimensions: 0 }, HASHES)).rejects.toThrow('invalid_embedding_model');
      await expect(store.removeUnusedSince(-1, { tenant: 'tenant-a' })).rejects.toThrow('invalid_embedding_time');
      expect(statements.length).toBe(before);
      expect(() => new SqlEmbeddingStore({ adapter: db, prefix: 'Bad-Prefix' })).toThrow('invalid_embedding_table_prefix');
    });
    const db = await engine.open();
    try {
      expect(() => new SqlEmbeddingStore({ adapter: db, maxIdleMs: DAY })).toThrow('invalid_embedding_max_idle');
    } finally {
      await engine.close(db, engine.prefix());
    }
  });

  it("hashes an input with its model and size as the library index hashes a passage's input", () => {
    const expected = createHash('sha256').update(`${MODEL.model}\u0000${MODEL.dimensions}\u0000${INPUTS[0]}`, 'utf8').digest('hex');
    expect(embeddingInputHash(MODEL, INPUTS[0])).toBe(expected);
    expect(embeddingInputHash({ ...MODEL, dimensions: 8 }, INPUTS[0])).not.toBe(expected);
    expect(embeddingInputHash({ ...MODEL, model: 'another-model' }, INPUTS[0])).not.toBe(expected);
  });
}
