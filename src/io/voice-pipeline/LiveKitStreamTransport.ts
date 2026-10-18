/**
 * @module voice-pipeline/LiveKitStreamTransport
 *
 * A concrete {@link IPlaybackTransport} over a LiveKit room, for a server-side
 * agent that joined the room as a participant. Node only: it runs on
 * `@livekit/rtc-node`, an optional peer dependency.
 *
 * ## The linked participant
 * The transport hears and answers one remote participant, the linked one.
 * The `participant` option links one as LiveKit Agents' sessions do: an
 * identity at once, or with `'first'` the first participant in the room whose
 * kind is in `participantKinds` (STANDARD and SIP unless given) or, when the
 * room holds none, the first of them to join; participants of other kinds (an
 * agent, a recorder, an ingress) are passed over. `participantIdentity` links
 * one identity with the transport's own defaults. `setParticipant()` links
 * another participant at any time. While nobody is linked, the audio source
 * waits, `sendControl()` sends nothing and resolves, and every text stream
 * that arrives is closed unread.
 *
 * ## Audio (inbound)
 * One participant's microphone, read by {@link LiveKitRoomAudioSource} as
 * mono Float32 frames at the configured sample rate and emitted as `'audio'`.
 * While a consumer has emitted `'pause'`, frames are held up to `bufferMs`;
 * the oldest beyond it are dropped and reported as `'gap'` on `'resume'`.
 *
 * ## Text (both ways)
 * Control messages travel as LiveKit text streams on one topic (default
 * `'agentos.voice'`), to and from the selected participant alone; another
 * sender's stream on the topic is closed unread. `sendControl()` sends a JSON
 * {@link ServerTextMessage}; to a phone caller bridged by LiveKit SIP, which
 * reads no text streams, it sends nothing and resolves. Without a publisher,
 * every JSON message the participant sends is emitted as `'message'`, and a
 * message that is not JSON, or a text stream that fails while it is read,
 * emits `'error'` while the transport stays open.
 *
 * Text input, on by default with `participant` (the `textInput` option),
 * reads the text streams the linked participant sends on `'lk.chat'`, the
 * topic a LiveKit frontend's chat sends on and LiveKit Agents' sessions read,
 * on a handler of its own beside the control topic's. Each stream is read
 * with bounds when its reader has an async iterator (12000 bytes, enough for
 * every text the check accepts, and five seconds), else whole, and emitted as
 * a `text_input` message once `isClientTextInputMessage()` accepts it. A text
 * it refuses (empty, whitespace alone, over 4,000 characters), or a stream
 * that fails or passes the bounds, emits `'error'` with
 * `livekit text input refused`, which names no text, and the transport stays
 * open, with a publisher too. Another sender's stream, and every stream while
 * nobody is linked, is closed unread. A room that already handles the topic
 * keeps its handler: text input is off, and one warning line says so, through
 * `logger` when one is given.
 *
 * ## Audio (outbound)
 * Without the `publisher` option the transport publishes nothing:
 * `sendAudio()` and `waitForPlayback()` reject, and the rejection of
 * `sendAudio()` carries a handler of its own, so a caller that does not wait
 * for it raises no unhandled rejection. With it, the transport speaks on one
 * microphone track through {@link LiveKitAudioPublisher}: its input must be
 * mono at 16 kHz, `readyForPlayback()` publishes the track and waits, at most
 * `receiptTimeoutMs`, for a participant to subscribe to it (a first chunk
 * sent before then waits the same way), and `sendAudio()` takes raw or
 * WAV-wrapped PCM16. How a chunk counts as played is the publisher's playout
 * mode, fixed by `readyForPlayback()` or `sendAudio()` once the participant
 * is in the room; a chunk sent before then plays natively:
 * - Native playout, the default and the only mode for a SIP participant:
 *   every participant subscribed to the track hears it, chunks queue on the
 *   track in order, `waitForPlayback()` resolves once the track has played
 *   the chunk out, `waitForPlayout()` once it has played out every chunk
 *   sent, or rejects once a stalled track has taken nothing for
 *   `receiptTimeoutMs` plus `maxDurationMs` and what it had not played is
 *   discarded, a capture that never returns closing the transport,
 *   `clearPlayback()` needs no answer, and a `barge_in` message acts
 *   on the track as it is sent: a cancel clears it, a pause holds it, and a
 *   resume releases it, each at once, while the messages themselves reach
 *   the participant in the order they were sent, a cancel once its clear
 *   has finished or `receiptTimeoutMs` plus `maxDurationMs` have passed.
 * - Participant playout, when `publisher.playout` is `'participant'` or the
 *   participant's `agentos.playout` attribute is: one chunk at a time,
 *   announced to the participant, and `waitForPlayback()` resolves only after
 *   the native queue has drained and the participant has sent its playback
 *   receipt on the topic.
 *
 * With a publisher the participant's text streams are read with bounds (4096
 * bytes, five seconds, four at once) and only a playback or clear receipt, a
 * `transcript` message (as `isClientTranscriptMessage()` checks it) or a
 * `control` message with `mute`, `unmute` or `stop` is taken; anything else
 * is reported as `'error'` and closes the transport. Outbound text is bounded
 * as well: 16384 bytes a message, four in flight, and a send not done within
 * five seconds closes the transport.
 *
 * ## Lifetime
 * The linked participant leaving the room closes the transport while
 * `closeOnDisconnect` is on: by default with `participant`, listen-only or
 * speaking, and with `participantIdentity` only with a publisher. With it off
 * the transport stays open, and the participant rejoining under the same
 * identity is heard again. Another participant leaving changes nothing.
 * `close()` stops reading audio, drops the frames a pause held, unregisters
 * the topic, closes the text streams still arriving and emits `'close'` at
 * once; the room stays connected, because it belongs to the caller.
 * `whenClosed()` resolves once the native input reader has acknowledged its
 * cancellation, the input loop has ended, the text streams are closed and,
 * with a publisher, the track is unpublished and the track and its source are
 * closed; it rejects when any of that failed. A room that disconnects closes
 * the transport. A closed transport replays nothing on `'resume'`.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AudioFrame, IPlaybackTransport, EncodedAudioChunk, ClientTextMessage, ServerTextMessage, PlaybackReceipt, VoiceGeneration } from './types.js';
import { LiveKitAudioPublisher, isLiveKitSipParticipant, type LiveKitAudioPublisherOptions, type LiveKitPlayout } from './LiveKitAudioPublisher.js';
import { PlaybackAcknowledgementSchema } from './PlaybackAcknowledgements.js';
import { isClientTranscriptMessage } from './clientTranscript.js';
import { isClientTextInputMessage, MAX_TEXT_INPUT_LENGTH } from './clientTextInput.js';
import { LiveKitRoomAudioSource, type LiveKitParticipantLike, type LiveKitRoomLike, type LiveKitRtcModule, type LiveKitTextStreamReaderLike } from '../hearing/LiveKitRoomAudioSource.js';

/** The text stream topic of the control messages when none is configured. */
export const LIVEKIT_TRANSPORT_DEFAULT_TOPIC = 'agentos.voice';

