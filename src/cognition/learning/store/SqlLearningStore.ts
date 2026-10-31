/**
 * @module learning/store/SqlLearningStore
 *
 * The learning store over a `@framers/sql-storage-adapter` store: Postgres for a deployment that several processes
 * share, SQLite for one process and the tests. Each chain's head row orders appends across processes by
 * compare-and-swap (`advanceHead`), and every state change runs in one adapter transaction with its ledger row.
 *
 * Give it the runtime's raw storage adapter, never AgentOS's provenance-wrapped one, whose write hooks can turn a
 * `run()` into a no-op: a ledger write that silently does nothing would leave a change with no record. The store
 * leaves the adapter open when it closes.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
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
import { ensureLearningSchema } from './schema.js';
import type { LearningKind, LedgerVerdict } from '../types.js';

export interface SqlLearningStoreOptions {
  /** The host's storage adapter, with transactions. The store never closes it. */
  adapter: StorageAdapter;
  /**
   * Create the tables and add the columns a later release names before the store's first statement. Default `true`;
   * `false` for a product that runs the learning store's DDL in its own migrations.
   */
  ensureSchema?: boolean;
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => String(value);
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const toLedger = (r: Row): StoredLedgerRow => ({
  id: str(r.id),
  chainKey: str(r.chain_key),
  seq: Number(r.seq),
  rowType: str(r.row_type) as StoredLedgerRow['rowType'],
  candidateId: str(r.candidate_id),
  namespace: str(r.namespace),
  agentKey: str(r.agent_key),
  userId: strOrNull(r.user_id),
  turnUserId: strOrNull(r.turn_user_id),
  sessionId: strOrNull(r.session_id),
  kind: str(r.kind) as LearningKind,
  subject: str(r.subject),
  verdict: str(r.verdict) as LedgerVerdict,
  body: str(r.body),
  prevHash: str(r.prev_hash),
  hash: str(r.hash),
  stateDigest: strOrNull(r.state_digest),
  createdAt: str(r.created_at),
});

const toHead = (r: Row): ChainHead => ({
  chainKey: str(r.chain_key),
  namespace: str(r.namespace),
  agentKey: str(r.agent_key),
  userId: strOrNull(r.user_id),
  lastId: str(r.last_id),
  lastHash: str(r.last_hash),
  seq: Number(r.seq),
  forgotten: Number(r.forgotten) === 1,
});

const toTrait = (r: Row): StoredTraitRow => ({
  namespace: str(r.namespace),
  agentKey: str(r.agent_key),
  userId: str(r.user_id),
  personaId: str(r.persona_id),
  state: str(r.state),
  version: Number(r.version),
  updatedAt: str(r.updated_at),
});

const toFreeze = (r: Row): FreezeRow => ({
  scopeKey: str(r.scope_key),
  mode: str(r.mode) as FreezeRow['mode'],
  namespace: str(r.namespace),
  agentKey: strOrNull(r.agent_key),
  userId: strOrNull(r.user_id),
  setBy: str(r.set_by),
  createdAt: str(r.created_at),
});

