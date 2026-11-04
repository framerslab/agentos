/**
 * @file spendBudget.ts
 * @description A spend budget for a run of calls. Before each provider call
 * the call's largest cost is checked against what the budget has left; after
 * it, the cost the provider reported (or its token counts at the model's
 * listed price) is recorded. The spending is held by a CostGuard under the
 * budget's id, so budgets that share a guard and an id share one total, and a
 * guard's own daily cap holds across all of them. A budget given a spend meter
 * also reserves each call's largest cost in it before the call and settles the
 * call at what it cost after it, so a run's concurrent calls cannot overrun an
 * allowance several processes share.
 */
import { CostCapExceededError, CostGuard } from '../../safety/runtime/CostGuard.js';
import type { CostCapType } from '../../safety/runtime/CostGuard.js';
import type { ISpendMeter, SpendDenyReason, SpendReserveResult } from '../../safety/runtime/SpendMeter.js';
import { toMicro } from '../../safety/runtime/SpendReservations.js';
import { clampMaxOutputTokens } from '../../core/llm/providers/model-output-limits.js';
import { estimateMaxCallCostUSD, modelPricing, type MaxCostRequest, type ModelPriceTier } from './modelPricing.js';
import { createContentSafeConsole } from '../../core/logging/contentSafeConsole.js';

/** This module's fixed diagnostic origin; no runtime name enters telemetry. */
const console = createContentSafeConsole('spend_budget');

/** What a budget was about to refuse, for an `onLimitReached` callback. */
export interface SpendLimitInfo {
  /** The budget's id. */
  budgetId: string;
  /**
   * Which cap: the guard's session, daily or single-call cap, the token budget, a model or a request with no price it
   * can be held to (`unpriced`), or the budget's spend meter (`usd`).
   */
  capType: CostCapType | 'tokens' | 'unpriced' | 'usd';
  /** What the call was: `generate_text.step`, `stream_text`, `embed_text` and the like. */
  what: string;
  /**
   * Why, in one sentence. For a reservation the meter refused, the meter's word for it: `allowance_exhausted`,
   * `in_flight`, `already_consumed` or `retries_exhausted`.
   */
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
   * what was about to be refused and the call is then refused as with `'throw'`. A function that throws refuses the
   * call with its own error, and the budgets that draw on this one hear of the refusal as of any other.
   */
  onLimitReached?: 'throw' | 'warn' | ((info: SpendLimitInfo) => void);
  /**
   * The guard that holds the spending; a budget given none makes its own, with no daily or single-call cap. On a guard
   * given, the budget sets the session cap of its id to `maxCostUSD` and keeps the daily cap the guard holds for that id.
   */
  guard?: CostGuard;
  /** The id the guard keeps the spending under; a budget given none makes one. */
  budgetId?: string;
  /**
   * A call on a model with no price row: `'refuse'` (the default) refuses it with {@link UnpricedModelError},
   * since its cost could not be counted; `'allow'` lets it run and counts its cost as nothing, while the token
   * budget and a budget already past its cap still refuse it. A budget with a `meter` refuses it either way: a meter
   * cannot hold a cost nothing bounds.
   */
  unpriced?: 'refuse' | 'allow';
  /**
   * A budget this one draws on. Every check asks the parent first, with the same estimate, and every record and
   * outside cost is added to the parent after this budget. A refusal by the parent, or by any budget above it, runs
   * this budget's own `onLimitReached` function (when it is one) with the refusing budget's {@link SpendLimitInfo},
   * after the refusing budget's own, before the error goes on. A parent chain that holds a budget on the same `guard`
   * and `budgetId` as this one is refused: the two would keep one total and charge every call to it twice.
   */
  parent?: SpendBudget;
  /**
   * A persisted allowance this budget holds its calls in, beside its in-memory caps. {@link SpendBudget.assertCanSpend}
   * given a {@link SpendBudgetCall} reserves the call's largest cost (`estimateMaxCallCostUSD`) in micro-dollars, behind
   * a fence, and {@link SpendBudget.record} given a {@link SpendBudgetSettlement} settles it. A budget with a parent,
   * and a call held to two budgets, reserves in every meter above it: once for each meter and account, so one call
   * under one operation id cannot be held for two accounts on one meter, and is refused. The synchronous check holds
   * nothing, so on a budget with a meter it refuses the call: the generation helpers (`generateText()`, `streamText()`,
   * `generateObject()`, `embedText()`, `agent()`, `gmi()`) make that check and do not reserve. Needs `accountId`.
   */
  meter?: ISpendMeter;
  /** The account a `meter` holds this budget's calls under. Without a meter it is kept here for a host to read. */
  accountId?: string;
}

/** A provider call a budget checks, and reserves for on a budget with a meter, before it is sent. */
export interface SpendBudgetCall {
  /** The provider the call goes to. */
  providerId: string;
  /** The model the call names. */
  modelId: string;
  /** What the call sends, which bounds what it can cost ({@link estimateMaxCallCostUSD}). */
  request: MaxCostRequest;
  /**
   * The host's durable id for the call, which {@link SpendBudgetSettlement.operationId} names again after it. One id
   * holds one reservation: a second call under it while it is held, or after it counted, is refused.
   */
  operationId: string;
}

