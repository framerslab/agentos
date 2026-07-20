/**
 * @file types.ts
 * @description Core Intermediate Representation (IR) types for the AgentOS Unified Orchestration Layer.
 *
 * All three authoring APIs — AgentGraph (graph-based), workflow (sequential), and mission
 * (goal-oriented) — compile down to these IR types before execution. Keeping a single shared IR
 * means the runtime, checkpointing, memory, and diagnostics subsystems only need one implementation.
 *
 * Dependency graph (no circular imports):
 *   primitive enums/constants → condition/executor unions → policy interfaces →
 *   view interfaces → GraphNode / GraphEdge / GraphState → CompiledExecutionGraph
 */
import type { JudgeNodeConfig } from '../../core/llm/providers/judge-config.js';

export type { JudgeNodeConfig } from '../../core/llm/providers/judge-config.js';

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/** Sentinel node-id representing the implicit entry point of every graph. */
export const START = '__START__' as const;

/** Sentinel node-id representing the implicit exit point of every graph. */
export const END = '__END__' as const;

// ---------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------

/**
 * Controls how many LLM turns a node may consume per invocation.
 *
 * - `single_turn`        — exactly one prompt/response pair; deterministic cost.
 * - `react_bounded`      — ReAct-style tool-use loop capped by `maxInternalIterations`.
 * - `planner_controlled` — the orchestrating planner decides when the node is "done".
 */
export type NodeExecutionMode = 'single_turn' | 'react_bounded' | 'planner_controlled';

/**
 * Broad classification of the side-effects a node may produce.
 * Used by the runtime for scheduling, parallelism gating, and audit logging.
 *
 * - `pure`     — no I/O; can be cached and parallelised freely.
 * - `read`     — reads external state but does not mutate it.
 * - `write`    — mutates external state (DB, API, file-system, …).
 * - `external` — fire-and-forget external call; mutation status unknown.
 * - `human`    — requires a human in the loop; execution suspends until resolved.
 */
export type EffectClass = 'pure' | 'read' | 'write' | 'external' | 'human';

// ---------------------------------------------------------------------------
// Memory primitives
// ---------------------------------------------------------------------------

/**
 * Cognitive memory trace categories, modelled after the psychological taxonomy used
 * throughout the AgentOS memory subsystem.
 *
 * - `episodic`    — autobiographical events tied to a moment in time.
 * - `semantic`    — factual / world-knowledge, not time-stamped.
 * - `procedural`  — how-to knowledge; encoded skills and routines.
 * - `prospective` — future-oriented intentions ("remember to …").
 * - `relational`  — trust, boundary, and relationship-state memory.
 */
export type MemoryTraceType =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'prospective'
  | 'relational';

/**
 * Visibility scope of a memory trace.
 *
 * - `global`       — shared across all agents and all sessions.
 * - `persona`      — private to this agent identity.
 * - `session`      — lives only for the lifetime of a single run.
 * - `conversation` — lives only for the current conversation turn window.
 */
export type GraphMemoryScope = 'global' | 'persona' | 'session' | 'conversation';

/**
 * How the runtime handles in-flight memory reads/writes relative to concurrent graph branches.
 *
 * - `live`       — always reads/writes the latest committed value; no isolation.
 * - `snapshot`   — reads a point-in-time snapshot taken at graph start; writes are deferred.
 * - `journaled`  — writes are appended to a journal and replayed atomically at commit.
 */
export type MemoryConsistencyMode = 'live' | 'snapshot' | 'journaled';

// ---------------------------------------------------------------------------
// GraphCondition — routing predicate discriminated union
// ---------------------------------------------------------------------------

/**
 * A TypeScript function that inspects `GraphState` and returns the id of the next node.
 * Used with `{ type: 'function' }` conditions so authors can express arbitrary routing logic.
 */
export type GraphConditionFn = (state: GraphState) => string;

