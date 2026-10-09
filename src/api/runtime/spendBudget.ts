/**
 * @file spendBudget.ts
 * @description A spend budget for a run of calls. Before each provider call
 * the call's largest cost is checked against what the budget has left; after
 * it, the cost the provider reported (or its token counts at the model's
 * listed price) is recorded. The spending is held by a CostGuard under the
 * budget's id, so budgets that share a guard and an id share one total, and a
 * guard's own daily cap holds across all of them.
 */
import { CostCapExceededError, CostGuard } from '../../safety/runtime/CostGuard.js';
import type { CostCapType } from '../../safety/runtime/CostGuard.js';
import { openAIModelPricing } from '../../core/llm/providers/implementations/openaiPricing.js';
import { clampMaxOutputTokens } from '../../core/llm/providers/model-output-limits.js';

/** What a budget was about to refuse, for an `onLimitReached` callback. */
export interface SpendLimitInfo {
  /** The budget's id. */
  budgetId: string;
  /** Which cap: the guard's session, daily or single-call cap, the token budget, or a model with no price row. */
  capType: CostCapType | 'tokens' | 'unpriced';
  /** What the call was: `generate_text.step`, `stream_text`, `embed_text` and the like. */
  what: string;
  /** Why, in one sentence. */
  reason: string;
}

/** A budget's settings. */
export interface SpendBudgetOptions {
  /** The most the run may spend, in US dollars. */
  maxCostUSD: number;
  /** The most prompt and completion tokens the run may use, counted by this budget: zero or more. */
  maxTotalTokens?: number;
  /**
   * What a call that would pass the budget does: `'throw'` (the default) refuses it with
   * {@link CostCapExceededError}; `'warn'` logs once per call and lets it run; a function is told
   * what was about to be refused and the call is then refused as with `'throw'`.
   */
  onLimitReached?: 'throw' | 'warn' | ((info: SpendLimitInfo) => void);
  /** The guard that holds the spending; a budget given none makes its own, with no daily or single-call cap. */
  guard?: CostGuard;
  /** The id the guard keeps the spending under; a budget given none makes one. */
  budgetId?: string;
  /**
   * A call on a model with no price row: `'refuse'` (the default) refuses it with {@link UnpricedModelError},
   * since its cost could not be counted; `'allow'` lets it run and counts its cost as nothing, while the token
   * budget and a budget already past its cap still refuse it.
   */
  unpriced?: 'refuse' | 'allow';
}

/** Refused because the model has no price row, so the call's cost could not be counted. */
export class UnpricedModelError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly modelId: string,
  ) {
    super(`No price is known for ${providerId}:${modelId}, so a call to it cannot be counted against the budget`);
    this.name = 'UnpricedModelError';
  }
}

/** The output tokens a call is assumed to use when it names no cap, or a cap of NaN. */
export const DEFAULT_OUTPUT_ESTIMATE_TOKENS = 4096;

/**
 * The output tokens a call to `modelId` is estimated with: its cap, held to the model's output ceiling where one below
 * it is known (16,384 for gpt-4o), as OpenAIProvider sends it, or {@link DEFAULT_OUTPUT_ESTIMATE_TOKENS} without one.
 */
function outputTokensOf(modelId: string, maxOutputTokens: number | undefined): number {
  // A cap of NaN (what `Number(undefined)` gives) limits nothing: OpenAI is sent it as null. An estimate made with it
  // would be NaN, which every check lets through, since every comparison with NaN is false.
  const cap = clampMaxOutputTokens(modelId, maxOutputTokens);
  return cap === undefined || Number.isNaN(cap) ? DEFAULT_OUTPUT_ESTIMATE_TOKENS : cap;
}

let budgets = 0;

/** A budget for a run of calls; pass one instance to every call that should share it. */
export class SpendBudget {
  /** The id its spending is kept under. */
  readonly id: string;
  /** Its settings. */
  readonly options: Readonly<SpendBudgetOptions>;
  private readonly guard: CostGuard;
  private tokens = 0;

