/**
 * @module learning/traitLoad
 *
 * A learner's trait record: the row in `agentos_learning_traits` and the learner's ledger chain. A record
 * verifies when the chain does and the row matches the digest of the newest ledger row that changed it; a chain that
 * does not verify, a row that does not match, a row with no ledger row and a ledger row with no trait row do not, and
 * the caller renders the persona's authored traits. A learner's first load writes the row from the registry persona's
 * authored traits with its `operator_set` row (reason `created`); a load that finds the persona moved writes the new
 * baseline with one (reason `persona_changed`), and one that finds the persona's honesty-humility above the row's
 * floor, the persona unchanged (an operator lowered it, or an import started the row with none), raises the floor with
 * one (reason `floor_raised`). Every change of the row is written with its rows in one store transaction, at the
 * version it read. Honesty-humility and emotionality are read from the newest kept `operator_set` row that carries the
 * operator's map, never from the row.
 */
import { HEXACO_TRAIT_KEYS, type HexacoTraitValues } from '../substrate/personas/hexaco.js';
import { chainKeyOf, type Ledger, type ProposeOptions } from './ledger/Ledger.js';
import type { LearningStore, StoredTraitRow } from './store/LearningStore.js';
import {
  newTraitState,
  operatorTraitsOf,
  parseTraitState,
  serializeTraitState,
  traitDigest,
  traitRecord,
  withOperatorSet,
  withPersona,
  type OperatorTraits,
  type TraitState,
} from './traitState.js';
import type { LearnerKey, LedgerEntry, LedgerEvidence, LedgerVerdict } from './types.js';

/** The kinds whose rows carry a trait row's digest: an operator's change and, from a later release, a trait rule's. */
export const TRAIT_STATE_KINDS: readonly string[] = ['operator_set', 'trait'];

/** What a load found. */
export type TraitLoad =
  | { status: 'ok'; state: TraitState; operator: OperatorTraits; row: StoredTraitRow }
  /** The record does not verify: the authored traits render until an operator calls `operatorSet`. */
  | { status: 'broken'; reason: string }
  /** The user is forgotten: no row is written for them again. */
  | { status: 'forgotten' }
  /** The store could not be read; the next turn reads it again. */
  | { status: 'unavailable'; reason: string };

/** Thrown inside a transaction whose trait row another writer moved, so the rows roll back and the caller reads again. */
export class TraitRowMoved extends Error {
  constructor() {
    super('the trait row moved');
  }
}

/** Each candidate's current verdict: its newest verdict row's, else `pending`. */
export function latestVerdicts(entries: readonly LedgerEntry[]): Map<string, LedgerVerdict> {
  const verdicts = new Map<string, LedgerVerdict>();
  for (const entry of entries) {
    if (entry.rowType === 'candidate' && !verdicts.has(entry.id)) verdicts.set(entry.id, 'pending');
    if (entry.rowType === 'verdict') verdicts.set(entry.candidateId, entry.verdict);
  }
  return verdicts;
}

/** The operator's two traits a load reads: the map of the newest kept `operator_set` candidate that carries one. */
export function operatorTraitsOfChain(entries: readonly LedgerEntry[]): OperatorTraits {
  const verdicts = latestVerdicts(entries);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.rowType !== 'candidate' || entry.kind !== 'operator_set' || verdicts.get(entry.id) !== 'kept') continue;
    if (entry.after && typeof entry.after === 'object' && 'operatorTraits' in entry.after) return operatorTraitsOf(entry.after);
  }
  return {};
}

/** The newest row of a chain that records a trait row's digest. */
export function latestTraitStateRow(entries: readonly LedgerEntry[]): LedgerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.stateDigest && TRAIT_STATE_KINDS.includes(entry.kind)) return entry;
  }
  return undefined;
}