/** The value of the `participant` option that links the first remote participant of a linked kind. */
const FIRST = 'first';

/** The kinds `'first'` links unless `participantKinds` names others: rtc-node's `ParticipantKind` STANDARD (0) and SIP (3). */
const LINKED_KINDS: readonly number[] = [0, 3];

/** rtc-node's `ParticipantKind.STANDARD`, the kind of a participant whose kind is not given. */
const KIND_STANDARD = 0;

/** The text stream topic text input reads unless `textInput` names another: LiveKit's chat topic. */
const TEXT_INPUT_TOPIC = 'lk.chat';

/**
 * The most a text-input stream is read to, in UTF-8 bytes: three a UTF-16 code unit, so every text
 * `isClientTextInputMessage()` accepts fits whole, in any script.
 */
const TEXT_INPUT_MAX_BYTES = MAX_TEXT_INPUT_LENGTH * 3;

/** A frame's length in milliseconds. */
const frameMs = (frame: AudioFrame): number => (frame.samples.length / frame.sampleRate) * 1000;

/**
 * The topic of a text input or output option: the one it names when it is on, `topic` when it is on and names none,
 * `undefined` when it is off. Unset, the option is on when `on` is.
 */
function optionTopic(option: boolean | { topic?: string } | undefined, on: boolean, topic: string): string | undefined {
  const value = option ?? on;
  if (value === false) return undefined;
  return value === true ? topic : value.topic ?? topic;
}

