/**
 * @file WorkflowBuilder.ts
 * @description Fluent DSL for authoring deterministic, acyclic workflow graphs.
 *
 * `workflow()` is the sequential/pipeline-oriented authoring API in the AgentOS
 * Unified Orchestration Layer. Unlike `AgentGraph` (which allows arbitrary directed
 * graphs including cycles), every workflow is a strict DAG — cycles are detected and
 * rejected at compile time.
 *
 * Supported step primitives:
 * - `step()` / `then()` — a single named node (tool, GMI, or human).
 * - `branch()` — a router + fan-out; branches rejoin at the next step.
 * - `parallel()` — fan-out to N concurrent nodes that rejoin via merge reducers.
 *
 * All GMI steps default to `executionMode: 'single_turn'` to keep workflows
 * deterministic and cost-bounded.
 *
 * @example
 * ```ts
 * const wf = workflow('summarize-and-tag')
 *   .input(z.object({ text: z.string() }))
 *   .returns(z.object({ summary: z.string(), tags: z.array(z.string()) }))
 *   .step('fetch', { tool: 'web_fetch' })
 *   .step('summarize', { gmi: { instructions: 'Summarize the document.' } })
 *   .compile();
 *
 * const result = await wf.invoke({ text: 'hello world' });
 * ```
 */

import type {
  GraphNode,
  GraphEdge,
  CompiledExecutionGraph,
  StateReducers,
  MemoryPolicy,
  DiscoveryPolicy,
  GuardrailPolicy,
  VoiceNodeConfig,
  BuiltinReducer,
  ReducerFn,
} from '../ir/types.js';
import { START, END } from '../ir/types.js';
import type { VoiceTransportConfig } from '../runtime/VoiceTransportAdapter.js';
import { gmiNode, toolNode, humanNode } from './nodes.js';
import type { ICheckpointStore } from '../checkpoint/ICheckpointStore.js';
import { InMemoryCheckpointStore } from '../checkpoint/InMemoryCheckpointStore.js';
import { GraphCompiler } from '../compiler/GraphCompiler.js';
import { GraphValidator } from '../compiler/Validator.js';
import { GraphRuntime } from '../runtime/GraphRuntime.js';
import { NodeExecutor, type NodeExecutorDeps } from '../runtime/NodeExecutor.js';
import type { GraphEvent } from '../events/GraphEvent.js';

/**
 * Public alias for the dependency-injection surface accepted by every
 * compiled-workflow runtime.
 *
 * Mirrors the internal `NodeExecutorDeps` interface from `NodeExecutor`. All
 * fields are optional: callers wire in only the executors their nodes
 * actually need (`toolOrchestrator` for tool nodes, `loopController` +
 * `providerCall` for GMI nodes, etc.). Missing executors cause the
 * corresponding node type to fail with `success: false` rather than a hard
 * throw, matching the runtime's graceful-degradation contract.
 */
export type WorkflowRuntimeDeps = NodeExecutorDeps;

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------

/**
 * Configuration for a single workflow step node.
 *
 * Exactly one of `tool`, `gmi`, `human`, `extension`, or `subgraph` must be provided
 * to specify the execution strategy.  All remaining fields are optional policies.
 */
