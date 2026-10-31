/**
 * @module learning/store/LearningStore
 *
 * Where learned state lives: the ledger and each chain's head, the trait rows, outcomes, lessons and skills, freezes
 * and suspensions, the sessions a layer served, and the tombstones of forgotten users. Every learner-keyed row carries
 * its learner's namespace. The store holds rows and decides nothing: the ledger (`ledger/Ledger.ts`) is the only
 * writer of ledger and head rows, and every state change runs in {@link LearningStore.transaction} with its ledger
 * row, so the two commit together or not at all.
 */
import type { LearningKind, LedgerVerdict } from '../types.js';

/** A ledger row as stored: the entry's canonical JSON, the columns it is read by, and its place in its chain. */
export interface StoredLedgerRow {
  /** A ULID, so ids sort by time. */
  id: string;
  /** The chain the row belongs to (`ledger/Ledger.ts`, `chainKeyOf`). */
  chainKey: string;
  /** The row's place in its chain, from 1. Unique within the chain. */
  seq: number;
  rowType: 'candidate' | 'verdict';
  /** A candidate's own id; a verdict's candidate. */
  candidateId: string;
  namespace: string;
  agentKey: string;
  /** The learner's user id; `null` on a row with no learner. */
  userId: string | null;
  /** On a `userId: null` row, the explicit id of a second user whose turn it records. */
  turnUserId: string | null;
  sessionId: string | null;
  kind: LearningKind;
  subject: string;
  verdict: LedgerVerdict;
  /** The canonical JSON of the whole entry but its hash, which the hash is taken over. */
  body: string;
  prevHash: string;
  hash: string;
  /** On a row that changes its subject's stored state, the digest of that state after the change. */
  stateDigest: string | null;
  createdAt: string;
}

/** One chain's head: the newest row and its hash, and the forgotten mark `forgetUser` sets. */
export interface ChainHead {
  chainKey: string;
  namespace: string;
  agentKey: string;
  /** The user the chain belongs to: its learner's, or a visitor's `turnUserId`; `null` for the agent's chain. */
  userId: string | null;
  lastId: string;
  lastHash: string;
  seq: number;
  forgotten: boolean;
}

/** A learner's trait state; `state` is the JSON `learning/traitState.ts` reads and writes. */
export interface StoredTraitRow {
  namespace: string;
  agentKey: string;
  userId: string;
  personaId: string;
  state: string;
  /** Advanced by every update; an update names the version it read. */
  version: number;
  updatedAt: string;
}

/** A run-time freeze or suspension: its scope, and `frozen` or `off`. */
export interface FreezeRow {
  /** `all`, `agent|<agentKey>` or `learner|<namespace>|<agentKey>|<userId>` (`hostCalls.ts`, `freezeScopeKey`). */
  scopeKey: string;
  mode: 'frozen' | 'off';
  namespace: string;
  agentKey: string | null;
  userId: string | null;
  setBy: string;
  createdAt: string;
}

/**
 * A session a layer served: the learner's own (`learner`), or one in which a user other than its first spoke with an
 * explicit id (`visitor`, written at that user's first turn there). `forgetUser` reads both kinds.
 */
export interface SessionRow {
  namespace: string;
  agentKey: string;
  sessionId: string;
  userId: string;
  kind: 'learner' | 'visitor';
  personaId: string;
  /** The conversation ids the session's turns named. */
  conversationIds: string[];
  /** The brains that hold the session's memory: the GMI's, and the memory tools' facade once it filed for the user. */
  brainIds: string[];
  /** When the row was first written; writing the row again keeps it. */
  startedAt: string;
  version: number;
}