/** The reservation a finished call settles. */
export interface SpendBudgetSettlement {
  /** The id the call was reserved under. */
  operationId: string;
  /**
   * `'consumed'` (the default) takes what the call cost and frees the rest; a call whose cost is not known takes its
   * whole reservation. `'released'` frees it all, for a call that failed before any output and was billed nothing.
   */
  outcome?: 'consumed' | 'released';
}

/** Refused because the model has no price row, or the request's cost has no bound, so the call's cost could not be counted. */
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
 * Exported for the launch's one-call floor (agencyLaunch), which counts a call as a check does.
 */
export function outputEstimateTokens(modelId: string, maxOutputTokens: number | undefined): number {
  // A cap of NaN (what `Number(undefined)` gives) limits nothing: OpenAI is sent it as null. An estimate made with it
  // would be NaN, which every check lets through, since every comparison with NaN is false.
  const cap = clampMaxOutputTokens(modelId, maxOutputTokens);
  return cap === undefined || Number.isNaN(cap) ? DEFAULT_OUTPUT_ESTIMATE_TOKENS : cap;
}

/**
 * The info of the budget that refused, by the error it threw and the check it was thrown in, so a child learns of an
 * ancestor's refusal. An error object a limit function throws again in a later check (one shared error) names that
 * check's refusal.
 */
const refusalInfo = new WeakMap<object, { info: SpendLimitInfo; run: number }>();
/**
 * The refusal a thrown value that is not an object names (an `onLimitReached` function may throw a string), which the
 * WeakMap cannot hold: a check runs synchronously, so the value thrown in the check in progress is the one the
 * budgets below meet. Cleared when the next outermost check begins.
 */
let primitiveRefusal: { error: unknown; info: SpendLimitInfo } | undefined;
/** How deep the checks in progress go: a check asks its parent's, and a two-budget check asks both. */
let checkDepth = 0;
/** The outermost checks begun so far: the run a refusal was named in. */
let checkRun = 0;

/** Names `info` as the refusal `error` carries, unless the error already names one: the first budget to refuse names it. */
function markRefusal(error: unknown, info: SpendLimitInfo): void {
  if (typeof error === 'object' && error !== null) {
    const held = refusalInfo.get(error);
    if (!held || held.run !== checkRun) refusalInfo.set(error, { info, run: checkRun });
  } else if (!primitiveRefusal || !Object.is(primitiveRefusal.error, error)) {
    primitiveRefusal = { error, info };
  }
}

/** The refusal `error` names in the check in progress, an object's or a primitive's. */
function refusalOf(error: unknown): SpendLimitInfo | undefined {
  if (typeof error === 'object' && error !== null) {
    const held = refusalInfo.get(error);
    return held && held.run === checkRun ? held.info : undefined;
  }
  return primitiveRefusal && Object.is(primitiveRefusal.error, error) ? primitiveRefusal.info : undefined;
}

/** Runs `work` as one check, or as part of the one in progress: the outermost begins a run, which names refusals afresh. */
function withinCheck(work: () => void): void {
  if (checkDepth === 0) {
    primitiveRefusal = undefined;
    checkRun += 1;
  }
  checkDepth += 1;
  try {
    work();
  } finally {
    checkDepth -= 1;
  }
}

/**
 * Runs `on` with `info`. A function that throws refuses the call with its own error, which then names `info` as its
 * refusal, so the budgets below still hear of it.
 */
function runLimitFunction(on: (info: SpendLimitInfo) => void, info: SpendLimitInfo): void {
  try {
    on(info);
  } catch (error) {
    markRefusal(error, info);
    throw error;
  }
}

/** Runs `budget`'s own `onLimitReached` function, when it is one, with the info of the budget that refused with `error`. */
function hearRefusal(budget: SpendBudget, error: unknown): void {
  const info = refusalOf(error);
  const on = budget.options.onLimitReached;
  if (info && typeof on === 'function') runLimitFunction(on, info);
}

let budgets = 0;

/** What a budget with a meter reads while a reservation's check is in progress. */
interface ReservationCheck {
  /** The meter refusal this check is to report: every budget that names that meter and account hears of it. */
  denial?: MeterHold & { reason: SpendDenyReason };
  /** The call's model has a price row, and the request is what has no bound. */
  unbounded: boolean;
}

/**
 * The check of a reservation in progress ({@link reserveCall}), which runs synchronously; unset outside one. A budget
 * with a meter refuses a check made without one, since that check holds nothing in the meter.
 */
let reservationCheck: ReservationCheck | undefined;

/** The reason a budget with a meter gives a check that holds nothing in it. */
const CHECK_HOLDS_NOTHING = 'a call on a budget with a meter is checked with assertCanSpend(what, call), which reserves it in the meter';

/** What the check, or the record, of a call held to two budgets ({@link bothBudgets}) has reached so far. */
interface Reach {
  /** The budgets reached: a budget both draw on is checked, and charged, once. */
  budgets: Set<SpendBudget>;
  /**
   * The spending totals the record has charged, by guard and id: budgets on one guard and one id keep one total, which
   * one call is charged once, while each of those budgets still counts the call's tokens.
   */
  totals: Map<CostGuard, Set<string>>;
}

