/**
 * @file NodeExecutor.ts
 * @description Dispatches execution to the appropriate handler based on `GraphNode.executorConfig.type`.
 *
 * The executor is intentionally thin — it contains no retry logic (handled by `GraphRuntime`),
 * no state mutation (handled by `StateManager`), and no event emission (handled by the caller).
 * Each private method maps one-to-one with a `NodeExecutorConfig` variant.
 *
 * Execution flow:
 *   `execute()` → optional timeout race → `executeNode()` → variant handler
 *
 * Placeholders for `gmi`, `extension`, and `subgraph` nodes are wired in `GraphRuntime`
 * after the `LoopController` and extension managers are available.
 */

import type { GraphNode, GraphState, GraphCondition, CompiledExecutionGraph, JudgeNodeConfig } from '../ir/types.js';
import { resolveJudgeLlm } from '../../core/llm/providers/judge-config.js';
import type {
  GraphEvent,
  MissionExpansionTrigger,
  MissionGraphPatch,
} from '../events/GraphEvent.js';
import type { LoopController, LoopChunk, LoopOutput } from './LoopController.js';
import type { VoiceNodeExecutor } from './VoiceNodeExecutor.js';
import { safeEvaluateExpression } from './safeExpressionEvaluator.js';

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/**
 * The normalised result returned by every `NodeExecutor.execute()` call regardless
 * of which executor variant was dispatched.
 *
 * The runtime inspects these fields to decide the next graph step:
 * - `success`          — whether the node completed without error.
 * - `output`           — arbitrary payload produced by the node (tool result, LLM response, etc.).
 * - `error`            — human-readable error message; only present when `success` is `false`.
 * - `routeTarget`      — next node id determined by a `router` or `guardrail` node.
 * - `scratchUpdate`    — partial object merged into `GraphState.scratch` by `StateManager`.
 * - `artifactsUpdate`  — partial object merged into `GraphState.artifacts` by `StateManager`.
 * - `events`           — additional `GraphEvent` values the executor wants the runtime to emit.
 * - `interrupt`        — when `true`, the runtime suspends the run and waits for human input.
 */
export interface NodeExecutionResult {
  /** Whether the node completed successfully. */
  success: boolean;
  /** Arbitrary output produced by the node. */
  output?: unknown;
  /** Human-readable error description; populated only when `success` is `false`. */
  error?: string;
  /** Target node id returned by `router` or guardrail rerouting. */
  routeTarget?: string;
  /** Partial update to merge into `GraphState.scratch`. */
  scratchUpdate?: Record<string, unknown>;
  /** Partial update to merge into `GraphState.artifacts`. */
  artifactsUpdate?: Record<string, unknown>;
  /** Extra runtime events the executor wants to surface to callers. */
  events?: GraphEvent[];
  /** Mission graph expansion requests emitted by this node's tool usage. */
  expansionRequests?: Array<{
    trigger: MissionExpansionTrigger;
    reason: string;
    request: unknown;
    patch?: MissionGraphPatch;
  }>;
  /** When `true`, the runtime must suspend and await human resolution. */
  interrupt?: boolean;
  /**
   * Optional per-executor telemetry surfaced on the `node_end` event.
   * Populated today by the GMI executor (iteration / tool-call counters);
   * other executors leave it undefined.
   */
  metadata?: import('../events/GraphEvent.js').NodeTelemetry;
}

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

/**
 * External dependencies injected into `NodeExecutor` at construction time.
 *
 * Using an interface rather than concrete types keeps the executor decoupled from
 * the full `ToolOrchestrator` and `GuardrailEngine` implementations and makes the
 * unit-test surface minimal.
 *
 * GMI / extension / subgraph managers are omitted here and wired by `GraphRuntime`
 * once those subsystems are available.
 */
