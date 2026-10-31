/**
 * @module learning/ledger/Ledger
 *
 * The only writer of `agentos_learning_ledger` and `agentos_learning_heads`. Every lasting self-change is proposed
 * here before any state changes; the change runs in the same store transaction as its rows, or, for a memory write in
 * a store of its own, between a `pending` row and its verdict. A row with a learner chains under the learner; a
 * `userId: null` row under the visitor it names, else under the agent; so `forgetUser` removes whole chains and leaves
 * every other chain whole. Each chain's head row is advanced by compare-and-swap before the rows are written, so a
 * writer in another process that read the same head loses, re-reads and appends after it. A change with no record
 * does not happen: a store error cancels the change and reaches the caller.
 *
 * A row's text is the canonical JSON of its entry, which holds the chain's previous hash and the row's place in the
 * chain; its hash is SHA-256 over that text, or HMAC-SHA-256 under `learning.ledgerKey`. A verdict decides a `pending`
 * candidate (`kept`, `rejected` or `reverted`), and `reverted` follows a `kept` one; the ledger refuses any other
 * verdict inside the transaction that would write it, so of two processes that decide one candidate at once, one
 * writes its verdict.
 *
 * Limits: a SQLite store serves one adapter. Its transactions run one at a time on the adapter's one connection, and
 * the ledger retries a moved head, not a file another connection holds locked: of two adapters on one SQLite file, in
 * one process or two, an append that runs while the other's does can fail with SQLite's busy error, so processes that
 * share learners share a Postgres store. The load check reads every row of a chain, the rows before its newest
 * reanchor included.
 */
import { encodeScopeIdPart } from '../../memory/retrieval/store/scopeIdForm.js';
import { processIsFrozen } from '../config.js';
import type { LearningStore, LearningStoreTx, StoredLedgerRow } from '../store/LearningStore.js';
import type {
  LearningKind,
  LedgerEntry,
  LedgerEvidence,
  LedgerLearner,
  LedgerVerdict,
  LedgerVersions,
} from '../types.js';
import { agentosVersion, canonicalJson, GENESIS_HASH, hmacSha256Hex, sha256Hex } from './canonical.js';
import { ulid } from './ids.js';

/** The chain a row belongs to: its learner's, else that of the visitor it names, else the agent's. */
export function chainKeyOf(learner: LedgerLearner, turnUserId?: string | null): string {
  const ns = encodeScopeIdPart(learner.namespace);
  const agent = encodeScopeIdPart(learner.agentKey);
  if (learner.userId !== null) return `u|${ns}|${agent}|${encodeScopeIdPart(learner.userId)}`;
  if (turnUserId) return `t|${ns}|${agent}|${encodeScopeIdPart(turnUserId)}`;
  return `a|${ns}|${agent}`;
}

/** The tombstone of a forgotten user: SHA-256 over the canonical JSON `[namespace, userId]`, unkeyed. */
export function tombstoneHash(namespace: string, userId: string): Promise<string> {
  return sha256Hex(canonicalJson([namespace, userId]));
}

/** What a row proposes. */
export interface CandidateInput {
  learner: LedgerLearner;
  kind: LearningKind;
  actor: string;
  subject: string;
  before: unknown;
  after: unknown;
  evidence?: LedgerEvidence;
  sessionId?: string;
  /**
   * On a `userId: null` row, the explicit id of a second user whose turn it records. A blank id names no one. A row
   * with a learner takes none: it would sit in the learner's chain, and that user's deletion would cut it out.
   */
  turnUserId?: string;
  versions?: Partial<LedgerVersions>;
}

