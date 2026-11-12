/**
 * @fileoverview The memory block's budget and the value checks of the recall settings (`memory.recall` on `agent()`
 * and `gmi()`, a persona's `cognitiveMemoryConfig.recall`, a manager's `recall`).
 *
 * @module agentos/cognition/memory/retrieval/recall/budget
 */
import type { ManagerRecallConfig } from '../../core/config.js';
import { recallLog } from './log.js';

/** The memory block's budget, in tokens, when no `recall.budget.totalTokens` is set: what the GMI's memory bridge asked for before the setting existed. */
export const DEFAULT_RECALL_BUDGET_TOKENS = 1600;

const CAPTURE_MODES: readonly unknown[] = ['off', 'metadata', 'metadata+stream'];
const RETRIEVAL_MODES: readonly unknown[] = ['dense', 'hybrid'];
/** The hybrid recall's constants that count candidates, so must be whole numbers of at least 1. */
const COUNT_CONSTANTS: readonly string[] = ['topK', 'recentTopK', 'overFetch'];

/** Why a recall setting was refused at construction. */
export type RecallOptionRejection = 'conflict' | 'unsupported_provider' | 'unsupported_runtime' | 'invalid_value';

/**
 * A recall setting refused at construction. `option` is the field under `memory.recall` (`budget.totalTokens`,
 * `budget`, `capture`, `retrieval`, a manager's `constants`), or `recall` for the setting itself.
 */
export class RecallOptionError extends Error {
  constructor(
    readonly option: string,
    readonly reason: RecallOptionRejection,
    message: string,
  ) {
    super(message);
    this.name = 'RecallOptionError';
  }
}

/**
 * Writes one `memory.recall.option_rejected` line, then throws.
 *
 * @throws {RecallOptionError} Always, with `option`, `reason` and `message`.
 */
export function rejectRecallOption(option: string, reason: RecallOptionRejection, message: string): never {
  recallLog.error('memory.recall.option_rejected', { option, reason });
  throw new RecallOptionError(option, reason, message);
}

/** Whether `value` is a plain settings object: an object that is not an array. */
function isSettingsObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a recall setting's values: the setting and its `budget` objects, `budget.totalTokens` an integer of at least
 * 0, `capture` one of its three modes, `retrieval` `'dense'` or `'hybrid'`, and a manager's `constants` an object
 * whose values are finite numbers of at least 0, `topK`, `recentTopK` and `overFetch` integers of at least 1, and
 * `nearDuplicate` above 0 and at most 1. A `null` or `undefined` setting, or field, is unset.
 *
 * @param recall - The setting.
 * @param where - What opens the message (`gmi()`, `agent()`, `CognitiveMemoryManager`).
 * @throws {RecallOptionError} With the reason `invalid_value`, naming the field, after one `memory.recall.option_rejected` line.
 */
export function assertRecallConfig(recall: ManagerRecallConfig | null | undefined, where: string): void {
  if (recall == null) return;
  // A JavaScript caller's `recall: 'off'` or `budget: 2400` would otherwise read as unset and build on the defaults.
  if (!isSettingsObject(recall)) {
    rejectRecallOption('recall', 'invalid_value', `${where}: memory.recall must be an object ({ budget?, capture? }).`);
  }
  const budget: unknown = recall.budget;
  if (budget != null && !isSettingsObject(budget)) {
    rejectRecallOption('budget', 'invalid_value', `${where}: memory.recall.budget must be an object ({ totalTokens? }).`);
  }
  const total: unknown = recall.budget?.totalTokens;
  if (total != null && !(typeof total === 'number' && Number.isInteger(total) && total >= 0)) {
    rejectRecallOption('budget.totalTokens', 'invalid_value', `${where}: memory.recall.budget.totalTokens must be an integer of at least 0.`);
  }
  if (recall.capture != null && !CAPTURE_MODES.includes(recall.capture)) {
    rejectRecallOption('capture', 'invalid_value', `${where}: memory.recall.capture must be 'off', 'metadata' or 'metadata+stream'.`);
  }
  if (recall.retrieval != null && !RETRIEVAL_MODES.includes(recall.retrieval)) {
    rejectRecallOption('retrieval', 'invalid_value', `${where}: memory.recall.retrieval must be 'dense' or 'hybrid'.`);
  }
  const constants: unknown = recall.constants;
  if (constants != null) {
    if (!isSettingsObject(constants)) {
      rejectRecallOption('constants', 'invalid_value', `${where}: recall.constants must be an object of numbers.`);
    }
    for (const [name, value] of Object.entries(constants as Record<string, unknown>)) {
      if (value == null) continue;
      const finite = typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const fits = COUNT_CONSTANTS.includes(name)
        ? finite && Number.isInteger(value) && value >= 1
        : name === 'nearDuplicate'
          ? finite && value > 0 && value <= 1
          : finite;
      if (!fits) {
        const rule = COUNT_CONSTANTS.includes(name)
          ? 'an integer of at least 1'
          : name === 'nearDuplicate'
            ? 'a number above 0 and at most 1'
            : 'a finite number of at least 0';
        rejectRecallOption('constants', 'invalid_value', `${where}: recall.constants.${name} must be ${rule}.`);
      }
    }
  }
}

