/**
 * @module learning/toolContext
 *
 * What a tool reads about the turn it runs in. A GMI with a learner session puts a {@link ToolLearningContext} on
 * every tool call's session data (`sessionData.learning`); a call without one runs on a host with no learning layer.
 * The five self-modification tools (`forge_tool`, `create_workflow`, `manage_skills`, `self_evaluate`'s `adjust` and
 * `adapt_personality`) ask {@link selfChangeRefusal} before they act.
 */
import type { ToolExecutionResult } from '../../core/tools/ITool.js';
import { processIsFrozen } from './config.js';
import { LEARNING_MODES, type LearningMode, type ToolLearningContext } from './types.js';

/**
 * Reads `sessionData.learning`.
 *
 * @returns `undefined` when the call carries none: the host has no learning layer. Otherwise the turn's learner and
 *   mode; a learner value that is not `'bound'` reads as no learner, and a mode it does not know reads as `'off'`.
 */
export function readToolLearningContext(
  sessionData: Record<string, unknown> | undefined,
): ToolLearningContext | undefined {
  const raw = sessionData?.learning;
  if (raw === undefined || raw === null) return undefined;
  const { learner, mode } = (typeof raw === 'object' ? raw : {}) as { learner?: unknown; mode?: unknown };
  return {
    learner: learner === 'bound' ? 'bound' : 'none',
    mode: LEARNING_MODES.includes(mode as LearningMode) ? (mode as LearningMode) : 'off',
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
 * freeze (`AGENTOS_LEARNING_FREEZE=1`, with or without a layer) or a turn in mode `frozen`; then, with a layer, a turn
 * in mode `off`; then a turn with no learner. Without a layer only the process freeze refuses.
 *
 * @param sessionData - The call's `ToolExecutionContext.sessionData`.
 * @param env - The environment to read; the process's by default.
 */
export function selfChangeRefusal(
  sessionData: Record<string, unknown> | undefined,
  env?: Record<string, string | undefined>,
): SelfChangeRefusal | undefined {
  const learning = readToolLearningContext(sessionData);
  if (processIsFrozen(env) || learning?.mode === 'frozen') return 'frozen';
  if (!learning) return undefined;
  if (learning.mode === 'off') return 'off';
  if (learning.learner !== 'bound') return 'no_learner';
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