export interface NodeExecutorDeps {
  /**
   * Routes tool-call requests to registered `ITool` implementations.
   * When absent, any `tool` node will resolve with `success: false`.
   */
  toolOrchestrator?: {
    /**
     * Process a single tool call and return its result.
     *
     * @param details - Wrapper containing `toolCallRequest.toolName` and `toolCallRequest.arguments`.
     * @returns Promise resolving to an object with at least `output` and `isError` / `success`.
     */
    processToolCall(details: {
      toolCallRequest: { toolName: string; arguments: Record<string, unknown> };
    }): Promise<{ success?: boolean; isError?: boolean; output?: unknown; error?: string }>;
  };

  /**
   * Evaluates one or more named guardrails against a content payload.
   * When absent, guardrail nodes are treated as always-passing.
   */
  guardrailEngine?: {
    /**
     * Run all listed guardrails against `content` and return a combined verdict.
     *
     * @param content      - The payload to evaluate (typically `GraphState.scratch`).
     * @param guardrailIds - Ordered list of guardrail identifiers to run.
     * @returns Aggregated result with `passed` flag and per-guardrail `results`.
     */
    evaluate(
      content: unknown,
      guardrailIds: string[],
    ): Promise<{ passed: boolean; results: unknown[] }>;
  };

  /**
   * LoopController for GMI node execution. When provided alongside `providerCall`,
   * GMI nodes delegate to the LoopController's ReAct loop instead of returning a placeholder.
   */
  loopController?: LoopController;

  /**
   * Provider-specific LLM call that returns a streaming async generator.
   * Used by GMI nodes to produce text via the LoopController.
   *
   * @param instructions - System instructions from the GMI node config.
   * @param state        - Current graph state for context injection.
   * @returns Async generator yielding LoopChunks and returning a LoopOutput.
   */
  providerCall?: (instructions: string, state: Partial<GraphState>) => AsyncGenerator<LoopChunk, LoopOutput, undefined>;

  /**
   * Resolves a subgraph id to its compiled execution graph for recursive invocation.
   * When absent, subgraph nodes return a placeholder.
   */
  subgraphResolver?: (graphId: string) => CompiledExecutionGraph | undefined;

  /**
   * Factory that creates a GraphRuntime for subgraph execution.
   * Injected to avoid circular imports between NodeExecutor and GraphRuntime.
   */
  createSubgraphRuntime?: (graph: CompiledExecutionGraph) => {
    invoke(graph: CompiledExecutionGraph, input: unknown): Promise<unknown>;
  };

  /**
   * Executes an extension method by ID. When absent, extension nodes return a placeholder.
   *
   * @param extensionId - The registered extension identifier.
   * @param method      - The method name to invoke on the extension.
   * @param input       - Input data passed to the extension method.
   * @returns Promise resolving to the extension's output.
   */
  extensionExecutor?: (
    extensionId: string,
    method: string,
    input: unknown,
  ) => Promise<{ success: boolean; output?: unknown; error?: string }>;

  /**
   * Executor for `voice` nodes. Manages voice pipeline sessions, turn collection,
   * and exit-condition racing. When absent, voice nodes return `success: false`.
   */
  voiceExecutor?: VoiceNodeExecutor;
}

// ---------------------------------------------------------------------------
// NodeExecutor
// ---------------------------------------------------------------------------

/**
 * Stateless executor that dispatches a `GraphNode` to the appropriate handler.
 *
 * One `NodeExecutor` instance is typically shared across the lifetime of a `GraphRuntime`
 * and reused for every node invocation within every run. All state is passed through
 * `GraphState` and returned via `NodeExecutionResult`.
 *
 * @example
 * ```ts
 * const executor = new NodeExecutor({ toolOrchestrator, guardrailEngine });
 * const result = await executor.execute(node, graphState);
 * if (!result.success) console.error(result.error);
 * ```
 */
