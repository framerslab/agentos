/**
 * @module voice-pipeline/types
 *
 * Core interfaces and types for the AgentOS streaming voice pipeline.
 *
 * The voice pipeline connects speech-to-text, endpoint detection, diarization,
 * agent processing, and text-to-speech into a low-latency, real-time conversation
 * system. All heavy I/O crosses EventEmitter-based session boundaries to keep
 * the hot path non-blocking.
 *
 * ## Dependency order (no circular refs)
 *
 * ```
 *   AudioFrame / EncodedAudioChunk
 *   -> Transport (IStreamTransport)
 *   -> STT (IStreamingSTT + StreamingSTTSession)
 *   -> Endpoint detection (IEndpointDetector + VadEvent)
 *   -> Diarization (IDiarizationEngine + DiarizationSession)
 *   -> TTS (IStreamingTTS + StreamingTTSSession)
 *   -> Barge-in (IBargeinHandler)
 *   -> Session (VoicePipelineSession)
 *   -> Protocol messages (ClientTextMessage, ServerTextMessage)
 * ```
 *
 * ## Design rationale
 *
 * Every interface in this module is kept deliberately narrow so that
 * implementations can be swapped at runtime (e.g. Deepgram STT vs Whisper
 * vs browser WebSpeechAPI) without touching the orchestrator. The
 * EventEmitter-based session pattern was chosen over callback interfaces
 * because it naturally supports fan-out (multiple listeners) and backpressure
 * is handled at the transport level rather than per-callback.
 */

import type { EventEmitterLike, VoiceEventListener } from './VoiceEventEmitter.js';

// ============================================================================
// Section 1 -- Raw audio types
// ============================================================================

/**
 * A single frame of raw PCM audio, as produced by a microphone capture or
 * a VAD pre-processor. Each frame typically represents 10-20 ms of audio.
 *
 * @see {@link EncodedAudioChunk} for the compressed counterpart used in TTS output.
 *
 * @example
 * ```typescript
 * const frame: AudioFrame = {
 *   samples: new Float32Array(320),   // 20 ms @ 16 kHz
 *   sampleRate: 16000,
 *   timestamp: Date.now(),
 * };
 * ```
 */
export interface AudioFrame {
  /**
   * Interleaved 32-bit float PCM samples, normalised to [-1, 1].
   * For mono audio this is a flat array; stereo interleaves L/R pairs.
   *
   * Float32Array is chosen over Int16Array because it avoids quantisation
   * artefacts in DSP operations (e.g. energy calculation, resampling) and
   * is the native format for Web Audio API.
   */
  samples: Float32Array;

  /**
   * Samples per second (e.g. 16000, 24000, 48000).
   *
   * 16 kHz is the standard for telephony and most STT engines. 24 kHz is
   * typical for TTS output. The pipeline resamples internally when STT
   * and TTS sample rates differ.
   */
  sampleRate: number;

  /**
   * Unix epoch millisecond timestamp at which this frame was captured.
   * Used for synchronisation across STT, VAD, and diarization streams.
   *
   * Must be monotonically increasing within a session. Out-of-order
   * frames degrade STT accuracy and confuse the endpoint detector's
   * duration tracking.
   */
  timestamp: number;

  /**
   * Optional hint from the capture layer identifying the speaker source
   * (e.g. a hardware device label or a WebRTC peer ID). Used by the
   * diarization engine when native speaker IDs are unavailable.
   *
   * See `DiarizedSegment.speakerId` for the post-diarization label.
   */
  speakerHint?: string;

  /** Validated wire packet sequence when supplied by the capture boundary. */
  sequence?: number;

  /** Channel count at the capture boundary; omitted means the legacy mono convention. */
  channels?: number;

  /** Optional call fence; required by {@link ScopedAudioFrame}. */
  generation?: VoiceGeneration;
}

/**
 * A compressed audio chunk ready for transmission over the wire (e.g. to a
 * TTS websocket or a playback buffer). Contains the rendered text to allow
 * barge-in handlers to track interrupted utterance state.
 *
 * @see {@link AudioFrame} for the uncompressed PCM counterpart used in capture.
 * @see {@link StreamingTTSSession} which emits these on the `'audio'` event.
 *
 * @example
 * ```typescript
 * const chunk: EncodedAudioChunk = {
 *   audio: Buffer.from([...opusBytes]),
 *   format: 'opus',
 *   sampleRate: 24000,
 *   durationMs: 60,
 *   text: 'Hello there!',
 * };
 * ```
 */
export interface EncodedAudioChunk {
  /**
   * Raw encoded bytes in the format specified by `format`.
   */
  audio: Buffer;

  /**
   * Codec/container format of `audio`.
   *
   * - `'pcm'` -- raw signed 16-bit LE samples (lowest latency, highest bandwidth).
   * - `'mp3'` -- MPEG Layer 3 (wide browser support, moderate latency).
   * - `'opus'` -- Opus in OGG container (best quality/size ratio, recommended default).
   */
  format: 'pcm' | 'mp3' | 'opus';

  /**
   * Samples per second for the encoded stream.
   */
  sampleRate: number;

  /**
   * Playback duration of this chunk in milliseconds.
   * Used by the orchestrator to track cumulative played time for
   * barge-in context (`BargeinContext.playedDurationMs`).
   */
  durationMs: number;

  /**
   * The text fragment that was synthesised into this chunk. Preserved so
   * barge-in handlers can report `VoiceTurnMetadata.interruptedRemainder`
   * accurately when playback is cut short.
   */
  text: string;

  /** Container of the declared codec; omitted preserves legacy metadata. */
  container?: 'raw' | 'wav' | 'mp3' | 'ogg';

  /** Captured tenant scope; required on call-profile output. */
  scopeId?: string;

  /** Captured call; required on call-profile output. */
  callId?: string;

  /** Call fence captured when this synthesis request started. */
  generation?: VoiceGeneration;

  /** Monotonic playback chunk sequence within the inference generation. */
  sequence?: number;
}

// ============================================================================
// Section 2 -- Transport layer
// ============================================================================

/**
 * Discriminated union of control messages sent from the pipeline to the
 * underlying stream transport (e.g. a WebSocket or WebRTC data-channel).
 *
 * See `IStreamTransport.sendControl()` for the transport method that accepts these messages.
 * @see {@link ServerTextMessage} for the full server-to-client protocol.
 *
 * @example
 * ```typescript
 * const muteMsg: TransportControlMessage = { type: 'mute' };
 * const stopMsg: TransportControlMessage = { type: 'stop', reason: 'session timeout' };
 * ```
 */
export type TransportControlMessage =
  | {
      /** Mute the outbound audio stream without closing the session. */
      type: 'mute';
    }
  | {
      /** Unmute the outbound audio stream previously muted. */
      type: 'unmute';
    }
  | {
      /** Reconfigure transport-layer parameters at runtime. */
      type: 'config';
      /** Partial configuration overrides. Keys are transport-specific. */
      params: Record<string, unknown>;
    }
  | {
      /** Gracefully stop the transport and signal end-of-stream. */
      type: 'stop';
      /** Optional human-readable reason included in the closing handshake. */
      reason?: string;
    };

/**
 * Abstraction over any bidirectional audio/text stream transport.
 * Implementations include WebSocket, WebRTC data-channel, and in-process pipes.
 *
 * The transport layer is intentionally thin: it handles framing and I/O but
 * knows nothing about STT, TTS, or conversation state. This separation lets
 * the pipeline swap transports (e.g. WebSocket -> WebRTC) without touching
 * any voice logic.
 *
 * ## Events emitted
 *
 * | Event       | Payload               | Description                            |
 * |-------------|-----------------------|----------------------------------------|
 * | `'audio'`   | {@link AudioFrame}    | Inbound audio from the remote client.  |
 * | `'message'` | {@link ClientTextMessage} | Inbound JSON control from the client. |
 * | `'close'`   | *(none)*              | Transport has been closed (either side). |
 * | `'error'`   | `Error`               | Fatal transport error.                 |
 *
 * @see {@link WebSocketStreamTransport} for the canonical WebSocket implementation.
 */
export interface IStreamTransport extends EventEmitterLike {
  /**
   * Stable identifier for this transport connection (e.g. a UUID or socket ID).
   * Used as a correlation key in logs and metrics.
   */
  readonly id: string;

  /**
   * Current connection state.
   * - `'connecting'` -- handshake in progress.
   * - `'open'` -- fully established and ready.
   * - `'closing'` -- graceful teardown initiated.
   * - `'closed'` -- no longer usable.
   */
  readonly state: 'connecting' | 'open' | 'closing' | 'closed';

  /**
   * The one audio format the transport plays, when it plays only one: `LiveKitStreamTransport` with a publisher
   * plays `'pcm'`. `VoicePipelineOrchestrator` asks its TTS for this format, and reports a chunk in another one instead
   * of sending it. Absent when the remote client decodes what it receives.
   */
  readonly playbackFormat?: 'pcm' | 'mp3' | 'opus';

  /**
   * Send a synthesised audio chunk to the remote client for playback.
   * Resolves once the chunk has been handed to the underlying I/O layer.
   *
   * @param chunk - Encoded audio to deliver.
   * @returns Resolves when the data has been buffered for transmission.
   * @throws {Error} If the transport is not in `'open'` state.
   */
  sendAudio(chunk: EncodedAudioChunk): Promise<void>;

  /**
   * Send a JSON control message to the remote client.
   *
   * @param message - Server-side protocol message.
   * @returns Resolves when the data has been buffered for transmission.
   * @throws {Error} If the transport is not in `'open'` state.
   */
  sendControl(message: ServerTextMessage): Promise<void>;

  /**
   * Resolves once the audio handed to `sendAudio()` has played out at the far end, as far as the transport can tell,
   * on a transport that plays it on its own timing after taking it, as a speaking `LiveKitStreamTransport` does: every
   * chunk sent so far, and any sent while it waits. Audio a clear discarded counts as played out.
   * `VoicePipelineOrchestrator` without a call profile keeps a reply `speaking` until it settles, so speech over the
   * rest of the reply interrupts it; a rejection ends the reply too, as interrupted, since what of it played is not
   * known (`VoiceConversationItem`), unless the wait was aborted. It aborts `signal` when a barge-in
   * cuts the reply or the session closes first, and a transport may then settle the wait at once. On a transport
   * without it, the orchestrator keeps the reply `speaking` for the duration of the audio it was sent instead
   * (`VoicePipelineConfig.maxPlayoutWaitMs`).
   *
   * @param signal - Aborted when the wait is no longer needed.
   * @returns Resolves once the audio sent so far has played out.
   */
  waitForPlayout?(signal?: AbortSignal): Promise<void>;

  /**
   * Close the transport, optionally supplying a WebSocket-style close code and
   * human-readable reason string for diagnostics.
   *
   * @param code - Optional numeric close code (defaults to 1000 normal closure).
   * @param reason - Optional human-readable close reason.
   */
  close(code?: number, reason?: string): void;
}

// ============================================================================
// Section 3 -- Streaming STT (Speech-to-Text)
// ============================================================================

/**
 * A hosted socket's immutable identity, established before any network
 * opening. The built-in Deepgram and OpenAI streaming adapters give one to
 * every socket they try, retries, reconnects and rollovers included, and pass
 * it to {@link SttConnectionHooks.authorize} before the WebSocket upgrade.
 */