/**
 * A DSL expression string evaluated by the runtime's condition interpreter.
 * Expressions may reference `state.*` fields using dot-notation.
 * Example: `"state.scratch.confidence > 0.8 ? 'approve' : 'review'"`
 */
export type GraphConditionExpr = string;

/**
 * Discriminated union for all routing predicates supported by graph edges.
 *
 * - `{ type: 'function' }` — calls a runtime-registered TypeScript function.
 * - `{ type: 'expression' }` — evaluates a sandboxed DSL string.
 */
export type GraphCondition =
  | { type: 'function'; fn: GraphConditionFn; description?: string }
  | { type: 'expression'; expr: GraphConditionExpr };

// ---------------------------------------------------------------------------
// NodeExecutorConfig — node implementation discriminated union
// ---------------------------------------------------------------------------

/**
 * Configuration for a voice pipeline node.
 * All fields except `mode` are optional and default from agent.config.json voice section.
 */
export interface VoiceNodeConfig {
  /** Voice session mode */
  mode: 'conversation' | 'listen-only' | 'speak-only';
  /** STT provider override */
  stt?: string;
  /** TTS provider override */
  tts?: string;
  /** TTS voice override */
  voice?: string;
  /** Endpointing mode */
  endpointing?: 'acoustic' | 'heuristic' | 'semantic';
  /** Barge-in mode */
  bargeIn?: 'hard-cut' | 'soft-fade' | 'disabled';
  /** Enable diarization */
  diarization?: boolean;
  /** Language (BCP-47) */
  language?: string;
  /** Max turns before node completes (0 = unlimited) */
  maxTurns?: number;
  /** Exit condition */
  exitOn?: 'hangup' | 'silence-timeout' | 'keyword' | 'turns-exhausted' | 'manual';
  /** Keywords that trigger completion (when exitOn: 'keyword') */
  exitKeywords?: string[];
  /**
   * Line a `speak-only` node delivers to TTS before completing. When set, a
   * `speak-only` node pushes this text via the transport adapter's
   * `deliverNodeOutput` (→ `pipeline.pushToTTS`) then routes its `completed`
   * edge. No effect on `conversation` / `listen-only` modes.
   */
  speakText?: string;
}

/**
 * Describes how the runtime should execute a `GraphNode`.  Each variant maps to a
 * distinct execution strategy.
 *
 * - `gmi`        — General Model Invocation: call an LLM with system instructions.
 * - `tool`       — Invoke a registered `ITool` by name, optionally with static args.
 * - `extension`  — Call a method on a registered `IExtension`.
 * - `human`      — Suspend execution and surface a prompt to a human operator.
 * - `guardrail`  — Run one or more guardrail checks; route or block on violation.
 * - `router`     — Pure routing node; evaluates a `GraphCondition` and emits no output.
 * - `subgraph`   — Delegate to another `CompiledExecutionGraph` with optional field mapping.
 * - `voice`      — Run a voice pipeline session with configurable STT/TTS and turn management.
 */
