/**
 * @module learning/hostCalls
 *
 * What the layer's operator calls share: the key a run-time freeze or suspension is stored under and the turns it
 * covers; the checks of what a host passes; what an import takes; the inverse of an operator's change; a memory
 * write's record, read back, checked against its traces and taken back; and the scopes `forgetUser` deletes.
 */
import { encodeScopeIdPart } from '../memory/retrieval/store/scopeIdForm.js';
import type { TraceSnapshot } from '../memory/retrieval/store/tracePersistence.js';
import { OPERATOR_ONLY_TRAITS } from '../substrate/personas/personalityPrompt.js';
import { learnerScopeIds, learnerUserScopeId, scopeIdOf, sessionScopeIds, taggedScopeId } from './scopes.js';
import type { FreezeRow, SessionRow } from './store/LearningStore.js';
import {
  bandsFor,
  clampLearnable,
  LEARNABLE_TRAITS,
  newTraitState,
  operatorTraitsOf,
  parseTraitState,
  renderedTraits,
  type OperatorTraits,
  type TraitState,
} from './traitState.js';
import type {
  FreezeScope,
  ImportReport,
  LearnedStateDocument,
  LearnerKey,
  LearningMemoryTools,
  LedgerEntry,
  MemoryWriteBefore,
  MemoryWriteChange,
} from './types.js';

/** The scope a turn's mode is read for: its agent, and its learner on a learner's turn. */
export interface FreezeTarget {
  agentKey: string;
  learner?: LearnerKey;
}

/** The key a run-time freeze or suspension is stored under: `all`, `agent|<agentKey>` or `learner|<ns>|<agent>|<user>`. */
export function freezeScopeKey(scope: FreezeScope): string {
  if ('scope' in scope) return 'all';
  if ('agentKey' in scope) return `agent|${encodeScopeIdPart(scope.agentKey)}`;
  const { namespace, agentKey, userId } = scope.learner;
  return `learner|${encodeScopeIdPart(namespace)}|${encodeScopeIdPart(agentKey)}|${encodeScopeIdPart(userId)}`;
}

/** Whether a stored freeze or suspension covers a turn of `target`. */
export function freezeCovers(row: Pick<FreezeRow, 'scopeKey'>, target: FreezeTarget): boolean {
  if (row.scopeKey === 'all') return true;
  if (row.scopeKey === freezeScopeKey({ agentKey: target.agentKey })) return true;
  return target.learner !== undefined && row.scopeKey === freezeScopeKey({ learner: target.learner });
}

/** @throws {TypeError} When a learner key a host passes is not one. */
export function assertLearnerKey(key: unknown, call: string): asserts key is LearnerKey {
  const k = key && typeof key === 'object' ? (key as Record<string, unknown>) : undefined;
  if (!k) throw new TypeError(`${call}: name the learner as { namespace, agentKey, userId }.`);
  if (typeof k.namespace !== 'string') throw new TypeError(`${call}: learner.namespace must be a string ('' for none).`);
  if (typeof k.agentKey !== 'string' || k.agentKey.trim() === '') throw new TypeError(`${call}: learner.agentKey must be a non-blank string.`);
  if (typeof k.userId !== 'string' || k.userId.trim() === '') throw new TypeError(`${call}: learner.userId must be a non-blank string.`);
}

/** @throws {TypeError} When a freeze or suspension scope names nothing. */
export function assertFreezeScope(scope: unknown, call: string): asserts scope is FreezeScope {
  const s = scope && typeof scope === 'object' ? (scope as Record<string, unknown>) : undefined;
  if (s && 'scope' in s) {
    if (s.scope === 'all') return;
    throw new TypeError(`${call}: a scope of everything is { scope: 'all' }.`);
  }
  if (s && 'agentKey' in s) {
    if (typeof s.agentKey === 'string' && s.agentKey.trim() !== '') return;
    throw new TypeError(`${call}: agentKey must be a non-blank string.`);
  }
  if (s && 'learner' in s) {
    assertLearnerKey(s.learner, call);
    return;
  }
  throw new TypeError(`${call}: name a scope: { scope: 'all' }, { agentKey } or { learner }.`);
}