export interface SttConnectionOpening {
  /** UUID unique across providers, retries, rollovers and process restarts. */
  readonly connectionId: string;
  /** Adapter id, such as `deepgram-streaming`. */
  readonly providerId: string;
  /** Exact hosted `vendor:model` entry used to reserve and price this socket. */
  readonly entry: string;
  /** Exact model used on the wire. */
  readonly model: string;
}

/**
 * Built-in hosted usage, with the identity shared by authorization and
 * settlement: one immutable cumulative report per interval and exactly one
 * final report for every socket a built-in adapter tried.
 */
export interface SttMeasuredUsageEvent extends StreamingSTTUsageEvent {
  /** The socket's {@link SttConnectionOpening.connectionId}. */
  readonly connectionId: string;
  /** The socket's {@link SttConnectionOpening.entry}. */
  readonly entry: string;
  /** The socket's {@link SttConnectionOpening.model}. */
  readonly model: string;
  /** The supplier's request id for this socket, when the supplier reported one. */
  readonly supplierRequestId?: string;
}

/**
 * Host accounting at the socket boundary, separate from provider permission
 * (`ProviderPolicy` still decides which providers may open). Honored by the
 * built-in Deepgram and OpenAI streaming adapters.
 */
export interface SttConnectionHooks {
  /**
   * Reserve against `opening.entry` and `opening.connectionId` before resolving.
   * Rejection forbids this socket and does not authorize a vendor fallback.
   * The host must test `signal.aborted` inside its transaction before commit
   * and roll back or release any late acquisition. No socket opens after abort.
   */
  authorize(opening: SttConnectionOpening, signal: AbortSignal): Promise<void>;
  /**
   * Finite per-socket funded audio ceiling, in wire seconds. Deepgram rolls to
   * an independently authorized socket of the same vendor before exceeding it.
   */
  audioCeiling?(opening: SttConnectionOpening): number;
  /**
   * Synchronous check of prospective cumulative wire seconds before each send,
   * including replay and overlap. `false` ends the provider with an
   * authorization error; must not throw.
   */
  beforeAudio?(opening: SttConnectionOpening, nextAudioSeconds: number): boolean;
  /**
   * Receive cumulative and exactly one final report for every attempted socket,
   * including final zero for a failed or denied opening. Unadopted OpenAI openings
   * use `connectionIndex` zero; all billing identity uses `connectionId`.
   * Queue durable processing synchronously and never throw. This is mirrored
   * by the session's `'usage'` event for adopted sockets: consume one path, not both.
   */
  usage(event: SttMeasuredUsageEvent): void;
  /** Maximum authorization wait before abort, in milliseconds. Default 10000. */
  authorizationTimeoutMs?: number;
}

/**
 * Configuration passed to `IStreamingSTT.startSession()` when opening a new
 * speech recognition stream.
 *
 * See `VoicePipelineConfig.sttOptions` for provider-level overrides.
 *
 * @example
 * ```typescript
 * const config: StreamingSTTConfig = {
 *   language: 'en-US',
 *   interimResults: true,
 *   punctuate: true,
 * };
 * ```
 */
export interface StreamingSTTConfig {
  /**
   * BCP-47 language code for recognition (e.g. `'en-US'`, `'fr-FR'`).
   * Falls back to the provider default when omitted.
   */
  language?: string;

  /**
   * Whether to emit interim (non-final) transcript events. When `true`,
   * partial results arrive more frequently at the cost of higher word error rate.
   * Interim results are useful for real-time UI display and early endpoint hints.
   * @defaultValue true
   */
  interimResults?: boolean;

  /**
   * Enable automatic punctuation insertion if the provider supports it.
   * Punctuation is critical for the {@link HeuristicEndpointDetector} which
   * uses terminal punctuation (`.`, `?`, `!`) as a turn-completion signal.
   * @defaultValue true
   */
  punctuate?: boolean;

  /**
   * Mask profanity in transcripts if supported by the provider.
   * @defaultValue false
   */
  profanityFilter?: boolean;

  /**
   * Pass-through options forwarded verbatim to the underlying provider SDK.
   * Useful for enabling provider-specific features (e.g. custom vocabulary,
   * speaker adaptation models) without modifying the interface.
   */
  providerOptions?: Record<string, unknown>;

  /** Optional accounting hooks honored by built-in Deepgram and OpenAI streaming adapters. */
  connectionHooks?: SttConnectionHooks;

  /** Call-profile identity; scoped adapters capture this and update it only through reset. */
  call?: AudioIdentity;
}

/**
 * A single word within a {@link TranscriptEvent}, augmented with timing and
 * optional speaker attribution.
 *
 * See `TranscriptEvent.words` for the array that contains these entries.
 */
export interface TranscriptWord {
  /**
   * The recognised word token (may include punctuation if `punctuate` is enabled).
   */
  word: string;

  /**
   * Millisecond offset from the start of the utterance at which this word begins.
   */
  start: number;

  /**
   * Millisecond offset from the start of the utterance at which this word ends.
   */
  end: number;

  /**
   * Recognition confidence in the range [0, 1]. Higher is better.
   * Typically 0.8+ for clear speech, 0.4-0.7 for noisy or accented audio.
   */
  confidence: number;

  /**
   * Speaker label when diarization is performed natively by the STT provider
   * (e.g. Deepgram's `diarize` option). When diarization is handled by a
   * separate {@link IDiarizationEngine}, this field is populated post-hoc.
   */
  speaker?: string;
}

/**
 * Emitted by a {@link StreamingSTTSession} each time the provider produces a
 * recognition hypothesis.
 *
 * See `IEndpointDetector.pushTranscript()` for the endpoint detector hook that consumes these events.
 *
 * @example
 * ```typescript
 * sttSession.on('transcript', (event: TranscriptEvent) => {
 *   if (event.isFinal) {
 *     console.log(`Final: "${event.text}" (confidence: ${event.confidence})`);
 *   }
 * });
 * ```
 */
export interface TranscriptEvent {
  /**
   * Full transcript text for the current utterance hypothesis.
   */
  text: string;

  /**
   * Aggregate confidence score for `text` in the range [0, 1].
   */
  confidence: number;

  /**
   * Word-level detail, sorted by `start` time. May be empty for interim events
   * from providers that only supply word timing in final results.
   */
  words: TranscriptWord[];

  /**
   * `true` when this hypothesis is stable and will not be revised.
   * `false` for interim (streaming) hypotheses.
   *
   * The {@link HeuristicEndpointDetector} only accumulates final transcripts;
   * interim results are discarded to avoid double-counting.
   */
  isFinal: boolean;

  /**
   * Duration of the recognised speech segment in milliseconds.
   * Populated only on final events where the provider supplies timing.
   */
  durationMs?: number;

  /**
   * Sentiment analysis result from the STT provider, when enabled.
   * Deepgram returns this when `sentiment=true` is set in providerOptions.
   */
  sentiment?: {
    /** Overall sentiment polarity. */
    label: 'positive' | 'negative' | 'neutral';
    /** Confidence score in [0, 1]. */
    confidence: number;
  };

  /**
   * Identifier of the provider's input item this hypothesis belongs to, when
   * the provider keys its results (OpenAI Realtime's `item_id`). Every interim
   * and the final of one utterance carry the same `itemId`, so a consumer that
   * shows interim text replaces it by key, and the results of two utterances
   * whose events interleave never mix. Providers without item keys leave it
   * undefined.
   */
  itemId?: string;

  /**
   * One connection-scoped speaker when every word has that voice; null when
   * diarization was requested but the words do not name exactly one voice.
   * Absent when diarization was not requested. Per-word speakers stay raw.
   */
  speaker?: string | null;

  /** The original item id on a later run of a final split by speaker. */
  runOf?: string;

  /**
   * Start of the utterance's audio, in milliseconds counted from the first
   * frame pushed into the session, when the provider reports speech
   * boundaries.
   */
  startMs?: number;

  /**
   * End of the utterance's audio, in milliseconds counted from the first
   * frame pushed into the session, when the provider reports speech
   * boundaries.
   */
  endMs?: number;

  /**
   * `true` on a result the provider sends before the end of speech of the
   * speech it transcribes: the session's `'speech_end'` for that speech
   * follows it. `DeepgramStreamingSTT` sets it on each result of an item
   * whose speech has not ended: it emits a segment's final before the
   * `'speech_end'` that Deepgram's `speech_final` or `UtteranceEnd` raises.
   * It sets `false` on a result of an item whose `'speech_end'` came before
   * its final (a final delayed past an `UtteranceEnd`), so that final answers
   * the end already waiting. A provider that sends an utterance's final
   * after that utterance's `'speech_end'`, as `OpenAIRealtimeTranscriptionSTT`
   * does, leaves it undefined. {@link HeuristicEndpointDetector} reads it on
   * a final that carries an `itemId`: such a final belongs to the speech it
   * arrives in, never to a turn that has ended, and that speech's
   * `'speech_end'` pairs with it.
   */
  beforeSpeechEnd?: boolean;

  /**
   * Language of `text`: the code the provider detected, or the language the
   * session was configured with (for example `'en'`). Undefined when neither
   * is known.
   */
  language?: string;
}

/**
 * Payload of the `'usage'` event a {@link StreamingSTTSession} emits for each
 * provider connection it opens, so a host can meter or settle the audio of
 * each connection on its own. A session that opens a new connection, to roll
 * over a provider's session limit or to recover from a dropped one, reports
 * that connection under its own `connectionIndex`; a connection that replaces
 * a dropped one keeps the dropped connection's rollover clocks, so the next
 * rollover and its approval come at the same time as without the drop.
 *
 * @example
 * ```typescript
 * sttSession.on('usage', (usage: StreamingSTTUsageEvent) => {
 *   if (usage.final) meter.settle(usage.connectionIndex, usage.audioSeconds);
 * });
 * ```
 */
export interface StreamingSTTUsageEvent {
  /** Provider that received the audio (its `IStreamingSTT.providerId`). */
  providerId: string;

  /** Built-in hosted socket UUID; custom adapters may omit it. Never substitute a local index. */
  connectionId?: string;

  /** Exact hosted `vendor:model` entry; custom adapters may omit it. */
  entry?: string;

  /** Model the connection transcribed with, when the provider names one. */
  model?: string;

  /**
   * 1-based index of the provider connection within the session, in the
   * order the connections opened.
   */
  connectionIndex: number;

  /** Seconds of audio sent on this connection so far. */
  audioSeconds: number;

  /** `true` on the connection's last report, sent once it has closed. */
  final: boolean;
}

/**
 * An active streaming speech-to-text session. Audio frames are pushed in
 * and transcript events flow out via EventEmitter.
 *
 * ## Events emitted
 *
 * | Event            | Payload                         | Description                                          |
 * |------------------|---------------------------------|------------------------------------------------------|
 * | `'transcript'`   | {@link TranscriptEvent}         | Interim or final hypothesis.                         |
 * | `'speech_start'` | *(none)*                        | Speech began (providers with voice-activity events). |
 * | `'speech_end'`   | *(none)*                        | Speech ended (providers with voice-activity events). |
 * | `'usage'`        | {@link StreamingSTTUsageEvent}  | Audio sent on one provider connection (providers that meter per connection). |
 * | `'error'`        | `Error`                         | Unrecoverable provider error.                        |
 * | `'close'`        | *(none)*                        | Session has been fully terminated.                   |
 *
 * See `IStreamingSTT.startSession()` for the factory method that creates these sessions.
 */
