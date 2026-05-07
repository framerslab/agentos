/**
 * @file GraphRuntime.ts
 * @description Main execution engine for the AgentOS Unified Orchestration Layer.
 *
 * `GraphRuntime` ties together the `StateManager`, `NodeScheduler`, `NodeExecutor`,
 * and `ICheckpointStore` subsystems into a single runnable unit. It supports three
 * execution modes:
 *
 * - **`invoke()`** — execute a graph to completion and return final artifacts.
 * - **`stream()`** — execute a graph while yielding `GraphEvent` values at every step.
 * - **`resume()`** — restore a previously interrupted run from its latest checkpoint.
 *
 * Design principles:
 * - No mutable instance state beyond the injected config; each `invoke`/`stream`/`resume`
 *   call is fully isolated.
 * - All state lives in `GraphState`; `StateManager` is the sole authority for mutations.
 * - Checkpointing is always delegated to the injected `ICheckpointStore`.
 * - Edge evaluation is a pure function of `GraphEdge[]`, `GraphState`, and `NodeExecutionResult`.
 */

import type { CompiledExecutionGraph, EffectClass, GraphEdge, GraphState } from '../ir/types.js';
import { END } from '../ir/types.js';
import type {
  GraphEvent,
  MissionExpansionTrigger,
  MissionGraphPatch,
} from '../events/GraphEvent.js';
import type { ICheckpointStore, Checkpoint } from '../checkpoint/ICheckpointStore.js';
import { StateManager } from './StateManager.js';
import { NodeScheduler } from './NodeScheduler.js';
import { NodeExecutor, type NodeExecutionResult } from './NodeExecutor.js';
import { safeEvaluateExpression } from './safeExpressionEvaluator.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Dependencies required to construct a `GraphRuntime`.
 *
 * @property checkpointStore - Persistence backend for checkpoint snapshots.
 * @property nodeExecutor    - Dispatcher that runs individual graph nodes.
 */
export interface GraphRuntimeConfig {
  /** Persistence backend for checkpoint snapshots. */
  checkpointStore: ICheckpointStore;
  /** Dispatcher that executes individual `GraphNode` instances. */
  nodeExecutor: NodeExecutor;
  /** Optional mission graph expansion hook applied between node executions. */
  expansionHandler?: GraphExpansionHandler;
  /** Optional periodic planner reevaluation cadence, in completed nodes. */
  reevalInterval?: number;
  /**
   * Optional discovery engine for `discovery`-type edge routing.
   * When present and an edge has a `discoveryQuery`, the engine is called to
   * resolve the target dynamically. Falls back to `discoveryFallback` when absent.
   */
  discoveryEngine?: {
    discover(query: string, options?: unknown): Promise<{ results?: Array<{ id?: string; name?: string }> }>;
  };
  /**
   * Optional persona trait values for `personality`-type edge routing.
   * Keys are trait names (e.g. `'openness'`), values are 0–1 floats.
   * When absent, traits are read from `state.scratch._personaTraits` or default to 0.5.
   */
  personaTraits?: Record<string, number>;
}

export interface GraphExpansionRequest {
  trigger: MissionExpansionTrigger;
  reason: string;
  request: unknown;
  patch?: MissionGraphPatch;
}

export interface GraphExpansionContext {
  graph: CompiledExecutionGraph;
  runId: string;
  nodeId: string;
  state: GraphState;
  request: GraphExpansionRequest;
  checkpointIdBefore?: string;
  completedNodes: string[];
  skippedNodes: string[];
  nodeResults: Record<string, {
    effectClass: EffectClass;
    output: unknown;
    durationMs: number;
  }>;
}

export interface GraphExpansionResult {
  graph?: CompiledExecutionGraph;
  events?: GraphEvent[];
}

export interface GraphExpansionHandler {
  handle(context: GraphExpansionContext): Promise<GraphExpansionResult | null>;
}

function shouldTriggerPlannerReevaluation(
  reevalInterval: number | undefined,
  completedNodeCount: number,
): boolean {
  return typeof reevalInterval === 'number'
    && Number.isFinite(reevalInterval)
    && reevalInterval > 0
    && completedNodeCount > 0
    && completedNodeCount % reevalInterval === 0;
}

function getParallelBatchSizeBeforePlannerReevaluation(
  reevalInterval: number | undefined,
  completedNodeCountBeforeBatch: number,
  readyNodeCount: number,
): number {
  if (
    typeof reevalInterval !== 'number'
    || !Number.isFinite(reevalInterval)
    || reevalInterval <= 0
    || readyNodeCount <= 0
  ) {
    return readyNodeCount;
  }

  const completedSinceLastBoundary = completedNodeCountBeforeBatch % reevalInterval;
  const remainingUntilBoundary =
    completedSinceLastBoundary === 0
      ? reevalInterval
      : reevalInterval - completedSinceLastBoundary;

  return Math.min(readyNodeCount, remainingUntilBoundary);
}

// ---------------------------------------------------------------------------
// GraphRuntime
// ---------------------------------------------------------------------------

/**
 * Main execution engine for compiled AgentOS graphs.
 *
 * Instantiate once and reuse across multiple runs — the runtime itself is stateless
 * between calls. Each `invoke()` / `stream()` / `resume()` call creates isolated local
 * state tracked via closures.
 *
 * @example
 * ```ts
 * const runtime = new GraphRuntime({ checkpointStore, nodeExecutor });
 * const result = await runtime.invoke(compiledGraph, { query: 'hello' });
 * ```
 */