/** The two-budget check and record in progress; unset outside one, each of which runs synchronously. */
const reaching: { check?: Reach; charge?: Reach } = {};

/** Whether the two-budget check or record in progress has reached `budget` already; marks it reached. */
function reachedBefore(kind: 'check' | 'charge', budget: SpendBudget): boolean {
  const reach = reaching[kind];
  if (!reach) return false;
  if (reach.budgets.has(budget)) return true;
  reach.budgets.add(budget);
  return false;
}

/** Whether the two-budget record in progress has charged the total `guard` keeps under `id` already; marks it charged. */
function totalChargedBefore(guard: CostGuard, id: string): boolean {
  const reach = reaching.charge;
  if (!reach) return false;
  const ids = reach.totals.get(guard) ?? new Set<string>();
  if (ids.has(id)) return true;
  reach.totals.set(guard, ids.add(id));
  return false;
}

/** Runs `work` as one two-budget check or record, or as part of the one in progress. */
function reachOnce(kind: 'check' | 'charge', work: () => void): void {
  const outer = reaching[kind];
  reaching[kind] = outer ?? { budgets: new Set(), totals: new Map() };
  try {
    work();
  } finally {
    reaching[kind] = outer;
  }
}

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
   *   `maxCostUSD` may be `Number.POSITIVE_INFINITY` (a budget with no dollar cap). Also when a `meter` has no
   *   `accountId` to hold the calls under, and when a budget in the `parent` chain keeps its spending on the given
   *   `guard` under the same id; the guard is left as it was.
   */
  constructor(options: SpendBudgetOptions) {
    if (!(options.maxCostUSD >= 0)) throw new RangeError('maxCostUSD must be zero or more');
    // A token cap of NaN (what `Number(undefined)` gives) would never refuse a call, since every comparison with NaN
    // is false.
    if (options.maxTotalTokens !== undefined && !(options.maxTotalTokens >= 0)) {
      throw new RangeError('maxTotalTokens must be zero or more');
    }
    if (options.meter && !options.accountId) throw new RangeError('A spend budget with a meter needs an accountId');
    this.options = options;
    this.id = options.budgetId ?? `budget-${Date.now()}-${++budgets}`;
    if (options.guard) {
      // One guard and one id keep one total: a budget above this one that keeps it too would be charged every call twice
      // (once by each budget), and this budget would replace the cap that budget holds for the id.
      for (let above = options.parent; above; above = above.options.parent) {
        if (above.guard === options.guard && above.id === this.id) {
          throw new RangeError(`A spend budget cannot draw on a budget that keeps its spending on the same guard under the same id ('${this.id}')`);
        }
      }
    }
    this.guard =
      options.guard ??
      new CostGuard({
        maxSessionCostUsd: options.maxCostUSD,
        maxDailyCostUsd: Number.POSITIVE_INFINITY,
        maxSingleOperationCostUsd: Number.POSITIVE_INFINITY,
      });
    if (options.guard) {
      // setAgentLimits replaces what the guard holds for an id, so the id's daily cap (one set for it, or the guard's
      // own) goes back in with the session cap: making a budget lifts no cap the guard already holds.
      options.guard.setAgentLimits(this.id, {
        maxSessionCostUsd: options.maxCostUSD,
        maxDailyCostUsd: options.guard.getSnapshot(this.id).dailyLimit,
      });
    }
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
   * What is left under this budget's own caps (a parent's are not counted): the dollars under `maxCostUSD` (Infinity
   * for a budget with no dollar cap) and, when `maxTotalTokens` is set, the tokens under it. Never below zero: a record
   * is never refused, so a run can pass a cap by its last call.
   */
  remaining(): { usd: number; tokens?: number } {
    const usd = Math.max(0, this.options.maxCostUSD - this.spentUSD());
    const max = this.options.maxTotalTokens;
    return max === undefined ? { usd } : { usd, tokens: Math.max(0, max - this.tokens) };
  }

  /**
   * Refuses (or warns about) a call that could cost up to `estimateUSD` and use up to `estimateTokens`, when it would
   * pass what is left; `estimateUSD` undefined means the model has no price row, which `unpriced: 'allow'` checks as
   * a call that costs nothing. `model`, the call's provider and model, is named in the refusal of a model with no
   * price row. A budget with a `parent` has the parent check the call first, with the same estimate, so the refusal
   * thrown can be the parent's, or that of a budget above it.
   *
   * @throws {CostCapExceededError} At a cap. Its `capType`, `currentCost` and `limit` are those of the cap that refused
   *   the call: the id's total for the session or the day and that cap, or, at the guard's single-operation cap, the
   *   call's estimate and that cap. The token cap has no cap type of its own, so its refusal carries `session`, the
   *   run's dollars and `maxCostUSD`, and a message that names the token cap and the token counts.
   * @throws {UnpricedModelError} For a model with no price row, unless the budget allows one.
   */
  assertCanSpend(
    estimateUSD: number | undefined,
    estimateTokens: number,
    what: string,
    model?: { providerId: string; modelId: string },
  ): void;
  /**
   * Checks a call by what it sends, at its largest cost, and holds that cost in the budget's meter under its operation
   * id: the budget's own caps first, then the meter of every budget it draws on and its own. The promise resolves once
   * the call is held, and the call is sent only then. A meter's refusal runs `onLimitReached` with
   * `capType: 'usd'` and the meter's word as the `reason`. Under `'warn'` the call runs with nothing held for that
   * meter. {@link SpendBudget.record} with the same operation id settles it. Without a meter it is the check alone, at
   * the call's largest cost.
   *
   * @throws {CostCapExceededError} At a cap, or when a meter refuses; its message names the meter's word.
   * @throws {UnpricedModelError} For a model with no price row or a request whose cost has no bound
   *   ({@link estimateMaxCallCostUSD}): a budget with a meter refuses either whatever `unpriced` says.
   * @throws {SpendMeterUnavailableError} When a meter's store cannot answer: no call runs.
   */
  assertCanSpend(what: string, call: SpendBudgetCall): Promise<void>;
  assertCanSpend(
    first: number | undefined | string,
    second: number | SpendBudgetCall,
    what?: string,
    model?: { providerId: string; modelId: string },
  ): void | Promise<void> {
    if (typeof first === 'string') return reserveCall(this, first, second as SpendBudgetCall);
    this.assertWithinCaps(first, second as number, what as string, model);
  }

  /** The synchronous check of {@link SpendBudget.assertCanSpend}, which a call held to two budgets makes on both. */
  protected assertWithinCaps(estimateUSD: number | undefined, estimateTokens: number, what: string, model?: { providerId: string; modelId: string }): void {
    withinCheck(() => this.check(estimateUSD, estimateTokens, what, model));
  }

  /** {@link SpendBudget.assertCanSpend}'s rules, inside the count of the checks in progress. */
  private check(estimateUSD: number | undefined, estimateTokens: number, what: string, model?: { providerId: string; modelId: string }): void {
    // Under a call held to two budgets, a budget both draw on is asked once.
    if (reachedBefore('check', this)) return;
    const parent = this.options.parent;
    if (parent) {
      try {
        parent.assertCanSpend(estimateUSD, estimateTokens, what, model);
      } catch (error) {
        // An ancestor refused: this budget's own function hears of it, with that budget's info, before it goes on.
        hearRefusal(this, error);
        throw error;
      }
    }
    const metered = this.options.meter !== undefined;
    if (metered) {
      const denial = reservationCheck?.denial;
      const refusal = !reservationCheck ? CHECK_HOLDS_NOTHING : denial?.meter === this.options.meter && denial?.accountId === this.options.accountId ? denial?.reason : undefined;
      if (refusal !== undefined) {
        this.refuse({ budgetId: this.id, capType: 'usd', what, reason: refusal }, () => {
          // As for the token cap: the guard's cap types and dollar figures do not name a meter, so the message does.
          const error = new CostCapExceededError(this.id, 'session', this.spentUSD(), this.options.maxCostUSD);
          error.message = `Spend meter refused a call for budget '${this.id}': ${refusal}`;
          throw error;
        });
        return;
      }
    }
    if (estimateUSD === undefined && (this.options.unpriced !== 'allow' || metered)) {
      const named = model ? `${model.providerId}:${model.modelId}` : 'the model';
      const unbounded = reservationCheck?.unbounded === true;
      const reason = unbounded ? `what a request to ${named} can cost cannot be bounded` : `${named} has no price row`;
      this.refuse({ budgetId: this.id, capType: 'unpriced', what, reason }, () => {
        const error = new UnpricedModelError(model?.providerId ?? 'unknown', model?.modelId ?? what);
        if (unbounded) error.message = `${reason}, so a call to it cannot be counted against the budget`;
        throw error;
      });
      return;
    }
    const max = this.options.maxTotalTokens;
    if (max !== undefined && this.tokens + estimateTokens > max) {
      const reason = `${this.tokens + estimateTokens} tokens would pass ${max}`;
      this.refuse({ budgetId: this.id, capType: 'tokens', what, reason }, () => {
        // CostCapExceededError's cap types are the guard's and its numbers are dollars, so the token cap's refusal says
        // which cap it was in its message.
        const error = new CostCapExceededError(this.id, 'session', this.spentUSD(), this.options.maxCostUSD);
        error.message = `Token cap exceeded for budget '${this.id}': ${reason}`;
        throw error;
      });
      return;
    }
    // A call allowed without a price row is checked as costing nothing, so a budget already past its cap (through a
    // cost a provider reported, or one recorded from outside) still stops it.
    const verdict = this.guard.canAfford(this.id, estimateUSD ?? 0);
    if (verdict.allowed) return;
    const capType = verdict.capType ?? 'session';
    this.refuse({ budgetId: this.id, capType, what, reason: verdict.reason ?? 'the budget is spent' }, () => {
      // The numbers of the cap that refused the call: the day's total and its limit for the daily cap, the call's
      // estimate and the limit for the single-operation cap, the run's own for the session cap.
      throw new CostCapExceededError(
        this.id,
        capType,
        verdict.currentCostUsd ?? this.spentUSD(),
        verdict.limitUsd ?? this.options.maxCostUSD,
      );
    });
  }

  /**
   * Records a finished call: its cost (undefined for a model with no price row, counted as nothing) and its tokens. A
   * token count the provider reported as `NaN` counts as none: added, it would make the count NaN, and a count of NaN
   * never reaches `maxTotalTokens`, since every comparison with NaN is false. A budget with a `parent` records the call
   * there too, after itself.
   */
  record(costUSD: number | undefined, tokens: number, what: string): void;
  /**
   * Records a finished call as above, at once, and settles the reservation {@link SpendBudget.assertCanSpend} made for
   * it in every meter that holds it: at `costUSD` in micro-dollars, the meter holding that to the reservation and freeing
   * the rest, at the whole reservation when the cost is not known, or freed whole when `outcome` is `'released'`.
   *
   * @throws {SpendMeterUnavailableError} When a meter's store cannot answer. The cost is already charged to the budget's
   *   caps, and the reservation stays held, behind its fence, until a later settle or a reconcile with `resolveExpired`.
   *   An error the charge throws (a guard's `onCapReached` function) rejects the promise too, after the settle.
   */
  record(costUSD: number | undefined, tokens: number, what: string, settlement: SpendBudgetSettlement): Promise<void>;
  record(costUSD: number | undefined, tokens: number, what: string, settlement?: SpendBudgetSettlement): void | Promise<void> {
    if (settlement) return this.chargeAndSettle(costUSD, tokens, what, settlement);
    this.charge(costUSD, tokens, what);
  }

  /** The charge, at once, and the settle whatever the charge does: a guard's `onCapReached` function can throw. */
  private async chargeAndSettle(costUSD: number | undefined, tokens: number, what: string, settlement: SpendBudgetSettlement): Promise<void> {
    try {
      this.charge(costUSD, tokens, what);
    } finally {
      await settleCall(this, costUSD, settlement);
    }
  }

  /** The synchronous part of {@link SpendBudget.record}, which a call held to two budgets makes on both. */
  protected charge(costUSD: number | undefined, tokens: number, what: string): void {
    // Under a call held to two budgets, a budget both draw on is charged once, and so is a total that budgets on one
    // guard and one id keep.
    if (reachedBefore('charge', this)) return;
    const counted = Math.max(0, tokens);
    this.tokens += Number.isNaN(counted) ? 0 : counted;
    if (costUSD !== undefined && costUSD > 0 && !totalChargedBefore(this.guard, this.id)) {
      this.guard.recordCost(this.id, costUSD, undefined, { what });
    }
    this.options.parent?.record(costUSD, tokens, what);
  }

  /**
   * Records a cost made outside AgentOS, such as speech-to-text minutes billed by the minute. A cost of zero or below
   * records nothing. A budget with a `parent` records the cost there too, after itself.
   *
   * @throws {RangeError} When `costUSD` is not a number, `NaN` included: a cost that could not be counted would let
   *   the run spend past its cap.
   */
  recordExternal(costUSD: number, kind: string): void {
    if (typeof costUSD !== 'number' || Number.isNaN(costUSD)) {
      throw new RangeError(`An outside cost must be a number of US dollars, not ${String(costUSD)}`);
    }
    if (reachedBefore('charge', this)) return;
    if (costUSD > 0 && !totalChargedBefore(this.guard, this.id)) this.guard.recordCost(this.id, costUSD, undefined, { what: `external.${kind}` });
    this.options.parent?.recordExternal(costUSD, kind);
  }

  private refuse(info: SpendLimitInfo, thrower: () => never): void {
    const on = this.options.onLimitReached ?? 'throw';
    if (on === 'warn') {
      console.warn(`[agentos] spend budget ${info.budgetId}: ${info.what} would pass the budget (${info.reason}); running it`);
      return;
    }
    if (typeof on === 'function') runLimitFunction(on, info);
    try {
      thrower();
    } catch (error) {
      // The first budget to refuse names the refusal; the budgets below it read it (assertCanSpend).
      markRefusal(error, info);
      throw error;
    }
  }
}