export interface StreamingSTTSession extends EventEmitterLike {
  /**
   * Push a raw audio frame into the recognition stream. Frames must arrive
   * in capture order; gaps or out-of-order frames degrade accuracy.
   *
   * @param frame - PCM audio frame to process.
   */
  pushAudio(frame: AudioFrame): void;

  /**
   * Signal end-of-utterance to the provider. The provider will flush any
   * buffered audio and emit a final {@link TranscriptEvent} before `'close'`.
   */
  flush(): Promise<void>;

  /**
   * Immediately terminate the session without waiting for a final result.
   * Useful during barge-in where the in-flight hypothesis is discarded.
   */
  close(): void;
}

/**
 * Factory interface for streaming speech-to-text providers.
 *
 * Implementations are registered via the `EXTENSION_KIND_STREAMING_STT`
 * extension kind and resolved by the voice pipeline at session creation time.
 *
 * See {@link StreamingSTTSession} for the session interface returned by `startSession()`.
 */
export interface IStreamingSTT {
  /**
   * Unique, stable identifier for this provider (e.g. `'deepgram'`, `'whisper-live'`).
   */
  readonly providerId: string;

  /**
   * `true` when the provider has at least one active session open.
   */
  readonly isStreaming: boolean;

  /**
   * Open a new streaming recognition session.
   *
   * @param config - Session-level configuration overriding provider defaults.
   * @returns A ready-to-use session whose lifecycle is independent of this factory.
   * @throws {Error} If the provider fails to initialise (e.g. invalid API key).
   */
  startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession>;
}

// ============================================================================
// Section 4 -- Endpoint detection
// ============================================================================

/**
 * A VAD (Voice Activity Detection) or STT-derived event describing speech
 * energy transitions over time.
 *
 * See `IEndpointDetector.pushVadEvent()` for the endpoint-detector hook that consumes these.
 *
 * @example
 * ```typescript
 * const speechStart: VadEvent = {
 *   type: 'speech_start',
 *   timestamp: Date.now(),
 *   source: 'vad',
 *   energyLevel: 0.42,
 * };
 * ```
 */
export interface VadEvent {
  /**
   * Type of the VAD transition:
   * - `'speech_start'` -- voice energy detected after silence.
   * - `'speech_end'` -- voice energy fell below the silence threshold.
   * - `'silence'` -- periodic silence heartbeat (emitted at `silenceIntervalMs` cadence).
   */
  type: 'speech_start' | 'speech_end' | 'silence';

  /**
   * Unix epoch millisecond timestamp at which this transition was detected.
   * Used by the endpoint detector to compute speech duration.
   */
  timestamp: number;

  /**
   * Optional raw energy level used to trigger this event (implementation-defined scale).
   * Useful for debugging VAD sensitivity but not consumed by the pipeline logic.
   */
  energyLevel?: number;

  /**
   * Origin of the VAD event:
   * - `'vad'` -- emitted by a standalone VAD model (e.g. Silero, WebRTC VAD).
   * - `'stt'` -- inferred from STT activity (e.g. provider-side endpointing signals).
   *
   * The pipeline synthesises STT-derived speech_start/speech_end events when
   * a dedicated VAD is not available, using the source field to distinguish them.
   */
  source?: 'vad' | 'stt';
}

/**
 * Semantic reason why the endpoint detector decided the user has finished speaking.
 *
 * Each reason maps to a different detection strategy within the endpoint detector:
 *
 * | Reason             | Detection strategy                                     |
 * |--------------------|--------------------------------------------------------|
 * | `silence_timeout`  | VAD silence exceeded configured threshold               |
 * | `punctuation`      | STT final result ends with `.`, `?`, or `!`            |
 * | `syntax_complete`  | Syntax model determined utterance is grammatically complete |
 * | `semantic_model`   | Small LM scored intent as complete                     |
 * | `manual`           | Explicitly triggered by a ClientTextMessage control     |
 * | `timeout`          | Hard maximum turn duration elapsed                     |
 *
 * See `TurnCompleteEvent.reason` for the field that carries this value.
 * See `VoiceTurnMetadata.endpointReason` for where it is forwarded to the agent.
 */
export type EndpointReason =
  | 'silence_timeout'
  | 'punctuation'
  | 'syntax_complete'
  | 'semantic_model'
  | 'manual'
  | 'timeout';

/**
 * Emitted by {@link IEndpointDetector} when it determines the user has finished
 * their turn and the pipeline should hand off to the agent.
 *
 * @see {@link IEndpointDetector} which emits these on the `'turn_complete'` event.
 * @see {@link VoicePipelineOrchestrator} which transitions to `'processing'` state upon receipt.
 *
 * @example
 * ```typescript
 * detector.on('turn_complete', (event: TurnCompleteEvent) => {
 *   console.log(`User said: "${event.transcript}" (reason: ${event.reason})`);
 * });
 * ```
 */
export interface TurnCompleteEvent {
  /**
   * The final consolidated transcript for this turn.
   * May be empty for acoustic-only detectors that have no transcript access.
   */
  transcript: string;

  /**
   * Aggregate STT confidence score for the transcript, in the range [0, 1].
   * Zero when no STT data is available (e.g. acoustic-only mode).
   */
  confidence: number;

  /**
   * Total duration of detected speech in this turn, in milliseconds.
   * Computed as `speechEndTimestamp - speechStartTimestamp`.
   */
  durationMs: number;

  /**
   * The semantic reason that triggered turn completion.
   * @see {@link EndpointReason} for the full set of possible values.
   */
  reason: EndpointReason;
}

/**
 * What the agent is doing, as `VoicePipelineOrchestrator` reports it to its
 * endpoint detector through `IEndpointDetector.setAgentContext()`, so the
 * detector can tell a backchannel, a response the user makes while the agent
 * holds the floor, from the user's own turn.
 *
 * @example
 * ```typescript
 * // The user's turn has completed: the agent holds the floor until its reply ends or a barge-in cuts it.
 * detector.setAgentContext?.({ speaking: true });
 * ```
 */
export interface EndpointAgentContext {
  /**
   * The agent holds the floor: its turn has begun and its reply has not
   * ended. `VoicePipelineOrchestrator` reports `true` from the moment a
   * user's turn completes until the reply ends or a barge-in cuts it.
   */
  speaking: boolean;
  /**
   * Whether the agent's last reply asked a question.
   *
   * @deprecated Ignored. A backchannel is a response made while the other
   * party holds the floor, so `speaking` alone decides whether a final is
   * one, and a reply's punctuation does not say whether it expects an answer
   * ("Tell me the time you would like." asks without `?`). The property stays
   * so that code which sets it still compiles; `VoicePipelineOrchestrator`
   * does not set it.
   */
  askedQuestion?: boolean;
}

/**
 * Detects turn boundaries in a continuous audio/transcript stream.
 * Combines VAD events with linguistic signals to decide when the user
 * has finished speaking.
 *
 * ## Events emitted
 *
 * | Event                  | Payload                 | Description                            |
 * |------------------------|-------------------------|----------------------------------------|
 * | `'turn_complete'`      | {@link TurnCompleteEvent} | The user's turn has ended.           |
 * | `'speech_start'`       | *(none)*                | The user has started speaking.         |
 * | `'barge_in_detected'`  | *(none)*                | User spoke while TTS was playing.      |
 * | `'late_final'`         | {@link TranscriptEvent} | A final that arrived after its turn ended, which the turn does not take. |
 * | `'backchannel_detected'` | `{ text: string }`    | A final the detector dropped as a backchannel (see `isBackchannel()`). |
 *
 * A detector that drops such a final from its turns emits `'late_final'`
 * with the final as it was pushed, once per final it drops
 * ({@link HeuristicEndpointDetector} does, for an item-keyed final that
 * arrives after a reset ended its turn and before the next `speech_end`, a
 * standalone VAD's next `speech_start` or a reset with `'session'`, while the
 * transcriber's next utterance is spoken included).
 * `VoicePipelineOrchestrator` does not listen for it, so the conversation
 * leaves those words out; `startListenSession` writes the final to its sink
 * as a turn of its own.
 *
 * @see {@link HeuristicEndpointDetector} for the rule-based implementation.
 * @see {@link AcousticEndpointDetector} for the purely acoustic implementation.
 */
export interface IEndpointDetector extends EventEmitterLike {
  /**
   * Active detection strategy:
   * - `'acoustic'` -- pure silence-timeout based (no transcript analysis).
   * - `'heuristic'` -- silence + terminal punctuation + backchannel filtering.
   * - `'semantic'` -- small LM scoring utterance completeness.
   */
  readonly mode: 'acoustic' | 'heuristic' | 'semantic';

  /**
   * Upper bound in milliseconds for a pending turn after `speech_end`, including
   * any timer polling interval. A listen session uses this to drain on stop;
   * detectors that omit it receive a 3250 ms drain bound.
   */
  readonly turnCompletionTimeoutMs?: number;

  /**
   * Push a VAD event from the upstream voice activity detector.
   *
   * @param event - The VAD event to process.
   */
  pushVadEvent(event: VadEvent): void;

  /**
   * Push a partial or final STT result for linguistic analysis.
   * Acoustic-mode detectors may no-op this method.
   *
   * @param event - Transcript event from the STT session.
   */
  pushTranscript(event: TranscriptEvent): void;

  /**
   * Reset all internal state (timers, partial transcripts) without destroying
   * the detector instance. Called at the start of each new turn, and with
   * `'session'` as a session starts on the detector
   * (`VoicePipelineOrchestrator.startSession()` and `startListenSession()`
   * make that call), so a detector a host hands to one session after another
   * starts each with nothing an earlier session left.
   *
   * @param scope - `'turn'` (the default) ends a turn, and a final of that turn
   *   can still arrive after it ({@link HeuristicEndpointDetector} drops such a
   *   late final and reports it as `'late_final'`, and never takes a final
   *   marked `beforeSpeechEnd` for one); `'session'` starts a session, whose
   *   transcriber sends no final of an earlier session's turns, so nothing
   *   from before it is awaited.
   */
  reset(scope?: 'turn' | 'session'): void;

  /**
   * Tells the detector whether the agent holds the floor.
   * `VoicePipelineOrchestrator` calls it as its session starts, after the
   * reset with `'session'` (`speaking: false`), as a user's turn completes
   * and the agent takes the floor (`speaking: true`), and as the agent's
   * reply ends or a barge-in cuts it (`speaking: false`). From the first call
   * until a reset with `'session'`, {@link HeuristicEndpointDetector} reads a
   * final with trailing `.`, `,`, `!` or an ellipsis ("Sure.") as its phrase,
   * never takes one that ends with `?` ("Okay?") for a backchannel, and drops
   * a backchannel such as "yeah" only while the agent holds the floor: while
   * the agent listens, every final is the user's, a lone "okay" included.
   * Until the first call, and again after a reset with `'session'`, it drops
   * a final whose whole text, trimmed and lowercased, is a backchannel
   * phrase, whatever the agent is doing, so a caller that never calls it,
   * such as a listen session, keeps that rule. A detector without this method
   * is told nothing.
   *
   * @param context - Whether the agent holds the floor; its deprecated `askedQuestion` is ignored.
   */
  setAgentContext?(context: EndpointAgentContext): void;

