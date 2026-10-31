/**
 * @module learning/store/InMemoryLearningStore
 *
 * The learning store in the process, for tests and short-lived processes: the default where a host gives the layer no
 * storage adapter. The ledger and the state it records end with the process, and until then the store holds every row
 * in memory, since ledger rows never decay; a long-running host gives the layer a storage adapter instead.
 *
 * Calls run one at a time, in the order they are made, and a call outside a transaction runs as a transaction of its
 * own. A transaction writes the rows in place and keeps an undo log, which it replays newest first when its function
 * throws, so no call copies the store's state and no call sees a write that a transaction takes back. A chain's,
 * a candidate's and a learner's ledger rows are found through maps keyed by each; a user's deletion is the one call
 * that reads every ledger row.
 */
import {
  TransactionalLearningStore,
  type ChainHead,
  type FreezeRow,
  type LearnerDocRow,
  type LearnerDocTable,
  type LearningStoreTx,
  type SessionRow,
  type StoredLedgerRow,
  type StoredTraitRow,
} from './LearningStore.js';

/** Every table's rows, and the maps that find ledger rows. Stored rows are never changed in place: a write replaces one. */
interface Tables {
  /** Ledger rows by id. */
  ledger: Map<string, StoredLedgerRow>;
  /** Ledger rows by chain key, then seq. */
  chains: Map<string, Map<number, StoredLedgerRow>>;
  /** Ledger rows by candidate id, then row id: a candidate and its verdicts. */
  candidates: Map<string, Map<string, StoredLedgerRow>>;
  /** Ledger rows with a `userId`, by learner (namespace, agent key, user id), then row id. */
  learners: Map<string, Map<string, StoredLedgerRow>>;
  heads: Map<string, ChainHead>;
  traits: Map<string, StoredTraitRow>;
  freezes: Map<string, FreezeRow>;
  sessions: Map<string, SessionRow>;
  /** When each tombstone was written, by its hash. */
  forgotten: Map<string, string>;
  docs: Record<LearnerDocTable, Map<string, LearnerDocRow>>;
}

const DOC_TABLES: readonly LearnerDocTable[] = ['outcomes', 'lessons', 'skills'];

const emptyTables = (): Tables => ({
  ledger: new Map(),
  chains: new Map(),
  candidates: new Map(),
  learners: new Map(),
  heads: new Map(),
  traits: new Map(),
  freezes: new Map(),
  sessions: new Map(),
  forgotten: new Map(),
  docs: { outcomes: new Map(), lessons: new Map(), skills: new Map() },
});

/** One key for several ids; JSON keeps `['a|b', 'c']` and `['a', 'b|c']` apart. */
const keyOf = (...parts: string[]): string => JSON.stringify(parts);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byChainAndSeq = (a: StoredLedgerRow, b: StoredLedgerRow): number => compare(a.chainKey, b.chainKey) || a.seq - b.seq;

/** Copies of ledger rows, ordered by chain key and seq. */
const sortedCopies = (rows: Iterable<StoredLedgerRow> | undefined): StoredLedgerRow[] =>
  rows ? [...rows].sort(byChainAndSeq).map((row) => ({ ...row })) : [];

const copySession = (row: SessionRow): SessionRow => ({ ...row, conversationIds: [...row.conversationIds], brainIds: [...row.brainIds] });

/** The writes of one transaction, each with the step that takes it back. */
class UndoLog {
  private readonly steps: Array<() => void> = [];

  /** Sets `key` in `map`, remembering what it held there. */
  set<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (map.has(key)) {
      const before = map.get(key) as V;
      this.steps.push(() => {
        map.set(key, before);
      });
    } else {
      this.steps.push(() => {
        map.delete(key);
      });
    }
    map.set(key, value);
  }

  /** Deletes `key` from `map`, remembering what it held there; `false` when it held nothing. */
  delete<K, V>(map: Map<K, V>, key: K): boolean {
    if (!map.has(key)) return false;
    const before = map.get(key) as V;
    this.steps.push(() => {
      map.set(key, before);
    });
    return map.delete(key);
  }

  /** Takes every write back, newest first. */
  undo(): void {
    while (this.steps.length > 0) this.steps.pop()?.();
  }
}

/** One transaction's handle. Every write goes through its undo log; once the transaction ends, every call throws. */
class MemoryTx implements LearningStoreTx {
  private ended = false;

  constructor(
    private readonly tables: Tables,
    private readonly log: UndoLog,
  ) {}