/**
 * A budget that holds each call to two budgets: a call is checked against the first, then the second, and refused when
 * either refuses it, a refusal by the second (or a budget above it) running the first's own `onLimitReached` function as
 * a refusal by the first's parent does; a finished call or an outside cost is recorded in both. A budget both draw on is checked and
 * charged once, and so is the one total that budgets on one guard and one id keep, each of them still counting the
 * call's tokens. What is left is the lesser of what each has left under its own caps; what it has spent, and the tokens
 * it has counted, are the first's.
 */
class BothBudgets extends SpendBudget {
  constructor(
    readonly first: SpendBudget,
    readonly second: SpendBudget,
  ) {
    // No cap of its own: every check and record goes to the two budgets.
    super({ maxCostUSD: Number.POSITIVE_INFINITY, unpriced: 'allow', budgetId: first.id });
  }

  override spentUSD(): number {
    return this.first.spentUSD();
  }

  override tokensUsed(): number {
    return this.first.tokensUsed();
  }

  override remaining(): { usd: number; tokens?: number } {
    const a = this.first.remaining();
    const b = this.second.remaining();
    const usd = Math.min(a.usd, b.usd);
    if (a.tokens === undefined) return b.tokens === undefined ? { usd } : { usd, tokens: b.tokens };
    return { usd, tokens: b.tokens === undefined ? a.tokens : Math.min(a.tokens, b.tokens) };
  }

