/**
 * @module voice-pipeline/LiveKitStreamTransport
 *
 * A concrete {@link IStreamTransport} over a LiveKit room, for a server-side
 * agent that joined the room as a participant. Node only: it runs on
 * `@livekit/rtc-node`, an optional peer dependency.
 *
 * ## Wire protocol
 *
 * ### Audio (inbound)
 * One participant's microphone, read by {@link LiveKitRoomAudioSource} as
 * mono Float32 frames at the configured sample rate and emitted as `'audio'`.
 *
 * ### Text (both ways)
 * Control messages travel as LiveKit text streams on one topic (default
 * `'agentos.voice'`): `sendControl()` sends a JSON {@link ServerTextMessage}
 * to the participant, and a JSON {@link ClientTextMessage} the participant
 * sends on the topic is emitted as `'message'`; another sender's stream on
 * the topic is closed unread. A message that is not JSON, or a text stream of
 * the participant's that fails while it is read, emits `'error'`, and the
 * transport stays open.
 *
 * ### Audio (outbound)
 * This transport does not publish audio: `sendAudio()` rejects. It carries
 * what an agent hears and its control messages; an agent that speaks
 * publishes its own track. The rejection carries a handler of its own, so a
 * caller that does not wait for it raises no unhandled rejection.
 * `VoicePipelineOrchestrator` reports the first refused chunk of each reply as
 * its `'error'`, or as a console warning when nothing listens for `'error'`,
 * and not the rest of that reply's chunks.
 *
 * ## Lifetime
 * `close()` stops reading audio, drops the frames a pause held, closes the text
 * streams still arriving, unregisters the topic and emits `'close'`; the room
 * stays connected, because it belongs to the caller. A room that disconnects
 * closes the transport. A closed transport replays nothing on `'resume'`.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AudioFrame,
  IStreamTransport,
  EncodedAudioChunk,
  ClientTextMessage,
  ServerTextMessage,
} from './types.js';
import {
  LiveKitRoomAudioSource,
  type LiveKitRoomLike,
  type LiveKitRtcModule,
  type LiveKitTextStreamReaderLike,
} from '../hearing/LiveKitRoomAudioSource.js';

/** The text stream topic of the control messages when none is configured. */
export const LIVEKIT_TRANSPORT_DEFAULT_TOPIC = 'agentos.voice';

/** A frame's length in milliseconds. */
const frameMs = (frame: AudioFrame): number => (frame.samples.length / frame.sampleRate) * 1000;

/** Options of {@link LiveKitStreamTransport}. */
export interface LiveKitStreamTransportOptions {
  /** A connected room (rtc-node `Room`) the agent joined. */
  room: LiveKitRoomLike;
  /** Identity of the participant the agent hears and answers. */
  participantIdentity: string;
  /**
   * Sample rate of the inbound frames, a whole number of samples per second;
   * match the STT (24000 for OpenAI Realtime transcription).
   */
  sampleRate: number;
  /** Text stream topic of the control messages. @defaultValue 'agentos.voice' */
  topic?: string;
  /**
   * Length of each inbound frame in milliseconds, a whole number that holds at
   * least one sample at `sampleRate`; rtc-node's default when omitted.
   */
  frameSizeMs?: number;
  /** While the consumer has asked for a pause, frames are held up to this much audio; beyond it the oldest are dropped and a `gap` is emitted on resume. Default 2000. */
  bufferMs?: number;
  /** The `@livekit/rtc-node` module the host imports; imported on first use when omitted. */
  rtc?: LiveKitRtcModule;
}

/**
 * Closes a text stream reader, releasing what it holds (rtc-node's reader keeps
 * its subscription until its stream ends or it is closed). A reader without
 * `close()` is left to end with its stream.
 */
function closeTextReader(reader: LiveKitTextStreamReaderLike): void {
  reader.close?.().catch(() => {
    // The stream already ended or failed; nothing is left to release.
  });
}