/** Options of {@link LiveKitStreamTransport}: the connected room, the participant it links and optional call-scoped publishing. */
export interface LiveKitStreamTransportOptions {
  /** A connected room (rtc-node `Room`) the agent joined. */
  room: LiveKitRoomLike;
  /**
   * Identity of the participant the agent hears and answers, linked with the transport's own defaults: no text input
   * and no transcription output unless set, and a close on the participant's departure only with `publisher` unless
   * `closeOnDisconnect` is set. Give exactly one of this and `participant`.
   */
  participantIdentity?: string;
  /**
   * The participant to link, with LiveKit Agents' session defaults: an identity, linked at once, or `'first'`, the
   * first remote participant whose kind is in `participantKinds`, in the room already or, when none is, the first of
   * them to join. With it, `closeOnDisconnect`, `textInput` and `transcriptionOutput` are on unless set. Give exactly
   * one of this and `participantIdentity`; a participant whose identity is `'first'` is linked with `setParticipant()`.
   */
  participant?: string | 'first';
  /**
   * The kinds `'first'` links, as rtc-node's `ParticipantKind` numbers them (STANDARD 0, INGRESS 1, EGRESS 2, SIP 3,
   * AGENT 4, CONNECTOR 5, BRIDGE 6); a participant whose kind is not given counts as STANDARD. Default `[0, 3]`,
   * STANDARD and SIP.
   */
  participantKinds?: readonly number[];
  /**
   * Close when the linked participant leaves the room, listen-only or speaking. Default `true` with `participant`;
   * with `participantIdentity`, a transport with `publisher` closes and a listen-only one stays open. `false` keeps
   * the transport open, and the participant rejoining under the same identity is heard again.
   */
  closeOnDisconnect?: boolean;
  /**
   * Read the text streams the linked participant sends on `topic` (`'lk.chat'` unless given) as `text_input` messages.
   * Default `true` with `participant`, `false` with `participantIdentity`. A stream is read with bounds (12000 bytes,
   * five seconds) when its reader has an async iterator, and a text `isClientTextInputMessage()` refuses emits
   * `livekit text input refused` while the transport stays open. A room that already handles the topic keeps it:
   * text input is off, and one warning line says so.
   */
  textInput?: boolean | { topic?: string };
  /**
   * Write the user's transcripts and the agent's played text as transcription text streams on `topic`
   * (`'lk.transcription'` unless given). Default `true` with `participant`, `false` with `participantIdentity`.
   */
  transcriptionOutput?: boolean | { topic?: string };
  /**
   * Takes the transport's warning lines: the line saying text input is off and, without a publisher, an error that
   * nothing listens for. Each is a console warning when omitted.
   */
  logger?: { warn(message: string): void };
  /**
   * Sample rate of the inbound frames, a whole number of samples per second;
   * match the STT (24000 for OpenAI Realtime transcription). Must be 16000
   * with `publisher`.
   */
  sampleRate: number;
  /** Text stream topic of the control messages. @defaultValue 'agentos.voice' */
  topic?: string;
  /**
   * Length of each inbound frame in milliseconds, a whole number that holds at
   * least one sample at `sampleRate`; rtc-node's default when omitted.
   */
  frameSizeMs?: number;
  /**
   * While the consumer has asked for a pause, frames are held up to this much
   * audio, a finite number of milliseconds of zero or more; beyond it the
   * oldest are dropped and reported as a `gap` on resume. Default 2000.
   */
  bufferMs?: number;
  /**
   * The `@livekit/rtc-node` module the host imports, which serves the publisher too unless `publisher.rtc` names
   * another; imported on first use when omitted.
   */
  rtc?: LiveKitRtcModule;
  /**
   * Speaks on one track of the room's local participant, which must offer
   * `publishTrack()` and `unpublishTrack()`, in native playout unless
   * `playout` or the participant asks for receipts. Absent means listen-only:
   * audio output is rejected.
   */
  publisher?: LiveKitAudioPublisherOptions;
}

/**
 * Closes a text stream reader, releasing what it holds (rtc-node's reader keeps
 * its subscription until its stream ends or it is closed). A reader without
 * `close()` is left to end with its stream.
 */
function closeTextReader(reader: LiveKitTextStreamReaderLike): void { void reader.close?.().catch(() => {}); }

/** The control messages a speaking transport takes besides playback receipts and transcript messages. */
const controlSchema = z.strictObject({ type: z.literal('control'), action: z.strictObject({ type: z.enum(['mute', 'unmute', 'stop']) }) });

/**
 * {@link IPlaybackTransport} over a LiveKit room: inbound audio from one
 * participant, control messages as text streams on a topic and, with
 * `publisher`, the agent's audio on one published track, which every
 * participant subscribed to it hears.
 *
 * ## Events emitted
 *
 * | Event       | Payload                   | Description                                   |
 * |-------------|---------------------------|-----------------------------------------------|
 * | `'audio'`   | `AudioFrame`              | The participant's audio, mono Float32.        |
 * | `'gap'`     | `{ droppedMs: number, reason: 'paused' }` | Audio dropped beyond the paused buffer, reported on resume before held frames; a pause asked again during the replay stops it, and the frames not yet emitted stay held. |
 * | `'message'` | {@link ClientTextMessage} | A JSON message from the participant on the topic; with a publisher, only a `transcript` message or a `control` message with `mute`, `unmute` or `stop`. With text input, also a `text_input` message for each text the linked participant sends on the text-input topic. |
 * | `'close'`   | *(none)*                  | The transport closed: `close()`, the room disconnecting, the linked participant leaving while `closeOnDisconnect` is on or, with a publisher, a refused message or a capture that never returned. |
 * | `'error'`   | `Error`                   | A message that is not JSON, a text stream of the participant's that fails while it is read, a failure to read audio (the peer missing among them), a text input refused (`livekit text input refused`, which leaves the transport open), or cleanup after `close()` that did not complete (`livekit cleanup incomplete`); with a publisher, also a refused message, and a capture that never returned (`livekit output stalled`), which closes the transport. |
 *
 * Without a publisher, an error that nothing listens for is written as a
 * console warning instead, since an `'error'` that nothing listens for would
 * throw. With a publisher, errors carry fixed messages (`livekit input
 * failed`, `livekit control refused`, `livekit output stalled`, `livekit
 * cleanup incomplete`), and one that nothing listens for is dropped. A room or selected participant loss
 * closes this physical path; `CallTransportBinding` interprets it as a detach.
 *
 * @example
 * ```typescript
 * const transport = new LiveKitStreamTransport({
 *   room,
 *   participantIdentity: 'user-1',
 *   sampleRate: 24_000,
 * });
 * transport.on('audio', (frame) => sttSession.pushAudio(frame));
 * await transport.sendControl({ type: 'agent_thinking' });
 * ```
 */