  /** Takes back every write the transaction made. */
  rollBack(): void {
    this.log.undo();
  }

  /** Ends the transaction: every later call on this handle throws. */
  end(): void {
    this.ended = true;
  }

  async insertLedgerRow(row: StoredLedgerRow): Promise<void> {
    const t = this.open();
    if (t.ledger.has(row.id)) throw new Error(`The learning ledger has a row with id ${row.id}.`);
    if (t.chains.get(row.chainKey)?.has(row.seq)) throw new Error(`The learning ledger's chain has a row at seq ${row.seq}.`);
    const stored = { ...row };
    this.log.set(t.ledger, stored.id, stored);
    this.index(t.chains, stored.chainKey, stored.seq, stored);
    this.index(t.candidates, stored.candidateId, stored.id, stored);
    if (stored.userId !== null) this.index(t.learners, keyOf(stored.namespace, stored.agentKey, stored.userId), stored.id, stored);
  }

  async ledgerRow(id: string): Promise<StoredLedgerRow | undefined> {
    const row = this.open().ledger.get(id);
    return row ? { ...row } : undefined;
  }

  async chainRows(chainKey: string): Promise<StoredLedgerRow[]> {
    return sortedCopies(this.open().chains.get(chainKey)?.values());
  }

  async candidateRows(candidateId: string): Promise<StoredLedgerRow[]> {
    return sortedCopies(this.open().candidates.get(candidateId)?.values());
  }

  async learnerLedgerRows(namespace: string, agentKey: string, userId: string): Promise<StoredLedgerRow[]> {
    return sortedCopies(this.open().learners.get(keyOf(namespace, agentKey, userId))?.values());
  }

  async head(chainKey: string): Promise<ChainHead | undefined> {
    const head = this.open().heads.get(chainKey);
    return head ? { ...head } : undefined;
  }

  async insertHead(head: ChainHead): Promise<boolean> {
    const t = this.open();
    if (t.heads.has(head.chainKey)) return false;
    this.log.set(t.heads, head.chainKey, { ...head });
    return true;
  }

  async advanceHead(chainKey: string, expectedSeq: number, next: { lastId: string; lastHash: string; seq: number }): Promise<boolean> {
    const t = this.open();
    const head = t.heads.get(chainKey);
    if (!head || head.forgotten || head.seq !== expectedSeq) return false;
    this.log.set(t.heads, chainKey, { ...head, lastId: next.lastId, lastHash: next.lastHash, seq: next.seq });
    return true;
  }

  async markHeadsForgotten(namespace: string, userId: string): Promise<number> {
    const t = this.open();
    const marked = [...t.heads.values()].filter((head) => head.namespace === namespace && head.userId === userId);
    for (const head of marked) this.log.set(t.heads, head.chainKey, { ...head, forgotten: true });
    return marked.length;
  }

  async traitRow(namespace: string, agentKey: string, userId: string): Promise<StoredTraitRow | undefined> {
    const row = this.open().traits.get(keyOf(namespace, agentKey, userId));
    return row ? { ...row } : undefined;
  }

  async insertTraitRow(row: StoredTraitRow): Promise<boolean> {
    const t = this.open();
    const key = keyOf(row.namespace, row.agentKey, row.userId);
    if (t.traits.has(key)) return false;
    this.log.set(t.traits, key, { ...row });
    return true;
  }

  async updateTraitRow(row: StoredTraitRow, expectedVersion: number): Promise<boolean> {
    const t = this.open();
    const key = keyOf(row.namespace, row.agentKey, row.userId);
    if (t.traits.get(key)?.version !== expectedVersion) return false;
    this.log.set(t.traits, key, { ...row });
    return true;
  }

  async freezeRows(): Promise<FreezeRow[]> {
    return [...this.open().freezes.values()]
      .sort((a, b) => compare(a.scopeKey, b.scopeKey) || compare(a.mode, b.mode))
      .map((row) => ({ ...row }));
  }

  async insertFreeze(row: FreezeRow): Promise<void> {
    const t = this.open();
    const key = keyOf(row.scopeKey, row.mode);
    if (!t.freezes.has(key)) this.log.set(t.freezes, key, { ...row });
  }

  async deleteFreeze(scopeKey: string, mode: FreezeRow['mode']): Promise<boolean> {
    return this.log.delete(this.open().freezes, keyOf(scopeKey, mode));
  }