/** A JSON list of strings as stored; anything else reads as an empty list. */
const parseList = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(str(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const toSession = (r: Row): SessionRow => ({
  namespace: str(r.namespace),
  agentKey: str(r.agent_key),
  sessionId: str(r.session_id),
  userId: str(r.user_id),
  kind: str(r.kind) as SessionRow['kind'],
  personaId: str(r.persona_id),
  conversationIds: parseList(r.conversation_ids),
  brainIds: parseList(r.brain_ids),
  startedAt: str(r.started_at),
  version: Number(r.version),
});

const toDoc = (r: Row): LearnerDocRow => ({
  id: str(r.id),
  namespace: str(r.namespace),
  agentKey: str(r.agent_key),
  userId: str(r.user_id),
  body: str(r.body),
  version: Number(r.version),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

const LEDGER_COLUMNS =
  'id, chain_key, seq, row_type, candidate_id, namespace, agent_key, user_id, turn_user_id, session_id, kind, subject, verdict, body, prev_hash, hash, state_digest, created_at';

const DOC_TABLES: Record<LearnerDocTable, string> = {
  outcomes: 'agentos_learning_outcomes',
  lessons: 'agentos_learning_lessons',
  skills: 'agentos_learning_skills',
};

/** The tables `deleteUserRows` deletes a user's rows from by `user_id`, after the ledger, each under its count's name. */
const USER_TABLES: ReadonlyArray<[name: string, table: string]> = [
  ['heads', 'agentos_learning_heads'],
  ['traits', 'agentos_learning_traits'],
  ['outcomes', 'agentos_learning_outcomes'],
  ['lessons', 'agentos_learning_lessons'],
  ['skills', 'agentos_learning_skills'],
  ['sessions', 'agentos_learning_sessions'],
  ['freezes', 'agentos_learning_freezes'],
];

/** One transaction's handle, over the adapter's handle for that transaction. */
class SqlTx implements LearningStoreTx {
  constructor(private readonly db: StorageAdapter) {}

  async insertLedgerRow(row: StoredLedgerRow): Promise<void> {
    await this.db.run(
      `INSERT INTO agentos_learning_ledger (${LEDGER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.chainKey, row.seq, row.rowType, row.candidateId, row.namespace, row.agentKey, row.userId,
        row.turnUserId, row.sessionId, row.kind, row.subject, row.verdict, row.body, row.prevHash, row.hash,
        row.stateDigest, row.createdAt,
      ],
    );
  }

  async ledgerRow(id: string): Promise<StoredLedgerRow | undefined> {
    const row = await this.db.get<Row>(`SELECT ${LEDGER_COLUMNS} FROM agentos_learning_ledger WHERE id = ?`, [id]);
    return row ? toLedger(row) : undefined;
  }

  async chainRows(chainKey: string): Promise<StoredLedgerRow[]> {
    return (await this.db.all<Row>(`SELECT ${LEDGER_COLUMNS} FROM agentos_learning_ledger WHERE chain_key = ? ORDER BY seq`, [chainKey])).map(toLedger);
  }

  async candidateRows(candidateId: string): Promise<StoredLedgerRow[]> {
    return (
      await this.db.all<Row>(`SELECT ${LEDGER_COLUMNS} FROM agentos_learning_ledger WHERE candidate_id = ? ORDER BY chain_key, seq`, [candidateId])
    ).map(toLedger);
  }

  async learnerLedgerRows(namespace: string, agentKey: string, userId: string): Promise<StoredLedgerRow[]> {
    return (
      await this.db.all<Row>(
        `SELECT ${LEDGER_COLUMNS} FROM agentos_learning_ledger WHERE namespace = ? AND agent_key = ? AND user_id = ? ORDER BY chain_key, seq`,
        [namespace, agentKey, userId],
      )
    ).map(toLedger);
  }

  async head(chainKey: string): Promise<ChainHead | undefined> {
    const row = await this.db.get<Row>('SELECT * FROM agentos_learning_heads WHERE chain_key = ?', [chainKey]);
    return row ? toHead(row) : undefined;
  }

  async insertHead(head: ChainHead): Promise<boolean> {
    const result = await this.db.run(
      `INSERT INTO agentos_learning_heads (chain_key, namespace, agent_key, user_id, last_id, last_hash, seq, forgotten)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chain_key) DO NOTHING`,
      [head.chainKey, head.namespace, head.agentKey, head.userId, head.lastId, head.lastHash, head.seq, head.forgotten ? 1 : 0],
    );
    return result.changes > 0;
  }

  async advanceHead(chainKey: string, expectedSeq: number, next: { lastId: string; lastHash: string; seq: number }): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE agentos_learning_heads SET last_id = ?, last_hash = ?, seq = ?
        WHERE chain_key = ? AND seq = ? AND forgotten = 0`,
      [next.lastId, next.lastHash, next.seq, chainKey, expectedSeq],
    );
    return result.changes > 0;
  }

  async markHeadsForgotten(namespace: string, userId: string): Promise<number> {
    const result = await this.db.run('UPDATE agentos_learning_heads SET forgotten = 1 WHERE namespace = ? AND user_id = ?', [namespace, userId]);
    return result.changes;
  }

  async traitRow(namespace: string, agentKey: string, userId: string): Promise<StoredTraitRow | undefined> {
    const row = await this.db.get<Row>(
      'SELECT * FROM agentos_learning_traits WHERE namespace = ? AND agent_key = ? AND user_id = ?',
      [namespace, agentKey, userId],
    );
    return row ? toTrait(row) : undefined;
  }

  async insertTraitRow(row: StoredTraitRow): Promise<boolean> {
    const result = await this.db.run(
      `INSERT INTO agentos_learning_traits (namespace, agent_key, user_id, persona_id, state, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (namespace, agent_key, user_id) DO NOTHING`,
      [row.namespace, row.agentKey, row.userId, row.personaId, row.state, row.version, row.updatedAt],
    );
    return result.changes > 0;
  }

  async updateTraitRow(row: StoredTraitRow, expectedVersion: number): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE agentos_learning_traits SET persona_id = ?, state = ?, version = ?, updated_at = ?
        WHERE namespace = ? AND agent_key = ? AND user_id = ? AND version = ?`,
      [row.personaId, row.state, row.version, row.updatedAt, row.namespace, row.agentKey, row.userId, expectedVersion],
    );
    return result.changes > 0;
  }

  async freezeRows(): Promise<FreezeRow[]> {
    return (await this.db.all<Row>('SELECT * FROM agentos_learning_freezes ORDER BY scope_key, mode')).map(toFreeze);
  }

  async insertFreeze(row: FreezeRow): Promise<void> {
    await this.db.run(
      `INSERT INTO agentos_learning_freezes (scope_key, mode, namespace, agent_key, user_id, set_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (scope_key, mode) DO NOTHING`,
      [row.scopeKey, row.mode, row.namespace, row.agentKey, row.userId, row.setBy, row.createdAt],
    );
  }

  async deleteFreeze(scopeKey: string, mode: FreezeRow['mode']): Promise<boolean> {
    const result = await this.db.run('DELETE FROM agentos_learning_freezes WHERE scope_key = ? AND mode = ?', [scopeKey, mode]);
    return result.changes > 0;
  }

  async sessionRow(namespace: string, agentKey: string, sessionId: string, userId: string, kind: SessionRow['kind']): Promise<SessionRow | undefined> {
    const row = await this.db.get<Row>(
      `SELECT * FROM agentos_learning_sessions
        WHERE namespace = ? AND agent_key = ? AND session_id = ? AND user_id = ? AND kind = ?`,
      [namespace, agentKey, sessionId, userId, kind],
    );
    return row ? toSession(row) : undefined;
  }

  async putSessionRow(row: SessionRow): Promise<void> {
    await this.db.run(
      `INSERT INTO agentos_learning_sessions
         (namespace, agent_key, session_id, user_id, kind, persona_id, conversation_ids, brain_ids, started_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (namespace, agent_key, session_id, user_id, kind) DO UPDATE SET
         persona_id = excluded.persona_id, conversation_ids = excluded.conversation_ids,
         brain_ids = excluded.brain_ids, version = excluded.version`,
      [
        row.namespace, row.agentKey, row.sessionId, row.userId, row.kind, row.personaId,
        JSON.stringify(row.conversationIds), JSON.stringify(row.brainIds), row.startedAt, row.version,
      ],
    );
  }

  async sessionRowsOf(namespace: string, userId: string): Promise<SessionRow[]> {
    return (
      await this.db.all<Row>('SELECT * FROM agentos_learning_sessions WHERE namespace = ? AND user_id = ? ORDER BY session_id, kind', [namespace, userId])
    ).map(toSession);
  }

  async isForgotten(hash: string): Promise<boolean> {
    return Boolean(await this.db.get<Row>('SELECT hash FROM agentos_learning_forgotten WHERE hash = ?', [hash]));
  }

  async insertForgotten(hash: string, forgottenAt: string): Promise<void> {
    await this.db.run('INSERT INTO agentos_learning_forgotten (hash, forgotten_at) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING', [hash, forgottenAt]);
  }

  async learnerDocs(table: LearnerDocTable, namespace: string, agentKey: string, userId: string): Promise<LearnerDocRow[]> {
    return (
      await this.db.all<Row>(
        `SELECT * FROM ${DOC_TABLES[table]} WHERE namespace = ? AND agent_key = ? AND user_id = ? ORDER BY created_at, id`,
        [namespace, agentKey, userId],
      )
    ).map(toDoc);
  }

  async deleteUserRows(namespace: string, userId: string): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    deleted.ledger = (
      await this.db.run('DELETE FROM agentos_learning_ledger WHERE namespace = ? AND (user_id = ? OR turn_user_id = ?)', [namespace, userId, userId])
    ).changes;
    for (const [name, table] of USER_TABLES) {
      deleted[name] = (await this.db.run(`DELETE FROM ${table} WHERE namespace = ? AND user_id = ?`, [namespace, userId])).changes;
    }
    return deleted;
  }
}

/** The learning store over a SQL storage adapter (see the module's description). */
export class SqlLearningStore extends TransactionalLearningStore {
  readonly kind = 'sql' as const;
  private readonly adapter: StorageAdapter;
  private readonly ensureSchema: boolean;
  /** Settles once the tables exist; unset again when making them failed, so the next call tries again. */
  private ready: Promise<void> | undefined;

  /** @throws {Error} When the adapter has no transactions: a change and its ledger row must commit together. */
  constructor(options: SqlLearningStoreOptions) {
    super();
    if (!options.adapter.capabilities.has('transactions')) {
      throw new Error(
        `A SQL learning store needs a storage adapter with transactions, so that a change and its ledger row commit together; "${options.adapter.kind}" has none.`,
      );
    }
    this.adapter = options.adapter;
    this.ensureSchema = options.ensureSchema !== false;
  }

  private whenReady(): Promise<void> {
    if (!this.ensureSchema) return Promise.resolve();
    this.ready ??= ensureLearningSchema(this.adapter).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async transaction<T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T> {
    await this.whenReady();
    return this.adapter.transaction((trx) => fn(new SqlTx(trx)));
  }

  /** Leaves the adapter open: it is the host's. */
  async close(): Promise<void> {}
}