export interface StepConfig {
  /** Name of a registered `ITool` to invoke. */
  tool?: string;
  /**
   * General Model Invocation config. `executionMode` is always overridden to
   * `'single_turn'` inside a workflow to keep execution deterministic.
   */
  gmi?: {
    instructions: string;
    /** Ignored at runtime — always coerced to `'single_turn'` by the workflow compiler. */
    executionMode?: 'single_turn';
    /** Hard cap on LLM output tokens for this step. */
    maxTokens?: number;
  };
  /** Human-in-the-loop step; suspends the run until a human provides a response. */
  human?: { prompt: string };
  /** Call a method on a registered extension. */
  extension?: { extensionId: string; method: string };
  /** Delegate to a previously compiled sub-workflow or agent graph. */
  subgraph?: CompiledExecutionGraph;
  /** Memory read/write policy for this step. */
  memory?: MemoryPolicy;
  /** Capability discovery policy applied before execution. */
  discovery?: DiscoveryPolicy;
  /** Declarative guardrail policy applied to input and/or output. */
  guardrails?: GuardrailPolicy;
  /** When `true`, execution suspends and waits for human approval before proceeding. */
  requiresApproval?: boolean;
  /** What to do when the step fails. */
  onFailure?: 'abort' | 'skip' | 'retry';
  /** Automatic retry configuration. Only used when `onFailure` is `'retry'`. */
  retryPolicy?: {
    maxAttempts: number;
    backoff: 'fixed' | 'linear' | 'exponential';
    backoffMs: number;
  };
  /** Maximum wall-clock execution time in milliseconds. */
  timeout?: number;
  /** Side-effect classification used by the runtime for scheduling decisions. */
  effectClass?: 'pure' | 'read' | 'write' | 'external' | 'human';
  /**
   * Optional artifact key name. When set, this step's successful `output`
   * is promoted into `state.artifacts[outputAs]` (the value returned from
   * `invoke()`). When omitted, the step's output is promoted into
   * `state.artifacts[<stepId>]` by default. Use this to make your final
   * step populate a key that matches the shape of your `.returns()`
   * schema — e.g. `step('publish', { tool: '...', outputAs: 'publishedTo' })`
   * when `.returns(z.object({ publishedTo: z.array(z.string()) }))`.
   */
  outputAs?: string;
  /**
   * Voice pipeline node configuration.
   * When provided alongside `executorConfig.type: 'voice'`, these settings are
   * forwarded to the VoiceNodeExecutor.  Typically set via the `voiceNode()`
   * builder rather than directly through `StepConfig`.
   */
  voice?: VoiceNodeConfig;
}

// ---------------------------------------------------------------------------
// Internal step representation
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the three step kinds the builder collects
 * before lowering to IR nodes and edges during `compile()`.
 *
 * @internal
 */
type InternalStep =
  | { kind: 'step'; id: string; config: StepConfig }
  | {
      kind: 'branch';
      condition: (state: any) => string;
      routes: Record<string, StepConfig>;
    }
  | {
      kind: 'parallel';
      steps: StepConfig[];
      join: {
        strategy: 'all' | 'any' | 'quorum';
        quorumCount?: number;
        merge: Record<string, BuiltinReducer | ReducerFn>;
        timeout?: number;
      };
    };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `WorkflowBuilder` with the given human-readable name.
 *
 * @param name - Display name embedded in the compiled `CompiledExecutionGraph`.
 * @returns A fresh `WorkflowBuilder` instance.
 *
 * @example
 * ```ts
 * const wf = workflow('my-pipeline')
 *   .input(z.object({ query: z.string() }))
 *   .returns(z.object({ answer: z.string() }))
 *   .step('search', { tool: 'web_search' })
 *   .step('answer', { gmi: { instructions: 'Answer the question.' } })
 *   .compile();
 * ```
 */
export function workflow(name: string): WorkflowBuilder {
  return new WorkflowBuilder(name);
}

// ---------------------------------------------------------------------------
// WorkflowBuilder
// ---------------------------------------------------------------------------

/**
 * Fluent builder for deterministic DAG workflows.
 *
 * Steps are appended in declaration order and connected sequentially. Branch and
 * parallel primitives fan out and automatically rejoin at the next declared step.
 *
 * Call `.compile()` to validate the graph (must be acyclic) and obtain a
 * `CompiledWorkflow` ready for `invoke()`, `stream()`, or `resume()`.
 */
export class WorkflowBuilder {
  /** Zod schema (or any plain object) representing `GraphState.input`. */
  private inputSchema: any;
  /** Zod schema (or any plain object) representing `GraphState.artifacts`. */
  private returnsSchema: any;
  /** Ordered list of steps declared by the author. */
  private steps: InternalStep[] = [];
  /** Human-readable name forwarded to the compiled graph. */
  private readonly name: string;
  /**
   * Optional transport configuration set via {@link transport}.
   * When present, the compiled workflow is associated with a transport backend
   * (e.g. a voice pipeline) that intercepts graph I/O at runtime.
   */
  private _transportConfig: ({ type: string } & Omit<VoiceTransportConfig, 'type'>) | undefined;

