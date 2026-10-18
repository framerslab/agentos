/**
 * @file VoiceTurnCollector.ts
 * @description Subscribes to a voice session's events and maintains a running transcript buffer, turn counter, and
 * last-speaker tracker.
 *
 * ## Event bridging strategy
 *
 * The collector bridges a voice session's events into the typed `GraphEvent` stream consumed by the graph runtime. It
 * reads them under one of two sets of names ({@link VoiceTurnCollectorEvents}).
 *
 * A started `VoicePipelineSession`'s own events (`events: 'session'`), the names of `VoiceSessionEventMap`:
 *
 * | Session event                              | GraphEvent emitted     | Buffered? |
 * |--------------------------------------------|------------------------|-----------|
 * | `user_input_transcribed`, `isFinal: false` | `voice_transcript`     | No        |
 * | `user_input_transcribed`, `isFinal: true`  | `voice_transcript`     | Yes       |
 * | `conversation_item_added`, a user item     | `voice_turn_complete`  | N/A       |
 * | `barge_in`, `action: 'cancel'`             | `voice_barge_in`       | N/A       |
 *
 * A session's `barge_in` also reports speech that paused the reply (`'pause'`) and the reply going on after a false
 * interruption (`'resume'`); neither cut the reply, so neither reaches the graph.
 *
 * The names a host relays a pipeline's events under onto an emitter of its own (`events: 'relayed'`, the default):
 *
 * | Session event        | GraphEvent emitted       | Buffered? | Why                                                    |
 * |----------------------|--------------------------|-----------|--------------------------------------------------------|
 * | `interim_transcript` | `voice_transcript`       | No        | Partials are noisy and would duplicate final entries.   |
 * | `final_transcript`   | `voice_transcript`       | Yes       | Confirmed utterances form the canonical transcript.     |
 * | `turn_complete`      | `voice_turn_complete`    | N/A       | Marks endpoint detection; advances the turn counter.    |
 * | `barge_in`           | `voice_barge_in`         | N/A       | Signals user interruption for downstream handlers.      |
 *
 * A started session emits `turn_complete` as well, as a deprecated alias of its user items, so a collector reads it
 * under one set of names and never both: each turn counts once.
 *
 * ## Checkpoint restore
 *
 * The `initialTurnCount` constructor parameter enables checkpoint restore:
 * pass the previously persisted count so that `turnIndex` values continue
 * from where the session left off rather than resetting to zero. This is
 * critical for `maxTurns` enforcement across graph suspensions.
 *
 * See `VoiceNodeExecutor` for the owner of this collector during voice node execution.
 * @see {@link VoiceNodeCheckpoint} -- persists `turnIndex` and `transcript` across suspensions.
 */

import { EventEmitter } from 'events';
import type { GraphEvent } from '../events/GraphEvent.js';
import type { VoiceSessionEventMap } from '../../io/voice-pipeline/types.js';

// ---------------------------------------------------------------------------
// TranscriptEntry
// ---------------------------------------------------------------------------

/**
 * A single confirmed (final) utterance captured from the voice pipeline.
 *
 * Only final transcripts populate the transcript buffer -- interim
 * partials are discarded to keep the transcript clean and avoid duplicate
 * entries that would corrupt downstream summarisation.
 *
 * @example
 * ```ts
 * const entry: TranscriptEntry = {
 *   speaker: 'Speaker_0',
 *   text: 'Hello, how can I help you?',
 *   timestamp: Date.now(),
 * };
 * ```
 */
export interface TranscriptEntry {
  /**
   * Speaker identifier as reported by the STT service (e.g. `"Speaker_0"`).
   * Defaults to `"user"` when the STT service does not provide diarization labels.
   */
  speaker: string;

  /** Recognised text for this utterance. */
  text: string;