  /**
   * Whether the detector would drop a final with this text as a backchannel
   * now: the same phrases, the same reading of the text and the same agent
   * context as for its own finals. `VoicePipelineOrchestrator` asks it of
   * each final from a client that transcribes on its own device, and hands
   * one it answers `true` for to the detector on its own, which drops it and
   * reports it as `'backchannel_detected'`, instead of joining it into the
   * turn's text. A detector without this method gets every client final
   * joined with the turn's earlier ones.
   *
   * @param text - A final's text.
   * @returns `true` when the detector would drop the final as a backchannel.
   */
  isBackchannel?(text: string): boolean;
}

// ============================================================================
// Section 5 -- Diarization (speaker separation)
// ============================================================================

/**
 * Configuration for a diarization session. Controls expected speaker count and
 * chunking behaviour for providers that require buffered audio.
 *
 * See `IDiarizationEngine.startSession()` for the factory method that accepts this config.
 */
export interface DiarizationConfig {
  /**
   * Hint to the provider about how many distinct speakers are expected.
   * When omitted, the provider uses auto-detection (which typically adds
   * latency as it needs more audio to stabilise speaker count).
   */
  expectedSpeakers?: number;

  /**
   * When `true`, use the provider's built-in diarization instead of the
   * AgentOS diarization engine (e.g. Deepgram `diarize` option).
   * @defaultValue false
   */
  preferProviderNative?: boolean;

  /**
   * Size of audio chunks processed per diarization inference, in milliseconds.
   * Smaller values reduce latency; larger values improve accuracy.
   * @defaultValue 500
   */
  chunkSizeMs?: number;

  /**
   * Overlap between consecutive chunks in milliseconds. Overlap improves
   * speaker boundary accuracy at the cost of extra compute.
   * @defaultValue 100
   */
  overlapMs?: number;
}

/**
 * A contiguous segment of transcript text with millisecond timing metadata.
 *
 * @see {@link DiarizedSegment} which extends this with speaker attribution.
 */
export interface TranscriptSegment {
  /**
   * The text content of the segment.
   */
  text: string;

  /**
   * Start of the segment in milliseconds from the beginning of the stream.
   */
  startMs: number;

  /**
   * End of the segment in milliseconds from the beginning of the stream.
   */
  endMs: number;
}

/**
 * A {@link TranscriptSegment} extended with speaker attribution produced by the
 * diarization engine.
 *
 * @see {@link DiarizationSession} which emits these on the `'segment'` event.
 *
 * @example
 * ```typescript
 * diarizationSession.on('segment', (seg: DiarizedSegment) => {
 *   console.log(`[${seg.speakerId}]: "${seg.text}"`);
 * });
 * ```
 */
export interface DiarizedSegment extends TranscriptSegment {
  /**
   * Stable speaker label assigned by the diarization engine (e.g. `'SPEAKER_0'`).
   * The label is consistent within a session but not across sessions unless
   * speaker enrollment is used.
   */
  speakerId: string;

  /**
   * Confidence that this segment belongs to `speakerId`, in the range [0, 1].
   */
  speakerConfidence: number;
}

/**
 * An active diarization session. Accepts raw audio and outputs speaker-attributed
 * transcript segments via EventEmitter.
 *
 * ## Events emitted
 *
 * | Event              | Payload                                  | Description                    |
 * |--------------------|------------------------------------------|--------------------------------|
 * | `'segment'`        | {@link DiarizedSegment}                  | A diarized segment is ready.   |
 * | `'speaker_change'` | `{ from: string; to: string }`           | Speaker transition detected.   |
 * | `'error'`          | `Error`                                  | Unrecoverable engine error.    |
 * | `'close'`          | *(none)*                                 | Session terminated.            |
 *
 * See `IDiarizationEngine.startSession()` for the factory method that creates these sessions.
 */
export interface DiarizationSession extends EventEmitterLike {
  /**
   * Push a raw audio frame for diarization analysis.
   *
   * @param frame - PCM audio frame from the capture stream.
   */
  pushAudio(frame: AudioFrame): void;

  /**
   * Apply speaker labels to an existing transcript using the session's
   * current speaker model. Returns labelled segments.
   *
   * @param transcript - Plain transcript segments to label.
   * @returns Speaker-attributed segments with confidence scores.
   */
  labelTranscript(transcript: TranscriptSegment[]): Promise<DiarizedSegment[]>;

  /**
   * Enroll a known speaker so subsequent audio is attributed to a named identity
   * rather than an anonymous `SPEAKER_N` label.
   *
   * @param speakerId - Stable identifier for the speaker (e.g. user UUID).
   * @param samples - Representative audio frames for the speaker's voice.
   *   Typically 10-30 seconds of clean speech produces the best embeddings.
   */
  enrollSpeaker(speakerId: string, samples: AudioFrame[]): Promise<void>;

  /**
   * Terminate the session and release all provider-side resources.
   */
  close(): void;
}

/**
 * Factory interface for diarization (speaker separation) engines.
 *
 * Registered via `EXTENSION_KIND_DIARIZATION`.
 *
 * See {@link DiarizationSession} for the session interface returned by `startSession()`.
 */
export interface IDiarizationEngine {
  /**
   * Open a new diarization session.
   *
   * @param config - Session configuration controlling chunking and speaker hints.
   * @returns A live session that accepts audio and emits diarized segments.
   */
  startSession(config?: DiarizationConfig): Promise<DiarizationSession>;
}

// ============================================================================
// Section 6 -- Streaming TTS (Text-to-Speech)
// ============================================================================

/**
 * Configuration passed to `IStreamingTTS.startSession()` when opening a new
 * text-to-speech synthesis stream.
 *
 * See `VoicePipelineConfig.ttsOptions` for provider-level overrides.
 *
 * @example
 * ```typescript
 * const config: StreamingTTSConfig = {
 *   voice: 'nova',
 *   format: 'opus',
 *   sampleRate: 24000,
 *   chunkingMode: 'sentence',
 * };
 * ```
 */
export interface StreamingTTSConfig {
  /**
   * Provider-specific voice identifier (e.g. `'alloy'`, `'nova'`, `'en-US-Wavenet-D'`).
   * Defaults to the provider's built-in default when omitted.
   */
  voice?: string;

  /**
   * Output audio format.
   * @defaultValue 'opus'
   */
  format?: 'pcm' | 'mp3' | 'opus';

  /**
   * Output sample rate in Hz. Must be supported by the chosen `format`.
   * @defaultValue 24000
   */
  sampleRate?: number;

  /**
   * Controls how the provider segments incoming token streams into synthesis
   * requests:
   * - `'sentence'` -- flush at sentence boundaries (lower latency).
   * - `'word'` -- flush at word boundaries (minimum latency, may sound choppy).
   * - `'paragraph'` -- flush at paragraph boundaries (highest quality).
   * @defaultValue 'sentence'
   */
  chunkingMode?: 'sentence' | 'word' | 'paragraph';

  /**
   * Maximum number of milliseconds of audio to buffer before forcing a flush,
   * regardless of `chunkingMode`. Prevents unbounded memory growth for very
   * long utterances.
   * @defaultValue 3000
   */
  maxBufferMs?: number;

  /**
   * Pass-through options forwarded to the underlying provider SDK.
   */
  providerOptions?: Record<string, unknown>;

  /**
   * Optional prosody controls. Streaming providers consume the subset
   * they support and ignore the rest; see {@link TTSExpressiveness}.
   */
  expressiveness?: TTSExpressiveness;

  /** Optional scoped synthesis request. A call-profile provider reports this identity on every chunk and usage event. */
  call?: AudioIdentity & { requestId: string };
}

/**
 * An active streaming TTS session. Token text is pushed in and encoded audio
 * chunks flow out via EventEmitter.
 *
 * ## Events emitted
 *
 * | Event              | Payload                   | Description                          |
 * |--------------------|---------------------------|--------------------------------------|
 * | `'audio'`          | {@link EncodedAudioChunk}  | A synthesised chunk ready for playback. |
 * | `'flush_complete'`  | *(none)*                  | All queued tokens have been synthesised. |
 * | `'error'`          | `Error`                   | Unrecoverable synthesis error.       |
 * | `'close'`          | *(none)*                  | Session terminated.                  |
 *
 * See `IStreamingTTS.startSession()` for the factory method that creates these sessions.
 */
export interface StreamingTTSSession extends EventEmitterLike {
  /**
   * Push one or more LLM output tokens into the synthesis buffer.
   * The session will chunk and synthesise them according to `StreamingTTSConfig.chunkingMode`.
   *
   * @param tokens - Text tokens to synthesise (may be partial words).
   */
  pushTokens(tokens: string): void;

  /**
   * Force synthesis of all buffered tokens, then emit `'flush_complete'`.
   * Call at end-of-response or when transitioning between agent turns.
   */
  flush(): Promise<void>;

  /**
   * Immediately stop synthesis and discard all buffered tokens. Audio chunks
   * currently in-flight are not recalled; the caller must stop playback separately.
   * Used during barge-in to halt the agent's response.
   */
  cancel(): void;

  /**
   * Terminate the session and release provider-side resources.
   */
  close(): void;

  /** Opt-in pull contract. Await the sink before producing another chunk; never also emit that chunk as audio. */
  setAudioSink?(sink: (chunk: EncodedAudioChunk) => Promise<void>): void;

  /** Bounded text admission; the call profile requires this alongside setAudioSink. */
  writeTokens?(tokens: string): Promise<void>;
}

/**
 * Factory interface for streaming text-to-speech providers.
 *
 * Registered via `EXTENSION_KIND_STREAMING_TTS`.
 *
 * See {@link StreamingTTSSession} for the session interface returned by `startSession()`.
 */
export interface IStreamingTTS {
  /**
   * Unique, stable identifier for this provider (e.g. `'openai'`, `'elevenlabs'`).
   */
  readonly providerId: string;

  /**
   * Open a new streaming synthesis session.
   *
   * @param config - Session-level configuration overriding provider defaults.
   * @returns A live session that accepts tokens and emits audio chunks.
   * @throws {Error} If the provider fails to initialise (e.g. invalid API key).
   */
  startSession(config?: StreamingTTSConfig): Promise<StreamingTTSSession>;
}

// ============================================================================
// Section 6b -- Batch text-to-speech
// ============================================================================

/**
 * Configuration for a batch (one-shot) TTS synthesis request.
 * Used by {@link IBatchTTS.synthesize} for non-streaming narration.
 */
/**
 * Optional prosody / expressiveness controls for TTS synthesis.
 *
 * Providers apply the SUBSET of knobs their API supports and silently
 * ignore the rest — callers can pass one object regardless of which
 * provider ends up serving the request:
 * - ElevenLabs: stability, similarityBoost, style, useSpeakerBoost, speed.
 * - OpenAI: speed only.
 * - Deepgram Aura: none (no prosody parameters exist on the API).
 *
 * Batch providers report the knobs they actually consumed on
 * {@link BatchTTSResult.appliedExpressiveness} so callers can avoid
 * double-applying (e.g. a client-side playback-rate speed on top of a
 * provider-rendered speed).
 */
export interface TTSExpressiveness {
  /** Voice steadiness, 0-1. Lower is more variable/expressive. */
  stability?: number;
  /** How closely the voice tracks its reference, 0-1. */
  similarityBoost?: number;
  /** Style exaggeration, 0-1. */
  style?: number;
  /** Speaking-rate multiplier (provider-dependent range; ~0.7-1.2 on ElevenLabs, 0.25-4 on OpenAI). */
  speed?: number;
  /** ElevenLabs speaker-boost toggle. */
  useSpeakerBoost?: boolean;
  /**
   * Natural-language acting direction (e.g. "whisper, urgent, on the verge
   * of tears"). Rendered only by providers with an instruction surface —
   * Hume Octave maps it to `utterances[].description`. Providers without
   * such a surface ignore it, and per the appliedExpressiveness contract it
   * is reported ONLY when the serving provider actually consumed it.
   */
  instructions?: string;
}