  /**
   * @param name - Human-readable workflow name.
   */
  constructor(name: string) {
    this.name = name;
  }

  // -------------------------------------------------------------------------
  // Schema declarations
  // -------------------------------------------------------------------------

  /**
   * Declare the input schema for this workflow.
   *
   * Accepts a Zod schema or any plain object; the value is forwarded to
   * `GraphCompiler` which lowers it to JSON Schema via `lowerZodToJsonSchema`.
   *
   * @param schema - Input schema (Zod instance or plain JSON Schema object).
   */
  input(schema: any): this {
    this.inputSchema = schema;
    return this;
  }

  /**
   * Declare the return (output artifacts) schema for this workflow.
   *
   * @param schema - Output schema (Zod instance or plain JSON Schema object).
   */
  returns(schema: any): this {
    this.returnsSchema = schema;
    return this;
  }

  /**
   * Attach a transport backend to this workflow.
   *
   * When `type` is `'voice'`, the compiled workflow will route graph I/O
   * through the voice transport adapter at runtime. The `config` values
   * override per-field defaults from `agent.config.json`.
   *
   * The transport config is stored as `_transportConfig` on the builder
   * instance and is available for inspection or forwarding to the runtime.
   *
   * @param type   - Transport kind; currently only `'voice'` is supported.
   * @param config - Optional voice pipeline overrides (STT, TTS, voice, etc.).
   * @returns `this` for fluent chaining.
   *
   * @example
   * ```typescript
   * const wf = workflow('voice-flow')
   *   .input(inputSchema)
   *   .returns(outputSchema)
   *   .transport('voice', { stt: 'deepgram', tts: 'openai', voice: 'alloy' })
   *   .step('listen', { tool: 'listen_tool' })
   *   .compile();
   * ```
   */
  transport(type: 'voice', config?: Omit<VoiceTransportConfig, 'type'>): this {
    (this as any)._transportConfig = { type, ...config };
    return this;
  }

  // -------------------------------------------------------------------------
  // Step primitives
  // -------------------------------------------------------------------------

  /**
   * Append a single named step to the workflow.
   *
   * The step is connected from all current tail nodes and becomes the new
   * single-element tail after it is added.
   *
   * @param id     - Unique step identifier within this workflow.
   * @param config - Execution and policy configuration for the step.
   */
  step(id: string, config: StepConfig): this {
    this.steps.push({ kind: 'step', id, config });
    return this;
  }

  /**
   * Alias for `step()` — reads more naturally when chaining sequential steps.
   *
   * @param id     - Unique step identifier.
   * @param config - Execution and policy configuration.
   */
  then(id: string, config: StepConfig): this {
    return this.step(id, config);
  }

  /**
   * Append a conditional branch to the workflow.
   *
   * The `condition` function is evaluated at runtime against `GraphState` and must
   * return one of the keys of `routes`. Each route becomes its own branch node; all
   * branches become the collective tail that the next declared step connects from.
   *
   * @param condition - Routing function; return value must match a key in `routes`.
   * @param routes    - Map of route key → step config for each branch arm.
   */
  branch(condition: (state: any) => string, routes: Record<string, StepConfig>): this {
    this.steps.push({ kind: 'branch', condition, routes });
    return this;
  }

  /**
   * Append a parallel fan-out to the workflow.
   *
   * All `steps` execute concurrently (subject to runtime scheduling). After all
   * branches complete, their outputs are merged using the `join.merge` reducers.
   * The parallel branch nodes collectively become the new tail.
   *
   * @param steps - Array of step configs to execute concurrently.
   * @param join  - Fan-in configuration including merge strategy and reducers.
   */
  parallel(
    steps: StepConfig[],
    join: {
      strategy: 'all' | 'any' | 'quorum';
      quorumCount?: number;
      merge: Record<string, BuiltinReducer | ReducerFn>;
      timeout?: number;
    }
  ): this {
    this.steps.push({ kind: 'parallel', steps, join });
    return this;
  }

  // -------------------------------------------------------------------------
  // Compilation
  // -------------------------------------------------------------------------