  /**
   * Wall-clock timestamp (milliseconds since Unix epoch) recorded at the
   * moment the final transcript was processed by the collector.
   *
   * This is the collector's receive time, not the STT service's recognition
   * time, so it includes any event loop latency between STT and the collector.
   */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The names a {@link VoiceTurnCollector} reads its session's events under.
 *
 * - `'relayed'`: `interim_transcript`, `final_transcript`, `turn_complete` and `barge_in`, the names a host relays a
 *   pipeline's events under onto an emitter of its own. The default.
 * - `'session'`: a started `VoicePipelineSession`'s own events (`VoiceSessionEventMap`): `user_input_transcribed`,
 *   `conversation_item_added` (its user items) and `barge_in`.
 */
export type VoiceTurnCollectorEvents = 'relayed' | 'session';

/** Options of a {@link VoiceTurnCollector}. */
export interface VoiceTurnCollectorOptions {
  /** The names the session's events are read under. @defaultValue 'relayed' */
  events?: VoiceTurnCollectorEvents;
}

// ---------------------------------------------------------------------------
// VoiceTurnCollector
// ---------------------------------------------------------------------------

/**
 * Stateful collector that subscribes to a voice session and routes
 * session events into the AgentOS `GraphEvent` stream.
 *
 * The collector is designed to be short-lived -- created at the start of a
 * voice node execution and released with {@link dispose} when the node
 * completes. Its state (transcript, turn count, last speaker) is captured into
 * a {@link VoiceNodeCheckpoint} by the executor before disposal.
 *
 * @example
 * ```ts
 * const collector = new VoiceTurnCollector(
 *   session, // a started VoicePipelineSession
 *   (evt) => graphEventEmitter.emit(evt),
 *   'voice-node-1',
 *   0,
 *   { events: 'session' },
 * );
 *
 * // After the conversation:
 * console.log(collector.getTurnCount());   // number of completed turns
 * console.log(collector.getTranscript());  // full buffered transcript
 * console.log(collector.getLastSpeaker()); // last identified speaker
 * collector.dispose();
 * ```
 *
 * @see {@link TranscriptEntry} -- shape of each buffered transcript entry.
 * See `VoiceNodeExecutor` for the executor that creates and queries the collector.
 */
export class VoiceTurnCollector {
  /** Buffered confirmed utterances in chronological order. Append-only. */
  private transcript: TranscriptEntry[] = [];

  /** Running count of completed turns (endpoint-detected). */
  private turnCount: number;

  /**
   * Speaker identifier from the most recent final transcript.
   * Empty string until the first final transcript arrives.
   */
  private lastSpeaker = '';

  /** The listeners this collector added to its session, each with its event, for {@link dispose}. */
  private readonly subscriptions: Array<{ event: string; listener: (...args: any[]) => void }> = [];

  /**
   * Creates a new VoiceTurnCollector and immediately subscribes to session events.
   *
   * Subscription is performed in the constructor (rather than a separate `init()`
   * method) because the collector has no meaningful state before subscription;
   * {@link dispose} removes every listener it added.
   *
   * @param session          - The voice session to subscribe to: a started
   *                           `VoicePipelineSession` with `events: 'session'`,
   *                           or an emitter of relayed events.
   * @param eventSink        - Callback invoked synchronously for every emitted
   *                           `GraphEvent`. Must not throw -- exceptions would
   *                           propagate into the session event loop.
   * @param nodeId           - Identifies the owning graph node in every emitted
   *                           event, enabling consumers to filter events by node.
   * @param initialTurnCount - Seed value for `turnCount`; pass a persisted value
   *                           to resume from a checkpoint rather than starting at
   *                           zero. Defaults to `0`.
   * @param options          - The names the session's events are read under.
   */
  constructor(
    private readonly session: EventEmitter,
    private readonly eventSink: (event: GraphEvent) => void,
    private readonly nodeId: string,
    initialTurnCount = 0,
    options: VoiceTurnCollectorOptions = {}
  ) {
    this.turnCount = initialTurnCount;
    if (options.events === 'session') this.subscribeSession();
    else this.subscribeRelayed();
  }

  /**
   * Removes every listener this collector added to its session. Safe to call more than once; the collector's state
   * stays readable.
   */
  dispose(): void {
    for (const { event, listener } of this.subscriptions.splice(0)) this.session.off(event, listener);
  }

  /**
   * Adds a listener to the session and records it for {@link dispose}.
   *
   * @param event    - The session's event.
   * @param listener - What the collector runs on it.
   */
  private listen(event: string, listener: (...args: any[]) => void): void {
    this.session.on(event, listener);
    this.subscriptions.push({ event, listener });
  }

  /** Reads a started `VoicePipelineSession`'s own events. */
  private subscribeSession(): void {
    // A transcript of the user's speech, interim or final.
    this.listen('user_input_transcribed', (evt: Partial<VoiceSessionEventMap['user_input_transcribed']> | undefined) => {
      const text = evt?.transcript ?? '';
      const confidence = evt?.confidence ?? 0;
      if (evt?.isFinal) this.final(text, evt.speakerId, confidence);
      else this.interim(text, evt?.speakerId, confidence);
    });

    // A user turn joined the conversation: the turn the endpoint detector completed. An agent reply is no turn.
    this.listen('conversation_item_added', (evt: Partial<VoiceSessionEventMap['conversation_item_added']> | undefined) => {
      const item = evt?.item;
      if (item?.role !== 'user') return;
      this.turn(item.text ?? '', item.endpointReason);
    });

    // The user's speech cut the reply. A pause, and the resume of a false interruption, left it playing.
    this.listen('barge_in', (evt: Partial<VoiceSessionEventMap['barge_in']> | undefined) => {
      if (evt?.action === 'cancel') this.bargeIn(evt);
    });
  }

