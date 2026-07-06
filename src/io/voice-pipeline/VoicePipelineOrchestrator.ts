/**
 * @module voice-pipeline/VoicePipelineOrchestrator
 *
 * Central state machine that wires together transport, STT, endpoint detection,
 * TTS, barge-in handling, and the agent session into a coordinated real-time
 * voice conversation loop.
 *
 * ## State transitions
 *
 * ```
 * IDLE -----> startSession() ---------> LISTENING
 * LISTENING -> turn_complete ----------> PROCESSING
 * PROCESSING -> LLM tokens start -----> SPEAKING
 * SPEAKING --> TTS flush_complete -----> LISTENING
 * SPEAKING --> barge-in (cancel) ------> INTERRUPTING -> LISTENING
 * ANY ------> transport disconnect ----> CLOSED
 * ANY ------> stopSession() -----------> CLOSED
 * ```
 *
 * ## Design notes
 *
 * - The orchestrator does NOT resolve providers from ExtensionManager yet.
 *   All components must be injected via {@link VoicePipelineOverrides}.
 *   ExtensionManager integration is a planned future task.
 * - Event wiring is done once during `startSession()` and never rewired.
 *   The transport/STT/TTS sessions are immutable for the session's lifetime.
 * - A watchdog timer prevents the pipeline from staying in LISTENING forever
 *   if the user walks away (default 30 s). The watchdog resets after each
 *   completed turn.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type {
  AudioFrame,
  EncodedAudioChunk,
  IBargeinHandler,
  IDiarizationEngine,
  IEndpointDetector,
  IStreamTransport,
  IStreamingSTT,
  IStreamingTTS,
  IVoicePipelineAgentSession,
  PipelineState,
  StreamingSTTSession,
  StreamingTTSSession,
  TranscriptEvent,
  TurnCompleteEvent,
  VoicePipelineConfig,
  VoicePipelineSession,
  VoiceTurnMetadata,
} from './types.js';

// ============================================================================
// Overrides (dependency injection for testing)
// ============================================================================

/**
 * Overrides for injecting pre-built components, primarily for unit testing.
 * In production, components would be resolved from ExtensionManager by
 * provider ID (a planned future enhancement).
 *
 * See `VoicePipelineOrchestrator.startSession()` for the method that accepts these overrides.
 *
 * @example
 * ```typescript
 * const overrides: VoicePipelineOverrides = {
 *   streamingSTT: myDeepgramSTT,
 *   streamingTTS: myOpenAITTS,
 *   endpointDetector: new HeuristicEndpointDetector(),
 *   bargeinHandler: new HardCutBargeinHandler(),
 * };
 * ```
 */
export interface VoicePipelineOverrides {
  /** Pre-built streaming STT provider (bypasses ExtensionManager resolution). */
  streamingSTT?: IStreamingSTT;
  /** Pre-built streaming TTS provider (bypasses ExtensionManager resolution). */
  streamingTTS?: IStreamingTTS;
  /** Pre-built endpoint detector instance. */
  endpointDetector?: IEndpointDetector;
  /** Pre-built barge-in handler instance. */
  bargeinHandler?: IBargeinHandler;
  /** Pre-built diarization engine (optional; only needed for multi-speaker). */
  diarizationEngine?: IDiarizationEngine;
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * VoicePipelineOrchestrator is the central state machine for the AgentOS
 * streaming voice pipeline. It coordinates audio capture, speech recognition,
 * endpoint detection, agent inference, text-to-speech synthesis, and barge-in
 * handling into a seamless real-time conversation loop.
 *
 * ## Events emitted
 *
 * | Event             | Payload                                      |
 * |-------------------|----------------------------------------------|
 * | `'state_changed'` | `{ from: PipelineState, to: PipelineState }`  |
 * | `'turn_complete'` | {@link TurnCompleteEvent}                     |
 *
 * @see {@link VoicePipelineSession} for the public session interface returned by `startSession()`.
 */
export class VoicePipelineOrchestrator extends EventEmitter {
  // --------------------------------------------------------------------------
  // Private state
  // --------------------------------------------------------------------------

  /** Current pipeline state. Transitions are managed exclusively by the internal state setter. */
  private _state: PipelineState = 'idle';

  /** Active STT session created during `startSession()`. Null when idle or closed. */
  private _sttSession: StreamingSTTSession | null = null;