/** The operator a call names; the row's actor is `operator:<by>`. @throws {TypeError} When it names none. */
export function operatorOf(by: unknown, call: string): string {
  if (typeof by !== 'string' || by.trim() === '') throw new TypeError(`${call}: by must name the operator.`);
  return by.trim();
}

/** A run-time freeze's or suspension's row. */
export function freezeRowOf(scope: FreezeScope, mode: FreezeRow['mode'], by: string | undefined, now: number): FreezeRow {
  const base = {
    scopeKey: freezeScopeKey(scope),
    mode,
    setBy: `operator:${typeof by === 'string' && by.trim() !== '' ? by.trim() : 'unnamed'}`,
    createdAt: new Date(now).toISOString(),
  };
  if ('scope' in scope) return { ...base, namespace: '', agentKey: null, userId: null };
  if ('agentKey' in scope) return { ...base, namespace: '', agentKey: scope.agentKey, userId: null };
  return { ...base, namespace: scope.learner.namespace, agentKey: scope.learner.agentKey, userId: scope.learner.userId };
}

/** @throws {TypeError} When a document is not a learned-state document of this version. */
export function assertLearnedStateDocument(doc: unknown, call: string): asserts doc is LearnedStateDocument {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : undefined;
  if (!d || d.version !== 1) throw new TypeError(`${call}: the document is not a learned-state document of version 1.`);
  assertLearnerKey(d.learner, call);
  for (const field of ['lessons', 'skills', 'ledger', 'outcomes'] as const) {
    if (d[field] !== undefined && !Array.isArray(d[field])) throw new TypeError(`${call}: the document's ${field} must be a list.`);
  }
}

/** A trait state recorded in a ledger row's `before` or `after`, read back; `undefined` for anything else. */
export function stateOfRecord(value: unknown): TraitState | undefined {
  return value && typeof value === 'object' && 'baseline' in value ? parseTraitState(JSON.stringify(value)) : undefined;
}

/** What an import takes and refuses. */
export interface ImportAdmission {
  /** The state to write; none when the document carries no trait state. */
  next?: TraitState;
  taken: ImportReport['taken'];
  refused: ImportReport['refused'];
}

const idOf = (item: unknown): string | undefined =>
  item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : undefined;

/**
 * What an import takes: the four learnable traits, each clamped into the target's lifetime band (the
 * target row's baseline, or, for a learner with no row, the document's, which the learner's first load moves to its
 * persona and clamps again); never honesty-humility or emotionality, which come from the target persona and its
 * operator, and never a floor the document names: a learner with no row starts with none, and its first load raises
 * it to the persona's honesty-humility. Lessons, skills and outcomes are refused (`no_admission`), and the document's
 * ledger rows stay with their source chain (`source_chain`).
 */
export function admitImport(doc: LearnedStateDocument, target: TraitState | undefined, operator: OperatorTraits, now: number): ImportAdmission {
  const taken: ImportReport['taken'] = [];
  const refused: ImportReport['refused'] = [];
  let next: TraitState | undefined;
  const raw = doc.traitState && typeof doc.traitState === 'object' ? doc.traitState : null;
  if (raw) {
    const source = parseTraitState(JSON.stringify(raw));
    const rawCurrent = raw.current && typeof raw.current === 'object' ? (raw.current as Record<string, unknown>) : {};
    for (const key of OPERATOR_ONLY_TRAITS) {
      if (rawCurrent[key] !== undefined) refused.push({ item: `trait:${key}`, reason: 'operator_only' });
    }
    const base: TraitState = target ?? { ...newTraitState(source.baseline, now), honestyAtLastLoad: 0 };
    const current = { ...base.current };
    for (const key of LEARNABLE_TRAITS) {
      const value = source.current[key];
      if (value === undefined) continue;
      current[key] = clampLearnable(value, base.baseline[key]);
      taken.push({ item: `trait:${key}`, detail: String(current[key]) });
    }
    next = { ...base, current };
    next.bands = bandsFor(renderedTraits(next, base.baseline, operator), base.bands);
  }
  const kinds: Array<[string, unknown[] | undefined]> = [
    ['lesson', doc.lessons],
    ['skill', doc.skills],
    ['outcome', doc.outcomes],
  ];
  for (const [kind, items] of kinds) {
    (items ?? []).forEach((item, index) => refused.push({ item: `${kind}:${idOf(item) ?? index}`, reason: 'no_admission' }));
  }
  if ((doc.ledger ?? []).length > 0) refused.push({ item: 'ledger', reason: 'source_chain' });
  return { ...(next ? { next } : {}), taken, refused };
}

