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

/** Why a recall setting was refused at construction. */
export type RecallOptionRejection = 'conflict' | 'unsupported_provider' | 'unsupported_runtime' | 'invalid_value';

/**
 * A recall setting refused at construction. `option` is the field under `memory.recall` (`budget.totalTokens`,
 * `budget`, `capture`), or `recall` for the setting itself.
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
 * 0, `capture` one of its three modes. A `null` or `undefined` setting, or field, is unset.
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
}

/**
 * The configured budget of the memory block, in tokens, its preamble included: `recall.budget.totalTokens`, else
 * {@link DEFAULT_RECALL_BUDGET_TOKENS}.
 */
export function recallBudgetTokens(recall: ManagerRecallConfig | null | undefined): number {
  return recall?.budget?.totalTokens ?? DEFAULT_RECALL_BUDGET_TOKENS;
}
