/**
 * @module memory/tools/learningWrite
 *
 * The write path the four memory tools that write (`memory_add`, `memory_update`, `memory_delete`, `memory_merge`)
 * share where the GMI put the turn's scope ids on the call. Each write runs through the learner session's
 * recorder: the freeze, the user's tombstone, a `pending` ledger row, the write, the tombstone again, the verdict
 * (`kept`, or `rejected` with its reason); in mode `off` and under a suspension the write runs with no row. A write
 * that reads a trace first writes only while the trace is live and still holds the content and tags it read
 * (compare-and-set), so the row's before-state is the state the write replaced. A write the recorder takes back is
 * undone through the facade that made the tools, so a trace's memory-graph node, index entry and knowledge-graph copy
 * go with its row.
 */
import type { ToolExecutionResult } from '../../../../core/tools/ITool.js';
import { refusedSelfChange } from '../../../learning/toolContext.js';
import type { SessionSelfChange } from '../../../learning/types.js';
import type { Brain } from '../../retrieval/store/Brain.js';
import { snapshotInEncodedForm, takeScopeIdFormLock } from '../../retrieval/store/scopeIdForm.js';
import {
  deleteTraceRows,
  holdsEncodedScopeIdForm,
  parseTraceMetadata,
  readTraceSnapshot,
  writeTraceSnapshot,
  type TraceSnapshot,
} from '../../retrieval/store/tracePersistence.js';
import type { MemoryToolTurn } from './scopeContext.js';

/**
 * What a memory tool takes a write back through: the `Memory` facade that made the tools (`Memory.createTools()`
 * passes itself). Without one, a tool deletes and restores the rows itself and rebuilds the full-text index.
 */
export interface MemoryToolWriteBack {
  readonly brainId: string;
  deleteTraces(traceIds: readonly string[]): Promise<{ deleted: number }>;
  restoreTrace(traceId: string, before: TraceSnapshot): Promise<void>;
  /**
   * Deletes the knowledge-graph copies of traces a tool soft-deleted, leaving the traces: a memory manager on the
   * facade's Brain writes such a copy of each trace it stores.
   */
  deleteGraphCopies(traceIds: readonly string[]): Promise<number>;
}