/** A learner's trait record as stored, and whether it verifies. */
export interface LearnerRecord {
  /** The chain verifies and the row matches its newest ledger row's digest, or the learner has neither yet. */
  verified: boolean;
  /** The chain alone verifies: a record that does not verify with a chain that does has a row edited outside the layer. */
  chainOk: boolean;
  /** Why the record does not verify. */
  reason?: string;
  row?: StoredTraitRow;
  /** The row's state as stored. */
  state?: TraitState;
  /** The chain's entries, oldest first. */
  entries: LedgerEntry[];
  /** The operator's map the chain holds. */
  operator: OperatorTraits;
}

/** Reads a learner's record once: the chain is checked, then the row and the chain's rows are read in one transaction. */
async function readRecordOnce(store: LearningStore, ledger: Ledger, key: LearnerKey): Promise<LearnerRecord> {
  const chainKey = chainKeyOf(key);
  const check = await ledger.verifyChain(chainKey);
  const { row, rows } = await store.transaction(async (tx) => ({
    row: await tx.traitRow(key.namespace, key.agentKey, key.userId),
    rows: await tx.chainRows(chainKey),
  }));
  const state = row ? parseTraitState(row.state) : undefined;
  const stored = row ? { row, state } : {};
  let entries: LedgerEntry[];
  try {
    entries = rows.map((r) => JSON.parse(r.body) as LedgerEntry);
  } catch {
    return { verified: false, chainOk: false, reason: 'a ledger row is unreadable', ...stored, entries: [], operator: {} };
  }
  const base = { ...stored, chainOk: check.ok, entries, operator: operatorTraitsOfChain(entries) };
  if (!check.ok) return { verified: false, reason: check.reason, ...base };
  const stateRow = latestTraitStateRow(entries);
  if (!row || !state) return stateRow ? { verified: false, reason: 'its trait row is missing', ...base } : { verified: true, ...base };
  if (!stateRow) return { verified: false, reason: 'its trait row has no ledger row', ...base };
  if (stateRow.stateDigest !== (await traitDigest(state))) {
    return { verified: false, reason: 'its trait row does not match its newest ledger row', ...base };
  }
  return { verified: true, ...base };
}

/**
 * Reads a learner's record, and once more when it does not verify: on an adapter that does not serialize
 * transactions, another process's append can commit between two reads.
 */
export async function readLearnerRecord(store: LearningStore, ledger: Ledger, key: LearnerKey): Promise<LearnerRecord> {
  const first = await readRecordOnce(store, ledger, key);
  return first.verified ? first : readRecordOnce(store, ledger, key);
}

/** One change of a learner's trait row with its `operator_set` row. */
export interface TraitRowWrite {
  ledger: Ledger;
  key: LearnerKey;
  /** The persona the row names. */
  personaId: string;
  sessionId?: string;
  now: () => number;
  /** The row as read; none to create one. */
  current?: { row: StoredTraitRow; state: TraitState };
  /** The state and the operator's map before the change, as the row's `before` records them; none for a creation. */
  before?: { state: TraitState; operator: OperatorTraits };
  next: TraitState;
  /** The operator's map after the change. */
  operator: OperatorTraits;
  actor: string;
  reason: string;
  evidence?: LedgerEvidence;
  /** What the row's `after` records beside the state (an import's report). */
  afterExtra?: Record<string, unknown>;
  /** Verdicts on earlier candidates written with this one (a revert's `reverted`). */
  alsoDecide?: ProposeOptions['alsoDecide'];
}

/**
 * Writes a trait row with its `operator_set` candidate and `kept` verdict, in one store transaction, at the version
 * it read. Runs under a freeze: every caller is an operator's act or the persona's.
 *
 * @returns The row, its state and the candidate; `moved` when another writer created or changed the row first,
 *   `forgotten` for a forgotten user, `conflict` when the chain's head stayed busy.
 */