  /**
   * Compile the workflow into an executable `CompiledWorkflow`.
   *
   * Compilation steps:
   * 1. Validate that `.input()` and `.returns()` schemas were declared.
   * 2. Lower each `InternalStep` into `GraphNode` + `GraphEdge` IR objects,
   *    threading `tailNodeIds` to connect steps sequentially.
   * 3. Connect all final tail nodes to `END`.
   * 4. Run `GraphCompiler.compile()` to produce a `CompiledExecutionGraph`.
   * 5. Run `GraphValidator.validate()` with `{ requireAcyclic: true }` — throws on cycle.
   * 6. Wrap in a `CompiledWorkflow` with a `GraphRuntime` backed by the given store.
   *
   * @param options - Optional compilation options.
   * @throws {Error} When `.input()` or `.returns()` was not called.
   * @throws {Error} When the compiled graph contains a cycle (should never happen via this API).
   */
  compile(options?: {
    /** Custom checkpoint persistence backend; defaults to `InMemoryCheckpointStore`. */
    checkpointStore?: ICheckpointStore;
    /**
     * Runtime-execution dependencies forwarded to the underlying
     * `NodeExecutor`. Wire in `toolOrchestrator` for `tool` nodes,
     * `loopController` + `providerCall` for `gmi` nodes,
     * `extensionExecutor` for `extension` nodes, etc. Without these, the
     * matching node types fail with `success: false`.
     *
     * @see {@link WorkflowRuntimeDeps}
     */
    deps?: WorkflowRuntimeDeps;
  }): CompiledWorkflow {
    if (!this.inputSchema) {
      throw new Error('workflow() requires .input() schema — input is required');
    }
    if (!this.returnsSchema) {
      throw new Error('workflow() requires .returns() schema — returns is required');
    }

    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const reducers: StateReducers = {};
    let edgeCounter = 0;
    const nextEdgeId = () => `we-${++edgeCounter}`;

    /**
     * The set of node ids that the *next* step should connect FROM.
     * Starts at [START]; branches and parallel steps update this to fan-out tails.
     */
    let tailNodeIds: string[] = [START];

    for (const internalStep of this.steps) {
      if (internalStep.kind === 'step') {
        // ── Sequential step ────────────────────────────────────────────────
        const node = this.configToNode(internalStep.id, internalStep.config);
        nodes.set(internalStep.id, node);

        for (const tail of tailNodeIds) {
          edges.push({
            id: nextEdgeId(),
            source: tail,
            target: internalStep.id,
            type: 'static',
          });
        }
        tailNodeIds = [internalStep.id];
      } else if (internalStep.kind === 'branch') {
        // ── Router + fan-out ───────────────────────────────────────────────
        // Insert a pure router node that evaluates the condition.
        const routerId = `router-${++edgeCounter}`;
        const routerNode: GraphNode = {
          id: routerId,
          type: 'router',
          executorConfig: {
            type: 'router',
            condition: { type: 'function', fn: internalStep.condition },
          },
          executionMode: 'single_turn',
          effectClass: 'pure',
          checkpoint: 'none',
        };
        nodes.set(routerId, routerNode);

        // Connect all current tails to the router.
        for (const tail of tailNodeIds) {
          edges.push({
            id: nextEdgeId(),
            source: tail,
            target: routerId,
            type: 'static',
          });
        }

        // Create a branch node per route and wire conditional edges from the router.
        const branchTails: string[] = [];
        for (const [routeKey, config] of Object.entries(internalStep.routes)) {
          const branchId = `branch-${routeKey}-${++edgeCounter}`;
          const branchNode = this.configToNode(branchId, config);
          nodes.set(branchId, branchNode);

          // Capture routeKey for the closure.
          const capturedRouteKey = routeKey;
          const capturedCondition = internalStep.condition;

          edges.push({
            id: nextEdgeId(),
            source: routerId,
            target: branchId,
            type: 'conditional',
            condition: {
              type: 'function',
              /**
               * Returns `branchId` only when the router condition resolves to this
               * branch's route key; otherwise returns an empty string so the runtime
               * skips this edge.
               */
              fn: (state: any): string => {
                const resolved = capturedCondition(state);
                return resolved === capturedRouteKey ? branchId : '';
              },
            },
          });

          branchTails.push(branchId);
        }

        // All branch leaves become the new tail for the next step.
        tailNodeIds = branchTails;
      } else if (internalStep.kind === 'parallel') {
        // ── Parallel fan-out ───────────────────────────────────────────────
        const parallelTails: string[] = [];

        for (let i = 0; i < internalStep.steps.length; i++) {
          const pId = `parallel-${i}-${++edgeCounter}`;
          const pNode = this.configToNode(pId, internalStep.steps[i]);
          nodes.set(pId, pNode);

          // Each parallel branch connects from all current tails.
          for (const tail of tailNodeIds) {
            edges.push({
              id: nextEdgeId(),
              source: tail,
              target: pId,
              type: 'static',
            });
          }

          parallelTails.push(pId);
        }

        // Register field-level merge reducers from the join config.
        for (const [field, reducer] of Object.entries(internalStep.join.merge)) {
          reducers[field] = reducer;
        }

        // All parallel branches become the new tail.
        tailNodeIds = parallelTails;
      }
    }

    // Connect all remaining tail nodes to the END sentinel.
    for (const tail of tailNodeIds) {
      edges.push({
        id: nextEdgeId(),
        source: tail,
        target: END,
        type: 'static',
      });
    }

    // ── Compile ────────────────────────────────────────────────────────────
    const ir = GraphCompiler.compile({
      name: this.name,
      nodes,
      edges,
      stateSchema: {
        input: this.inputSchema,
        scratch: this.inputSchema, // scratch mirrors input shape by default
        artifacts: this.returnsSchema,
      },
      reducers,
      memoryConsistency: 'snapshot',
      checkpointPolicy: 'every_node',
    });

    // ── Validate: workflows MUST be acyclic ───────────────────────────────
    const result = GraphValidator.validate(ir, { requireAcyclic: true });
    if (!result.valid) {
      throw new Error(`Workflow validation failed: ${result.errors.join('; ')}`);
    }

    const store = options?.checkpointStore ?? new InMemoryCheckpointStore();
    return new CompiledWorkflow(ir, store, options?.deps);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Lower a `StepConfig` into a `GraphNode` with the given `id`.
   *
   * Priority order for executor type selection:
   * `tool` → `gmi` → `human` → `extension` → `subgraph` → fallback tool node.
   *
   * GMI nodes always receive `executionMode: 'single_turn'` regardless of what
   * the author specified in `config.gmi.executionMode`.
   *
   * @param id     - Node id to assign.
   * @param config - Caller-supplied step configuration.
   * @returns A fully constructed `GraphNode` ready for the IR.
   */
  private configToNode(id: string, config: StepConfig): GraphNode {
    // Attach `outputAs` to the node's metadata so the runtime knows which
    // artifact key to populate after a successful execution. The runtime
    // falls back to using `id` when `outputAs` is missing, which is what
    // gives `state.artifacts[stepId] = output` as the default behavior.
    const metadata = config.outputAs ? { outputAs: config.outputAs } : undefined;

    if (config.tool) {
      return {
        ...toolNode(
          config.tool,
          {
            timeout: config.timeout,
            retryPolicy: config.retryPolicy as any,
          },
          {
            effectClass: config.effectClass,
            memory: config.memory,
            discovery: config.discovery,
            guardrails: config.guardrails,
          }
        ),
        id,
        ...(metadata ? { metadata } : {}),
      };
    }

    if (config.gmi) {
      return {
        ...gmiNode(
          {
            instructions: config.gmi.instructions,
            executionMode: 'single_turn', // Always single_turn in workflow()
            maxTokens: config.gmi.maxTokens,
          },
          {
            memory: config.memory,
            guardrails: config.guardrails,
          }
        ),
        id,
        ...(metadata ? { metadata } : {}),
      };
    }

    if (config.human) {
      return {
        ...humanNode({ prompt: config.human.prompt, timeout: config.timeout }),
        id,
        ...(metadata ? { metadata } : {}),
      };
    }

    if (config.extension) {
      // Extension nodes are represented as GraphNode with extension executorConfig.
      return {
        id,
        type: 'extension',
        executorConfig: {
          type: 'extension',
          extensionId: config.extension.extensionId,
          method: config.extension.method,
        },
        executionMode: 'single_turn',
        effectClass: config.effectClass ?? 'external',
        timeout: config.timeout,
        checkpoint: 'none',
        memoryPolicy: config.memory,
        guardrailPolicy: config.guardrails,
        ...(metadata ? { metadata } : {}),
      };
    }

    if (config.subgraph) {
      return {
        id,
        type: 'subgraph',
        executorConfig: {
          type: 'subgraph',
          graphId: config.subgraph.id,
        },
        executionMode: 'single_turn',
        effectClass: config.effectClass ?? 'read',
        checkpoint: 'none',
        ...(metadata ? { metadata } : {}),
      };
    }

    if (config.voice) {
      // Voice pipeline node: runs a bidirectional STT/TTS session with configurable
      // turn limits and exit conditions.  Uses `react_bounded` execution mode to
      // model the multi-turn interaction loop within a single graph node.
      return {
        id,
        type: 'voice' as const,
        executorConfig: {
          type: 'voice' as const,
          voiceConfig: config.voice,
        },
        executionMode: 'react_bounded',
        effectClass: config.effectClass ?? 'external',
        timeout: config.timeout,
        checkpoint: 'before',
        memoryPolicy: config.memory,
        guardrailPolicy: config.guardrails,
        ...(metadata ? { metadata } : {}),
      };
    }

    // Fallback: treat as a no-op tool node.
    return {
      ...toolNode('unknown', { timeout: config.timeout }),
      id,
    };
  }
}

// ---------------------------------------------------------------------------
// CompiledWorkflow
// ---------------------------------------------------------------------------

/**
 * An execution-ready workflow produced by `WorkflowBuilder.compile()`.
 *
 * Wraps a `CompiledExecutionGraph` and a `GraphRuntime`, exposing the same
 * three execution modes as the raw runtime:
 *
 * - `invoke(input)` — run to completion and return final artifacts.
 * - `stream(input)` — run while yielding `GraphEvent` values at each step.
 * - `resume(checkpointId)` — restore an interrupted run from a checkpoint.
 */
export class CompiledWorkflow {
  /** Underlying execution runtime. */
  private readonly runtime: GraphRuntime;

