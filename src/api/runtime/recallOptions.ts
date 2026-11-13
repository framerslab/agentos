/**
 * @file recallOptions.ts
 * The construction rules of `memory.recall` on `agent()` and `gmi()`: where the setting goes, what it replaces and
 * what is refused.
 *
 * @module api/runtime/recallOptions
 */
import type { MemoryRecallConfig } from '../../cognition/memory/core/config.js';
import { assertRecallConfig, rejectRecallOption } from '../../cognition/memory/retrieval/recall/budget.js';

/** What {@link resolveRecallOptions} decided. */
export interface ResolvedRecallOptions {
  /** What the cognitive memory manager is built with; undefined when unset or when no cognitive memory runs. */
  managerRecall: MemoryRecallConfig | undefined;
  /** The `tokenBudget` for `memoryProvider.getContext`; undefined keeps `memoryProviderOptions.tokenBudget`, else `DEFAULT_MEMORY_TOKEN_BUDGET`. */
  providerTokenBudget: number | undefined;
  /**
   * Options that were set and are applied nowhere; the caller writes one `memory.recall.option_ignored` line for each.
   * `token_budget`: `memoryProviderOptions.tokenBudget` beside cognitive memory with no `memoryProvider.getContext`.
   * `recall_budget`: `memory.recall.budget.totalTokens` with neither cognitive memory nor a `memoryProvider.getContext`.
   */
  ignored: Array<'token_budget' | 'recall_budget'>;
}

/** What {@link resolveRecallOptions} reads. */
export interface RecallOptionsInput {
  /** The agent's `memory.recall`; `null` (a JSON value) is unset. */
  recall: MemoryRecallConfig | null | undefined;
  /** Whether cognitive memory supplies the memory block of the agent's session turns (the GMI path with memory on). */
  cognitiveMemory: boolean;
  /** The agent's `memoryProviderOptions.tokenBudget`. */
  providerTokenBudget: number | undefined;
  /**
   * Whether the agent has a `memoryProvider.getContext`. On the GMI path with cognitive memory on, a session's turn
   * skips it, and `generate()` and `stream()`, which run without cognitive memory, still call it with
   * `memoryProviderOptions.tokenBudget`.
   */
  providerContext: boolean;
  /** What opens a refusal's message: `agent()` or `gmi()`. */
  where: string;
}

/**
 * Applies the construction rules of `memory.recall`.
 *
 * - With cognitive memory on (the GMI path), the recall setting goes to the manager, and
 *   `memoryProviderOptions.tokenBudget` never sizes the block: it is reported in `ignored` when it is set and no
 *   `memoryProvider.getContext` reads it (with one, `generate()` and `stream()` still hand it to the provider).
 * - Without it (the default runtime, or a GMI agent whose memory is off), `budget.totalTokens` is the provider's
 *   `tokenBudget` when `memoryProviderOptions.tokenBudget` is unset, two different values are refused (`conflict`), and
 *   `capture`, `retrieval` and `rerank` (any value, `'none'` included) are refused (`unsupported_runtime`): no cognitive
 *   assembler or recall runs. With no `memoryProvider.getContext` to read it, a set `budget.totalTokens` is reported in
 *   `ignored` (`recall_budget`).
 * - Either way, a value of the wrong kind, or a setting or a budget that is not an object, is refused (`invalid_value`),
 *   and a `rerank` that names a provider other than `local` or `llm` is refused (`unsupported_provider`).
 *
 * @throws {RecallOptionError} Naming the field, after one `memory.recall.option_rejected` line.
 */
export function resolveRecallOptions(o: RecallOptionsInput): ResolvedRecallOptions {
  const recall = o.recall ?? undefined;
  assertRecallConfig(recall, o.where);
  if (o.cognitiveMemory) {
    return {
      managerRecall: recall,
      providerTokenBudget: undefined,
      ignored: o.providerTokenBudget !== undefined && !o.providerContext ? ['token_budget'] : [],
    };
  }
  if (recall?.capture != null) {
    rejectRecallOption(
      'capture',
      'unsupported_runtime',
      `${o.where}: memory.recall.capture needs cognitive memory, which runs on runtime: 'gmi' (or gmi()) with memory on; this agent's memory comes from memoryProvider.`,
    );
  }
  if (recall?.retrieval != null) {
    rejectRecallOption(
      'retrieval',
      'unsupported_runtime',
      `${o.where}: memory.recall.retrieval needs cognitive memory, which runs on runtime: 'gmi' (or gmi()) with memory on; this agent's memory comes from memoryProvider.`,
    );
  }
  // Any value, the default included: the field has no meaning without the cognitive recall it orders.
  if (recall?.rerank != null) {
    rejectRecallOption(
      'rerank',
      'unsupported_runtime',
      `${o.where}: memory.recall.rerank needs cognitive memory, which runs on runtime: 'gmi' (or gmi()) with memory on; this agent's memory comes from memoryProvider.`,
    );
  }
  const total = recall?.budget?.totalTokens ?? undefined;
  if (total !== undefined && o.providerTokenBudget !== undefined && total !== o.providerTokenBudget) {
    rejectRecallOption(
      'budget.totalTokens',
      'conflict',
      `${o.where}: memory.recall.budget.totalTokens (${total}) and memoryProviderOptions.tokenBudget (${o.providerTokenBudget}) are both set and differ; set one.`,
    );
  }
  return {
    managerRecall: undefined,
    providerTokenBudget: total ?? o.providerTokenBudget,
    ignored: total !== undefined && !o.providerContext ? ['recall_budget'] : [],
  };
}
