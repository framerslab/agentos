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
 * ANY ------> a part of it fails ------> CLOSED
 * ANY ------> stopSession() -----------> CLOSED
 * ```
 *
 * ## Two runtimes
 *
 * Without a call profile the orchestrator runs the components the caller
 * injects. Failures stay inside the session: an `'error'` from the STT session,
 * the TTS session, the transport or the endpoint detector, and a turn whose
 * agent stream or synthesis flush fails, end this session and no other, while a
 * transport send that rejects is reported and ends nothing.
 *
 * `overrides.callProfile` selects the call runtime instead: one scoped call
 * whose input is one sequenced 16 kHz mono fan-out to a scoped STT session, a
 * VAD session and an audio endpoint detector; each reply synthesizes through a
 * pull-contract TTS session into playback the transport acknowledges; results
 * carry worker and inference generations and a transport epoch, so a stale one
 * cannot speak; interruption follows measured speech; and the physical
 * transport can be detached and reattached without ending the call.
 *
 * ## Design notes
 *
 * - The orchestrator does not resolve providers from ExtensionManager: every
 *   component is injected via {@link VoicePipelineOverrides}.
 * - Event wiring is done once during `startSession()` and never rewired.
 * - A watchdog timer prevents a session without a call profile from staying in
 *   LISTENING forever if the user walks away (default 30 s). The watchdog
 *   resets after each completed turn.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { AudioFanout } from './AudioFanout.js';
import { PlaybackQueue, type PlaybackQueueLimits } from './PlaybackQueue.js';
import { TtsUsageMeter } from './TtsUsageMeter.js';
import {
  copyAudioIdentity,
  sameVoiceGeneration,
  type AudioFrame,
  type AudioIdentity,
  type EncodedAudioChunk,
  type IBargeinHandler,
  type IDiarizationEngine,
  type IEndpointDetector,
  type IAudioEndpointDetector,
  type IVadSession,
  type IStreamTransport,
  type IPlaybackTransport,
  type IStreamingSTT,
  type IStreamingTTS,
  type IVoicePipelineAgentSession,
  type PipelineState,
  type StreamingSTTSession,
  type ScopedStreamingSTTSession,
  type StreamingTTSSession,
  type TranscriptEvent,
  type ScopedTranscriptEvent,
  type TurnCompleteEvent,
  type ScopedTurnCompleteEvent,
  type VadFrameEvent,
  type StreamingTTSUsageEvent,
  type VoiceGeneration,
  type VoicePipelineConfig,
  type VoicePipelineSession,
  type VoiceTurnMetadata,
  type ServerTextMessage,
} from './types.js';

// ============================================================================
// Call profile and overrides
// ============================================================================

/** Call-specific bounds and owned detectors; credentials never travel in this object. */
export interface CallPipelineProfile {
  /** The scope, call, first recognition turn and fences the call starts with. */
  identity: AudioIdentity;
  /** The call's voice activity session; the call owns and disposes it. */
  vadSession: IVadSession;
  /** The call's audio endpoint detector; the call owns and disposes it. */
  audioEndpointDetector: IAudioEndpointDetector;
  /** Most input frames queued or in flight. */
  maxInputFrames: number;
  /** Most input samples queued or in flight. */
  maxInputSamples: number;
  /** The playback slot's byte and duration ceilings. */
  playback: PlaybackQueueLimits;
  /** Successive speech, in milliseconds of VAD-classified audio, that interrupts the agent while it thinks or speaks. */
  minSpeechMs: number;
  /** Most characters of one reply admitted to synthesis. */
  maxTextCharacters: number;
  /** Most synthesis requests of the call. */
  maxSynthesisRequests: number;
  /**
   * The durable manager invokes each cleanup operation in order. With it set, a failure or a transport close is
   * reported through `onFailure`, and the call, like a client stop, is left for the manager to close.
   */
  managerOwned?: boolean;
  /** Durably fences the new generation before any new inference is dispatched. */
  onGeneration(generation: VoiceGeneration): Promise<void>;
  /** Persists the interrupted recognition identity without resubmitting it. */
  onInterrupted(identity: AudioIdentity): void;
  /** Content-free supervisor notification. It requests manager cleanup rather than settling money. */
  onFailure(code: 'provider_failure' | 'transport_failure' | 'budget_exhausted' | 'cleanup_incomplete'): void;
  /** Resolves only on actual model/tool/synthesis abort acknowledgement or isolated process exit. */
  fenceInference(generation: VoiceGeneration): Promise<void>;
}

/**
 * The components the caller builds and injects; `callProfile` selects the stricter call runtime. In production, a host
 * builds the providers and passes them here; the orchestrator does not resolve them from ExtensionManager.
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
  /** Pre-built endpoint detector instance; required without a call profile. */
  endpointDetector?: IEndpointDetector;
  /** Pre-built barge-in handler instance; required without a call profile. */
  bargeinHandler?: IBargeinHandler;
  /** Pre-built diarization engine (optional; only needed for multi-speaker). */
  diarizationEngine?: IDiarizationEngine;
  /** Runs the session as one scoped call; its STT and TTS sessions must take the scoped and pull contracts. */
  callProfile?: CallPipelineProfile;
}

// ============================================================================
// Orchestrator
// ============================================================================

/**
 * VoicePipelineOrchestrator is the central state machine for the AgentOS
 * streaming voice pipeline. It coordinates audio capture, speech recognition,
 * endpoint detection, agent inference, text-to-speech synthesis, and barge-in
 * handling into a seamless real-time conversation loop. It is the common owner
 * for sessions without a profile and for opt-in scoped call sessions.
 *
 * ## Events emitted
 *
 * | Event                  | Payload                                      |
 * |------------------------|----------------------------------------------|
 * | `'state_changed'`      | `{ from: PipelineState, to: PipelineState }`  |
 * | `'turn_complete'`      | {@link TurnCompleteEvent}; a {@link ScopedTurnCompleteEvent} under a call profile |
 * | `'close'`              | *(none)*: the session moved to `closed`       |
 * | `'error'`              | `Error`: a `turn_complete` or `close` listener threw or rejected; a transport send rejected (of a reply's audio, the first refused chunk only); or, as the content-free `Error('voice pipeline failed')`, a part of a session without a profile failed and the session closes. With no `'error'` listener it is written as a console warning instead |
 * | `'cleanup_incomplete'` | *(none)*: the stop that followed such a failure could not close every part |
 * | `'transcript'`, `'gap'`, `'generation'`, `'interrupted'`, `'usage'`, `'failure'`, `'detached'`, `'reattached'` | re-emitted from a call profile's session |
 *
 * @see {@link VoicePipelineSession} for the public session interface returned by `startSession()`.
 */
export class VoicePipelineOrchestrator extends EventEmitter {
  private current: PipelineState = 'idle';
  private call?: CallPipelineRuntime;
  private transport?: IStreamTransport;
  private agent?: IVoicePipelineAgentSession;
  private stt?: StreamingSTTSession;
  private tts?: StreamingTTSSession;
  private endpoint?: IEndpointDetector;
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  /** Text of the reply being spoken, for barge-in context and `agent_done`. */
  private text = '';
  /** Duration of the reply's audio handed to the transport, for barge-in context and `agent_done`. */
  private playedMs = 0;
  /**
   * The reply being spoken: replaced as each reply starts to speak (PROCESSING -> SPEAKING). The send of each audio
   * chunk holds the reply it belongs to, so that each reply's first refused chunk is reported and the rest are not.
   */
  private _currentReply = { audioRefusalReported: false };
  private publicSession?: VoicePipelineSession;

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

  /** Current pipeline state (read-only); a call profile moves through the same states. */
  get state(): PipelineState {
    return this.current;
  }

  private stateTo(to: PipelineState): void {
    const from = this.current;
    if (from === to) return;
    this.current = to;
    this.emit('state_changed', { from, to });
    this.publicSession?.emit('state_change', to);
  }

  /**
   * Ends a session without a profile on a failure of one of its parts. The report is content-free: a provider's or
   * an agent's error can carry what was said, so its text reaches neither a listener nor the console.
   */
  private reportFailure(): void {
    if (this.current === 'closed') return;
    const error = new Error('voice pipeline failed');
    this._reportError(error, 'the session ended on a failure');
    const session = this.publicSession;
    if (session && session.listenerCount('error') > 0) this._reportError(error, 'the session ended on a failure', session);
    void this.stopSession('provider_failure').catch(() => {
      this.emit('cleanup_incomplete');
    });
  }

  /** Runs one step of the session; a throw or a rejection ends the session through `reportFailure()`. */
  private supervise(work: () => unknown): void {
    try {
      void Promise.resolve(work()).catch(() => this.reportFailure());
    } catch {
      this.reportFailure();
    }
  }

  /** An unlistened `'error'` would throw into the emitter: each part's error ends this session instead. */
  private watch(source: EventEmitter): void {
    source.on('error', () => this.reportFailure());
  }

  /**
   * Reset the watchdog timer for max turn duration. If the pipeline stays in
   * LISTENING for longer than {@link VoicePipelineConfig.maxTurnDurationMs}
   * (default 30 s) without a `turn_complete`, the watchdog gives the endpoint
   * detector a synthetic `speech_end`, so a user who walks away does not hold
   * the pipeline in LISTENING forever.
   */
  private resetWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.current === 'listening') this.supervise(() => this.endpoint?.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'vad' }));
    }, this.config.maxTurnDurationMs ?? 30000);
  }

  /**
   * Starts one conversation. A call profile requires scoped adapters and an acknowledged playback transport.
   *
   * Without a call profile this method:
   * 1. Validates the orchestrator is in `'idle'` state and has its four components.
   * 2. Creates STT and TTS sub-sessions from the provided factories.
   * 3. Wires all event handlers (transport -> STT -> endpoint -> agent -> TTS -> transport).
   * 4. Transitions to `'listening'` and starts the watchdog timer.
   * 5. Returns a {@link VoicePipelineSession} handle.
   *
   * A sub-session that fails to start closes the session, its transport included, and rejects this call.
   *
   * @param transport - The bidirectional audio/text stream transport.
   * @param agent - The agent session adapter for turn-based conversation.
   * @param overrides - The components, and the call profile when the session is a scoped call.
   * @returns A live VoicePipelineSession object; under a call profile, the call's own session.
   *
   * @throws {Error} If the orchestrator is not in `'idle'` state.
   * @throws {Error} If a required component is missing, or a call profile's contracts are not met.
   */
  async startSession(transport: IStreamTransport, agent: IVoicePipelineAgentSession, overrides: VoicePipelineOverrides = {}): Promise<VoicePipelineSession> {
    if (this.current !== 'idle' || this.transport) throw new Error('Cannot start session: expected idle');
    if (!overrides.streamingSTT) throw new Error('streamingSTT is required');
    if (!overrides.streamingTTS) throw new Error('streamingTTS is required');
    if (overrides.callProfile) {
      const call = new CallPipelineRuntime(this.config, transport, agent, overrides.streamingSTT, overrides.streamingTTS, overrides.callProfile);
      this.call = call;
      this.transport = transport;
      call.on('state_change', (state: PipelineState) => this.stateTo(state));
      // As without a profile, a listener that throws is reported and the listeners after it still run.
      call.on('turn_complete', (event: TurnCompleteEvent) => this._emitEach(this, 'turn_complete', event));
      call.on('close', () => {
        this.stateTo('closed');
        this._emitEach(this, 'close');
      });
      for (const name of ['gap', 'generation', 'interrupted', 'usage', 'failure', 'detached', 'reattached', 'transcript'] as const) call.on(name, (event: unknown) => this.emit(name, event));
      await call.start();
      return call;
    }
    if (!overrides.endpointDetector) throw new Error('endpointDetector is required');
    if (!overrides.bargeinHandler) throw new Error('bargeinHandler is required');
    this.transport = transport;
    this.agent = agent;
    this.endpoint = overrides.endpointDetector;
    this.watch(transport);
    this.watch(this.endpoint);
    try {
      this.stt = await overrides.streamingSTT.startSession({ language: this.config.language, providerOptions: this.config.sttOptions });
      this.watch(this.stt);
      this.tts = await overrides.streamingTTS.startSession({ voice: this.config.voice, format: this.config.format, providerOptions: this.config.ttsOptions, expressiveness: this.config.ttsExpressiveness });
      this.watch(this.tts);
      if ((this.current as PipelineState) === 'closed') {
        this.stt.close();
        this.tts.close();
        throw new Error('session closed during start');
      }
    } catch (error) {
      await this.stopSession('provider_failure');
      throw error;
    }
    const stt = this.stt;
    const tts = this.tts;
    const endpoint = this.endpoint;
    const bargein = overrides.bargeinHandler;
    transport.on('audio', (frame: AudioFrame) => {
      if (this.current !== 'closed') this.supervise(() => stt.pushAudio(frame));
    });
    transport.on('close', () => {
      this.supervise(() => this.stopSession('transport_closed'));
    });
    stt.on('transcript', (event: TranscriptEvent) => {
      if (this.current === 'closed') return;
      this.supervise(() => endpoint.pushTranscript(event));
      this._watchSend(() => transport.sendControl({ type: 'transcript', text: event.text, isFinal: event.isFinal, confidence: event.confidence }));
    });
    endpoint.on('turn_complete', (event: TurnCompleteEvent) => {
      if (this.current !== 'listening') return;
      // Re-emitted for waitForUserTurn() and for hosts that listen on the orchestrator or on the session.
      this._emitEach(this, 'turn_complete', event);
      if (this.publicSession) this._emitEach(this.publicSession, 'turn_complete', event);
      // A listener may have stopped the session: only a session still listening takes the turn.
      if ((this.current as PipelineState) !== 'listening') return;
      this.stateTo('processing');
      if (this.watchdog) clearTimeout(this.watchdog);
      // Sends are not waited for: a send that rejects is reported and ends neither the turn nor the session.
      this._watchSend(() => transport.sendControl({ type: 'agent_thinking' }));
      this.supervise(async () => {
        if (this.current === 'closed') return;
        const tokens = agent.sendText(event.transcript, { speakers: [], endpointReason: event.reason, speechDurationMs: event.durationMs, wasInterrupted: false, transcriptConfidence: event.confidence });
        // The reply gets its record before its audio is sent.
        this._currentReply = { audioRefusalReported: false };
        this.stateTo('speaking');
        this.text = '';
        this.playedMs = 0;
        this._watchSend(() => transport.sendControl({ type: 'agent_speaking', text: '' }));
        for await (const token of tokens) {
          if (this.current !== 'speaking') break;
          this.text += token;
          tts.pushTokens(token);
        }
        if (this.current === 'speaking') await tts.flush();
      });
    });
    tts.on('audio', (chunk: EncodedAudioChunk) => {
      if (this.current !== 'speaking') return;
      this.playedMs += chunk.durationMs;
      this._watchSend(() => transport.sendAudio(chunk), this._currentReply);
    });
    tts.on('flush_complete', () => {
      if (this.current !== 'speaking') return;
      this.stateTo('listening');
      this._watchSend(() => transport.sendControl({ type: 'agent_done', text: this.text, durationMs: this.playedMs }));
      this.supervise(() => endpoint.reset());
      this.resetWatchdog();
    });
    stt.on('speech_start', () => this.supervise(async () => {
      if (this.current === 'closed') return;
      endpoint.pushVadEvent({ type: 'speech_start', timestamp: Date.now(), source: 'stt' });
      if (this.current !== 'speaking') return;
      const action = await bargein.handleBargein({ speechDurationMs: 0, interruptedText: this.text, playedDurationMs: this.playedMs });
      // A decision that comes back after the reply has ended is not acted on.
      if (this.current !== 'speaking') return;
      if (action.type === 'cancel') {
        this.stateTo('interrupting');
        tts.cancel();
        agent.abort?.();
        this._watchSend(() => transport.sendControl({ type: 'barge_in', action }));
        if ((this.current as PipelineState) === 'closed') return;
        endpoint.reset();
        this.stateTo('listening');
        this.resetWatchdog();
      } else if (action.type === 'pause') this._watchSend(() => transport.sendControl({ type: 'barge_in', action }));
    }));
    stt.on('speech_end', () => {
      if (this.current !== 'closed') this.supervise(() => endpoint.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'stt' }));
    });
    const publicSession = Object.assign(new EventEmitter(), { sessionId: randomUUID(), transport, close: (reason?: string) => this.stopSession(reason) });
    // A getter, so the session reads the state of the moment rather than a copy taken here.
    Object.defineProperty(publicSession, 'state', { get: () => this.current });
    this.publicSession = publicSession as VoicePipelineSession;
    this.stateTo('listening');
    this.resetWatchdog();
    return this.publicSession;
  }

  /**
   * Hands an event to each of `target`'s listeners for it, in order, as `emit()` would, except that a listener that
   * throws or rejects is reported and the listeners after it still run. `emit()` stops at a throw, which would skip
   * the listeners after it (`waitForUserTurn()`'s among them) and throw into the code that raised the event: an
   * endpoint detector's handler, or a stop that has not yet closed the session's parts.
   *
   * @param target - The orchestrator or the session it returned.
   * @param event - The event to hand on.
   * @param args - What each listener is handed.
   */
  private _emitEach(target: EventEmitter, event: 'turn_complete' | 'close', ...args: unknown[]): void {
    for (const listener of target.rawListeners(event)) {
      try {
        const result: unknown = (listener as (...values: unknown[]) => unknown).apply(target, args);
        // Promise.resolve() also takes a promise of another realm or library, and leaves any other value alone.
        Promise.resolve(result).catch((err: unknown) => this._reportError(err, `a ${event} listener failed`));
      } catch (err) {
        this._reportError(err, `a ${event} listener failed`);
      }
    }
  }

  /**
   * Reports a failure as `'error'` when something listens for it, and otherwise as a console warning: an `'error'`
   * that nothing listens for would throw. As `emit('error')` hands a failure, it goes first to the `errorMonitor`
   * listeners, whether or not anything listens for `'error'`, and then to each `'error'` listener in order, except
   * that a listener that throws or rejects is written as a console warning, with the failure it was handed, and the
   * listeners after it still run: the failures are reported from an async event handler or a promise's rejection
   * handler, where a listener's throw or rejection would become an unhandled rejection, and `emit()` does not hand back
   * what a listener returns.
   *
   * @param err - The failure; anything other than an `Error` is wrapped in one.
   * @param what - What failed, for the console warning.
   * @param target - Whose listeners get the failure: the orchestrator, or the session it returned.
   */
  private _reportError(err: unknown, what: string, target: EventEmitter = this): void {
    const error = err instanceof Error ? err : new Error(String(err));
    const warnListenerFailed = (thrown: unknown): void => {
      const listenerFailure = thrown instanceof Error ? thrown.message : String(thrown);
      console.warn(
        `[voice-pipeline-orchestrator] ${what}:`,
        error.message,
        `(an 'error' listener failed: ${listenerFailure})`
      );
    };
    const handToListeners = (event: string | symbol): void => {
      for (const listener of target.rawListeners(event)) {
        try {
          const result: unknown = (listener as (error: Error) => unknown).call(target, error);
          // As in _emitEach(), Promise.resolve() also takes a promise of another realm or library.
          Promise.resolve(result).catch(warnListenerFailed);
        } catch (thrown) {
          warnListenerFailed(thrown);
        }
      }
    };
    handToListeners(EventEmitter.errorMonitor);
    if (target.listenerCount('error') === 0) {
      console.warn(`[voice-pipeline-orchestrator] ${what}:`, error.message);
      return;
    }
    handToListeners('error');
  }

  /**
   * Makes a transport send that the orchestrator does not wait for. A send that rejects, as one does on a WebSocket
   * that is closing or a LiveKit room that is disconnecting, or that throws, is reported once through `_reportError()`
   * and ends nothing; a send that resolves is left as it is. Unhandled, the rejection would end the process: Node
   * raises an unhandled rejection as an uncaught exception by default.
   *
   * A refused control message is reported each time. Of a reply's audio chunks only the first refused is reported: a
   * transport that does not publish audio, as `LiveKitStreamTransport` does not, refuses every chunk of every reply.
   *
   * @param send - Calls `sendControl()` or `sendAudio()`; it is called at once.
   * @param reply - For an audio chunk, the reply it belongs to (`_currentReply` when it was sent).
   */
  private _watchSend(send: () => Promise<void>, reply?: { audioRefusalReported: boolean }): void {
    let sent: Promise<void>;
    try {
      // Promise.resolve() also takes a transport whose send returns no promise, as a plain JavaScript one may.
      sent = Promise.resolve(send());
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.catch((err: unknown) => {
      if (reply) {
        // The rest of a reply's refusals are not reported. Each reply keeps its own record, so the first refusal of
        // an earlier reply is reported even when it settles after a later reply's.
        if (reply.audioRefusalReported) return;
        reply.audioRefusalReported = true;
      }
      this._reportError(err, 'a transport send failed');
    });
  }

  /** Cancels synthesis without closing recognition or the physical media path. */
  async cancelSynthesis(): Promise<void> {
    if (this.call) await this.call.cancelSynthesis();
    else this.tts?.cancel();
  }

  /**
   * Drains only the scoped closing generation; without a call profile it does nothing. Under a call profile it follows
   * `cancelSynthesis()` and accepts only final transcripts of the closing generation until it resolves.
   *
   * @param signal - Aborting it rejects the drain.
   */
  async drainRecognition(signal: AbortSignal): Promise<void> {
    if (this.call) await this.call.drainRecognition(signal);
  }

  /** Clears pending output independently from recognition. */
  async clearCallPlayback(): Promise<void> {
    await this.call?.clearPlayback();
  }

  /**
   * Terminal stop. Call-profile cleanup rejects if its native fence or disposal is incomplete.
   *
   * Without a call profile the session moves to `'closed'` and emits `'close'` at once, then aborts the agent's
   * request, closes the STT and TTS sessions, resets the endpoint detector and closes the transport, unless the
   * transport has closed itself. The promise rejects when one of those throws. Safe to call more than once: a later
   * call returns the first one's outcome.
   *
   * @param reason - Optional human-readable reason for diagnostics.
   */
  stopSession(reason?: string): Promise<void> {
    if (this.call) return this.call.close(reason);
    if (this.current === 'closed') return this.stopping ?? Promise.resolve();
    if (this.stopping) return this.stopping;
    this.stateTo('closed');
    if (this.watchdog) clearTimeout(this.watchdog);
    this._emitEach(this, 'close');
    if (this.publicSession) this._emitEach(this.publicSession, 'close');
    const failures: unknown[] = [];
    const transport = this.transport;
    for (const close of [
      () => this.agent?.abort?.(),
      () => this.stt?.close(),
      () => this.tts?.close(),
      () => this.endpoint?.reset(),
      // A transport that closed itself is not closed again; the WebSocket transport would read 'closing' ever after.
      () => {
        if (transport && transport.state !== 'closed') transport.close(1000, reason);
      },
    ]) {
      try {
        close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.stopping = failures.length ? Promise.reject(new Error('cleanup incomplete')) : Promise.resolve();
    return this.stopping;
  }

  /**
   * Wait for the next user turn to complete: the accepted endpoint event, or a rejection when shutdown wins.
   *
   * Resolves with the first {@link TurnCompleteEvent} the orchestrator re-emits after this call, so that graph
   * nodes (via VoiceTransportAdapter) can `await` user input without managing raw EventEmitter subscriptions.
   * Rejects with `Error('session closed')` when the session is already closed, or closes before a turn completes.
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
  waitForUserTurn(): Promise<TurnCompleteEvent> {
    if (this.current === 'closed') return Promise.reject(new Error('session closed'));
    return new Promise((resolve, reject) => {
      const clean = (): void => {
        this.off('turn_complete', turn);
        this.off('close', close);
      };
      const turn = (event: TurnCompleteEvent): void => {
        clean();
        resolve(event);
      };
      const close = (): void => {
        clean();
        reject(new Error('session closed'));
      };
      this.once('turn_complete', turn);
      this.once('close', close);
    });
  }

  /**
   * Sends graph output through the same profile-specific producer path.
   *
   * Without a call profile, a string or each token of an `AsyncIterable<string>` goes to the TTS session's
   * `pushTokens()`, then `flush()` signals the end of the utterance. Under a call profile the text is a reply of its
   * own: a new generation, synthesized into acknowledged playback while the call is listening.
   *
   * @param text - A complete string, or an async iterable of string tokens.
   *
   * @throws {Error} If there is no active TTS session (i.e. session not started or already stopped), or, under a call
   *   profile, if the call is not listening.
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
    if (this.call) return this.call.speak(text);
    if (!this.tts || this.current === 'closed') throw new Error('No active TTS session');
    if (typeof text === 'string') this.tts.pushTokens(text);
    else for await (const token of text) this.tts.pushTokens(token);
    await this.tts.flush();
  }

  /**
   * Transient loss on the stable logical transport. The authenticated binding calls this before replacement.
   *
   * @param reason - Why the physical transport was lost, for diagnostics.
   * @param transportEpoch - The epoch being detached; another epoch's detach is ignored.
   * @throws {Error} Without a call profile.
   */
  async detach(reason: string, transportEpoch: number): Promise<void> {
    if (!this.call) throw new Error('call profile required');
    await this.call.detach(reason, transportEpoch);
  }

  /**
   * The binding already checked scope/call/participant/grant; this method checks worker and epoch continuity.
   *
   * @param generation - The same worker and inference generations with a strictly newer transport epoch.
   * @throws {Error} Without a call profile, when the call is not detached, or when the generation does not continue it.
   */
  async reattach(generation: VoiceGeneration): Promise<void> {
    if (!this.call) throw new Error('call profile required');
    await this.call.reattach(generation);
  }
}

// ============================================================================
// Call runtime (the opt-in call profile)
// ============================================================================

/**
 * One scoped call: the private runtime behind `overrides.callProfile`, kept apart from the injected path. Every
 * result is checked against the call's scope, call, recognition turn and fences, so a stale or foreign one is dropped
 * or ends the call; a turn, an interruption, a detach and a reattach each advance a fence before new work starts.
 */
class CallPipelineRuntime extends EventEmitter implements VoicePipelineSession {
  readonly sessionId = randomUUID();
  private current: PipelineState = 'idle';
  private identity: AudioIdentity;
  private turnSequence = 0;
  private stt?: ScopedStreamingSTTSession;
  private tts?: StreamingTTSSession;
  private fan?: AudioFanout;
  private queue?: PlaybackQueue;
  private meter: TtsUsageMeter;
  private detached = false;
  /** Set while a generation changes; input, turns, transcripts and synthesis arriving meanwhile are dropped or refused. */
  private changing = false;
  private closing?: Promise<void>;
  private transition: Promise<void> = Promise.resolve();
  private response?: Promise<void>;
  private vadWork: Promise<void> = Promise.resolve();
  private vadBusy = false;
  private transcriptWork: Promise<void> = Promise.resolve();
  private transcriptPending = 0;
  /** Successive speech, from the durations of VAD-classified frames; silence clears it. */
  private speechMs = 0;
  private vadSequence = 0;
  private inputSequence = 0;
  private inputDurationMs = 0;
  private inputDrain?: Promise<void>;
  private muted = false;
  private synthesisRequests = 0;
  private stopping = false;
  private draining = false;
  private recognitionDrained = false;

  constructor(private readonly config: VoicePipelineConfig, readonly transport: IStreamTransport, private readonly agent: IVoicePipelineAgentSession, private readonly sttProvider: IStreamingSTT, private readonly ttsProvider: IStreamingTTS, private readonly profile: CallPipelineProfile) {
    super();
    this.identity = copyAudioIdentity(profile.identity);
    this.meter = new TtsUsageMeter(this.identity.scopeId, this.identity.callId, profile.maxSynthesisRequests);
    if (config.diarization) throw new Error('call-profile diarization unavailable');
    if (!agent.abort || ![profile.minSpeechMs, profile.maxTextCharacters, profile.maxSynthesisRequests].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid call profile');
    const playback = transport as Partial<IPlaybackTransport>;
    if (!playback.waitForPlayback || !playback.clearPlayback) throw new Error('acknowledged playback required');
  }

  get state(): PipelineState {
    return this.current;
  }

  private stateTo(state: PipelineState): void {
    if (state !== this.current) {
      this.current = state;
      this.emit('state_change', state);
    }
  }

  private matches(event: AudioIdentity): boolean {
    return event?.scopeId === this.identity.scopeId && event.callId === this.identity.callId && event.turnId === this.identity.turnId && !!event.generation && sameVoiceGeneration(event.generation, this.identity.generation);
  }

  private live(generation: Readonly<VoiceGeneration>): boolean {
    return !this.stopping && this.current !== 'closed' && !this.detached && sameVoiceGeneration(generation, this.identity.generation);
  }

  private fail(code: 'provider_failure' | 'transport_failure' | 'budget_exhausted'): void {
    if (this.current === 'closed') return;
    this.profile.onFailure(code);
    this.emit('failure', { scopeId: this.identity.scopeId, callId: this.identity.callId, code });
    if (!this.profile.managerOwned) void this.close(code).catch(() => { this.profile.onFailure('cleanup_incomplete'); });
  }

  private watch(source: EventEmitter): void {
    source.on('error', () => this.fail('provider_failure'));
  }

  /** Advances the inference generation and the recognition turn; nothing of the previous generation can speak. */
  private advance(): VoiceGeneration {
    const generation = { ...this.identity.generation, inferenceGeneration: this.identity.generation.inferenceGeneration + 1 };
    this.identity = copyAudioIdentity({ ...this.identity, turnId: `turn-${++this.turnSequence}`, generation });
    this.speechMs = 0;
    this.vadSequence = 0;
    this.emit('generation', generation);
    return generation;
  }

  private async resetInput(): Promise<void> {
    this.fan?.reset();
    await this.fan?.drain();
    await this.stt?.reset(this.identity);
  }

  /** Opens the scoped STT session, wires the call and fences its first generation; a failure closes the call. */
  async start(): Promise<void> {
    this.watch(this.profile.vadSession);
    this.watch(this.profile.audioEndpointDetector);
    this.transport.on('error', () => this.fail('transport_failure'));
    this.transport.on('close', () => {
      if (this.current === 'closed') return;
      if (this.profile.managerOwned) this.fail('transport_failure');
      else void this.close('transport_closed').catch(() => this.profile.onFailure('cleanup_incomplete'));
    });
    try {
      const stt = await this.sttProvider.startSession({ language: this.config.language, providerOptions: this.config.sttOptions, call: this.identity });
      this.watch(stt);
      const scoped = stt as Partial<ScopedStreamingSTTSession>;
      if (!scoped.pushAudioScoped || !scoped.reset) {
        stt.close();
        throw new Error('scoped STT required');
      }
      this.stt = stt as ScopedStreamingSTTSession;
      if (this.current === 'closed') {
        stt.close();
        throw new Error('session closed during start');
      }
      this.fan = new AudioFanout({
        identity: () => this.identity,
        stt: async (frame) => {
          this.inputSequence = frame.sequence;
          this.inputDurationMs = frame.samples.length / 16;
          await this.stt!.pushAudioScoped(frame);
        },
        vad: this.profile.vadSession,
        endpoint: this.profile.audioEndpointDetector,
        maxFrames: this.profile.maxInputFrames,
        maxSamples: this.profile.maxInputSamples,
        afterFrame: () => this.vadWork,
        onGap: (event) => {
          this.emit('gap', event);
          void this.interrupt().catch(() => this.fail('provider_failure'));
        },
      });
      stt.on('transcript', (event: ScopedTranscriptEvent) => {
        // While stopping, only a drain's finals of the closing generation are accepted.
        if (!this.matches(event) || this.current === 'closed' || (this.stopping ? !this.draining || !event.isFinal : this.detached || this.changing)) return;
        if (++this.transcriptPending > 32) {
          this.transcriptPending--;
          this.fail('provider_failure');
          return;
        }
        this.transcriptWork = this.transcriptWork.then(async () => {
          if (!this.matches(event) || this.current === 'closed' || (this.stopping ? !this.draining || !event.isFinal : this.detached || this.changing)) return;
          this.emit('transcript', event);
          if (!this.stopping) await this.profile.audioEndpointDetector.pushTranscript(event);
          if (this.matches(event) && (this.current as PipelineState) !== 'closed') await this.send({ type: 'transcript', text: event.text, isFinal: event.isFinal, confidence: event.confidence }, event.generation);
        }).catch(() => this.fail('provider_failure')).finally(() => { this.transcriptPending--; });
      });
      stt.on('stt:gap', (event: { lostMs: number }) => this.fan?.gap('provider', event.lostMs));
      stt.on('close', () => {
        if (!this.changing && this.current !== 'closed') this.fail('provider_failure');
      });
      this.profile.vadSession.on('vad', (event: VadFrameEvent) => {
        if (!this.matches(event) || this.detached || this.changing || this.current === 'closed' || event.sequence <= this.vadSequence) return;
        // One VAD event per admitted frame, for that frame, with the frame's own duration.
        if (this.vadBusy || event.sequence !== this.inputSequence || event.durationMs !== this.inputDurationMs || event.source !== 'vad' || !Number.isFinite(event.durationMs) || event.durationMs <= 0 || event.durationMs > this.profile.maxInputSamples / 16) {
          this.fail('provider_failure');
          return;
        }
        this.vadSequence = event.sequence;
        this.speechMs = event.speech ? this.speechMs + this.inputDurationMs : 0;
        this.vadBusy = true;
        this.vadWork = this.profile.audioEndpointDetector.pushVadEvent(event).then(() => {
          if (this.matches(event) && this.speechMs >= this.profile.minSpeechMs && ['processing', 'speaking'].includes(this.current)) {
            void this.interrupt().catch(() => this.fail('provider_failure'));
          }
        }).catch(() => this.fail('provider_failure')).finally(() => { this.vadBusy = false; });
      });
      this.profile.audioEndpointDetector.on('turn_complete', (event: ScopedTurnCompleteEvent) => this.acceptTurn(event));
      this.transport.on('audio', (frame: AudioFrame) => {
        if (this.stopping || this.muted || this.detached || this.changing || this.current === 'closed') return;
        try {
          if (frame.generation && !sameVoiceGeneration(frame.generation, this.identity.generation)) return;
          this.fan!.offer(frame);
          if (!this.inputDrain) this.inputDrain = this.fan!.drain().catch(() => this.fail('provider_failure')).finally(() => { this.inputDrain = undefined; });
        } catch {
          this.fail('provider_failure');
        }
      });
      this.transport.on('gap', (event: { lostMs?: number; droppedMs?: number }) => {
        if (!this.detached && this.current !== 'closed') this.fan?.gap('transport', event.lostMs ?? event.droppedMs ?? 0);
      });
      // Client control is an allowlist: mute, unmute and stop. Anything else ends the call.
      this.transport.on('message', (message: { type?: string; action?: { type?: string } }) => {
        if (message?.type !== 'control' || !['mute', 'unmute', 'stop'].includes(message.action?.type ?? '')) {
          this.fail('transport_failure');
          return;
        }
        if (message.action!.type === 'stop') {
          if (!this.profile.managerOwned) void this.close('client_stop').catch(() => this.profile.onFailure('cleanup_incomplete'));
        } else {
          this.muted = message.action!.type === 'mute';
          if (this.muted) void this.interrupt().catch(() => this.fail('provider_failure'));
        }
      });
      await this.profile.onGeneration({ ...this.identity.generation });
      await this.resetInput();
      if ((this.current as PipelineState) === 'closed') throw new Error('session closed during start');
      this.stateTo('listening');
    } catch (error) {
      await this.close('provider_failure');
      throw error;
    }
  }

  private async send(message: ServerTextMessage, generation: Readonly<VoiceGeneration>): Promise<void> {
    if (!this.live(generation)) return;
    // The logical binding carries this fence on its wire envelope without widening ServerTextMessage.
    await this.transport.sendControl(Object.assign({}, message, { scopeId: this.identity.scopeId, callId: this.identity.callId, generation: { ...generation } }));
  }

  private acceptTurn(event: ScopedTurnCompleteEvent): void {
    if (this.stopping || !this.matches(event) || this.detached || this.changing || this.current !== 'listening') return;
    this.emit('turn_complete', event);
    if ((this.current as PipelineState) !== 'listening' || this.detached || this.changing) return;
    this.stateTo('processing');
    this.changing = true;
    const generation = this.advance();
    const outputIdentity = copyAudioIdentity({ ...event, generation });
    this.response = (async () => {
      await this.profile.onGeneration(generation);
      await this.resetInput();
      this.changing = false;
      if (!this.live(generation)) return;
      await this.send({ type: 'agent_thinking' }, generation);
      if (!this.live(generation)) return;
      const metadata: VoiceTurnMetadata = { speakers: [], endpointReason: event.reason, speechDurationMs: event.durationMs, wasInterrupted: false, transcriptConfidence: event.confidence, identity: outputIdentity };
      await this.synthesize(this.agent.sendText(event.transcript, metadata), outputIdentity);
    })().catch(() => {
      if (this.live(generation)) this.fail('provider_failure');
    });
  }

  /**
   * Speaks one reply of `identity`'s generation through a new pull-contract TTS session and acknowledged playback;
   * `agent_done` goes out only once synthesis is complete, its final usage is reported and playback is acknowledged.
   */
  private async synthesize(tokens: AsyncIterable<string>, identity: AudioIdentity): Promise<void> {
    const generation = identity.generation;
    if (++this.synthesisRequests > this.profile.maxSynthesisRequests) {
      this.fail('budget_exhausted');
      throw new Error('synthesis request bound');
    }
    const requestId = randomUUID();
    const tts = await this.ttsProvider.startSession({ voice: this.config.voice, format: this.config.format, providerOptions: this.config.ttsOptions, expressiveness: this.config.ttsExpressiveness, call: { ...identity, requestId } });
    tts.on('error', () => {
      if (this.live(generation)) this.fail('provider_failure');
    });
    if (!this.live(generation)) {
      tts.cancel();
      tts.close();
      await this.profile.fenceInference({ ...generation });
      return;
    }
    this.tts = tts;
    if (!tts.setAudioSink || !tts.writeTokens) throw new Error('awaited TTS producer required');
    const queue = new PlaybackQueue(this.transport as IPlaybackTransport, generation, this.profile.playback);
    this.queue = queue;
    let finalUsage = false;
    let flushed = false;
    let text = '';
    tts.on('usage', (event: StreamingTTSUsageEvent) => {
      try {
        if (event.requestId !== requestId || event.turnId !== identity.turnId || !sameVoiceGeneration(event.generation, generation)) throw new Error('foreign synthesis request');
        this.meter.record(event);
        if (event.final && event.status === 'completed') finalUsage = true;
        this.emit('usage', event);
      } catch {
        this.fail('provider_failure');
      }
    });
    // A pull-contract producer hands every chunk to its sink; one emitted as audio breaks the contract.
    tts.on('audio', () => {
      if (this.live(generation)) this.fail('provider_failure');
    });
    tts.on('flush_complete', () => {
      if (this.live(generation)) flushed = true;
    });
    tts.on('close', () => {
      if (this.tts === tts && this.live(generation) && !flushed) this.fail('provider_failure');
    });
    tts.setAudioSink(async (chunk) => {
      if (!this.live(generation) || this.changing || chunk.scopeId !== identity.scopeId || chunk.callId !== identity.callId) throw new Error('stale synthesis');
      await queue.enqueue(chunk);
    });
    this.stateTo('speaking');
    await this.send({ type: 'agent_speaking', text: '' }, generation);
    for await (const token of tokens) {
      if (!this.live(generation)) return;
      text += token;
      if (text.length > this.profile.maxTextCharacters) {
        this.fail('budget_exhausted');
        throw new Error('text admission bound');
      }
      await tts.writeTokens(token);
    }
    if (!this.live(generation)) return;
    await tts.flush();
    await queue.drain();
    if (!this.live(generation)) return;
    if (!flushed || !finalUsage) throw new Error('incomplete synthesis completion');
    this.tts = undefined;
    tts.close();
    this.queue = undefined;
    await this.send({ type: 'agent_done', text, durationMs: queue.stats().playedMs }, generation);
    if (!this.live(generation)) return;
    this.changing = true;
    await this.resetInput();
    this.changing = false;
    if (this.live(generation)) this.stateTo('listening');
  }

  /** Speaks graph output as a reply of its own generation; the call must be listening. */
  async speak(text: string | AsyncIterable<string>): Promise<void> {
    if (this.stopping || this.current !== 'listening' || this.detached || this.changing) throw new Error('session not ready');
    this.stateTo('processing');
    this.changing = true;
    const generation = this.advance();
    const identity = copyAudioIdentity(this.identity);
    const tokens = typeof text === 'string' ? (async function* () { yield text; })() : text;
    const work = (async () => {
      await this.profile.onGeneration(generation);
      await this.resetInput();
      this.changing = false;
      if (this.live(generation)) await this.synthesize(tokens, identity);
    })();
    this.response = work.catch(() => {
      if (this.live(generation)) this.fail('provider_failure');
    });
    await work;
  }

  /**
   * Advances the generation synchronously, then aborts the agent, cancels synthesis, clears playback, waits for the
   * old generation's inference fence and resets input before the call listens again.
   */
  private interrupt(): Promise<void> {
    if (this.current === 'closed' || this.changing) return this.transition;
    const interrupted = copyAudioIdentity(this.identity);
    const old = { ...this.identity.generation };
    this.changing = true;
    const generation = this.advance();
    this.stateTo('interrupting');
    this.profile.onInterrupted(interrupted);
    this.emit('interrupted', interrupted);
    this.agent.abort?.();
    const tts = this.tts;
    this.tts = undefined;
    tts?.cancel();
    tts?.close();
    const queue = this.queue;
    this.queue = undefined;
    const response = this.response;
    this.transition = (async () => {
      await this.profile.onGeneration(generation);
      await Promise.all([queue?.cancel(), this.profile.fenceInference(old)]);
      await response;
      await this.resetInput();
      this.changing = false;
      if (this.current !== 'closed') this.stateTo('listening');
    })();
    return this.transition;
  }

  /** Holds input and interrupts the current epoch's work; the call stays open and emits no `close`. */
  async detach(_reason: string, transportEpoch: number): Promise<void> {
    if (this.current === 'closed' || transportEpoch !== this.identity.generation.transportEpoch) return;
    this.detached = true;
    await this.transition;
    // A response opening a provider has its own generation guard; fence it before a replacement can speak.
    if (this.changing) {
      await this.response;
      this.changing = false;
    }
    await this.interrupt();
    this.emit('detached', { ...this.identity });
  }

  /** Continues a detached call on a strictly newer transport epoch of the same worker and inference generation. */
  async reattach(generation: VoiceGeneration): Promise<void> {
    const old = this.identity.generation;
    if (!this.detached || this.current === 'closed' || this.changing || generation.workerGeneration !== old.workerGeneration || generation.inferenceGeneration !== old.inferenceGeneration || generation.transportEpoch <= old.transportEpoch) throw new Error('reattach refused');
    this.identity = copyAudioIdentity({ ...this.identity, generation });
    await this.profile.onGeneration({ ...generation });
    await this.resetInput();
    this.detached = false;
    this.emit('reattached', { ...this.identity });
  }

  /** Freeze new work while keeping the closing recognition generation intact. */
  async cancelSynthesis(): Promise<void> {
    this.stopping = true;
    this.agent.abort?.();
    const tts = this.tts;
    this.tts = undefined;
    tts?.cancel();
    tts?.close();
  }

  /** Separate playback cancellation from recognition drain and physical teardown. */
  async clearPlayback(): Promise<void> {
    await this.queue?.cancel();
    this.queue = undefined;
  }

  /** Only final recognition from the captured closing generation is accepted during this bounded drain. */
  async drainRecognition(signal: AbortSignal): Promise<void> {
    if (this.recognitionDrained) return;
    if (!this.stopping) throw new Error('recognition drain before stop');
    signal.throwIfAborted();
    this.draining = true;
    let rejectAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new Error('recognition drain cancelled'));
        signal.addEventListener('abort', rejectAbort, { once: true });
      });
      await Promise.race([(async () => {
        await this.inputDrain;
        await this.fan?.drain();
        await this.stt?.flush();
        await this.transcriptWork;
      })(), cancelled]);
      this.recognitionDrained = true;
    } finally {
      this.draining = false;
      if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
    }
  }

  /** Purge callers omit drain; disposal fences every generation after content acceptance is closed. */
  close(_reason?: string): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.draining = false;
    const old = { ...this.identity.generation };
    this.stateTo('closed');
    this.detached = true;
    this.emit('close');
    this.closing = (async () => {
      await this.cancelSynthesis();
      await this.clearPlayback();
      this.stt?.close();
      await this.profile.fenceInference(old);
      await this.transition;
      await this.response;
      await this.transcriptWork;
      await this.vadWork;
      if (this.fan) await this.fan.dispose();
      else {
        await this.profile.vadSession.dispose();
        await this.profile.audioEndpointDetector.dispose();
      }
      this.advance();
      this.transport.close(1000, 'session closed');
    })().catch((error) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