  async sessionRow(namespace: string, agentKey: string, sessionId: string, userId: string, kind: SessionRow['kind']): Promise<SessionRow | undefined> {
    const row = this.open().sessions.get(keyOf(namespace, agentKey, sessionId, userId, kind));
    return row ? copySession(row) : undefined;
  }

  async putSessionRow(row: SessionRow): Promise<void> {
    const t = this.open();
    const key = keyOf(row.namespace, row.agentKey, row.sessionId, row.userId, row.kind);
    const startedAt = t.sessions.get(key)?.startedAt ?? row.startedAt;
    this.log.set(t.sessions, key, { ...copySession(row), startedAt });
  }

  async sessionRowsOf(namespace: string, userId: string): Promise<SessionRow[]> {
    return [...this.open().sessions.values()]
      .filter((row) => row.namespace === namespace && row.userId === userId)
      .sort((a, b) => compare(a.sessionId, b.sessionId) || compare(a.kind, b.kind))
      .map(copySession);
  }

  async isForgotten(hash: string): Promise<boolean> {
    return this.open().forgotten.has(hash);
  }

  async insertForgotten(hash: string, forgottenAt: string): Promise<void> {
    const t = this.open();
    if (!t.forgotten.has(hash)) this.log.set(t.forgotten, hash, forgottenAt);
  }

  async learnerDocs(table: LearnerDocTable, namespace: string, agentKey: string, userId: string): Promise<LearnerDocRow[]> {
    return [...this.open().docs[table].values()]
      .filter((row) => row.namespace === namespace && row.agentKey === agentKey && row.userId === userId)
      .sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
      .map((row) => ({ ...row }));
  }

  async deleteUserRows(namespace: string, userId: string): Promise<Record<string, number>> {
    const t = this.open();
    const ledger = [...t.ledger.values()].filter(
      (row) => row.namespace === namespace && (row.userId === userId || row.turnUserId === userId),
    );
    for (const row of ledger) {
      this.log.delete(t.ledger, row.id);
      this.unindex(t.chains, row.chainKey, row.seq);
      this.unindex(t.candidates, row.candidateId, row.id);
      if (row.userId !== null) this.unindex(t.learners, keyOf(row.namespace, row.agentKey, row.userId), row.id);
    }
    const deleted: Record<string, number> = { ledger: ledger.length };
    const ofUser = (row: { namespace: string; userId: string | null }) => row.namespace === namespace && row.userId === userId;
    deleted.heads = this.deleteWhere(t.heads, ofUser);
    deleted.traits = this.deleteWhere(t.traits, ofUser);
    for (const table of DOC_TABLES) deleted[table] = this.deleteWhere(t.docs[table], ofUser);
    deleted.sessions = this.deleteWhere(t.sessions, ofUser);
    deleted.freezes = this.deleteWhere(t.freezes, ofUser);
    return deleted;
  }

  /** The tables, while the transaction is open. */
  private open(): Tables {
    if (this.ended) throw new Error('A learning store transaction was used after it ended: make every call inside its function.');
    return this.tables;
  }

  private index<K>(index: Map<string, Map<K, StoredLedgerRow>>, key: string, inner: K, row: StoredLedgerRow): void {
    let rows = index.get(key);
    if (!rows) {
      rows = new Map();
      this.log.set(index, key, rows);
    }
    this.log.set(rows, inner, row);
  }

  private unindex<K>(index: Map<string, Map<K, StoredLedgerRow>>, key: string, inner: K): void {
    const rows = index.get(key);
    if (!rows) return;
    this.log.delete(rows, inner);
    if (rows.size === 0) this.log.delete(index, key);
  }

  private deleteWhere<V>(map: Map<string, V>, matches: (row: V) => boolean): number {
    const keys = [...map].filter(([, row]) => matches(row)).map(([key]) => key);
    for (const key of keys) this.log.delete(map, key);
    return keys.length;
  }
}

/** The learning store in the process, for tests and short-lived processes (see the module's description). */
export class InMemoryLearningStore extends TransactionalLearningStore {
  readonly kind = 'memory' as const;
  private readonly tables: Tables = emptyTables();
  /** Settles when the last call made so far has ended; the next call starts then. */
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const tx = new MemoryTx(this.tables, new UndoLog());
      try {
        return await fn(tx);
      } catch (error) {
        tx.rollBack();
        throw error;
      } finally {
        tx.end();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Releases nothing: the rows stay with the store until the process ends. */
  async close(): Promise<void> {}
}