export async function writeTraitRow(
  write: TraitRowWrite,
): Promise<{ row: StoredTraitRow; state: TraitState; entry: LedgerEntry } | 'moved' | 'forgotten' | 'conflict'> {
  const row: StoredTraitRow = {
    namespace: write.key.namespace,
    agentKey: write.key.agentKey,
    userId: write.key.userId,
    personaId: write.personaId,
    state: serializeTraitState(write.next),
    version: (write.current?.row.version ?? 0) + 1,
    updatedAt: new Date(write.now()).toISOString(),
  };
  try {
    const result = await write.ledger.propose(
      {
        learner: { namespace: write.key.namespace, agentKey: write.key.agentKey, userId: write.key.userId },
        kind: 'operator_set',
        actor: write.actor,
        subject: 'traits',
        before: write.before ? traitRecord(write.before.state, write.before.operator) : null,
        after: { ...traitRecord(write.next, write.operator), ...(write.afterExtra ?? {}) },
        ...(write.evidence ? { evidence: write.evidence } : {}),
        ...(write.sessionId !== undefined ? { sessionId: write.sessionId } : {}),
      },
      {
        verdict: 'kept',
        reason: write.reason,
        operator: true,
        stateDigest: await traitDigest(write.next),
        ...(write.alsoDecide ? { alsoDecide: write.alsoDecide } : {}),
        change: async (tx) => {
          const written = write.current ? await tx.updateTraitRow(row, write.current.row.version) : await tx.insertTraitRow(row);
          if (!written) throw new TraitRowMoved();
        },
      },
    );
    if (result.status === 'forgotten') return 'forgotten';
    if (!('candidate' in result)) return 'conflict';
    return { row, state: write.next, entry: result.candidate };
  } catch (error) {
    if (error instanceof TraitRowMoved) return 'moved';
    throw error;
  }
}

/** What a load reads and writes with. */
export interface TraitLoadArgs {
  store: LearningStore;
  ledger: Ledger;
  key: LearnerKey;
  personaId: string;
  /** The registry persona's authored traits. */
  authored: HexacoTraitValues;
  sessionId: string;
  now: () => number;
}

/**
 * Loads a learner's trait row (the module's doc). A first load seeds the new row with the operator's map when an
 * operator set one before the learner's first session, so the operator's values are not lost to the creation's row.
 * A row another writer moves during the load is read again, up to three times.
 *
 * @throws {Error} When the store fails: the caller renders the authored traits and reads again at the next turn.
 */
export async function loadLearnerTraits(args: TraitLoadArgs): Promise<TraitLoad> {
  const common = { ledger: args.ledger, key: args.key, personaId: args.personaId, sessionId: args.sessionId, now: args.now, actor: 'operator:persona' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await readLearnerRecord(args.store, args.ledger, args.key);
    if (!record.verified) return { status: 'broken', reason: record.reason ?? 'it does not verify' };
    const { operator } = record;
    if (!record.row || !record.state) {
      const fresh = newTraitState(args.authored, args.now());
      const seeded = Object.keys(operator).length > 0 ? withOperatorSet(fresh, operator, {}).state : fresh;
      const created = await writeTraitRow({ ...common, next: seeded, operator, reason: 'created' });
      if (created === 'moved') continue;
      if (created === 'forgotten') return { status: 'forgotten' };
      if (created === 'conflict') return { status: 'unavailable', reason: 'other writers held the ledger chain' };
      return { status: 'ok', state: created.state, operator, row: created.row };
    }
    const next = withPersona(record.state, args.authored, operator);
    if (!next) return { status: 'ok', state: record.state, operator, row: record.row };
    const stored = record.state;
    const personaMoved = HEXACO_TRAIT_KEYS.some((trait) => next.baseline[trait] !== stored.baseline[trait]);
    const moved = await writeTraitRow({
      ...common,
      current: { row: record.row, state: record.state },
      before: { state: record.state, operator },
      next,
      operator,
      reason: personaMoved ? 'persona_changed' : 'floor_raised',
    });
    if (moved === 'moved') continue;
    if (moved === 'forgotten') return { status: 'forgotten' };
    // The row holds a verified state: it renders, and the next load moves the baseline.
    if (moved === 'conflict') return { status: 'ok', state: record.state, operator, row: record.row };
    return { status: 'ok', state: moved.state, operator, row: moved.row };
  }
  return { status: 'unavailable', reason: 'the trait row kept moving during the load' };
}