export type NodeExecutorConfig =
  | {
      type: 'gmi';
      /** System-level instructions injected before the user message. */
      instructions: string;
      /** Maximum ReAct loop iterations when `executionMode` is `react_bounded`. Defaults to 10. */
      maxInternalIterations?: number;
      /** Whether to issue multiple tool calls in a single model turn. */
      parallelTools?: boolean;
      /** Sampling temperature forwarded to the LLM provider. */
      temperature?: number;
      /** Hard cap on output tokens for this node's completion. */
      maxTokens?: number;
    }
  | {
      type: 'tool';
      /** Registered tool name as it appears in the tool catalogue. */
      toolName: string;
      /** Static arguments merged with runtime-provided arguments before invocation. */
      args?: Record<string, unknown>;
    }
  | {
      type: 'extension';
      /** Extension identifier as registered in the capability registry. */
      extensionId: string;
      /** Name of the extension method to call. */
      method: string;
    }
  | {
      type: 'human';
      /** Message displayed to the human operator while the graph is suspended. */
      prompt: string;
      /** When `true`, the node auto-accepts without waiting for human input. Useful for testing. */
      autoAccept?: boolean;
      /** When `true` or a string, the node auto-rejects. A string value is used as the rejection reason. */
      autoReject?: boolean | string;
      /**
       * Delegates the approval decision to an LLM judge instead of a human.
       * When the judge's confidence falls below `confidenceThreshold`, execution
       * falls through to the normal human interrupt.
       */
      judge?: JudgeNodeConfig;
      /**
       * Behaviour when the node's `timeout` expires.
       * - `'accept'` — auto-accept.
       * - `'reject'` — auto-reject.
       * - `'error'`  — throw a timeout error (default behaviour).
       * @default 'error'
       */
      onTimeout?: 'accept' | 'reject' | 'error';
      /**
       * Run post-approval guardrails after an automated approval path
       * (`autoAccept`, `judge`, or timeout-accept). Defaults to `true`.
       */
      guardrailOverride?: boolean;
    }
  | {
      type: 'guardrail';
      /** Ordered list of guardrail identifiers to evaluate. */
      guardrailIds: string[];
      /** Action taken when any guardrail fires. */
      onViolation: 'block' | 'reroute' | 'warn' | 'sanitize';
      /** Node id to route to when `onViolation` is `'reroute'`. */
      rerouteTarget?: string;
    }
  | {
      type: 'router';
      /** Routing predicate; the returned node-id determines the next edge. */
      condition: GraphCondition;
    }
  | {
      type: 'subgraph';
      /** Id of the `CompiledExecutionGraph` to delegate to. */
      graphId: string;
      /** Maps parent `scratch` field paths → child `input` field paths. */
      inputMapping?: Record<string, string>;
      /** Maps child `artifacts` field paths → parent `scratch` field paths. */
      outputMapping?: Record<string, string>;
    }
  | {
      type: 'voice';
      /** Voice pipeline session configuration. */
      voiceConfig: VoiceNodeConfig;
    };

// ---------------------------------------------------------------------------
// RetryPolicy
// ---------------------------------------------------------------------------

/**
 * Governs automatic retry behaviour for transient node failures.
 *
 * @property maxAttempts - Total number of attempts (including the first).
 * @property backoff     - Wait time growth strategy between attempts.
 * @property backoffMs   - Base wait duration in milliseconds.
 * @property retryOn     - Optional allowlist of error codes/names that trigger retry.
 *                         When absent, all errors are retried up to `maxAttempts`.
 */
export interface RetryPolicy {
  maxAttempts: number;
  backoff: 'fixed' | 'linear' | 'exponential';
  backoffMs: number;
  retryOn?: string[];
}

// ---------------------------------------------------------------------------
// Policy interfaces
// ---------------------------------------------------------------------------

/**
 * Controls how a node reads from and writes to the agent's memory subsystem.
 *
 * @property consistency - Isolation mode applied for all memory I/O in this node.
 * @property read        - Optional filter applied when loading traces before execution.
 * @property write       - Optional encoding settings applied when persisting after execution.
 */
export interface MemoryPolicy {
  consistency: MemoryConsistencyMode;
  read?: {
    /** Restrict loaded traces to these memory types. */
    types?: MemoryTraceType[];
    /** Restrict loaded traces to this scope. */
    scope?: GraphMemoryScope;
    /** Maximum number of traces to surface into `GraphState.memory`. */
    maxTraces?: number;
    /** Minimum consolidation strength (0–1) for a trace to be returned. */
    minStrength?: number;
    /** Free-text semantic query used for vector-similarity retrieval. */
    semanticQuery?: string;
  };
  write?: {
    /** When true, the runtime auto-encodes node output into a new trace. */
    autoEncode?: boolean;
    /** Trace category applied to auto-encoded output. */
    type?: MemoryTraceType;
    /** Scope applied to auto-encoded output. */
    scope?: GraphMemoryScope;
  };
}