export interface ProposeOptions {
  /** `pending` (default) writes the candidate alone; `kept`, `rejected` or `reverted` writes its verdict with it. */
  verdict?: LedgerVerdict;
  /**
   * The reason the candidate records, and its verdict with it; an `operator_set` candidate whose reason is `reanchor`
   * starts its chain's verified part, and is written after the chain's newest row though its head was deleted or
   * moved back outside the layer. Default `pending`, or the verdict's name.
   */
  reason?: string;
  /** On a row that changes its subject's stored state: that state's digest after the change. */
  stateDigest?: string;
  /** The state change, run in the same transaction as the rows: a throw writes neither. */
  change?: (tx: LearningStoreTx, rows: LedgerEntry[]) => Promise<void>;
  /** An operator's act (`operatorSet`, `revert`, an import, a trait row's creation): it runs under a freeze. */
  operator?: boolean;
  /**
   * Verdicts on earlier candidates of the same chain, written with this candidate (a revert's `reverted`). Each must
   * be able to follow its candidate's current verdict, as `decide` requires; otherwise `propose` throws and writes
   * nothing.
   */
  alsoDecide?: Array<{ candidateId: string; verdict: LedgerVerdict; reason: string }>;
}

/**
 * What `propose` did. `frozen`: a freeze refused a new candidate, and nothing was written. `forgotten`: the chain's
 * user is forgotten: nothing was written, or the append found the tombstone once it had committed and ran the user's
 * deletion again, so the change does not stand. `conflict`: the chain's head moved under each of four attempts in a
 * row; nothing was written and the change was not made, and no `rejected` row records it, since that row would race
 * for the same head.
 */
export type ProposeResult =
  | { status: 'pending' | 'kept' | 'rejected' | 'reverted'; candidate: LedgerEntry; verdict?: LedgerEntry; rows: LedgerEntry[] }
  | { status: 'frozen' | 'forgotten' | 'conflict' };

/**
 * What `decide` did. `refused`: the candidate's current verdict, `current`, is one this verdict cannot follow, and
 * nothing was written. `forgotten` and `conflict` as for `propose`.
 */
export type DecideResult =
  | { status: Exclude<LedgerVerdict, 'pending'>; verdict: LedgerEntry }
  | { status: 'forgotten' | 'conflict' | 'unknown_candidate' }
  | { status: 'refused'; current: LedgerVerdict };

export type ChainCheck = { ok: true; keyed: boolean } | { ok: false; keyed: boolean; reason: string };

export interface LedgerOptions {
  store: LearningStore;
  /** `learning.ledgerKey`: keys every hash (HMAC-SHA-256). A secret the store never holds. */
  ledgerKey?: string;
  /** Milliseconds since the epoch. Default `Date.now`. */
  clock?: () => number;
  /**
   * Whether a new candidate of this learner is frozen; read on every `propose`, beside `AGENTOS_LEARNING_FREEZE=1`,
   * which freezes every learner of the process. Default: never.
   */
  isFrozen?: (learner: LedgerLearner) => boolean;
  /**
   * `forgetUser`'s learning-store deletion for one user, run again when an append finds the tombstone after it
   * committed. Default: the store's `deleteUserRows`.
   */
  onForgottenAfterCommit?: (namespace: string, userId: string) => Promise<void>;
  /** The versions every row records, beside what a candidate names. */
  versions?: Partial<LedgerVersions>;
}

/** One try and three retries: an append that loses its compare-and-swap that often answers `conflict`. */
const APPEND_ATTEMPTS = 4;

/** Thrown inside a transaction whose head another writer moved: rolls the transaction back for a retry. */
class HeadMoved extends Error {}

/** A draft row: everything but the chain's fields. A candidate's draft carries the id its verdicts name. */
type Draft = Omit<LedgerEntry, 'id' | 'prevHash' | 'seq' | 'createdAt'> & { id?: string };

type Appended = { status: 'appended'; rows: LedgerEntry[] };

