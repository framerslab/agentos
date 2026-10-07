/**
 * @fileoverview Core types for the Emergent Capability Engine.
 * @module @framers/agentos/emergent/types
 *
 * Provides all type definitions for the runtime tool creation system, enabling
 * agents to forge new tools via composition or sandboxed code execution, subject
 * to LLM-as-judge verification and tiered promotion.
 *
 * Key concepts:
 * - ToolTier: Lifecycle scope of an emergent tool (session → agent → shared)
 * - ComposableToolSpec: Pipeline of existing tool calls with input mapping
 * - SandboxedToolSpec: Arbitrary code execution in a memory/time-bounded sandbox
 * - CreationVerdict: LLM judge evaluation of a newly forged tool
 * - PromotionVerdict: Multi-reviewer gate before tier promotion
 * - EmergentTool: Unified shape for any runtime-created tool
 */

import type { JSONSchemaObject } from '../../core/tools/ITool.js';
import type { SelfImprovementConfig } from './SelfImprovementConfig.js';

// ============================================================================
// TIER SYSTEM
// ============================================================================

/**
 * Lifecycle scope tier for an emergent tool.
 *
 * Tools progress through tiers as they prove reliability. Higher tiers require
 * more stringent promotion verdicts and multi-reviewer sign-off.
 *
 * - `'session'` — Exists only for the current agent session; discarded on shutdown.
 * - `'agent'`   — Persisted for the agent that created it; not shared globally.
 * - `'shared'`  — Promoted to a shared tool registry; available to all agents.
 */
export type ToolTier = 'session' | 'agent' | 'shared';

// ============================================================================
// SANDBOX API ALLOWLIST
// ============================================================================

/**
 * Named APIs that sandboxed tool code is permitted to invoke.
 *
 * All other I/O is forbidden by default. The allowlist is declared per-tool in
 * {@link SandboxedToolSpec} and enforced by the sandbox runtime at execution time.
 *
 * - `'fetch'`         — Outbound HTTP/HTTPS requests via the global `fetch` API.
 * - `'fs.readFile'`   — Synchronous read of files in a pre-approved path whitelist.
 * - `'crypto'`        — Access to the Node.js `crypto` module for hashing / HMAC.
 */
export type SandboxAPI = 'fetch' | 'fs.readFile' | 'crypto';

/**
 * A capability a code-forged tool can be granted, by its catalogue name.
 * `fs.read` is the catalogue name of the `fs.readFile` function injected into
 * forged code; `SandboxAPI` keeps the injected names.
 */
export type CapabilityName = 'fetch' | 'fs.read' | 'crypto';

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

/**
 * A single step in a composable tool pipeline.
 *
 * Steps are executed sequentially. Each step invokes an existing registered tool
 * by name and maps values from the pipeline's shared input namespace into the
 * step's arguments using reference expressions.
 *
 * Reference expression syntax (resolved at runtime):
 * - `"$input"` — the original input to the composable tool.
 * - `"$prev"`  — the output of the immediately preceding step.
 * - `"$steps.<stepName>"` — the output of a named step.
 * - Any other literal value is used as-is.
 */
export interface ComposableStep {
  /**
   * Unique name for this step within the pipeline.
   * Used for cross-step references via `$steps.<stepName>`.
   * @example "fetchUser"
   */
  name: string;

  /**
   * The registered tool name to invoke for this step.
   * Must match the `name` property of an `ITool` available to the agent.
   * @example "web_search"
   */
  tool: string;

  /**
   * Input argument mapping for the tool invocation.
   * Keys are the tool's argument names; values are literal values or reference
   * expressions (`$input`, `$prev`, `$steps.<name>`).
   *
   * @example
   * ```ts
   * { query: "$input.searchTerm", maxResults: 5 }
   * ```
   */
  inputMapping: Record<string, unknown>;

  /**
   * Optional JSONata / simple expression evaluated against `$prev` before
   * executing this step. When the expression evaluates to falsy, the step is
   * skipped and its output is `null`.
   *
   * @example "$prev.totalCount > 0"
   */
  condition?: string;
}

/**
 * Implementation specification for a tool built by composing existing tools.
 *
 * The engine executes each step in order, threading outputs through the
 * reference expression system. The final step's output becomes the tool's output.
 */
