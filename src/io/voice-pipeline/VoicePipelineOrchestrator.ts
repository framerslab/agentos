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
 * SPEAKING --> TTS flush_complete -----> LISTENING (once played out, on a transport that reports it)
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
 * - Event wiring is done once during `startSession()` and never rewired. The
 *   endpoint detector is the host's, which can hand it to one session after
 *   another: a stop removes the listeners the session added to it.
 * - Without a call profile, a client that transcribes on its own device sends
 *   `transcript` messages ({@link ClientTranscriptMessage}) in place of audio;
 *   they reach the endpoint detector as the STT session's transcripts do, each
 *   final joined with the turn's earlier ones (a backchannel the detector
 *   would drop reaches it on its own), the client's lines standing in for its
 *   speech events (`_wireClientTranscripts`). A session takes its
 *   speech from the first source it receives, audio or transcript messages,
 *   and drops what arrives from the other, reporting the first drop as
 *   `'error'` (`_takesSpeechFrom`). A call profile ends the call on a
 *   transcript message, as on any client message but its controls.
 * - A transport that plays one audio format alone (`IStreamTransport.playbackFormat`, `'pcm'` for
 *   `LiveKitStreamTransport` with a publisher) gets it: the TTS session is asked for that format, and a chunk in
 *   another one is reported once, naming the TTS provider, and not sent.
 * - A watchdog timer prevents a session without a call profile from staying in
 *   LISTENING forever if the user walks away (default 30 s). The watchdog
 *   resets after each completed turn.
 * - An endpoint detector that takes `setAgentContext()` hears whether the
 *   agent holds the floor: not as the session starts, from the moment each
 *   user turn completes, and not again once the reply ends or a barge-in
 *   cuts it. From the session's first utterance, `HeuristicEndpointDetector`
 *   drops a backchannel such as "uh huh" or "Sure." only while the agent
 *   holds the floor, takes every final said while the agent listens as the
 *   user's, a lone "okay" included, and never takes a final that ends with
 *   `?` for a backchannel.
 * - Without a call profile, speech that starts while the agent speaks
 *   interrupts the reply until the floor is decided (`Interruption`). It is
 *   measured from its start: the barge-in handler is asked with
 *   `speechDurationMs: 0`, then every `BARGEIN_ASK_INTERVAL_MS` (100 ms)
 *   while the speech lasts, on each of its transcripts and at its end, each
 *   time with the speech so far, until it answers `cancel` or the floor is
 *   decided. A `pause` holds the reply's audio while the TTS session goes on.
 *   When the speech ends, a final with words cuts the reply; an empty final,
 *   a backchannel or no final within `falseInterruptionMs` is a false
 *   interruption, and the reply resumes: a `resume` control, then the audio
 *   the pause held. A reply that resumed before the speech's final came goes
 *   on listening for it until the reply ends: a final with words that comes
 *   then still cuts the reply. The endpoint detector hears the speech once
 *   the floor is decided, so the speech that cuts a reply is the user's turn.
 * - Without a call profile, a reply ends once its TTS session has reported
 *   `flush_complete` and the audio it was sent has played out
 *   (`_finishReply`): on a transport that reports its playout
 *   (`IStreamTransport.waitForPlayout()`, as a speaking
 *   `LiveKitStreamTransport` does), when that says so, and on any other one
 *   when the audio's own duration has passed, each chunk counted from when it
 *   was sent at the earliest (`VoicePipelineConfig.maxPlayoutWaitMs`). Until
 *   then the pipeline stays `speaking`, so speech over the rest of the reply
 *   interrupts it, and `agent_done` waits.
 * - Both runtimes emit the session events of `VoiceSessionEventMap` on the
 *   session `startSession()` returns, and the orchestrator emits them too,
 *   but `error` and `state_change` (`SessionEvents`): each through
 *   `emitEach()`, so a listener that throws is reported and the listeners
 *   after it still run. Without a call profile the session sends its client
 *   `session_started` as it opens and `session_ended` as a stop closes a
 *   transport that is still open.
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
  type BargeinAction,
  type ClientTextMessage,
  type ClientTranscriptMessage,
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
  type TranscriptWord,
  type ScopedTranscriptEvent,
  type TurnCompleteEvent,
  type ScopedTurnCompleteEvent,
  type VadEvent,
  type VadFrameEvent,
  type StreamingTTSUsageEvent,
  type VoiceAgentState,
  type VoiceGeneration,
  type VoicePipelineConfig,
  type VoicePipelineSession,
  type VoiceSessionErrorSource,
  type VoiceSessionEventMap,
  type VoiceTurnMetadata,
  type VoiceUserState,
  type ServerTextMessage,
} from './types.js';
import { isClientTranscriptMessage, transcriptEventFromClient } from './clientTranscript.js';
import { describeReason, isError } from './describeReason.js';
import type { VoiceEventListener } from './VoiceEventEmitter.js';

/**
 * How long a client's open transcript line lasts with no message before it is
 * closed as by an empty final (`_wireClientTranscripts`), so a line whose final
 * never comes holds no speech open.
 */
const CLIENT_LINE_TIMEOUT_MS = 5_000;

/** The most transcript lines a client holds open; one more makes the oldest give way. */
const CLIENT_MAX_OPEN_LINES = 8;

/** The most text a turn of a client's joined finals reaches the endpoint detector with. */
const CLIENT_TURN_MAX_TEXT = 16_000;

/**
 * How often the barge-in handler is asked again while the user speaks over the reply, in milliseconds, so that a
 * handler deciding by `speechDurationMs`, as the stock handlers do, acts within this of its threshold.
 */
const BARGEIN_ASK_INTERVAL_MS = 100;

/**
 * How long a reply paused by barge-in waits, after the speech that paused it ends, for that speech's final before it
 * resumes, by default (`VoicePipelineConfig.falseInterruptionMs`).
 */
const DEFAULT_FALSE_INTERRUPTION_MS = 1_500;

/**
 * The longest a reply stays `speaking` after its synthesis completes on a transport that cannot report its playout,
 * by default (`VoicePipelineConfig.maxPlayoutWaitMs`).
 */
const DEFAULT_MAX_PLAYOUT_WAIT_MS = 30_000;

/** The longest delay `setTimeout()` keeps; a longer one would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A failure of one part of a session, naming the part for `session_error`. It carries no text of the failure it
 * stands for, which can hold what was said; the session reports it content-free.
 */
class PartFailure extends Error {
  constructor(readonly source: VoiceSessionErrorSource) {
    super('voice pipeline part failed');
  }
}

/**
 * Runs `work`; a throw becomes a {@link PartFailure} of `source`, unless it is one already, which names its own part.
 *
 * @param source - The part `work` runs.
 * @param work - What to run.
 * @returns What `work` returns.
 */
function inPart<T>(source: VoiceSessionErrorSource, work: () => T): T {
  try {
    return work();
  } catch (err) {
    throw err instanceof PartFailure ? err : new PartFailure(source);
  }
}

/**
 * Awaits `work`; a throw or a rejection becomes a {@link PartFailure} of `source`, unless it is one already, which
 * names its own part: a TTS session that hands on its sink's transport failure reports the transport.
 *
 * @param source - The part `work` runs.
 * @param work - What to run.
 * @returns What `work` resolves with.
 */
async function inPartAsync<T>(source: VoiceSessionErrorSource, work: () => T | PromiseLike<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw err instanceof PartFailure ? err : new PartFailure(source);
  }
}

/**
 * Yields what `iterable` yields; a throw or a rejection of the iterable's own becomes a {@link PartFailure} of
 * `source`, unless it is one already. A throw or a `break` in the loop that consumes it closes it, and the iterable
 * with it, as a `for await` over the iterable itself would.
 *
 * @param source - The part the iterable comes from.
 * @param iterable - The values, such as an agent's reply tokens.
 * @returns The same values.
 */
async function* fromPart<T>(source: VoiceSessionErrorSource, iterable: AsyncIterable<T>): AsyncGenerator<T> {
  try {
    for await (const value of iterable) yield value;
  } catch (err) {
    throw err instanceof PartFailure ? err : new PartFailure(source);
  }
}

/**
 * Awaits a playback queue's `enqueue()` or `drain()`. A rejection the transport caused, a refused send or a playback
 * acknowledgement that failed or did not match, becomes a {@link PartFailure} of `'transport'`; any other, such as a
 * chunk the queue refused before it reached the transport, is handed on as it came, for the TTS session to report.
 *
 * @param queue - The reply's playback queue.
 * @param playing - What `enqueue()` or `drain()` returned.
 */
async function played(queue: PlaybackQueue, playing: Promise<void>): Promise<void> {
  try {
    await playing;
  } catch (err) {
    throw queue.transportFailed ? new PartFailure('transport') : err;
  }
}

/**
 * Hands an event to each of `target`'s listeners for it, in order, as `emit()` would, except that a listener that
 * throws or rejects goes to `report` and the listeners after it still run. `emit()` stops at a throw, which would skip
 * the listeners after it (`waitForUserTurn()`'s among them) and throw into the code that raised the event: an endpoint
 * detector's handler, or a stop that has not yet closed the session's parts. Once `stopped` answers `true`, as it does
 * after a listener has closed the session, the listeners after it get nothing.
 *
 * @param target - The emitter whose listeners get the event.
 * @param event - The event.
 * @param args - What each listener is handed.
 * @param report - Takes a listener's throw or rejection, and what failed.
 * @param stopped - Whether the event is to go no further.
 */
function emitEach(
  target: EventEmitter,
  event: string,
  args: unknown[],
  report: (err: unknown, what: string) => void,
  stopped: () => boolean = () => false
): void {
  for (const listener of target.rawListeners(event)) {
    if (stopped()) return;
    try {
      const result: unknown = (listener as (...values: unknown[]) => unknown).apply(target, args);
      // Promise.resolve() also takes a promise of another realm or library, and leaves any other value alone.
      Promise.resolve(result).catch((err: unknown) => report(err, `a ${event} listener failed`));
    } catch (err) {
      report(err, `a ${event} listener failed`);
    }
  }
}

/**
 * The one speaker a transcript's words name, when every word that names a speaker names the same one.
 *
 * @param words - The transcript's words.
 * @returns The speaker, or `undefined` when no word names one or two words name different ones.
 */
function speakerOf(words: readonly TranscriptWord[] | undefined): string | undefined {
  let speaker: string | undefined;
  for (const word of words ?? []) {
    if (word.speaker === undefined) continue;
    if (speaker !== undefined && word.speaker !== speaker) return undefined;
    speaker = word.speaker;
  }
  return speaker;
}

/** A transcript of the user's speech, from an STT session or a client's line, as `user_input_transcribed` reports it. */
interface HeardTranscript {
  /** The transcript's text. */
  text: string;
  /** Whether it is final. */
  isFinal: boolean;
  /** The transcriber's confidence, when it reported one. */
  confidence?: number;
  /** Its language, when the transcriber reported one. */
  language?: string;
  /** The transcriber's or the client's key for the utterance. */
  itemId?: string;
  /** The one speaker its words name. */
  speakerId?: string;
}

/**
 * The `user_input_transcribed` payload of a transcript: its text and finality, and each of its confidence, language,
 * speaker and key that it has.
 *
 * @param heard - The transcript.
 * @returns The payload.
 */
function transcribedEvent(heard: HeardTranscript): VoiceSessionEventMap['user_input_transcribed'] {
  return {
    transcript: heard.text,
    isFinal: heard.isFinal,
    ...(typeof heard.confidence === 'number' && Number.isFinite(heard.confidence) ? { confidence: heard.confidence } : {}),
    ...(heard.language ? { language: heard.language } : {}),
    ...(heard.speakerId ? { speakerId: heard.speakerId } : {}),
    ...(heard.itemId ? { itemId: heard.itemId } : {}),
    createdAt: Date.now(),
  };
}

/**
 * The configuration a session's `session_started` message carries: the session's own, without the provider options,
 * which can hold what a host keeps from its client.
 *
 * @param config - The session's configuration.
 * @returns A copy without `sttOptions` and `ttsOptions`.
 */