/** The four learnable traits' kept values and the operator's map a ledger row records. */
function recordOf(value: unknown): { current: Partial<Record<string, number>>; operator: OperatorTraits; honestyAtLastLoad?: number } {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const raw = v.current && typeof v.current === 'object' ? (v.current as Record<string, unknown>) : {};
  const current: Partial<Record<string, number>> = {};
  for (const key of LEARNABLE_TRAITS) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isFinite(n)) current[key] = n;
  }
  return {
    current,
    operator: operatorTraitsOf(value),
    ...(typeof v.honestyAtLastLoad === 'number' ? { honestyAtLastLoad: v.honestyAtLastLoad } : {}),
  };
}

/**
 * The state a revert of an operator's change writes: each learnable trait the change moved goes back by the step
 * it made, applied to the value it holds now and clamped into its band, and each operator trait it changed goes back
 * to what it was, with the floor under honesty-humility; changes to other traits since then stay.
 */
export function invertOperatorSet(original: LedgerEntry, current: TraitState, operator: OperatorTraits): { state: TraitState; operator: OperatorTraits } {
  const before = recordOf(original.before);
  const after = recordOf(original.after);
  const kept = { ...current.current };
  for (const key of LEARNABLE_TRAITS) {
    const was = before.current[key];
    const set = after.current[key];
    if (was === undefined || set === undefined || was === set) continue;
    kept[key] = clampLearnable((kept[key] ?? current.baseline[key]) - (set - was), current.baseline[key]);
  }
  const nextOperator: OperatorTraits = { ...operator };
  for (const key of ['honesty', 'emotionality'] as const) {
    if (before.operator[key] === after.operator[key]) continue;
    if (before.operator[key] === undefined) delete nextOperator[key];
    else nextOperator[key] = before.operator[key];
  }
  const floorMoved = before.operator.honesty !== after.operator.honesty;
  const honestyAtLastLoad = floorMoved
    ? (nextOperator.honesty ?? before.honestyAtLastLoad ?? current.honestyAtLastLoad)
    : current.honestyAtLastLoad;
  const state: TraitState = { ...current, current: kept, honestyAtLastLoad };
  state.bands = bandsFor(renderedTraits(state, current.baseline, nextOperator), current.bands);
  return { state, operator: nextOperator };
}