  protected override assertWithinCaps(estimateUSD: number | undefined, estimateTokens: number, what: string, model?: { providerId: string; modelId: string }): void {
    // One check over both budgets: a refusal by the second is named in the run the first then hears of it in.
    withinCheck(() => reachOnce('check', () => {
      this.first.assertCanSpend(estimateUSD, estimateTokens, what, model);
      try {
        this.second.assertCanSpend(estimateUSD, estimateTokens, what, model);
      } catch (error) {
        // The first draws on the second as on a parent: its own function hears of the second's refusal before it goes on.
        hearRefusal(this.first, error);
        throw error;
      }
    }));
  }

  protected override charge(costUSD: number | undefined, tokens: number, what: string): void {
    reachOnce('charge', () => {
      this.first.record(costUSD, tokens, what);
      this.second.record(costUSD, tokens, what);
    });
  }

  override recordExternal(costUSD: number, kind: string): void {
    reachOnce('charge', () => {
      this.first.recordExternal(costUSD, kind);
      this.second.recordExternal(costUSD, kind);
    });
  }
}

/** A meter that holds a budget's calls, and the account it holds them under. */
interface MeterHold {
  meter: ISpendMeter;
  accountId: string;
}

/**
 * The meters a call on `budget` is held in, those above it first, as a check asks a parent first: one hold for each
 * meter and account, however many budgets in the chain name that pair.
 */