export class NodeExecutor {
  /**
   * @param deps - External service adapters. All fields are optional; missing services
   *               cause graceful degradation rather than hard failures.
   */
  constructor(private readonly deps: NodeExecutorDeps) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute `node` against the provided `state`, optionally racing against a timeout.
   *
   * If `node.timeout` is set, execution races against a timer that resolves with a
   * `success: false` result after the specified number of milliseconds.
   *
   * For `human` nodes with an `onTimeout` directive, the timeout result is modified:
   * - `'accept'` — auto-accept on timeout.
   * - `'reject'` — auto-reject on timeout.
   * - `'error'`  — standard timeout error (default behaviour for all node types).
   *
   * @param node  - Immutable node descriptor from the compiled graph IR.
   * @param state - Current (partial) graph state threaded from the runtime.
   * @returns A `NodeExecutionResult` describing the outcome.
   */
  async execute(node: GraphNode, state: Partial<GraphState>): Promise<NodeExecutionResult> {
    if (node.timeout) {
      const result = await Promise.race([
        this.executeNode(node, state),
        this.buildTimeoutPromise(node.timeout, node.id),
      ]);

      // When a human node times out and has an onTimeout directive, translate
      // the generic timeout failure into the requested resolution.
      if (
        !result.success &&
        result.error?.includes('timeout') &&
        node.executorConfig.type === 'human'
      ) {
        const onTimeout = (node.executorConfig as { onTimeout?: string }).onTimeout;
        if (onTimeout === 'accept') {
          const timeoutAcceptResult: NodeExecutionResult = {
            success: true,
            output: { approved: true, decidedBy: 'timeout-accept' },
          };
          const guardrailCheck = await this.runHumanNodeGuardrails(
            node.id,
            node.executorConfig as { guardrailOverride?: boolean; prompt: string },
            timeoutAcceptResult.output as Record<string, unknown>,
          );
          return guardrailCheck ?? timeoutAcceptResult;
        }
        if (onTimeout === 'reject') {
          return {
            success: true,
            output: { approved: false, reason: 'Timed out', decidedBy: 'timeout-reject' },
          };
        }
        // 'error' (or undefined) — fall through to the default timeout failure.
      }

      return result;
    }
    return this.executeNode(node, state);
  }

  // ---------------------------------------------------------------------------
  // Internal dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatches to the correct private handler based on `executorConfig.type`.
   *
   * Each branch receives only the narrowed config type it needs, keeping handler
   * signatures precise and avoiding accidental access to unrelated fields.
   */
  private async executeNode(
    node: GraphNode,
    state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    const config = node.executorConfig;

    switch (config.type) {
      case 'tool':
        return this.executeTool(config, state);

      case 'router':
        return this.executeRouter(config, state);

      case 'guardrail':
        return this.executeGuardrail(config, state);

      case 'human':
        return this.executeHuman(node.id, config);

      case 'gmi':
        return this.executeGmi(config, state);

      case 'extension':
        return this.executeExtension(config, state);

      case 'subgraph':
        return this.executeSubgraph(config, state);

      case 'voice':
        if (!this.deps.voiceExecutor) {
          return { success: false, error: 'VoiceNodeExecutor not configured' };
        }
        return this.deps.voiceExecutor.execute(node, state);
    }
  }

  // ---------------------------------------------------------------------------
  // Variant handlers
  // ---------------------------------------------------------------------------

  /**
   * Invokes a registered `ITool` via `ToolOrchestrator.processToolCall()`.
   *
   * Static args from `config.args` are merged into the call. The orchestrator
   * is responsible for argument validation and schema enforcement.
   *
   * @param config - `{ type: 'tool'; toolName: string; args?: Record<string, unknown> }`
   * @param state  - Current graph state (not used directly but available for future extension).
   */
  private async executeTool(
    config: { type: 'tool'; toolName: string; args?: Record<string, unknown> },
    _state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    if (!this.deps.toolOrchestrator) {
      return {
        success: false,
        error: 'No ToolOrchestrator configured',
      };
    }

    const result = await this.deps.toolOrchestrator.processToolCall({
      toolCallRequest: {
        toolName: config.toolName,
        arguments: config.args ?? {},
      },
    });

    return {
      success: result.success ?? !result.isError,
      output: result.output,
      error: result.error,
    };
  }

