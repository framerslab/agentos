/**
 * @fileoverview Configuration types and defaults for the self-improving
 * agent system: personality mutation, skill management, workflow composition,
 * and self-evaluation.
 *
 * All sub-systems are opt-in and bounded by configurable limits to prevent
 * runaway self-modification. The {@link DEFAULT_SELF_IMPROVEMENT_CONFIG}
 * constant provides sensible defaults with self-improvement disabled.
 *
 * @module @framers/agentos/emergent/SelfImprovementConfig
 */

// ============================================================================
// SELF-IMPROVEMENT CONFIGURATION
// ============================================================================

/**
 * Configuration for bounded autonomous self-improvement.
 *
 * Controls four self-improvement capabilities:
 * - **Personality**: HEXACO trait mutation with per-session budgets and decay.
 * - **Skills**: Runtime skill enable/disable with allowlist gating.
 * - **Workflows**: Tool composition with step limits and tool allowlists.
 * - **Self-evaluation**: LLM-based self-scoring with parameter adjustment.
 *
 * All capabilities require `enabled: true` as a master switch. Individual
 * sub-system settings provide additional fine-grained control.
 */
export interface SelfImprovementConfig {
  /**
   * Master switch for all self-improvement tools.
   * When `false`, no self-improvement tools are registered with the engine.
   * @default false
   */
  enabled: boolean;

  /**
   * Configuration for bounded personality trait mutation.
   *
   * Personality mutations modify HEXACO dimensions at runtime, subject to
   * per-session delta budgets and Ebbinghaus-style decay toward baseline
   * values during consolidation cycles.
   */
  personality: {
    /**
     * Maximum absolute delta per trait per session.
     *
     * Limits how far any single HEXACO dimension can shift in a single
     * agent session. Deltas exceeding this budget are clamped.
     * @default 0.15
     */
    maxDeltaPerSession: number;

    /**
     * Whether to persist mutations across sessions with strength decay.
     *
     * When `true`, mutations are written to the PersonalityMutationStore
     * and gradually decay toward baseline via the ConsolidationLoop.
     * When `false`, mutations are session-scoped only.
     * @default true
     */
    persistWithDecay: boolean;

    /**
     * Decay rate toward baseline per consolidation cycle.
     *
     * Each consolidation cycle reduces every mutation's strength by this
     * amount. Mutations whose strength falls below 0.1 are pruned.
     * @default 0.05
     */
    decayRate: number;
  };

  /**
   * Configuration for runtime skill management.
   *
   * Controls which skills the agent can enable/disable at runtime and
   * whether human-in-the-loop approval is required for new skill categories.
   */
  skills: {
    /**
     * Skill IDs or patterns the agent is allowed to enable.
     *
     * Supports three matching modes:
     * - `['*']` — All skills are allowed (default).
     * - `['category:X']` — Skills in category `X` are allowed.
     * - `['skillId']` — Exact skill ID match.
     *
     * @default ['*']
     */
    allowlist: string[];

    /**
     * Whether to require HITL approval for skills in new categories.
     *
     * When `true`, enabling a skill whose category is not yet represented
     * among active skills returns a `requires_approval` status instead of
     * enabling immediately.
     * @default true
     */
    requireApprovalForNewCategories: boolean;
  };

  /**
   * Configuration for runtime workflow composition.
   *
   * Workflows are multi-step tool pipelines created by the agent at runtime.
   * Steps execute sequentially with reference resolution (`$input`, `$prev`,
   * `$steps[N]`) between them.
   */
  workflows: {
    /**
     * Maximum number of steps per composed workflow.
     *
     * Prevents unbounded pipeline creation. Workflows exceeding this
     * limit are rejected at creation time.
     * @default 10
     */
    maxSteps: number;

    /**
     * Tool names the agent may compose into workflows. `'*'` is the one
     * pattern: a name is matched exactly otherwise.
     *
     * - `['*']` — All registered tools are allowed (default).
     * - `['toolName']` — Only the listed tools may appear as workflow steps.
     *
     * The `create_workflow` tool is always excluded to prevent recursion. The
     * engine's chaining rule applies to every step as well (see
     * `EmergentConfig.compose`): a tool with side effects the host has not
     * listed there, a tool that declares no `hasSideEffects`, and
     * `launch_agency`, listed or not, are refused when the workflow is created,
     * and each step is checked again just before it runs.
     * @default ['*']
     */
    allowedTools: string[];
  };

  /**
   * Configuration for self-evaluation and strategy adjustment.
   *
   * The agent can evaluate its own responses, score them on multiple
   * criteria, and adjust operational parameters (temperature, verbosity,
   * personality) based on the evaluation results.
   */
  selfEval: {
    /**
     * Whether to auto-apply suggested adjustments after evaluation.
     *
     * When `true`, the self-evaluate tool applies parameter adjustments
     * immediately. When `false`, adjustments are returned as suggestions
     * only and require explicit confirmation.
     * @default true
     */
    autoAdjust: boolean;

    /**
     * Parameters the agent is permitted to adjust via self-evaluation.
     *
     * Common adjustable parameters:
     * - `'temperature'` — LLM sampling temperature.
     * - `'verbosity'` — Response length preference.
     * - `'personality'` — Any HEXACO trait delta via a `{ trait, delta }` payload.
     * - explicit trait names such as `'openness'` or `'agreeableness'`.
     *
     * @default ['temperature', 'verbosity', 'personality']
     */
    adjustableParams: string[];

    /**
     * Maximum number of self-evaluations allowed per session.
     *
     * Prevents excessive LLM calls for self-scoring. Further evaluation
     * requests beyond this limit are rejected.
     * @default 10
     */
    maxEvaluationsPerSession: number;

    /**
     * Optional model override for the evaluation judge.
     *
     * When omitted, the tool auto-detects the current text runtime and uses
     * its cheapest configured text model when available, falling back to
     * `openai:gpt-4o-mini`.
     *
     * @default auto-detected cheap text model
     */
    evaluationModel?: string;
  };
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

/**
 * Sensible defaults for self-improvement configuration.
 *
 * Self-improvement is **disabled** by default (`enabled: false`). When opted
 * in, all skills are available, workflows are bounded to 10 steps, and
 * personality mutations decay at 5% per consolidation cycle.
 */
export const DEFAULT_SELF_IMPROVEMENT_CONFIG: Readonly<SelfImprovementConfig> = {
  enabled: false,
  personality: {
    maxDeltaPerSession: 0.15,
    persistWithDecay: true,
    decayRate: 0.05,
  },
  skills: {
    allowlist: ['*'],
    requireApprovalForNewCategories: true,
  },
  workflows: {
    maxSteps: 10,
    allowedTools: ['*'],
  },
  selfEval: {
    autoAdjust: true,
    adjustableParams: ['temperature', 'verbosity', 'personality'],
    maxEvaluationsPerSession: 10,
  },
} as const;