/**
 * Controls dynamic capability discovery performed before or during node execution.
 *
 * @property enabled    - Master switch; when false all other fields are ignored.
 * @property query      - Semantic query forwarded to `CapabilityDiscoveryEngine`.
 * @property kind       - Restricts discovery to a specific capability kind.
 * @property maxResults - Maximum number of results injected into the node's context.
 * @property fallback   - Behaviour when discovery returns no results.
 *                        `'all'` injects the full capability list; `'error'` aborts the node.
 */
export interface DiscoveryPolicy {
  enabled: boolean;
  query?: string;
  kind?: 'tool' | 'skill' | 'extension' | 'any';
  maxResults?: number;
  fallback?: 'all' | 'error';
}

/**
 * Configures persona-layer traits injected into the node's prompt context.
 *
 * @property traits      - HEXACO-style trait overrides (values in range 0–1).
 * @property mood        - Override the PAD mood state label for this node.
 * @property adaptStyle  - Whether to apply learned communication-style preferences.
 */
export interface PersonaPolicy {
  traits?: Record<string, number>;
  mood?: string;
  adaptStyle?: boolean;
}

/**
 * Declarative guardrail policy attached to a node or edge.
 *
 * @property input        - Guardrail ids evaluated against the node's incoming payload.
 * @property output       - Guardrail ids evaluated against the node's outgoing payload.
 * @property onViolation  - Action taken when any guardrail fires.
 * @property rerouteTarget - Required when `onViolation` is `'reroute'`.
 */
export interface GuardrailPolicy {
  input?: string[];
  output?: string[];
  onViolation: 'block' | 'reroute' | 'warn' | 'sanitize';
  rerouteTarget?: string;
}

/**
 * Optional per-node LLM override attached during planning or compilation.
 *
 * The runtime may use this to route different graph nodes to different
 * providers/models without changing the graph-level default LLM config.
 */