/** A trace changed between a tool's read of it and the write that replaces it: the write changed nothing. */
export class TraceMovedError extends Error {
  constructor(traceId: string) {
    super(`trace ${traceId} changed after the call read it`);
    this.name = 'TraceMovedError';
  }
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  frozen: 'memory writes are frozen',
  withdrawn: 'consolidation reads and rewrites every scope of the brain, so it does not run where a learning layer exists',
  organization_scope: 'a turn files no organization memory where a learning layer exists',
  no_thread: 'the call names neither a conversation nor a session to file a thread memory under',
  no_recorder: "the turn's learner session records no memory writes",
  other_user: 'the trace belongs to another user',
  conflict: 'the trace changed while the call read it',
  forgotten: "the turn's user was forgotten",
  write_failed: 'the write failed',
  store_unavailable: 'the learning store could not be reached',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The result a memory tool returns when it refuses or its write is not kept: nothing changed, `details.reason` names
 * why, and `details.ledgerId` names the row that recorded the attempt, where one did.
 *
 * @param toolName - The tool's name, as the model called it.
 * @param reason - Why: a recorder's reason, or one of the tool's own (`organization_scope`, `no_thread`,
 *   `no_recorder`, `other_user`, `conflict`, `withdrawn`).
 * @param error - For `write_failed`, the error the write raised; its message ends the sentence.
 * @param ledgerId - The id of the candidate row that recorded the attempt.
 */
export function refusedMemoryWrite<T = never>(
  toolName: string,
  reason: string,
  error?: unknown,
  ledgerId?: string,
): ToolExecutionResult<T> {
  const why = `${REASON_TEXT[reason] ?? reason}${error === undefined ? '' : ` (${messageOf(error)})`}`;
  const refused = refusedSelfChange<T>(toolName, reason, why);
  return ledgerId ? { ...refused, details: { ...refused.details, ledgerId } } : refused;
}

/**
 * Runs one write through the turn's recorder and gives the tool's result: `kept` (with its ledger id) and `written`
 * (no row: mode `off` or a suspension) succeed with the write's output; anything else fails with its reason, a write
 * that found its trace changed as `conflict`.
 */
export async function recordToolWrite<T, O>(
  toolName: string,
  record: NonNullable<MemoryToolTurn['record']>,
  change: SessionSelfChange<T>,
  outputOf: (result: T) => O,
): Promise<ToolExecutionResult<O>> {
  const outcome = await record(change);
  if (outcome.status === 'kept') {
    return { success: true, output: outputOf(outcome.result), details: { status: 'kept', ledgerId: outcome.ledgerId } };
  }
  if (outcome.status === 'written') {
    return { success: true, output: outputOf(outcome.result), details: { status: 'written' } };
  }
  if (outcome.reason === 'write_failed' && outcome.error instanceof TraceMovedError) {
    return refusedMemoryWrite<O>(toolName, 'conflict', undefined, outcome.ledgerId);
  }
  return refusedMemoryWrite<O>(
    toolName,
    outcome.reason,
    outcome.reason === 'write_failed' ? outcome.error : undefined,
    outcome.ledgerId,
  );
}

/** How a trace stands to a call's turn: its own, another user's inside the turn's own scopes, or outside them. */
export type TraceReach = 'own' | 'other_user' | 'out';

/**
 * Whether a call's turn reaches a trace by id: the trace's scope and scope id are one of the turn's own, and the
 * second user it names (`turnUserId`) is the turn's own, both absent or equal.
 */
export function reachOf(snapshot: Pick<TraceSnapshot, 'scope' | 'scopeId' | 'metadata'>, turn: MemoryToolTurn): TraceReach {
  if (!turn.own.some((pair) => pair.scope === snapshot.scope && pair.scopeId === snapshot.scopeId)) return 'out';
  const named = parseTraceMetadata(snapshot.metadata).turnUserId;
  const traceUser = typeof named === 'string' && named !== '' ? named : undefined;
  return traceUser === turn.turnUserId ? 'own' : 'other_user';
}

/**
 * Reads the live traces a call names, in the order given, keeping those its turn reaches by id; `otherUser` is set when
 * one of them lies in the turn's own scopes but another user filed it. A trace outside the turn's scopes reads as
 * absent, so a call learns nothing about another scope.
 */
export async function reachTraces(
  brain: Brain,
  traceIds: readonly string[],
  turn: MemoryToolTurn,
): Promise<{ snapshots: TraceSnapshot[]; otherUser: boolean }> {
  const snapshots: TraceSnapshot[] = [];
  let otherUser = false;
  for (const traceId of [...new Set(traceIds)]) {
    const snapshot = await readTraceSnapshot(brain, brain.brainId, traceId);
    if (!snapshot || snapshot.deleted === 1) continue;
    const reach = reachOf(snapshot, turn);
    if (reach === 'own') snapshots.push(snapshot);
    else if (reach === 'other_user') otherUser = true;
  }
  return { snapshots, otherUser };
}

/** What a compare-and-set write appends to its `WHERE`: the row is live and holds the content and tags it was read with. */
export function stillAsRead(snapshot: TraceSnapshot): { sql: string; params: unknown[] } {
  return { sql: ' AND deleted = 0 AND content = ? AND tags = ?', params: [snapshot.content, snapshot.tags] };
}

/**
 * After a soft delete has committed: the deleted traces' knowledge-graph copies go too, through the facade that made
 * the tools. A tool over a bare `Brain` has no graph to reach. A failure leaves the copies, which a delete by the
 * trace's id or its scope finds later, and never fails the delete.
 */
export async function dropGraphCopies(writeBack: MemoryToolWriteBack | undefined, traceIds: readonly string[]): Promise<void> {
  if (!writeBack || traceIds.length === 0) return;
  try {
    await writeBack.deleteGraphCopies(traceIds);
  } catch {
    // The trace is deleted; its copy holds no part of a recall.
  }
}

/**
 * Takes back a tool's write (`SessionSelfChange.undo`). `forgotten`: every trace the write created, changed or deleted
 * is deleted for good, so nothing of the forgotten user comes back. `unrecorded`: what it created is deleted, and what
 * it changed or deleted comes back from the snapshots its row holds.
 */
export async function undoToolWrite(
  brain: Brain,
  writeBack: MemoryToolWriteBack | undefined,
  write: { created: readonly string[]; before: readonly TraceSnapshot[] },
  reason: 'forgotten' | 'unrecorded',
): Promise<void> {
  const gone =
    reason === 'forgotten' ? [...write.created, ...write.before.map((snapshot) => snapshot.id)] : [...write.created];
  if (gone.length > 0) await deleteForGood(brain, writeBack, gone);
  if (reason === 'unrecorded') {
    for (const snapshot of write.before) await restoreSnapshot(brain, writeBack, snapshot);
  }
}

async function deleteForGood(brain: Brain, writeBack: MemoryToolWriteBack | undefined, traceIds: string[]): Promise<void> {
  if (writeBack) {
    await writeBack.deleteTraces(traceIds);
    return;
  }
  await brain.transaction(async (trx) => {
    await deleteTraceRows(trx, brain.brainId, traceIds);
    const rebuild = brain.fullTextRebuild();
    await trx.run(rebuild.sql, rebuild.params);
  });
}

async function restoreSnapshot(brain: Brain, writeBack: MemoryToolWriteBack | undefined, snapshot: TraceSnapshot): Promise<void> {
  if (writeBack) {
    await writeBack.restoreTrace(snapshot.id, snapshot);
    return;
  }
  const { dialect } = brain.features;
  await brain.transaction(async (trx) => {
    // A snapshot read in the plain form goes back under the encoded id once the brain holds that form, as
    // `Memory.restoreTrace` writes it.
    let restored = snapshot;
    if (snapshot.scopeIdForm === 'plain') {
      if (dialect.name === 'postgres') await takeScopeIdFormLock(trx, brain.brainId);
      if (await holdsEncodedScopeIdForm(trx, brain.brainId)) restored = snapshotInEncodedForm(snapshot);
    }
    await writeTraceSnapshot(trx, dialect.insertOrReplace.bind(dialect), brain.brainId, restored);
    const rebuild = brain.fullTextRebuild();
    await trx.run(rebuild.sql, rebuild.params);
  });
}
