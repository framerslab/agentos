/**
 * @file GraphEvent.ts
 * @description Discriminated union of all runtime events emitted during an AgentOS graph run,
 * plus a `GraphEventEmitter` that supports both listener-based and async-iterable consumption.
 *
 * Events are emitted in strict causal order within a single run. Consumers may subscribe via
 * `on()` / `off()` for push-based handling, or via `stream()` for pull-based async iteration.
 */

import type { GraphState, GraphNode, GraphEdge } from '../ir/types.js';

export interface MissionEvalScores {
  feasibility: number;
  costEfficiency: number;
  latency: number;
  robustness: number;
  overall: number;
}

export interface MissionGraphPatch {
  addNodes: GraphNode[];
  addEdges: GraphEdge[];
  removeNodes?: string[];
  rewireEdges?: Array<{ from: string; to: string; newTarget: string }>;
  reason: string;
  estimatedCostDelta: number;
  estimatedLatencyDelta: number;
}

export type MissionExpansionTrigger =
  | 'agent_request'
  | 'supervisor_manage'
  | 'planner_reeval';

/**
 * Optional per-node telemetry attached to `node_end` events. Populated by
 * executors that have meaningful internal activity worth surfacing — today
 * the GMI executor reports the ReAct-loop iteration count, the number of
 * tool calls and errors observed, and whether the iteration cap was hit.
 * Other executors omit `telemetry` entirely.
 */
export interface NodeTelemetry {
  /** Number of internal LLM iterations the node ran (GMI/ReAct loop). */
  iterations?: number;
  /** Successful tool result events observed during execution. */
  toolCalls?: number;
  /** Failed tool calls observed during execution. */
  toolErrors?: number;
  /** True when the loop hit `maxIterations` without a natural termination. */
  iterationsExhausted?: boolean;
}

// ---------------------------------------------------------------------------
// GraphEvent discriminated union
// ---------------------------------------------------------------------------

/**
 * All runtime events emitted by the graph executor.
 *
 * Every variant carries a `type` discriminant so consumers can narrow with a
 * simple `switch (event.type)` or exhaustive-check library.
 */