/** The columns of a stored row that must equal its own text, so an edit to a column alone shows. */
const INDEXED: Array<[keyof StoredLedgerRow, (entry: LedgerEntry) => unknown]> = [
  ['id', (e) => e.id],
  ['seq', (e) => e.seq],
  ['rowType', (e) => e.rowType],
  ['candidateId', (e) => e.candidateId],
  ['namespace', (e) => e.learner.namespace],
  ['agentKey', (e) => e.learner.agentKey],
  ['userId', (e) => e.learner.userId],
  ['turnUserId', (e) => e.turnUserId ?? null],
  ['sessionId', (e) => e.sessionId ?? null],
  ['kind', (e) => e.kind],
  ['subject', (e) => e.subject],
  ['verdict', (e) => e.verdict],
  ['prevHash', (e) => e.prevHash],
  ['stateDigest', (e) => e.stateDigest ?? null],
  ['createdAt', (e) => e.createdAt],
];

/** The verdicts that may follow a candidate's current one: a verdict decides a `pending` candidate, and `reverted` follows `kept`. */
const NEXT_VERDICTS: Readonly<Record<LedgerVerdict, readonly LedgerVerdict[]>> = {
  pending: ['kept', 'rejected', 'reverted'],
  kept: ['reverted'],
  rejected: [],
  reverted: [],
};

/** A candidate's current verdict, from its rows: its latest verdict row's, or `pending`; `undefined` with no candidate row. */
function currentVerdictOf(rows: readonly StoredLedgerRow[]): LedgerVerdict | undefined {
  if (!rows.some((row) => row.rowType === 'candidate')) return undefined;
  let current: LedgerVerdict = 'pending';
  for (const row of rows) if (row.rowType === 'verdict') current = row.verdict;
  return current;
}

/** A row's entry, or `undefined` when its text is not a ledger entry's. */
function readEntry(body: string): LedgerEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { learner, turnUserId } = parsed as { learner?: unknown; turnUserId?: unknown };
  if (!learner || typeof learner !== 'object') return undefined;
  const { namespace, agentKey, userId } = learner as { namespace?: unknown; agentKey?: unknown; userId?: unknown };
  if (typeof namespace !== 'string' || typeof agentKey !== 'string') return undefined;
  if (userId !== null && typeof userId !== 'string') return undefined;
  if (turnUserId !== undefined && typeof turnUserId !== 'string') return undefined;
  return parsed as LedgerEntry;
}

/** A stored row's entry. @throws {Error} When its text is not a ledger entry's. */
function entryOf(row: StoredLedgerRow): LedgerEntry {
  const entry = readEntry(row.body);
  if (!entry) throw new Error(`The learning ledger's row ${row.id} is unreadable.`);
  return entry;
}