function meterHoldsOf(budget: SpendBudget): MeterHold[] {
  const holds: MeterHold[] = [];
  const visit = (at: SpendBudget): void => {
    if (at instanceof BothBudgets) {
      visit(at.first);
      visit(at.second);
      return;
    }
    const { parent, meter, accountId } = at.options;
    if (parent) visit(parent);
    if (meter && accountId && !holds.some((hold) => hold.meter === meter && hold.accountId === accountId)) {
      holds.push({ meter, accountId });
    }
  };
  visit(budget);
  return holds;
}

/**
 * Frees what a call holds in `holds`, on the way to refusing it. A meter that cannot answer keeps its reservation,
 * counted, until a later settle or reconcile: the refusal goes on, with a warning line.
 */
async function releaseHolds(holds: MeterHold[], operationId: string): Promise<void> {
  const released = await Promise.allSettled(holds.map((hold) => hold.meter.settle({ operationId, outcome: 'released' })));
  if (released.some((result) => result.status === 'rejected')) {
    console.warn('[agentos] spend budget: a refused call\'s reservation could not be freed; it stays held until a later settle or reconcile');
  }
}

/**
 * {@link SpendBudget.assertCanSpend} for a named call. The budgets' own caps are checked at the call's largest cost, in
 * one synchronous check, then each meter is asked in turn. On a meter's refusal the same check runs again carrying it,
 * so every budget that names that meter and account refuses as any budget refuses and the budgets below hear of it; when
 * that check refuses the call, what the earlier meters hold is freed.
 */
async function reserveCall(budget: SpendBudget, what: string, call: SpendBudgetCall): Promise<void> {
  const { providerId, modelId, request, operationId } = call;
  const max = estimateMaxCallCostUSD(providerId, modelId, request);
  const tokens = tokensOfChars(promptCharsOf(request.messages, request.system, request.tools)) + outputEstimateTokens(modelId, request.maxOutputTokens);
  const unbounded = max === undefined && modelPricing(providerId, modelId) !== undefined;
  const check = (denial?: ReservationCheck['denial']): void => {
    const outer = reservationCheck;
    reservationCheck = { denial, unbounded };
    try {
      budget.assertCanSpend(max, tokens, what, { providerId, modelId });
    } finally {
      reservationCheck = outer;
    }
  };
  check();
  // Only a budget set to warn, or one with no meter that allows the call, gets here with no bound: nothing to hold.
  if (max === undefined) return;
  // Rounded up, so the reservation stays at or above the bound; settling frees what it holds beyond the call's cost.
  const units = Math.ceil(max * 1_000_000);
  const held: MeterHold[] = [];
  for (const hold of meterHoldsOf(budget)) {
    let answer: SpendReserveResult;
    try {
      answer = await hold.meter.reserve({ accountId: hold.accountId, operationId, units, requireFence: true });
    } catch (error) {
      await releaseHolds(held, operationId);
      throw error;
    }
    if (answer.status === 'reserved') {
      held.push(hold);
      continue;
    }
    try {
      check({ ...hold, reason: answer.reason });
    } catch (error) {
      await releaseHolds(held, operationId);
      throw error;
    }
    // Every budget that names this meter is set to warn: the call runs, and what the other meters hold stays for its settle.
  }
}