export interface BatchTTSConfig {
  /** Provider-specific voice identifier. */
  voice?: string;
  /** Model identifier (e.g. 'tts-1', 'tts-1-hd', 'eleven_multilingual_v2'). */
  model?: string;
  /** Output audio format. @defaultValue 'mp3' */
  format?: 'mp3' | 'opus' | 'pcm';
  /** Playback speed multiplier (provider-dependent range, typically 0.25-4.0). */
  speed?: number;
  /**
   * Optional prosody controls. Providers consume the subset they support
   * and ignore the rest; see {@link TTSExpressiveness}. A top-level
   * `speed` takes precedence over `expressiveness.speed`.
   */
  expressiveness?: TTSExpressiveness;
  /** Pass-through options forwarded to the underlying provider SDK. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Result of a batch TTS synthesis operation.
 */
export interface BatchTTSResult {
  /** Raw audio bytes in the requested format. */
  audio: Buffer;
  /** Audio format of the returned buffer. */
  format: 'mp3' | 'opus' | 'pcm';
  /** Estimated duration in milliseconds. */
  durationMs: number;
  /** Provider ID that served this request. */
  provider: string;
  /**
   * Names of the {@link TTSExpressiveness} knobs the serving provider
   * actually consumed from CALLER-provided values (silent provider
   * defaults are not reported). Unset when the provider applied none —
   * e.g. Deepgram Aura, which has no prosody parameters.
   */
  appliedExpressiveness?: string[];
}

/**
 * Factory interface for batch (one-shot) text-to-speech providers.
 *
 * Unlike {@link IStreamingTTS} which pushes tokens incrementally for real-time
 * voice conversations, batch TTS accepts complete text and returns finished audio.
 * Suitable for narration, pre-rendered dialogue, and audio export.
 *
 * Providers may implement both {@link IStreamingTTS} and {@link IBatchTTS}.
 */
export interface IBatchTTS {
  /** Unique, stable identifier for this provider (e.g. 'openai-tts-1', 'elevenlabs-batch'). */
  readonly providerId: string;
  /** Synthesize complete text into audio. */
  synthesize(text: string, config?: BatchTTSConfig): Promise<BatchTTSResult>;
}

/**
 * Configuration for a batch (one-shot) STT transcription request.
 * Used by {@link IBatchSTT.transcribe} for pre-recorded audio (voice notes,
 * uploaded clips).
 */
export interface BatchSTTConfig {
  /** Source audio MIME type (e.g. 'audio/webm', 'audio/mp4'). Sent as the
   *  request Content-Type / used to name the multipart part. @default 'audio/webm' */
  mimeType?: string;
  /** BCP-47 language hint (e.g. 'en'). @default 'en' */
  language?: string;
  /** Provider-specific model override (e.g. 'nova-3', 'whisper-1'). */
  model?: string;
  /** Pass-through options forwarded to the underlying provider SDK. */
  providerOptions?: Record<string, unknown>;
}

/**
 * Result of a batch STT transcription operation.
 */
export interface BatchSTTResult {
  /** Recognized transcript text (trimmed). */
  transcript: string;
  /** Estimated source audio duration in milliseconds. */
  durationMs: number;
  /** Provider ID that served this request. */
  provider: string;
}

/**
 * Factory interface for batch (one-shot) speech-to-text providers.
 *
 * Unlike {@link IStreamingSTT} which recognizes audio incrementally over a live
 * session, batch STT accepts a complete audio buffer and returns a finished
 * transcript. Suitable for voice notes, uploaded clips, and offline
 * transcription.
 *
 * A provider signals a silent clip by throwing `EmptyTranscriptError` (from the
 * batch STT providers module) — a determinate result, not a provider failure.
 */
export interface IBatchSTT {
  /** Unique, stable identifier for this provider (e.g. 'deepgram-prerecorded', 'openai-whisper'). */
  readonly providerId: string;
  /** Transcribe a complete audio buffer into text. */
  transcribe(audio: Buffer, config?: BatchSTTConfig): Promise<BatchSTTResult>;
}

// ============================================================================
// Section 7 -- Barge-in handling
// ============================================================================

/**
 * Contextual information supplied to `IBargeinHandler.handleBargein()` so the
 * handler can make an informed decision about how to respond to interruption.
 *
 * @see {@link IBargeinHandler} which consumes this context.
 * @see {@link HardCutBargeinHandler} and {@link SoftFadeBargeinHandler} for concrete handlers.
 *
 * @example
 * ```typescript
 * const context: BargeinContext = {
 *   speechDurationMs: 450,
 *   interruptedText: 'I was explaining the process of...',
 *   playedDurationMs: 2300,
 * };
 * ```
 */
export interface BargeinContext {
  /**
   * Duration of the user's speech over the reply so far, in ms.
   * `VoicePipelineOrchestrator` asks with 0 as the speech starts, then again
   * every 100 ms while it lasts, on each of its transcripts and at its end,
   * each time with the speech measured from its start.
   * Short durations (< 100 ms) often indicate accidental noise, lip smacks,
   * or breaths rather than intentional interruption.
   *
   * @see {@link HardCutBargeinHandler} which uses a 300 ms default threshold.
   * @see {@link SoftFadeBargeinHandler} which uses a tiered threshold system.
   */
  speechDurationMs: number;

  /**
   * The partial TTS text that was interrupted. Used to construct
   * `VoiceTurnMetadata.interruptedRemainder` so the agent knows what
   * information was cut off and can avoid repeating it.
   */
  interruptedText: string;

  /**
   * How many milliseconds of the reply's audio had been sent to the transport
   * when the handler is asked. `VoicePipelineOrchestrator` counts audio a
   * pause holds once it is sent.
   * Combined with `interruptedText`, this allows the agent to estimate
   * how much of the response the user actually heard.
   */
  playedDurationMs: number;
}

/**
 * Action the pipeline should take in response to a detected barge-in.
 * Returned by `IBargeinHandler.handleBargein()`.
 *
 * @see {@link IBargeinHandler} which returns this type.
 *
 * @example
 * ```typescript
 * const cancelAction: BargeinAction = { type: 'cancel', injectMarker: '[interrupted]' };
 * const pauseAction: BargeinAction  = { type: 'pause', fadeMs: 150 };
 * const resumeAction: BargeinAction = { type: 'resume' };
 * const ignoreAction: BargeinAction = { type: 'ignore' };
 * ```
 */
export type BargeinAction =
  | {
      /** Immediately stop all TTS output and discard the remainder of the response. */
      type: 'cancel';
      /**
       * Optional text marker injected into the conversation context to signal that
       * the agent's turn was cut short (e.g. `'[interrupted]'`).
       */
      injectMarker?: string;
    }
  | {
      /**
       * Fade out TTS audio over `fadeMs` milliseconds then pause.
       * `VoicePipelineOrchestrator` sends the transport this action and holds
       * the reply's audio until the reply is cancelled or, after a false
       * interruption, resumed with `'resume'`.
       */
      type: 'pause';
      /** Duration of the fade-out in milliseconds. @defaultValue 150 */
      fadeMs?: number;
    }
  | {
      /**
       * Resume TTS playback from where it was paused (only valid after a prior
       * `'pause'` action). `VoicePipelineOrchestrator` sends it in the
       * `barge_in` message after a false interruption, followed by the audio
       * the pause held; a handler that answers it changes nothing there.
       */
      type: 'resume';
    }
  | {
      /**
       * Treat the detected barge-in as noise and continue TTS playback uninterrupted.
       * Appropriate for very short, low-confidence speech detections.
       */
      type: 'ignore';
    };

/**
 * Handles the policy decision when a barge-in (user speaking over TTS) is detected.
 *
 * Registered via `EXTENSION_KIND_BARGEIN_HANDLER`.
 *
 * @see {@link HardCutBargeinHandler} for the immediate-stop strategy.
 * @see {@link SoftFadeBargeinHandler} for the three-tier fade strategy.
 */
export interface IBargeinHandler {
  /**
   * Interruption strategy implemented by this handler:
   * - `'hard-cut'` -- TTS audio is stopped immediately with no fade.
   * - `'soft-fade'` -- TTS audio fades out over a short window before stopping.
   */
  readonly mode: 'hard-cut' | 'soft-fade';

  /**
   * Called by the pipeline as the user speaks over the agent's reply.
   * `VoicePipelineOrchestrator`, without a call profile, asks as the speech
   * starts and again as it grows (see `BargeinContext.speechDurationMs`),
   * until the handler answers `'cancel'` or the speech's end decides, so a
   * handler that decides by the speech's duration acts once it reaches its
   * threshold. The handler evaluates the context and returns the action the
   * pipeline should execute.
   *
   * @param context - Contextual snapshot at the moment of interruption.
   * @returns The action to perform (or a promise resolving to one).
   */
  handleBargein(context: BargeinContext): BargeinAction | Promise<BargeinAction>;
}

// ============================================================================
// Section 8 -- Agent session interface
// ============================================================================

/**
 * Adapts any AgentOS agent to the voice pipeline's turn-based protocol.
 *
 * The pipeline calls `sendText()` with the user's final transcript and
 * streams the response back as text tokens for TTS synthesis.
 *
 * @see {@link VoicePipelineOrchestrator} which invokes this during the
 *   `PROCESSING -> SPEAKING` state transition.
 */
export interface IVoicePipelineAgentSession {
  /**
   * Send the user's utterance to the agent and receive a streaming text response.
   *
   * @param text - Final transcript from the STT + endpoint detection pipeline.
   * @param metadata - Rich metadata about the current voice turn.
   * @returns An async iterable of text tokens (suitable for streaming into TTS).
   *
   * @example
   * ```typescript
   * const tokens = agentSession.sendText('What is the weather?', metadata);
   * for await (const token of tokens) {
   *   ttsSession.pushTokens(token);
   * }
   * ```
   */
  sendText(text: string, metadata: VoiceTurnMetadata): AsyncIterable<string>;

  /**
   * Abort the current agent response mid-stream (called on barge-in when
   * {@link BargeinAction} type is `'cancel'`).
   *
   * Implementations should cancel any in-flight LLM requests. The pipeline
   * will discard any tokens emitted after `abort()` is called.
   */
  abort?(): void;
}

/**
 * Rich metadata attached to each voice turn and passed to the agent session.
 * Enables the agent to tailor its response based on conversation dynamics.
 *
 * See `IVoicePipelineAgentSession.sendText()` for the agent-session method that receives this metadata.
 *
 * @example
 * ```typescript
 * const metadata: VoiceTurnMetadata = {
 *   speakers: ['user'],
 *   endpointReason: 'punctuation',
 *   speechDurationMs: 3200,
 *   wasInterrupted: false,
 *   transcriptConfidence: 0.92,
 * };
 * ```
 */
export interface VoiceTurnMetadata {
  /**
   * Speaker labels present in this turn. Contains at least one entry (the user).
   * Multi-speaker turns arise in conference call or multi-party scenarios.
   */
  speakers: string[];

  /**
   * The reason the endpoint detector decided the user had finished speaking.
   * @see {@link EndpointReason} for the full set of possible values.
   */
  endpointReason: EndpointReason;