  /** Reads the names a host relays a pipeline's events under. */
  private subscribeRelayed(): void {
    // ------------------------------------------------------------------
    // interim_transcript -- partial STT result, forwarded but NOT buffered.
    //
    // Why not buffer? Interim transcripts are speculative and frequently
    // revised by the STT engine. Buffering them would produce duplicate
    // or contradictory entries. They are forwarded as events so that UIs
    // can show live typing indicators.
    // ------------------------------------------------------------------
    this.listen('interim_transcript', (evt: any) => this.interim(evt?.text ?? '', evt?.speaker, evt?.confidence ?? 0));

    // ------------------------------------------------------------------
    // final_transcript -- confirmed utterance, buffered AND forwarded.
    //
    // This is the canonical source of truth for what was said. Every
    // confirmed utterance is appended to the transcript buffer and the
    // last-speaker tracker is updated.
    // ------------------------------------------------------------------
    this.listen('final_transcript', (evt: any) => this.final(evt?.text ?? '', evt?.speaker, evt?.confidence ?? 0));

    // ------------------------------------------------------------------
    // turn_complete -- endpoint detection fired; advance the turn counter.
    // ------------------------------------------------------------------
    this.listen('turn_complete', (evt: any) => this.turn(evt?.transcript ?? '', evt?.reason));

    // ------------------------------------------------------------------
    // barge_in -- user interrupted agent mid-speech.
    //
    // This event does not affect the turn count or transcript buffer
    // because the interruption itself is not a complete utterance. The
    // interrupted text (what the agent was saying) and the user's speech
    // (what triggered the interruption) are forwarded for downstream
    // handlers to process.
    // ------------------------------------------------------------------
    this.listen('barge_in', (evt: any) => this.bargeIn(evt));
  }

  /**
   * An interim transcript: forwarded, not buffered.
   *
   * @param text       - The transcript's text.
   * @param speaker    - The speaker, when the transcriber named one.
   * @param confidence - The transcriber's confidence.
   */
  private interim(text: string, speaker: string | undefined, confidence: number): void {
    this.eventSink({
      type: 'voice_transcript',
      nodeId: this.nodeId,
      text,
      isFinal: false,
      speaker,
      confidence,
    });
  }

  /**
   * A final transcript: buffered and forwarded. The speaker defaults to `'user'` when the STT service provides no
   * diarization labels, the most common single-speaker case, where the only speaker is the human user.
   *
   * @param text       - The transcript's text.
   * @param speaker    - The speaker, when the transcriber named one.
   * @param confidence - The transcriber's confidence.
   */
  private final(text: string, speaker: string | undefined, confidence: number): void {
    const who = speaker ?? 'user';
    // Buffer the confirmed entry for downstream consumers (checkpoint, summarisation, analytics).
    this.transcript.push({ speaker: who, text, timestamp: Date.now() });
    // Track the most recent speaker for quick access without iterating the entire buffer.
    this.lastSpeaker = who;
    this.eventSink({
      type: 'voice_transcript',
      nodeId: this.nodeId,
      text,
      isFinal: true,
      speaker: who,
      confidence,
    });
  }

  /**
   * A completed user turn. The counter is incremented BEFORE emitting the event so that the turnIndex in the emitted
   * event reflects the new (post-increment) count. This matches the semantics expected by VoiceNodeExecutor's maxTurns
   * check, which reads getTurnCount() after the event fires.
   *
   * @param transcript - The turn's text.
   * @param reason     - Why the endpoint detector ended the turn, when it said.
   */
  private turn(transcript: string, reason: string | undefined): void {
    this.turnCount++;
    this.eventSink({
      type: 'voice_turn_complete',
      nodeId: this.nodeId,
      transcript,
      turnIndex: this.turnCount,
      endpointReason: reason ?? 'unknown',
    });
  }

  /**
   * A barge-in: forwarded with what the agent was saying and, from a relayed event that names it, what the user said.
   *
   * @param evt - The event.
   */
  private bargeIn(evt: { interruptedText?: string; userSpeech?: string } | undefined): void {
    this.eventSink({
      type: 'voice_barge_in',
      nodeId: this.nodeId,
      interruptedText: evt?.interruptedText ?? '',
      userSpeech: evt?.userSpeech ?? '',
    });
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /**
   * Returns the total number of completed turns since construction (or since the
   * provided `initialTurnCount` when restoring from a checkpoint).
   *
   * @returns The current turn count. Always >= `initialTurnCount`.
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Returns a shallow copy of the buffered transcript entries.
   *
   * A copy is returned to prevent external callers from mutating the internal
   * buffer -- entries are append-only and must remain in chronological order
   * for correct checkpoint persistence.
   *
   * @returns A new array containing all confirmed transcript entries in order.
   */
  getTranscript(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /**
   * Returns the speaker identifier from the most recent final transcript,
   * or an empty string if no final transcript has been received yet.
   *
   * @returns The last speaker label, or `''` if none.
   */
  getLastSpeaker(): string {
    return this.lastSpeaker;
  }
}
