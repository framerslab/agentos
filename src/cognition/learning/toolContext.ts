/**
 * @module learning/toolContext
 *
 * What a tool reads about the turn it runs in. A GMI with a learner session puts a {@link ToolLearningContext} on
 * every tool call's session data (`sessionData.learning`); a call without one runs on a host with no learning layer.
 * The five self-modification tools (`forge_tool`, `create_workflow`, `manage_skills`, `self_evaluate`'s `adjust` and
 * `adapt_personality`) ask {@link selfChangeRefusal} before they act, and the memory tools that write ask
 * {@link memoryWriteRefusal}.
 */
import type { ToolExecutionResult } from '../../core/tools/ITool.js';
import { processIsFrozen } from './config.js';
import {
  DEFAULT_ANONYMOUS_USER_IDS,
  LEARNING_MODES,
  type ILearnerSession,
  type LearningMode,
  type ProposalResult,
  type SelfChangeTurn,
  type SessionSelfChange,
  type ToolLearningContext,
  type TurnScopes,
} from './types.js';

/**
 * Whether a value is a turn's scopes as a learner session gives them: the GMI checks a preparation's before it files
 * by them, and a tool before it reads them. A blank scope id is no turn's: `''` is the Brain's unscoped traces.
 */
export function isTurnScopes(value: unknown): value is TurnScopes {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.learner === 'bound' || v.learner === 'none') &&
    LEARNING_MODES.includes(v.mode as LearningMode) &&
    typeof v.userScopeId === 'string' &&
    v.userScopeId !== '' &&
    typeof v.personaScopeId === 'string' &&
    v.personaScopeId !== '' &&
    typeof v.namespace === 'string'
  );
}

/**
 * Reads `sessionData.learning`.
 *
 * @returns `undefined` when the call carries none: the host has no learning layer. Otherwise the turn's learner and
 *   mode (a learner value that is not `'bound'` reads as no learner, a mode it does not know as `'off'`), and, where
 *   the GMI put them there and they are well formed, the turn's scopes, the session's recorder, a second user's id
 *   and the freeze to read at the call.
 */
export function readToolLearningContext(
  sessionData: Record<string, unknown> | undefined,
): ToolLearningContext | undefined {
  const raw = sessionData?.learning;
  if (raw === undefined || raw === null) return undefined;
  const fields = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const { learner, mode, scopes, recordSelfChange, turnUserId, frozen } = fields;
  return {
    learner: learner === 'bound' ? 'bound' : 'none',
    mode: LEARNING_MODES.includes(mode as LearningMode) ? (mode as LearningMode) : 'off',
    ...(isTurnScopes(scopes) ? { scopes } : {}),
    ...(typeof recordSelfChange === 'function' ? { recordSelfChange: recordSelfChange as ToolLearningContext['recordSelfChange'] } : {}),
    ...(typeof turnUserId === 'string' && turnUserId !== '' ? { turnUserId } : {}),
    ...(typeof frozen === 'function' ? { frozen: frozen as () => boolean } : {}),
  };
}

/** Why a self-modification tool refused before it acted. */
export type SelfChangeRefusal = 'frozen' | 'off' | 'no_learner';

const REFUSAL_TEXT: Record<SelfChangeRefusal, string> = {
  frozen: 'self-change is frozen',
  off: 'learning is off for this turn',
  no_learner: 'this turn has no learner',
};

/**
 * The refusal a self-modification tool gives before it acts, or `undefined` when it may act. In order: the process
 * freeze (`AGENTOS_LEARNING_FREEZE=1`, with or without a layer), a turn in mode `frozen` or a run-time freeze of the
 * turn's scope, read at the call; then, with a layer, a turn in mode `off`; then a turn with no learner. Without a
 * layer only the process freeze refuses.
 *
 * @param sessionData - The call's `ToolExecutionContext.sessionData`.
 * @param env - The environment to read; the process's by default.
 */
export function selfChangeRefusal(
  sessionData: Record<string, unknown> | undefined,
  env?: Record<string, string | undefined>,
): SelfChangeRefusal | undefined {
  const learning = readToolLearningContext(sessionData);
  if (processIsFrozen(env) || learning?.mode === 'frozen' || learning?.frozen?.() === true) return 'frozen';
  if (!learning) return undefined;
  if (learning.mode === 'off') return 'off';
  if (learning.learner !== 'bound') return 'no_learner';
  return undefined;
}

/**
 * The refusal a memory tool that writes (`memory_add`, `memory_update`, `memory_delete`, `memory_merge`,
 * `memory_reflect`) gives before it acts, or `undefined`: only a freeze stops it. The process freeze refuses with a
 * layer or without one; with a layer, a turn in mode `frozen` or a run-time freeze of the turn's scope. Mode `off`, a
 * suspension and a turn with no learner do not.
 *
 * @param sessionData - The call's `ToolExecutionContext.sessionData`.
 * @param env - The environment to read; the process's by default.
 */
export function memoryWriteRefusal(
  sessionData: Record<string, unknown> | undefined,
  env?: Record<string, string | undefined>,
): 'frozen' | undefined {
  const learning = readToolLearningContext(sessionData);
  if (processIsFrozen(env) || learning?.mode === 'frozen' || learning?.frozen?.() === true) return 'frozen';
  return undefined;
}