export interface ComposableToolSpec {
  /** Discriminant: always `'compose'` for composable specs. */
  mode: 'compose';

  /**
   * Ordered list of pipeline steps.
   * Must contain at least one step; the last step's output is the tool result.
   */
  steps: ComposableStep[];
}

/**
 * Implementation specification for a tool whose logic is arbitrary code
 * executed in a memory/time-bounded sandbox.
 *
 * The sandboxed function signature must be:
 * ```ts
 * async function run(input: unknown): Promise<unknown>
 * ```
 * The engine calls `run(input)` and returns its resolved value as the tool output.
 */
export interface SandboxedToolSpec {
  /** Discriminant: always `'sandbox'` for sandboxed specs. */
  mode: 'sandbox';

  /**
   * The full source code of the sandboxed module.
   * Must export or define an async `run` function as its entry point.
   *
   * @example
   * ```ts
   * async function run(input) {
   *   const res = await fetch(`https://api.example.com?q=${input.query}`);
   *   return res.json();
   * }
   * ```
   */
  code: string;

  /**
   * Explicit allowlist of sandbox APIs the code may invoke.
   * Any call to an API not in this list will throw at runtime.
   */
  allowlist: SandboxAPI[];
}

/**
 * Union of all supported tool implementation specifications.
 */
export type ToolImplementation = ComposableToolSpec | SandboxedToolSpec;

// ============================================================================
// SANDBOX EXECUTION
// ============================================================================

/**
 * Input to the sandbox executor for running a single sandboxed tool invocation.
 */
export interface SandboxExecutionRequest {
  /**
   * Source code of the sandboxed module (same format as `SandboxedToolSpec.code`).
   */
  code: string;

  /**
   * The argument object passed to the `run(input)` entry point.
   */
  input: unknown;

  /**
   * APIs the sandbox is permitted to call. Anything not listed is blocked.
   */
  allowlist: SandboxAPI[];

  /**
   * Nominal heap budget in megabytes for the sandbox execution.
   * The current node:vm-backed JavaScript executor reports heap deltas but does
   * not preemptively enforce this limit.
   * @default 128
   */
  memoryMB: number;

  /**
   * Maximum wall-clock time in milliseconds before the sandbox is forcibly
   * killed and an error is returned.
   * @default 5000
   */
  timeoutMs: number;
}

/**
 * Outcome of a single sandbox execution attempt.
 */
export interface SandboxExecutionResult {
  /**
   * `true` when `run()` resolved without throwing and within resource limits.
   */
  success: boolean;

  /**
   * The resolved return value of `run()`, present only when `success` is `true`.
   */
  output?: unknown;

  /**
   * Human-readable error description, present when `success` is `false`.
   * Includes timeout and thrown-exception cases. A future isolate-backed
   * runtime may also report memory-exceeded cases.
   */
  error?: string;

  /**
   * Actual wall-clock execution time in milliseconds.
   * Populated regardless of success/failure.
   */
  executionTimeMs: number;

  /**
   * Observed heap delta for the sandbox execution in bytes.
   * Populated when the runtime can measure it; otherwise `0`.
   */
  memoryUsedBytes: number;
}

// ============================================================================
// JUDGE VERDICTS
// ============================================================================

/**
 * Evaluation verdict produced by the LLM-as-judge after a tool is forged.
 *
 * The judge runs the tool against its declared test cases and scores it across
 * five evaluation dimensions. A tool is only registered when `approved` is `true`.
 */
export interface CreationVerdict {
  /**
   * Whether the judge approves the tool for registration at its initial tier.
   * `false` means the forge request is rejected and no tool is registered.
   */
  approved: boolean;

  /**
   * Overall confidence the judge has in its verdict, in the range [0, 1].
   * Low confidence may trigger a second judge pass or human review.
   */
  confidence: number;

  /**
   * Safety score in the range [0, 1].
   * Assesses whether the tool's implementation could cause unintended harm,
   * data exfiltration, or resource exhaustion.
   */
  safety: number;

  /**
   * Correctness score in the range [0, 1].
   * Measures how well the tool's outputs match the expected outputs in the
   * declared test cases.
   */
  correctness: number;

  /**
   * Determinism score in the range [0, 1].
   * Gauges whether repeated invocations with identical inputs produce
   * consistent outputs. Lower scores flag non-deterministic behaviour.
   */
  determinism: number;