/**
 * The configured budget of the memory block, in tokens, its preamble included: `recall.budget.totalTokens`, else
 * {@link DEFAULT_RECALL_BUDGET_TOKENS}.
 */
export function recallBudgetTokens(recall: ManagerRecallConfig | null | undefined): number {
  return recall?.budget?.totalTokens ?? DEFAULT_RECALL_BUDGET_TOKENS;
}

/**
 * The share of a model's context PromptEngine gives retrieved context (`applyTokenBudget`'s `rag` budget), which the
 * memory block and the turn's other retrieved context (RAG, long-term-memory text) share. Fixed at 0.20.
 */
export const PROMPT_CONTEXT_SHARE = 0.2;

/** The memory block's budget on one model: what was asked for, what the model's share leaves, and why they differ. */
export interface EffectiveRecallBudget {
  /** The configured budget (`recall.budget.totalTokens`). */
  requested: number;
  /** The budget the block is rendered in on this model: never above `requested`, never below 0. */
  effective: number;
  /** Set when `effective` is below `requested`: `zero_remaining` when nothing is left, `prompt_share` otherwise. */
  clampReason?: 'prompt_share' | 'zero_remaining';
  /** The model's retrieved-context share, in tokens. */
  promptShareTokens?: number;
  /** The turn's other retrieved context, in tokens, which the share holds first. */
  otherContextTokens?: number;
  /**
   * An input was not a finite number of at least 0 (the context size: above 0), so the clamp was skipped and
   * `effective` is `requested`.
   */
  invalid?: true;
}

/**
 * The memory block's budget on one model: the smaller of the configured budget and what is left of the model's
 * retrieved-context share ({@link PROMPT_CONTEXT_SHARE} of `contextTokens`, floored) after the turn's RAG and
 * long-term-memory text. Never below 0.
 *
 * @param i.totalTokens - The configured budget.
 * @param i.contextTokens - The model's context size as PromptEngine budgets it (`optimalContextTokens`, else `maxContextTokens`).
 * @param i.otherContextTokens - The tokens of the turn's other retrieved context.
 * @returns The budget, with `invalid` set when an input was not a finite number in range.
 */
export function effectiveRecallBudget(i: { totalTokens: number; contextTokens: number; otherContextTokens: number }): EffectiveRecallBudget {
  const inRange = (n: number): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!inRange(i.totalTokens) || !inRange(i.otherContextTokens) || !inRange(i.contextTokens) || i.contextTokens === 0) {
    return { requested: i.totalTokens, effective: i.totalTokens, invalid: true };
  }
  const promptShareTokens = Math.floor(PROMPT_CONTEXT_SHARE * i.contextTokens);
  const effective = Math.max(0, Math.min(i.totalTokens, promptShareTokens - i.otherContextTokens));
  const budget: EffectiveRecallBudget = { requested: i.totalTokens, effective, promptShareTokens, otherContextTokens: i.otherContextTokens };
  if (effective < i.totalTokens) budget.clampReason = effective === 0 ? 'zero_remaining' : 'prompt_share';
  return budget;
}

/** The assembler's token estimate (about four characters a token), with which the GMI sizes the other context. */
export { estimateMemoryTokens } from '../../core/prompt/MemoryPromptAssembler.js';
