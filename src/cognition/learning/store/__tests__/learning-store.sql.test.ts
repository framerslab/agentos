/**
 * @file learning-store.sql.test.ts
 * SqlLearningStore over real databases: the learning store contract on SQLite and, where CI provides it, on Postgres.
 * On both, the store leaves a host's adapter open when it closes, reads a learner's outcomes, lessons and skills by
 * creation time and then by id, and a column a later release adds reaches the tables an earlier release made, with
 * their rows kept. On SQLite, the store refuses an adapter without transactions, makes no table when a product runs
 * its own migrations, and makes its tables at its next call when its first attempt failed.
 *
 * On both, two stores that add one later column at the same moment add it once.
 *
 * On Postgres, two adapters that append to one chain at once, as two processes do, leave one linear chain that
 * verifies, whether the chain had rows or both start it; a check of a chain reads it as it stood at one moment while
 * another adapter appends to it; and a store makes its tables while another connection makes them at the same moment,
 * and opens without waiting while another connection holds a write transaction on them.
 *
 * The Postgres cases run when `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint job sets it). Each case's
 * tables go in a schema of their own (the storage library's `segment`), dropped once the cases have run, so cases and
 * runs that share a database never reach each other's rows.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresAdapter,
  resolveStorageAdapter,
  type StorageAdapter,
  type StorageCapability,
  type StorageParameters,
  type StorageRunResult,
} from '@framers/sql-storage-adapter';
import { chainKeyOf, Ledger } from '../../ledger/Ledger.js';
import { SqlLearningStore } from '../SqlLearningStore.js';
import { ensureLearningSchema, LEARNING_SCHEMA_DDL, type LearningColumnAddition } from '../schema.js';
import { headRow, ledgerRow, runLearningStoreContract, sessionRow } from './learning-store.contract.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** This run's own mark, in the names of the schemas its Postgres cases make and drop. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The schemas this run's Postgres cases made. */
const segments: string[] = [];

const EARLIER = '2026-10-12T11:00:00.000Z';
const NOW = '2026-10-12T12:00:00.000Z';
const DOC_TABLES = ['outcomes', 'lessons', 'skills'] as const;

const openSqlite = (): Promise<StorageAdapter> =>
  resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });

/** A new schema name of this run's own, kept so the schema is dropped once the cases have run. */
function newSegment(): string {
  const segment = `learning_store_${RUN}_${segments.length}`;
  segments.push(segment);
  return segment;
}

/** A Postgres adapter whose tables go in `segment`: by default, a new schema of this run's own. */
async function openPostgres(segment: string = newSegment()): Promise<StorageAdapter> {
  const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment, max: 5 });
  await adapter.open();
  return adapter;
}

const LEDGER_LEARNER = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const ledgerCandidate = (subject: string) => ({
  learner: LEDGER_LEARNER,
  kind: 'operator_set' as const,
  actor: 'operator:ops',
  subject,
  before: null,
  after: { subject },
});

/**
 * A transaction's handle that runs `between` once, after its first statement that reads the ledger while `armed` says
 * so: another process's append that commits between two statements of one transaction.
 */
class AppendBetweenTx implements StorageAdapter {
  readonly kind: string;
  readonly capabilities: ReadonlySet<StorageCapability>;

  constructor(
    private readonly trx: StorageAdapter,
    private readonly owner: AppendBetween,
  ) {
    this.kind = trx.kind;
    this.capabilities = trx.capabilities;
  }

  open(): Promise<void> {
    return this.trx.open();
  }

  close(): Promise<void> {
    return this.trx.close();
  }

  run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return this.trx.run(statement, parameters);
  }

  get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return this.trx.get<T>(statement, parameters);
  }

  async all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    const rows = await this.trx.all<T>(statement, parameters);
    if (this.owner.armed && statement.includes('agentos_learning_ledger')) {
      this.owner.armed = false;
      await this.owner.between();
    }
    return rows;
  }

  exec(script: string): Promise<void> {
    return this.trx.exec(script);
  }

  transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** An adapter over `target` whose transactions' handles are {@link AppendBetweenTx}. */
class AppendBetween implements StorageAdapter {
  readonly kind: string;
  readonly capabilities: ReadonlySet<StorageCapability>;
  /** Whether the next statement of a transaction that reads the ledger runs `between` after it. */
  armed = false;

  constructor(
    private readonly target: StorageAdapter,
    readonly between: () => Promise<void>,
  ) {
    this.kind = target.kind;
    this.capabilities = target.capabilities;
  }

