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

import type { EventEmitter } from 'node:events';

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
export interface IStreamTransport extends EventEmitter {
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
}

/**
 * An active streaming speech-to-text session. Audio frames are pushed in
 * and transcript events flow out via EventEmitter.
 *
 * ## Events emitted
 *
 * | Event          | Payload               | Description                        |
 * |----------------|-----------------------|------------------------------------|
 * | `'transcript'` | {@link TranscriptEvent} | Interim or final hypothesis.     |
 * | `'error'`      | `Error`               | Unrecoverable provider error.      |
 * | `'close'`      | *(none)*              | Session has been fully terminated. |
 *
 * See `IStreamingSTT.startSession()` for the factory method that creates these sessions.
 */
export interface StreamingSTTSession extends EventEmitter {
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
 *
 * @see {@link HeuristicEndpointDetector} for the rule-based implementation.
 * @see {@link AcousticEndpointDetector} for the purely acoustic implementation.
 */
export interface IEndpointDetector extends EventEmitter {
  /**
   * Active detection strategy:
   * - `'acoustic'` -- pure silence-timeout based (no transcript analysis).
   * - `'heuristic'` -- silence + terminal punctuation + backchannel filtering.
   * - `'semantic'` -- small LM scoring utterance completeness.
   */
  readonly mode: 'acoustic' | 'heuristic' | 'semantic';

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
   * the detector instance. Called at the start of each new turn.
   */
  reset(): void;
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
export interface DiarizationSession extends EventEmitter {
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
export interface StreamingTTSSession extends EventEmitter {
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
   * Duration of detected user speech before the barge-in was confirmed, in ms.
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
   * How many milliseconds of audio had been played at the point of interruption.
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
      /** Fade out TTS audio over `fadeMs` milliseconds then pause. */
      type: 'pause';
      /** Duration of the fade-out in milliseconds. @defaultValue 150 */
      fadeMs?: number;
    }
  | {
      /**
       * Resume TTS playback from where it was paused (only valid after a prior
       * `'pause'` action).
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
   * Called by the pipeline when a barge-in is confirmed. The handler evaluates
   * the context and returns the action the pipeline should execute.
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
 * | Event                    | Payload                   | Description                             |
 * |--------------------------|---------------------------|-----------------------------------------|
 * | `'state_change'`         | {@link PipelineState}     | Pipeline state machine transition.      |
 * | `'turn_complete'`        | {@link TurnCompleteEvent} | User turn detected.                     |
 * | `'agent_response_start'` | *(none)*                  | Agent has begun generating a response.  |
 * | `'agent_response_end'`   | *(none)*                  | Agent response fully played.            |
 * | `'barge_in'`             | {@link BargeinContext}     | User interrupted TTS playback.          |
 * | `'error'`                | `Error`                   | Unrecoverable pipeline error.           |
 * | `'close'`                | *(none)*                  | Session has been fully torn down.       |
 *
 * See `VoicePipelineOrchestrator.startSession()` for the factory method that creates these sessions.
 */
export interface VoicePipelineSession extends EventEmitter {
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
// Section 10 -- Wire protocol: client -> server messages
// ============================================================================

/**
 * Messages sent from the client (browser/app) to the server over the transport.
 * All messages are JSON-serialised.
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
    };

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
       * Sent once after the server has applied the client's `config` message
       * and is ready to receive audio.
       */
      type: 'session_started';
      /** The server-assigned session ID. */
      sessionId: string;
      /** Echo of the effective configuration (may differ from client request). */
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
       */
      type: 'session_ended';
      /** Optional human-readable reason for the session ending. */
      reason?: string;
    };