  /**
   * @param ir              - The compiled execution graph (produced by `GraphCompiler`).
   * @param checkpointStore - Checkpoint persistence backend.
   * @param deps            - Optional runtime executors forwarded to `NodeExecutor`.
   *                          Defaults to an empty object (no executors), in which
   *                          case `tool` / `gmi` / `extension` nodes degrade to
   *                          `success: false`. See {@link WorkflowRuntimeDeps}.
   */
  constructor(
    private readonly ir: CompiledExecutionGraph,
    checkpointStore: ICheckpointStore,
    deps: WorkflowRuntimeDeps = {},
  ) {
    this.runtime = new GraphRuntime({
      checkpointStore,
      nodeExecutor: new NodeExecutor(deps),
    });
  }

  /**
   * Execute the workflow to completion and return the final `artifacts` payload.
   *
   * @param input - Must conform to the schema declared via `.input()`.
   * @returns The `GraphState.artifacts` value after all nodes complete.
   */
  async invoke(input: unknown): Promise<unknown> {
    return this.runtime.invoke(this.ir, input);
  }

  /**
   * Execute the workflow while yielding `GraphEvent` values at each step boundary.
   *
   * @param input - Must conform to the schema declared via `.input()`.
   * @yields {GraphEvent} Runtime events in causal order.
   */
  async *stream(input: unknown): AsyncIterable<GraphEvent> {
    yield* this.runtime.stream(this.ir, input);
  }

  /**
   * Resume a previously interrupted workflow run from its latest checkpoint.
   *
   * @param checkpointId - Either the original run id or an exact checkpoint id.
   * @returns The final `GraphState.artifacts` value after resumption completes.
   */
  async resume(checkpointId: string): Promise<unknown> {
    return this.runtime.resume(this.ir, checkpointId);
  }

  /**
   * Expose the compiled IR for inspection, serialisation, or subgraph composition.
   *
   * @returns The underlying `CompiledExecutionGraph`.
   */
  toIR(): CompiledExecutionGraph {
    return this.ir;
  }
}