  /**
   * Bounded execution score in the range [0, 1].
   * Indicates whether the tool reliably completes within its declared
   * resource limits (memory, time). Scores derived from sandbox telemetry.
   */
  bounded: number;

  /**
   * Free-text explanation of the verdict, including any failure reasons,
   * flagged patterns, or suggestions for improvement.
   */
  reasoning: string;
}

/**
 * Verdict produced by the multi-reviewer panel before a tool is promoted
 * to a higher {@link ToolTier}.
 *
 * Requires independent sign-off from a safety auditor and a correctness reviewer.
 * Both must approve for `approved` to be `true`.
 */
export interface PromotionVerdict {
  /**
   * Whether both reviewers approved the promotion.
   * `false` means the tool remains at its current tier.
   */
  approved: boolean;

  /**
   * Safety audit sub-verdict from the safety-focused reviewer model.
   * Mirrors the shape of a partial {@link CreationVerdict}: `{ approved, confidence, reasoning }`.
   */
  safetyAuditor: {
    /** Whether the safety auditor approved. */
    approved: boolean;
    /** Safety auditor's confidence in [0, 1]. */
    confidence: number;
    /** Safety auditor's reasoning text. */
    reasoning: string;
  };

  /**
   * Correctness review sub-verdict from the correctness-focused reviewer model.
   * Mirrors the shape of a partial {@link CreationVerdict}: `{ approved, confidence, reasoning }`.
   */
  correctnessReviewer: {
    /** Whether the correctness reviewer approved. */
    approved: boolean;
    /** Correctness reviewer's confidence in [0, 1]. */
    confidence: number;
    /** Correctness reviewer's reasoning text. */
    reasoning: string;
  };

  /**
   * Combined confidence score derived from both reviewer confidences.
   * Typically the minimum or harmonic mean of the two sub-scores.
   */
  confidence: number;
}

/**
 * Verdict produced before reusing an emergent tool from a previous session.
 *
 * Validates that the tool's schema and runtime behaviour still match expectations,
 * and flags any anomalies that may indicate drift or tampering.
 */
export interface ReuseVerdict {
  /**
   * Whether the tool is safe to reuse in the current context.
   * `false` means the tool should be re-forged or discarded.
   */
  valid: boolean;

  /**
   * JSON Schema validation errors for the tool's input/output schemas, if any.
   * An empty array means schemas are structurally valid.
   */
  schemaErrors: string[];

  /**
   * Whether a behavioural anomaly was detected compared to the tool's
   * historical usage baseline.
   */
  anomaly: boolean;

  /**
   * Human-readable description of the detected anomaly, present when
   * `anomaly` is `true`.
   */
  anomalyReason?: string;
}

// ============================================================================
// USAGE STATS
// ============================================================================

/**
 * Accumulated runtime usage statistics for an emergent tool.
 *
 * Used by the promotion engine to decide when a tool has proven sufficient
 * reliability to advance to the next {@link ToolTier}.
 */
export interface ToolUsageStats {
  /**
   * Total number of times the tool has been invoked across all sessions
   * since it was first registered.
   */
  totalUses: number;

  /**
   * Number of invocations that completed without throwing or returning an error.
   */
  successCount: number;

  /**
   * Number of invocations that returned an error or threw an exception.
   */
  failureCount: number;

  /**
   * Rolling average wall-clock execution time in milliseconds, computed over
   * all recorded invocations.
   */
  avgExecutionTimeMs: number;

  /**
   * ISO-8601 timestamp of the most recent invocation, or `null` if the tool
   * has never been invoked.
   */
  lastUsedAt: string | null;

  /**
   * Aggregate confidence score in [0, 1] derived from judge verdict history.
   * Updated each time a new {@link CreationVerdict} or {@link PromotionVerdict}
   * is recorded.
   */
  confidenceScore: number;
}

/** Whether a stored tool may run. `demoted` is a host's decision and is never undone by loading. */
export type ToolState = 'active' | 'suspended' | 'demoted';

/**
 * Who recorded a tool's state. The library re-checks a suspension its own
 * checks set at the next load and lifts it when the cause is gone; a state the
 * host set stays until the host clears it, whatever words its reason uses.
 */
export type StateSetter = 'library' | 'host';