export class GraphRuntime {
  /**
   * @param config - Injected dependencies shared across all runs handled by this instance.
   */
  constructor(private readonly config: GraphRuntimeConfig) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute the graph to completion and return the final `artifacts` payload.
   *
   * This is a convenience wrapper around `stream()` that discards intermediate events
   * and awaits the terminal `run_end` event.
   *
   * @param graph - Compiled execution graph to run.
   * @param input - Initial user-provided input; frozen into `GraphState.input`.
   * @returns The `GraphState.artifacts` value after the last node completes.
   */
  async invoke(graph: CompiledExecutionGraph, input: unknown): Promise<unknown> {
    let finalOutput: unknown;
    for await (const event of this.stream(graph, input)) {
      if (event.type === 'run_end') finalOutput = event.finalOutput;
    }
    return finalOutput;
  }

  /**
   * Execute the graph while yielding `GraphEvent` values at each significant step.
   *
   * Events are emitted in strict causal order:
   * `run_start` → (`node_start` → `node_end` → `edge_transition`?)+ → `run_end`
   *
   * Checkpoints are saved according to both the graph-wide `checkpointPolicy` and
   * per-node `checkpoint` settings. An `interrupt` event causes immediate suspension
   * followed by a terminal `run_end`.
   *
   * @param graph - Compiled execution graph to run.
   * @param input - Initial user-provided input; frozen into `GraphState.input`.
   * @yields {GraphEvent} Runtime events in causal order.
   */
  async *stream(graph: CompiledExecutionGraph, input: unknown): AsyncGenerator<GraphEvent> {
    const runId = crypto.randomUUID();
    const stateManager = new StateManager(graph.reducers);
    let activeGraph = graph;

    let state = stateManager.initialize(input);
    const startTime = Date.now();

    /** Node ids whose execution has fully completed in this run. */
    const completedNodes: string[] = [];
    /** Node ids that were bypassed due to conditional routing. */
    const skippedNodes: string[] = [];
    /** Per-node execution results accumulated for checkpoint persistence. */
    const nodeResults: Record<string, { effectClass: EffectClass; output: unknown; durationMs: number }> = {};

    yield { type: 'run_start', runId, graphId: graph.id };

    while (true) {
      const scheduler = new NodeScheduler(activeGraph.nodes, activeGraph.edges);
      const readyNodes = scheduler.getReadyNodes(completedNodes, skippedNodes);
      if (readyNodes.length === 0) break; // All work is done (or no START edge).

      // ── Parallel execution ───────────────────────────────────────────────
      // When multiple nodes are ready simultaneously (e.g. fan-out from START),
      // execute them in parallel via Promise.all and merge their scratch updates
      // using StateManager.mergeParallelBranches(). This is the key optimisation
      // that makes fan-out/fan-in graphs like the parallel agency strategy
      // actually run concurrently instead of sequentially.
      //
      // Single-node batches fall through to the same code path (Promise.all
      // with a single element) so the logic is unified.
      const parallelBatchSize =
        readyNodes.length > 1
          ? (
            this.config.expansionHandler
              ? getParallelBatchSizeBeforePlannerReevaluation(
                  this.config.reevalInterval,
                  completedNodes.length,
                  readyNodes.length,
                )
              : readyNodes.length
          )
          : readyNodes.length;
      if (parallelBatchSize > 1) {
        const parallelReadyNodes = readyNodes.slice(0, parallelBatchSize);
        // Snapshot the state before fan-out so each branch starts from the
        // same baseline. After all branches complete, we merge their scratch
        // updates back into this baseline.
        const baseState = state;

        // Collect events from parallel branches so we can yield them in order
        // after all branches complete. We cannot yield from inside Promise.all
        // because async generators do not support concurrent yields.
        const branchResults: Array<{
          nodeId: string;
          events: GraphEvent[];
          branchState: GraphState;
          expansionRequests?: GraphExpansionRequest[];
          earlyTermination?: {
            type: 'interrupt' | 'error';
            events: GraphEvent[];
          };
        }> = [];

        const parallelOutcomes = await Promise.all(
          parallelReadyNodes.map(async (nodeId) => {
            const node = activeGraph.nodes.find(n => n.id === nodeId);
            if (!node) {
              skippedNodes.push(nodeId);
              return null;
            }

            const events: GraphEvent[] = [];
            let branchState = stateManager.recordNodeVisit(baseState, nodeId);

            // Checkpoint BEFORE (parallel branch).
            if (node.checkpoint === 'before' || node.checkpoint === 'both') {
              const checkpointId = await this.saveCheckpoint(
                activeGraph, runId, nodeId, branchState, nodeResults,
                completedNodes, skippedNodes, [],
              );
              branchState = this.attachCheckpointMetadata(branchState, checkpointId);
              events.push({ type: 'checkpoint_saved', checkpointId, nodeId });
            }

            events.push({ type: 'node_start', nodeId, state: { input: branchState.input, scratch: branchState.scratch } });
            const nodeStart = Date.now();

            let result = await this.config.nodeExecutor.execute(node, branchState);
            let durationMs = Date.now() - nodeStart;

            // Retry logic (same as sequential path).
            if (!result.success && !result.interrupt && node.retryPolicy) {
              const policy = node.retryPolicy;
              let attempt = 1;
              while (attempt < policy.maxAttempts && shouldRetry(policy, result.error)) {
                attempt++;
                await sleep(calculateBackoff(policy, attempt - 1));
                events.push({ type: 'node_start', nodeId, state: { input: branchState.input, scratch: branchState.scratch } });
                const retryStart = Date.now();
                result = await this.config.nodeExecutor.execute(node, branchState);
                durationMs = Date.now() - retryStart;
                if (result.success || result.interrupt) break;
              }
            }

            nodeResults[nodeId] = { effectClass: node.effectClass, output: result.output, durationMs };

            if (result.scratchUpdate) {
              branchState = stateManager.updateScratch(branchState, result.scratchUpdate);
            }
            if (result.artifactsUpdate) {
              branchState = stateManager.updateArtifacts(branchState, result.artifactsUpdate);
            } else if (result.success && result.output !== undefined && !result.routeTarget) {
              // Same default artifact promotion as the sequential path —
              // see the comment at the matching block below for context.
              const artifactKey =
                typeof node.metadata?.outputAs === 'string' && node.metadata.outputAs.length > 0
                  ? node.metadata.outputAs
                  : nodeId;
              branchState = stateManager.updateArtifacts(branchState, { [artifactKey]: result.output });
            }
            events.push(...getResultEvents(result));

            // Check for interrupt / error in the parallel branch.
            if (result.interrupt) {
              events.push({ type: 'node_end', nodeId, output: result.output, durationMs, telemetry: result.metadata });
              const terminationEvents: GraphEvent[] = [
                { type: 'interrupt', nodeId, reason: 'human_approval' },
              ];
              return { nodeId, events, branchState, earlyTermination: { type: 'interrupt' as const, events: terminationEvents } };
            }

            if (!result.success) {
              const errorMessage = result.error ?? `Node ${nodeId} failed`;
              const timeoutMs = this.extractTimeoutMs(errorMessage);
              const terminationEvents: GraphEvent[] = [];
              if (timeoutMs !== null) {
                terminationEvents.push({ type: 'node_timeout', nodeId, timeoutMs });
              }
              terminationEvents.push({
                type: 'error', nodeId,
                error: { code: timeoutMs !== null ? 'NODE_TIMEOUT' : 'NODE_EXECUTION_FAILED', message: errorMessage },
              });
              return { nodeId, events, branchState, earlyTermination: { type: 'error' as const, events: terminationEvents } };
            }

            events.push({ type: 'node_end', nodeId, output: result.output, durationMs, telemetry: result.metadata });
            completedNodes.push(nodeId);

            // Edge routing for this parallel branch.
            const outEdges = activeGraph.edges.filter(e => e.source === nodeId);
            const targets = await this.evaluateEdges(outEdges, branchState, result);

            for (const potentialTarget of outEdges.map(e => e.target)) {
              if (!targets.includes(potentialTarget) && !completedNodes.includes(potentialTarget) && !skippedNodes.includes(potentialTarget)) {
                skippedNodes.push(potentialTarget);
              }
            }

            for (const target of targets) {
              if (target !== END) {
                const edgeType = outEdges.find(e => e.target === target)?.type ?? 'static';
                events.push({ type: 'edge_transition', sourceId: nodeId, targetId: target, edgeType });
              }
            }

            // Checkpoint AFTER (parallel branch).
            if (node.checkpoint === 'after' || node.checkpoint === 'both' || graph.checkpointPolicy === 'every_node') {
              const checkpointId = await this.saveCheckpoint(
                activeGraph, runId, nodeId, branchState, nodeResults,
                completedNodes, skippedNodes, this.resolvePendingEdgeIds(outEdges, targets),
              );
              branchState = this.attachCheckpointMetadata(branchState, checkpointId);
              events.push({ type: 'checkpoint_saved', checkpointId, nodeId });
            }

            return {
              nodeId,
              events,
              branchState,
              expansionRequests: [...(result.expansionRequests ?? [])],
            };
          }),
        );

        // Yield all collected events from parallel branches in order,
        // then merge branch states into the shared baseline.
        const successfulBranches: GraphState[] = [];
        let earlyTermination = false;

        for (const outcome of parallelOutcomes) {
          if (!outcome) continue;

          // Yield all events from this branch.
          for (const event of outcome.events) {
            yield event;
          }

          if (outcome.earlyTermination) {
            // Yield termination events and abort the run.
            for (const event of outcome.earlyTermination.events) {
              yield event;
            }
            // Save checkpoint and terminate.
            const checkpointId = await this.saveCheckpoint(
              activeGraph, runId, outcome.nodeId, outcome.branchState,
              nodeResults, completedNodes, skippedNodes, [],
            );
            state = this.attachCheckpointMetadata(outcome.branchState, checkpointId);
            yield { type: 'checkpoint_saved', checkpointId, nodeId: outcome.nodeId };
            if (outcome.earlyTermination.type === 'interrupt') {
              yield { type: 'interrupt', nodeId: outcome.nodeId, reason: 'human_approval' };
            } else {
              const node = graph.nodes.find(n => n.id === outcome.nodeId);
              yield { type: 'interrupt', nodeId: outcome.nodeId, reason: node?.type === 'guardrail' ? 'guardrail_violation' : 'error' };
            }
            yield { type: 'run_end', runId, finalOutput: state.artifacts, totalDurationMs: Date.now() - startTime };
            earlyTermination = true;
            break;
          }

          successfulBranches.push(outcome.branchState);
        }

        if (earlyTermination) return;

        // Merge all branch states back into the baseline using StateManager.
        // This is the merge step that makes parallel execution correct:
        // each branch may have written to different scratch keys, and the
        // reducer configuration determines how conflicts are resolved.
        if (successfulBranches.length > 0) {
          state = stateManager.mergeParallelBranches(baseState, successfulBranches);
        }

        if (this.config.expansionHandler) {
          const expansionQueue: Array<{
            nodeId: string;
            request: GraphExpansionRequest;
          }> = [];

          for (const outcome of parallelOutcomes) {
            if (!outcome || outcome.earlyTermination || !outcome.expansionRequests?.length) continue;

            for (const request of outcome.expansionRequests) {
              expansionQueue.push({
                nodeId: outcome.nodeId,
                request,
              });
            }
          }

          if (shouldTriggerPlannerReevaluation(this.config.reevalInterval, completedNodes.length)) {
            const lastCompletedNodeId = parallelReadyNodes[parallelReadyNodes.length - 1]!;
            expansionQueue.push({
              nodeId: lastCompletedNodeId,
              request: {
                trigger: 'planner_reeval',
                reason: `Periodic reevaluation after ${completedNodes.length} completed nodes`,
                request: {
                  completedNodeCount: completedNodes.length,
                  lastCompletedNodeId,
                },
              },
            });
          }

          if (expansionQueue.length > 0) {
            const checkpointNodeId = expansionQueue[expansionQueue.length - 1]!.nodeId;
            const checkpointIdBefore = await this.saveCheckpoint(
              activeGraph,
              runId,
              checkpointNodeId,
              state,
              nodeResults,
              completedNodes,
              skippedNodes,
              [],
            );
            state = this.attachCheckpointMetadata(state, checkpointIdBefore);
            yield { type: 'checkpoint_saved', checkpointId: checkpointIdBefore, nodeId: checkpointNodeId };
            yield { type: 'mission:checkpoint_saved', checkpointId: checkpointIdBefore, nodeId: checkpointNodeId };

            for (const { nodeId, request } of expansionQueue) {
              const expansionOutcome = await this.config.expansionHandler.handle({
                graph: activeGraph,
                runId,
                nodeId,
                state,
                request,
                checkpointIdBefore,
                completedNodes: [...completedNodes],
                skippedNodes: [...skippedNodes],
                nodeResults: nodeResults as GraphExpansionContext['nodeResults'],
              });

              for (const event of expansionOutcome?.events ?? []) {
                yield event;
              }

              if (expansionOutcome?.graph) {
                activeGraph = expansionOutcome.graph;
              }
            }
          }
        }
      } else {
        // ── Sequential execution (single ready node) ─────────────────────────
        // Original single-node path preserved for simplicity and to avoid
        // the overhead of Promise.all for the common single-node case.
        const nodeId = readyNodes[0];
        const node = activeGraph.nodes.find(n => n.id === nodeId);
        if (!node) {
          // Node declared in edges but missing from nodes array — skip defensively.
          skippedNodes.push(nodeId);
          continue;
        }

        state = stateManager.recordNodeVisit(state, nodeId);

        // ── Checkpoint BEFORE ────────────────────────────────────────────────
        if (node.checkpoint === 'before' || node.checkpoint === 'both') {
          const checkpointId = await this.saveCheckpoint(
            activeGraph,
            runId,
            nodeId,
            state,
            nodeResults,
            completedNodes,
            skippedNodes,
            [],
          );
          state = this.attachCheckpointMetadata(state, checkpointId);
          yield { type: 'checkpoint_saved', checkpointId, nodeId };
        }

        yield { type: 'node_start', nodeId, state: { input: state.input, scratch: state.scratch } };
        const nodeStart = Date.now();

        // ── Execute (with retry) ─────────────────────────────────────────────
        let result = await this.config.nodeExecutor.execute(node, state);
        let durationMs = Date.now() - nodeStart;

        if (!result.success && !result.interrupt && node.retryPolicy) {
          const policy = node.retryPolicy;
          let attempt = 1;
          while (attempt < policy.maxAttempts && shouldRetry(policy, result.error)) {
            attempt++;
            await sleep(calculateBackoff(policy, attempt - 1));
            yield { type: 'node_start', nodeId, state: { input: state.input, scratch: state.scratch } };
            const retryStart = Date.now();
            result = await this.config.nodeExecutor.execute(node, state);
            durationMs = Date.now() - retryStart;
            if (result.success || result.interrupt) break;
          }
        }

        nodeResults[nodeId] = {
          effectClass: node.effectClass,
          output: result.output,
          durationMs,
        };

        // Apply state patches produced by the node.
        if (result.scratchUpdate) {
          state = stateManager.updateScratch(state, result.scratchUpdate);
        }
        if (result.artifactsUpdate) {
          state = stateManager.updateArtifacts(state, result.artifactsUpdate);
        } else if (result.success && result.output !== undefined && !result.routeTarget) {
          // Default artifact promotion: when the node ran successfully and the
          // executor did not produce its own `artifactsUpdate`, promote
          // `result.output` into `state.artifacts` under the key declared on
          // `node.metadata.outputAs` (set by builders like workflow()'s
          // `step('id', { outputAs: 'foo' })`), or fall back to `node.id`.
          // This is what makes `await workflow.invoke(...)` actually return
          // the per-step outputs that authors `.returns()`-typed against,
          // instead of an empty object.
          //
          // Router nodes (which return `routeTarget` instead of a payload)
          // are excluded — they're control-flow, not value producers.
          const artifactKey =
            typeof node.metadata?.outputAs === 'string' && node.metadata.outputAs.length > 0
              ? node.metadata.outputAs
              : nodeId;
          state = stateManager.updateArtifacts(state, { [artifactKey]: result.output });
        }
        for (const event of getResultEvents(result)) {
          yield event;
        }

        // ── Human interrupt ───────────────────────────────────────────────────
        if (result.interrupt) {
          yield { type: 'node_end', nodeId, output: result.output, durationMs, telemetry: result.metadata };
          yield { type: 'interrupt', nodeId, reason: 'human_approval' };
          // Persist so the run can be resumed later.
          const checkpointId = await this.saveCheckpoint(
            activeGraph,
            runId,
            nodeId,
            state,
            nodeResults,
            completedNodes,
            skippedNodes,
            [],
          );
          state = this.attachCheckpointMetadata(state, checkpointId);
          yield { type: 'checkpoint_saved', checkpointId, nodeId };
          yield { type: 'run_end', runId, finalOutput: state.artifacts, totalDurationMs: Date.now() - startTime };
          return;
        }

        if (!result.success) {
          const errorMessage = result.error ?? `Node ${nodeId} failed`;
          const timeoutMs = this.extractTimeoutMs(errorMessage);
          if (timeoutMs !== null) {
            yield { type: 'node_timeout', nodeId, timeoutMs };
          }
          yield {
            type: 'error',
            nodeId,
            error: {
              code: timeoutMs !== null ? 'NODE_TIMEOUT' : 'NODE_EXECUTION_FAILED',
              message: errorMessage,
            },
          };
          const checkpointId = await this.saveCheckpoint(
            activeGraph,
            runId,
            nodeId,
            state,
            nodeResults,
            completedNodes,
            skippedNodes,
            [],
          );
          state = this.attachCheckpointMetadata(state, checkpointId);
          yield { type: 'checkpoint_saved', checkpointId, nodeId };
          yield {
            type: 'interrupt',
            nodeId,
            reason: node.type === 'guardrail' ? 'guardrail_violation' : 'error',
          };
          yield { type: 'run_end', runId, finalOutput: state.artifacts, totalDurationMs: Date.now() - startTime };
          return;
        }

        yield { type: 'node_end', nodeId, output: result.output, durationMs, telemetry: result.metadata };

        completedNodes.push(nodeId);

        const expansionRequests = [...(result.expansionRequests ?? [])];
        if (
          this.config.expansionHandler
          && shouldTriggerPlannerReevaluation(this.config.reevalInterval, completedNodes.length)
        ) {
          expansionRequests.push({
            trigger: 'planner_reeval',
            reason: `Periodic reevaluation after ${completedNodes.length} completed nodes`,
            request: {
              completedNodeCount: completedNodes.length,
              lastCompletedNodeId: nodeId,
            },
          });
        }

        if (this.config.expansionHandler && expansionRequests.length > 0) {
          let checkpointIdBefore: string | undefined;

          for (const request of expansionRequests) {
            if (!checkpointIdBefore) {
              checkpointIdBefore = await this.saveCheckpoint(
                activeGraph,
                runId,
                nodeId,
                state,
                nodeResults,
                completedNodes,
                skippedNodes,
                [],
              );
              state = this.attachCheckpointMetadata(state, checkpointIdBefore);
              yield { type: 'checkpoint_saved', checkpointId: checkpointIdBefore, nodeId };
              yield { type: 'mission:checkpoint_saved', checkpointId: checkpointIdBefore, nodeId };
            }

            const outcome = await this.config.expansionHandler.handle({
              graph: activeGraph,
              runId,
              nodeId,
              state,
              request,
              checkpointIdBefore,
              completedNodes: [...completedNodes],
              skippedNodes: [...skippedNodes],
              nodeResults: nodeResults as GraphExpansionContext['nodeResults'],
            });

            for (const event of outcome?.events ?? []) {
              yield event;
            }

            if (outcome?.graph) {
              activeGraph = outcome.graph;
            }
          }
        }

        // ── Edge routing ──────────────────────────────────────────────────────
        const outEdges = activeGraph.edges.filter(e => e.source === nodeId);
        const targets = await this.evaluateEdges(outEdges, state, result);

        // Any outgoing-edge target that was NOT selected is marked as skipped
        // so downstream nodes that depend only on the skipped branch do not block.
        // This applies to ALL edge types (static, conditional, personality, discovery)
        // when a router node produces a routing decision.
        for (const potentialTarget of outEdges.map(e => e.target)) {
          if (
            !targets.includes(potentialTarget) &&
            !completedNodes.includes(potentialTarget) &&
            !skippedNodes.includes(potentialTarget)
          ) {
            skippedNodes.push(potentialTarget);
          }
        }

        for (const target of targets) {
          if (target !== END) {
            const edgeType = outEdges.find(e => e.target === target)?.type ?? 'static';
            yield { type: 'edge_transition', sourceId: nodeId, targetId: target, edgeType };
          }
        }

        // ── Checkpoint AFTER ──────────────────────────────────────────────────
        if (
          node.checkpoint === 'after' ||
          node.checkpoint === 'both' ||
          activeGraph.checkpointPolicy === 'every_node'
        ) {
          const checkpointId = await this.saveCheckpoint(
            activeGraph,
            runId,
            nodeId,
            state,
            nodeResults,
            completedNodes,
            skippedNodes,
            this.resolvePendingEdgeIds(outEdges, targets),
          );
          state = this.attachCheckpointMetadata(state, checkpointId);
          yield { type: 'checkpoint_saved', checkpointId, nodeId };
        }
      }
    }

    yield {
      type: 'run_end',
      runId,
      finalOutput: state.artifacts,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Resume a previously interrupted run from its latest persisted checkpoint.
   *
   * The runtime restores `GraphState` from the checkpoint and re-executes any nodes
   * that had not yet completed when the run was suspended. Nodes recorded as
   * `write`, `external`, or `human` effect-class are replayed from their stored
   * outputs to avoid duplicate side-effects; all other nodes are re-executed.
   *
   * @param graph - The same compiled graph that was originally invoked.
   * @param runOrCheckpointId - Either the original run id or an exact checkpoint id.
   * @returns The final `GraphState.artifacts` value after resumption completes.
   * @throws {Error} When no checkpoint exists for the given identifier.
   */
  async resume(graph: CompiledExecutionGraph, runOrCheckpointId: string): Promise<unknown> {
    let finalOutput: unknown;
    for await (const event of this.streamResume(graph, runOrCheckpointId)) {
      if (event.type === 'run_end') finalOutput = event.finalOutput;
    }
    return finalOutput;
  }

  /**
   * Resume a previously interrupted run and stream runtime events from the restore point.
   *
   * Accepts either the original run id or an exact checkpoint id. The resolved checkpoint
   * is used to reconstruct `GraphState`, then execution continues through the same event
   * stream contract as {@link stream()}.
   *
   * @param graph - Compiled execution graph to resume.
   * @param runOrCheckpointId - Either the original run id or an exact checkpoint id.
   * @yields {GraphEvent} Runtime events in causal order from the checkpoint onward.
   * @throws {Error} When no checkpoint exists for the given identifier.
   */
  async *streamResume(
    graph: CompiledExecutionGraph,
    runOrCheckpointId: string,
  ): AsyncGenerator<GraphEvent> {
    const checkpoint =
      await this.config.checkpointStore.latest(runOrCheckpointId)
      ?? await this.config.checkpointStore.get(runOrCheckpointId);
    if (!checkpoint) throw new Error(`No checkpoint found for identifier ${runOrCheckpointId}`);

    // Reconstruct graph state from the persisted snapshot.
    const stateManager = new StateManager(graph.reducers);
    let state = stateManager.initialize(checkpoint.state.input);
    state = {
      ...state,
      scratch: checkpoint.state.scratch as GraphState['scratch'],
      artifacts: checkpoint.state.artifacts as GraphState['artifacts'],
      visitedNodes: [...checkpoint.visitedNodes],
      iteration: checkpoint.visitedNodes.length,
    };
    yield* this.continueFromCheckpoint(graph, checkpoint.runId, state, checkpoint);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Continue execution from a restored checkpoint state.
   *
   * Mirrors `stream()` but initialises `completedNodes` / `nodeResults` from the
   * checkpoint so previously-finished work is not repeated. Nodes with side-effectful
   * effect classes are replayed from stored outputs; pure / read nodes are re-executed.
   *
   * @param graph      - The compiled execution graph.
   * @param runId      - Original run identifier for checkpoint persistence.
   * @param state      - `GraphState` restored from the checkpoint.
   * @param checkpoint - Full checkpoint snapshot; provides `nodeResults` and `visitedNodes`.
   * @yields {GraphEvent} Runtime events in causal order, starting from the resume point.
   */
  private async *continueFromCheckpoint(
    graph: CompiledExecutionGraph,
    runId: string,
    state: GraphState,
    checkpoint: Checkpoint,
  ): AsyncGenerator<GraphEvent> {
    const stateManager = new StateManager(graph.reducers);
    let activeGraph = graph;

    const completedNodes = [...checkpoint.visitedNodes];
    const skippedNodes = [...(checkpoint.skippedNodes ?? [])];
    const nodeResults = { ...checkpoint.nodeResults };
    const startTime = Date.now();

    yield { type: 'run_start', runId, graphId: graph.id };

    while (true) {
      const scheduler = new NodeScheduler(activeGraph.nodes, activeGraph.edges);
      const readyNodes = scheduler.getReadyNodes(completedNodes, skippedNodes);
      if (readyNodes.length === 0) break;

      for (const nodeId of readyNodes) {
        const node = activeGraph.nodes.find(n => n.id === nodeId);
        if (!node) {
          skippedNodes.push(nodeId);
          continue;
        }

        // Nodes with side-effects that were recorded are replayed from stored output
        // to prevent duplicate writes/calls.
        const recorded = checkpoint.nodeResults[nodeId];
        if (
          recorded &&
          (recorded.effectClass === 'write' ||
            recorded.effectClass === 'external' ||
            recorded.effectClass === 'human')
        ) {
          completedNodes.push(nodeId);
          yield { type: 'node_end', nodeId, output: recorded.output, durationMs: recorded.durationMs };
          continue;
        }

        // Re-execute the node (pure / read effects, or nodes without a stored result).
        state = stateManager.recordNodeVisit(state, nodeId);
        yield { type: 'node_start', nodeId, state: { input: state.input, scratch: state.scratch } };
        const nodeStart = Date.now();

        let result = await this.config.nodeExecutor.execute(node, state);
        let durationMs = Date.now() - nodeStart;

        if (!result.success && !result.interrupt && node.retryPolicy) {
          const policy = node.retryPolicy;
          let attempt = 1;
          while (attempt < policy.maxAttempts && shouldRetry(policy, result.error)) {
            attempt++;
            await sleep(calculateBackoff(policy, attempt - 1));
            yield { type: 'node_start', nodeId, state: { input: state.input, scratch: state.scratch } };
            const retryStart = Date.now();
            result = await this.config.nodeExecutor.execute(node, state);
            durationMs = Date.now() - retryStart;
            if (result.success || result.interrupt) break;
          }
        }

        nodeResults[nodeId] = { effectClass: node.effectClass, output: result.output, durationMs };

        if (result.scratchUpdate) state = stateManager.updateScratch(state, result.scratchUpdate);
        if (result.artifactsUpdate) {
          state = stateManager.updateArtifacts(state, result.artifactsUpdate);
        } else if (result.success && result.output !== undefined && !result.routeTarget) {
          // Same default artifact promotion as the primary path.
          const artifactKey =
            typeof node.metadata?.outputAs === 'string' && node.metadata.outputAs.length > 0
              ? node.metadata.outputAs
              : nodeId;
          state = stateManager.updateArtifacts(state, { [artifactKey]: result.output });
        }
        for (const event of getResultEvents(result)) {
          yield event;
        }

        if (result.interrupt) {
          yield { type: 'node_end', nodeId, output: result.output, durationMs, telemetry: result.metadata };
          yield { type: 'interrupt', nodeId, reason: 'human_approval' };
          const checkpointId = await this.saveCheckpoint(
            activeGraph,
            runId,
            nodeId,
            state,
            nodeResults,
            completedNodes,
            skippedNodes,
            [],
          );
          state = this.attachCheckpointMetadata(state, checkpointId);
          yield { type: 'checkpoint_saved', checkpointId, nodeId };
          yield { type: 'run_end', runId, finalOutput: state.artifacts, totalDurationMs: Date.now() - startTime };
          return;
        }

        if (!result.success) {
          const errorMessage = result.error ?? `Node ${nodeId} failed`;
          const timeoutMs = this.extractTimeoutMs(errorMessage);
          if (timeoutMs !== null) {
            yield { type: 'node_timeout', nodeId, timeoutMs };
          }
          yield {
            type: 'error',
            nodeId,
            error: {
              code: timeoutMs !== null ? 'NODE_TIMEOUT' : 'NODE_EXECUTION_FAILED',
              message: errorMessage,
            },
          };
          const checkpointId = await this.saveCheckpoint(
            activeGraph,
            runId,
            nodeId,
            state,
            nodeResults,
            completedNodes,
            skippedNodes,
            [],
          );
          state = this.attachCheckpointMetadata(state, checkpointId);
          yield { type: 'checkpoint_saved', checkpointId, nodeId };
          yield {
            type: 'interrupt',
            nodeId,
            reason: node.type === 'guardrail' ? 'guardrail_violation' : 'error',
          };
          yield { type: 'run_end', runId, finalOutput: state.artifacts, totalDurationMs: Date.now() - startTime };
          return;
        }

        yield { type: 'node_end', nodeId, output: result.output, durationMs, telemetry: result.metadata };
        completedNodes.push(nodeId);

        const expansionRequests = [...(result.expansionRequests ?? [])];
        if (
          this.config.expansionHandler
          && shouldTriggerPlannerReevaluation(this.config.reevalInterval, completedNodes.length)
        ) {
          expansionRequests.push({
            trigger: 'planner_reeval',
            reason: `Periodic reevaluation after ${completedNodes.length} completed nodes`,
            request: {
              completedNodeCount: completedNodes.length,
              lastCompletedNodeId: nodeId,
            },
          });
        }

        if (this.config.expansionHandler && expansionRequests.length > 0) {
          let checkpointIdBefore: string | undefined;

          for (const request of expansionRequests) {
            if (!checkpointIdBefore) {
              checkpointIdBefore = await this.saveCheckpoint(
                activeGraph,
                runId,
                nodeId,
                state,
                nodeResults,
                completedNodes,
                skippedNodes,
                [],
              );
              state = this.attachCheckpointMetadata(state, checkpointIdBefore);
              yield { type: 'checkpoint_saved', checkpointId: checkpointIdBefore, nodeId };
              yield { type: 'mission:checkpoint_saved', checkpointId: checkpointIdBefore, nodeId };
            }

            const outcome = await this.config.expansionHandler.handle({
              graph: activeGraph,
              runId,
              nodeId,
              state,
              request,
              checkpointIdBefore,
              completedNodes: [...completedNodes],
              skippedNodes: [...skippedNodes],
              nodeResults: nodeResults as GraphExpansionContext['nodeResults'],
            });

            for (const event of outcome?.events ?? []) {
              yield event;
            }

            if (outcome?.graph) {
              activeGraph = outcome.graph;
            }
          }
        }

        // Evaluate outgoing edges for the resumed node.
        const outEdges = activeGraph.edges.filter(e => e.source === nodeId);
        const targets = await this.evaluateEdges(outEdges, state, result);

        for (const potentialTarget of outEdges.map(e => e.target)) {
          if (
            !targets.includes(potentialTarget) &&
            !completedNodes.includes(potentialTarget) &&
            !skippedNodes.includes(potentialTarget)
          ) {
            skippedNodes.push(potentialTarget);
          }
        }

        for (const target of targets) {
          if (target !== END) {
            const edgeType = outEdges.find(e => e.target === target)?.type ?? 'static';
            yield { type: 'edge_transition', sourceId: nodeId, targetId: target, edgeType };
          }
        }
      }
    }

    yield {
      type: 'run_end',
      runId,
      finalOutput: state.artifacts,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Evaluate the outgoing edges from a just-completed node and return the list of
   * target node ids to activate next.
   *
   * Priority rule: if `result.routeTarget` is set (returned by `router` or `guardrail`
   * nodes) it overrides any edge-derived targets.
   *
   * @param edges  - All outgoing edges from the source node.
   * @param state  - Current `GraphState` passed to condition functions.
   * @param result - Execution result; `routeTarget` takes precedence when present.
   * @returns Ordered array of target node ids (may include `END`).
   */
  private async evaluateEdges(
    edges: GraphEdge[],
    state: GraphState,
    result: NodeExecutionResult,
  ): Promise<string[]> {
    // Router / guardrail nodes return an explicit target that takes precedence.
    if (result.routeTarget) {
      return [result.routeTarget];
    }

    const targets: string[] = [];

    for (const edge of edges) {
      switch (edge.type) {
        case 'static':
          // Always follow static edges.
          targets.push(edge.target);
          break;

        case 'conditional': {
          if (!edge.condition) break;

          let resolvedTarget: string | undefined;
          if (edge.condition.type === 'function') {
            // Call the author-provided TypeScript routing function.
            // Function conditions return the actual node id to route to — add it directly.
            resolvedTarget = edge.condition.fn(state);
          } else {
            const expressionResult = evaluateConditionExpression(edge.condition.expr, state);
            const resultStr = String(expressionResult);
            // Expression evaluated to boolean true/false — use edge target directly
            if (resultStr === 'true') {
              resolvedTarget = edge.target;
            } else if (resultStr === 'false') {
              // Condition is false — do not add this edge's target
              resolvedTarget = undefined;
            } else {
              // Expression returned a route name string (e.g., 'nodeA')
              resolvedTarget = resultStr;
            }
          }

          // For function-based conditions the target field is the placeholder '__CONDITIONAL__',
          // so we accept whatever the function returned.  For expression-based conditions the
          // target field holds the real node id, so we only follow the edge when it matches.
          if (resolvedTarget != null) {
            const isPlaceholder = edge.target === '__CONDITIONAL__' || edge.target === '__DISCOVERY__';
            if ((isPlaceholder || resolvedTarget === edge.target) && !targets.includes(resolvedTarget)) {
              targets.push(resolvedTarget);
            }
          }
          break;
        }

        case 'personality':
          if (edge.personalityCondition) {
            const { trait, threshold, above, below } = edge.personalityCondition;
            // Resolve trait value: config > scratch._personaTraits > default 0.5
            const traitValue =
              this.config.personaTraits?.[trait]
                ?? ((state.scratch as Record<string, unknown> | undefined)?._personaTraits as Record<string, number> | undefined)?.[trait]
                ?? 0.5;
            targets.push(traitValue >= threshold ? above : below);
          }
          break;

        case 'discovery': {
          // Attempt dynamic discovery when an engine and query are available.
          if (this.config.discoveryEngine && edge.discoveryQuery) {
            try {
              const discoveryResult = await this.config.discoveryEngine.discover(edge.discoveryQuery, {
                kind: edge.discoveryKind,
              });
              const topResult = discoveryResult?.results?.[0];
              if (topResult && (topResult.id || topResult.name)) {
                targets.push(edge.target);
                break;
              }
            } catch {
              // Fall through to fallback on discovery error.
            }
          }
          // Fallback when no engine, no query, no results, or error.
          if (edge.discoveryFallback) targets.push(edge.discoveryFallback);
          break;
        }
      }
    }

    return targets;
  }

  /**
   * Serialize the current execution state into a `Checkpoint` and persist it
   * via the injected `ICheckpointStore`.
   *
   * @param graph        - The compiled graph (provides `id`).
   * @param runId        - Unique run identifier assigned at `stream()` call-time.
   * @param nodeId       - The node at whose boundary the checkpoint is being taken.
   * @param state        - Current full `GraphState`.
   * @param nodeResults  - Accumulated per-node execution results.
   * @param visitedNodes - Ordered list of completed node ids.
   */
  private async saveCheckpoint(
    graph: CompiledExecutionGraph,
    runId: string,
    nodeId: string,
    state: GraphState,
    nodeResults: Record<string, { effectClass: EffectClass; output: unknown; durationMs: number }>,
    visitedNodes: string[],
    skippedNodes: string[],
    pendingEdges: string[],
  ): Promise<string> {
    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      graphId: graph.id,
      runId,
      nodeId,
      timestamp: Date.now(),
      state: {
        input: state.input,
        scratch: state.scratch,
        artifacts: state.artifacts,
        diagnostics: state.diagnostics,
      },
      // Cast: checkpoint type requires EffectClass but we store as string for flexibility.
      nodeResults: nodeResults as Checkpoint['nodeResults'],
      visitedNodes: [...visitedNodes],
      skippedNodes: [...skippedNodes],
      pendingEdges: [...pendingEdges],
    };
    await this.config.checkpointStore.save(checkpoint);
    return checkpoint.id;
  }

  private attachCheckpointMetadata(state: GraphState, checkpointId: string): GraphState {
    return {
      ...state,
      checkpointId,
      diagnostics: {
        ...state.diagnostics,
        checkpointsSaved: state.diagnostics.checkpointsSaved + 1,
      },
    };
  }

  private extractTimeoutMs(errorMessage: string): number | null {
    const match = errorMessage.match(/timeout after (\d+)ms/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  private resolvePendingEdgeIds(edges: GraphEdge[], targets: string[]): string[] {
    return edges
      .filter((edge) => edge.target !== END && targets.includes(edge.target))
      .map((edge) => edge.id);
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

import type { RetryPolicy } from '../ir/types.js';

/**
 * Calculate the backoff delay in milliseconds for a given retry attempt.
 *
 * @param policy  - The retry policy with backoff strategy and base duration.
 * @param attempt - The current attempt number (1-indexed; attempt 2 is the first retry).
 * @returns Delay in milliseconds before the next attempt.
 */
function calculateBackoff(policy: RetryPolicy, attempt: number): number {
  switch (policy.backoff) {
    case 'fixed': return policy.backoffMs;
    case 'linear': return policy.backoffMs * attempt;
    case 'exponential': return policy.backoffMs * Math.pow(2, attempt - 1);
    default: return policy.backoffMs;
  }
}

function shouldRetry(policy: RetryPolicy, errorMessage?: string): boolean {
  if (!policy.retryOn || policy.retryOn.length === 0) return true;
  if (!errorMessage) return false;

  const normalizedError = errorMessage.toLowerCase();
  return policy.retryOn.some((entry) => normalizedError.includes(entry.toLowerCase()));
}

function evaluateConditionExpression(expr: string, state: GraphState): unknown {
  return safeEvaluateExpression(expr, state);
}

function getResultEvents(result: NodeExecutionResult): GraphEvent[] {
  return Array.isArray(result.events) ? result.events : [];
}

/**
 * Promise-based sleep utility for retry backoff delays.
 *
 * @param ms - Duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
