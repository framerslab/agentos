/**
 * @fileoverview AdaptPersonalityTool — ITool implementation that enables agents
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
 */

import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';
import type { RecordMutationInput } from './PersonalityMutationStore.js';
import { resolveSelfImprovementSessionKey } from './sessionScope.js';

// ============================================================================
// VALID TRAITS
// ============================================================================

/**
 * The six HEXACO personality dimensions that agents may self-modify.
 *
 * Each trait is a continuous value in the range [0, 1]:
 * - `openness`          — curiosity, creativity, willingness to explore
 * - `conscientiousness` — discipline, thoroughness, reliability
 * - `emotionality`      — emotional reactivity, empathy, anxiety
 * - `extraversion`      — sociability, energy, assertiveness
 * - `agreeableness`     — patience, tolerance, cooperation
 * - `honesty`           — sincerity, fairness, modesty
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
   * Agent-scoped, idempotent strength aging (spec batch-1 C6). Optional —
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
  /** Getter returning the current personality trait map (trait → value in [0, 1]). */
  getPersonality: () => Record<string, number>;
  /** Setter to apply a new value for a specific trait. */
  setPersonality: (trait: string, value: number) => void;
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
    'for every mutation. Per-session budgets prevent runaway drift.';

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

    // Decay-on-adapt (spec batch-1 C6): before applying a new mutation, age
    // this agent's STORED mutation strengths for the current UTC-day cycle.
    // Idempotent per (agent, day) via the store's guard table; a decay
    // failure never blocks the adapt itself. Aging advances on activity —
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

    // 3. Check session budget — track total |delta| per trait
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

    // 5. Get current value, compute new value (clamped 0–1), apply
    const personality = this.deps.getPersonality();
    const previousValue = personality[trait] ?? 0.5;
    let newValue = previousValue + effectiveDelta;

    // Clamp to [0, 1] range — may further reduce the effective delta
    if (newValue < 0) {
      newValue = 0;
      effectiveDelta = newValue - previousValue;
      clamped = true;
    } else if (newValue > 1) {
      newValue = 1;
      effectiveDelta = newValue - previousValue;
      clamped = true;
    }

    this.deps.setPersonality(trait, newValue);

    // Update session tracking
    const newSessionTotal = currentSessionTotal + Math.abs(effectiveDelta);
    sessionDeltas.set(trait, newSessionTotal);

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
