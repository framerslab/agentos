/**
 * @fileoverview AdaptPersonalityTool: the ITool implementation that enables agents
 * to mutate their own HEXACO personality traits at runtime with per-session
 * budget enforcement.
 *
 * @module @framers/agentos/emergent/AdaptPersonalityTool
 *
 * Agents call `adapt_personality` to shift a specific trait dimension (e.g.
 * openness, conscientiousness) by a bounded delta. The tool enforces:
 * - Only valid HEXACO trait names are accepted.
 * - Reasoning must be provided for every mutation (audit trail).
 * - Per-session budgets cap the total absolute delta per trait.
 * - Values are always clamped to the [0, 1] range.
 *
 * All mutations are recorded in the injected {@link PersonalityMutationStore}
 * for durability and downstream analysis.
 *
 * The tool refuses before it changes anything under `AGENTOS_LEARNING_FREEZE=1`
 * (`frozen`), and on a host with a learning layer (the call's
 * `sessionData.learning`) on a turn in mode `frozen` or `off` or with no learner
 * (`frozen`, `off`, `no_learner`). Every host refuses `honesty` and
 * `emotionality` (`operator_only`). With a layer it also refuses a step above
 * {@link MAX_STEP_WITH_LEARNING} (`step_bound`) and a call after the session's
 * {@link MAX_CALLS_PER_SESSION_WITH_LEARNING} accepted ones (`call_limit`).
 */

import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';
import type { RecordMutationInput } from './PersonalityMutationStore.js';
import { OPERATOR_ONLY_TRAITS } from '../substrate/personas/personalityPrompt.js';
import { resolveSelfImprovementSessionKey } from './sessionScope.js';
import { readToolLearningContext, refusedSelfChange, selfChangeRefusal } from '../learning/toolContext.js';

// ============================================================================
// VALID TRAITS
// ============================================================================

/**
 * The six valid HEXACO trait names. Only traits outside OPERATOR_ONLY_TRAITS may be self-modified.
 *
 * Each trait is a continuous value in the range [0, 1]:
 * - `openness`: curiosity, creativity, willingness to explore
 * - `conscientiousness`: discipline, thoroughness, reliability
 * - `emotionality`: emotional reactivity, empathy, anxiety
 * - `extraversion`: sociability, energy, assertiveness
 * - `agreeableness`: patience, tolerance, cooperation
 * - `honesty`: sincerity, fairness, modesty
 */
export const VALID_TRAITS = [
  'openness',
  'conscientiousness',
  'emotionality',
  'extraversion',
  'agreeableness',
  'honesty',
] as const;

/** Union type of valid HEXACO trait names. */
export type HEXACOTrait = (typeof VALID_TRAITS)[number];

/** On a host with a learning layer: the largest step one call may take. A larger delta is refused, not clamped. */
export const MAX_STEP_WITH_LEARNING = 0.02;

/**
 * On a host with a learning layer: how many calls of one session the tool accepts, counted per learner of the session
 * (its organization, persona and user), so two tenants or two users that share a session id count apart.
 */
export const MAX_CALLS_PER_SESSION_WITH_LEARNING = 3;

/** A non-blank string, trimmed; anything else reads as `''`. */
function plainId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The key a call's accepted count is kept under on a host with a learning layer: the turn's organization, persona and
 * user beside its session, each part encoded so no two of them run together.
 */
function callCountKey(context: ToolExecutionContext): string {
  const organizationId = plainId(context.sessionData?.organizationId);
  const userId = plainId((context.userContext as { userId?: unknown } | undefined)?.userId);
  return [organizationId, plainId(context.personaId), userId, resolveSelfImprovementSessionKey(context)]
    .map(encodeURIComponent)
    .join('|');
}

/**
 * Why the tool refused a call before it changed anything: `frozen`, `off` and `no_learner` as every
 * self-modification tool refuses (`selfChangeRefusal`); on every host, `operator_only` (honesty or
 * emotionality); with a learning layer, `step_bound` (a delta above {@link MAX_STEP_WITH_LEARNING}) and `call_limit` (the session already
 * had {@link MAX_CALLS_PER_SESSION_WITH_LEARNING} calls accepted).
 */