/** What a tool asked for when it was forged, kept so a rebuilt tool carries the same request. */
export type StoredRequest =
  | { kind: 'sandbox'; capabilities: CapabilityName[]; inferred?: boolean }
  | { kind: 'compose'; steps: Array<{ name: string; tool: string }> };

/**
 * A tool's state as this process holds it. It mirrors the tool's row in
 * `agentos_emergent_tool_state`, except for `request`, which can be `null`
 * while the row stores a request this release cannot read.
 */
export interface ToolStateRecord {
  toolId: string;
  state: ToolState;
  /**
   * The reason for a state other than `active`. The library's reasons are
   * catalogue words (`source_not_persisted`, `source_unreadable`,
   * `legacy_inactive`, `legacy_owner`); a host's reason is the text it gave.
   */
  reason: string | null;
  /** Who recorded the state. */
  setBy: StateSetter;
  /** Unix epoch milliseconds of the last state change. */
  at: number;
  /** The id of the write that set this state, when the row carries one. */
  writeId?: string;
  /**
   * The request this process holds for the tool: the stored one when it could
   * be read, else the one derived from the source, else `null`. A state change
   * that names no request leaves the stored column as it is.
   */
  request: StoredRequest | null;
}

/**
 * One row of `agentos_emergent_tools` joined with its state row. The five
 * state columns are null for a row written before state was kept.
 */
export interface PersistedToolRow {
  id: string;
  name: string;
  description: string;
  input_schema: string;
  output_schema: string | null;
  implementation_mode: string;
  implementation_source: string;
  tier: ToolTier;
  created_by_agent: string;
  created_by_session: string;
  created_at: number | string;
  judge_verdicts: string | null;
  confidence_score: number | null;
  total_uses: number | null;
  success_count: number | null;
  failure_count: number | null;
  avg_execution_ms: number | null;
  last_used_at: number | string | null;
  is_active: number | boolean | null;
  state: ToolState | null;
  state_reason: string | null;
  set_by: string | null;
  state_at: number | string | null;
  request_json: string | null;
  /** Whether the state row's flag write finished (0 while pending); null for a row with no state row. */
  flag_synced: number | boolean | null;
  /** The id of the last state write; null for a row with no state row, or one written without an id. */
  write_id: string | null;
}

// ============================================================================
// EMERGENT TOOL
// ============================================================================

/**
 * A tool created at runtime by the Emergent Capability Engine.
 *
 * `EmergentTool` is the persisted record that backs a forged tool. It carries
 * the tool's identity, schemas, implementation spec, current tier, audit trail,
 * and accumulated usage statistics.
 */
export interface EmergentTool {
  /**
   * Globally unique identifier assigned at forge time.
   * Convention: `emergent:<uuid-v4>` (e.g., `"emergent:a1b2c3d4-..."`).
   */
  id: string;

  /**
   * Machine-readable tool name exposed to the LLM in tool call requests.
   * Must be unique among tools currently registered for the agent.
   * @example "fetch_github_pr_summary"
   */
  name: string;

  /**
   * Natural language description of what the tool does and when to use it.
   * Injected into the LLM prompt as the tool's description field.
   */
  description: string;

  /**
   * JSON Schema defining the structure of arguments the tool accepts.
   * Validated by the executor before each invocation.
   */
  inputSchema: JSONSchemaObject;

  /**
   * JSON Schema defining the structure of the tool's output on success.
   * Used by downstream tools and the judge for output validation.
   */
  outputSchema: JSONSchemaObject;

  /**
   * The implementation specification — either a composable pipeline or
   * sandboxed code. Determines how the executor runs the tool.
   */
  implementation: ToolImplementation;

  /**
   * Current lifecycle tier. Tools start at `'session'` and may be promoted
   * to `'agent'` and then `'shared'` as they accumulate usage and pass audits.
   */
  tier: ToolTier;

  /**
   * The agent that created this tool, or `'system'`. The agent identity is the
   * persona: `forge_tool` passes the caller's `personaId`, and an `agent`-tier
   * tool runs only for a caller with that `personaId`. (A GMI instance id is
   * minted per session and cannot own a tool meant to outlive one: an
   * `agent`-tier row from an earlier release that carries one loads suspended
   * with the reason `legacy_owner`.)
   */
  createdBy: string;

  /**
   * ISO-8601 timestamp of when the tool was first forged and registered.
   */
  createdAt: string;