/**
 * {@link IStreamTransport} over a LiveKit room: inbound audio from one
 * participant, control messages as text streams on a topic.
 *
 * ## Events emitted
 *
 * | Event       | Payload                   | Description                                   |
 * |-------------|---------------------------|-----------------------------------------------|
 * | `'audio'`   | `AudioFrame`              | The participant's audio, mono Float32.        |
 * | `'gap'`     | `{ droppedMs: number, reason: 'paused' }` | Audio dropped beyond the paused buffer, reported on resume before held frames; a pause asked again during the replay stops it, and the frames not yet emitted stay held. |
 * | `'message'` | {@link ClientTextMessage} | A JSON message from the participant on the topic. |
 * | `'close'`   | *(none)*                  | The transport closed (or the room disconnected). |
 * | `'error'`   | `Error`                   | A message that is not JSON, a text stream of the participant's that fails while it is read, or a failure to read audio (the peer missing among them). |
 *
 * With no `'error'` listener, an error is written as a console warning
 * instead, since an `'error'` that nothing listens for would throw.
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
export class LiveKitStreamTransport extends EventEmitter implements IStreamTransport {
  readonly id = randomUUID();
  private _state: 'connecting' | 'open' | 'closing' | 'closed' = 'open';
  private readonly topic: string;
  private readonly source: LiveKitRoomAudioSource;
  private paused = false;
  private readonly held: AudioFrame[] = [];
  private heldMs = 0;
  private droppedMs = 0;
  private readonly bufferMs: number;
  /** The participant's text streams being read; {@link close} closes them. */
  private readonly readers = new Set<LiveKitTextStreamReaderLike>();

  /**
   * @throws {RangeError} When `sampleRate` or `frameSizeMs` is refused, as
   *   {@link LiveKitRoomAudioSource} refuses them; the topic is left free.
   * @throws {Error} When the room already has a text stream handler for the
   *   topic (rtc-node allows one per topic).
   */
  constructor(private readonly options: LiveKitStreamTransportOptions) {
    super();
    this.topic = options.topic ?? LIVEKIT_TRANSPORT_DEFAULT_TOPIC;
    this.bufferMs = options.bufferMs ?? 2_000;
    this.on('pause', () => {
      this.paused = true;
    });
    this.on('resume', () => {
      this.paused = false;
      // a transport that has closed replays nothing: what it held went with it
      if (this._state !== 'open') return;
      if (this.droppedMs > 0) {
        this.emit('gap', { droppedMs: this.droppedMs, reason: 'paused' });
        this.droppedMs = 0;
      }
      // one frame at a time: a listener that asks for a pause again while it takes a frame stops the replay there, and
      // the frames not yet emitted stay held, in order, with their length
      while (this.held.length > 0 && !this.paused && this._state === 'open') {
        const frame = this.held.shift()!;
        this.heldMs = this.held.length > 0 ? this.heldMs - frameMs(frame) : 0;
        this.emit('audio', frame);
      }
    });
    // The source checks the options before the topic is taken, so a refused
    // option leaves the topic free; until it is read, the source holds nothing.
    this.source = new LiveKitRoomAudioSource({
      room: options.room,
      participantIdentity: options.participantIdentity,
      sampleRate: options.sampleRate,
      frameSizeMs: options.frameSizeMs,
      rtc: options.rtc,
    });
    options.room.registerTextStreamHandler(this.topic, this.onText);
    void this.pump();
  }

  get state(): 'connecting' | 'open' | 'closing' | 'closed' {
    return this._state;
  }

  /**
   * Rejects: this transport does not publish audio (see the module notes). A
   * caller that awaits the promise gets the error; one that drops it raises no
   * unhandled rejection, which Node raises as an uncaught exception by default.
   * `VoicePipelineOrchestrator` reports the first refused chunk of each reply.
   */
  sendAudio(_chunk: EncodedAudioChunk): Promise<void> {
    const refused = Promise.reject(
      new Error(
        'LiveKitStreamTransport does not publish audio: it carries what the agent hears and its control messages'
      )
    );
    refused.catch(() => {
      // A handler of its own: a caller that drops the promise does not end the process.
    });
    return refused;
  }

  /**
   * Sends a JSON message to the participant as a text stream on the topic.
   *
   * @throws {Error} When the transport is not open or the room has no local participant.
   */
  async sendControl(message: ServerTextMessage): Promise<void> {
    if (this._state !== 'open') {
      throw new Error(`LiveKitStreamTransport: cannot send while ${this._state}`);
    }
    const local = this.options.room.localParticipant;
    if (!local) {
      throw new Error('LiveKitStreamTransport: the room has no local participant; connect it first');
    }
    await local.sendText(JSON.stringify(message), {
      topic: this.topic,
      destinationIdentities: [this.options.participantIdentity],
    });
  }

  /**
   * Stops reading audio, drops the frames a pause held, closes the text streams
   * still arriving, unregisters the topic and emits `'close'`. The room stays
   * connected. Idempotent.
   */
  close(_code?: number, _reason?: string): void {
    if (this._state === 'closing' || this._state === 'closed') return;
    this._state = 'closing';
    // what a pause held goes with the transport: a resume after the close emits none of it, and no gap
    this.held.length = 0;
    this.heldMs = 0;
    this.droppedMs = 0;
    this.options.room.unregisterTextStreamHandler(this.topic);
    this.source.close();
    for (const reader of this.readers) closeTextReader(reader);
    this.readers.clear();
    this._state = 'closed';
    this.emit('close');
  }

  /** Emits the participant's frames until the source ends, then closes. */
  private async pump(): Promise<void> {
    try {
      for await (const frame of this.source) {
        if (!this.paused) {
          this.emit('audio', frame);
          continue;
        }
        this.held.push(frame);
        this.heldMs += frameMs(frame);
        while (this.heldMs > this.bufferMs && this.held.length) {
          const oldMs = frameMs(this.held.shift()!);
          this.heldMs -= oldMs;
          this.droppedMs += oldMs;
        }
      }
    } catch (err) {
      this.emitErrorSafe(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (this._state === 'open') this.close();
    }
  }

  private readonly onText = (reader: LiveKitTextStreamReaderLike, participant: { identity: string }): void => {
    if (participant.identity !== this.options.participantIdentity || this._state !== 'open') {
      // Another sender's stream, or one that came as the transport closed: released unread.
      closeTextReader(reader);
      return;
    }
    this.readers.add(reader);
    reader
      .readAll()
      .then((text) => {
        this.readers.delete(reader);
        if (this._state !== 'open') return;
        let message: ClientTextMessage;
        try {
          message = JSON.parse(text) as ClientTextMessage;
        } catch (err) {
          this.emitErrorSafe(
            new Error(`LiveKitStreamTransport: failed to parse inbound text message as JSON: ${String(err)}`)
          );
          return;
        }
        this.emit('message', message);
      })
      .catch((err: unknown) => {
        this.readers.delete(reader);
        if (this._state === 'open') this.emitErrorSafe(err instanceof Error ? err : new Error(String(err)));
      });
  };

  /**
   * Emit `'error'` only when a listener exists: an unlistened EventEmitter
   * `'error'` throws and takes the whole process down.
   */
  private emitErrorSafe(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.warn('[livekit-stream-transport] error (no listener attached):', err.message);
    }
  }
}