/**
 * The result a self-modification tool returns when it refuses: nothing changed, and `details.reason` names why.
 *
 * @param toolName - The tool's name, as the model called it.
 * @param reason - A {@link SelfChangeRefusal}, or a tool's own reason (for `adapt_personality`, a bound).
 * @param why - The sentence for a tool's own reason; a {@link SelfChangeRefusal} has its own.
 */
export function refusedSelfChange<T = never>(toolName: string, reason: string, why?: string): ToolExecutionResult<T> {
  const text = why ?? REFUSAL_TEXT[reason as SelfChangeRefusal] ?? reason;
  return {
    success: false,
    error: `${toolName} refused (${reason}): ${text}; nothing was changed.`,
    details: { status: 'rejected', reason },
  };
}

/**
 * A turn's tool context (`sessionData.learning`) and the turn its recorded writes belong to, from a learner session
 * and what it prepared for the turn. The GMI builds each turn's with it, and a product that runs its own turn loop
 * puts the same on its tool calls. The recorder and the freeze read are bound to the turn and called on the session,
 * each only where the session has it; the turn's conversation goes to the session row, so `forgetUser` deletes the
 * conversation's thread.
 *
 * @param session - The learner session the turn was prepared by.
 * @param turn - The turn's learner and mode, its scope ids where the session gives them, the explicit id of a second
 *   user on a turn with no learner, and the turn's conversation id.
 * @returns `tools`, what each tool call of the turn is told; `writeTurn`, what the session's recorder and guard are told
 *   about the turn, `undefined` when the turn has no scope ids.
 */
export function toolLearningContextFor(
  session: ILearnerSession,
  turn: { learner: 'bound' | 'none'; mode: LearningMode; scopes?: TurnScopes; turnUserId?: string; conversationId?: string },
): { tools: ToolLearningContext; writeTurn: SelfChangeTurn | undefined } {
  const { scopes, turnUserId } = turn;
  const writeTurn: SelfChangeTurn | undefined = scopes
    ? {
        learner: scopes.learner,
        namespace: scopes.namespace,
        ...(turnUserId ? { turnUserId } : {}),
        ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
      }
    : undefined;
  const tools: ToolLearningContext = {
    learner: turn.learner,
    mode: turn.mode,
    ...(scopes ? { scopes } : {}),
    ...(writeTurn && typeof session.recordSelfChange === 'function'
      ? { recordSelfChange: <T>(input: SessionSelfChange<T>) => session.recordSelfChange!(input, writeTurn) }
      : {}),
    ...(turnUserId ? { turnUserId } : {}),
    ...(typeof session.isFrozen === 'function' ? { frozen: () => session.isFrozen!(writeTurn) } : {}),
  };
  return { tools, writeTurn };
}

/**
 * A turn's explicit user id: a non-blank id outside the default anonymous ids. A learner session drops the ids a host
 * adds to `learning.anonymousUserIds` when it keys a write to a turn's user (`SelfChangeTurn.turnUserId`).
 */
export function explicitTurnUserOf(userId: string | null | undefined): string | undefined {
  return typeof userId === 'string' && userId.trim() !== '' && !DEFAULT_ANONYMOUS_USER_IDS.includes(userId) ? userId : undefined;
}

/** A turn's learning for the memory paths that run before its GMI prepares it. */
export interface TurnLearningBeforePreparation {
  /** The turn's scope ids, by the session's own rule. */
  scopes: TurnScopes;
  /** On a turn with no learner: the turn's explicit user, whom its writes record. */
  turnUserId?: string;
  /** The session's recorder, bound to the turn; absent when the session has none. */
  recordSelfChange?: <T>(input: SessionSelfChange<T>) => Promise<ProposalResult<T>>;
}

/**
 * The learning of a turn for what reads and files its memory before the GMI prepares it: the full runtime's standalone
 * retriever and rolling-summary sink, which run in the turn pipeline before the GMI's turn. The session's `scopesFor`
 * gives the turn's scope ids by the session's rule, counting no turn and ending the session's learner on a turn of
 * another user or namespace as `prepareTurn` does; a turn with no learner records its explicit user; and the
 * session's recorder is bound to the turn, with the conversation its thread is filed under. A session that has not
 * opened yet answers its session's form with no learner, as the GMI's degraded turn does.
 *
 * @param session - The GMI's learner session.
 * @param turn - The turn's user (`null` for none), its namespace (the turn's organization, `''` for none), whether it
 *   is a workflow turn, and its conversation id.
 * @returns `undefined` when the session names no scope ids (a host's own session with no `scopesFor`): the caller
 *   then reads and files under the plain ids, as with no learning layer.
 * @throws What the session's `scopesFor` throws.
 */
export function turnLearningBeforePreparation(
  session: ILearnerSession,
  turn: { userId: string | null; namespace: string; workflowSeat: boolean; conversationId?: string },
): TurnLearningBeforePreparation | undefined {
  if (typeof session.scopesFor !== 'function') return undefined;
  const scopes = session.scopesFor({ userId: turn.userId, namespace: turn.namespace, workflowSeat: turn.workflowSeat });
  if (!isTurnScopes(scopes)) return undefined;
  const turnUserId = scopes.learner === 'none' ? explicitTurnUserOf(turn.userId) : undefined;
  const { tools } = toolLearningContextFor(session, {
    learner: scopes.learner,
    mode: scopes.mode,
    scopes,
    ...(turnUserId ? { turnUserId } : {}),
    ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
  });
  return {
    scopes,
    ...(turnUserId ? { turnUserId } : {}),
    ...(tools.recordSelfChange ? { recordSelfChange: tools.recordSelfChange } : {}),
  };
}