export type GraphEvent =
  /** Emitted once when the executor accepts a new run request. */
  | { type: 'run_start'; runId: string; graphId: string }

  /** Emitted immediately before a node's executor is called. */
  | { type: 'node_start'; nodeId: string; state: Partial<GraphState> }

  /**
   * Emitted after a node's executor returns successfully.
   * `durationMs` is wall-clock time from `node_start` to `node_end`.
   * `telemetry` carries optional per-executor diagnostic counters — populated
   * today by the GMI executor (iteration count, tool calls, tool errors,
   * whether the iteration cap was hit). Other executors leave it undefined.
   */
  | {
      type: 'node_end';
      nodeId: string;
      output: unknown;
      durationMs: number;
      telemetry?: NodeTelemetry;
    }

  /** Emitted when the executor resolves a routing condition and moves to the next node. */
  | { type: 'edge_transition'; sourceId: string; targetId: string; edgeType: string }

  /**
   * Streaming token delta from an LLM (GMI) node.
   * Multiple deltas are emitted per node; concatenate `content` to reconstruct the full response.
   */
  | { type: 'text_delta'; nodeId: string; content: string }

  /** Emitted when a node issues a tool call to the tool catalogue. */
  | { type: 'tool_call'; nodeId: string; toolName: string; args: unknown }

  /** Emitted when a tool call returns (whether success or structured error). */
  | { type: 'tool_result'; nodeId: string; toolName: string; result: unknown }

  /**
   * Emitted after each guardrail evaluation.
   * `passed: false` indicates a violation; `action` mirrors `GuardrailPolicy.onViolation`.
   */
  | {
      type: 'guardrail_result';
      nodeId: string;
      guardrailId: string;
      passed: boolean;
      action: string;
    }

  /** Emitted when a post-approval guardrail vetoes a human-node approval. */
  | {
      type: 'guardrail:hitl-override';
      nodeId: string;
      guardrailId: string;
      reason: string;
    }

  /** Emitted after the runtime successfully persists a checkpoint snapshot. */
  | { type: 'checkpoint_saved'; checkpointId: string; nodeId: string }

  /**
   * Emitted when graph execution is suspended mid-run.
   * - `human_approval`     — node requires operator sign-off before proceeding.
   * - `error`              — unrecoverable error after exhausting retry budget.
   * - `guardrail_violation` — a `block` guardrail fired, halting the run.
   */
  | {
      type: 'interrupt';
      nodeId: string;
      reason: 'human_approval' | 'error' | 'guardrail_violation';
    }

  /** Emitted after memory traces are loaded into `GraphState.memory` for a node. */
  | { type: 'memory_read'; nodeId: string; traceCount: number }

  /** Emitted after a memory trace is staged or committed for a node. */
  | { type: 'memory_write'; nodeId: string; traceType: string }

  /** Emitted after `DiscoveryPolicy`-triggered capability discovery completes. */
  | { type: 'discovery_result'; nodeId: string; toolsFound: string[] }

  /**
   * Emitted once when the graph run concludes normally.
   * `totalDurationMs` is wall-clock time from `run_start` to `run_end`.
   */
  | { type: 'run_end'; runId: string; finalOutput: unknown; totalDurationMs: number }

  /** Emitted when a node's wall-clock execution time exceeds `GraphNode.timeout`. */
  | { type: 'node_timeout'; nodeId: string; timeoutMs: number }

  /**
   * Emitted for unhandled exceptions or structured runtime errors.
   * `nodeId` is absent for graph-level errors that occur outside any node's scope.
   */
  | { type: 'error'; nodeId?: string; error: { message: string; code: string } }

  /**
   * Live STT transcription -- both interim (partial) and final (confirmed) results.
   *
   * Emitted by the internal voice turn collector for every speech recognition result.
   * Consumers should check `isFinal` to distinguish speculative partials from
   * confirmed utterances. Only final results are persisted in the transcript buffer.
   *
   * - `speaker` is absent when the STT provider does not support diarization.
   * - `confidence` ranges from `0` (no confidence) to `1` (maximum confidence).
   *
   * See `VoiceTurnCollector` for the internal event source.
   */
  | {
      type: 'voice_transcript';
      nodeId: string;
      text: string;
      isFinal: boolean;
      speaker?: string;
      confidence: number;
    }

  /**
   * Audio chunk metadata emitted when audio data flows through the voice pipeline.
   *
   * The actual PCM/opus audio bytes flow via `IStreamTransport`, NOT through events.
   * This event carries only metadata (direction, format, duration) so that the graph
   * event bus can track audio flow without handling binary payloads.
   *
   * - `direction: 'inbound'` -- user microphone audio arriving at the STT engine.
   * - `direction: 'outbound'` -- agent TTS audio being sent to the user.
   * - `durationMs` is `0` for streaming chunks where total duration is unknown.
   *
   * See `VoiceTransportAdapter` for the transport-layer emitter.
   */
  | {
      type: 'voice_audio';
      nodeId: string;
      direction: 'inbound' | 'outbound';
      format: string;
      durationMs: number;
    }

  /**
   * User barge-in -- the user interrupted the agent while it was speaking.
   *
   * Emitted by the internal voice turn collector when the session fires a `barge_in` event.
   * This signals that TTS playback should be cancelled and the graph may need to
   * reroute to handle the interruption (e.g. re-enter a listening state).
   *
   * - `interruptedText` -- what the agent was saying when interrupted.
   * - `userSpeech` -- what the user said that triggered the interruption.
   *
   * See `VoiceInterruptError` for the structured error variant used in graph-level handling.
   */
  | { type: 'voice_barge_in'; nodeId: string; interruptedText: string; userSpeech: string }

  /**
   * User turn complete -- the endpoint detector determined the user finished speaking.
   *
   * Emitted by both the internal voice turn collector (from session events) and
   * the voice transport adapter (from transport events). Carries the full
   * transcript for the completed turn and the endpoint detection reason.
   *
   * - `turnIndex` is 1-based and reflects the post-increment count (includes
   *   checkpoint-restored turns when resuming from a checkpoint).
   * - `endpointReason` describes why the endpoint was detected (e.g. `'punctuation'`,
   *   `'silence'`, `'acoustic'`, `'unknown'`).
   *
   * See `VoiceTurnCollector` for turn counting and event emission.
   */
  | {
      type: 'voice_turn_complete';
      nodeId: string;
      transcript: string;
      turnIndex: number;
      endpointReason: string;
    }

  /**
   * Voice session lifecycle event -- signals when a voice session starts or ends.
   *
   * Emitted by both the voice node executor (at the graph node level) and
   * the voice transport adapter (at the transport level). The `nodeId` is the
   * graph node id for executor-level events, or `'__transport__'` for
   * transport-level events.
   *
   * - `action: 'started'` -- the session is now active and accepting audio.
   * - `action: 'ended'` -- the session has terminated; `exitReason` describes why
   *   (e.g. `'turns-exhausted'`, `'hangup'`, `'interrupted'`, `'error'`,
   *   `'transport-disposed'`).
   *
   * See `VoiceNodeExecutor` for node-level lifecycle emission.
   * See `VoiceTransportAdapter` for transport-level lifecycle emission.
   */
  | { type: 'voice_session'; nodeId: string; action: 'started' | 'ended'; exitReason?: string }

  // -------------------------------------------------------------------------
  // Mission orchestrator events
  // -------------------------------------------------------------------------

  /** Emitted when the Tree of Thought planner begins decomposing a goal. */
  | { type: 'mission:planning_start'; goal: string }

  /** Emitted for each candidate branch generated during Phase 1 (divergent exploration). */
  | {
      type: 'mission:branch_generated';
      branchId: string;
      summary: string;
      scores?: MissionEvalScores;
    }

  /** Emitted when the evaluator selects a branch in Phase 2. */
  | { type: 'mission:branch_selected'; branchId: string; reason: string }

  /** Emitted when Phase 3 (Reflexion) applies refinements to the selected branch. */
  | { type: 'mission:refinement_applied'; changes: string[] }

  /** Emitted when the planned graph compiles to `CompiledExecutionGraph`. */
  | { type: 'mission:graph_compiled'; nodeCount: number; edgeCount: number; estimatedCost: number }

  /** Emitted when an expansion is proposed (agent request, supervisor, or planner loop). */
  | {
      type: 'mission:expansion_proposed';
      patch: MissionGraphPatch;
      trigger: MissionExpansionTrigger;
      reason?: string;
    }

  /** Emitted when an expansion is approved (auto or user). */
  | { type: 'mission:expansion_approved'; by: 'auto' | 'user' }

  /** Emitted when a proposed expansion is explicitly rejected. */
  | { type: 'mission:expansion_rejected'; by: 'user'; reason: string }

  /** Emitted after an expansion GraphPatch is applied. */
  | { type: 'mission:expansion_applied'; nodesAdded: number; edgesAdded?: number }

  /** Emitted when a mission checkpoint is saved for later replay/resume. */
  | { type: 'mission:checkpoint_saved'; checkpointId: string; nodeId: string }

  /** Emitted when a guardrail threshold is hit (agent count, cost, etc). */
  | { type: 'mission:threshold_reached'; threshold: string; value: number; cap: number }

  /** Periodic cost update for live dashboards and CLI. */
  | { type: 'mission:cost_update'; totalSpent: number; costCap: number }

  /** Emitted once when the mission finishes. */
  | { type: 'mission:complete'; summary: string; totalCost: number; totalDurationMs: number; agentCount: number }

  /** Emitted when a new agent is spawned during execution. */
  | { type: 'mission:agent_spawned'; agentId: string; role: string; provider: string; model: string }

  /** Emitted when the EmergentCapabilityEngine forges a new tool. */
  | { type: 'mission:tool_forged'; toolId: string; name: string; mode: 'compose' | 'sandbox' }

  /** Emitted when user approval is required before continuing. */
  | { type: 'mission:approval_required'; action: string; details?: unknown };