  /**
   * Ordered log of all judge verdicts issued for this tool, from initial
   * creation through any subsequent promotion reviews.
   * The most recent verdict is the last element.
   */
  judgeVerdicts: Array<CreationVerdict | PromotionVerdict>;

  /**
   * Accumulated runtime usage statistics.
   * Updated after every invocation by the usage tracking subsystem.
   */
  usageStats: ToolUsageStats;

  /**
   * Human-readable label describing the origin of this tool for audit purposes.
   * @example "forged by agent gmi-42 during session sess-99"
   */
  source: string;
}

// ============================================================================
// FORGE API
// ============================================================================

/**
 * A single test case used by the LLM judge to evaluate a newly forged tool.
 *
 * The judge invokes the tool with `input` and compares the result against
 * `expectedOutput` using semantic equivalence (not strict equality).
 */
export interface ForgeTestCase {
  /**
   * Input arguments object passed to the tool's `run` / execution entry point.
   * Must conform to the tool's declared `inputSchema`.
   */
  input: Record<string, unknown>;

  /**
   * Expected output value used for correctness scoring.
   * The judge uses this as a reference — partial matches may still score well.
   */
  expectedOutput: unknown;
}

/**
 * Request payload for the `forge_tool` system tool.
 *
 * An agent submits this to request the creation of a new emergent tool. The
 * engine validates the request, runs the judge, and returns a {@link ForgeResult}.
 */
export interface ForgeToolRequest {
  /**
   * Desired machine-readable name for the new tool.
   * Must be unique among tools currently visible to the requesting agent.
   */
  name: string;

  /**
   * Natural language description of the tool's purpose and behaviour.
   * Used verbatim as the tool's description in the LLM tool list.
   */
  description: string;

  /**
   * JSON Schema for the tool's input arguments.
   */
  inputSchema: JSONSchemaObject;

  /**
   * JSON Schema for the tool's expected output.
   */
  outputSchema: JSONSchemaObject;

  /**
   * Implementation specification — composable pipeline or sandboxed code.
   */
  implementation: ToolImplementation;

  /**
   * One or more test cases the judge uses to evaluate correctness.
   * At least one test case is required for the forge request to be accepted.
   */
  testCases: [ForgeTestCase, ...ForgeTestCase[]];
}

/**
 * Result returned after a forge_tool invocation.
 *
 * On success the new tool is registered and available immediately. On failure
 * the `verdict` field explains why the judge rejected the tool.
 */
export interface ForgeResult {
  /**
   * `true` when the tool was forged, judged, and registered successfully.
   */
  success: boolean;

  /**
   * The assigned tool ID, present only when `success` is `true`.
   * @example "emergent:a1b2c3d4-e5f6-..."
   */
  toolId?: string;

  /**
   * The full emergent tool record, present only when `success` is `true`.
   */
  tool?: EmergentTool;

  /**
   * The judge's creation verdict.
   * Present whether the forge succeeded or was rejected — callers can inspect
   * `verdict.reasoning` to understand why a rejection occurred.
   */
  verdict?: CreationVerdict;

  /**
   * Human-readable error message for system-level failures (e.g., sandbox crash,
   * schema parse error). Distinct from judge rejection — check `verdict` for those.
   */
  error?: string;
}

/**
 * Result returned after a `promote_tool` invocation.
 *
 * On success the tool's tier is incremented and the new record is persisted.
 */
export interface PromotionResult {
  /**
   * `true` when both reviewers approved and the tier was incremented.
   */
  success: boolean;

  /**
   * The multi-reviewer promotion verdict.
   * Present whether the promotion succeeded or was rejected.
   */
  verdict?: PromotionVerdict;

  /**
   * Human-readable error for system-level failures during the promotion process.
   */
  error?: string;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Configuration options for the Emergent Capability Engine.
 *
 * All fields have sensible defaults defined in {@link DEFAULT_EMERGENT_CONFIG}.
 * Pass a partial object to override only the fields you need.
 */
export interface EmergentConfig {
  /**
   * Master switch. When `false`, all forge / promote / execute requests are
   * rejected immediately with a `"emergent capabilities disabled"` error.
   * @default false
   */
  enabled: boolean;