/**
 * {@link SpendBudget.record}'s settle. A cost that is not a finite number, zero or more, is left out, which a meter
 * takes as the whole reservation. Every meter is told, whichever of them fails; the first failure then goes on.
 */
async function settleCall(budget: SpendBudget, costUSD: number | undefined, settlement: SpendBudgetSettlement): Promise<void> {
  const { operationId, outcome = 'consumed' } = settlement;
  const units = outcome === 'consumed' && typeof costUSD === 'number' && Number.isFinite(costUSD) && costUSD >= 0 ? toMicro(costUSD) : undefined;
  const settled = await Promise.allSettled(
    meterHoldsOf(budget).map((hold) => hold.meter.settle({ operationId, outcome, ...(units === undefined ? {} : { units }) })),
  );
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * A budget that holds each call to `first` and to `second`: checked against both (`first`'s own `onLimitReached`
 * function hearing of a refusal by `second`, as of one by its parent), recorded in both, a budget both draw on checked
 * and charged once, and a total that budgets on one guard and one id keep charged once. `first` itself when
 * the two are one budget. A seat's turn runs under one: the budget its team's call carries, and the member's own
 * (gmi.ts).
 *
 * @internal
 */
export function bothBudgets(first: SpendBudget, second: SpendBudget): SpendBudget {
  return first === second ? first : new BothBudgets(first, second);
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

/** USD per 1K tokens from per million, at twelve significant digits, so a table's per-1K rate reads back as listed. */
function perThousand(perMillion: number): number {
  return Number((perMillion / 1000).toPrecision(12));
}

/**
 * An estimate of the most a call could cost: its prompt's assumed tokens at the input rate and its output cap at the
 * output rate ({@link DEFAULT_OUTPUT_ESTIMATE_TOKENS} when it names none, or a cap of NaN), a cap above the model's
 * known output ceiling counted at the ceiling. The rates are the model's row's, and the long-context card's once the
 * prompt's assumed tokens pass its threshold: OpenAI bills a prompt of more than 272,000 tokens on its models with a
 * 1,050,000-token context window at twice the input rate and one and a half times the output rate, and Claude Haiku
 * 5.5 one of more than 100,000 at five times both, on the whole call. A prompt that four characters a token
 * undercounts (CJK text, emoji, base64) can pass the threshold below it, so such a call can cost more than its
 * estimate. Undefined when the provider's model has no price row: the rows are OpenAI's and Anthropic's tables and a
 * table the host registered for the provider ({@link modelPricing}). A bound that holds for any prompt, and every rate
 * a request can reach, is `estimateMaxCallCostUSD`'s (modelPricing.ts).
 */
export function estimateCallCostUSD(providerId: string, modelId: string, promptChars: number, maxOutputTokens: number | undefined): number | undefined {
  const price = modelPricing(providerId, modelId);
  if (!price) return undefined;
  const prompt = tokensOfChars(promptChars);
  const card: ModelPriceTier = price.longContext && prompt > price.longContext.thresholdTokens ? price.longContext : price;
  const output = outputEstimateTokens(modelId, maxOutputTokens);
  return (prompt / 1000) * perThousand(card.inputPerMTokUSD) + (output / 1000) * perThousand(card.outputPerMTokUSD);
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
    tokensOfChars(promptChars) + outputEstimateTokens(route.modelId, maxOutputTokens),
    what,
    { providerId: route.providerId, modelId: route.modelId },
  );
}

/**
 * The token counts of a finished call {@link costOfUsageUSD} prices: a provider's `ModelUsage` or a run's totals
 * (`TokenUsage`), which carry the cache counts as `cacheReadInputTokens`, `cacheCreationInputTokens` and
 * `cacheCreationExtendedInputTokens`, and as `cacheReadTokens`, `cacheCreationTokens` and
 * `cacheCreationExtendedTokens`, respectively.
 */
export interface UsageForCost {
  promptTokens?: number;
  completionTokens?: number;
  costUSD?: number;
  /** Every input token, cache reads and writes included: Anthropic's `input_tokens` leave them out, OpenAI's prompt tokens hold them. */
  inclusiveInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Of the cache writes, those made with the provider's longer lifetime: Anthropic's 1-hour writes
   * (`usage.cache_creation.ephemeral_1h_input_tokens`), OpenAI's 12-hour writes
   * (`cache_write_tokens_details.ttl_12h_tokens`).
   */
  cacheCreationExtendedInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** {@link UsageForCost.cacheCreationExtendedInputTokens} under the name a run's totals carry it. */
  cacheCreationExtendedTokens?: number;
}

/** A token count a report gave, or 0 for none, a negative count or one that is not a finite number. */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Providers built on the OpenAI provider (Groq, LiteLLM, Mistral, Together and xAI send through it, MiniMax extends
 * it), which reports OpenAI's list price for a model id OpenAI's table holds (`openaiPricing.ts`): a cost the client
 * computed, not one the gateway or the vendor billed.
 */
const OPENAI_CLIENT_PRICED = new Set(['groq', 'litellm', 'mistral', 'together', 'xai', 'minimax']);

/**
 * A finished call's cost: the provider's own `costUSD` when it reported one, else its tokens at the table's rates
 * ({@link modelPricing}: OpenAI's and Anthropic's tables and a table the host registered); undefined when neither is
 * known. A reported cost that is not a finite number, zero or more, is not used: a budget would record nothing for a
 * cost of NaN. For a provider built on the OpenAI provider (Groq, LiteLLM, Mistral, Together, xAI, MiniMax), a row
 * the host registered prices the call before the cost it reports, which is OpenAI's list price for the
 * model id: the call is charged at the rate it was estimated at. A bill the provider's API returned (OpenRouter's and
 * Requesty's `usage.cost`) stands.
 *
 * The prompt is `inclusiveInputTokens` where the report gives it (never fewer than `promptTokens`; for Anthropic, whose
 * prompt tokens leave the cache out, the prompt tokens and the cache counts where it does not), so the cache reads and
 * writes an Anthropic report keeps out of its prompt tokens are priced, and they count toward the long-context
 * threshold; the long-context card prices the whole call where the prompt is over it. Of the prompt, the cache reads are
 * priced at the card's cache-read rate (the input rate where the card has none); the writes the report names as made
 * with the longer lifetime (`cacheCreationExtendedInputTokens`: Anthropic's `cache_creation.ephemeral_1h_input_tokens`,
 * OpenAI's `cache_write_tokens_details.ttl_12h_tokens`) at the card's highest write rate (`cacheWritePerMTokUSD`:
 * Anthropic's 1-hour write at 2x input, OpenAI's 12-hour write at 2.5x); every other write at the rate of a write with
 * the provider's default lifetime (`defaultCacheWritePerMTokUSD`: Anthropic's 5-minute write and OpenAI's 30-minute
 * write, both 1.25x input), the rate each provider bills a write at when the request names no lifetime. A report that
 * does not split its writes by lifetime is thus priced as if every write had the default lifetime; a host row that
 * names a single write rate (`cacheWritePerMTokUSD` alone) prices every write at that rate. The rest of the prompt is
 * priced at the input rate. An embedding prices its prompt tokens alone, at the standard card.
 */
export function costOfUsageUSD(
  providerId: string,
  modelId: string,
  usage: UsageForCost | undefined,
  isEmbedding = false,
): number | undefined {
  const hostRow = OPENAI_CLIENT_PRICED.has(providerId) ? modelPricing(providerId, modelId) : undefined;
  const reported = usage?.costUSD;
  if (!hostRow && typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return reported;
  const price = hostRow ?? modelPricing(providerId, modelId);
  if (!price || usage === undefined) return undefined;
  const prompt = usage.promptTokens ?? 0;
  if (isEmbedding) return (prompt / 1000) * perThousand(price.inputPerMTokUSD);
  const cacheRead = tokenCount(usage.cacheReadInputTokens ?? usage.cacheReadTokens);
  const cacheWrite = tokenCount(usage.cacheCreationInputTokens ?? usage.cacheCreationTokens);
  const cacheWriteExtended = tokenCount(usage.cacheCreationExtendedInputTokens ?? usage.cacheCreationExtendedTokens);
  // Anthropic's prompt tokens leave the cache out, so a report of its with no inclusive total is completed with them.
  const inclusive = Math.max(
    prompt,
    usage.inclusiveInputTokens === undefined && providerId === 'anthropic' ? prompt + cacheRead + cacheWrite : tokenCount(usage.inclusiveInputTokens),
  );
  const read = Math.min(cacheRead, inclusive);
  const write = Math.min(cacheWrite, inclusive - read);
  const writeExtended = Math.min(cacheWriteExtended, write);
  const writeDefault = write - writeExtended;
  const card: ModelPriceTier = price.longContext && inclusive > price.longContext.thresholdTokens ? price.longContext : price;
  const readRate = card.cacheReadPerMTokUSD ?? card.inputPerMTokUSD;
  const extendedWriteRate = Math.max(card.inputPerMTokUSD, card.cacheWritePerMTokUSD ?? 0, card.automaticCacheWritePerMTokUSD ?? 0);
  // A card that names no default-lifetime rate (a host row with one write rate) prices every write at the one it has.
  const defaultWriteRate = Math.max(
    card.inputPerMTokUSD,
    card.defaultCacheWritePerMTokUSD ?? card.automaticCacheWritePerMTokUSD ?? card.cacheWritePerMTokUSD ?? 0,
  );
  return (
    ((inclusive - read - write) / 1000) * perThousand(card.inputPerMTokUSD) +
    (read > 0 ? (read / 1000) * perThousand(readRate) : 0) +
    (writeDefault > 0 ? (writeDefault / 1000) * perThousand(defaultWriteRate) : 0) +
    (writeExtended > 0 ? (writeExtended / 1000) * perThousand(extendedWriteRate) : 0) +
    ((usage.completionTokens ?? 0) / 1000) * perThousand(card.outputPerMTokUSD)
  );
}