export type AdaptPersonalityRefusal = 'frozen' | 'off' | 'no_learner' | 'operator_only' | 'step_bound' | 'call_limit';

// ============================================================================
// MUTATION STORE
// ============================================================================

/**
 * Durable store interface for recording personality mutations.
 * Implementations may write to SQLite, a JSON file, or in-memory arrays.
 */
export interface PersonalityMutationStore {
  /** Persist a single mutation record. */
  record(mutation: RecordMutationInput): Promise<string> | string;
  /**
   * Agent-scoped, idempotent strength aging (spec batch-1 C6). Optional:
   * older store implementations without it skip decay-on-adapt with a
   * warning; the concrete SQLite store implements it transactionally.
   */
  decayForAgent?(
    agentId: string,
    rate: number,
    cycleId: string,
  ): Promise<{ decayed: number; pruned: number; skipped?: boolean }>;
}

// ============================================================================
// INPUT TYPE
// ============================================================================

/**
 * Input arguments accepted by the `adapt_personality` tool.
 */
export interface AdaptPersonalityInput extends Record<string, any> {
  /** The HEXACO trait to modify. */
  trait: string;
  /** The signed delta to apply (positive = increase, negative = decrease). */
  delta: number;
  /** Free-text reasoning explaining why this adaptation is warranted. */
  reasoning: string;
}

// ============================================================================
// OUTPUT TYPE
// ============================================================================

/**
 * Result payload returned after a successful personality adaptation.
 */
export interface AdaptPersonalityOutput {
  /** The trait that was modified. */
  trait: string;
  /** Value before the mutation. */
  previousValue: number;
  /** Value after the mutation. */
  newValue: number;
  /** The actual delta applied. */
  delta: number;
  /** Whether the delta was clamped due to budget or range limits. */
  clamped: boolean;
  /** Total absolute delta applied to this trait in the current session. */
  sessionTotal: number;
  /** Remaining budget for this trait in the current session. */
  remainingBudget: number;
}

// ============================================================================
// CONSTRUCTOR DEPS
// ============================================================================

/**
 * Dependencies injected into the {@link AdaptPersonalityTool} constructor.
 */
export interface AdaptPersonalityDeps {
  /** Configuration controlling per-session budget limits. */
  config: {
    /** Maximum total |delta| that may be applied to any single trait per session. */
    maxDeltaPerSession: number;
    /**
     * When true, each adapt first ages this agent's STORED mutation
     * strengths for the current UTC-day cycle via
     * {@link PersonalityMutationStore.decayForAgent} ("decay-on-adapt",
     * spec batch-1 C6). Forwarded from
     * `SelfImprovementConfig.personality.persistWithDecay`.
     */
    persistWithDecay?: boolean;
    /** Strength subtracted per decay cycle. @default 0.05 */
    decayRate?: number;
  };
  /** Optional durable store for recording mutation history. */
  mutationStore?: PersonalityMutationStore;
  /**
   * Getter returning the calling agent's personality trait map
   * (trait → value in [0, 1]). Receives the tool's execution context so the
   * host can resolve the agent instance that made the call.
   */
  getPersonality: (context?: ToolExecutionContext) => Record<string, number>;
  /**
   * Setter to apply a new value for a specific trait on the calling agent.
   * Returning `false` means the host could not resolve the caller: the tool
   * then fails without spending budget or recording a mutation. Returning
   * nothing counts as applied.
   */
  setPersonality: (trait: string, value: number, context?: ToolExecutionContext) => boolean | void;
}

// ============================================================================
// TOOL IMPLEMENTATION
// ============================================================================

/**
 * ITool implementation enabling agents to self-modify their HEXACO personality
 * traits within per-session budgets.
 *
 * @example
 * ```ts
 * const tool = new AdaptPersonalityTool({
 *   config: { maxDeltaPerSession: 0.3 },
 *   mutationStore: myStore,
 *   getPersonality: () => agent.personality,
 *   setPersonality: (t, v) => { agent.personality[t] = v; },
 * });
 *
 * const result = await tool.execute(
 *   { trait: 'openness', delta: 0.1, reasoning: 'User prefers creative responses.' },
 *   context,
 * );
 * ```
 */