/** A row of the outcomes, lessons or skills table: its learner and its JSON body. The store reads these rows by learner and deletes them with a user. */
export interface LearnerDocRow {
  id: string;
  namespace: string;
  agentKey: string;
  userId: string;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The tables that hold learner documents. */
export type LearnerDocTable = 'outcomes' | 'lessons' | 'skills';

/**
 * What one transaction, or the store outside one, reads and writes. Every row the store is given is copied, and every
 * row it hands out is a copy: changing either changes nothing stored.
 */
export interface LearningStoreTx {
  /** Appends a row; throws when a row has its id, or its chain has a row at its seq. */
  insertLedgerRow(row: StoredLedgerRow): Promise<void>;
  ledgerRow(id: string): Promise<StoredLedgerRow | undefined>;
  /** A chain's rows in sequence order. */
  chainRows(chainKey: string): Promise<StoredLedgerRow[]>;
  /** A candidate and its verdicts, in sequence order. */
  candidateRows(candidateId: string): Promise<StoredLedgerRow[]>;
  /** The rows keyed to one learner (by namespace, agent and `userId`), ordered by chain key and sequence. */
  learnerLedgerRows(namespace: string, agentKey: string, userId: string): Promise<StoredLedgerRow[]>;

  head(chainKey: string): Promise<ChainHead | undefined>;
  /** Starts a chain's head; `false` when the chain has one. */
  insertHead(head: ChainHead): Promise<boolean>;
  /**
   * Moves a head from `expectedSeq` to `next`, whose `lastId`, `lastHash` and `seq` alone it writes; `false` when the
   * chain has no head, the head moved on, or it is marked forgotten.
   */
  advanceHead(chainKey: string, expectedSeq: number, next: { lastId: string; lastHash: string; seq: number }): Promise<boolean>;
  /** Marks every head of one user in one namespace forgotten; returns how many. */
  markHeadsForgotten(namespace: string, userId: string): Promise<number>;

  traitRow(namespace: string, agentKey: string, userId: string): Promise<StoredTraitRow | undefined>;
  /** `false` when the learner has a row. */
  insertTraitRow(row: StoredTraitRow): Promise<boolean>;
  /** Writes `row` over the row at `expectedVersion`; `false` when another write moved it on, or there is none. */
  updateTraitRow(row: StoredTraitRow, expectedVersion: number): Promise<boolean>;

  /** Every freeze and suspension, ordered by scope key and mode. */
  freezeRows(): Promise<FreezeRow[]>;
  /** Idempotent: a scope frozen twice holds one row, the first. */
  insertFreeze(row: FreezeRow): Promise<void>;
  deleteFreeze(scopeKey: string, mode: FreezeRow['mode']): Promise<boolean>;

  sessionRow(namespace: string, agentKey: string, sessionId: string, userId: string, kind: SessionRow['kind']): Promise<SessionRow | undefined>;
  /** Inserts the row, or writes it over the row of the same learner, session and kind, keeping that row's `startedAt`. */
  putSessionRow(row: SessionRow): Promise<void>;
  /** One user's session rows of both kinds in one namespace, every agent's, ordered by session id and kind. */
  sessionRowsOf(namespace: string, userId: string): Promise<SessionRow[]>;

  isForgotten(hash: string): Promise<boolean>;
  /** Idempotent. */
  insertForgotten(hash: string, forgottenAt: string): Promise<void>;

  /** One learner's rows of a learner document table, ordered by `createdAt` and id. */
  learnerDocs(table: LearnerDocTable, namespace: string, agentKey: string, userId: string): Promise<LearnerDocRow[]>;