export interface NodeLlmConfig {
  /** Logical provider identifier selected for this node (e.g. `openai`, `anthropic`, `groq`). */
  providerId: string;
  /** Model identifier selected for this node. */
  model: string;
  /** Human-readable explanation for audit/debugging. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// View interfaces (read-only runtime surfaces)
// ---------------------------------------------------------------------------

/**
 * A read-only snapshot of memory state visible to a node during execution.
 * Populated by the runtime before the node's executor is called; immutable thereafter.
 */
export interface MemoryView {
  /** Traces retrieved according to the node's `MemoryPolicy.read` configuration. */
  traces: ReadonlyArray<{
    traceId: string;
    type: MemoryTraceType;
    content: string;
    /** Consolidation strength in range 0–1; higher = stronger/more salient. */
    strength: number;
    scope: GraphMemoryScope;
    /** Unix epoch milliseconds when the trace was first encoded. */
    createdAt: number;
    metadata?: Record<string, unknown>;
  }>;
  /** Writes staged during this node's execution, not yet committed to the store. */
  pendingWrites: ReadonlyArray<{
    type: MemoryTraceType;
    content: string;
    scope: GraphMemoryScope;
  }>;
  /** Total number of traces that matched the read filter (before `maxTraces` capping). */
  totalTracesRead: number;
  /** Wall-clock time in milliseconds spent on the memory read operation. */
  readLatencyMs: number;
}

/**
 * Accumulated diagnostic telemetry for an entire graph run.
 * Appended to `GraphState.diagnostics` after each node completes.
 */
export interface DiagnosticsView {
  /** Cumulative LLM tokens consumed across all `gmi` nodes. */
  totalTokensUsed: number;
  /** Wall-clock duration from graph start to the latest completed node. */
  totalDurationMs: number;
  /** Per-node timing and token attribution. */
  nodeTimings: Record<string, { startMs: number; endMs: number; tokensUsed: number }>;
  /** Results from each `DiscoveryPolicy`-triggered capability lookup. */
  discoveryResults: Record<string, { query: string; toolsFound: string[]; latencyMs: number }>;
  /** Results from each guardrail evaluation. */
  guardrailResults: Record<string, { guardrailId: string; passed: boolean; action: string; latencyMs: number }>;
  /** Number of checkpoint snapshots persisted during the run. */
  checkpointsSaved: number;
  /** Number of memory read operations performed. */
  memoryReads: number;
  /** Number of memory write operations performed (including pending). */
  memoryWrites: number;
}

// ---------------------------------------------------------------------------
// Core graph building blocks
// ---------------------------------------------------------------------------

/**
 * A single vertex in the compiled execution graph.
 *
 * Nodes are immutable once compiled; all runtime state lives in `GraphState`.
 */
export interface GraphNode {
  /** Unique identifier within the parent `CompiledExecutionGraph`. Must not equal `START` or `END`. */
  id: string;
  /** Coarse type label kept in sync with `executorConfig.type` for fast switching. */
  type: 'gmi' | 'tool' | 'extension' | 'human' | 'guardrail' | 'router' | 'subgraph' | 'voice';
  /** Full executor configuration; discriminated union determines runtime strategy. */
  executorConfig: NodeExecutorConfig;
  /** Controls the LLM turn budget for this node. */
  executionMode: NodeExecutionMode;
  /** Classifies the side-effects this node may produce. */
  effectClass: EffectClass;
  /** Maximum wall-clock execution time in milliseconds before the node is aborted. */
  timeout?: number;
  /** Automatic retry configuration for transient failures. */
  retryPolicy?: RetryPolicy;
  /**
   * When the runtime should persist a checkpoint snapshot.
   * - `before` — snapshot taken before executor runs (enables re-entry on crash).
   * - `after`  — snapshot taken after executor succeeds.
   * - `both`   — snapshot taken at both points.
   * - `none`   — no snapshot for this node.
   */
  checkpoint: 'before' | 'after' | 'both' | 'none';
  /** JSON-Schema-compatible description of the expected input shape. */
  inputSchema?: Record<string, unknown>;
  /** JSON-Schema-compatible description of the expected output shape. */
  outputSchema?: Record<string, unknown>;
  /** Optional planner-estimated node complexity (0-1). */
  complexity?: number;
  /** Optional per-node LLM provider/model override. */
  llm?: NodeLlmConfig;
  /** Memory read/write configuration applied by the runtime around execution. */
  memoryPolicy?: MemoryPolicy;
  /** Dynamic capability discovery configuration applied before execution. */
  discoveryPolicy?: DiscoveryPolicy;
  /** Persona layer configuration injected into the prompt context. */
  personaPolicy?: PersonaPolicy;
  /** Declarative guardrails evaluated on input and/or output payloads. */
  guardrailPolicy?: GuardrailPolicy;
  /**
   * Optional builder-supplied metadata.
   *
   * The runtime currently consumes one well-known key:
   * - `outputAs: string` — when present, the node's successful `output` is
   *   promoted into `state.artifacts[outputAs]` after execution. When
   *   absent, the node's output is promoted into `state.artifacts[id]` by
   *   default. Any executor that explicitly sets `result.artifactsUpdate`
   *   takes precedence over either default.
   *
   * Builders are free to attach additional opaque keys for tooling.
   */
  metadata?: Record<string, unknown>;
}

/**
 * A directed edge connecting two vertices in the compiled execution graph.
 *
 * The `source` and `target` fields may be `START` or `END` sentinels.
 */
export interface GraphEdge {
  /** Unique identifier within the parent `CompiledExecutionGraph`. */
  id: string;
  /** Source node id (or `START`). */
  source: string;
  /** Target node id (or `END`). */
  target: string;
  /**
   * Edge routing strategy:
   * - `static`      — always followed; no condition evaluated.
   * - `conditional` — followed only when `condition` evaluates to this edge's target.
   * - `discovery`   — target is resolved at runtime via capability discovery.
   * - `personality` — target is chosen based on the agent's current trait values.
   */
  type: 'static' | 'conditional' | 'discovery' | 'personality';
  /** Routing predicate; required when `type` is `'conditional'`. */
  condition?: GraphCondition;
  /** Semantic query used to discover the target node at runtime; required for `'discovery'` edges. */
  discoveryQuery?: string;
  /** Capability kind filter applied during discovery-based routing. */
  discoveryKind?: 'tool' | 'skill' | 'extension' | 'any';
  /** Node id used as fallback when discovery resolves no target. */
  discoveryFallback?: string;
  /**
   * Personality-based routing descriptor; required when `type` is `'personality'`.
   * The runtime reads `trait` from the agent's current HEXACO/PAD state and
   * routes to `above` or `below` depending on whether the value exceeds `threshold`.
   */
  personalityCondition?: {
    trait: string;
    threshold: number;
    above: string;
    below: string;
  };
  /** Optional guardrail policy evaluated when traffic crosses this edge. */
  guardrailPolicy?: GuardrailPolicy;
}

// ---------------------------------------------------------------------------
// GraphState
// ---------------------------------------------------------------------------

/**
 * The mutable execution state threaded through every node of a graph run.
 *
 * Generic parameters allow authors to provide precise types for their specific graph.
 * All fields except `scratch` and `artifacts` are managed exclusively by the runtime.
 *
 * @template TInput     - Shape of the initial user-provided input.
 * @template TScratch   - Shape of intermediate computation results passed between nodes.
 * @template TArtifacts - Shape of outputs produced for external consumption.
 */
export interface GraphState<TInput = unknown, TScratch = unknown, TArtifacts = unknown> {
  /** The original user-provided input; frozen after graph start. */
  input: Readonly<TInput>;
  /** Node-to-node communication bag; merged via `StateReducers` after each node. */
  scratch: TScratch;
  /** Read-only memory snapshot populated before each node executes. */
  memory: MemoryView;
  /** Accumulated outputs intended for the caller; merged via `StateReducers` after each node. */
  artifacts: TArtifacts;
  /** Append-only telemetry record updated after each node completes. */
  diagnostics: DiagnosticsView;
  /** Id of the node currently executing (or most recently completed). */
  currentNodeId: string;
  /** Ordered list of node ids that have completed execution in this run. */
  visitedNodes: string[];
  /** Number of times the graph has looped back to a previously visited node. */
  iteration: number;
  /** Id of the most recently persisted checkpoint snapshot, if any. */
  checkpointId?: string;
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/**
 * Named built-in reducer strategies for `GraphState.scratch` and `GraphState.artifacts` fields.
 *
 * - `concat`  — append arrays or concatenate strings.
 * - `merge`   — deep-merge objects (right wins on conflict).
 * - `max`     — keep the larger numeric value.
 * - `min`     — keep the smaller numeric value.
 * - `avg`     — running arithmetic mean.
 * - `sum`     — running total.
 * - `last`    — always overwrite with the latest value (default semantics).
 * - `first`   — keep the first value; ignore subsequent writes.
 * - `longest` — keep the longer string or larger array.
 */
export type BuiltinReducer = 'concat' | 'merge' | 'max' | 'min' | 'avg' | 'sum' | 'last' | 'first' | 'longest';

/**
 * Custom reducer function for a single state field.
 *
 * @param existing - The current field value held in `GraphState`.
 * @param incoming - The new value emitted by the most recently completed node.
 * @returns The merged value to store back into `GraphState`.
 */
export type ReducerFn = (existing: unknown, incoming: unknown) => unknown;

/**
 * Maps dot-notation field paths in `GraphState.scratch` / `GraphState.artifacts` to
 * either a `BuiltinReducer` name or a custom `ReducerFn`.
 *
 * Example:
 * ```ts
 * const reducers: StateReducers = {
 *   'scratch.messages': 'concat',
 *   'artifacts.summary': (a, b) => String(b ?? a),
 * };
 * ```
 */
export interface StateReducers {
  [fieldPath: string]: ReducerFn | BuiltinReducer;
}

// ---------------------------------------------------------------------------
// Metadata types
// ---------------------------------------------------------------------------

/**
 * Lightweight descriptor stored alongside each persisted checkpoint snapshot.
 * Used by the runtime to enumerate and restore checkpoints without deserialising
 * the full `GraphState` payload.
 */
export interface CheckpointMetadata {
  /** Unique checkpoint id (UUIDv4 assigned by the runtime). */
  id: string;
  /** Id of the graph run that produced this checkpoint. */
  runId: string;
  /** Id of the `CompiledExecutionGraph` being executed. */
  graphId: string;
  /** Id of the node that triggered checkpoint persistence. */
  nodeId: string;
  /** Unix epoch milliseconds when the checkpoint was persisted. */
  timestamp: number;
  /** Serialised byte size of the `GraphState` payload. */
  stateSize: number;
  /** Whether a full `MemoryView` snapshot was included in the payload. */
  hasMemorySnapshot: boolean;
}

/**
 * Complete inspection record for an in-progress or finished graph run.
 * Returned by the runtime's run-management API.
 */
export interface RunInspection {
  /** Unique run id (UUIDv4 assigned when the run was started). */
  runId: string;
  /** Id of the `CompiledExecutionGraph` being executed. */
  graphId: string;
  /** Current lifecycle phase of the run. */
  status: 'running' | 'completed' | 'errored' | 'interrupted';
  /** Id of the node currently executing; absent when `status` is terminal. */
  currentNodeId?: string;
  /** Ordered list of node ids that have completed execution. */
  visitedNodes: string[];
  /** Ordered stream of runtime events emitted during the run (type: `GraphEvent[]`). */
  events: unknown[]; // Forward reference — GraphEvent will be defined in the event subsystem
  /** All checkpoint snapshots persisted during the run. */
  checkpoints: CheckpointMetadata[];
  /** Accumulated diagnostic telemetry. */
  diagnostics: DiagnosticsView;
  /** Final output value; only present when `status` is `'completed'`. */
  finalOutput?: unknown;
  /** Structured error detail; only present when `status` is `'errored'`. */
  error?: { message: string; code: string; nodeId?: string };
}

// ---------------------------------------------------------------------------
// CompiledExecutionGraph — root IR type
// ---------------------------------------------------------------------------

/**
 * The fully compiled, execution-ready representation of an agent graph.
 *
 * All three authoring APIs (AgentGraph builder, workflow DSL, mission planner) produce
 * a `CompiledExecutionGraph` as their final compilation artefact.  The runtime never
 * interprets authoring-API-specific constructs — it operates exclusively on this type.
 */
export interface CompiledExecutionGraph {
  /** Stable, globally unique graph identifier (slug or UUIDv4). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** All vertices, including any `START`/`END` bridge nodes inserted by the compiler. */
  nodes: GraphNode[];
  /** All directed edges, including static entry/exit edges from/to `START`/`END`. */
  edges: GraphEdge[];
  /**
   * JSON-Schema-compatible schema declarations for the three `GraphState` generics.
   * Used by the runtime for validation and by tooling for type generation.
   */
  stateSchema: {
    input: Record<string, unknown>;
    scratch: Record<string, unknown>;
    artifacts: Record<string, unknown>;
  };
  /** Field-level reducer configuration applied after each node completes. */
  reducers: StateReducers;
  /**
   * Graph-wide default checkpoint persistence policy.
   * Per-node `GraphNode.checkpoint` settings override this default.
   *
   * - `every_node` — persist after every node (safe, high storage cost).
   * - `explicit`   — persist only for nodes that declare `checkpoint !== 'none'`.
   * - `none`       — never persist (lowest overhead; no recovery on crash).
   */
  checkpointPolicy: 'every_node' | 'explicit' | 'none';
  /** Graph-wide memory consistency mode; may be overridden per-node via `MemoryPolicy.consistency`. */
  memoryConsistency: MemoryConsistencyMode;
}