// ---------------------------------------------------------------------------
// GraphEventEmitter
// ---------------------------------------------------------------------------

/**
 * Lightweight event emitter for `GraphEvent` values.
 *
 * Supports both:
 * - **Push-based** consumption via `on()` / `off()` callbacks.
 * - **Pull-based** consumption via the `stream()` async generator.
 *
 * The emitter is single-use: once `close()` is called it is permanently closed
 * and subsequent `emit()` calls are silently ignored.
 *
 * @example
 * ```ts
 * const emitter = new GraphEventEmitter();
 *
 * // Pull-based — collect events in order
 * async function consume() {
 *   for await (const event of emitter.stream()) {
 *     console.log(event.type);
 *   }
 * }
 *
 * emitter.emit({ type: 'run_start', runId: 'r1', graphId: 'g1' });
 * emitter.close();
 * await consume(); // logs 'run_start'
 * ```
 */
export class GraphEventEmitter {
  /** Registered push-based listener callbacks. */
  private readonly listeners: Array<(event: GraphEvent) => void> = [];

  /**
   * `true` after `close()` has been called. Once closed, `emit()` becomes a no-op
   * and all active `stream()` generators are drained and terminated.
   */
  private closed = false;

  // ---------------------------------------------------------------------------
  // Push-based API
  // ---------------------------------------------------------------------------

