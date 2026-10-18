/**
 * @file VoiceNodeExecutor.ts
 * @description Executes voice nodes in the orchestration graph by managing a voice
 * pipeline session, collecting turns via `VoiceTurnCollector`, and racing
 * multiple exit conditions (hangup, turns exhausted, keyword, silence timeout,
 * barge-in abort) to determine when the voice node completes.
 *
 * ## Design rationale
 *
 * The executor follows the standard 2-arg `execute(node, state)` contract used by
 * {@link NodeExecutor}. Internally it creates an `AbortController` for barge-in
 * support and optionally merges a parent abort signal from `state.scratch.abortSignal`.
 *
 * Exit conditions are modelled as a **single `Promise.race`** rather than a state
 * machine because the conditions are orthogonal and any one of them can fire at any
 * time. The `settled` flag inside {@link raceExitConditions} guards against
 * double-resolution when two conditions fire within the same microtask. When the race
 * settles, every listener it added, the collector's included, its silence timer and its
 * abort listener are released, so a node that runs again and again on one session and
 * one transport leaves nothing behind.
 *
 * ## State contract
 *
 * Voice transport and session references are expected in `state.scratch`:
 * - `voiceSession` -- a started `VoicePipelineSession`, whose own events the node reads:
 *   `user_input_transcribed`, `conversation_item_added`, `user_state_changed`, `barge_in`
 *   and `close` (`VoiceTransportAdapter` puts it there when given `{ session, orchestrator }`).
 * - `voiceTransport` -- the bidirectional transport EventEmitter (emits `close` / `disconnected`);
 *   without it, the started session's `transport`.
 * - `voiceTransport._voiceSession` -- deprecated, read only without `voiceSession` and kept until
 *   the next minor: an emitter of the pipeline's events relayed under the names
 *   `final_transcript`, `interim_transcript`, `turn_complete`, `speech_start` and `barge_in`.
 *
 * Checkpoint data is stored in `state.scratch[nodeId]` as a {@link VoiceNodeCheckpoint},
 * enabling the graph runtime to resume a voice session from the exact turn index where
 * it was previously suspended.
 *
 * See `VoiceTurnCollector` for transcript buffering and event bridging.
 * See `VoiceTransportAdapter` for how graph I/O is wrapped at the transport level.
 * @see {@link VoiceInterruptError} for the structured barge-in error type.
 */

import { EventEmitter } from 'events';
import type { GraphNode, GraphState, VoiceNodeConfig } from '../ir/types.js';
import type { GraphEvent } from '../events/GraphEvent.js';
import type { NodeExecutionResult } from './NodeExecutor.js';
import { VoiceTurnCollector, type VoiceTurnCollectorEvents } from './VoiceTurnCollector.js';
import { VoiceInterruptError } from '../../io/voice-pipeline/VoiceInterruptError.js';
import type { VoiceSessionEventMap } from '../../io/voice-pipeline/types.js';

/** The silence a `silence-timeout` node waits through, in milliseconds. */
const SILENCE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Checkpoint type
// ---------------------------------------------------------------------------

/**
 * Checkpoint data stored in `state.scratch[nodeId]` after a voice node completes.
 *
 * The graph runtime persists this structure so that a subsequent invocation of the
 * same voice node (e.g. after a graph loop or checkpoint restore) can continue the
 * conversation from `turnIndex` rather than resetting to zero.
 *
 * @example
 * ```ts
 * // Restoring from a checkpoint:
 * const checkpoint = state.scratch['voice-1'] as VoiceNodeCheckpoint;
 * const resumedTurnIndex = checkpoint.turnIndex; // e.g. 5
 * ```
 */
export interface VoiceNodeCheckpoint {
  /** Number of turns completed when the checkpoint was captured. */
  turnIndex: number;

  /**
   * Full transcript buffer at the time of checkpoint.
   *
   * Each entry records a confirmed (final) utterance with its speaker label
   * and wall-clock timestamp, preserving the full conversation history for
   * downstream summarisation or analytics.
   */
  transcript: Array<{ speaker: string; text: string; timestamp: number }>;