/** Whether a row starts a chain's verified part: an `operator_set` candidate whose reason is `reanchor`. */
function isReanchor(entry: Pick<LedgerEntry, 'rowType' | 'kind' | 'reason'>): boolean {
  return entry.rowType === 'candidate' && entry.kind === 'operator_set' && entry.reason === 'reanchor';
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Ledger {
  private readonly store: LearningStore;
  private readonly clock: () => number;

  constructor(private readonly options: LedgerOptions) {
    this.store = options.store;
    this.clock = options.clock ?? Date.now;
  }

  /** Whether hashes are keyed (`learning.ledgerKey`); the manifest says `ledger: unkeyed` otherwise. */
  get keyed(): boolean {
    return typeof this.options.ledgerKey === 'string' && this.options.ledgerKey.length > 0;
  }

  private hashOf(text: string): Promise<string> {
    return this.keyed ? hmacSha256Hex(this.options.ledgerKey!, text) : sha256Hex(text);
  }

  private async versionsOf(extra: Partial<LedgerVersions> | undefined): Promise<LedgerVersions> {
    return {
      agentos: await agentosVersion(),
      rules: 'none',
      renderer: 1,
      probes: 'none',
      model: '',
      ...this.options.versions,
      ...extra,
    };
  }

  /**
   * Proposes a change. Under a freeze a new candidate is refused (`frozen`) and nothing is written, unless the call
   * is an operator's. A forgotten user's chain takes nothing (`forgotten`). With `verdict`, the candidate's verdict,
   * any `alsoDecide` verdicts and `change` run in the same transaction as the candidate.
   *
   * @throws {Error} When the store fails or `change` throws, with nothing written, a store's refusal of a row whose
   *   text holds a lone surrogate included (a namespace, an agent key, a user id, a subject or a session id with one,
   *   which a SQL text column cannot hold); when a row with a learner names a `turnUserId`; when an `alsoDecide` entry
   *   names a candidate twice, one outside this chain, or one whose current verdict it cannot follow.
   * @throws {RangeError} When the clock gives a time a ULID cannot hold, with nothing written.
   */
  async propose(input: CandidateInput, options: ProposeOptions = {}): Promise<ProposeResult> {
    const turnUserId = input.turnUserId || null;
    if (turnUserId !== null && input.learner.userId !== null) {
      throw new Error('The learning ledger takes a turnUserId only on a row with no learner (userId null): a row with a learner is the learner\'s alone.');
    }
    if (!options.operator && (processIsFrozen() || this.options.isFrozen?.(input.learner))) return { status: 'frozen' };
    const versions = await this.versionsOf(input.versions);
    const verdict = options.verdict ?? 'pending';
    const candidateId = ulid(this.clock());
    const base = {
      learner: input.learner,
      kind: input.kind,
      actor: input.actor,
      subject: input.subject,
      versions,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(turnUserId ? { turnUserId } : {}),
    };
    const drafts: Draft[] = [
      {
        ...base,
        id: candidateId,
        rowType: 'candidate',
        candidateId,
        before: input.before ?? null,
        after: input.after ?? null,
        evidence: input.evidence ?? {},
        verdict: 'pending',
        reason: verdict === 'pending' ? (options.reason ?? 'pending') : (options.reason ?? verdict),
        ...(verdict === 'pending' && options.stateDigest ? { stateDigest: options.stateDigest } : {}),
      },
    ];
    if (verdict !== 'pending') {
      drafts.push({
        ...base,
        rowType: 'verdict',
        candidateId,
        before: null,
        after: null,
        evidence: input.evidence ?? {},
        verdict,
        reason: options.reason ?? verdict,
        ...(options.stateDigest ? { stateDigest: options.stateDigest } : {}),
      });
    }
    const others = options.alsoDecide ?? [];
    for (const other of others) {
      drafts.push({ ...base, rowType: 'verdict', candidateId: other.candidateId, before: null, after: null, evidence: {}, verdict: other.verdict, reason: other.reason });
    }
    const outcome = await this.append<never>(
      input.learner,
      turnUserId,
      drafts,
      options.change,
      others.length > 0 ? (tx, chainKey) => this.checkOthers(tx, chainKey, others) : undefined,
    );
    if (outcome.status !== 'appended') return outcome;
    const [candidate, decided] = outcome.rows;
    return {
      status: verdict,
      candidate: candidate!,
      ...(verdict !== 'pending' && decided ? { verdict: decided } : {}),
      rows: outcome.rows,
    };
  }

  /**
   * Writes a candidate's verdict on the candidate's chain, with an optional state change in the same transaction. A
   * verdict decides a `pending` candidate, and `reverted` follows a `kept` one; any other is `refused`, read in the
   * same transaction as the write.
   *
   * @throws {Error} When the store fails or `change` throws, with nothing written; when the candidate's text is not a
   *   ledger entry's.
   * @throws {RangeError} When the clock gives a time a ULID cannot hold, with nothing written.
   */
  async decide(
    candidateId: string,
    verdict: LedgerVerdict,
    reason: string,
    options: { evidence?: LedgerEvidence; stateDigest?: string; change?: ProposeOptions['change'] } = {},
  ): Promise<DecideResult> {
    const stored = await this.store.ledgerRow(candidateId);
    if (!stored || stored.rowType !== 'candidate') return { status: 'unknown_candidate' };
    const candidate = entryOf(stored);
    const turnUserId = candidate.turnUserId || null;
    const draft: Draft = {
      rowType: 'verdict',
      candidateId,
      learner: candidate.learner,
      kind: candidate.kind,
      actor: candidate.actor,
      subject: candidate.subject,
      before: null,
      after: null,
      evidence: options.evidence ?? {},
      verdict,
      reason,
      versions: candidate.versions,
      ...(candidate.sessionId !== undefined ? { sessionId: candidate.sessionId } : {}),
      ...(turnUserId ? { turnUserId } : {}),
      ...(options.stateDigest ? { stateDigest: options.stateDigest } : {}),
    };
    type Refusal = { status: 'unknown_candidate' } | { status: 'refused'; current: LedgerVerdict };
    const outcome = await this.append<Refusal>(candidate.learner, turnUserId, [draft], options.change, async (tx) => {
      const current = currentVerdictOf(await tx.candidateRows(candidateId));
      if (current === undefined) return { status: 'unknown_candidate' };
      return NEXT_VERDICTS[current].includes(verdict) ? undefined : { status: 'refused', current };
    });
    if (outcome.status !== 'appended') return outcome;
    // Only `kept`, `rejected` and `reverted` follow a candidate's verdict, so a written verdict is one of them.
    return { status: verdict as Exclude<LedgerVerdict, 'pending'>, verdict: outcome.rows[0]! };
  }

  /**
   * Inside an append's transaction, before it writes: each candidate `alsoDecide` names is named once, is a candidate
   * of this chain, and can take its verdict.
   */
  private async checkOthers(
    tx: LearningStoreTx,
    chainKey: string,
    others: NonNullable<ProposeOptions['alsoDecide']>,
  ): Promise<undefined> {
    const named = new Set<string>();
    for (const other of others) {
      if (named.has(other.candidateId)) {
        throw new Error(`The learning ledger writes no verdicts on candidate ${other.candidateId}: it is named more than once.`);
      }
      named.add(other.candidateId);
      const rows = await tx.candidateRows(other.candidateId);
      const own = rows.find((row) => row.rowType === 'candidate' && row.id === other.candidateId);
      if (!own || own.chainKey !== chainKey) {
        throw new Error(`The learning ledger writes no verdict on ${other.candidateId}: it is not a candidate of this chain.`);
      }
      const current = currentVerdictOf(rows) ?? 'pending';
      if (!NEXT_VERDICTS[current].includes(other.verdict)) {
        throw new Error(`The learning ledger writes no ${other.verdict} verdict on candidate ${other.candidateId}: its verdict is ${current}.`);
      }
    }
    return undefined;
  }

  /**
   * Appends rows to one chain: the head is moved by compare-and-swap first, then the rows and the change are written,
   * all in one transaction; a lost swap rolls back and tries again on the new head, three times. `check` reads, in the
   * same transaction and before anything is written, whether the append may go on; a lost swap runs it again.
   */
  private async append<R extends { status: string } = never>(
    learner: LedgerLearner,
    turnUserId: string | null,
    drafts: Draft[],
    change: ProposeOptions['change'],
    check?: (tx: LearningStoreTx, chainKey: string) => Promise<R | undefined>,
  ): Promise<Appended | { status: 'forgotten' | 'conflict' } | R> {
    const chainKey = chainKeyOf(learner, turnUserId);
    const owner = learner.userId ?? turnUserId;
    const tomb = owner === null ? undefined : await tombstoneHash(learner.namespace, owner);
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
      let outcome: Appended | { status: 'forgotten' } | R;
      try {
        outcome = await this.store.transaction(async (tx): Promise<Appended | { status: 'forgotten' } | R> => {
          const head = await tx.head(chainKey);
          if (head?.forgotten) return { status: 'forgotten' };
          if (!head && tomb !== undefined && (await tx.isForgotten(tomb))) return { status: 'forgotten' };
          const refusal = check ? await check(tx, chainKey) : undefined;
          if (refusal) return refusal;
          // A chain with rows and no head row (its head deleted outside the layer), and, for an operator's reanchor,
          // a chain with rows past its head (its head moved back outside the layer), goes on after its newest row, so
          // the reanchor can still append to it.
          const stored = !head || isReanchor(drafts[0]!) ? await tx.chainRows(chainKey) : [];
          const newest = stored[stored.length - 1];
          const after = newest !== undefined && (head === undefined || newest.seq > head.seq) ? newest : undefined;
          let prevHash = after?.hash ?? head?.lastHash ?? GENESIS_HASH;
          let seq = after?.seq ?? head?.seq ?? 0;
          const createdAt = new Date(this.clock()).toISOString();
          const written: Array<{ entry: LedgerEntry; body: string; hash: string }> = [];
          for (const draft of drafts) {
            seq += 1;
            const entry = { ...draft, id: draft.id ?? ulid(this.clock()), prevHash, seq, createdAt } as LedgerEntry;
            const body = canonicalJson(entry);
            const hash = await this.hashOf(body);
            written.push({ entry, body, hash });
            prevHash = hash;
          }
          const last = written[written.length - 1]!;
          const moved = head
            ? await tx.advanceHead(chainKey, head.seq, { lastId: last.entry.id, lastHash: last.hash, seq })
            : await tx.insertHead({
                chainKey,
                namespace: learner.namespace,
                agentKey: learner.agentKey,
                userId: owner,
                lastId: last.entry.id,
                lastHash: last.hash,
                seq,
                forgotten: false,
              });
          if (!moved) throw new HeadMoved();
          for (const { entry, body, hash } of written) {
            await tx.insertLedgerRow({
              id: entry.id,
              chainKey,
              seq: entry.seq,
              rowType: entry.rowType,
              candidateId: entry.candidateId,
              namespace: learner.namespace,
              agentKey: learner.agentKey,
              userId: learner.userId,
              turnUserId: entry.turnUserId ?? null,
              sessionId: entry.sessionId ?? null,
              kind: entry.kind,
              subject: entry.subject,
              verdict: entry.verdict,
              body,
              prevHash: entry.prevHash,
              hash,
              stateDigest: entry.stateDigest ?? null,
              createdAt: entry.createdAt,
            });
          }
          const rows = written.map((w) => w.entry);
          if (change) await change(tx, rows);
          return { status: 'appended', rows };
        });
      } catch (error) {
        if (error instanceof HeadMoved) continue;
        throw error;
      }
      if (outcome.status === 'appended' && tomb !== undefined && owner !== null && (await this.forgottenSinceCommit(learner.namespace, owner, tomb))) {
        return { status: 'forgotten' };
      }
      return outcome;
    }
    return { status: 'conflict' };
  }

  /**
   * Reads the tombstone again once an append that names a user has committed: a `forgetUser` that committed its
   * tombstone while the append ran deleted the user's rows without these, so they are deleted now. An error in that
   * read or that deletion never turns the committed append into a failed one: it is traced, and a second `forgetUser`
   * call deletes what is left.
   */
  private async forgottenSinceCommit(namespace: string, userId: string, tomb: string): Promise<boolean> {
    try {
      if (!(await this.store.isForgotten(tomb))) return false;
    } catch (error) {
      console.warn(
        `[agentos] learning: the ledger did not read the tombstone again once an append had committed (${messageOf(error)}); the append stands, and if its user was forgotten meanwhile, a second forgetUser call deletes its rows.`,
      );
      return false;
    }
    try {
      if (this.options.onForgottenAfterCommit) await this.options.onForgottenAfterCommit(namespace, userId);
      else await this.store.deleteUserRows(namespace, userId);
    } catch (error) {
      console.warn(
        `[agentos] learning: the rows an append wrote after its user was forgotten (tombstone ${tomb.slice(0, 16)}) were not deleted (${messageOf(error)}); a second forgetUser call deletes them.`,
      );
    }
    return true;
  }

  /** A candidate's current verdict: its latest verdict row's, or `pending`; `undefined` for an unknown id. */
  async latestVerdict(candidateId: string): Promise<LedgerVerdict | undefined> {
    return currentVerdictOf(await this.store.candidateRows(candidateId));
  }

  /**
   * The candidates of a chain whose latest verdict is still `pending` (a crash between a write and its verdict).
   * @throws {Error} When a candidate's text is not a ledger entry's.
   */
  async pendingCandidates(chainKey: string): Promise<LedgerEntry[]> {
    const rows = await this.store.chainRows(chainKey);
    const decided = new Set(rows.filter((row) => row.rowType === 'verdict').map((row) => row.candidateId));
    return rows.filter((row) => row.rowType === 'candidate' && !decided.has(row.id)).map(entryOf);
  }

  /**
   * The newest row of a chain that carries a state digest for one of the given kinds.
   * @throws {Error} When that row's text is not a ledger entry's.
   */
  async latestStateRow(chainKey: string, kinds: readonly LearningKind[]): Promise<LedgerEntry | undefined> {
    const rows = await this.store.chainRows(chainKey);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      if (row.stateDigest && kinds.includes(row.kind)) return entryOf(row);
    }
    return undefined;
  }

  /**
   * The entries of a chain, oldest first.
   * @throws {Error} When a row's text is not a ledger entry's.
   */
  async entries(chainKey: string): Promise<LedgerEntry[]> {
    return (await this.store.chainRows(chainKey)).map(entryOf);
  }

  /**
   * The load check: from the chain's newest `reanchor` row on (else from its first row), each row's text is read as an
   * entry, its hash is recomputed, its chain and its indexed columns are compared with its own text, each row links
   * to the one before and follows it by one, the first row of an unanchored chain starts from the genesis hash at 1,
   * and the head names the newest row. Rows before the newest reanchor are not checked. The rows and the head are read
   * at one moment (`chainWithHead`), so an append another process commits during the check never reads as a break.
   */
  async verifyChain(chainKey: string): Promise<ChainCheck> {
    const keyed = this.keyed;
    const broken = (reason: string): ChainCheck => ({ ok: false, keyed, reason });
    const { rows, head } = await this.store.chainWithHead(chainKey);
    if (rows.length === 0) return head ? broken('head with no rows') : { ok: true, keyed };
    // Newest first, as far as the newest reanchor: where the chain's verified part starts.
    const entries: LedgerEntry[] = [];
    let anchor = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const entry = readEntry(rows[i]!.body);
      if (!entry) return broken(`row ${rows[i]!.id}: unreadable`);
      entries[i] = entry;
      if (isReanchor(entry)) {
        anchor = i;
        break;
      }
    }
    const start = Math.max(anchor, 0);
    for (let i = start; i < rows.length; i += 1) {
      const row = rows[i]!;
      const entry = entries[i]!;
      if ((await this.hashOf(row.body)) !== row.hash) return broken(`row ${row.id}: hash`);
      if (row.chainKey !== chainKeyOf(entry.learner, entry.turnUserId ?? null)) return broken(`row ${row.id}: column chainKey`);
      for (const [column, read] of INDEXED) {
        if ((row[column] ?? null) !== (read(entry) ?? null)) return broken(`row ${row.id}: column ${String(column)}`);
      }
      if (i === start) {
        if (anchor < 0 && (row.prevHash !== GENESIS_HASH || row.seq !== 1)) return broken(`row ${row.id}: first row`);
      } else {
        const previous = rows[i - 1]!;
        if (row.prevHash !== previous.hash) return broken(`row ${row.id}: link`);
        if (row.seq !== previous.seq + 1) return broken(`row ${row.id}: sequence`);
      }
    }
    const last = rows[rows.length - 1]!;
    if (!head || head.lastId !== last.id || head.lastHash !== last.hash || head.seq !== last.seq) return broken('head');
    return { ok: true, keyed };
  }
}