  /**
   * Deletes every row of one user in one namespace: ledger rows whose `userId` or `turnUserId` is the user, the
   * user's heads, trait rows, outcomes, lessons, skills, session rows of both kinds, and freezes keyed to the user's
   * learners. Never the tombstone, which every later write for the user checks.
   *
   * @returns The rows deleted, per table: `ledger`, `heads`, `traits`, `outcomes`, `lessons`, `skills`, `sessions`
   *   and `freezes`.
   */
  deleteUserRows(namespace: string, userId: string): Promise<Record<string, number>>;
}

/** A learning store: the operations above, a transaction, and its end. */
export interface LearningStore extends LearningStoreTx {
  /** `sql` for a store over a storage adapter; `memory` for one that ends with the process. */
  readonly kind: 'sql' | 'memory';
  /**
   * Runs `fn` in one transaction: every write it makes through `tx` commits together, or none does when it throws.
   * `fn` makes every call through `tx`, never through the store: a call on the store runs outside the transaction,
   * and a store that runs one call at a time holds it until the transaction ends, so a transaction that waits for it
   * never ends.
   */
  transaction<T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T>;
  /** Releases what the store opened. A store over a host's adapter leaves the adapter open. */
  close(): Promise<void>;
}

/** Runs each operation of a store outside a transaction as a transaction of its own. */
export abstract class TransactionalLearningStore implements LearningStore {
  abstract readonly kind: LearningStore['kind'];
  abstract transaction<T>(fn: (tx: LearningStoreTx) => Promise<T>): Promise<T>;
  abstract close(): Promise<void>;

  insertLedgerRow(row: StoredLedgerRow) { return this.transaction((tx) => tx.insertLedgerRow(row)); }
  ledgerRow(id: string) { return this.transaction((tx) => tx.ledgerRow(id)); }
  chainRows(chainKey: string) { return this.transaction((tx) => tx.chainRows(chainKey)); }
  candidateRows(candidateId: string) { return this.transaction((tx) => tx.candidateRows(candidateId)); }
  learnerLedgerRows(namespace: string, agentKey: string, userId: string) { return this.transaction((tx) => tx.learnerLedgerRows(namespace, agentKey, userId)); }
  head(chainKey: string) { return this.transaction((tx) => tx.head(chainKey)); }
  insertHead(head: ChainHead) { return this.transaction((tx) => tx.insertHead(head)); }
  advanceHead(chainKey: string, expectedSeq: number, next: { lastId: string; lastHash: string; seq: number }) { return this.transaction((tx) => tx.advanceHead(chainKey, expectedSeq, next)); }
  markHeadsForgotten(namespace: string, userId: string) { return this.transaction((tx) => tx.markHeadsForgotten(namespace, userId)); }
  traitRow(namespace: string, agentKey: string, userId: string) { return this.transaction((tx) => tx.traitRow(namespace, agentKey, userId)); }
  insertTraitRow(row: StoredTraitRow) { return this.transaction((tx) => tx.insertTraitRow(row)); }
  updateTraitRow(row: StoredTraitRow, expectedVersion: number) { return this.transaction((tx) => tx.updateTraitRow(row, expectedVersion)); }
  freezeRows() { return this.transaction((tx) => tx.freezeRows()); }
  insertFreeze(row: FreezeRow) { return this.transaction((tx) => tx.insertFreeze(row)); }
  deleteFreeze(scopeKey: string, mode: FreezeRow['mode']) { return this.transaction((tx) => tx.deleteFreeze(scopeKey, mode)); }
  sessionRow(namespace: string, agentKey: string, sessionId: string, userId: string, kind: SessionRow['kind']) { return this.transaction((tx) => tx.sessionRow(namespace, agentKey, sessionId, userId, kind)); }
  putSessionRow(row: SessionRow) { return this.transaction((tx) => tx.putSessionRow(row)); }
  sessionRowsOf(namespace: string, userId: string) { return this.transaction((tx) => tx.sessionRowsOf(namespace, userId)); }
  isForgotten(hash: string) { return this.transaction((tx) => tx.isForgotten(hash)); }
  insertForgotten(hash: string, forgottenAt: string) { return this.transaction((tx) => tx.insertForgotten(hash, forgottenAt)); }
  learnerDocs(table: LearnerDocTable, namespace: string, agentKey: string, userId: string) { return this.transaction((tx) => tx.learnerDocs(table, namespace, agentKey, userId)); }
  deleteUserRows(namespace: string, userId: string) { return this.transaction((tx) => tx.deleteUserRows(namespace, userId)); }
}