  /**
   * @param options - The budget's settings.
   * @throws {RangeError} When `maxCostUSD`, or a `maxTotalTokens` that is set, is not a number zero or more.
   */
  constructor(options: SpendBudgetOptions) {
    if (!(options.maxCostUSD >= 0)) throw new RangeError('maxCostUSD must be zero or more');
    // A token cap of NaN (what `Number(undefined)` gives) would never refuse a call, since every comparison with NaN
    // is false.
    if (options.maxTotalTokens !== undefined && !(options.maxTotalTokens >= 0)) {
      throw new RangeError('maxTotalTokens must be zero or more');
    }
    this.options = options;
    this.id = options.budgetId ?? `budget-${Date.now()}-${++budgets}`;
    this.guard =
      options.guard ??
      new CostGuard({
        maxSessionCostUsd: options.maxCostUSD,
        maxDailyCostUsd: Number.POSITIVE_INFINITY,
        maxSingleOperationCostUsd: Number.POSITIVE_INFINITY,
      });
    if (options.guard) options.guard.setAgentLimits(this.id, { maxSessionCostUsd: options.maxCostUSD });
  }

  /** What the run has spent, in US dollars, as the guard holds it. */
  spentUSD(): number {
    return this.guard.getSnapshot(this.id).sessionCostUsd;
  }

  /** The tokens this budget has counted. */
  tokensUsed(): number {
    return this.tokens;
  }

  /**
   * Refuses (or warns about) a call that could cost up to `estimateUSD` and use up to `estimateTokens`, when it would
   * pass what is left; `estimateUSD` undefined means the model has no price row, which `unpriced: 'allow'` checks as
   * a call that costs nothing. `model`, the call's provider and model, is named in the refusal of a model with no
   * price row.
   */
  assertCanSpend(
    estimateUSD: number | undefined,
    estimateTokens: number,
    what: string,
    model?: { providerId: string; modelId: string },
  ): void {
    if (estimateUSD === undefined && this.options.unpriced !== 'allow') {
      const reason = model ? `${model.providerId}:${model.modelId} has no price row` : 'the model has no price row';
      this.refuse({ budgetId: this.id, capType: 'unpriced', what, reason }, () => {
        throw new UnpricedModelError(model?.providerId ?? 'unknown', model?.modelId ?? what);
      });
      return;
    }
    const max = this.options.maxTotalTokens;
    if (max !== undefined && this.tokens + estimateTokens > max) {
      this.refuse({ budgetId: this.id, capType: 'tokens', what, reason: `${this.tokens + estimateTokens} tokens would pass ${max}` }, () => {
        throw new CostCapExceededError(this.id, 'session', this.spentUSD(), this.options.maxCostUSD);
      });
      return;
    }
    // A call allowed without a price row is checked as costing nothing, so a budget already past its cap (through a
    // cost a provider reported, or one recorded from outside) still stops it.
    const verdict = this.guard.canAfford(this.id, estimateUSD ?? 0);
    if (verdict.allowed) return;
    const capType = verdict.capType ?? 'session';
    this.refuse({ budgetId: this.id, capType, what, reason: verdict.reason ?? 'the budget is spent' }, () => {
      throw new CostCapExceededError(this.id, capType, this.spentUSD(), this.options.maxCostUSD);
    });
  }

  /**
   * Records a finished call: its cost (undefined for a model with no price row, counted as nothing) and its tokens. A
   * token count the provider reported as `NaN` counts as none: added, it would make the count NaN, and a count of NaN
   * never reaches `maxTotalTokens`, since every comparison with NaN is false.
   */
  record(costUSD: number | undefined, tokens: number, what: string): void {
    const counted = Math.max(0, tokens);
    this.tokens += Number.isNaN(counted) ? 0 : counted;
    if (costUSD !== undefined && costUSD > 0) this.guard.recordCost(this.id, costUSD, undefined, { what });
  }

  /**
   * Records a cost made outside AgentOS, such as speech-to-text minutes billed by the minute. A cost of zero or below
   * records nothing.
   *
   * @throws {RangeError} When `costUSD` is not a number, `NaN` included: a cost that could not be counted would let
   *   the run spend past its cap.
   */
  recordExternal(costUSD: number, kind: string): void {
    if (typeof costUSD !== 'number' || Number.isNaN(costUSD)) {
      throw new RangeError(`An outside cost must be a number of US dollars, not ${String(costUSD)}`);
    }
    if (costUSD > 0) this.guard.recordCost(this.id, costUSD, undefined, { what: `external.${kind}` });
  }