  /**
   * Exit reason that caused the voice node to complete.
   * `null` when the checkpoint was captured mid-session (e.g. process crash).
   */
  lastExitReason: string | null;

  /**
   * Maps diarization speaker labels to human-readable names.
   * Reserved for future use -- populated as an empty object today.
   */
  speakerMap: Record<string, string>;

  /**
   * The voice config that was active when this checkpoint was created.
   * Stored so that a resumed session can verify config compatibility before
   * continuing from the persisted turn index.
   */
  sessionConfig: VoiceNodeConfig;
}

// ---------------------------------------------------------------------------
// VoiceNodeExecutor
// ---------------------------------------------------------------------------

/**
 * Executes voice-type graph nodes by running a voice pipeline session and racing
 * multiple exit conditions to determine when the node is done.
 *
 * Exit conditions are evaluated concurrently via a single `Promise` race:
 * - **Hangup** -- transport emits `close` or `disconnected`, or a started session emits `close`.
 * - **Turns exhausted** -- a user turn completes (a started session's `conversation_item_added`
 *   with a user item, or a relayed `turn_complete`) and the collector's count reaches
 *   `config.maxTurns`.
 * - **Keyword** -- a final transcript (a started session's final `user_input_transcribed`, or a
 *   relayed `final_transcript`) contains one of `config.exitKeywords`.
 * - **Silence timeout** -- no speech activity for 30 seconds (when `exitOn: 'silence-timeout'`).
 * - **Abort/barge-in** -- the internal `AbortController` is signalled, either by a
 *   parent abort signal or a `VoiceInterruptError`.
 *
 * @example
 * ```ts
 * const executor = new VoiceNodeExecutor((event) => emitter.emit(event));
 * const result = await executor.execute(voiceNode, graphState);
 * console.log(result.output.exitReason);
 * // 'turns-exhausted' | 'hangup' | 'keyword:goodbye' | 'silence-timeout' | 'interrupted'
 * ```
 *
 * See `VoiceTurnCollector` for session subscription and transcript buffering.
 * @see {@link VoiceInterruptError} -- structured barge-in error that triggers the `interrupted` path.
 */
export class VoiceNodeExecutor {
  /**
   * Creates a new VoiceNodeExecutor.
   *
   * @param eventSink - Callback invoked synchronously for every emitted {@link GraphEvent}.
   *                     Typically bound to the graph runtime's event emitter so that
   *                     voice lifecycle events (`voice_session`, `voice_transcript`, etc.)
   *                     are visible to all graph event consumers.
   */
  constructor(private readonly eventSink: (event: GraphEvent) => void) {}