export class LiveKitStreamTransport extends EventEmitter implements IPlaybackTransport {
  readonly id = randomUUID();
  /** `'pcm'` with a publisher, which plays raw or WAV PCM16 alone; `undefined` for a listen-only transport. */
  readonly playbackFormat?: 'pcm';
  private _state: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  private readonly topic: string;
  private readonly source: LiveKitRoomAudioSource;
  private readonly publisher?: LiveKitAudioPublisher;
  private readonly bufferMs: number;
  private paused = false;
  private readonly held: AudioFrame[] = [];
  private heldMs = 0;
  private droppedMs = 0;
  /** The participant's text streams being read; {@link close} closes them. */
  private readonly readers = new Set<LiveKitTextStreamReaderLike>();
  /**
   * The linked participant's text-input streams being read, apart from the control topic's, so a chat in flight never
   * counts against the four control streams a speaking transport reads at once; {@link close} closes them too.
   */
  private readonly textInputReaders = new Set<LiveKitTextStreamReaderLike>();
  private closing: Promise<void> = Promise.resolve();
  private sendingControls = 0;
  /**
   * Settles once the last control message that had to wait has gone out or failed: a cancel waiting for its clear, or a
   * message asked for while one waits. It never rejects.
   */
  private controls: Promise<void> = Promise.resolve();
  /** How many control messages wait to go out, behind a cancel's clear or behind a message that waits. */
  private waitingControls = 0;
  private readonly inputPump: Promise<void>;
  /** The identity of the participant the transport hears and answers; `undefined` while `'first'` waits for one. */
  private linked: string | undefined;
  /** The kinds `'first'` links. */
  private readonly kinds: readonly number[];
  /** Whether `'first'` waits for a participant of a linked kind to join. */
  private waitingForFirst = false;
  /** The topic text input holds, or `undefined` while text input is off. */
  private readonly textInputTopic: string | undefined;
  /** Whether the linked participant leaving the room closes the transport: `closeOnDisconnect`, or its default. */
  private readonly closeOnDeparture: boolean;