  /**
   * Duration of active user speech in this turn, in milliseconds.
   * Does not include silence periods.
   */
  speechDurationMs: number;

  /**
   * Whether the user's turn interrupted an in-progress TTS response.
   */
  wasInterrupted: boolean;

  /**
   * When `wasInterrupted` is `true`, the text remainder of the agent response
   * that was cut off. Useful for the agent to avoid re-stating information
   * the user has already heard.
   */
  interruptedRemainder?: string;

  /**
   * Aggregate STT confidence for the complete transcript, in the range [0, 1].
   */
  transcriptConfidence: number;

  /** Required on call-profile reasoning requests; absent on legacy sessions. */
  identity?: AudioIdentity;
}

// ============================================================================
// Section 9 -- Pipeline configuration and state
// ============================================================================

/**
 * Top-level configuration for the {@link VoicePipelineSession}.
 * Specifies which providers to use and their session-level options.
 *
 * @see {@link VoicePipelineOrchestrator} which consumes this configuration.
 *
 * @example
 * ```typescript
 * const config: VoicePipelineConfig = {
 *   stt: 'deepgram',
 *   tts: 'openai',
 *   endpointing: 'heuristic',
 *   bargeIn: 'hard-cut',
 *   voice: 'nova',
 *   format: 'opus',
 *   language: 'en-US',
 * };
 * ```
 */
export interface VoicePipelineConfig {
  /**
   * Identifier of the streaming STT provider to use (must be registered via
   * `EXTENSION_KIND_STREAMING_STT`).
   * Examples: `'deepgram'`, `'whisper-live'`, `'whisper-chunked'`.
   */
  stt: string;

  /**
   * Identifier of the streaming TTS provider to use (must be registered via
   * `EXTENSION_KIND_STREAMING_TTS`).
   * Examples: `'openai'`, `'elevenlabs'`, `'cartesia'`.
   */
  tts: string;

  /**
   * Endpoint detection strategy. Defaults to `'heuristic'` when omitted.
   * See `IEndpointDetector.mode` for the strategy descriptions.
   */
  endpointing?: 'acoustic' | 'heuristic' | 'semantic';

  /**
   * Enable speaker diarization for multi-speaker scenarios. Disabled by default.
   */
  diarization?: boolean;

  /**
   * Barge-in (interruption) handling mode. Defaults to `'hard-cut'` when omitted.
   * @see {@link HardCutBargeinHandler} and {@link SoftFadeBargeinHandler}.
   */
  bargeIn?: 'hard-cut' | 'soft-fade' | 'disabled';

  /**
   * TTS voice identifier. Forwarded to `StreamingTTSConfig.voice`.
   */
  voice?: string;

  /**
   * Output audio format for TTS. Forwarded to `StreamingTTSConfig.format`.
   * @defaultValue 'opus'
   */
  format?: 'pcm' | 'mp3' | 'opus';

  /**
   * BCP-47 language code. Forwarded to both STT and TTS sessions.
   */
  language?: string;

  /**
   * Hard cap on how long a single user turn may last, in milliseconds.
   * When exceeded, the endpoint detector fires with reason `'timeout'`.
   * @defaultValue 30000
   */
  maxTurnDurationMs?: number;

  /**
   * How long a reply paused by barge-in waits, after the user's speech ends,
   * for that speech's final transcript, in milliseconds. A final with words
   * cancels the reply; an empty final, a backchannel the endpoint detector
   * recognizes, or no final within this time is a false interruption, and
   * the reply resumes. Read without a call profile. A finite number of zero
   * or more: `VoicePipelineOrchestrator`'s constructor throws a `RangeError`
   * otherwise.
   * @defaultValue 1500
   */
  falseInterruptionMs?: number;

  /**
   * The longest a reply stays `speaking` after its synthesis completes, in milliseconds, on a transport without
   * `IStreamTransport.waitForPlayout()`. Such a transport cannot say when its audio has played, so the reply holds the
   * floor for the duration of the audio it was sent: each chunk plays after the one before it, from the moment it is
   * sent at the earliest. A barge-in over the rest of the reply interrupts it, and the reply ends, with `agent_done`,
   * once that audio has played or this much time has passed since its synthesis completed. Read without a call
   * profile. A finite number of zero or more: `VoicePipelineOrchestrator`'s constructor throws a `RangeError` otherwise.
   * @defaultValue 30000
   */
  maxPlayoutWaitMs?: number;

  /**
   * How long the user and the agent may both be listening before the session reports the user `'away'` in
   * `user_state_changed`, in milliseconds. The user's next speech makes the user `'speaking'` again. Unset, the user is
   * never `'away'`. A finite number greater than zero: `VoicePipelineOrchestrator`'s constructor throws a `RangeError`
   * otherwise.
   */
  userAwayTimeoutMs?: number;

  /**
   * Provider-level STT options merged into `StreamingSTTConfig.providerOptions`.
   */
  sttOptions?: Record<string, unknown>;

  /**
   * Provider-level TTS options merged into `StreamingTTSConfig.providerOptions`.
   */
  ttsOptions?: Record<string, unknown>;