  /**
   * Evaluates a `GraphCondition` and returns the resolved target node id as `routeTarget`.
   *
   * Two condition strategies are supported:
   * - `function` — calls the runtime-registered TypeScript `fn` directly.
   * - `expression` — delegates to `evaluateExpression()` for DSL string evaluation.
   *
   * @param config - `{ type: 'router'; condition: GraphCondition }`
   * @param state  - Current graph state passed to the condition function/evaluator.
   */
  private async executeRouter(
    config: { type: 'router'; condition: GraphCondition },
    state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    let target: string;

    if (config.condition.type === 'function') {
      // The function condition receives the full state and returns a node id.
      target = config.condition.fn(state as GraphState);
    } else {
      // Expression-based conditions are evaluated by the minimal DSL interpreter.
      target = this.evaluateExpression(config.condition.expr, state);
    }

    return { success: true, routeTarget: target };
  }

  /**
   * Evaluates a set of guardrails against `state.scratch` and either passes through
   * or triggers the configured violation action.
   *
   * When no `guardrailEngine` is configured, the node always passes (permissive default).
   * Violation handling currently supports `'reroute'`; `'block'`, `'warn'`, and `'sanitize'`
   * are propagated via `success: false` for the runtime to handle.
   *
   * @param config - Guardrail node config with `guardrailIds`, `onViolation`, and optional `rerouteTarget`.
   * @param state  - Current graph state; `state.scratch` is passed to the engine as the content payload.
   */
  private async executeGuardrail(
    config: {
      type: 'guardrail';
      guardrailIds: string[];
      onViolation: 'block' | 'reroute' | 'warn' | 'sanitize';
      rerouteTarget?: string;
    },
    state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    if (!this.deps.guardrailEngine) {
      // Permissive fallback: no engine means no enforcement.
      return {
        success: true,
        output: { passed: true, message: 'No guardrail engine configured' },
      };
    }

    const result = await this.deps.guardrailEngine.evaluate(state.scratch, config.guardrailIds);

    if (!result.passed && config.onViolation === 'reroute' && config.rerouteTarget) {
      // Soft violation: redirect the graph to the recovery branch.
      return { success: true, routeTarget: config.rerouteTarget };
    }

    // For all other violation actions (block, warn, sanitize) the runtime inspects
    // `success: false` and acts according to its own policy.
    return {
      success: result.passed,
      output: result,
    };
  }