  /**
   * Execute a voice node. Matches the standard 2-arg `execute(node, state)` signature
   * used throughout the orchestration runtime.
   *
   * ## Lifecycle
   *
   * 1. Validates that `node.executorConfig.type` is `'voice'`.
   * 2. Extracts the started session (`state.scratch.voiceSession`) and the `voiceTransport`
   *    from `state.scratch`, or the started session's own transport (pre-placed by the
   *    graph runtime or `VoiceTransportAdapter`).
   * 3. Checks for a {@link VoiceNodeCheckpoint} to resume from.
   * 4. Emits a `voice_session` started event.
   * 5. Creates an internal `AbortController` for barge-in, wiring it to any parent
   *    abort signal in `state.scratch.abortSignal`.
   * 6. Wires a `VoiceTurnCollector` onto the session and races exit conditions; the
   *    collector's and the race's listeners, the race's timer and the parent abort
   *    listener are released as the race settles.
   * 7. Resolves the exit reason to a route target via the node's edge map.
   * 8. Returns a {@link NodeExecutionResult} with transcript, exit reason, checkpoint,
   *    and optional route target.
   *
   * @param node  - Immutable voice node descriptor from the compiled graph IR.
   *                Must have `executorConfig.type === 'voice'`.
   * @param state - Current (partial) graph state threaded from the runtime.
   *                Must contain `scratch.voiceSession` (a started `VoicePipelineSession`)
   *                or `scratch.voiceTransport` for the voice session.
   * @returns A {@link NodeExecutionResult} with transcript, exit reason, and optional route target.
   *          On success, `output` contains `{ transcript, turns, exitReason, lastSpeaker, interruptedText }`.
   *          `scratchUpdate` carries the {@link VoiceNodeCheckpoint} keyed by node id.
   * @throws Never -- all errors are caught and returned as `{ success: false, error }`.
   *         {@link VoiceInterruptError} is caught and mapped to `exitReason: 'interrupted'`.
   *
   * @see {@link raceExitConditions} for the concurrent exit condition implementation.
   */
  async execute(node: GraphNode, state: Partial<GraphState>): Promise<NodeExecutionResult> {
    const config = node.executorConfig;

    // Guard: only voice nodes should reach this executor.
    if (config.type !== 'voice') {
      return { success: false, error: 'VoiceNodeExecutor received non-voice node' };
    }

    const voiceConfig = config.voiceConfig;
    const scratch = (state as any)?.scratch as Record<string, unknown> | undefined;

    // A started VoicePipelineSession, whose own events the node reads. VoiceTransportAdapter puts it here when it is
    // given `{ session, orchestrator }`.
    const startedSession = scratch?.voiceSession as (EventEmitter & { transport?: unknown }) | undefined;

    // The voice transport must be pre-placed in state.scratch by the graph runtime
    // or VoiceTransportAdapter before executing a voice node, or come with the
    // started session. Without it we cannot detect hangup.
    const transport = (scratch?.voiceTransport ?? startedSession?.transport) as EventEmitter | undefined;
    if (!transport) {
      return { success: false, error: 'Voice node requires voiceTransport in state.scratch' };
    }

    // speak-only nodes (e.g. greet / farewell bookends) deliver a single line
    // to TTS via the transport adapter, then complete. They do NOT race exit
    // conditions — there is no user turn to wait on. The adapter is placed in
    // scratch by `VoiceTransportAdapter.init()`.
    if (voiceConfig.mode === 'speak-only') {
      const adapter = (state as any)?.scratch?.voiceAdapter as
        | { deliverNodeOutput?: (nodeId: string, out: string) => Promise<void> }
        | undefined;
      if (voiceConfig.speakText && adapter?.deliverNodeOutput) {
        try {
          await adapter.deliverNodeOutput(node.id, voiceConfig.speakText);
        } catch {
          // Best-effort: a TTS delivery failure must not strand the graph.
        }
      }
      const speakEdges = (node as any).edges ?? {};
      this.eventSink({
        type: 'voice_session',
        nodeId: node.id,
        action: 'ended',
        exitReason: 'completed',
      });
      return {
        success: true,
        output: { transcript: [], turns: 0, exitReason: 'completed' },
        routeTarget: typeof speakEdges === 'object' ? speakEdges['completed'] : undefined,
      };
    }

    // Check for checkpoint restore -- if the node was previously executed and the
    // graph was suspended/restored, the prior turn count is in the checkpoint.
    // This lets the turn counter continue from where it left off rather than
    // resetting to zero, which would cause premature exits on maxTurns.
    const checkpoint = (state as any)?.scratch?.[node.id] as VoiceNodeCheckpoint | undefined;
    const initialTurnCount = checkpoint?.turnIndex ?? 0;

    // Signal that the voice session is now active for this node.
    this.eventSink({ type: 'voice_session', nodeId: node.id, action: 'started' });

    // Create an internal AbortController so barge-in events or parent cancellation
    // can terminate the exit condition race without waiting for a session event.
    const controller = new AbortController();

    // If a parent abort signal exists in scratch (e.g. from a graph-level timeout
    // or manual cancellation), forward its abort to our internal controller so that
    // the voice session is cancelled when the parent cancels. The listener goes when
    // the race settles, so a node run again and again under one signal leaves none.
    const parentSignal = scratch?.abortSignal as AbortSignal | undefined;
    const onParentAbort = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      // The session whose events the node reads: the started session, under its own
      // names. Without one, and deprecated until the next minor, the emitter a host
      // relays the pipeline's events onto as transport._voiceSession, under the
      // relayed names; without that either, a fresh emitter, which fires nothing, so
      // that only a hangup or an abort ends the node.
      const events: VoiceTurnCollectorEvents = startedSession ? 'session' : 'relayed';
      const session: EventEmitter = startedSession ?? (transport as any)._voiceSession ?? new EventEmitter();

      // Create the turn collector -- it subscribes to the session's transcripts,
      // turns and barge-ins and bridges them into GraphEvents while maintaining a
      // running transcript buffer and turn counter.
      const collector = new VoiceTurnCollector(session, this.eventSink, node.id, initialTurnCount, { events });

      // Race all exit conditions against each other. The first condition to fire
      // determines exitReason and ends the voice node; the collector's listeners
      // go with the race's own.
      const result = await this.raceExitConditions(session, events, collector, voiceConfig, controller, transport).finally(() => {
        collector.dispose();
        parentSignal?.removeEventListener('abort', onParentAbort);
      });

      // Map the exitReason string to a target node id using the edge map.
      // This is how voice nodes implement conditional routing: different exit
      // conditions route to different downstream nodes.
      const edges = (node as any).edges ?? {};
      const routeTarget = typeof edges === 'object' ? edges[result.reason] : undefined;

      // Build the checkpoint so the runtime can persist and restore later.
      // This is written into scratchUpdate and merged back into state.scratch
      // by the graph runtime after execution completes.
      const voiceCheckpoint: VoiceNodeCheckpoint = {
        turnIndex: collector.getTurnCount(),
        transcript: collector.getTranscript(),
        lastExitReason: result.reason,
        speakerMap: {},
        sessionConfig: voiceConfig,
      };

      // Signal that the voice session has ended for this node.
      this.eventSink({
        type: 'voice_session',
        nodeId: node.id,
        action: 'ended',
        exitReason: result.reason,
      });

      return {
        success: true,
        output: {
          transcript: collector.getTranscript(),
          turns: collector.getTurnCount(),
          exitReason: result.reason,
          lastSpeaker: collector.getLastSpeaker(),
          interruptedText: result.interruptedText,
        },
        routeTarget,
        scratchUpdate: { [node.id]: voiceCheckpoint },
      };
    } catch (err) {
      // VoiceInterruptError is a structured barge-in -- the user spoke over the
      // agent. This is not an error condition; it's a valid exit path that the
      // graph should be able to route on. We convert it to a successful result
      // with exitReason: 'interrupted' so edge routing works as expected.
      if (err instanceof VoiceInterruptError) {
        const edges = (node as any).edges ?? {};
        const routeTarget = edges['interrupted'];

        this.eventSink({
          type: 'voice_session',
          nodeId: node.id,
          action: 'ended',
          exitReason: 'interrupted',
        });

        return {
          success: true,
          output: {
            transcript: [],
            turns: 0,
            exitReason: 'interrupted',
            interruptedText: err.interruptedText,
            userSpeech: err.userSpeech,
          },
          routeTarget,
        };
      }

      // Unhandled error -- surface as a failed result so the graph runtime can
      // decide whether to retry, reroute, or halt.
      this.eventSink({
        type: 'voice_session',
        nodeId: node.id,
        action: 'ended',
        exitReason: 'error',
      });
      return { success: false, error: String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Races all configured exit conditions against each other and resolves with
   * the first one that fires.
   *
   * ## How it works
   *
   * Each exit condition is wired as a listener on either the `session` or
   * `transport` EventEmitter, through `subscribe()`, which records how to remove
   * it. All listeners call a shared `settleWith()` helper that settles the outer
   * Promise exactly once (guarded by a `settled` boolean); as it settles, by a
   * resolve or a reject, every listener the race added is removed, the silence
   * timer is cleared and the abort listener is dropped, so a node that loops on
   * one session adds nothing per run.
   *
   * The `AbortController` signal is also monitored -- if it fires with a
   * {@link VoiceInterruptError} the Promise rejects (handled by the caller's
   * catch block), otherwise it resolves with `{ reason: 'interrupted' }`.
   *
   * ## Which events
   *
   * On a started session (`events: 'session'`): a user item in
   * `conversation_item_added` is a turn, a final `user_input_transcribed` is a
   * transcript, the user's `user_state_changed` to `'speaking'` and each turn are
   * speech activity, and the session's `close` is a hangup. On relayed events
   * (`events: 'relayed'`): `turn_complete`, `final_transcript`, and `speech_start`
   * with `turn_complete`, as before.
   *
   * ## Why a Promise race instead of a state machine?
   *
   * The exit conditions are independent and asynchronous. A Promise-based race
   * avoids complex state transitions and lets each condition be a simple
   * event listener. The `settled` guard handles the only tricky case: two
   * conditions firing in the same microtask.
   *
   * @param session    - The session whose events the node reads.
   * @param events     - The names those events come under.
   * @param collector  - Active turn collector tracking turn count and transcript.
   * @param config     - Voice node configuration with exit settings (`maxTurns`,
   *                     `exitOn`, `exitKeywords`).
   * @param controller - Internal AbortController for barge-in signalling.
   * @param transport  - Bidirectional transport EventEmitter that fires `close`
   *                     and `disconnected` on hangup.
   * @returns The winning exit condition's reason string and optional interrupted text.
   */
  private async raceExitConditions(
    session: EventEmitter,
    events: VoiceTurnCollectorEvents,
    collector: VoiceTurnCollector,
    config: VoiceNodeConfig,
    controller: AbortController,
    transport: EventEmitter
  ): Promise<{ reason: string; interruptedText?: string }> {
    return new Promise((resolve, reject) => {
      /** Prevents double-resolution when multiple conditions fire simultaneously. */
      let settled = false;

      /** How to undo each listener and timer the race set up, run once as it settles. */
      const releases: Array<() => void> = [];

      /**
       * Adds a listener and records its removal.
       *
       * @param emitter  - The session or the transport.
       * @param event    - The event.
       * @param listener - What the race runs on it.
       */
      const subscribe = (emitter: EventEmitter, event: string, listener: (...args: any[]) => void): void => {
        emitter.on(event, listener);
        releases.push(() => emitter.off(event, listener));
      };

      /** Removes every listener the race added, clears its timer and drops its abort listener. */
      const release = (): void => {
        for (const undo of releases.splice(0)) undo();
      };

      /**
       * Settle the promise with a resolve value, guarding against double-settle.
       * Every exit condition calls this instead of `resolve()` directly.
       *
       * @param result - The exit condition result containing the reason string.
       */
      const settleWith = (result: { reason: string; interruptedText?: string }): void => {
        if (settled) return;
        settled = true;
        release();
        resolve(result);
      };

      /**
       * Settle the promise with a rejection, guarding against double-settle.
       *
       * @param reason - The rejection: a {@link VoiceInterruptError}.
       */
      const failWith = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        release();
        reject(reason);
      };

      // -- Hangup: transport disconnects -----------------------------------
      // Both `close` and `disconnected` events indicate the transport is gone.
      // We listen for both because different transport implementations emit
      // different event names (WebSocket uses `close`, telephony uses `disconnected`).
      // A started session that closes, by its transport or by a stop, says nothing more.
      const onDisconnect = (): void => settleWith({ reason: 'hangup' });
      subscribe(transport, 'close', onDisconnect);
      subscribe(transport, 'disconnected', onDisconnect);
      if (events === 'session') subscribe(session, 'close', onDisconnect);

      /** Whether a session event's payload is a user item of the conversation: a completed turn. */
      const isUserTurn = (evt: Partial<VoiceSessionEventMap['conversation_item_added']> | undefined): boolean =>
        evt?.item?.role === 'user';

      // -- Turns exhausted -------------------------------------------------
      // Only armed when maxTurns is a positive number. We check the collector's
      // count (not a local counter) because the collector may have been seeded
      // with an initialTurnCount from a checkpoint restore. The collector counts
      // the turn first: it subscribed before the race did.
      if (config.maxTurns && config.maxTurns > 0) {
        const onTurn = (): void => {
          if (collector.getTurnCount() >= config.maxTurns!) {
            settleWith({ reason: 'turns-exhausted' });
          }
        };
        if (events === 'session') {
          subscribe(session, 'conversation_item_added', (evt: Partial<VoiceSessionEventMap['conversation_item_added']> | undefined) => {
            if (isUserTurn(evt)) onTurn();
          });
        } else {
          subscribe(session, 'turn_complete', onTurn);
        }
      }

      // -- Keyword detection -----------------------------------------------
      // Only armed when exitOn is 'keyword' and at least one keyword is provided.
      // The keyword check is case-insensitive and uses substring matching so that
      // "goodbye" matches "okay goodbye then".
      if (config.exitOn === 'keyword' && config.exitKeywords?.length) {
        const onFinal = (said: string): void => {
          const text = said.toLowerCase();
          for (const kw of config.exitKeywords!) {
            if (text.includes(kw.toLowerCase())) {
              settleWith({ reason: `keyword:${kw}` });
              return;
            }
          }
        };
        if (events === 'session') {
          subscribe(session, 'user_input_transcribed', (evt: Partial<VoiceSessionEventMap['user_input_transcribed']> | undefined) => {
            if (evt?.isFinal) onFinal(evt.transcript ?? '');
          });
        } else {
          subscribe(session, 'final_transcript', (evt: any) => onFinal(evt?.text ?? ''));
        }
      }

      // -- Silence timeout (default 30 s) ----------------------------------
      // Only armed when exitOn is 'silence-timeout'. A watchdog timer is reset
      // on every speech activity event. If the timer fires without being reset,
      // the user has been silent for too long and the session ends.
      if (config.exitOn === 'silence-timeout') {
        let silenceTimer: ReturnType<typeof setTimeout> | undefined;

        /**
         * Reset the silence watchdog -- called on any speech activity. Once the race has settled it sets no timer: an
         * emit under way still calls the listeners it began with, the ones the settle removed included.
         */
        const resetTimer = (): void => {
          if (settled) return;
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => settleWith({ reason: 'silence-timeout' }), SILENCE_TIMEOUT_MS);
        };
        releases.push(() => clearTimeout(silenceTimer));

        // Reset as the user begins to speak and as a turn completes, to cover all
        // speech activity signals.
        if (events === 'session') {
          subscribe(session, 'user_state_changed', (evt: Partial<VoiceSessionEventMap['user_state_changed']> | undefined) => {
            if (evt?.newState === 'speaking') resetTimer();
          });
          subscribe(session, 'conversation_item_added', (evt: Partial<VoiceSessionEventMap['conversation_item_added']> | undefined) => {
            if (isUserTurn(evt)) resetTimer();
          });
        } else {
          subscribe(session, 'speech_start', resetTimer);
          subscribe(session, 'turn_complete', resetTimer);
        }
        resetTimer(); // Start the initial timer immediately.
      }

      // -- Abort signal (barge-in or parent cancellation) ------------------
      // If the abort reason is a VoiceInterruptError, we reject the Promise
      // (the caller's catch block converts it to exitReason: 'interrupted').
      // For any other abort reason (e.g. parent timeout), we resolve normally
      // with reason: 'interrupted'.
      const onAbort = (): void => {
        const reason = controller.signal.reason;
        if (reason instanceof VoiceInterruptError) {
          failWith(reason);
        } else {
          settleWith({ reason: 'interrupted' });
        }
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      releases.push(() => controller.signal.removeEventListener('abort', onAbort));
    });
  }
}