  /**
   * Optional prosody controls forwarded to the streaming TTS session as
   * {@link StreamingTTSConfig.expressiveness}. Providers consume the
   * subset they support (ElevenLabs: all knobs; Deepgram Aura: none).
   */
  ttsExpressiveness?: TTSExpressiveness;
}

/**
 * Lifecycle state of a {@link VoicePipelineSession}.
 *
 * ## Valid state transitions
 *
 * ```
 * idle -> listening -> processing -> speaking -> listening
 *                                             -> interrupting -> listening
 * any  -> closed
 * ```
 *
 * The state machine is enforced by the internal `VoicePipelineOrchestrator._setState`
 * which emits `'state_changed'` on every transition.
 */
export type PipelineState =
  | 'idle' // Session created but no audio flowing yet
  | 'listening' // Capturing user audio; STT + VAD active
  | 'processing' // User turn complete; agent generating response
  | 'speaking' // TTS audio streaming to client
  | 'interrupting' // Barge-in detected; winding down TTS
  | 'closed'; // Session terminated; no further state changes

/**
 * A live voice pipeline session binding a transport, STT, endpoint detection,
 * optional diarization, agent, and TTS into a single coordinated lifecycle.
 *
 * ## Events emitted
 *
 * The events of {@link VoiceSessionEventMap}, every one of which
 * {@link VOICE_SESSION_EVENT_NAMES} lists; `on`, `once` and `off` type each
 * listener by its event's payload. Both of `VoicePipelineOrchestrator`'s
 * runtimes emit the same map, and the orchestrator emits it as well, except
 * `error` and `state_change`, so a host that listens on the orchestrator
 * before `startSession()` also hears the session start.
 *
 * | Event                      | Payload                                   | When                                         |
 * |----------------------------|-------------------------------------------|----------------------------------------------|
 * | `'agent_state_changed'`    | `{ oldState, newState, createdAt }`       | The agent's {@link VoiceAgentState} changed. |
 * | `'user_state_changed'`     | `{ oldState, newState, createdAt }`       | The user's {@link VoiceUserState} changed.   |
 * | `'user_input_transcribed'` | `{ transcript, isFinal, ... }`            | A transcript of the user's speech arrived.   |
 * | `'conversation_item_added'`| `{ item, createdAt }`                     | A user turn or an agent reply joined the conversation. |
 * | `'speech_created'`         | `{ source, userInitiated, createdAt }`    | A reply or a host prompt began to speak.     |
 * | `'barge_in'`               | `{ speechDurationMs, action, ... }`       | The user's speech paused, resumed or cut the reply. |
 * | `'error'`                  | `Error`                                   | The session ended on a failure (content-free). |
 * | `'session_error'`          | `{ error, recoverable, source, createdAt }` | A failure, with where it came from and whether the session goes on. |
 * | `'close'`                  | `{ reason, error?, createdAt }`           | The session closed.                          |
 * | `'state_change'`           | {@link PipelineState}                     | Deprecated: read `agent_state_changed`.      |
 * | `'turn_complete'`          | {@link TurnCompleteEvent}                 | Deprecated: read `conversation_item_added`.  |
 *
 * See `VoicePipelineOrchestrator.startSession()` for the factory method that creates these sessions.
 *
 * @example
 * ```typescript
 * session.on('agent_state_changed', ({ oldState, newState }) => console.log(`${oldState} -> ${newState}`));
 * session.on('conversation_item_added', ({ item }) => history.push(item));
 * ```
 */
export interface VoicePipelineSession extends EventEmitterLike {
  /** Adds a listener for one of the session's events, typed by its payload. */
  on<K extends keyof VoiceSessionEventMap>(event: K, listener: (payload: VoiceSessionEventMap[K]) => void): this;
  /** Adds a listener for any event, as `EventEmitter.on()` does. */
  on(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Adds a listener for the next one of the session's events, typed by its payload. */
  once<K extends keyof VoiceSessionEventMap>(event: K, listener: (payload: VoiceSessionEventMap[K]) => void): this;
  /** Adds a listener for the next event of a name, as `EventEmitter.once()` does. */
  once(eventName: string | symbol, listener: VoiceEventListener): this;
  /** Removes a listener of one of the session's events. */
  off<K extends keyof VoiceSessionEventMap>(event: K, listener: (payload: VoiceSessionEventMap[K]) => void): this;
  /** Removes a listener, as `EventEmitter.off()` does. */
  off(eventName: string | symbol, listener: VoiceEventListener): this;

  /**
   * Unique, stable identifier for this session (UUID).
   */
  readonly sessionId: string;

  /**
   * Current pipeline state machine state.
   * @see {@link PipelineState} for the full set of states and transitions.
   */
  readonly state: PipelineState;

  /**
   * The transport this session is bound to. Useful for sending out-of-band
   * control messages without going through the pipeline.
   */
  readonly transport: IStreamTransport;

  /**
   * Gracefully close the session -- flush in-flight audio, tear down all sub-sessions,
   * and emit `'close'`.
   *
   * @param reason - Optional human-readable reason for diagnostics.
   */
  close(reason?: string): Promise<void>;
}

// ============================================================================
// Section 9b -- Session events
// ============================================================================

/**
 * What the agent is doing, as `agent_state_changed` reports it. The names are
 * LiveKit Agents' agent states (https://docs.livekit.io/agents/build/events/).
 *
 * - `'initializing'`: the session is starting; it reads so until `startSession()` has wired it.
 * - `'idle'`: input is turned off, so the agent hears nothing. `VoicePipelineOrchestrator` never reports it; a host
 *   API that can turn a session's input off does.
 * - `'listening'`: the agent waits for the user's turn.
 * - `'thinking'`: the user's turn has completed and the agent's reply has no word yet, or, under a call profile, a
 *   prompt `pushToTTS()` speaks has no word yet.
 * - `'speaking'`: the reply or the prompt has its first word, until its audio has played out or a barge-in cuts it.
 */
export type VoiceAgentState = 'initializing' | 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * What the user is doing, as `user_state_changed` reports it.
 *
 * - `'listening'`: the user is not speaking.
 * - `'speaking'`: between a start of the user's speech and its end: the STT session's `speech_start` and
 *   `speech_end`, a client's transcript lines from the first to open until the last closes, or, under a call profile,
 *   from `minSpeechMs` of successive VAD speech until a frame of silence.
 * - `'away'`: the user and the agent have both been listening for `VoicePipelineConfig.userAwayTimeoutMs`; only with
 *   that option set. The user's next speech makes the user `'speaking'`.
 */
export type VoiceUserState = 'listening' | 'speaking' | 'away';

/**
 * The part of a session a `session_error` came from: its STT, TTS, agent, transport, VAD or endpoint detector, or the
 * session itself (a listener that threw, speech from a second source, a barge-in handler that failed, a host prompt's
 * stream of text that failed, work the session runs across its parts).
 */
export type VoiceSessionErrorSource = 'stt' | 'tts' | 'agent' | 'transport' | 'vad' | 'endpoint' | 'session';

/** One item of the conversation, in the order the session added it (`conversation_item_added`). */
export type VoiceConversationItem =
  | {
      /** A user's turn. */
      role: 'user';
      /** The turn's transcript, as the agent receives it. */
      text: string;
      /** The language of the turn's last final transcript, when its transcriber reported one. */
      language?: string;
      /**
       * Where the turn came from: the session's STT (`'speech'`), a client's transcript messages (`'client'`), or a
       * typed message (`'text'`).
       */
      source: 'speech' | 'client' | 'text';
      /** Why the endpoint detector ended the turn, for a turn it ended. */
      endpointReason?: EndpointReason;
    }
  | {
      /** An agent's reply. */
      role: 'assistant';
      /** The reply's text, as the agent produced it. */
      text: string;
      /**
       * The part of `text` the session knows was heard: all of it for a reply whose audio played out, and, for a reply
       * a barge-in cut, the prefix the transport has acknowledged as played, which is empty while no transport reports
       * which text it played. A partly played reply's heard extent is then unknown, and `text` is not cut to a guess;
       * so is that of a reply whose transport's playout wait (`IStreamTransport.waitForPlayout()`) rejected.
       */
      playedText: string;
      /**
       * Whether a barge-in or another interruption cut the reply, or its audio did not play out: the transport's playout
       * wait rejected, as a stalled LiveKit track's does once it has discarded what it had not played.
       */
      interrupted: boolean;
    };

/**
 * The events of a {@link VoicePipelineSession}, by name, each with the payload its listeners get. Both runtimes of
 * `VoicePipelineOrchestrator` emit the same map, the names after LiveKit Agents' `AgentSession` events where LiveKit
 * has one (https://docs.livekit.io/agents/build/events/). A listener that throws is reported, and the listeners after
 * it still run.
 */
export interface VoiceSessionEventMap {
  /** The agent's state changed; LiveKit Agents' `agent_state_changed`. */
  agent_state_changed: {
    /** The state before. */
    oldState: VoiceAgentState;
    /** The state now. */
    newState: VoiceAgentState;
    /** When it changed, in milliseconds since the epoch. */
    createdAt: number;
  };
  /** The user's state changed; LiveKit Agents' `user_state_changed`. */
  user_state_changed: {
    /** The state before. */
    oldState: VoiceUserState;
    /** The state now. */
    newState: VoiceUserState;
    /** When it changed, in milliseconds since the epoch. */
    createdAt: number;
  };
  /** A transcript of the user's speech, interim or final, with words; LiveKit Agents' `user_input_transcribed`. */
  user_input_transcribed: {
    /** The transcript's text. */
    transcript: string;
    /** Whether the transcript is final. */
    isFinal: boolean;
    /** The transcriber's confidence in the transcript, in [0, 1], when it reported one. */
    confidence?: number;
    /** The transcript's language, when the transcriber reported one. */
    language?: string;
    /** The speaker, when every word of the transcript that names one names the same speaker. */
    speakerId?: string;
    /** The transcriber's or the client's key for the utterance, when it has one. */
    itemId?: string;
    /** When it arrived, in milliseconds since the epoch. */
    createdAt: number;
  };
  /** A user turn or an agent reply joined the conversation; LiveKit Agents' `conversation_item_added`. */
  conversation_item_added: {
    /** The item. */
    item: VoiceConversationItem;
    /** When it was added, in milliseconds since the epoch. */
    createdAt: number;
  };
  /** A reply or a host prompt began to speak: its first word; LiveKit Agents' `speech_created`. */
  speech_created: {
    /**
     * `'reply'` for the agent's answer to a turn, `'say'` for a prompt the host speaks through `pushToTTS()`: under a
     * call profile each one, which it speaks as a reply of its own, and without one a prompt pushed while a reply is
     * speaking, whose audio goes out with the reply's.
     */
    source: 'reply' | 'say';
    /** Whether the host asked for the speech (`true` for a prompt) rather than the session (`false` for a reply). */
    userInitiated: boolean;
    /** When it began, in milliseconds since the epoch. */
    createdAt: number;
  };
  /**
   * The user's speech acted on the reply: a `'pause'` held it, a `'resume'` let it go on after a false interruption,
   * a `'cancel'` cut it. Each matches the `barge_in` message the transport is sent; under a call profile, speech that
   * interrupts the agent is a `'cancel'`.
   */
  barge_in: {
    /** The user's speech over the reply so far, in milliseconds. */
    speechDurationMs: number;
    /** The reply's text so far. */
    interruptedText: string;
    /** The duration of the reply's audio sent so far (acknowledged as played, under a call profile), in milliseconds. */
    playedDurationMs: number;
    /** What the speech did to the reply. */
    action: BargeinAction['type'];
    /** When it happened, in milliseconds since the epoch. */
    createdAt: number;
  };
  /**
   * The session ended on a failure: the content-free `Error('voice pipeline failed')`, or `Error('voice call failed
   * (<code>)')` under a call profile, which never carries a part's own text. Existing payload and `errorMonitor`
   * semantics remain unchanged: the `errorMonitor` listeners get the same object first.
   */
  error: Error;
  /**
   * A failure, with where it came from and whether the session goes on: the `Error` that `error` delivers for a failure
   * that ends the session (`recoverable: false`, before `close`), or the one the orchestrator's `error` reports for one
   * that does not, such as a transport send that rejected (`recoverable: true`).
   */
  session_error: {
    /** The failure. */
    error: Error;
    /** `true` when the session goes on. */
    recoverable: boolean;
    /** The part it came from. */
    source: VoiceSessionErrorSource;
    /** When it happened, in milliseconds since the epoch. */
    createdAt: number;
  };
  /** The session closed; LiveKit Agents' `close`. */
  close: {
    /** Why: the reason given to the stop, `'transport_closed'` when the transport closed, or `'closed'`. */
    reason: string;
    /** The failure the session ended on, when it ended on one: the `Error` of `error`. */
    error?: Error;
    /** When it closed, in milliseconds since the epoch. */
    createdAt: number;
  };
  /** @deprecated Read agent_state_changed. Emitted beside it until the next minor. */
  state_change: PipelineState;
  /** @deprecated Read conversation_item_added (a user item). Emitted beside it until the next minor. */
  turn_complete: TurnCompleteEvent;
}

/** One `true` per event of {@link VoiceSessionEventMap}, so the compiler checks the list below names each once. */
const SESSION_EVENT_KEYS: Readonly<Record<keyof VoiceSessionEventMap, true>> = {
  agent_state_changed: true,
  user_state_changed: true,
  user_input_transcribed: true,
  conversation_item_added: true,
  speech_created: true,
  barge_in: true,
  error: true,
  session_error: true,
  close: true,
  state_change: true,
  turn_complete: true,
};

/**
 * Every key of {@link VoiceSessionEventMap}, in the map's order, for hosts that relay a session's events and for
 * the documentation's events table.
 *
 * @example
 * ```typescript
 * for (const name of VOICE_SESSION_EVENT_NAMES) session.on(name, (payload: unknown) => relay(name, payload));
 * ```
 */
export const VOICE_SESSION_EVENT_NAMES: readonly (keyof VoiceSessionEventMap)[] = Object.freeze(
  Object.keys(SESSION_EVENT_KEYS) as (keyof VoiceSessionEventMap)[]
);

// ============================================================================
// Section 10 -- Wire protocol: client -> server messages
// ============================================================================

/**
 * A transcript the client made itself, sent in place of audio by a client
 * that transcribes on its own device (for example with `MoonshineBrowserSTT`
 * in a browser). It carries the {@link TranscriptEvent} fields a display and
 * an endpoint detector read; every interim and the final of one line carry
 * the same `itemId`, and the final comes once, when the line is complete.
 * `toClientTranscriptMessage()` makes one from a `TranscriptEvent`;
 * `isClientTranscriptMessage()` checks one a server received, and
 * `transcriptEventFromClient()` turns it back into a `TranscriptEvent`.
 * `VoicePipelineOrchestrator` takes a session's speech from the first source
 * it receives: a session that received audio first drops these messages, and
 * one that received a message first drops the audio.
 *
 * @example
 * ```typescript
 * sttSession.on('transcript', (event: TranscriptEvent) => {
 *   socket.send(JSON.stringify(toClientTranscriptMessage(event)));
 * });
 * ```
 */
export interface ClientTranscriptMessage {
  /** Discriminator of the client message. */
  type: 'transcript';
  /** The line's text so far (interim), or its whole text (final); at most 4,000 characters. */
  text: string;
  /** Identifier of the line, at most 128 characters; every interim and the final of one line carry the same one. */
  itemId: string;
  /** `true` once the line is complete and will not be revised. */
  isFinal: boolean;
  /** Aggregate confidence of `text` in [0, 1]; read as 1 when absent. */
  confidence?: number;
  /**
   * Start of the line's audio, in milliseconds counted from the first frame
   * the client transcribed in this session.
   */
  startMs?: number;
  /** End of the line's audio, on the same clock as `startMs`. */
  endMs?: number;
  /** Language of `text` (for example `'en'`), at most 64 characters. */
  language?: string;
}

/**
 * Messages sent from the client (browser/app) to the server over the transport.
 * All messages are JSON-serialised.
 * A client that transcribes on its own device sends
 * {@link ClientTranscriptMessage}s in place of audio.
 *
 * @see {@link ServerTextMessage} for the server-to-client counterpart.
 *
 * @example
 * ```typescript
 * const configMsg: ClientTextMessage = {
 *   type: 'config',
 *   config: { stt: 'deepgram', tts: 'openai' },
 * };
 * ```
 */
export type ClientTextMessage =
  | {
      /**
       * Initial configuration sent once after the WebSocket connection is established.
       * The server responds with `session_started` after applying the config.
       */
      type: 'config';
      /** Pipeline configuration requested by the client. */
      config: VoicePipelineConfig;
    }
  | {
      /**
       * Runtime control commands sent during an active session.
       */
      type: 'control';
      /** The control action to perform. */
      action: TransportControlMessage;
    }
  | ClientTranscriptMessage;

// ============================================================================
// Section 11 -- Wire protocol: server -> client messages
// ============================================================================

/**
 * Messages sent from the server to the client over the transport.
 * All messages are JSON-serialised.
 *
 * @see {@link ClientTextMessage} for the client-to-server counterpart.
 * See `IStreamTransport.sendControl()` for the transport method that sends these messages.
 *
 * @example
 * ```typescript
 * const sessionStarted: ServerTextMessage = {
 *   type: 'session_started',
 *   sessionId: 'abc-123',
 *   config: { stt: 'deepgram', tts: 'openai' },
 * };
 * ```
 */
export type ServerTextMessage =
  | {
      /**
       * Sent once, when the session has opened and is ready to receive audio.
       * `VoicePipelineOrchestrator` sends it as `startSession()` completes, on a
       * session without a call profile.
       */
      type: 'session_started';
      /** The server-assigned session ID: the session's `sessionId`. */
      sessionId: string;
      /**
       * The effective configuration (may differ from the client's request).
       * `VoicePipelineOrchestrator` sends the fields `VoicePipelineConfig`
       * declares, less `sttOptions` and `ttsOptions`, the provider options,
       * which can hold what a host keeps from its client.
       */
      config: VoicePipelineConfig;
    }
  | {
      /**
       * Emitted for each STT hypothesis (interim and final).
       * Clients may display these in real time for visual feedback.
       */
      type: 'transcript';
      /** Transcript text for this event. */
      text: string;
      /** Whether this hypothesis is final. */
      isFinal: boolean;
      /** Aggregate confidence score [0, 1]. */
      confidence: number;
    }
  | {
      /**
       * Emitted when the agent has received the transcript and begun generating a reply.
       * Clients may show a thinking indicator.
       */
      type: 'agent_thinking';
    }
  | {
      /**
       * Emitted when TTS synthesis begins -- audio chunks will follow over the audio channel.
       * Clients may hide thinking indicators and prepare audio playback.
       */
      type: 'agent_speaking';
      /**
       * Speculative text of the agent's response accumulated so far. May be partial
       * if the TTS is streaming token-by-token.
       */
      text: string;
    }
  | {
      /**
       * Emitted when the agent's complete response has been synthesised and sent.
       */
      type: 'agent_done';
      /** Full text of the completed response. */
      text: string;
      /** Duration of the synthesised audio in milliseconds. */
      durationMs: number;
    }
  | {
      /**
       * Emitted when the pipeline detects that the user has started speaking
       * over the current TTS output (barge-in).
       */
      type: 'barge_in';
      /** The action the pipeline is taking in response. */
      action: BargeinAction;
    }
  | {
      /**
       * Emitted when an unrecoverable error occurs in the pipeline.
       * The session will be closed after this message.
       */
      type: 'error';
      /** Machine-readable error code (e.g. `'STT_PROVIDER_ERROR'`). */
      code: string;
      /** Human-readable description of the error. */
      message: string;
    }
  | {
      /**
       * Emitted as the final message before the server closes the transport.
       * `VoicePipelineOrchestrator` sends it as a stop closes a transport that
       * is still open, on a session without a call profile.
       */
      type: 'session_ended';
      /** Optional human-readable reason for the session ending: the reason the stop was given. */
      reason?: string;
    };

// ============================================================================
// Section 12 -- Listening: transcript turns and where they go
// ============================================================================

/** A transcript turn a listen session wrote. `turnId` is `<runId>:<seq>`, assigned by the sink in arrival order. */
export interface TranscriptTurn {
  /** The run the turn belongs to. */
  runId: string;
  /** The turn's number in its run, in arrival order. */
  seq: number;
  /** The turn's stable id, `<runId>:<seq>`. */
  turnId: string;
  /** Wall-clock milliseconds when the turn was written. */
  at: number;
  /** The turn's transcribed text. */
  text: string;
  /** Who spoke, when the session can tell. */
  speaker?: string;
  /** Where the turn starts on the session's audio clock, when the transcriber gave one. */
  startMs?: number;
  /** Where the turn ends on the same clock, when the transcriber gave one. */
  endMs?: number;
}

/** An unnumbered final; the sink allocates its run's next sequence. */
export type TranscriptInput = Omit<TranscriptTurn, 'seq' | 'turnId'>;

/** Where already numbered turns go; retained for callers that supply their own ids. */
export interface ITranscriptSink {
  /** Writes one numbered turn, resolving when persistence completes. */
  append(turn: TranscriptTurn): Promise<void>;
}

/** A listen session's sink. Turn ids are assigned by the sink in arrival order across sessions of one run. */
export interface ITranscriptInputSink extends ITranscriptSink {
  /**
   * Allocates the run's next sequence and writes the final. A slow sink pauses
   * the transport; a thrown error ends the session with sink_failed.
   * @returns The stored turn, or undefined when a fence or terminal run drops it.
   */
  appendNext(turn: TranscriptInput): Promise<TranscriptTurn | undefined>;
}

// ============================================================================
// Section 13 -- Scoped call runtime seams
// ============================================================================

/** Independent worker, inference and physical-transport fences. */
export interface VoiceGeneration {
  /** Advances only when a fenced worker replaces the previous one. */
  workerGeneration: number;
  /** Advances on each interruption, so output of an earlier inference cannot play. */
  inferenceGeneration: number;
  /** Advances on each reattachment of a physical transport. */
  transportEpoch: number;
}

/** Stable recognition identity captured at admission, never assigned to a delayed completion. */
export interface AudioIdentity {
  /** The scope the audio belongs to. */
  scopeId: string;
  /** The call the audio belongs to. */
  callId: string;
  /** The recognition turn the audio belongs to. */
  turnId: string;
  /** The fences in force when the audio was admitted. */
  generation: Readonly<VoiceGeneration>;
}

/** One normalized mono frame; sequence increases for the lifetime of the call, across resets. */
export interface ScopedAudioFrame extends AudioFrame, AudioIdentity {
  /** Always 16 kHz. */
  sampleRate: 16000;
  /** Always mono. */
  channels: 1;
  /** The frame's position in the call's input, starting at 1. */
  sequence: number;
  /** The fences in force when the frame was admitted. */
  generation: VoiceGeneration;
}

/** One classified frame, with duration measured from samples rather than wall-clock silence. */
export interface VadFrameEvent extends VadEvent, AudioIdentity {
  /** Always a voice activity model, never a recognizer's inference. */
  source: 'vad';
  /** The sequence of the classified frame. */
  sequence: number;
  /** Duration of the classified audio, from its sample count. */
  durationMs: number;
  /** Whether the frame was classified as speech. */
  speech: boolean;
}

/** Scoped recognition result. The producer preserves the input turn and generation. */
export interface ScopedTranscriptEvent extends TranscriptEvent, AudioIdentity {}

/** Scoped endpoint result. The producer preserves the input turn and generation. */
export interface ScopedTurnCompleteEvent extends TurnCompleteEvent, AudioIdentity {}

/** Content-free loss record. Resets never convert a missing interval into silence or billable speech. */
export interface AudioGapEvent extends AudioIdentity {
  /** A full queue, the transport, the provider, or an out-of-order or skipped sequence. */
  reason: 'overflow' | 'transport' | 'provider' | 'sequence';
  /** Lost audio in milliseconds, including queued audio the gap discarded. */
  lostMs: number;
  /** The last sequence admitted before the gap. */
  afterSequence: number;
}

/** Factory-owned VAD. Emits vad(VadFrameEvent), error(Error); reset fences all prior asynchronous work. */
export interface IVadSession extends EventEmitterLike {
  /** Classifies one frame; resolves once the frame is admitted. The samples are read-only. */
  pushAudio(frame: ScopedAudioFrame): Promise<void>;
  /** Discards retained audio and pending work, and labels later events with `identity`. */
  reset(identity: AudioIdentity): Promise<void>;
  /** Classifies retained audio and emits its events. */
  flush(): Promise<void>;
  /** Releases the session; it accepts no audio afterwards. */
  dispose(): Promise<void>;
}

/** Audio-aware endpointing. Emits turn_complete(ScopedTurnCompleteEvent), error(Error). */
export interface IAudioEndpointDetector extends EventEmitterLike {
  /** Detection strategy, as {@link IEndpointDetector.mode}. */
  readonly mode: 'acoustic' | 'heuristic' | 'semantic';
  /** Retains one frame for the detector's window; resolves once admitted. The samples are read-only. */
  pushAudio(frame: ScopedAudioFrame): Promise<void>;
  /** Consumes one classified frame, which may ask the detector to evaluate its window. */
  pushVadEvent(event: VadFrameEvent): Promise<void>;
  /** Consumes one scoped recognition result. */
  pushTranscript(event: ScopedTranscriptEvent): Promise<void>;
  /** Discards the window and pending work, and labels later results with `identity`. */
  reset(identity: AudioIdentity): Promise<void>;
  /** Releases the detector; it emits nothing afterwards. */
  dispose(): Promise<void>;
}

/** Call-profile STT explicitly binds asynchronous results to their admitted input identity. */
export interface ScopedStreamingSTTSession extends StreamingSTTSession {
  /** Admits one frame for recognition; resolves once it is admitted. Transcripts of it carry the frame's identity. The samples are read-only. */
  pushAudioScoped(frame: ScopedAudioFrame): Promise<void>;
  /** Resets recognition without replay; late results retain their old identity. */
  reset(identity: AudioIdentity): Promise<void>;
}

/** Playback acknowledged by a transport, not merely queued or sent to a socket. */
export interface PlaybackReceipt {
  /** The fences of the played chunk. */
  generation: VoiceGeneration;
  /** The played chunk's sequence within its inference generation. */
  sequence: number;
  /** Samples of the chunk that played. */
  playedSamples: number;
  /** Rate of `playedSamples`, in Hz. */
  sampleRate: number;
}

/** Speaking transports implement these methods in addition to IStreamTransport. */
export interface IPlaybackTransport extends IStreamTransport {
  /** Resolves only when this chunk has played. Abort rejects the wait; clearPlayback discards physical queued data. */
  waitForPlayback(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt>;
  /** Resolves after the publisher has discarded this generation's pending audio. */
  clearPlayback(generation: VoiceGeneration): Promise<void>;
  /** Optional physical setup barrier; completes before a call is considered connected. */
  readyForPlayback?(): Promise<void>;
}

/** Cumulative supplier work for one synthesis request, including cancelled work. */
export interface StreamingTTSUsageEvent extends AudioIdentity {
  /** Provider that synthesized (its `IStreamingTTS.providerId`). */
  providerId: string;
  /** The synthesis request the report counts. */
  requestId: string;
  /** Characters the provider accepted so far. */
  acceptedCharacters: number;
  /** Samples the provider generated so far, played or not. */
  generatedSamples: number;
  /** Rate of `generatedSamples`, in Hz. */
  sampleRate: number;
  /** The request's state at this report. */
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  /** `true` on the request's last report. */
  final: boolean;
}

/**
 * Compares all fences; the caller separately checks scope and call.
 *
 * @param a - One generation.
 * @param b - The other generation.
 * @returns `true` when the worker generation, inference generation and transport epoch are all equal.
 */
export function sameVoiceGeneration(a: Readonly<VoiceGeneration>, b: Readonly<VoiceGeneration>): boolean {
  return a.workerGeneration === b.workerGeneration && a.inferenceGeneration === b.inferenceGeneration && a.transportEpoch === b.transportEpoch;
}

/**
 * Copies and validates a fence so a host cannot mutate an active request's identity.
 *
 * @param value - The identity to copy.
 * @returns A frozen copy, with a frozen copy of its generation.
 * @throws {Error} When an id is empty, longer than 128 characters or not a string, or a fence is not a positive safe integer.
 */
export function copyAudioIdentity(value: AudioIdentity): AudioIdentity {
  if (![value.scopeId, value.callId, value.turnId].every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128)) throw new Error('invalid audio identity');
  const g = value.generation;
  if (![g.workerGeneration, g.inferenceGeneration, g.transportEpoch].every((x) => Number.isSafeInteger(x) && x > 0)) throw new Error('invalid audio generation');
  return Object.freeze({ scopeId: value.scopeId, callId: value.callId, turnId: value.turnId, generation: Object.freeze({ ...g }) });
}