  /**
   * Executes a human-in-the-loop node.
   *
   * The node supports several automated resolution strategies that bypass the
   * default human-interrupt behaviour:
   *
   * - `autoAccept` — resolve immediately with `approved: true`.
   * - `autoReject` — resolve immediately with `approved: false` and an optional reason.
   * - `judge` — delegate to an LLM judge via `generateText()`. If the judge's
   *   confidence is below `confidenceThreshold`, execution falls through to the
   *   normal human interrupt.
   *
   * When none of these options are set (or the judge cannot decide), the runtime
   * must treat `interrupt: true` as a signal to persist state, emit an `interrupt`
   * event, and halt the current run until the operator provides a response.
   *
   * @param config - Human node executor config including prompt and optional
   *   automation directives.
   */
  private async executeHuman(
    nodeId: string,
    config: {
      type: 'human';
      prompt: string;
      autoAccept?: boolean;
      autoReject?: boolean | string;
      judge?: JudgeNodeConfig;
      onTimeout?: 'accept' | 'reject' | 'error';
      guardrailOverride?: boolean;
    },
  ): Promise<NodeExecutionResult> {
    // --- Auto-accept: resolve immediately without human input ---
    if (config.autoAccept) {
      const autoAcceptResult = { approved: true, decidedBy: 'auto-accept' };
      // Run post-approval guardrails if enabled.
      const guardrailCheck = await this.runHumanNodeGuardrails(nodeId, config, autoAcceptResult);
      if (guardrailCheck) return guardrailCheck;
      return { success: true, output: autoAcceptResult };
    }

    // --- Auto-reject: resolve immediately without human input ---
    if (config.autoReject) {
      const reason = typeof config.autoReject === 'string'
        ? config.autoReject
        : 'Auto-rejected';
      return {
        success: true,
        output: { approved: false, reason, decidedBy: 'auto-reject' },
      };
    }

    // --- LLM judge: delegate to an LLM for the approval decision ---
    if (config.judge) {
      // Resolve the judge selection OUTSIDE the provider try/catch: an
      // invalid judge configuration (e.g. a non-default provider pinned
      // without a model) is a caller error that must propagate, not be
      // silently converted into a human interrupt like a provider failure.
      const judgeSel = resolveJudgeLlm(config.judge);
      try {
        const { generateText } = await import('../../api/generateText.js');

        const systemPrompt = [
          `You are an approval judge. Evaluate this request: "${config.prompt}".`,
          `Criteria: ${config.judge.criteria ?? 'Is this action safe, relevant, and appropriate?'}`,
          '',
          'Return ONLY a JSON object: { "approved": boolean, "confidence": number, "reasoning": string }',
          'Do not include any other text.',
        ].join('\n');

        const result = await generateText({
          model: judgeSel.model,
          provider: judgeSel.provider,
          system: systemPrompt,
          prompt: config.prompt,
          temperature: 0.1,
          ...(judgeSel.effort !== undefined ? { effort: judgeSel.effort } : {}),
        });

        const jsonMatch = result.text.match(/\{[\s\S]*\}/);
        const decision = JSON.parse(jsonMatch?.[0] ?? '{}');
        const threshold = config.judge.confidenceThreshold ?? 0.7;

        if (
          typeof decision.approved === 'boolean' &&
          typeof decision.confidence === 'number' &&
          decision.confidence >= threshold
        ) {
          if (decision.approved) {
            const judgeResult = { ...decision, decidedBy: 'llm-judge' };
            // Run post-approval guardrails if enabled.
            const guardrailCheck = await this.runHumanNodeGuardrails(nodeId, config, judgeResult);
            if (guardrailCheck) return guardrailCheck;
          }
          return {
            success: true,
            output: { ...decision, decidedBy: 'llm-judge' },
          };
        }
        // Confidence below threshold — fall through to human interrupt.
      } catch {
        // LLM call failed — fall through to human interrupt.
      }
    }

    // --- Default: suspend execution and await human resolution ---
    return {
      success: false,
      interrupt: true,
      error: 'Awaiting human input',
      output: { prompt: config.prompt },
    };
  }

  /**
   * Runs post-approval guardrails for a human node when an approval
   * decision has been reached (auto-accept, LLM judge, or timeout-accept).
   *
   * When `guardrailOverride` is not `false` and the node has an associated
   * `guardrailPolicy`, the guardrails are evaluated. If any guardrail blocks,
   * this returns a denial result; otherwise returns `null` (proceed normally).
   *
   * @param config - The human node's executor config.
   * @param approvalOutput - The approval output that was about to be returned.
   * @returns A `NodeExecutionResult` denying the action, or `null` if guardrails pass.
   */
  private async runHumanNodeGuardrails(
    nodeId: string,
    config: {
      guardrailOverride?: boolean;
      prompt: string;
    },
    approvalOutput: Record<string, unknown>,
  ): Promise<NodeExecutionResult | null> {
    // Skip when the override safety net is explicitly disabled.
    if (config.guardrailOverride === false) {
      return null;
    }

    // Only evaluate when a guardrail engine is wired.
    if (!this.deps.guardrailEngine) {
      return null;
    }

    // Run the guardrail engine against the approval context.
    const guardrailIds = ['pii-redaction', 'code-safety'];
    const evalResult = await this.deps.guardrailEngine.evaluate(
      { prompt: config.prompt, approval: approvalOutput },
      guardrailIds,
    );

    if (!evalResult.passed) {
      const reason = (evalResult.results as Array<{ reason?: string }>)
        .map((r) => r.reason)
        .filter(Boolean)
        .join('; ') || 'Blocked by post-approval guardrail';

      return {
        success: true,
        output: {
          approved: false,
          reason: `Guardrail override: ${reason}`,
          decidedBy: 'guardrail-override',
        },
        events: [{
          type: 'guardrail:hitl-override' as any,
          nodeId,
          guardrailId: guardrailIds.join(','),
          reason,
        } as any],
      };
    }

    return null;
  }