  /**
   * Registers a callback that is invoked synchronously for every subsequent `emit()` call.
   *
   * @param listener - Function to call with each emitted `GraphEvent`.
   */
  on(listener: (event: GraphEvent) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Removes a previously registered listener.
   * If the listener was not registered, this is a no-op.
   *
   * @param listener - The exact function reference passed to `on()`.
   */
  off(listener: (event: GraphEvent) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Dispatches `event` to all registered listeners and any active `stream()` generators.
   * If `close()` has already been called, this method is a no-op.
   *
   * @param event - The `GraphEvent` to dispatch.
   */
  emit(event: GraphEvent): void {
    if (this.closed) return;

    // Notify all push-based listeners synchronously.
    for (const listener of this.listeners) {
      listener(event);
    }

    // Notify all active stream generators via their internal dispatch functions.
    for (const dispatch of this.streamDispatchers) {
      dispatch(event);
    }
  }

  /**
   * Permanently closes the emitter.
   *
   * - Future `emit()` calls are silently ignored.
   * - Active `stream()` generators are signalled to drain their queues and return.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Signal each active stream generator to complete.
    for (const complete of this.streamCompleters) {
      complete();
    }
  }

  // ---------------------------------------------------------------------------
  // Pull-based API (async iterable)
  // ---------------------------------------------------------------------------

  /**
   * Internal set of per-stream event dispatch functions.
   * Each active `stream()` generator registers one entry here.
   */
  private readonly streamDispatchers = new Set<(event: GraphEvent) => void>();

  /**
   * Internal set of per-stream close signals.
   * Each active `stream()` generator registers one entry here.
   */
  private readonly streamCompleters = new Set<() => void>();

  /**
   * Returns an `AsyncGenerator` that yields every `GraphEvent` emitted after the
   * call to `stream()`, in the exact order they were emitted.
   *
   * The generator completes (returns) when `close()` is called on the emitter
   * and any queued events have been yielded.
   *
   * Multiple concurrent `stream()` calls are supported; each gets an independent
   * copy of the event stream.
   *
   * @example
   * ```ts
   * for await (const event of emitter.stream()) {
   *   if (event.type === 'run_end') break;
   * }
   * ```
   */
  async *stream(): AsyncGenerator<GraphEvent> {
    // Per-generator queue of events waiting to be yielded.
    const queue: GraphEvent[] = [];

    // When non-null, a pending `await next` in the generator loop is resolved here.
    let pendingResolve: ((value: IteratorResult<GraphEvent>) => void) | null = null;

    /**
     * Called by `emit()` — either resolves a waiting generator or enqueues the event.
     */
    const dispatch = (event: GraphEvent): void => {
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    /** Called by `close()` — wakes up a waiting generator so it can drain and exit. */
    const complete = (): void => {
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        // Signal the generator loop to re-check the closed flag.
        resolve({ value: undefined as unknown as GraphEvent, done: true });
      }
    };

    this.streamDispatchers.add(dispatch);
    this.streamCompleters.add(complete);

    try {
      // If the emitter was already closed before stream() was called, drain nothing.
      while (!this.closed || queue.length > 0) {
        if (queue.length > 0) {
          // There are queued events — yield them immediately without suspending.
          yield queue.shift()!;
        } else if (this.closed) {
          // Queue is empty and emitter is closed — we are done.
          break;
        } else {
          // Queue is empty and emitter is still open — suspend until the next event.
          const result = await new Promise<IteratorResult<GraphEvent>>((resolve) => {
            pendingResolve = resolve;
          });

          if (result.done) {
            // `complete()` was called — drain remaining queue items then exit.
            while (queue.length > 0) {
              yield queue.shift()!;
            }
            break;
          }

          yield result.value;
        }
      }
    } finally {
      // Always clean up registrations, even if the caller breaks out of the for-await loop.
      this.streamDispatchers.delete(dispatch);
      this.streamCompleters.delete(complete);
      if (pendingResolve !== null) {
        // Resolve any dangling promise to avoid memory leaks.
        const resolve = pendingResolve as (value: IteratorResult<GraphEvent>) => void;
        pendingResolve = null;
        resolve({ value: undefined as unknown as GraphEvent, done: true });
      }
    }
  }
}