  /** Active TTS session created during `startSession()`. Null when idle or closed. */
  private _ttsSession: StreamingTTSSession | null = null;

  /** The endpoint detector wired during `startSession()`. Null when idle or closed. */
  private _endpointDetector: IEndpointDetector | null = null;

  /** The barge-in handler consulted when speech is detected during SPEAKING. Null when idle or closed. */
  private _bargeinHandler: IBargeinHandler | null = null;

  /** The transport bound to this session. Null when idle or closed. */
  private _transport: IStreamTransport | null = null;

  /** The agent session adapter for turn-based conversation. Null when idle or closed. */
  private _agentSession: IVoicePipelineAgentSession | null = null;

  /**
   * Watchdog timer ID for max turn duration. Fires a synthetic speech_end
   * VAD event if the pipeline stays in LISTENING too long without a turn_complete.
   */
  private _watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tracks cumulative TTS text for barge-in context. Reset at the start
   * of each agent response (PROCESSING -> SPEAKING transition).
   */
  private _currentTTSText = '';

  /**
   * Tracks cumulative played duration (ms) for barge-in context.
   * Incremented as each {@link EncodedAudioChunk} is forwarded to the transport.
   */
  private _currentPlayedMs = 0;

  // --------------------------------------------------------------------------
  // Public getters
  // --------------------------------------------------------------------------