  /**
   * Executes a GMI (General Model Invocation) node via the LoopController.
   *
   * When `deps.loopController` and `deps.providerCall` are both available, builds a
   * `LoopContext` that wires the provider's streaming generator to the LoopController's
   * ReAct loop. Text deltas are accumulated and returned as the node output.
   *
   * Falls back to a placeholder when the LLM subsystem is not yet wired (e.g. in tests
   * or when Wunderland provides its own override).
   *
   * @param config - GMI executor config with instructions and optional sampling params.
   * @param state  - Current graph state for context injection into the provider call.
   */
  private async executeGmi(
    config: { type: 'gmi'; instructions: string; maxInternalIterations?: number; parallelTools?: boolean; temperature?: number; maxTokens?: number },
    state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    if (!this.deps.loopController || !this.deps.providerCall) {
      // Placeholder: allows the executor to be used before the LLM subsystem is ready.
      return { success: true, output: 'gmi-placeholder' };
    }

    try {
      const loopContext = {
        generateStream: () => this.deps.providerCall!(config.instructions, state),
        executeTool: async (toolCall: { id: string; name: string; arguments: Record<string, unknown> }) => {
          if (!this.deps.toolOrchestrator) {
            return { id: toolCall.id, name: toolCall.name, success: false, error: 'No ToolOrchestrator configured' };
          }
          const result = await this.deps.toolOrchestrator.processToolCall({
            toolCallRequest: { toolName: toolCall.name, arguments: toolCall.arguments },
          });
          return {
            id: toolCall.id,
            name: toolCall.name,
            success: result.success ?? !result.isError,
            output: result.output,
            error: result.error,
          };
        },
        addToolResults: () => {
          // No-op: results are fed back via the provider call's conversation context.
        },
      };

      // Bounds for the empty-output fallback. Per-item caps keep any single
      // tool from dominating; the total cap keeps the synthesised string from
      // blowing up downstream prompts.
      const PER_RESULT_CAP = 4000;
      const PER_ERROR_CAP = 1000;
      const TOTAL_FALLBACK_CAP = 16000;

      let accumulatedText = '';
      // Capture tool activity so we can fall back to it if the LLM never emits
      // a final text response — e.g. max_iterations exhausted mid-research, or
      // tool-call iterations with no narration (some providers omit content on
      // tool_calls).
      const toolResults: Array<{ name: string; content: string }> = [];
      const toolErrors: Array<{ name: string; error: string }> = [];
      let iterationsExhausted = false;
      let iterations = 0;

      for await (const event of this.deps.loopController.execute(
        {
          maxIterations: config.maxInternalIterations ?? 10,
          parallelTools: config.parallelTools ?? false,
          failureMode: 'fail_open',
        },
        loopContext,
      )) {
        if (event.type === 'text_delta') {
          accumulatedText += event.content;
        } else if (event.type === 'loop_complete') {
          iterations = event.totalIterations;
        } else if (event.type === 'tool_result' && event.result?.success) {
          const out = event.result.output;
          const content: string = typeof out === 'string'
            ? out
            : (() => {
                try {
                  // JSON.stringify returns undefined for top-level undefined or
                  // a function — coerce those to a fallback string.
                  return JSON.stringify(out) ?? String(out ?? '');
                } catch {
                  return String(out ?? '');
                }
              })();
          toolResults.push({ name: event.toolName, content: content.slice(0, PER_RESULT_CAP) });
        } else if (event.type === 'tool_error') {
          toolErrors.push({ name: event.toolName, error: String(event.error).slice(0, PER_ERROR_CAP) });
        } else if (event.type === 'max_iterations_reached') {
          iterationsExhausted = true;
          iterations = event.iteration;
        }
      }

      // Fallback: if the LLM never produced text, surface whatever tool activity
      // happened so subsequent graph nodes have something to work with instead
      // of an empty string. Successful results take priority; if there are only
      // errors, surface those so the user can see what went wrong.
      if (!accumulatedText.trim() && (toolResults.length > 0 || toolErrors.length > 0)) {
        // Tool names come from a registry but third-party extensions can in
        // principle register names containing newlines, backticks, or other
        // markdown-breaking characters. The fallback string is consumed both
        // as plain conversation context and rendered into mission report
        // markdown — sanitising defensively keeps a malformed tool name from
        // breaking either path. Cap to 80 chars to bound pathological names.
        const safeToolName = (raw: string): string =>
          String(raw).replace(/[`\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 80) || 'unnamed-tool';
        const header = iterationsExhausted
          ? '[max_iterations_reached before final summary; surfacing raw tool activity]'
          : '[no text response from model; surfacing raw tool activity]';
        const lines: string[] = [header, ''];
        // Track running length manually so each chunk insertion is O(chunk),
        // and so partial chunks are never appended (a chunk is all-or-nothing
        // to avoid orphaned "Tool: X" headers without their content).
        let currentLength = lines.join('\n').length;
        let truncated = false;
        const pushChunk = (chunk: string[]): boolean => {
          // chunkLength includes the leading '\n' separator before the chunk
          // plus '\n' between each chunk line.
          const chunkLength = chunk.reduce((sum, line) => sum + line.length + 1, 0);
          if (currentLength + chunkLength > TOTAL_FALLBACK_CAP) {
            truncated = true;
            return false;
          }
          lines.push(...chunk);
          currentLength += chunkLength;
          return true;
        };
        for (const r of toolResults) {
          if (!pushChunk([`Tool: ${safeToolName(r.name)}`, 'Result:', r.content, ''])) break;
        }
        if (!truncated) {
          for (const e of toolErrors) {
            if (!pushChunk([`Tool: ${safeToolName(e.name)}`, `Error: ${e.error}`, ''])) break;
          }
        }
        if (truncated) lines.push('[fallback truncated]');
        accumulatedText = lines.join('\n').trimEnd();
      }

      return {
        success: true,
        output: accumulatedText,
        metadata: {
          iterations,
          toolCalls: toolResults.length,
          toolErrors: toolErrors.length,
          iterationsExhausted,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `GMI execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Executes a subgraph node by recursively invoking a child `GraphRuntime`.
   *
   * When `deps.subgraphResolver` and `deps.createSubgraphRuntime` are both available,
   * the resolver looks up the compiled graph by id, input/output mappings are applied
   * to shuttle data between parent scratch and child input/artifacts, and a new runtime
   * instance executes the child graph to completion.
   *
   * Falls back to a placeholder when the subgraph subsystem is not yet wired.
   *
   * @param config - Subgraph executor config with graphId and optional field mappings.
   * @param state  - Current parent graph state used for input mapping.
   */
  private async executeSubgraph(
    config: { type: 'subgraph'; graphId: string; inputMapping?: Record<string, string>; outputMapping?: Record<string, string> },
    state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    if (!this.deps.subgraphResolver || !this.deps.createSubgraphRuntime) {
      // Placeholder: allows the executor to be used before nested graph lookup is available.
      return { success: true, output: 'subgraph-placeholder' };
    }

    const childGraph = this.deps.subgraphResolver(config.graphId);
    if (!childGraph) {
      return { success: false, error: `Subgraph not found: ${config.graphId}` };
    }

    try {
      // Build child input from parent scratch via inputMapping.
      const childInput: Record<string, unknown> = {};
      if (config.inputMapping && state.scratch) {
        for (const [parentPath, childPath] of Object.entries(config.inputMapping)) {
          const val = this.resolvePathValue(state.scratch, parentPath);
          this.setPathValue(childInput, childPath, val);
        }
      }

      const runtime = this.deps.createSubgraphRuntime(childGraph);
      const childOutput = await runtime.invoke(childGraph, childInput);

      // Map child artifacts back to parent scratch via outputMapping.
      let scratchUpdate: Record<string, unknown> | undefined;
      if (config.outputMapping && childOutput && typeof childOutput === 'object') {
        scratchUpdate = {};
        for (const [childPath, parentPath] of Object.entries(config.outputMapping)) {
          const val = this.resolvePathValue(childOutput, childPath);
          this.setPathValue(scratchUpdate, parentPath, val);
        }
      }

      return { success: true, output: childOutput, scratchUpdate };
    } catch (err) {
      return {
        success: false,
        error: `Subgraph execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Executes an extension method via the injected `extensionExecutor`.
   *
   * @param config - Extension executor config with extensionId and method name.
   * @param state  - Current graph state passed as input to the extension.
   */
  private async executeExtension(
    config: { type: 'extension'; extensionId: string; method: string },
    state: Partial<GraphState>,
  ): Promise<NodeExecutionResult> {
    if (!this.deps.extensionExecutor) {
      return { success: true, output: 'extension-not-configured' };
    }

    try {
      const result = await this.deps.extensionExecutor(
        config.extensionId,
        config.method,
        { input: state.input, scratch: state.scratch },
      );
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        scratchUpdate: result.output && typeof result.output === 'object'
          ? result.output as Record<string, unknown>
          : undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: `Extension ${config.extensionId}.${config.method} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Safe dot-path expression evaluator for `{ type: 'expression' }` routing conditions.
   *
   * Replaces partition references (`scratch`, `input`, `artifacts`) with their resolved
   * values from `state`, then evaluates the resulting expression using `new Function()`.
   * Only simple comparisons and boolean logic are supported.
   *
   * @param expr  - The DSL expression string from `GraphConditionExpr`.
   * @param state - Current graph state whose partitions are accessible in the expression.
   * @returns The resolved target node id, or `'false'` if evaluation fails.
   */
  private evaluateExpression(expr: string, state: Partial<GraphState>): string {
    return safeEvaluateExpression(expr, state);
  }

  /**
   * Resolves a dot-separated path against an object, returning the nested value.
   *
   * @param obj  - Root object to traverse.
   * @param path - Dot-separated field path (e.g. `'foo.bar.baz'`).
   * @returns The resolved value, or `undefined` if any segment is missing.
   */
  private resolvePathValue(obj: unknown, path: string): unknown {
    let val: unknown = obj;
    for (const key of path.split('.')) {
      val = (val as Record<string, unknown> | undefined)?.[key];
    }
    return val;
  }

  /**
   * Sets a value at a dot-separated path on an object, creating intermediate objects as needed.
   *
   * @param obj   - Root object to mutate.
   * @param path  - Dot-separated field path (e.g. `'foo.bar'`).
   * @param value - Value to set at the terminal key.
   */
  private setPathValue(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in current) || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
  }

  /**
   * Builds a `Promise` that resolves with a timeout-failure result after `ms` milliseconds.
   *
   * Races against `executeNode()` inside `execute()` to enforce `GraphNode.timeout`.
   *
   * @param ms     - Timeout duration in milliseconds.
   * @param nodeId - Node id included in the error message for debugging.
   */
  private buildTimeoutPromise(ms: number, nodeId: string): Promise<NodeExecutionResult> {
    return new Promise((resolve) => {
      setTimeout(
        () => resolve({ success: false, error: `Node ${nodeId} timeout after ${ms}ms` }),
        ms,
      );
    });
  }
}