  open(): Promise<void> {
    return this.target.open();
  }

  close(): Promise<void> {
    return this.target.close();
  }

  run(statement: string, parameters?: StorageParameters): Promise<StorageRunResult> {
    return this.target.run(statement, parameters);
  }

  get<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T | null> {
    return this.target.get<T>(statement, parameters);
  }

  all<T = unknown>(statement: string, parameters?: StorageParameters): Promise<T[]> {
    return this.target.all<T>(statement, parameters);
  }

  exec(script: string): Promise<void> {
    return this.target.exec(script);
  }

  transaction<T>(fn: (trx: StorageAdapter) => Promise<T>): Promise<T> {
    return this.target.transaction((trx) => fn(new AppendBetweenTx(trx, this)));
  }
}

/** Waits until a statement of another session waits for a lock that the session `pid` holds. */
async function waitUntilBlockedBy(observer: StorageAdapter, pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await observer.get<{ blocked: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND ? = ANY (pg_blocking_pids(pid))) AS blocked',
      [pid],
    );
    if (row?.blocked === true) return;
    if (Date.now() > deadline) throw new Error(`no statement waited for session ${pid} within 15 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A store over `adapter` that closes the adapter when it closes, as the contract closes every store it opens. */
function closingItsAdapter(adapter: StorageAdapter): SqlLearningStore {
  const store = new SqlLearningStore({ adapter });
  const close = store.close.bind(store);
  store.close = async () => {
    await close();
    await adapter.close();
  };
  return store;
}

/** The contract, and what the store does on a database of each kind, over the adapters `open` makes. */
function storeCases(name: string, open: () => Promise<StorageAdapter>): void {
  runLearningStoreContract(`SqlLearningStore on ${name}`, async () => closingItsAdapter(await open()));

  describe(`SqlLearningStore on ${name}`, () => {
    it("leaves the host's adapter open when it closes", async () => {
      const adapter = await open();
      try {
        const store = new SqlLearningStore({ adapter });
        await store.insertForgotten('h', NOW);
        await store.close();
        expect(await adapter.get('SELECT hash, forgotten_at FROM agentos_learning_forgotten')).toEqual({ hash: 'h', forgotten_at: NOW });
      } finally {
        await adapter.close();
      }
    });

    it("reads a learner's outcomes, lessons and skills by creation time, then by id", async () => {
      const adapter = await open();
      try {
        const store = new SqlLearningStore({ adapter });
        expect(await store.learnerDocs('outcomes', 'A', 'tutor', '42')).toEqual([]);
        const rows: Array<[id: string, namespace: string, agentKey: string, userId: string, createdAt: string]> = [
          ['b', 'A', 'tutor', '42', NOW],
          ['C', 'A', 'tutor', '42', NOW],
          ['a', 'A', 'tutor', '42', NOW],
          ['first', 'A', 'tutor', '42', EARLIER],
          ['user-7', 'A', 'tutor', '7', EARLIER],
          ['coach', 'A', 'coach', '42', EARLIER],
          ['tenant-b', 'B', 'tutor', '42', EARLIER],
        ];
        for (const table of DOC_TABLES) {
          for (const [id, namespace, agentKey, userId, createdAt] of rows) {
            await adapter.run(
              `INSERT INTO agentos_learning_${table} (id, namespace, agent_key, user_id, body, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [`${table}:${id}`, namespace, agentKey, userId, `{"id":"${id}"}`, 2, createdAt, NOW],
            );
          }
        }

        for (const table of DOC_TABLES) {
          const docs = await store.learnerDocs(table, 'A', 'tutor', '42');
          // A locale's collation (en_US.utf8, say) sorts 'a' and 'b' before 'C'; by code unit 'C' comes first.
          expect(docs.map((doc) => doc.id)).toEqual([`${table}:first`, `${table}:C`, `${table}:a`, `${table}:b`]);
          expect(docs[0]).toEqual({
            id: `${table}:first`,
            namespace: 'A',
            agentKey: 'tutor',
            userId: '42',
            body: '{"id":"first"}',
            version: 2,
            createdAt: EARLIER,
            updatedAt: NOW,
          });
        }
      } finally {
        await adapter.close();
      }
    });

    it('adds a column a later release names to the tables an earlier release made, and keeps their rows', async () => {
      const adapter = await open();
      try {
        const earlier = new SqlLearningStore({ adapter });
        expect(await earlier.learnerDocs('outcomes', 'A', 'tutor', '42')).toEqual([]);
        await adapter.run(
          `INSERT INTO agentos_learning_outcomes (id, namespace, agent_key, user_id, body, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ['o-1', 'A', 'tutor', '42', '{}', 1, NOW, NOW],
        );
        const later: LearningColumnAddition[] = [{ table: 'agentos_learning_outcomes', column: 'team_source', definition: 'TEXT' }];

        await ensureLearningSchema(adapter, later);
        await ensureLearningSchema(adapter, later);

        expect(await adapter.get('SELECT id, team_source FROM agentos_learning_outcomes')).toEqual({ id: 'o-1', team_source: null });
        expect((await earlier.learnerDocs('outcomes', 'A', 'tutor', '42')).map((doc) => doc.id)).toEqual(['o-1']);
      } finally {
        await adapter.close();
      }
    });

    it('adds a later column once when two stores add it at the same moment', async () => {
      const adapter = await open();
      try {
        expect(await new SqlLearningStore({ adapter }).isForgotten('h')).toBe(false);
        const later: LearningColumnAddition[] = [{ table: 'agentos_learning_outcomes', column: 'team_source', definition: 'TEXT' }];
        // Each finds the column missing before either adds it; the one that adds it second finds it there.
        await Promise.all([ensureLearningSchema(adapter, later), ensureLearningSchema(adapter, later)]);
        expect(await adapter.all('SELECT id, team_source FROM agentos_learning_outcomes')).toEqual([]);
      } finally {
        await adapter.close();
      }
    });
  });
}

storeCases('SQLite', openSqlite);

describe.skipIf(!POSTGRES_URL)('on Postgres', () => {
  afterAll(async () => {
    if (segments.length === 0) return;
    const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  storeCases('Postgres', () => openPostgres());

  describe('the ledger, with two adapters on one database', () => {
    it('leaves one linear chain that verifies when both append to one chain at once', async () => {
      const segment = newSegment();
      const one = await openPostgres(segment);
      const two = await openPostgres(segment);
      try {
        const key = chainKeyOf(LEDGER_LEARNER);
        const a = new Ledger({ store: new SqlLearningStore({ adapter: one }) });
        const b = new Ledger({ store: new SqlLearningStore({ adapter: two }) });
        await a.propose(ledgerCandidate('first'), { verdict: 'kept' });
        // The second store finds the tables the first made before the two race.
        expect(await b.verifyChain(key)).toEqual({ ok: true, keyed: false });
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? a : b).propose(ledgerCandidate(`s-${i}`), { verdict: 'kept' })),
        );
        // Eight writers on one head can make one lose four swaps in a row: it answers conflict and writes nothing.
        expect(results.every((r) => r.status === 'kept' || r.status === 'conflict')).toBe(true);
        expect(results.some((r) => r.status === 'kept')).toBe(true);
        const rows = await new SqlLearningStore({ adapter: one }).chainRows(key);
        expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
        expect(rows.length).toBe(2 + 2 * results.filter((r) => r.status === 'kept').length);
        expect(await a.verifyChain(key)).toEqual({ ok: true, keyed: false });
      } finally {
        await one.close();
        await two.close();
      }
    });

    it('starts one chain when both append its first rows at once', async () => {
      const segment = newSegment();
      const one = await openPostgres(segment);
      const two = await openPostgres(segment);
      try {
        const key = chainKeyOf(LEDGER_LEARNER);
        const first = new SqlLearningStore({ adapter: one });
        const second = new SqlLearningStore({ adapter: two });
        // Each store makes or finds its tables before the race, one after the other.
        expect(await first.head(key)).toBeUndefined();
        expect(await second.head(key)).toBeUndefined();
        const a = new Ledger({ store: first });
        const b = new Ledger({ store: second });
        const results = await Promise.all([a.propose(ledgerCandidate('a'), { verdict: 'kept' }), b.propose(ledgerCandidate('b'), { verdict: 'kept' })]);
        expect(results.map((r) => r.status)).toEqual(['kept', 'kept']);
        expect((await first.chainRows(key)).map((r) => [r.seq, r.rowType])).toEqual([
          [1, 'candidate'],
          [2, 'verdict'],
          [3, 'candidate'],
          [4, 'verdict'],
        ]);
        expect(await first.head(key)).toMatchObject({ seq: 4, userId: '42', forgotten: false });
        expect(await b.verifyChain(key)).toEqual({ ok: true, keyed: false });
      } finally {
        await one.close();
        await two.close();
      }
    });

    it('checks a chain as it stood at one moment while another adapter appends to it', async () => {
      const segment = newSegment();
      const one = await openPostgres(segment);
      const two = await openPostgres(segment);
      try {
        const key = chainKeyOf(LEDGER_LEARNER);
        const writer = new Ledger({ store: new SqlLearningStore({ adapter: two }) });
        await writer.propose(ledgerCandidate('first'), { verdict: 'kept' });
        // The other adapter's append commits once the check has read the ledger, before the check reads on.
        const checking = new AppendBetween(one, async () => {
          expect((await writer.propose(ledgerCandidate('between'), { verdict: 'kept' })).status).toBe('kept');
        });
        const checker = new Ledger({ store: new SqlLearningStore({ adapter: checking }) });
        checking.armed = true;
        expect(await checker.verifyChain(key)).toEqual({ ok: true, keyed: false });
        expect(checking.armed).toBe(false);
        expect((await writer.entries(key)).map((entry) => entry.subject)).toEqual(['first', 'first', 'between', 'between']);
        expect(await checker.verifyChain(key)).toEqual({ ok: true, keyed: false });
      } finally {
        await one.close();
        await two.close();
      }
    });
  });

  describe('the tables, with two adapters on one database', () => {
    it('makes its tables while another connection makes them at the same moment', async () => {
      const segment = newSegment();
      const rival = await openPostgres(segment);
      const observer = await openPostgres(segment);
      const adapter = await openPostgres(segment);
      let opening: Promise<boolean> | undefined;
      try {
        await rival.transaction(async (trx) => {
          // The other connection's tables, made in a transaction it has not committed: the store's first statement
          // waits for the catalog rows they wrote, and Postgres fails it once they commit.
          await trx.exec(LEARNING_SCHEMA_DDL);
          const session = await trx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          opening = new SqlLearningStore({ adapter }).isForgotten('h');
          opening.catch(() => undefined);
          await waitUntilBlockedBy(observer, Number(session?.pid));
        });
        expect(await opening).toBe(false);
      } finally {
        await opening?.catch(() => undefined);
        await rival.close();
        await observer.close();
        await adapter.close();
      }
    });

    it('opens without waiting while another connection holds a write transaction on its tables', async () => {
      const segment = newSegment();
      const writing = await openPostgres(segment);
      const opening = await openPostgres(segment);
      const writer = new SqlLearningStore({ adapter: writing });
      expect(await writer.isForgotten('h')).toBe(false);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let wrote!: () => void;
      const written = new Promise<void>((resolve) => {
        wrote = resolve;
      });
      // A write left open on the ledger, a head and a session row, as a slow writer of another process holds one.
      const transaction = writer.transaction(async (tx) => {
        await tx.insertLedgerRow(ledgerRow({ id: 'held' }));
        await tx.insertHead(headRow({ lastId: 'held' }));
        await tx.putSessionRow(sessionRow());
        wrote();
        await held;
      });
      let first: Promise<boolean> | undefined;
      try {
        await written;
        first = new SqlLearningStore({ adapter: opening }).isForgotten('h');
        first.catch(() => undefined);
        const settled = await Promise.race([
          first.then(() => 'opened'),
          new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 3_000)),
        ]);
        expect(settled).toBe('opened');
      } finally {
        release();
        await transaction;
        await first?.catch(() => undefined);
        await writing.close();
        await opening.close();
      }
    });
  });
});

describe('SqlLearningStore', () => {
  it('refuses an adapter without transactions', async () => {
    const adapter = await openSqlite();
    try {
      const without = Object.assign(Object.create(adapter) as StorageAdapter, { capabilities: new Set() });
      expect(() => new SqlLearningStore({ adapter: without })).toThrow(/transactions/);
    } finally {
      await adapter.close();
    }
  });

  it('makes no table when a product runs its own migrations', async () => {
    const adapter = await openSqlite();
    try {
      const store = new SqlLearningStore({ adapter, ensureSchema: false });
      await expect(store.isForgotten('h')).rejects.toThrow(/no such table/);
      await adapter.exec(LEARNING_SCHEMA_DDL);
      expect(await store.isForgotten('h')).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it('makes its tables at its next call when its first attempt failed', async () => {
    const adapter = await openSqlite();
    try {
      vi.spyOn(adapter, 'exec').mockRejectedValueOnce(new Error('the database is not reachable'));
      const store = new SqlLearningStore({ adapter });
      await expect(store.isForgotten('h')).rejects.toThrow('the database is not reachable');
      await store.insertForgotten('h', NOW);
      expect(await store.isForgotten('h')).toBe(true);
    } finally {
      await adapter.close();
    }
  });
});