  /**
   * Current pipeline state (read-only).
   *
   * @example
   * ```typescript
   * if (orchestrator.state === 'listening') {
   *   console.log('Waiting for user input...');
   * }
   * ```
   */
  get state(): PipelineState {
    return this._state;
  }

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  /**
   * Create a new orchestrator with the given pipeline configuration.
   *
   * The orchestrator starts in `'idle'` state. Call `startSession()`
   * to wire up components and transition to `'listening'`.
   *
   * @param config - Top-level pipeline configuration specifying providers and options.
   */
  constructor(private readonly config: VoicePipelineConfig) {
    super();
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start a voice session. Accepts pre-built components via overrides for testing.
   * In production, components would be resolved from ExtensionManager (future task).
   *
   * This method:
   * 1. Validates the orchestrator is in `'idle'` state.
   * 2. Creates STT and TTS sub-sessions from the provided factories.
   * 3. Wires all event handlers (transport -> STT -> endpoint -> agent -> TTS -> transport).
   * 4. Transitions to `'listening'` and starts the watchdog timer.
   * 5. Returns a {@link VoicePipelineSession} handle.
   *
   * @param transport - The bidirectional audio/text stream transport.
   * @param agentSession - The agent session adapter for turn-based conversation.
   * @param overrides - Optional pre-built components (for testing or manual wiring).
   * @returns A live VoicePipelineSession object.
   *
   * @throws {Error} If the orchestrator is not in `'idle'` state.
   * @throws {Error} If any required component (STT, TTS, endpoint, bargein) is missing.
   */
  async startSession(
    transport: IStreamTransport,
    agentSession: IVoicePipelineAgentSession,
    overrides?: VoicePipelineOverrides
  ): Promise<VoicePipelineSession> {
    // Guard: only one session per orchestrator instance
    if (this._state !== 'idle') {
      throw new Error(
        `Cannot start session in state '${this._state}'; expected 'idle'. ` +
          `Create a new VoicePipelineOrchestrator instance for a new session.`
      );
    }

    this._transport = transport;
    this._agentSession = agentSession;

    // Extract injected components from overrides
    const stt = overrides?.streamingSTT;
    const tts = overrides?.streamingTTS;
    const endpointDetector = overrides?.endpointDetector;
    const bargeinHandler = overrides?.bargeinHandler;

    // All four core components are mandatory — fail fast with clear messages
    if (!stt) {
      throw new Error(
        'streamingSTT is required (pass via overrides or wait for ExtensionManager support).'
      );
    }
    if (!tts) {
      throw new Error(
        'streamingTTS is required (pass via overrides or wait for ExtensionManager support).'
      );
    }
    if (!endpointDetector) {
      throw new Error(
        'endpointDetector is required. Pass a HeuristicEndpointDetector or AcousticEndpointDetector via overrides.'
      );
    }
    if (!bargeinHandler) {
      throw new Error(
        'bargeinHandler is required. Pass a HardCutBargeinHandler or SoftFadeBargeinHandler via overrides.'
      );
    }

    // Create provider sub-sessions with pipeline-level config
    const sttSession = await stt.startSession({
      language: this.config.language,
      providerOptions: this.config.sttOptions,
    });
    const ttsSession = await tts.startSession({
      voice: this.config.voice,
      format: this.config.format,
      providerOptions: this.config.ttsOptions,
      expressiveness: this.config.ttsExpressiveness,
    });

    // Store references for use by wiring helpers and teardown
    this._sttSession = sttSession;
    this._ttsSession = ttsSession;
    this._endpointDetector = endpointDetector;
    this._bargeinHandler = bargeinHandler;

    // Wire the event pipeline: transport -> STT -> endpoint -> agent -> TTS -> transport
    this._wireTransportToSTT(transport, sttSession);
    this._wireSTTToEndpoint(sttSession, endpointDetector, transport);
    this._wireTurnComplete(endpointDetector, transport, agentSession, ttsSession);
    this._wireTTSToTransport(ttsSession, transport);
    this._wireBargein(sttSession, ttsSession, bargeinHandler, transport, agentSession);
    this._wireDisconnect(transport, sttSession, ttsSession);

    // IDLE -> LISTENING: audio can now flow
    this._setState('listening');

    // Start the watchdog timer to prevent indefinite LISTENING
    this._resetWatchdog();

    // Build the public VoicePipelineSession facade
    const sessionId = randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- needed for closure
    const orchestrator = this;
    const session: VoicePipelineSession = Object.assign(new EventEmitter(), {
      sessionId,
      get state(): PipelineState {
        return orchestrator._state;
      },
      transport,
      async close(reason?: string): Promise<void> {
        await orchestrator.stopSession(reason);
      },
    });

    // Forward internal state_changed events to the public session as state_change
    this.on('state_changed', (evt) => session.emit('state_change', evt.to));

    return session;
  }

  /**
   * Stop the current session, tearing down all sub-sessions and timers.
   *
   * Safe to call multiple times -- subsequent calls after the first are no-ops.
   *
   * @param reason - Optional human-readable reason for diagnostics.
   */
  async stopSession(reason?: string): Promise<void> {
    // Idempotent: already closed, nothing to do
    if (this._state === 'closed') return;

    // Cancel the watchdog first to prevent it firing during teardown
    this._clearWatchdog();

    // Tear down sub-sessions (null-safe via optional chaining)
    this._sttSession?.close();
    this._ttsSession?.close();
    this._transport?.close(1000, reason);

    // Transition to terminal state
    this._setState('closed');

    // Release references to allow garbage collection of provider resources
    this._sttSession = null;
    this._ttsSession = null;
    this._endpointDetector = null;
    this._bargeinHandler = null;
    this._transport = null;
    this._agentSession = null;
  }

  // --------------------------------------------------------------------------
  // Public integration points for VoiceTransportAdapter / graph nodes
  // --------------------------------------------------------------------------

  /**
   * Wait for the next user turn to complete.
   *
   * Wraps the internal `'turn_complete'` event in a one-shot Promise so that
   * graph nodes (via VoiceTransportAdapter) can `await` user input without
   * having to manage raw EventEmitter subscriptions themselves.
   *
   * Resolves with the first {@link TurnCompleteEvent} fired after this call.
   * If the session is closed before a turn completes, the Promise will never
   * resolve -- callers should race it against a session-close signal if needed.
   *
   * @returns A Promise that resolves with the completed turn event.
   *
   * @example
   * ```typescript
   * const turn = await orchestrator.waitForUserTurn();
   * console.log('User said:', turn.transcript);
   * console.log('Reason:', turn.reason);
   * ```
   */
  async waitForUserTurn(): Promise<TurnCompleteEvent> {
    return new Promise<TurnCompleteEvent>((resolve) => {
      // `once` ensures the listener is auto-removed after the first emission,
      // preventing memory leaks when waitForUserTurn is called repeatedly.
      this.once('turn_complete', (event: TurnCompleteEvent) => resolve(event));
    });
  }

  /**
   * Push text to the active TTS session.
   *
   * Accepts either a plain string or an `AsyncIterable<string>` of token chunks
   * (e.g. a streaming LLM response). Calls `pushTokens()` on the active TTS
   * session for each token, then calls `flush()` to signal end-of-utterance.
   *
   * Used by VoiceTransportAdapter to deliver graph node output as speech
   * without the caller needing a direct reference to the TTS session.
   *
   * @param text - A complete string, or an async iterable of string tokens.
   *
   * @throws {Error} If there is no active TTS session (i.e. session not started
   *   or already stopped).
   *
   * @example
   * ```typescript
   * // Plain string
   * await orchestrator.pushToTTS('Hello, how can I help?');
   *
   * // Streaming tokens from an LLM
   * await orchestrator.pushToTTS(llm.streamTokens(prompt));
   * ```
   */
  async pushToTTS(text: string | AsyncIterable<string>): Promise<void> {
    const ttsSession = this._ttsSession;
    if (!ttsSession) {
      throw new Error(
        'No active TTS session. Ensure startSession() has been called and the session has not been stopped.'
      );
    }

    if (typeof text === 'string') {
      // Single string: push all at once
      ttsSession.pushTokens(text);
    } else {
      // Async iterable: push token-by-token as they arrive from the LLM
      for await (const token of text) {
        ttsSession.pushTokens(token);
      }
    }

    // Signal end-of-utterance so the TTS provider can finalise synthesis
    await ttsSession.flush();
  }

  // --------------------------------------------------------------------------
  // Wiring helpers -- each method connects one segment of the event pipeline
  // --------------------------------------------------------------------------

  /**
   * Wire segment 1: Transport -> STT.
   *
   * Every inbound audio frame from the transport is forwarded directly to
   * the STT session for recognition. No buffering or resampling is done here;
   * the STT provider is expected to handle sample rate conversion internally.
   *
   * @param transport - The bidirectional transport receiving client audio.
   * @param sttSession - The STT session that will process the audio.
   */
  private _wireTransportToSTT(transport: IStreamTransport, sttSession: StreamingSTTSession): void {
    transport.on('audio', (frame: AudioFrame) => {
      sttSession.pushAudio(frame);
    });
  }

  /**
   * Wire segment 2: STT -> Endpoint Detector + Transport.
   *
   * Every transcript event from STT is:
   * 1. Forwarded to the endpoint detector for turn-boundary analysis.
   * 2. Relayed to the transport so the client can display real-time captions.
   *
   * @param sttSession - The STT session emitting transcript events.
   * @param endpointDetector - The detector analysing transcripts for turn boundaries.
   * @param transport - The transport for relaying transcript events to the client.
   */
  private _wireSTTToEndpoint(
    sttSession: StreamingSTTSession,
    endpointDetector: IEndpointDetector,
    transport: IStreamTransport
  ): void {
    sttSession.on('transcript', (transcript: TranscriptEvent) => {
      // Feed the endpoint detector so it can check for terminal punctuation,
      // backchannel phrases, etc.
      endpointDetector.pushTranscript(transcript);

      // Relay to the client for real-time caption display
      transport.sendControl({
        type: 'transcript',
        text: transcript.text,
        isFinal: transcript.isFinal,
        confidence: transcript.confidence,
      });
    });
  }

  /**
   * Wire segment 3: Endpoint Detector -> Agent -> TTS.
   *
   * When the endpoint detector fires `turn_complete`, the orchestrator:
   * 1. Transitions LISTENING -> PROCESSING.
   * 2. Sends the transcript to the agent session.
   * 3. Transitions PROCESSING -> SPEAKING as LLM tokens start arriving.
   * 4. Pipes each token to the TTS session.
   *
   * The turn is only processed if the orchestrator is currently in LISTENING
   * state, preventing duplicate processing from stale events.
   *
   * @param endpointDetector - The detector that fires turn_complete events.
   * @param transport - For sending agent_thinking/agent_speaking control messages.
   * @param agentSession - The agent session that generates the response.
   * @param ttsSession - The TTS session that synthesises the response as audio.
   */
  private _wireTurnComplete(
    endpointDetector: IEndpointDetector,
    transport: IStreamTransport,
    agentSession: IVoicePipelineAgentSession,
    ttsSession: StreamingTTSSession
  ): void {
    endpointDetector.on('turn_complete', async (event: TurnCompleteEvent) => {
      // Guard: only process turn_complete when we're actively listening.
      // This prevents processing stale events that arrive after a barge-in
      // or transport disconnect has already moved us out of LISTENING.
      if (this._state !== 'listening') return;

      // Stop the watchdog -- the user has finished speaking
      this._clearWatchdog();

      // LISTENING -> PROCESSING: agent is now generating a response
      this._setState('processing');
      transport.sendControl({ type: 'agent_thinking' });

      // Build turn metadata for the agent so it can adapt its response
      const metadata: VoiceTurnMetadata = {
        speakers: [],
        endpointReason: event.reason,
        speechDurationMs: event.durationMs,
        wasInterrupted: false,
        transcriptConfidence: event.confidence,
      };

      // Begin streaming the agent's response
      const tokenStream = agentSession.sendText(event.transcript, metadata);

      // PROCESSING -> SPEAKING: first tokens are about to flow
      this._setState('speaking');
      this._currentTTSText = '';
      this._currentPlayedMs = 0;
      transport.sendControl({ type: 'agent_speaking', text: '' });

      // Stream each LLM token to the TTS session. The loop breaks early
      // if a barge-in transitions us out of SPEAKING.
      for await (const token of tokenStream) {
        // Cast needed because TypeScript narrows `this._state` to the value
        // at the top of the async function, not the current runtime value.
        if ((this._state as string) !== 'speaking') break;
        this._currentTTSText += token;
        ttsSession.pushTokens(token);
      }

      // Only flush if we're still in SPEAKING -- a barge-in may have
      // transitioned us to INTERRUPTING/LISTENING already.
      if ((this._state as string) === 'speaking') {
        await ttsSession.flush();
      }
    });
  }

  /**
   * Wire segment 4: TTS -> Transport.
   *
   * Each audio chunk from TTS is forwarded to the transport for client playback.
   * The `flush_complete` event signals that all tokens have been synthesised,
   * triggering the SPEAKING -> LISTENING transition.
   *
   * @param ttsSession - The TTS session emitting audio chunks.
   * @param transport - The transport delivering audio to the client.
   */
  private _wireTTSToTransport(ttsSession: StreamingTTSSession, transport: IStreamTransport): void {
    ttsSession.on('audio', (chunk: EncodedAudioChunk) => {
      // Only forward audio while we're in the SPEAKING state.
      // Chunks arriving after a barge-in are silently dropped.
      if (this._state === 'speaking') {
        this._currentPlayedMs += chunk.durationMs;
        transport.sendAudio(chunk);
      }
    });

    ttsSession.on('flush_complete', () => {
      // Only transition back to LISTENING if we're still SPEAKING.
      // A barge-in may have already moved us to INTERRUPTING -> LISTENING.
      if (this._state === 'speaking') {
        // SPEAKING -> LISTENING: agent response fully delivered
        this._setState('listening');

        // Notify the client that the agent's response is complete
        transport.sendControl({
          type: 'agent_done',
          text: this._currentTTSText,
          durationMs: this._currentPlayedMs,
        });

        // Reset the endpoint detector for the next user turn
        this._endpointDetector?.reset();

        // Restart the watchdog for the next turn
        this._resetWatchdog();
      }
    });
  }

  /**
   * Wire segment 5: Barge-in detection.
   *
   * When `speech_start` is detected (from the STT session) during the SPEAKING
   * state, the barge-in handler is consulted. Depending on the handler's
   * decision:
   *
   * - **cancel**: TTS is stopped, agent is aborted, state goes
   *   SPEAKING -> INTERRUPTING -> LISTENING.
   * - **pause**: A control message is sent but state remains SPEAKING.
   * - **ignore**: No action taken (e.g. lip smack below threshold).
   *
   * The `speech_start` and `speech_end` events are also forwarded to the
   * endpoint detector as synthetic VAD events so it can track speech activity
   * even when a dedicated VAD model is not present.
   *
   * @param sttSession - The STT session that re-emits speech_start/speech_end.
   * @param ttsSession - The TTS session to cancel on barge-in.
   * @param bargeinHandler - The policy handler deciding what to do.
   * @param transport - For sending barge_in control messages.
   * @param agentSession - The agent session to abort on cancel.
   */
  private _wireBargein(
    sttSession: StreamingSTTSession,
    ttsSession: StreamingTTSSession,
    bargeinHandler: IBargeinHandler,
    transport: IStreamTransport,
    agentSession: IVoicePipelineAgentSession
  ): void {
    sttSession.on('speech_start', async () => {
      // Forward to endpoint detector as a synthetic VAD event so it can
      // track turn boundaries even without a dedicated VAD model.
      this._endpointDetector?.pushVadEvent({
        type: 'speech_start',
        timestamp: Date.now(),
        source: 'stt',
      });

      // Barge-in is only relevant when TTS is actively playing
      if (this._state === 'speaking') {
        const action = await bargeinHandler.handleBargein({
          // speechDurationMs is 0 because we detect the start of speech, not
          // its duration. The handler's threshold logic determines whether
          // this instant detection is enough to trigger a cancel.
          speechDurationMs: 0,
          interruptedText: this._currentTTSText,
          playedDurationMs: this._currentPlayedMs,
        });

        if (action.type === 'cancel') {
          // SPEAKING -> INTERRUPTING -> LISTENING (two rapid transitions)
          this._setState('interrupting');
          ttsSession.cancel();
          agentSession.abort?.();
          transport.sendControl({ type: 'barge_in', action });

          // INTERRUPTING -> LISTENING: ready for the user's next turn
          this._setState('listening');
          this._endpointDetector?.reset();
          this._resetWatchdog();
        } else if (action.type === 'pause') {
          // Notify client of the pause but stay in SPEAKING state.
          // The TTS audio fade-out is handled client-side.
          transport.sendControl({ type: 'barge_in', action });
        }
        // 'ignore' and 'resume' actions require no pipeline-level response
      }
    });

    sttSession.on('speech_end', () => {
      // Forward to endpoint detector as a synthetic VAD event
      this._endpointDetector?.pushVadEvent({
        type: 'speech_end',
        timestamp: Date.now(),
        source: 'stt',
      });
    });
  }

  /**
   * Wire segment 6: Transport disconnect.
   *
   * When the transport closes (e.g. WebSocket disconnect, client navigation),
   * all sub-sessions are torn down and the orchestrator transitions to CLOSED.
   * This is a terminal state -- no further events are emitted.
   *
   * @param transport - The transport to monitor for closure.
   * @param sttSession - The STT session to close on disconnect.
   * @param ttsSession - The TTS session to close on disconnect.
   */
  private _wireDisconnect(
    transport: IStreamTransport,
    sttSession: StreamingSTTSession,
    ttsSession: StreamingTTSSession
  ): void {
    transport.on('close', () => {
      this._clearWatchdog();
      // Transition to terminal state first, then tear down sub-sessions.
      // This ordering ensures any event handlers see the CLOSED state
      // before the sessions are destroyed.
      this._setState('closed');
      sttSession.close();
      ttsSession.close();
    });
  }

  // --------------------------------------------------------------------------
  // State management
  // --------------------------------------------------------------------------

  /**
   * Transition to a new pipeline state, emitting a `'state_changed'` event.
   *
   * No-ops if the target state equals the current state (idempotent).
   * This is the ONLY method that mutates the internal `_state`, ensuring all
   * transitions are observable via the `'state_changed'` event.
   *
   * @param state - The target pipeline state.
   */
  private _setState(state: PipelineState): void {
    const from = this._state;
    // Idempotent: skip if already in the target state
    if (from === state) return;
    this._state = state;
    this.emit('state_changed', { from, to: state });
  }

  // --------------------------------------------------------------------------
  // Watchdog timer
  // --------------------------------------------------------------------------

  /**
   * Reset the watchdog timer for max turn duration.
   *
   * If the pipeline stays in LISTENING for longer than
   * {@link VoicePipelineConfig.maxTurnDurationMs} (default 30 s) without a
   * `turn_complete`, the watchdog fires a synthetic `speech_end` VAD event
   * to trigger the endpoint detector's silence timeout logic. This prevents
   * the pipeline from hanging indefinitely when the user walks away or
   * the microphone captures no meaningful audio.
   */
  private _resetWatchdog(): void {
    this._clearWatchdog();
    const maxMs = this.config.maxTurnDurationMs ?? 30_000;
    this._watchdogTimer = setTimeout(() => {
      // Only fire if we're still in LISTENING -- the user may have spoken
      // or the session may have been closed while the timer was pending.
      if (this._state === 'listening') {
        this._endpointDetector?.pushVadEvent({
          type: 'speech_end',
          timestamp: Date.now(),
          source: 'vad',
        });
      }
    }, maxMs);
  }

  /**
   * Clear the watchdog timer if one is active.
   * Safe to call even when no timer is pending (no-op).
   */
  private _clearWatchdog(): void {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }
}