function clientConfig(config: VoicePipelineConfig): VoicePipelineConfig {
  const { sttOptions: _sttOptions, ttsOptions: _ttsOptions, ...rest } = config;
  return rest;
}

/**
 * The session events of one runtime ({@link VoiceSessionEventMap}): the agent's and the user's states, the timer that
 * reports the user `'away'`, and every event handed to the runtime's targets through {@link emitEach}. Once closed it
 * emits nothing more; the runtime emits `close` itself.
 */
class SessionEvents {
  /** What the agent is doing now. */
  agent: VoiceAgentState = 'initializing';
  /** What the user is doing now. */
  user: VoiceUserState = 'listening';
  /** Reports the user `'away'` once the user and the agent have both listened for `awayAfterMs`. */
  private away?: ReturnType<typeof setTimeout>;
  private closed = false;

  /**
   * @param targets - The emitters each event goes to, in order: the orchestrator, then the session (under a call
   *   profile, the call's own).
   * @param report - Takes a listener's throw or rejection, what failed, and the event it was handed.
   * @param awayAfterMs - `VoicePipelineConfig.userAwayTimeoutMs`; undefined, the user is never away.
   */
  constructor(
    private readonly targets: () => readonly EventEmitter[],
    private readonly report: (err: unknown, what: string, event: string) => void,
    private readonly awayAfterMs: number | undefined
  ) {}

  /**
   * Whether the session has closed: no event goes out from then on. A runtime that hands an event to listeners itself,
   * as each does the deprecated `state_change`, stops there too.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Hands an event to every target's listeners, unless the session has closed. A listener that closes the session
   * ends the event there: no listener after it, of that target or the next, gets it after `close`.
   *
   * @param event - The event.
   * @param payload - Its payload.
   */
  emit<K extends keyof VoiceSessionEventMap>(event: K, payload: VoiceSessionEventMap[K]): void {
    for (const target of this.targets()) {
      if (this.closed) return;
      emitEach(target, event, [payload], (err, what) => this.report(err, what, event), () => this.closed);
    }
  }

  /**
   * Moves the agent to `state`, emitting `agent_state_changed` when it changes.
   *
   * @param state - What the agent does now.
   */
  agentTo(state: VoiceAgentState): void {
    if (this.closed || state === this.agent) return;
    const oldState = this.agent;
    this.agent = state;
    this.emit('agent_state_changed', { oldState, newState: state, createdAt: Date.now() });
    this.watchAway();
  }

  /**
   * Moves the user to `state`, emitting `user_state_changed` when it changes.
   *
   * @param state - What the user does now.
   */
  userTo(state: VoiceUserState): void {
    if (this.closed || state === this.user) return;
    const oldState = this.user;
    this.user = state;
    this.emit('user_state_changed', { oldState, newState: state, createdAt: Date.now() });
    this.watchAway();
  }

  /** Starts the away timer while the user and the agent both listen, and stops it otherwise. */
  private watchAway(): void {
    if (this.closed || this.awayAfterMs === undefined || this.agent !== 'listening' || this.user !== 'listening') {
      clearTimeout(this.away);
      this.away = undefined;
      return;
    }
    this.away ??= setTimeout(() => {
      this.away = undefined;
      this.userTo('away');
    }, Math.min(this.awayAfterMs, MAX_TIMER_MS));
  }

  /** The session has closed: the timer stops and no event is emitted any more. */
  close(): void {
    this.closed = true;
    clearTimeout(this.away);
    this.away = undefined;
  }
}

/** A failure a session ends on whose `session_error` has yet to go out. */
interface FailureEvent {
  /** The failure: the `Error` its `'error'` listeners were handed. */
  error: Error;
  /** The part it came from. */
  source: VoiceSessionErrorSource;
}

/** What the user's speech does, from the STT session's events or a client's transcript lines. */
interface SpeechEdges {
  /** Speech began: a synthetic VAD event, and, while the agent speaks, an interruption of the reply. */
  start(): Promise<void>;
  /** Speech ended: a synthetic VAD event. */
  end(): void;
  /**
   * A transcript of the speech arrived: during an interruption, a final counts toward the decision, and the barge-in
   * handler is asked again.
   */
  heard(text: string, isFinal: boolean): void;
  /**
   * Tells the endpoint detector something of the speech: at once, or, during an interruption, once the floor is
   * decided, in the order it came (`Interruption.told`).
   */
  tell(work: () => void): void;
}

/** What a session without a call profile keeps of the reply being spoken. */
interface ReplyRecord {
  /** Whether a refused chunk of the reply has been reported; the rest of its refusals are not. */
  audioRefusalReported: boolean;
  /**
   * When the audio sent so far will have played, on `Date.now()`'s clock, as a transport that cannot report its
   * playout plays it: each chunk after the one before it, from the moment it was sent at the earliest.
   */
  playsUntil: number;
  /** Whether the reply has its first word, from which the agent speaks (`agent_state_changed`). */
  started: boolean;
  /**
   * Whether a wait for the reply's audio to play out failed (`_finishReply`), as a stalled LiveKit track's does once it
   * has discarded what it had not played: what of the reply was heard is then not known.
   */
  playoutFailed?: boolean;
}

/** The parts of a session without a call profile that its replies and their interruptions act on. */
interface ReplyParts {
  /** The session's transport. */
  transport: IStreamTransport;
  /** The agent whose reply an interruption cuts. */
  agent: IVoicePipelineAgentSession;
  /** The TTS session that speaks the reply. */
  tts: StreamingTTSSession;
  /** The session's endpoint detector. */
  endpoint: IEndpointDetector;
  /** The handler asked about each interruption. */
  bargein: IBargeinHandler;
}

/**
 * The user's speech over the agent's reply, in a session without a call profile: from a speech start while the
 * pipeline is `speaking` until the floor is decided (`_interrupt`). The barge-in handler's `cancel` cuts the reply
 * (`_cutReply`); otherwise the speech's end decides (`_settleInterruption`): speech that never paused the reply ends
 * with the reply going on (`_endInterruption`), and a paused reply is cut by a final with words or resumes
 * (`_resumeReply`). A reply that resumed when no final came within `falseInterruptionMs` keeps the interruption
 * listening for that final until the reply ends (`lingering`): a final with words then cuts the reply.
 */