  private refuse(info: SpendLimitInfo, thrower: () => never): void {
    const on = this.options.onLimitReached ?? 'throw';
    if (on === 'warn') {
      console.warn(`[agentos] spend budget ${info.budgetId}: ${info.what} would pass the budget (${info.reason}); running it`);
      return;
    }
    if (typeof on === 'function') on(info);
    thrower();
  }
}

/** A budget from what a caller passed: an instance as it is, settings made into a new instance, or nothing. */
export function asSpendBudget(input: SpendBudget | SpendBudgetOptions | undefined): SpendBudget | undefined {
  if (input === undefined) return undefined;
  return input instanceof SpendBudget ? input : new SpendBudget(input);
}

/**
 * The characters a request sends: its messages as JSON, its system prompt and its tool definitions as JSON, which
 * estimate its prompt tokens. A provider bills the tool definitions a call sends as prompt tokens.
 */
export function promptCharsOf(messages: unknown, system?: unknown, tools?: unknown): number {
  const systemText = typeof system === 'string' ? system : system === undefined ? '' : JSON.stringify(system);
  const toolsText = tools === undefined ? '' : JSON.stringify(tools);
  return JSON.stringify(messages ?? []).length + systemText.length + toolsText.length;
}

/** The tokens a prompt of `chars` characters is assumed to hold: four characters a token, rounded up. */
export function tokensOfChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * The most a call could cost: its prompt's assumed tokens at the input rate and its output cap at the output rate
 * ({@link DEFAULT_OUTPUT_ESTIMATE_TOKENS} when it names none, or a cap of NaN), a cap above the model's known output
 * ceiling counted at the ceiling. Undefined when the provider's model has no price row (only OpenAI's table is known
 * here).
 */
export function estimateCallCostUSD(providerId: string, modelId: string, promptChars: number, maxOutputTokens: number | undefined): number | undefined {
  const price = providerId === 'openai' ? openAIModelPricing(modelId) : undefined;
  if (!price) return undefined;
  const output = outputTokensOf(modelId, maxOutputTokens);
  return (tokensOfChars(promptChars) / 1000) * price.input + (output / 1000) * price.output;
}

/**
 * Checks a provider call against a budget before it is sent: its prompt of `promptChars` characters and its output cap
 * (held to the model's output ceiling where one below it is known, or {@link DEFAULT_OUTPUT_ESTIMATE_TOKENS} without
 * one, or for a cap of NaN), priced at the model's row and counted against the token budget, through
 * {@link SpendBudget.assertCanSpend}.
 *
 * @internal Called by the generation helpers before each provider call.
 */
export function assertCallWithinBudget(
  budget: SpendBudget,
  route: { providerId: string; modelId: string },
  promptChars: number,
  maxOutputTokens: number | undefined,
  what: string,
): void {
  budget.assertCanSpend(
    estimateCallCostUSD(route.providerId, route.modelId, promptChars, maxOutputTokens),
    tokensOfChars(promptChars) + outputTokensOf(route.modelId, maxOutputTokens),
    what,
    { providerId: route.providerId, modelId: route.modelId },
  );
}

/**
 * A finished call's cost: the provider's own `costUSD` when it reported one, else its tokens at the table's rates
 * (an embedding prices its prompt tokens alone); undefined when neither is known.
 */
export function costOfUsageUSD(
  providerId: string,
  modelId: string,
  usage: { promptTokens?: number; completionTokens?: number; costUSD?: number } | undefined,
  isEmbedding = false,
): number | undefined {
  if (typeof usage?.costUSD === 'number') return usage.costUSD;
  const price = providerId === 'openai' ? openAIModelPricing(modelId) : undefined;
  if (!price || usage === undefined) return undefined;
  const prompt = usage.promptTokens ?? 0;
  return isEmbedding ? (prompt / 1000) * price.input : (prompt / 1000) * price.input + ((usage.completionTokens ?? 0) / 1000) * price.output;
}