export class AdaptPersonalityTool
  implements ITool<AdaptPersonalityInput, AdaptPersonalityOutput>
{
  /** @inheritdoc */
  readonly id = 'com.framers.emergent.adapt-personality';

  /** @inheritdoc */
  readonly name = 'adapt_personality';

  /** @inheritdoc */
  readonly displayName = 'Adapt Personality';

  /** @inheritdoc */
  readonly description =
    'Adjust a HEXACO personality trait by a bounded delta. Requires reasoning ' +
    'for every mutation. Honesty and emotionality are set only by the persona definition. ' +
    'Per-session budgets prevent runaway drift.';

  /** @inheritdoc */
  readonly category = 'emergent';

  /** @inheritdoc */
  readonly hasSideEffects = true;

  /** @inheritdoc */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      trait: {
        type: 'string',
        enum: [...VALID_TRAITS],
        description: 'The HEXACO personality trait to modify.',
      },
      delta: {
        type: 'number',
        description:
          'Signed delta to apply (positive = increase, negative = decrease).',
      },
      reasoning: {
        type: 'string',
        description: 'Why this personality adaptation is warranted.',
      },
    },
    required: ['trait', 'delta', 'reasoning'],
  };

  /** Per-session accumulated |delta| per trait. */
  private readonly sessionDeltas: Map<string, Map<string, number>> = new Map();

  /**
   * Per-session count of the calls accepted on a host with a learning layer, keyed by the turn's organization, persona
   * and user beside its session. Kept in process memory for the life of the tool.
   */
  private readonly sessionCalls: Map<string, number> = new Map();

  /** Injected dependencies. */
  private readonly deps: AdaptPersonalityDeps;

  /**
   * Create a new AdaptPersonalityTool.
   *
   * @param deps - Injected dependencies including config, mutation store,
   *   and personality getter/setter.
   */
  constructor(deps: AdaptPersonalityDeps) {
    this.deps = deps;
  }

  // --------------------------------------------------------------------------
  // EXECUTE
  // --------------------------------------------------------------------------

  /**
   * Apply a personality trait mutation within session budget constraints.
   *
   * @param args - The trait, delta, and reasoning for the mutation.
   * @param context - Tool execution context.
   * @returns A {@link ToolExecutionResult} wrapping the mutation outcome.
   */
  async execute(
    args: AdaptPersonalityInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<AdaptPersonalityOutput>> {
    // The freeze, then the turn's mode, then its learner: refused before anything is read or changed.
    const refusal = selfChangeRefusal(context.sessionData);
    if (refusal) return refusedSelfChange(this.name, refusal);

    const { trait, delta, reasoning } = args;

    // 1. Validate trait name
    if (!VALID_TRAITS.includes(trait as HEXACOTrait)) {
      return {
        success: false,
        error: `Invalid trait "${trait}". Must be one of: ${VALID_TRAITS.join(', ')}`,
      };
    }

    // 2. Validate reasoning is non-empty
    if (!reasoning || typeof reasoning !== 'string' || reasoning.trim().length === 0) {
      return {
        success: false,
        error: 'reasoning is required and must be a non-empty string',
      };
    }

    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      return {
        success: false,
        error: 'delta is required and must be a finite number',
      };
    }

    // Operator-only traits stay authored on every host, before a budget, a read or a mutation.
    if (OPERATOR_ONLY_TRAITS.includes(trait as HEXACOTrait)) {
      return refusedSelfChange(this.name, 'operator_only', `only the persona definition sets ${trait}`);
    }

    // The learning layer retains its existing step and call limits.
    const learning = readToolLearningContext(context.sessionData);
    const countKey = callCountKey(context);
    if (learning) {
      if (Math.abs(delta) > MAX_STEP_WITH_LEARNING + 1e-9) {
        return refusedSelfChange(this.name, 'step_bound', `one call moves a trait by at most ${MAX_STEP_WITH_LEARNING}`);
      }
      if ((this.sessionCalls.get(countKey) ?? 0) >= MAX_CALLS_PER_SESSION_WITH_LEARNING) {
        return refusedSelfChange(this.name, 'call_limit', `a session accepts ${MAX_CALLS_PER_SESSION_WITH_LEARNING} calls`);
      }
    }

    // 3. Check session budget: track total |delta| per trait
    const { maxDeltaPerSession } = this.deps.config;
    const sessionDeltas = this.getSessionDeltas(context);
    const currentSessionTotal = sessionDeltas.get(trait) ?? 0;
    const remainingBudget = maxDeltaPerSession - currentSessionTotal;

    // 4. Clamp delta to remaining budget
    let effectiveDelta = delta;
    let clamped = false;

    if (Math.abs(effectiveDelta) > remainingBudget) {
      effectiveDelta = remainingBudget * Math.sign(effectiveDelta);
      clamped = true;
    }

    // If no budget remains, the effective delta is 0
    if (remainingBudget <= 0) {
      effectiveDelta = 0;
      clamped = true;
    }

    // 5. Get the caller's current value, compute new value (clamped 0–1), apply
    const personality = this.deps.getPersonality(context);
    const previousValue = personality[trait] ?? 0.5;
    let newValue = previousValue + effectiveDelta;

    // Clamp to [0, 1] range, which may further reduce the effective delta
    if (newValue < 0) {
      newValue = 0;
      effectiveDelta = newValue - previousValue;
      clamped = true;
    } else if (newValue > 1) {
      newValue = 1;
      effectiveDelta = newValue - previousValue;
      clamped = true;
    }

    const applied = this.deps.setPersonality(trait, newValue, context);
    if (applied === false) {
      // The host found no agent instance for this call. Stop before any budget
      // is spent or a durable mutation is written for an agent nothing changed on.
      return {
        success: false,
        error:
          'adapt_personality could not resolve the calling agent instance; no trait was changed.',
      };
    }

    // Update session tracking before any await, so an overlapping call for
    // the same session and trait sees this call's share of the budget.
    const newSessionTotal = currentSessionTotal + Math.abs(effectiveDelta);
    sessionDeltas.set(trait, newSessionTotal);
    if (learning) {
      this.sessionCalls.set(countKey, (this.sessionCalls.get(countKey) ?? 0) + 1);
    }

    // Decay-on-adapt (spec batch-1 C6): before recording the new mutation, age
    // this agent's STORED mutation strengths for the current UTC-day cycle.
    // Idempotent per (agent, day) via the store's guard table; a decay
    // failure never blocks the adapt itself. Aging advances on activity:
    // dormant agents' mutations hold strength until their next adapt.
    if (this.deps.config.persistWithDecay && this.deps.mutationStore) {
      if (this.deps.mutationStore.decayForAgent) {
        const cycleId = 'day:' + new Date().toISOString().slice(0, 10);
        try {
          await this.deps.mutationStore.decayForAgent(
            context.gmiId,
            this.deps.config.decayRate ?? 0.05,
            cycleId,
          );
        } catch (err) {
          console.warn('[agentos] decay-on-adapt failed (mutation proceeds):', err);
        }
      } else {
        console.warn(
          '[agentos] persistWithDecay is on but the mutation store lacks decayForAgent; decay skipped',
        );
      }
    }


    // 6. Record in mutation store when persistence is enabled.
    if (this.deps.mutationStore) {
      await Promise.resolve(
        this.deps.mutationStore.record({
          agentId: context.gmiId,
          trait,
          delta: effectiveDelta,
          reasoning,
          baselineValue: previousValue,
          mutatedValue: newValue,
        }),
      );
    }

    // 7. Return result
    const output: AdaptPersonalityOutput = {
      trait,
      previousValue,
      newValue,
      delta: effectiveDelta,
      clamped,
      sessionTotal: newSessionTotal,
      remainingBudget: maxDeltaPerSession - newSessionTotal,
    };

    return { success: true, output };
  }

  /** Returns the calling session's per-trait delta totals, creating the map on first use. */
  private getSessionDeltas(context: ToolExecutionContext): Map<string, number> {
    const sessionKey = resolveSelfImprovementSessionKey(context);
    const existing = this.sessionDeltas.get(sessionKey);
    if (existing) {
      return existing;
    }

    const created = new Map<string, number>();
    this.sessionDeltas.set(sessionKey, created);
    return created;
  }
}