interface Interruption {
  /** Speech of the segments that have ended, in milliseconds. */
  spokenMs: number;
  /** When the segment being spoken started, on `Date.now()`'s clock, or `null` between segments. */
  segmentAt: number | null;
  /** When the last segment ended, on `Date.now()`'s clock: the wait for a final counts from it. */
  endedAt: number;
  /** How many segments of speech started: a start after an end, before the decision, adds one. */
  segments: number;
  /** How many finals arrived, empty ones included: an ended speech with fewer finals than segments waits for one. */
  finals: number;
  /** Whether a final had words other than a backchannel the endpoint detector recognizes. */
  words: boolean;
  /** Whether the handler answered `pause` during the interruption: a final with words then cuts the reply. */
  paused: boolean;
  /** Whether the reply's audio is held: from a `pause`, which the transport is sent, until the reply resumes. */
  holding: boolean;
  /**
   * Whether the reply resumed when `falseInterruptionMs` passed with a segment's final still to come. The interruption
   * then listens for finals until the reply ends: a final with words cuts the reply. The finals it waited for count as
   * come, so speech that follows is decided on its own finals, and a `pause` holds the reply again only while the user
   * speaks.
   */
  lingering: boolean;
  /** The reply's audio that arrived during the pause, in order. */
  audio: EncodedAudioChunk[];
  /**
   * Whether the reply ended during the pause: its synthesis completed, or, on a transport that reports its playout, the
   * audio it was sent stopped playing. It then ends after the resume, once the audio the pause held has played.
   */
  synthesized: boolean;
  /**
   * What the endpoint detector would have been told of the speech since its first start, in order. It is told once
   * the floor is decided: as the agent holds the floor when the reply goes on, so a backchannel stays out of the
   * conversation, and as the user holds it when the reply is cut, so the speech is the user's turn.
   */
  told: Array<() => void>;
  /** The timer that asks the handler again while a segment lasts. */
  tick?: ReturnType<typeof setTimeout>;
  /** The timer that resumes a paused reply when no final comes within `falseInterruptionMs` of the speech's end. */
  wait?: ReturnType<typeof setTimeout>;
  /** Whether an ask is in flight. */
  asking: boolean;
  /** Whether something asked meanwhile: the handler is asked once more when the ask in flight returns. */
  again: boolean;
}

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
 * | `'close'`              | `{ reason, error?, createdAt }`: the session moved to `closed` |
 * | `'agent_state_changed'`, `'user_state_changed'`, `'user_input_transcribed'`, `'conversation_item_added'`, `'speech_created'`, `'barge_in'`, `'session_error'` | the session's events ({@link VoiceSessionEventMap}), emitted here as on the session, from the moment `startSession()` is called |
 * | `'error'`              | `Error`: a listener of the session's events threw or rejected; a transport send rejected (of a reply's audio, the first refused chunk only); speech came from a second source and was dropped (the session's first drop only); a TTS chunk came in another format than the transport's `playbackFormat` and was dropped (the session's first only, naming the provider); or, as the content-free `Error('voice pipeline failed')`, a part of a session without a profile failed and the session closes. With no `'error'` listener it is written as a console warning instead |
 * | `'cleanup_incomplete'` | *(none)*: the stop that followed such a failure could not close every part |
 * | `'transcript'`, `'gap'`, `'generation'`, `'interrupted'`, `'usage'`, `'failure'`, `'detached'`, `'reattached'` | re-emitted from a call profile's session |
 *
 * @see {@link VoicePipelineSession} for the public session interface returned by `startSession()`.
 */
/** How long a stop waits for the client to have its `session_ended` before the transport closes, in milliseconds. */
const SESSION_ENDED_SEND_MS = 500;

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
  private _currentReply: ReplyRecord = { audioRefusalReported: false, playsUntil: 0, started: false };
  private publicSession?: VoicePipelineSession;
  /** The session events of a session without a call profile; a call profile's runtime has its own. */
  private readonly events: SessionEvents;
  /** Ends the wait of a reply whose synthesis completed for its audio to play out (`_finishReply`). */
  private playoutWait?: AbortController;
  /** The failure a session without a call profile ended on, for its `close` event. */
  private failure?: Error;
  /**
   * The failures whose `session_error` has yet to go out, each with the part it came from, in order
   * (`_sendFailureEvents`): a failure whose `'error'` listener stops the session has its `session_error` before `close`.
   */
  private readonly failureEvents: FailureEvent[] = [];
  /** The language of the current turn's last final transcript, for the user's conversation item. */
  private turnLanguage?: string;
  /**
   * Clears the client's open transcript lines and the timer of each (`_wireClientTranscripts`), so that none fires
   * after a stop; set when a session without a call profile starts.
   */
  private endClientLines?: () => void;
  /**
   * Where the session takes its speech from: the first source it received, its transport's audio or a client's
   * transcript messages (`_takesSpeechFrom`); unset until either arrives.
   */
  private speechSource?: 'audio' | 'client';
  /** Whether the session has reported dropping speech from its other source; it reports that once. */
  private speechSourceDropReported = false;
  /**
   * The listeners this session added to its endpoint detector, each with its event (`_onEndpoint`). The host owns the
   * detector and can hand it to one session after another, so the stop removes exactly these (`_releaseEndpoint`): a
   * closed session's handlers then neither stay reachable from the detector nor count toward its listener limit.
   */
  private readonly endpointListeners: Array<{ event: string; listener: VoiceEventListener }> = [];
  /** The user's speech over the reply being spoken, until the floor is decided (`_interrupt`). */
  private interruption?: Interruption;
  /**
   * How long a paused reply waits, after the speech that paused it ends, for that speech's final
   * (`VoicePipelineConfig.falseInterruptionMs`).
   */
  private readonly falseInterruptionMs: number;
  /**
   * The longest a reply stays `speaking` after its synthesis completes on a transport that cannot report its playout
   * (`VoicePipelineConfig.maxPlayoutWaitMs`).
   */
  private readonly maxPlayoutWaitMs: number;

  /**
   * Create a new orchestrator with the given pipeline configuration.
   *
   * The orchestrator starts in `'idle'` state. Call `startSession()`
   * to wire up components and transition to `'listening'`.
   *
   * @param config - Top-level pipeline configuration specifying providers and options.
   * @throws {RangeError} When `config.falseInterruptionMs` or `config.maxPlayoutWaitMs` is given and is not a finite
   *   number of zero or more, or `config.userAwayTimeoutMs` is given and is not a finite number greater than zero.
   */
  constructor(private readonly config: VoicePipelineConfig) {
    super();
    const falseInterruptionMs = config.falseInterruptionMs ?? DEFAULT_FALSE_INTERRUPTION_MS;
    // NaN or Infinity is no time to wait, and a negative number is no duration; zero waits for no final.
    if (!Number.isFinite(falseInterruptionMs) || falseInterruptionMs < 0) {
      throw new RangeError(
        `VoicePipelineOrchestrator: falseInterruptionMs must be a finite number of zero or more, got ${String(falseInterruptionMs)}`
      );
    }
    this.falseInterruptionMs = falseInterruptionMs;
    const maxPlayoutWaitMs = config.maxPlayoutWaitMs ?? DEFAULT_MAX_PLAYOUT_WAIT_MS;
    // Zero ends a reply as its synthesis completes, as on a transport whose audio has already played.
    if (!Number.isFinite(maxPlayoutWaitMs) || maxPlayoutWaitMs < 0) {
      throw new RangeError(
        `VoicePipelineOrchestrator: maxPlayoutWaitMs must be a finite number of zero or more, got ${String(maxPlayoutWaitMs)}`
      );
    }
    this.maxPlayoutWaitMs = maxPlayoutWaitMs;
    const awayMs = config.userAwayTimeoutMs;
    if (awayMs !== undefined && (!Number.isFinite(awayMs) || awayMs <= 0)) {
      throw new RangeError(
        `VoicePipelineOrchestrator: userAwayTimeoutMs must be a finite number greater than zero, got ${String(awayMs)}`
      );
    }
    this.events = new SessionEvents(
      () => (this.publicSession ? [this, this.publicSession] : [this]),
      (err, what, event) => this._listenerFailed(err, what, event),
      awayMs
    );
  }

  /** Current pipeline state (read-only); a call profile moves through the same states. */
  get state(): PipelineState {
    return this.current;
  }

  /**
   * Moves the pipeline to `to`. Without a call profile the agent's state follows (`agent_state_changed`): listening
   * as the pipeline listens and thinking as it processes a turn; a reply speaks from its first word (the reply's token
   * loop), an interruption keeps the state it came from, and a close is reported as `close`. A listener that moves the
   * pipeline on, as a stop does, ends the change there: the session's `state_change` listeners after it, and the
   * agent's state, hear nothing of a state the pipeline has left.
   *
   * @param to - The new state.
   */
  private stateTo(to: PipelineState): void {
    const from = this.current;
    if (from === to) return;
    this.current = to;
    this.emit('state_changed', { from, to });
    if (this.current !== to) return;
    const session = this.publicSession;
    if (session) {
      emitEach(session, 'state_change', [to], (err, what) => this._listenerFailed(err, what, 'state_change'), () => this.events.isClosed || this.current !== to);
    }
    // A call profile's runtime reports its own agent states, which the orchestrator emits as they come.
    if (this.call || this.current !== to) return;
    if (to === 'listening') this.events.agentTo('listening');
    else if (to === 'processing') this.events.agentTo('thinking');
  }

  /**
   * Ends a session without a profile on a failure of one of its parts. The report is content-free: a provider's or
   * an agent's error can carry what was said, so its text reaches neither a listener nor the console. The session's
   * `errorMonitor` listeners get the `Error` first, whether or not the session has an `'error'` listener, then its
   * `'error'` listeners, then the orchestrator's (`_reportError`); `session_error` carries the same `Error` with the
   * part it came from, before `close`, though one of those listeners stops the session (`_sendFailureEvents`).
   *
   * @param source - The part that failed.
   */
  private reportFailure(source: VoiceSessionErrorSource = 'session'): void {
    if (this.current === 'closed') return;
    const error = new Error('voice pipeline failed');
    this.failure ??= error;
    this.failureEvents.push({ error, source });
    // The session's listeners get it before the orchestrator's, so a host on the session hears it before any stop an
    // orchestrator listener makes. The orchestrator's report writes the console warning when nothing listens there for
    // 'error', so the session's writes none.
    if (this.publicSession) this._reportError(error, 'the session ended on a failure', this.publicSession, false);
    this._reportError(error, 'the session ended on a failure');
    this._sendFailureEvents();
    void this.stopSession('provider_failure').catch(() => {
      this.emit('cleanup_incomplete');
    });
  }

  /**
   * Emits the `session_error` of each failure the session ends on that has not had one yet, in order: as the failure is
   * reported (`reportFailure`), or as a stop closes the session before that, when one of the failure's `'error'`
   * listeners stops it.
   */
  private _sendFailureEvents(): void {
    for (const { error, source } of this.failureEvents.splice(0)) this._sessionError(error, false, source);
  }

  /**
   * Runs one step of the session; a throw or a rejection ends the session through `reportFailure()`.
   *
   * @param work - The step.
   * @param source - The part the step runs, for a failure that does not name its own ({@link PartFailure}).
   */
  private supervise(work: () => unknown, source: VoiceSessionErrorSource = 'session'): void {
    const failed = (err: unknown): void => this.reportFailure(err instanceof PartFailure ? err.source : source);
    try {
      void Promise.resolve(work()).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * An unlistened `'error'` would throw into the emitter: each part's error ends this session instead.
   *
   * @param emitter - The part.
   * @param source - Which part it is.
   */
  private watch(emitter: EventEmitter, source: VoiceSessionErrorSource): void {
    emitter.on('error', () => this.reportFailure(source));
  }

  /**
   * Emits `session_error`: on the session and the orchestrator, or, under a call profile, through the call's runtime.
   *
   * @param error - The failure, the same object `'error'` reports.
   * @param recoverable - `true` when the session goes on.
   * @param source - The part it came from.
   */
  private _sessionError(error: Error, recoverable: boolean, source: VoiceSessionErrorSource): void {
    if (this.call) this.call.sessionError(error, recoverable, source);
    else this.events.emit('session_error', { error, recoverable, source, createdAt: Date.now() });
  }

  /**
   * A listener of one of the session's events threw or rejected: it is reported as `'error'` (`_reportError`) and as a
   * recoverable `session_error`, except that a `session_error` listener's own failure raises no `session_error`.
   *
   * @param err - What the listener threw or rejected with.
   * @param what - What failed, for the console warning.
   * @param event - The event the listener was handed.
   */
  private _listenerFailed(err: unknown, what: string, event: string): void {
    const error = this._reportError(err, what);
    if (event !== 'session_error') this._sessionError(error, true, 'session');
  }

  /**
   * Adds a listener to the session's endpoint detector and records it in `endpointListeners`, so the stop removes it,
   * and no listener the host or another session added.
   *
   * @param endpoint - The session's endpoint detector.
   * @param event - The detector's event.
   * @param listener - What the session runs on it.
   */
  private _onEndpoint(endpoint: IEndpointDetector, event: string, listener: VoiceEventListener): void {
    endpoint.on(event, listener);
    this.endpointListeners.push({ event, listener });
  }

  /**
   * Removes the listeners this session added to its endpoint detector (`_onEndpoint`), as the session stops. An emit
   * already under way, such as the `turn_complete` whose listener stopped the session, still calls them: an emitter
   * calls the listeners present when the emit began.
   */
  private _releaseEndpoint(): void {
    for (const { event, listener } of this.endpointListeners.splice(0)) this.endpoint?.off(event, listener);
  }

  /**
   * Tells the endpoint detector the agent no longer holds the floor, as its reply ends or a barge-in cuts it. The user
   * holds it then, so the detector takes a lone "okay" or "yeah" as the user's turn, whatever the reply said.
   *
   * @param endpoint - The session's endpoint detector; one without `setAgentContext()` is told nothing.
   */
  private _replyEnded(endpoint: IEndpointDetector): void {
    endpoint.setAgentContext?.({ speaking: false });
  }

  /**
   * Opens an interruption as the user starts to speak over the reply, and asks the barge-in handler with
   * `speechDurationMs: 0`; a timer asks again every `BARGEIN_ASK_INTERVAL_MS` while the speech lasts. Until the floor
   * is decided, what the endpoint detector is told of the speech waits in the interruption (`SpeechEdges.tell`).
   *
   * @param parts - The session's parts.
   * @returns Resolves once the handler's first answer is acted on; rejects when the handler throws or rejects.
   */
  private _interrupt(parts: ReplyParts): Promise<void> {
    const open: Interruption = {
      spokenMs: 0,
      segmentAt: Date.now(),
      endedAt: 0,
      segments: 1,
      finals: 0,
      words: false,
      paused: false,
      holding: false,
      lingering: false,
      audio: [],
      synthesized: false,
      told: [],
      asking: false,
      again: false,
    };
    this.interruption = open;
    this._tick(open, parts);
    return this._askBargein(open, parts);
  }

  /**
   * Asks the barge-in handler again `BARGEIN_ASK_INTERVAL_MS` from now, and so on while the segment being spoken lasts
   * and the interruption is the session's.
   *
   * @param open - The interruption.
   * @param parts - The session's parts.
   */
  private _tick(open: Interruption, parts: ReplyParts): void {
    clearTimeout(open.tick);
    open.tick = setTimeout(() => {
      open.tick = undefined;
      if (this.interruption !== open || open.segmentAt === null) return;
      this._tick(open, parts);
      this.supervise(() => this._askBargein(open, parts));
    }, BARGEIN_ASK_INTERVAL_MS);
  }

  /**
   * A segment of speech starts in an interruption after the last one ended: it is measured from now, the handler is
   * asked as it lasts, and a paused reply stops waiting for a final, since the speech goes on. A start while a segment
   * lasts changes nothing.
   *
   * @param open - The interruption.
   * @param parts - The session's parts.
   */
  private _segmentStarted(open: Interruption, parts: ReplyParts): void {
    if (open.segmentAt !== null) return;
    open.segments += 1;
    open.segmentAt = Date.now();
    clearTimeout(open.wait);
    open.wait = undefined;
    this._tick(open, parts);
  }

  /**
   * The segment being spoken ends: its speech is added to the interruption's, its timer stops, and the wait for its
   * final counts from now.
   *
   * @param open - The interruption.
   */
  private _segmentEnded(open: Interruption): void {
    if (open.segmentAt === null) return;
    open.endedAt = Date.now();
    open.spokenMs += Math.max(0, open.endedAt - open.segmentAt);
    open.segmentAt = null;
    clearTimeout(open.tick);
    open.tick = undefined;
  }

  /**
   * The interruption's speech so far, in milliseconds: its ended segments, and the one being spoken. A clock set back
   * counts as no speech.
   *
   * @param open - The interruption.
   * @returns The speech so far.
   */
  private _spokenMs(open: Interruption): number {
    return open.spokenMs + (open.segmentAt === null ? 0 : Math.max(0, Date.now() - open.segmentAt));
  }

  /**
   * Asks the barge-in handler about the interruption, with the speech measured now, the reply's text so far and the
   * duration of its audio sent, and acts on the answer: `cancel` cuts the reply (`_cutReply`), a `pause` while the
   * reply's audio flows is sent to the transport and holds that audio (in an interruption that listens on after a
   * resume, only while the user speaks), and any other answer changes nothing; a handler's `resume` leaves the decision
   * to the speech's end. One ask is in flight at a time: one asked for meanwhile follows it, with the speech measured
   * then. An answer that comes back after the floor was decided or the reply ended is not acted on. Once the answers
   * are in, an ended speech decides the floor (`_settleInterruption`).
   *
   * @param open - The interruption.
   * @param parts - The session's parts.
   * @returns Resolves once the answers are acted on; rejects when the handler throws or rejects.
   */
  private async _askBargein(open: Interruption, parts: ReplyParts): Promise<void> {
    if (open.asking) {
      open.again = true;
      return;
    }
    open.asking = true;
    try {
      do {
        open.again = false;
        const action = await parts.bargein.handleBargein({
          speechDurationMs: this._spokenMs(open),
          interruptedText: this.text,
          playedDurationMs: this.playedMs,
        });
        if (this.interruption !== open || this.current !== 'speaking') return;
        if (action.type === 'cancel') {
          this._cutReply(open, action, parts);
          return;
        }
        // After a resume, a final that comes late pauses nothing: only the user's speech holds the reply again.
        if (action.type === 'pause' && !open.holding && !(open.lingering && open.segmentAt === null)) {
          open.paused = true;
          open.holding = true;
          this._watchSend(() => parts.transport.sendControl({ type: 'barge_in', action }));
          this._bargedIn(open, action);
        }
      } while (open.again);
    } finally {
      open.asking = false;
    }
    this._settleInterruption(open, parts);
  }

  /**
   * Decides the floor once the interruption's speech has ended and the handler's answers are in. Speech that never
   * paused the reply ends with the reply going on (`_endInterruption`). A paused reply is cut when a final had words,
   * one that came while the handler was still answering included; it resumes (`_resumeReply`) when each segment's
   * final has come without words, as an empty final or a backchannel such as "uh huh", or when `falseInterruptionMs`
   * have passed since the speech ended with no final with words: a false interruption. A reply that resumed with a
   * final still to come (`lingering`) plays on until it ends, and a final with words that comes meanwhile cuts it.
   *
   * @param open - The interruption.
   * @param parts - The session's parts.
   * @param waited - Whether `falseInterruptionMs` have passed since the speech ended.
   */
  private _settleInterruption(open: Interruption, parts: ReplyParts, waited = false): void {
    if (this.interruption !== open || open.segmentAt !== null) return;
    if (!open.paused) this._endInterruption(open);
    else if (open.words) this._cutReply(open, { type: 'cancel' }, parts);
    else if (waited || open.finals >= open.segments) this._resumeReply(open, parts);
    else if (open.holding) {
      // The wait counts from the end of speech, however long the handler took to answer since; a clock set back
      // waits no longer than falseInterruptionMs.
      const leftMs = Math.min(this.falseInterruptionMs, Math.max(0, open.endedAt + this.falseInterruptionMs - Date.now()));
      open.wait ??= setTimeout(() => this.supervise(() => this._settleInterruption(open, parts, true)), leftMs);
    }
  }

  /**
   * Cuts the reply: the pipeline goes `interrupting`, the TTS session is cancelled, the agent's request aborted and the
   * transport sent `barge_in` with `action`; the audio a pause held is never sent. Then the endpoint detector is reset
   * and told the user holds the floor, the pipeline returns to `listening`, and the detector is told the speech that
   * cut the reply, in the order it came, as the user's turn.
   *
   * @param open - The interruption that cuts the reply.
   * @param action - The `cancel` the transport is sent: the handler's, or `{ type: 'cancel' }` when a final with words
   *   cuts a paused reply.
   * @param parts - The session's parts.
   */
  private _cutReply(open: Interruption, action: BargeinAction, parts: ReplyParts): void {
    this._closeInterruption(open);
    // A reply waiting for its audio to play out waits no more: what is left of it is cut.
    this._stopPlayoutWait();
    this.stateTo('interrupting');
    parts.tts.cancel();
    parts.agent.abort?.();
    this._watchSend(() => parts.transport.sendControl({ type: 'barge_in', action }));
    // A listener of barge_in may have stopped the session.
    this._bargedIn(open, action);
    if (this.current === 'closed') return;
    // The cut reply joins the conversation as interrupted; which of its words were heard is not known here.
    if (this.text) this.events.emit('conversation_item_added', { item: { role: 'assistant', text: this.text, playedText: '', interrupted: true }, createdAt: Date.now() });
    // Cast needed because TypeScript keeps `this.current` narrowed by the check above; a listener may have stopped it.
    if ((this.current as PipelineState) === 'closed') return;
    parts.endpoint.reset();
    this._replyEnded(parts.endpoint);
    this.stateTo('listening');
    this.resetWatchdog();
    this._replay(open);
  }

  /**
   * Resumes a paused reply after a false interruption: the transport is sent `barge_in` with `resume`, then the audio
   * the pause held, in order, and a reply that ended during the pause ends once that audio has played
   * (`_finishReply`). When each segment's final has come, the interruption ends here, and the endpoint detector is
   * told the speech as the agent holds the floor, so a backchannel stays out of the conversation. When
   * `falseInterruptionMs` passed first, the interruption listens on for finals until the reply ends (`lingering`), and
   * what the detector is told of the speech waits with it: a final with words then cuts the reply
   * (`_settleInterruption`). The finals it waited for count as come, so speech that follows, which can pause the reply
   * again, resumes it here on its own finals.
   *
   * @param open - The interruption.
   * @param parts - The session's parts.
   */
  private _resumeReply(open: Interruption, parts: ReplyParts): void {
    if (this.interruption !== open) return;
    if (open.finals < open.segments && !open.synthesized) {
      // A final still to come can cut the reply until it ends; a reply that ended during the pause ends once the audio
      // the pause held has played, so nothing is left to cut.
      clearTimeout(open.wait);
      open.wait = undefined;
      open.finals = open.segments;
      open.lingering = true;
    }
    // The interruption ends here unless it listens on, and with a reply that ends here in any case.
    if (!open.lingering || open.synthesized) {
      this._closeInterruption(open);
      this._replay(open);
      if (this.current !== 'speaking') return;
    }
    // A lingering interruption holds nothing unless speech that started after the resume paused the reply again.
    if (!open.holding) return;
    open.holding = false;
    this._watchSend(() => parts.transport.sendControl({ type: 'barge_in', action: { type: 'resume' } }));
    this._bargedIn(open, { type: 'resume' });
    if (this.current !== 'speaking') return;
    for (const chunk of open.audio.splice(0)) this._sendReplyAudio(parts.transport, chunk);
    if (open.synthesized) this._finishReply(parts);
  }

  /**
   * Emits `barge_in`: the user's speech paused, resumed or cut the reply, as the transport was just sent.
   *
   * @param open - The interruption whose speech it was.
   * @param action - What the speech did to the reply.
   */
  private _bargedIn(open: Interruption, action: BargeinAction): void {
    this.events.emit('barge_in', {
      speechDurationMs: this._spokenMs(open),
      interruptedText: this.text,
      playedDurationMs: this.playedMs,
      action: action.type,
      createdAt: Date.now(),
    });
  }

  /**
   * Ends an interruption whose speech never paused the reply, or, as the reply ends, one that listened on after a resume
   * (`lingering`): the reply goes on or has ended, and the endpoint detector is told the speech as the agent holds the
   * floor.
   *
   * @param open - The interruption.
   */
  private _endInterruption(open: Interruption): void {
    this._closeInterruption(open);
    this._replay(open);
  }

  /**
   * Ends an interruption as the session's: its timers stop. What it holds is the caller's to send, tell or drop.
   *
   * @param open - The interruption.
   */
  private _closeInterruption(open: Interruption): void {
    clearTimeout(open.tick);
    clearTimeout(open.wait);
    open.tick = undefined;
    open.wait = undefined;
    if (this.interruption === open) this.interruption = undefined;
  }

  /**
   * Tells the endpoint detector what an interruption held for it, in order, each through `supervise()`: a failure ends
   * the session, and the rest is dropped.
   *
   * @param open - The interruption.
   */
  private _replay(open: Interruption): void {
    for (const work of open.told.splice(0)) {
      if (this.current === 'closed') return;
      this.supervise(work, 'endpoint');
    }
  }

  /**
   * Sends a chunk of the reply's audio to the transport, counted in the reply's played duration.
   *
   * @param transport - The session's transport.
   * @param chunk - The chunk.
   */
  private _sendReplyAudio(transport: IStreamTransport, chunk: EncodedAudioChunk): void {
    this.playedMs += chunk.durationMs;
    const reply = this._currentReply;
    // A transport that cannot report its playout plays each chunk after the one before it, from when it was sent at the
    // earliest; a duration that is no number of milliseconds plays for none.
    const durationMs = Number.isFinite(chunk.durationMs) && chunk.durationMs > 0 ? chunk.durationMs : 0;
    reply.playsUntil = Math.max(reply.playsUntil, Date.now()) + durationMs;
    this._watchSend(() => transport.sendAudio(chunk), reply);
  }

  /**
   * Ends the reply once its audio has played: the pipeline stays `speaking` until then, so speech over the rest of the
   * reply interrupts it as over any part of it, and the agent holds the floor. A transport that reports its playout
   * (`waitForPlayout()`, as a speaking `LiveKitStreamTransport` does) says when the audio it was sent has played out; a
   * wait that rejects, as a stalled LiveKit track's does once it has discarded what it had not played, ends the reply
   * too, though what of it was heard is not known (`ReplyRecord.playoutFailed`). On any other transport the reply waits
   * for the audio's own duration (`ReplyRecord.playsUntil`), at most `maxPlayoutWaitMs`, and ends at once when that has
   * passed. A barge-in that cuts the reply, a stop and a later wait abort the wait (`_stopPlayoutWait`), and a wait that
   * settles after the reply was cut or replaced changes nothing. Then the reply ends (`_settleReply`).
   *
   * @param parts - The session's parts.
   */
  private _finishReply(parts: ReplyParts): void {
    const reply = this._currentReply;
    this._stopPlayoutWait();
    const wait = new AbortController();
    this.playoutWait = wait;
    const settle = (played: boolean): void => {
      if (wait.signal.aborted) return;
      this.playoutWait = undefined;
      if (!played) reply.playoutFailed = true;
      if (this._currentReply === reply && this.current === 'speaking') this.supervise(() => this._settleReply(parts));
    };
    let playout: Promise<void> | undefined;
    try {
      playout = parts.transport.waitForPlayout?.(wait.signal);
    } catch (err) {
      playout = Promise.reject(err);
    }
    if (playout) {
      // As in _watchSend(), Promise.resolve() also takes a promise of another realm or library.
      Promise.resolve(playout).then(
        () => settle(true),
        () => settle(false)
      );
      return;
    }
    // The transport cannot say when its audio has played: the audio it was sent plays for its own duration.
    const leftMs = Math.min(this.maxPlayoutWaitMs, reply.playsUntil - Date.now());
    if (!(leftMs > 0)) {
      this.playoutWait = undefined;
      this._settleReply(parts);
      return;
    }
    const timer = setTimeout(() => settle(true), Math.min(leftMs, MAX_TIMER_MS));
    wait.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }

  /** Ends the wait of a reply for its audio to play out, if one is under way (`_finishReply`). */
  private _stopPlayoutWait(): void {
    const wait = this.playoutWait;
    this.playoutWait = undefined;
    wait?.abort();
  }

  /**
   * Ends a reply whose audio has played. One that a pause holds ends after the resume, once the audio the pause held has
   * played (`_resumeReply`), and not at all when it is cut; speech over it that never paused it, or whose final had not
   * come when the reply resumed (`lingering`), ends with it, told as said while the agent held the floor; then the reply
   * is done (`_replyDone`).
   *
   * @param parts - The session's parts.
   */
  private _settleReply(parts: ReplyParts): void {
    const open = this.interruption;
    if (open?.holding) {
      open.synthesized = true;
      return;
    }
    if (open) {
      this._endInterruption(open);
      // Telling the detector can fail and end the session.
      if (this.current !== 'speaking') return;
    }
    this._replyDone(parts);
  }

  /**
   * Ends the reply once its audio has played (`_finishReply`): the transport is sent `agent_done`, the reply joins the
   * conversation as played (`conversation_item_added`), or, when a wait for its playout failed, as interrupted with no
   * text known heard, the pipeline returns to `listening`, the endpoint detector is reset and told the user holds the
   * floor, and the watchdog starts.
   *
   * @param parts - The session's parts.
   */
  private _replyDone(parts: ReplyParts): void {
    this._watchSend(() => parts.transport.sendControl({ type: 'agent_done', text: this.text, durationMs: this.playedMs }));
    // A reply whose playout wait failed joins as a cut one does: which of its words were heard is not known.
    const heard = !this._currentReply.playoutFailed;
    if (this.text) this.events.emit('conversation_item_added', { item: { role: 'assistant', text: this.text, playedText: heard ? this.text : '', interrupted: !heard }, createdAt: Date.now() });
    // A listener may have stopped the session.
    if (this.current !== 'speaking') return;
    this.stateTo('listening');
    this.supervise(() => {
      parts.endpoint.reset();
      this._replyEnded(parts.endpoint);
    }, 'endpoint');
    this.resetWatchdog();
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
      if (this.current === 'listening') this.supervise(() => this.endpoint?.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'vad' }), 'endpoint');
    }, this.config.maxTurnDurationMs ?? 30000);
  }

  /**
   * Starts one conversation. A call profile requires scoped adapters and an acknowledged playback transport.
   *
   * Without a call profile this method:
   * 1. Validates the orchestrator is in `'idle'` state and has its four components.
   * 2. Resets the endpoint detector with `'session'`, so a detector an earlier session used carries nothing of that
   *    session into this one, such as a wait for the late final of its last turn, then tells a detector that takes
   *    `setAgentContext()` that the agent does not hold the floor, so it reads backchannels by the agent's context
   *    from the session's first utterance.
   * 3. Asks a transport that has `readyForPlayback()` to get its playback ready, without waiting for it: a speaking
   *    `LiveKitStreamTransport` publishes its track, so the participant has subscribed before the first reply plays.
   *    A failure there fails the first reply's send, which reports it.
   * 4. Creates STT and TTS sub-sessions from the provided factories.
   * 5. Wires all event handlers (transport -> STT -> endpoint -> agent -> TTS -> transport, and a client's
   *    transcript messages -> endpoint).
   * 6. Transitions to `'listening'` and starts the watchdog timer.
   * 7. Returns a {@link VoicePipelineSession} handle.
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
      const call = new CallPipelineRuntime(this.config, transport, agent, overrides.streamingSTT, overrides.streamingTTS, overrides.callProfile, (err, what, target, warnUnheard) => this._reportError(err, what, target, warnUnheard));
      this.call = call;
      this.transport = transport;
      call.on('state_change', (state: PipelineState) => this.stateTo(state));
      // As without a profile, a listener that throws is reported and the listeners after it still run.
      call.on('turn_complete', (event: TurnCompleteEvent) => this._emitEach(this, 'turn_complete', event));
      // Set as the call's close goes out. The call's state reads 'closed' before that, while the session_error of a
      // failure whose 'error' listener closed the call is still to go out ahead of close.
      let ended = false;
      call.on('close', (closed: VoiceSessionEventMap['close']) => {
        ended = true;
        this.stateTo('closed');
        this._emitEach(this, 'close', closed);
      });
      // The call's session events, from its start: a host that listens here before startSession() hears it open. As
      // without a profile, a listener here that closes the call ends the event there: no listener after it gets it.
      for (const name of ['agent_state_changed', 'user_state_changed', 'user_input_transcribed', 'conversation_item_added', 'speech_created', 'barge_in', 'session_error'] as const) {
        call.on(name, (payload: unknown) => emitEach(this, name, [payload], (err, what) => this._listenerFailed(err, what, name), () => ended));
      }
      for (const name of ['gap', 'generation', 'interrupted', 'usage', 'failure', 'detached', 'reattached', 'transcript'] as const) call.on(name, (event: unknown) => this.emit(name, event));
      await call.start();
      return call;
    }
    if (!overrides.endpointDetector) throw new Error('endpointDetector is required');
    if (!overrides.bargeinHandler) throw new Error('bargeinHandler is required');
    // This session's STT session sends no final of an earlier session's turns, so a detector an earlier session used
    // waits for none.
    overrides.endpointDetector.reset('session');
    // The user holds the floor until a turn completes. Told so, a detector reads backchannels by the agent's context
    // from the session's first utterance; HeuristicEndpointDetector keeps its exact-phrase rule only for a caller that
    // reports none.
    overrides.endpointDetector.setAgentContext?.({ speaking: false });
    this.transport = transport;
    this.agent = agent;
    this.endpoint = overrides.endpointDetector;
    this.watch(transport, 'transport');
    // As watch() does for the other parts, and recorded: the detector is the host's and outlives the session.
    this._onEndpoint(this.endpoint, 'error', () => this.reportFailure('endpoint'));
    // A track published as the session starts has its subscriber before the first reply plays. Not waited for: a
    // failure fails the first reply's send, which reports it.
    const playback = transport as Partial<IPlaybackTransport>;
    if (typeof playback.readyForPlayback === 'function') {
      try {
        void Promise.resolve(playback.readyForPlayback()).catch(() => {});
      } catch {
        // As a rejection: the first reply's send reports it.
      }
    }
    try {
      this.stt = await overrides.streamingSTT.startSession({ language: this.config.language, providerOptions: this.config.sttOptions });
      this.watch(this.stt, 'stt');
      this.tts = await overrides.streamingTTS.startSession({ voice: this.config.voice, format: transport.playbackFormat ?? this.config.format, providerOptions: this.config.ttsOptions, expressiveness: this.config.ttsExpressiveness });
      this.watch(this.tts, 'tts');
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
    const parts: ReplyParts = { transport, agent, tts, endpoint, bargein: overrides.bargeinHandler };
    // The user's speech: the STT session's speech_start, speech_end and transcripts, or a client's transcript lines
    // (_wireClientTranscripts). Each edge moves the user's state (`user_state_changed`) and goes to the endpoint
    // detector as a synthetic VAD event, and a start while the agent speaks interrupts the reply until the floor is
    // decided (`_interrupt`): the barge-in handler is asked as the speech grows, and what the detector is told of the
    // speech waits for the decision.
    const speech: SpeechEdges = {
      start: async () => {
        if (this.current === 'closed') return;
        this.events.userTo('speaking');
        if ((this.current as PipelineState) === 'closed') return;
        const event: VadEvent = { type: 'speech_start', timestamp: Date.now(), source: 'stt' };
        const open = this.interruption;
        if (open) {
          // The user speaks again before the floor is decided: the same interruption, measured across both.
          speech.tell(() => endpoint.pushVadEvent(event));
          this._segmentStarted(open, parts);
          await this._askBargein(open, parts);
        } else {
          endpoint.pushVadEvent(event);
          if (this.current === 'speaking') await this._interrupt(parts);
        }
      },
      end: () => {
        if (this.current === 'closed') return;
        if (this.events.user === 'speaking') this.events.userTo('listening');
        if ((this.current as PipelineState) === 'closed') return;
        const event: VadEvent = { type: 'speech_end', timestamp: Date.now(), source: 'stt' };
        speech.tell(() => endpoint.pushVadEvent(event));
        const open = this.interruption;
        if (!open) return;
        this._segmentEnded(open);
        this.supervise(() => this._askBargein(open, parts));
      },
      heard: (text, isFinal) => {
        const open = this.interruption;
        if (!open) return;
        if (isFinal) {
          open.finals += 1;
          // A backchannel such as "uh huh", said while the agent holds the floor, makes no claim to it.
          if (text.trim() && !endpoint.isBackchannel?.(text)) open.words = true;
        }
        this.supervise(() => this._askBargein(open, parts));
      },
      tell: (work) => {
        if (this.interruption) this.interruption.told.push(work);
        else work();
      },
    };
    transport.on('audio', (frame: AudioFrame) => {
      if (this.current !== 'closed' && this._takesSpeechFrom('audio')) this.supervise(() => stt.pushAudio(frame), 'stt');
    });
    transport.on('close', () => {
      this.supervise(() => this.stopSession('transport_closed'));
    });
    stt.on('transcript', (event: TranscriptEvent) => {
      if (this.current === 'closed') return;
      this._transcribed({ text: event.text, isFinal: event.isFinal, confidence: event.confidence, language: event.language, itemId: event.itemId, speakerId: speakerOf(event.words) });
      if ((this.current as PipelineState) === 'closed') return;
      this.supervise(() => speech.tell(() => endpoint.pushTranscript(event)), 'endpoint');
      this._watchSend(() => transport.sendControl({ type: 'transcript', text: event.text, isFinal: event.isFinal, confidence: event.confidence }));
      this.supervise(() => speech.heard(event.text, event.isFinal));
    });
    this._onEndpoint(endpoint, 'turn_complete', (event: TurnCompleteEvent) => {
      // The language of this turn's finals goes with this turn, taken or not.
      const language = this.turnLanguage;
      this.turnLanguage = undefined;
      if (this.current !== 'listening') return;
      // Re-emitted for waitForUserTurn() and for hosts that listen on the orchestrator or on the session.
      this._emitEach(this, 'turn_complete', event);
      if (this.publicSession) this._emitEach(this.publicSession, 'turn_complete', event);
      // A listener may have stopped the session: only a session still listening takes the turn.
      if ((this.current as PipelineState) !== 'listening') return;
      // The turn joins the conversation as the agent takes it.
      this.events.emit('conversation_item_added', {
        item: {
          role: 'user',
          text: event.transcript,
          ...(language ? { language } : {}),
          source: this.speechSource === 'client' ? 'client' : 'speech',
          endpointReason: event.reason,
        },
        createdAt: Date.now(),
      });
      if ((this.current as PipelineState) !== 'listening') return;
      this.stateTo('processing');
      // A listener of the change may have stopped the session: the client hears no thinking from a closed one.
      if ((this.current as PipelineState) !== 'processing') return;
      if (this.watchdog) clearTimeout(this.watchdog);
      // Sends are not waited for: a send that rejects is reported and ends neither the turn nor the session.
      this._watchSend(() => transport.sendControl({ type: 'agent_thinking' }));
      this.supervise(async () => {
        if (this.current === 'closed') return;
        // The agent holds the floor from the moment the user's turn completes, before its reply has a word: the
        // detector drops a backchannel such as "uh huh" until the reply ends or a barge-in cuts it.
        inPart('endpoint', () => endpoint.setAgentContext?.({ speaking: true }));
        const tokens = inPart('agent', () => agent.sendText(event.transcript, { speakers: [], endpointReason: event.reason, speechDurationMs: event.durationMs, wasInterrupted: false, transcriptConfidence: event.confidence }));
        // The reply gets its record before its audio is sent.
        this._stopPlayoutWait();
        const reply: ReplyRecord = { audioRefusalReported: false, playsUntil: 0, started: false };
        this._currentReply = reply;
        this.stateTo('speaking');
        this.text = '';
        this.playedMs = 0;
        this._watchSend(() => transport.sendControl({ type: 'agent_speaking', text: '' }));
        for await (const token of fromPart('agent', tokens)) {
          // A reply a barge-in cut takes no more of its agent's stream, though the next reply speaks by then.
          if (this.current !== 'speaking' || this._currentReply !== reply) break;
          if (!reply.started) {
            // The reply has its first word: the agent's speech is created, and the agent speaks.
            reply.started = true;
            this.events.emit('speech_created', { source: 'reply', userInitiated: false, createdAt: Date.now() });
            this.events.agentTo('speaking');
            if ((this.current as PipelineState) !== 'speaking') break;
          }
          this.text += token;
          inPart('tts', () => tts.pushTokens(token));
        }
        if (this.current === 'speaking' && this._currentReply === reply) await inPartAsync('tts', () => tts.flush());
      });
    });
    const playbackFormat = transport.playbackFormat;
    const ttsProvider = overrides.streamingTTS.providerId;
    let formatRefusalReported = false;
    tts.on('audio', (chunk: EncodedAudioChunk) => {
      if (this.current !== 'speaking') return;
      // A transport that plays one format alone would refuse the chunk; the session says once which provider sent what.
      if (playbackFormat && chunk.format !== playbackFormat) {
        if (!formatRefusalReported) {
          formatRefusalReported = true;
          const error = this._reportError(new Error(`the TTS provider '${ttsProvider}' sent ${chunk.format} audio, and the transport plays ${playbackFormat} only`), 'a TTS chunk the transport cannot play');
          this._sessionError(error, true, 'tts');
        }
        return;
      }
      // A pause holds the reply's audio until the reply resumes or is cut; a chunk the transport cannot play is never held.
      const open = this.interruption;
      if (open?.holding) open.audio.push(chunk);
      else this._sendReplyAudio(transport, chunk);
    });
    tts.on('flush_complete', () => {
      if (this.current !== 'speaking') return;
      const open = this.interruption;
      if (open?.holding) {
        // The reply ends once the audio the pause holds is sent and has played (`_resumeReply`), and not at all when
        // it is cut.
        open.synthesized = true;
        return;
      }
      // The reply ends once the transport has played its audio out; speech over the rest of it interrupts it.
      this._finishReply(parts);
    });
    stt.on('speech_start', () => this.supervise(() => speech.start()));
    stt.on('speech_end', () => this.supervise(() => speech.end()));
    this._wireClientTranscripts(transport, endpoint, speech);
    const publicSession = Object.assign(new EventEmitter(), { sessionId: randomUUID(), transport, close: (reason?: string) => this.stopSession(reason) });
    // A getter, so the session reads the state of the moment rather than a copy taken here.
    Object.defineProperty(publicSession, 'state', { get: () => this.current });
    this.publicSession = publicSession as VoicePipelineSession;
    this.stateTo('listening');
    // A listener of the session's first state may have stopped it.
    if ((this.current as PipelineState) === 'closed') return this.publicSession;
    // The client hears that the session is open, under its id, with the configuration it runs.
    this._watchSend(() => transport.sendControl({ type: 'session_started', sessionId: publicSession.sessionId, config: clientConfig(this.config) }));
    this.resetWatchdog();
    return this.publicSession;
  }

  /**
   * Emits `user_input_transcribed` for a transcript with words, from the STT session or a client, and keeps the
   * language of a final for the turn it belongs to.
   *
   * @param heard - The transcript.
   */
  private _transcribed(heard: HeardTranscript): void {
    if (!heard.text.trim()) return;
    if (heard.isFinal && heard.language) this.turnLanguage = heard.language;
    this.events.emit('user_input_transcribed', transcribedEvent(heard));
  }

  /**
   * Client transcripts -> Endpoint Detector, for a session without a call profile.
   *
   * A client that transcribes on its own device sends its transcripts as
   * `transcript` messages ({@link ClientTranscriptMessage}) in place of
   * audio. A session that received audio first drops them, and one that
   * received a transcript message first drops the transport's audio
   * (`_takesSpeechFrom`). Each one `isClientTranscriptMessage()` accepts
   * reaches the endpoint detector as a transcript from the STT session does,
   * and the client's lines stand in for the STT session's speech events: the
   * first line to open while none is open is a speech start (while the agent
   * speaks, an interruption of the reply, whose first answer from the
   * barge-in handler comes before the line's text; each message after it
   * asks the handler again, and the detector is told the lines' text once
   * the floor is decided, each final joined then), and the final that closes
   * the last open line is a speech end, after its text.
   *
   * The detector keeps one final without an `itemId` per turn, each replacing
   * the last, and a client makes one line per speech segment (Moonshine
   * completes a line at a pause inside a sentence), so each final reaches the
   * detector joined, in arrival order, after the finals of the turn so far,
   * and without the line's `itemId`, since its text is the turn's: a final
   * with one would be kept per item and joined again. An interim reaches it
   * as it is. The turn's finals start again when the detector completes a
   * turn and when the pipeline returns to listening, where the detector is
   * reset. A final the detector's `isBackchannel()` answers `true` for
   * reaches it on its own instead, also without the line's `itemId`, so the
   * detector drops it and reports it as `'backchannel_detected'` and the
   * turn's text stays as it was; a detector without `isBackchannel()` gets
   * every final joined.
   *
   * A line opens with its first message that has text, so an empty line that
   * never opened is nothing, and an empty final closes its line without its
   * text (an empty final would replace the detector's last final). A line
   * that gets no message for `CLIENT_LINE_TIMEOUT_MS` is closed as by an empty
   * final, so a line whose final never comes (a client session that failed, a
   * message lost in a reconnect) holds no speech open. A stop, by
   * `stopSession()` or a transport close, ends every open line and clears its
   * timer, so none fires after the session. A client's input is bounded: at
   * most `CLIENT_MAX_OPEN_LINES` lines open, the oldest giving way, and a
   * turn's joined text at most `CLIENT_TURN_MAX_TEXT` characters.
   * Messages are handled one at a time, in the order they arrive, and one
   * that fails ends the session as a failure of the STT session's events
   * does. Nothing is relayed back, since the client shows its own text, and
   * once the session is closed a message is ignored. Other client messages
   * are not this segment's.
   *
   * @param transport - The transport the client's messages arrive on.
   * @param endpoint - The detector whose turns the client's finals are joined within.
   * @param speech - What speech starting and ending does, as for the STT session's events.
   */
  private _wireClientTranscripts(transport: IStreamTransport, endpoint: IEndpointDetector, speech: SpeechEdges): void {
    const lines = { open: new Map<string, ReturnType<typeof setTimeout>>(), finals: [] as string[] };
    this.endClientLines = () => {
      for (const timer of lines.open.values()) clearTimeout(timer);
      lines.open.clear();
    };
    this._onEndpoint(endpoint, 'turn_complete', () => {
      lines.finals = [];
    });
    // `flush_complete` and a barge-in's cancel reset the detector as they return to listening.
    this.on('state_changed', (change: { to: PipelineState }) => {
      if (change.to === 'listening') lines.finals = [];
    });
    let handled: Promise<void> = Promise.resolve();
    const handle = (message: ClientTranscriptMessage): void => {
      // As supervise() does for the STT session's events, a failure ends the session through reportFailure().
      handled = handled
        .then(() => this._onClientTranscript(message, lines, handle, endpoint, speech))
        .catch((err: unknown) => this.reportFailure(err instanceof PartFailure ? err.source : 'session'));
    };
    transport.on('message', (message: ClientTextMessage) => {
      if (isClientTranscriptMessage(message) && this.current !== 'closed' && this._takesSpeechFrom('client')) handle(message);
    });
  }

  /**
   * Whether the session takes speech from `source`. A session takes its speech from one source, the first it
   * receives: its transport's audio, which the STT session transcribes, or a client's transcript messages
   * (`_wireClientTranscripts`). With both, the endpoint detector would get two sets of speech starts and ends and two
   * sets of finals, and a client's final would replace the finals the STT session's transcripts hold. What arrives from
   * the other source is dropped; the session's first drop is reported through `_reportError()`, and the rest are not.
   *
   * @param source - Where the speech arrived from: `'audio'` for a frame, `'client'` for a transcript message.
   * @returns `true` when the session takes its speech from `source`.
   */
  private _takesSpeechFrom(source: 'audio' | 'client'): boolean {
    this.speechSource ??= source;
    if (this.speechSource === source) return true;
    if (!this.speechSourceDropReported) {
      this.speechSourceDropReported = true;
      const error = this._reportError(
        new Error(
          source === 'audio'
            ? 'audio was dropped: this session takes its speech from client transcripts, which it received first'
            : 'a client transcript was dropped: this session takes its speech from audio, which it received first'
        ),
        'a second speech source'
      );
      this._sessionError(error, true, 'session');
    }
    return false;
  }

  /**
   * One checked client transcript (see `_wireClientTranscripts`).
   *
   * @param message - The client's message.
   * @param lines - The client's open lines, each with the timer that closes it,
   *   and the finals of the detector's current turn.
   * @param handle - Hands a message to the chain, as one from the transport.
   * @param endpoint - The session's endpoint detector.
   * @param speech - What speech starting and ending does.
   */
  private async _onClientTranscript(
    message: ClientTranscriptMessage,
    lines: { open: Map<string, ReturnType<typeof setTimeout>>; finals: string[] },
    handle: (message: ClientTranscriptMessage) => void,
    endpoint: IEndpointDetector,
    speech: SpeechEdges
  ): Promise<void> {
    if (this.current === 'closed') return;
    const { itemId } = message;
    const text = message.text.trim();
    const opening = !lines.open.has(itemId);
    if (opening && !text) return;
    if (opening && lines.open.size >= CLIENT_MAX_OPEN_LINES) {
      // A client holds at most CLIENT_MAX_OPEN_LINES lines open: the oldest gives way.
      const oldest = lines.open.keys().next();
      if (!oldest.done) {
        clearTimeout(lines.open.get(oldest.value));
        lines.open.delete(oldest.value);
      }
    }
    // Each message gives its line CLIENT_LINE_TIMEOUT_MS more; a line that
    // gets no message in that time is closed as by an empty final.
    clearTimeout(lines.open.get(itemId));
    lines.open.set(
      itemId,
      setTimeout(() => handle({ type: 'transcript', text: '', itemId, isFinal: true }), CLIENT_LINE_TIMEOUT_MS)
    );
    if (opening && lines.open.size === 1) {
      await speech.start();
      // Cast needed because TypeScript keeps `this.current` narrowed by the
      // check above across the await; the session may have closed meanwhile.
      if ((this.current as PipelineState) === 'closed') return;
    }
    if (text) {
      // The line's own text, as the client transcribed it; the detector below is told the turn's.
      this._transcribed({ text, isFinal: message.isFinal, confidence: message.confidence, language: message.language, itemId });
      if ((this.current as PipelineState) === 'closed') return;
      const event = transcriptEventFromClient(message);
      // Joined as the detector is told it: during an interruption, once the floor is decided, so a final that cut the
      // reply starts the user's turn.
      speech.tell(() => {
        if (message.isFinal) {
          // A backchannel the detector would drop reaches it on its own, so the detector drops and reports it; joined
          // with the turn's finals, it would be words of the turn.
          if (!endpoint.isBackchannel?.(text)) {
            // A turn's text stops growing at CLIENT_TURN_MAX_TEXT: later finals are left out.
            if (lines.finals.join(' ').length < CLIENT_TURN_MAX_TEXT) lines.finals.push(text);
            event.text = lines.finals.join(' ').slice(0, CLIENT_TURN_MAX_TEXT);
          }
          // The text is the turn's, or a lone backchannel's, not the line's: with the line's itemId, a detector
          // that keeps finals per item would join the turn's lines a second time.
          delete event.itemId;
        }
        endpoint.pushTranscript(event);
      });
    }
    // An empty final closes its line with no words: an interruption counts it as a final.
    speech.heard(text, message.isFinal);
    if (message.isFinal) {
      clearTimeout(lines.open.get(itemId));
      lines.open.delete(itemId);
      if (lines.open.size === 0) speech.end();
    }
  }

  /**
   * Hands an event to each of `target`'s listeners for it, in order, through {@link emitEach}: a listener that throws
   * or rejects is reported (`_listenerFailed`) and the listeners after it still run. A listener that stops the session
   * ends any event but `close` there, as it ends a session event ({@link SessionEvents}): the listeners after it get
   * nothing, so no `turn_complete` follows `close`.
   *
   * @param target - The orchestrator or the session it returned.
   * @param event - The event to hand on.
   * @param args - What each listener is handed.
   */
  private _emitEach(target: EventEmitter, event: string, ...args: unknown[]): void {
    emitEach(target, event, args, (err, what) => this._listenerFailed(err, what, event), () => event !== 'close' && this.current === 'closed');
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
   * @param err - The failure; anything other than an `Error` is wrapped in one. Its text, and that of what a listener
   *   throws, comes from `describeReason()`, which gives text for any value: a reason `String()` cannot print (an
   *   object without a prototype, a revoked proxy) is named by its type, where building the report would throw.
   * @param what - What failed, for the console warning.
   * @param target - Whose listeners get the failure: the orchestrator, or the session it returned.
   * @param warnUnheard - Whether a failure that nothing listens for as `'error'` is written as a console warning; a
   *   report that another report writes the warning for passes `false`, and its `errorMonitor` listeners still get it.
   * @returns The `Error` the listeners were handed, for `session_error`.
   */
  private _reportError(err: unknown, what: string, target: EventEmitter = this, warnUnheard = true): Error {
    const error = isError(err) ? err : new Error(describeReason(err));
    const warnListenerFailed = (thrown: unknown): void => {
      console.warn(
        `[voice-pipeline-orchestrator] ${what}:`,
        describeReason(error),
        `(an 'error' listener failed: ${describeReason(thrown)})`
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
      if (warnUnheard) console.warn(`[voice-pipeline-orchestrator] ${what}:`, describeReason(error));
      return error;
    }
    handToListeners('error');
    return error;
  }

  /**
   * Makes a transport send that the orchestrator does not wait for. A send that rejects, as one does on a WebSocket
   * that is closing or a LiveKit room that is disconnecting, or that throws, is reported once through `_reportError()`
   * and ends nothing; a send that resolves is left as it is. Unhandled, the rejection would end the process: Node
   * raises an unhandled rejection as an uncaught exception by default.
   *
   * A refused control message is reported each time. Of a reply's audio chunks only the first refused is reported: a
   * transport that does not publish audio, as `LiveKitStreamTransport` without a publisher does not, refuses every chunk
   * of every reply.
   *
   * A closed session sends nothing: `session_ended`, which the stop sends itself, is the last message its client gets,
   * though a listener that stopped the session returns into a step that would send more.
   *
   * @param send - Calls `sendControl()` or `sendAudio()`; it is called at once, unless the session has closed.
   * @param reply - For an audio chunk, the reply it belongs to (`_currentReply` when it was sent).
   */
  private _watchSend(send: () => Promise<void>, reply?: ReplyRecord): void {
    if (this.current === 'closed') return;
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
      this._sessionError(this._reportError(err, 'a transport send failed'), true, 'transport');
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
   * Without a call profile the session moves to `'closed'` and emits `'close'` at once, with the reason and, after a
   * failure, the failure's `Error`; then it aborts the agent's request, closes the STT and TTS sessions, resets the
   * endpoint detector and removes the listeners the session added to it, and closes the transport, unless the transport
   * has closed itself: a transport still open is sent `session_ended` first and closed once that send has settled, or
   * after half a second when it hangs, since a transport closed with a send in flight can drop it. The promise rejects when one of those
   * throws. An interruption of the reply under way ends with the session: its timers stop, and the audio and speech
   * it holds are neither sent nor told; so does a reply's wait for its audio to play out. No session event is emitted
   * after `'close'`. Safe to call more than once: a later call returns the first one's outcome.
   *
   * @param reason - Optional human-readable reason for diagnostics; `'closed'` in the `close` event when omitted.
   */
  stopSession(reason?: string): Promise<void> {
    if (this.call) return this.call.close(reason);
    if (this.current === 'closed') return this.stopping ?? Promise.resolve();
    if (this.stopping) return this.stopping;
    this.stateTo('closed');
    if (this.watchdog) clearTimeout(this.watchdog);
    this.endClientLines?.();
    // An interruption's timers go with the session, and nothing it holds is sent or told.
    if (this.interruption) this._closeInterruption(this.interruption);
    this._stopPlayoutWait();
    // A failure whose 'error' listener stopped the session has its session_error before close.
    this._sendFailureEvents();
    // The session's events end here: the away timer stops, and nothing is emitted after close.
    this.events.close();
    const closed: VoiceSessionEventMap['close'] = { reason: reason ?? 'closed', ...(this.failure ? { error: this.failure } : {}), createdAt: Date.now() };
    this._emitEach(this, 'close', closed);
    if (this.publicSession) this._emitEach(this.publicSession, 'close', closed);
    const failures: unknown[] = [];
    const transport = this.transport;
    let ended: Promise<void> | undefined;
    for (const close of [
      () => this.agent?.abort?.(),
      () => this.stt?.close(),
      () => this.tts?.close(),
      () => this.endpoint?.reset(),
      () => this._releaseEndpoint(),
      // A transport that closed itself is not closed again; the WebSocket transport would read 'closing' ever after.
      () => {
        if (!transport || transport.state === 'closed') return;
        // A session that opened tells its client why it ends; the transport closes below, once that send has settled.
        if (this.publicSession && transport.state === 'open') {
          let sending: Promise<void>;
          try {
            sending = Promise.resolve(transport.sendControl(reason === undefined ? { type: 'session_ended' } : { type: 'session_ended', reason }));
          } catch (err) {
            // A send that throws has settled too: the transport closes at once.
            sending = Promise.reject(err);
          }
          ended = sending.then(
            () => undefined,
            () => undefined
          );
          // A failed send is reported as _watchSend() reports one; _watchSend() itself sends nothing once closed.
          sending.catch((err: unknown) => {
            this._reportError(err, 'a transport send failed');
          });
        }
      },
    ]) {
      try {
        close();
      } catch (error) {
        failures.push(error);
      }
    }
    // The transport closes once the client has its session_ended, or after SESSION_ENDED_SEND_MS when the send hangs: a
    // WebSocket's send resolves when its callback fires, and a transport closed before that can drop the message.
    const closeTransport = async (): Promise<void> => {
      // A transport that reported its own close has no client left to wait for: it is closed at once, as before.
      if (ended && reason !== 'transport_closed') {
        const sent = ended;
        // The bound's timer goes when the send settles, so a stopped session leaves no timer behind.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SESSION_ENDED_SEND_MS);
          (timer as { unref?: () => void }).unref?.();
          void sent.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (!transport || transport.state === 'closed') return;
      try {
        transport.close(1000, reason);
      } catch (error) {
        failures.push(error);
      }
    };
    this.stopping = closeTransport().then(() => {
      if (failures.length) throw new Error('cleanup incomplete');
    });
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
   * `pushTokens()`, then `flush()` signals the end of the utterance. The session sends its TTS session's audio only
   * while it is `speaking`: the prompt's first word pushed then is `speech_created` with `source: 'say'`, and a prompt
   * pushed at another time creates none. Under a call profile the text is a reply of its own: a new generation,
   * synthesized into acknowledged playback while the call is listening.
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
    // The host's own speech is created at its first word, with source 'say', as the call runtime's speak() creates it.
    // The session sends its TTS session's audio only while it speaks: a word pushed then goes out with the reply's
    // audio, and a prompt pushed at another time creates no speech, since none of it reaches the transport.
    let created = false;
    const create = (): void => {
      if (created || this.current !== 'speaking') return;
      created = true;
      this.events.emit('speech_created', { source: 'say', userInitiated: true, createdAt: Date.now() });
    };
    if (typeof text === 'string') {
      create();
      this.tts.pushTokens(text);
    } else {
      for await (const token of text) {
        create();
        this.tts.pushTokens(token);
      }
    }
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
  /** The call's session events ({@link VoiceSessionEventMap}), which the orchestrator emits as well. */
  private readonly events: SessionEvents;
  /** The language of the current turn's last final transcript, for the user's conversation item. */
  private turnLanguage?: string;
  /**
   * The text of the reply or prompt being spoken, for `barge_in` and an interrupted conversation item; empty while
   * none is, as while the call processes a turn.
   */
  private replyText = '';
  /** Whether a reply or a prompt is being spoken: an interruption cuts it. */
  private replying = false;
  /** The first failure the call ended on, for its `close` event. */
  private failure?: Error;
  /**
   * The failures whose `session_error` has yet to go out, each with the part it came from, in order
   * (`sendFailureEvents`): a failure whose `'error'` listener closes the call has its `session_error` before `close`.
   */
  private readonly failureEvents: FailureEvent[] = [];

  /**
   * @param report - Reports a failure to the listeners of `target`, the orchestrator's by default, as the orchestrator
   *   reports its own (`'error'`, or a console warning with no listener), and gives the `Error` it handed them.
   */
  constructor(private readonly config: VoicePipelineConfig, readonly transport: IStreamTransport, private readonly agent: IVoicePipelineAgentSession, private readonly sttProvider: IStreamingSTT, private readonly ttsProvider: IStreamingTTS, private readonly profile: CallPipelineProfile, private readonly report: (err: unknown, what: string, target?: EventEmitter, warnUnheard?: boolean) => Error) {
    super();
    this.events = new SessionEvents(() => [this], (err, what, event) => this.listenerFailed(err, what, event), config.userAwayTimeoutMs);
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

  /**
   * Moves the call to `state`; the agent's state follows as without a call profile: listening as the call listens,
   * thinking as it processes a turn, speaking from the first word of a reply or a prompt (`synthesize`), an
   * interruption keeping the state it came from.
   *
   * @param state - The new state.
   */
  private stateTo(state: PipelineState): void {
    if (state === this.current) return;
    this.current = state;
    // A listener that moves the call on, as a close does, ends the change there, as in the orchestrator's stateTo().
    emitEach(this, 'state_change', [state], (err, what) => this.listenerFailed(err, what, 'state_change'), () => this.events.isClosed || this.current !== state);
    if (this.current !== state) return;
    if (state === 'listening') this.events.agentTo('listening');
    else if (state === 'processing') this.events.agentTo('thinking');
  }

  /**
   * Hands an event to this session's listeners through {@link emitEach}: a listener that throws or rejects is
   * reported, and the listeners after it still run. A listener that closes the call ends any event but `close` there,
   * as in the orchestrator's `_emitEach()`.
   *
   * @param event - The event.
   * @param args - What each listener is handed.
   */
  private emitEach(event: string, ...args: unknown[]): void {
    emitEach(this, event, args, (err, what) => this.listenerFailed(err, what, event), () => event !== 'close' && this.current === 'closed');
  }

  /**
   * A listener of one of the call's events threw or rejected: it is reported as the orchestrator's `'error'` and as a
   * recoverable `session_error`, except that a `session_error` listener's own failure raises no `session_error`.
   *
   * @param err - What the listener threw or rejected with.
   * @param what - What failed.
   * @param event - The event the listener was handed.
   */
  private listenerFailed(err: unknown, what: string, event: string): void {
    const error = this.report(err, what);
    if (event !== 'session_error') this.sessionError(error, true, 'session');
  }

  /**
   * Emits `session_error` on this session, which the orchestrator emits as well.
   *
   * @param error - The failure.
   * @param recoverable - `true` when the call goes on.
   * @param source - The part it came from.
   */
  sessionError(error: Error, recoverable: boolean, source: VoiceSessionErrorSource): void {
    this.events.emit('session_error', { error, recoverable, source, createdAt: Date.now() });
  }

  /**
   * Emits the `session_error` of each failure the call ends on that has not had one yet, in order: as the failure is
   * reported (`fail`), or as a close that one of the failure's `'error'` listeners makes ends the call before that.
   */
  private sendFailureEvents(): void {
    for (const { error, source } of this.failureEvents.splice(0)) this.sessionError(error, false, source);
  }

  private matches(event: AudioIdentity): boolean {
    return event?.scopeId === this.identity.scopeId && event.callId === this.identity.callId && event.turnId === this.identity.turnId && !!event.generation && sameVoiceGeneration(event.generation, this.identity.generation);
  }

  private live(generation: Readonly<VoiceGeneration>): boolean {
    return !this.stopping && this.current !== 'closed' && !this.detached && sameVoiceGeneration(generation, this.identity.generation);
  }

  /**
   * The call fails: `onFailure` and `failure` with the content-free code, as before; the session's `errorMonitor`
   * listeners get the content-free `Error('voice call failed (<code>)')`, whether or not it has an `'error'` listener,
   * then its `'error'` listeners, when it has any, and nothing is written when it has none; `session_error` carries
   * the same object with the part it came from, before the call closes (unless `managerOwned`), though one of those
   * listeners closes the call (`sendFailureEvents`).
   *
   * @param code - The content-free failure code.
   * @param source - The part that failed.
   */
  private fail(code: 'provider_failure' | 'transport_failure' | 'budget_exhausted', source: VoiceSessionErrorSource = 'session'): void {
    if (this.current === 'closed') return;
    this.profile.onFailure(code);
    this.emit('failure', { scopeId: this.identity.scopeId, callId: this.identity.callId, code });
    const error = new Error(`voice call failed (${code})`);
    this.failure ??= error;
    this.failureEvents.push({ error, source });
    this.report(error, 'the call failed', this, false);
    this.sendFailureEvents();
    if (!this.profile.managerOwned) void this.close(code).catch(() => { this.profile.onFailure('cleanup_incomplete'); });
  }

  private watch(emitter: EventEmitter, source: VoiceSessionErrorSource): void {
    emitter.on('error', () => this.fail('provider_failure', source));
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
    this.watch(this.profile.vadSession, 'vad');
    this.watch(this.profile.audioEndpointDetector, 'endpoint');
    this.transport.on('error', () => this.fail('transport_failure', 'transport'));
    this.transport.on('close', () => {
      if (this.current === 'closed') return;
      if (this.profile.managerOwned) this.fail('transport_failure', 'transport');
      else void this.close('transport_closed').catch(() => this.profile.onFailure('cleanup_incomplete'));
    });
    try {
      const stt = await this.sttProvider.startSession({ language: this.config.language, providerOptions: this.config.sttOptions, call: this.identity });
      this.watch(stt, 'stt');
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
          this.fail('provider_failure', 'stt');
          return;
        }
        this.transcriptWork = this.transcriptWork.then(async () => {
          if (!this.matches(event) || this.current === 'closed' || (this.stopping ? !this.draining || !event.isFinal : this.detached || this.changing)) return;
          this.emit('transcript', event);
          this.transcribed(event);
          if (!this.stopping) await this.profile.audioEndpointDetector.pushTranscript(event);
          if (this.matches(event) && (this.current as PipelineState) !== 'closed') await this.send({ type: 'transcript', text: event.text, isFinal: event.isFinal, confidence: event.confidence }, event.generation);
        }).catch(() => this.fail('provider_failure')).finally(() => { this.transcriptPending--; });
      });
      stt.on('stt:gap', (event: { lostMs: number }) => this.fan?.gap('provider', event.lostMs));
      stt.on('close', () => {
        if (!this.changing && this.current !== 'closed') this.fail('provider_failure', 'stt');
      });
      this.profile.vadSession.on('vad', (event: VadFrameEvent) => {
        if (!this.matches(event) || this.detached || this.changing || this.current === 'closed' || event.sequence <= this.vadSequence) return;
        // One VAD event per admitted frame, for that frame, with the frame's own duration.
        if (this.vadBusy || event.sequence !== this.inputSequence || event.durationMs !== this.inputDurationMs || event.source !== 'vad' || !Number.isFinite(event.durationMs) || event.durationMs <= 0 || event.durationMs > this.profile.maxInputSamples / 16) {
          this.fail('provider_failure', 'vad');
          return;
        }
        this.vadSequence = event.sequence;
        this.speechMs = event.speech ? this.speechMs + this.inputDurationMs : 0;
        // The user speaks from as much successive speech as interrupts the agent, until a frame of silence.
        if (event.speech ? this.speechMs >= this.profile.minSpeechMs : this.events.user === 'speaking') this.events.userTo(event.speech ? 'speaking' : 'listening');
        this.vadBusy = true;
        this.vadWork = this.profile.audioEndpointDetector.pushVadEvent(event).then(() => {
          if (this.matches(event) && this.speechMs >= this.profile.minSpeechMs && ['processing', 'speaking'].includes(this.current)) {
            void this.interrupt('speech').catch(() => this.fail('provider_failure'));
          }
        }).catch(() => this.fail('provider_failure', 'endpoint')).finally(() => { this.vadBusy = false; });
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
          this.fail('transport_failure', 'transport');
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

  /**
   * Emits `user_input_transcribed` for a transcript with words, and keeps the language of a final for its turn.
   *
   * @param event - The scoped transcript.
   */
  private transcribed(event: ScopedTranscriptEvent): void {
    if (!event.text.trim()) return;
    if (event.isFinal && event.language) this.turnLanguage = event.language;
    this.events.emit(
      'user_input_transcribed',
      transcribedEvent({ text: event.text, isFinal: event.isFinal, confidence: event.confidence, language: event.language, itemId: event.itemId, speakerId: speakerOf(event.words) })
    );
  }

  private acceptTurn(event: ScopedTurnCompleteEvent): void {
    if (this.stopping || !this.matches(event) || this.detached || this.changing || this.current !== 'listening') return;
    const language = this.turnLanguage;
    this.turnLanguage = undefined;
    this.emitEach('turn_complete', event);
    if ((this.current as PipelineState) !== 'listening' || this.detached || this.changing) return;
    // The turn joins the conversation as the agent takes it.
    this.events.emit('conversation_item_added', {
      item: { role: 'user', text: event.transcript, ...(language ? { language } : {}), source: 'speech', endpointReason: event.reason },
      createdAt: Date.now(),
    });
    if ((this.current as PipelineState) !== 'listening' || this.detached || this.changing) return;
    this.stateTo('processing');
    // A listener of the agent's move to thinking may have closed the call: a closed call takes the turn no further.
    if ((this.current as PipelineState) !== 'processing') return;
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
      await this.synthesize(inPart('agent', () => this.agent.sendText(event.transcript, metadata)), outputIdentity, 'reply');
    })().catch((err: unknown) => {
      if (this.live(generation)) this.fail('provider_failure', err instanceof PartFailure ? err.source : 'session');
    });
  }

  /**
   * Speaks one reply of `identity`'s generation through a new pull-contract TTS session and acknowledged playback;
   * `agent_done` goes out only once synthesis is complete, its final usage is reported and playback is acknowledged.
   * Its first word is `speech_created` (`source`) and makes the agent speak; once acknowledged, it joins the
   * conversation as played.
   */
  private async synthesize(tokens: AsyncIterable<string>, identity: AudioIdentity, source: 'reply' | 'say'): Promise<void> {
    const generation = identity.generation;
    if (++this.synthesisRequests > this.profile.maxSynthesisRequests) {
      this.fail('budget_exhausted');
      throw new Error('synthesis request bound');
    }
    const requestId = randomUUID();
    const tts = await inPartAsync('tts', () => this.ttsProvider.startSession({ voice: this.config.voice, format: this.transport.playbackFormat ?? this.config.format, providerOptions: this.config.ttsOptions, expressiveness: this.config.ttsExpressiveness, call: { ...identity, requestId } }));
    tts.on('error', () => {
      if (this.live(generation)) this.fail('provider_failure', 'tts');
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
        this.fail('provider_failure', 'tts');
      }
    });
    // A pull-contract producer hands every chunk to its sink; one emitted as audio breaks the contract.
    tts.on('audio', () => {
      if (this.live(generation)) this.fail('provider_failure', 'tts');
    });
    tts.on('flush_complete', () => {
      if (this.live(generation)) flushed = true;
    });
    tts.on('close', () => {
      if (this.tts === tts && this.live(generation) && !flushed) this.fail('provider_failure', 'tts');
    });
    tts.setAudioSink(async (chunk) => {
      if (!this.live(generation) || this.changing || chunk.scopeId !== identity.scopeId || chunk.callId !== identity.callId) throw new Error('stale synthesis');
      await played(queue, queue.enqueue(chunk));
    });
    this.stateTo('speaking');
    this.replyText = '';
    this.replying = true;
    await this.send({ type: 'agent_speaking', text: '' }, generation);
    let started = false;
    for await (const token of fromPart('agent', tokens)) {
      if (!this.live(generation)) return;
      if (!started) {
        // The first word: the speech is created, and the agent speaks.
        started = true;
        this.events.emit('speech_created', { source, userInitiated: source === 'say', createdAt: Date.now() });
        this.events.agentTo('speaking');
        if (!this.live(generation)) return;
      }
      text += token;
      this.replyText = text;
      if (text.length > this.profile.maxTextCharacters) {
        this.fail('budget_exhausted');
        throw new Error('text admission bound');
      }
      // Checked above: a session without writeTokens() never reaches the loop.
      await inPartAsync('tts', () => tts.writeTokens!(token));
    }
    if (!this.live(generation)) return;
    await inPartAsync('tts', () => tts.flush());
    await played(queue, queue.drain());
    if (!this.live(generation)) return;
    if (!flushed || !finalUsage) throw new PartFailure('tts');
    this.tts = undefined;
    tts.close();
    this.queue = undefined;
    await this.send({ type: 'agent_done', text, durationMs: queue.stats().playedMs }, generation);
    if (!this.live(generation)) return;
    // The reply played to its end: it joins the conversation as heard, and no later barge-in reports its text.
    this.replying = false;
    this.replyText = '';
    if (text) this.events.emit('conversation_item_added', { item: { role: 'assistant', text, playedText: text, interrupted: false }, createdAt: Date.now() });
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
    // A listener of the agent's move to thinking may have closed the call: a closed call speaks no prompt.
    if ((this.current as PipelineState) !== 'processing') return;
    this.changing = true;
    const generation = this.advance();
    const identity = copyAudioIdentity(this.identity);
    const tokens = typeof text === 'string' ? (async function* () { yield text; })() : text;
    const work = (async () => {
      await this.profile.onGeneration(generation);
      await this.resetInput();
      this.changing = false;
      if (this.live(generation)) await this.synthesize(tokens, identity, 'say');
    })();
    this.response = work.catch((err: unknown) => {
      if (this.live(generation)) this.fail('provider_failure', err instanceof PartFailure ? err.source : 'session');
    });
    await work;
  }

  /**
   * Advances the generation synchronously, then aborts the agent, cancels synthesis, clears playback, waits for the
   * old generation's inference fence and resets input before the call listens again. A reply or a prompt being spoken
   * joins the conversation as interrupted; when the user's speech interrupted it, `barge_in` says so first.
   *
   * @param cause - `'speech'` when the user's speech interrupts the agent; `'other'` for a mute, a gap or a detach.
   */
  private interrupt(cause: 'speech' | 'other' = 'other'): Promise<void> {
    if (this.current === 'closed' || this.changing) return this.transition;
    const interrupted = copyAudioIdentity(this.identity);
    const old = { ...this.identity.generation };
    // advance() clears the measure of the speech that interrupts.
    const speechDurationMs = this.speechMs;
    this.changing = true;
    const generation = this.advance();
    this.stateTo('interrupting');
    this.profile.onInterrupted(interrupted);
    this.emit('interrupted', interrupted);
    if (cause === 'speech') {
      // Speech while the call processes a turn cuts no reply: the text of the last one, which played, is not reported.
      this.events.emit('barge_in', { speechDurationMs, interruptedText: this.replying ? this.replyText : '', playedDurationMs: this.queue?.stats().playedMs ?? 0, action: 'cancel', createdAt: Date.now() });
    }
    if (this.replying) {
      this.replying = false;
      const text = this.replyText;
      this.replyText = '';
      // Which of its words were heard is not known here.
      if (text) this.events.emit('conversation_item_added', { item: { role: 'assistant', text, playedText: '', interrupted: true }, createdAt: Date.now() });
    }
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
  close(reason?: string): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.draining = false;
    const old = { ...this.identity.generation };
    this.stateTo('closed');
    this.detached = true;
    // A failure whose 'error' listener closed the call has its session_error before close.
    this.sendFailureEvents();
    // The call's events end here: the away timer stops, and nothing is emitted after close.
    this.events.close();
    this.emitEach('close', { reason: reason ?? 'closed', ...(this.failure ? { error: this.failure } : {}), createdAt: Date.now() });
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