  /**
   * Maximum number of session-scoped emergent tools an agent may hold at once.
   * Forge requests beyond this limit are rejected until older tools are evicted.
   * @default 10
   */
  maxSessionTools: number;

  /**
   * Maximum number of agent-scoped emergent tools persisted per agent.
   * Promotion from `'session'` to `'agent'` is blocked when this limit is reached.
   * @default 50
   */
  maxAgentTools: number;

  /**
   * Whether sandboxed code tools may be forged at all.
   *
   * When `false`, agents may still create compose-mode tools from existing
   * registered tools, but any forge request using `implementation.mode:
   * 'sandbox'` is rejected before validation or execution.
   *
   * This is intentionally disabled by default because sandboxed code carries
   * higher review and persistence risk than composing tools that are already registered.
   *
   * @default false
   */
  allowSandboxTools: boolean;

  /**
   * Whether sandbox source code should be persisted at rest.
   *
   * When `false`, sandbox tools still run in memory for the active process, but
   * durable storage only receives redacted metadata instead of raw source code.
   * This reduces the blast radius of runtime-forged code while preserving audit
   * visibility and non-source tool metadata.
   *
   * Persisting raw sandbox source should be an explicit opt-in for trusted
   * environments that need restart-time rehydration of sandbox tools.
   *
   * @default false
   */
  persistSandboxSource: boolean;

  /**
   * Nominal memory budget in megabytes for each sandboxed tool execution.
   * The current node:vm-backed executor reports heap deltas but does not
   * preemptively enforce this limit.
   * Passed as `SandboxExecutionRequest.memoryMB`.
   * @default 128
   */
  sandboxMemoryMB: number;

  /**
   * Wall-clock timeout in milliseconds for each sandboxed tool execution.
   * Passed as `SandboxExecutionRequest.timeoutMs`.
   * @default 5000
   */
  sandboxTimeoutMs: number;

  /**
   * Thresholds that must be met before a tool is eligible for tier promotion.
   */
  promotionThreshold: {
    /**
     * Minimum total invocation count before promotion is considered.
     * @default 5
     */
    uses: number;

    /**
     * Minimum aggregate confidence score (from usage stats) before promotion.
     * In the range [0, 1].
     * @default 0.8
     */
    confidence: number;
  };

  /**
   * Model ID used by the single LLM judge at forge time ({@link CreationVerdict}).
   * Should be a fast, cost-efficient model — correctness is handled by test cases.
   * @default "gpt-4o-mini"
   */
  judgeModel: string;

  /**
   * Model ID used by both reviewers in the multi-reviewer promotion panel
   * ({@link PromotionVerdict}). Should be a more capable model than `judgeModel`.
   * @default "gpt-4o"
   */
  promotionJudgeModel: string;

  /**
   * Self-improvement configuration for bounded autonomous personality mutation,
   * skill management, workflow composition, and self-evaluation.
   *
   * When omitted or `undefined`, self-improvement tools are not registered.
   * @default undefined (disabled)
   */
  selfImprovement?: SelfImprovementConfig;
}

/**
 * Default configuration for the Emergent Capability Engine.
 *
 * Note: `enabled` defaults to `false` — emergent capabilities must be explicitly
 * opted-in via the agent's configuration to prevent accidental runtime tool creation.
 */
export const DEFAULT_EMERGENT_CONFIG: Readonly<EmergentConfig> = {
  enabled: false,
  maxSessionTools: 10,
  maxAgentTools: 50,
  allowSandboxTools: false,
  persistSandboxSource: false,
  sandboxMemoryMB: 128,
  sandboxTimeoutMs: 5000,
  promotionThreshold: {
    uses: 5,
    confidence: 0.8,
  },
  judgeModel: 'gpt-4o-mini',
  promotionJudgeModel: 'gpt-4o',
} as const;

/**
 * The prefix of a GMI instance id (`GMIManager` mints `gmi-instance-<uuid>`).
 * Earlier releases recorded the forging instance's id as an `agent`-tier
 * tool's owner; the persona is the owner now. The prefix is reserved for
 * telling those rows apart: a tool whose owner begins with it is never
 * promoted to the `agent` tier, so an `agent`-tier row whose owner carries
 * it is always one an earlier release wrote, and it loads suspended with the
 * reason `legacy_owner`.
 */
export const GMI_INSTANCE_ID_PREFIX = 'gmi-instance-';