/** A `memory_write` row's `after`, read back; `undefined` when it is not one. */
export function parseMemoryWrite(after: unknown): MemoryWriteChange | undefined {
  if (!after || typeof after !== 'object') return undefined;
  const v = after as Record<string, unknown>;
  const ids = (x: unknown): string[] | undefined => (Array.isArray(x) && x.every((i) => typeof i === 'string') ? (x as string[]) : undefined);
  const created = ids(v.created);
  const deleted = ids(v.deleted);
  const changed =
    Array.isArray(v.changed) &&
    v.changed.every((c) => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string' && typeof (c as { content?: unknown }).content === 'string')
      ? (v.changed as Array<{ id: string; content: string }>)
      : undefined;
  if (typeof v.brainId !== 'string' || !created || !deleted || !changed) return undefined;
  return { brainId: v.brainId, created, changed, deleted };
}

/** A `memory_write` row's `before`, read back. */
export function parseMemoryBefore(before: unknown): MemoryWriteBefore | null {
  const traces = before && typeof before === 'object' ? (before as { traces?: unknown }).traces : undefined;
  if (!Array.isArray(traces)) return null;
  return {
    traces: traces.filter(
      (t): t is TraceSnapshot => !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string' && typeof (t as { content?: unknown }).content === 'string',
    ),
  };
}

/**
 * Whether a memory write's traces hold the change its row names: every created trace is live, every deleted
 * one is gone and every changed one holds the content the row names.
 */
export async function memoryWriteHolds(change: MemoryWriteChange, read: (traceId: string) => Promise<TraceSnapshot | undefined>): Promise<boolean> {
  for (const id of change.created) {
    const trace = await read(id);
    if (!trace || trace.deleted) return false;
  }
  for (const id of change.deleted) {
    const trace = await read(id);
    if (trace && !trace.deleted) return false;
  }
  for (const { id, content } of change.changed) {
    const trace = await read(id);
    if (!trace || trace.deleted || trace.content !== content) return false;
  }
  return true;
}

/**
 * Takes a memory write back through the facade of its brain: the traces it created are deleted, and the traces it
 * changed or deleted are brought back to the before-state its row holds.
 *
 * @throws {Error} When the facade cannot do what the write needs.
 */
export async function undoMemoryWrite(facade: LearningMemoryTools, change: MemoryWriteChange, before: MemoryWriteBefore | null): Promise<void> {
  if (change.created.length > 0) {
    if (facade.deleteTraces) await facade.deleteTraces(change.created);
    else if (facade.forget) for (const id of change.created) await facade.forget(id);
    else throw new Error('the memory tools facade can neither delete nor forget a trace');
  }
  for (const snapshot of before?.traces ?? []) {
    if (!facade.restoreTrace) throw new Error('the memory tools facade cannot restore a trace');
    await facade.restoreTrace(snapshot.id, snapshot);
  }
}

/** A scope `forgetUser` deletes; with `turnUserId`, only that user's traces of it. */
export interface ForgetTarget {
  scope: 'user' | 'persona' | 'thread';
  scopeId: string;
  turnUserId?: string;
}

/**
 * The scopes `forgetUser` deletes for one user in one namespace: the learner's `user`
 * scope and, for each persona of the user's own sessions, its `persona` scope; each of the user's own sessions' scopes
 * and the threads of its conversations and of the session itself, in the session's form; and, on each session the user
 * spoke on as a second user, that user's traces of the same scopes, by `turnUserId`. Exact ids, never a prefix.
 */
export function forgetTargets(namespace: string, userId: string, rows: readonly SessionRow[]): ForgetTarget[] {
  const targets = new Map<string, ForgetTarget>();
  const add = (target: ForgetTarget): void => {
    targets.set(`${target.scope}\u0000${target.scopeId}\u0000${target.turnUserId ?? ''}`, target);
  };
  const user = { namespace, userId };
  add({ scope: 'user', scopeId: learnerUserScopeId(user) });
  for (const row of rows) {
    const whose = row.kind === 'visitor' ? { turnUserId: userId } : {};
    if (row.kind === 'learner') add({ scope: 'persona', scopeId: learnerScopeIds(user, row.personaId).personaScopeId });
    const session = sessionScopeIds(row.sessionId, namespace, row.personaId);
    add({ scope: 'user', scopeId: session.userScopeId, ...whose });
    add({ scope: 'persona', scopeId: session.personaScopeId, ...whose });
    for (const id of [...row.conversationIds, row.sessionId]) add({ scope: 'thread', scopeId: taggedScopeId(id, namespace), ...whose });
  }
  return [...targets.values()];
}

/** The plain-form scopes of a user id, as filed before a namespace existed: a namespaced `forgetUser` leaves them. */
export function plainScopesOf(userId: string, rows: readonly SessionRow[]): Array<{ scope: 'user' | 'persona'; scopeId: string }> {
  const plain = scopeIdOf(userId);
  const personas = [...new Set(rows.filter((row) => row.kind === 'learner').map((row) => row.personaId))];
  return [
    { scope: 'user', scopeId: plain },
    ...personas.map((personaId) => ({ scope: 'persona' as const, scopeId: `${plain}::${scopeIdOf(personaId)}` })),
  ];
}