  /**
   * @throws {Error} `invalid livekit input bound` when `bufferMs` is not a
   *   finite number of zero or more, or when `publisher` is given and
   *   `sampleRate` is not 16000.
   * @throws {Error} `LiveKitStreamTransport: give exactly one of
   *   participantIdentity and participant` when both are given, neither is,
   *   or `participant` is empty.
   * @throws {RangeError} When `sampleRate` or `frameSizeMs` is refused, as
   *   {@link LiveKitRoomAudioSource} refuses them.
   * @throws {Error} When `publisher` is given and the room's local participant
   *   cannot publish a track, or a publisher bound is refused.
   * @throws {Error} When the room already has a text stream handler for the
   *   topic (rtc-node allows one per topic). Every refusal before this one
   *   leaves the topic free, and nothing listens to the room. A room that
   *   already handles the text-input topic is no refusal: text input is off.
   */
  constructor(private readonly options: LiveKitStreamTransportOptions) {
    super(); this.topic = options.topic ?? LIVEKIT_TRANSPORT_DEFAULT_TOPIC; this.bufferMs = options.bufferMs ?? 2000;
    if (!Number.isFinite(this.bufferMs) || this.bufferMs < 0 || (options.publisher && options.sampleRate !== 16000)) throw new Error('invalid livekit input bound');
    // `participant` follows LiveKit Agents' session conventions; `participantIdentity` keeps the transport's own defaults.
    const conventions = options.participant !== undefined;
    if (conventions === (options.participantIdentity !== undefined) || options.participant === '') throw new Error('LiveKitStreamTransport: give exactly one of participantIdentity and participant');
    this.kinds = options.participantKinds ?? LINKED_KINDS;
    this.linked = options.participant === FIRST ? this.firstOfKind() : options.participant ?? options.participantIdentity;
    // The source checks the options before the topic is taken, so a refused
    // option leaves the topic free; until it is read, the source holds nothing.
    this.source = new LiveKitRoomAudioSource({ room: options.room, participantIdentity: this.linked,
      sampleRate: options.sampleRate, frameSizeMs: options.frameSizeMs, rtc: options.rtc, strictMono: !!options.publisher });
    if (options.publisher) {
      this.playbackFormat = 'pcm';
      this.publisher = new LiveKitAudioPublisher(options.publisher, options.room.localParticipant, (message) => this.sendWire(message), {
        rtc: options.rtc, participant: () => this.linkedParticipant(),
        // A capture that never returned leaves the track unable to take audio: the path closes, as it does for a control
        // message not sent within five seconds, once the messages already waiting, a cancel among them, have gone out.
        stalled: () => { this.emitErrorSafe(new Error('livekit output stalled')); void this.controls.then(() => this.close()); },
      });
    }
    this.on('pause', () => { if (this._state === 'open') this.paused = true; });
    this.on('resume', () => {
      if (this._state !== 'open') return; this.paused = false;
      if (this.droppedMs > 0) { this.emit('gap', { droppedMs: this.droppedMs, reason: 'paused' }); this.droppedMs = 0; }
      // one frame at a time: a listener that asks for a pause again while it takes a frame stops the replay there, and
      // the frames not yet emitted stay held, in order, with their length
      while (this.held.length > 0 && !this.paused && this._state === 'open') {
        const frame = this.held.shift()!;
        this.heldMs = this.held.length > 0 ? this.heldMs - frameMs(frame) : 0;
        this.emit('audio', frame);
      }
    });
    options.room.registerTextStreamHandler(this.topic, this.onText);
    // rtc-node takes one handler a topic: a room that already handles the text-input topic keeps it, and text input is off.
    let textInputTopic = optionTopic(options.textInput, conventions, TEXT_INPUT_TOPIC);
    if (textInputTopic !== undefined) {
      try { options.room.registerTextStreamHandler(textInputTopic, this.onTextInput); }
      catch { this.warn(`LiveKitStreamTransport: text input is off, the room already handles the ${textInputTopic} topic`); textInputTopic = undefined; }
    }
    this.textInputTopic = textInputTopic;
    // With `participantIdentity` and no `closeOnDisconnect`, only a speaking transport closes when the participant leaves.
    this.closeOnDeparture = options.closeOnDisconnect ?? (conventions || !!options.publisher);
    if (this.closeOnDeparture) options.room.on('participantDisconnected', this.participantDisconnected);
    // 'first' with nobody of a linked kind in the room links the first of them to join.
    if (options.participant === FIRST && this.linked === undefined) { this.waitingForFirst = true; options.room.on('participantConnected', this.participantConnected); }
    this.inputPump = this.pump();
  }
  /** Identity of the linked participant, or `undefined` while `'first'` waits for one to join. */
  get participantIdentity(): string | undefined { return this.linked; }
  /**
   * Links another participant: the audio source moves to its microphone, its frames carrying its identity as
   * `speakerHint`, the control topic and text input take its streams alone, control messages go to it, and the
   * departure that closes the transport is its departure. A `'first'` wait ends. A transport that is not open, or the
   * participant linked already, changes nothing.
   *
   * @param identity - The participant's identity.
   * @throws {Error} When `identity` is empty.
   */
  setParticipant(identity: string): void {
    if (typeof identity !== 'string' || identity === '') throw new Error('LiveKitStreamTransport: setParticipant needs a participant identity');
    if (this._state === 'open') this.link(identity);
  }
  /** Links the participant with the identity, ending a `'first'` wait. */
  private link(identity: string): void {
    this.stopWaitingForFirst();
    if (identity === this.linked) return;
    this.linked = identity; this.source.setParticipant(identity);
  }
  /** The first remote participant in the room, in the room's order, whose kind `'first'` links. */
  private firstOfKind(): string | undefined {
    for (const participant of this.options.room.remoteParticipants.values()) {
      if (this.kinds.includes(participant.kind ?? KIND_STANDARD)) return participant.identity;
    }
    return undefined;
  }
  private stopWaitingForFirst(): void {
    if (!this.waitingForFirst) return;
    this.waitingForFirst = false; this.options.room.off('participantConnected', this.participantConnected);
  }
  /** While `'first'` waits, links the first participant of a linked kind to join; one of another kind is passed over. */
  private readonly participantConnected = (participant: LiveKitParticipantLike): void => {
    if (this.waitingForFirst && this.kinds.includes(participant.kind ?? KIND_STANDARD)) this.link(participant.identity);
  };
  /** Physical state; call reconnecting state remains the manager's responsibility. */
  get state(): 'connecting' | 'open' | 'closing' | 'closed' { return this._state; }
  /**
   * The publisher's playout mode once `readyForPlayback()` or `sendAudio()` fixed it, which waits for the participant
   * to be in the room; `undefined` before, and for a listen-only transport.
   */
  get playout(): LiveKitPlayout | undefined { return this.publisher?.playout; }
  /**
   * Publishes the one speaking track and waits for a participant to subscribe to it, at most
   * `publisher.receiptTimeoutMs`. Listen-only readiness allocates nothing.
   */
  async readyForPlayback(): Promise<void> { if (this._state !== 'open') throw new Error('transport closed'); await this.publisher?.ready(); }
  /** Listen-only construction still rejects; speaking delegates to the one native conversion boundary. */
  sendAudio(chunk: EncodedAudioChunk): Promise<void> {
    const result = this.publisher ? this.publisher.sendAudio(chunk) : Promise.reject(new Error('LiveKitStreamTransport does not publish audio: it carries what the agent hears and its control messages'));
    result.catch(() => {}); return result;
  }
  /** Resolves once the chunk has played: in native playout once the track has played it out, in participant playout once the native queue has drained and the participant's receipt has come. */
  waitForPlayback(generation: VoiceGeneration, sequence: number, signal: AbortSignal): Promise<PlaybackReceipt> {
    if (!this.publisher) return Promise.reject(new Error('LiveKitStreamTransport does not publish audio'));
    return this.publisher.waitForPlayback(generation, sequence, signal);
  }
  /**
   * Resolves once the track has played out what the transport was handed: every chunk sent so far, and any sent while
   * it waits; what a clear or a pause discarded counts as played out, and a clear or a close ends the wait at once. A
   * track that takes no frame and plays nothing out for `publisher.receiptTimeoutMs` plus `publisher.maxDurationMs`,
   * outside a pause, has stalled: what it had not played is discarded and the wait rejects with
   * `publisher drain timeout`. A capture that does not return within the same bound, whoever waits for it, makes the
   * transport emit `livekit output stalled` and close, once the control messages already waiting have gone out. A
   * listen-only transport resolves at once. An aborted `signal` rejects the wait at once
   * (`publisher playout wait aborted`), as a session aborts it when a barge-in cuts the reply or the session closes.
   *
   * @param signal - Ends the wait when aborted.
   */
  async waitForPlayout(signal?: AbortSignal): Promise<void> { await this.publisher?.waitForPlayout(signal); }
  /** Discards only this physical path's queued output; a closed path must finish native cleanup. */
  async clearPlayback(generation: VoiceGeneration): Promise<void> {
    if (this._state === 'closed') { await this.closing; return; }
    await this.publisher?.clearPlayback(generation);
  }
  /**
   * Sends one JSON text stream to the participant on the topic. With a
   * publisher, a message is at most 16384 bytes, at most four are in flight,
   * and a send not done within five seconds closes the transport.
   */
  private async sendWire(message: unknown): Promise<void> {
    if (this._state !== 'open') throw new Error('LiveKitStreamTransport: cannot send while ' + this._state); if (!this.options.room.localParticipant) throw new Error('LiveKitStreamTransport: the room has no local participant; connect it first');
    // While nobody is linked there is nobody to send to.
    const to = this.linked; if (to === undefined) return;
    const text = JSON.stringify(message);
    if (this.publisher && (Buffer.byteLength(text) > 16384 || this.sendingControls >= 4)) throw new Error('livekit control bound');
    this.sendingControls++; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.options.room.localParticipant.sendText(text, { topic: this.topic, destinationIdentities: [to] });
      if (!this.publisher) { await work; return; }
      await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.close(); reject(new Error('livekit control timeout')); }, 5000); })]);
    } finally { if (timer) clearTimeout(timer); this.sendingControls--; }
  }
  /**
   * Sends one JSON message to the participant as a text stream on the topic. Existing server messages retain their
   * wire representation; call-profile messages carry their captured scope and generation. A SIP participant reads no
   * text streams, so nothing is sent to one and the send resolves, as it does while nobody is linked. Outside
   * participant playout a `barge_in` message first acts on the track, as a page acts on the audio it plays: a `cancel`
   * clears what the track holds, a `pause` holds the track (`LiveKitAudioPublisher.pause()`) and a `resume` releases
   * it, each at once. Messages go out in the
   * order they were asked for. A `cancel` goes out once its clear has finished, or once the publisher's
   * `receiptTimeoutMs` plus `maxDurationMs` have passed, so a capture that never returns does not hold it; a message
   * asked for while it waits, a `resume` for the next reply among them, waits behind it, and they go out one at a time
   * once it has; at most 64 messages wait, the `cancel` included (`livekit control bound` beyond). A message with nothing waiting ahead
   * of it goes out within the call, beside any still going out.
   *
   * @throws {Error} When the transport is not open or the room has no local participant, and `livekit control bound`
   *   when 64 messages wait already.
   */
  async sendControl(message: ServerTextMessage): Promise<void> {
    if (this._state !== 'open') throw new Error('LiveKitStreamTransport: cannot send while ' + this._state);
    // The barge-in action the track takes, outside participant playout.
    const action = message.type === 'barge_in' && this.publisher && this.publisher.playout !== 'participant' ? message.action : undefined;
    const previous = this.waitingControls > 0 ? this.controls : undefined;
    // A message that would wait is refused, before it acts on the track, once 64 wait already.
    if ((previous || action?.type === 'cancel') && this.waitingControls >= 64) throw new Error('livekit control bound');
    let cleared: Promise<void> | undefined;
    if (action?.type === 'cancel') {
      cleared = this.publisher!.clearPlayback();
      // Handled here as well, so a clear that fails while an earlier message is still going out is no unhandled rejection.
      cleared.catch(() => {});
    } else if (action?.type === 'pause') this.publisher!.pause();
    else if (action?.type === 'resume') this.publisher!.resume();
    if (!previous && !cleared) {
      if (this.nobodyReads()) return;
      return this.sendWire(message);
    }
    this.waitingControls++;
    const sent = (async () => {
      try {
        // The messages that wait go out one at a time, each once the one ahead of it has gone out or failed.
        if (previous) await previous;
        if (cleared) await this.clearOrDeadline(cleared);
      } finally { this.waitingControls--; }
      if (this.nobodyReads()) return;
      await this.sendWire(message);
    })();
    // A failed message is its caller's to report; the messages behind it still go out.
    this.controls = sent.catch(() => {});
    return sent;
  }
  /**
   * Waits for a cancel's clear, at most the publisher's `receiptTimeoutMs` plus `maxDurationMs`, the bound of its playout
   * wait: a clear whose capture never returns does not hold the cancel and the messages behind it. A clear that fails
   * rejects.
   */
  private async clearOrDeadline(cleared: Promise<void>): Promise<void> {
    const { receiptTimeoutMs, maxDurationMs } = this.options.publisher!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleared, new Promise<void>((resolve) => { timer = setTimeout(resolve, receiptTimeoutMs + maxDurationMs); })]);
    } finally { clearTimeout(timer); }
  }
  /** The participant the transport hears and answers, while it is linked and in the room. */
  private linkedParticipant(): LiveKitParticipantLike | undefined { return this.linked === undefined ? undefined : this.options.room.remoteParticipants.get(this.linked); }
  /** Whether a control message has nobody to read it: nobody is linked, or the linked participant is a phone caller. */
  private nobodyReads(): boolean { return this.linked === undefined || isLiveKitSipParticipant(this.linkedParticipant()); }
  /** Stops input synchronously without disconnecting the host-owned room. Native cleanup is awaited through whenClosed. */
  close(_code?: number, _reason?: string): void {
    if (this._state === 'closing' || this._state === 'closed') return; this._state = 'closing';
    this.options.room.unregisterTextStreamHandler(this.topic);
    // Only a topic the transport holds is let go: a room that already handled the text-input topic keeps its handler.
    if (this.textInputTopic !== undefined) this.options.room.unregisterTextStreamHandler(this.textInputTopic);
    if (this.closeOnDeparture) this.options.room.off('participantDisconnected', this.participantDisconnected);
    this.stopWaitingForFirst();
    // what a pause held goes with the transport: a resume after the close emits none of it, and no gap
    this.source.close(); this.held.length = 0; this.heldMs = 0; this.droppedMs = 0;
    const readers = [...this.readers, ...this.textInputReaders]; this.readers.clear(); this.textInputReaders.clear();
    this.closing = (async () => {
      const results = await Promise.allSettled([this.source.whenClosed(), this.inputPump, this.publisher?.close() ?? Promise.resolve(), ...readers.map((reader) => reader.close?.() ?? Promise.resolve())]);
      if (results.some((r) => r.status === 'rejected')) throw new Error('livekit cleanup incomplete');
    })();
    this.closing.catch(() => this.emitErrorSafe(new Error('livekit cleanup incomplete')));
    this._state = 'closed'; this.emit('close');
  }
  /** Positive native unpublish/disposal acknowledgement; rejection leaves the manager's media fence incomplete. */
  whenClosed(): Promise<void> { return this._state === 'closed' ? this.closing : Promise.reject(new Error('transport still open')); }
  private readonly participantDisconnected = (participant: { identity: string }): void => { if (participant.identity === this.linked) this.close(); };
  /** Emits the participant's frames until the source ends, then closes. */
  private async pump(): Promise<void> {
    try {
      for await (const frame of this.source) {
        if (this._state !== 'open') break;
        if (!this.paused) { this.emit('audio', frame); continue; }
        this.held.push(frame); this.heldMs += frameMs(frame);
        while (this.heldMs > this.bufferMs && this.held.length) {
          const oldMs = frameMs(this.held.shift()!); this.heldMs -= oldMs; this.droppedMs += oldMs;
        }
      }
    } catch (error) { this.emitErrorSafe(this.publisher ? new Error('livekit input failed') : error instanceof Error ? error : new Error(String(error))); }
    finally { if (this._state === 'open') this.close(); }
  }
  /** Reads one text stream through its async iterator: at most `maxBytes` bytes within five seconds, then closes it. */
  private async readBounded(reader: LiveKitTextStreamReaderLike, maxBytes = 4096): Promise<string> {
    if (!reader[Symbol.asyncIterator]) throw new Error('bounded text reader required');
    let total = 0; let text = ''; let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      const iterator = reader[Symbol.asyncIterator]!();
      try {
        for (;;) { const next = await iterator.next(); if (next.done) return text;
          total += Buffer.byteLength(next.value); if (total > maxBytes) throw new Error('text bound'); text += next.value;
        }
      } finally { await reader.close?.(); }
    })();
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { closeTextReader(reader); reject(new Error('text deadline')); }, 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private readonly onText = (reader: LiveKitTextStreamReaderLike, participant: { identity: string }): void => {
    // Another sender's stream, one that came while nobody is linked, or one that came as the transport closed: released unread.
    if (participant.identity !== this.linked || this._state !== 'open') { closeTextReader(reader); return; }
    if (this.publisher && this.readers.size >= 4) { closeTextReader(reader); this.emitErrorSafe(new Error('livekit control refused')); this.close(); return; }
    this.readers.add(reader);
    const read = this.publisher ? this.readBounded(reader) : reader.readAll();
    void read.then((text) => {
      if (this._state !== 'open') return; let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('LiveKitStreamTransport: failed to parse inbound text message as JSON'); }
      if (this.publisher) {
        const receipt = PlaybackAcknowledgementSchema.safeParse(value);
        if (receipt.success) { this.publisher.receiveReceipt(receipt.data); return; }
        // A page that transcribes on its own device sends its lines, which a session without a call profile reads.
        this.emit('message', isClientTranscriptMessage(value) ? value : controlSchema.parse(value));
      } else this.emit('message', value as ClientTextMessage);
    }).catch((error: unknown) => {
      if (this._state !== 'open') return;
      this.emitErrorSafe(this.publisher ? new Error('livekit control refused') : error instanceof Error ? error : new Error(String(error)));
      if (this.publisher) this.close();
    }).finally(() => { this.readers.delete(reader); });
  };
  /**
   * Takes a stream on the text-input topic. The linked participant's, while the transport is open, is read, with bounds
   * when its reader has an async iterator and whole otherwise, and emitted as a `text_input` message once
   * `isClientTextInputMessage()` accepts it; a text it refuses, or a stream that fails or passes the bounds, emits
   * `livekit text input refused` and the transport stays open. Any other stream is closed unread.
   */
  private readonly onTextInput = (reader: LiveKitTextStreamReaderLike, participant: { identity: string }): void => {
    if (participant.identity !== this.linked || this._state !== 'open') { closeTextReader(reader); return; }
    this.textInputReaders.add(reader);
    const read = reader[Symbol.asyncIterator] ? this.readBounded(reader, TEXT_INPUT_MAX_BYTES) : reader.readAll();
    // The error names the refusal, never the text.
    const refused = (): void => { if (this._state === 'open') this.emitErrorSafe(new Error('livekit text input refused')); };
    void read.then((text) => {
      if (this._state !== 'open') return;
      const message = { type: 'text_input' as const, text };
      if (isClientTextInputMessage(message)) this.emit('message', message); else refused();
    }, refused)
      // A 'message' listener that throws is reported as the transport's error, as the control topic reports one.
      .catch((error: unknown) => { if (this._state === 'open') this.emitErrorSafe(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { this.textInputReaders.delete(reader); });
  };
  /**
   * Emit `'error'` only when a listener exists: an unlistened EventEmitter
   * `'error'` throws and takes the whole process down.
   */
  private emitErrorSafe(error: Error): void {
    if (this.listenerCount('error')) this.emit('error', error);
    else if (!this.publisher) this.warn('[livekit-stream-transport] error (no listener attached):', error.message);
  }
  /** Writes one warning line through the host's `logger`, else as a console warning. */
  private warn(...parts: string[]): void {
    if (this.options.logger) this.options.logger.warn(parts.join(' '));
    else console.warn(...parts);
  }
}
