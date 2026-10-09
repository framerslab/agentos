/**
 * @module hearing/LiveKitTranscriptionOutput
 * Writes a speech-to-text session's transcripts into a LiveKit room the way
 * LiveKit's own transcription output does, so a page's standard handler of the
 * `lk.transcription` topic shows them: each interim and each final as a text
 * stream holding the line's whole text, with `lk.segment_id` (the transcript's
 * `itemId`), `lk.transcription_final` and `lk.transcribed_track_id`, and on a
 * final whose transcript has times, `agentos.start_ms` and `agentos.end_ms`
 * (whole milliseconds on the session's audio clock), which
 * `transcriptEventFromLiveKit()` reads back. Writes go out in the order they
 * were asked for. The finals are kept in a {@link TranscriptLedger}, so a
 * participant that reconnects can be sent again the finals after the last line
 * it holds, a line taken back among them, each with the times it was first
 * written with.
 *
 * The room is described by a structural type, so this module and its typings
 * carry no dependency on `@livekit/rtc-node`; a connected rtc-node `Room` is
 * passed as it is.
 *
 * @example
 * ```typescript
 * const output = new LiveKitTranscriptionOutput({ room, trackSid: () => heardTrack?.sid });
 * sttSession.on('transcript', (event) => {
 *   output.write(event).catch((error) => console.warn('transcript not sent', error));
 * });
 * // when the page says the last line it holds:
 * await output.replayAfter(lastItemId, participantIdentity);
 * ```
 */

import {
  LIVEKIT_TRANSCRIPTION_ATTRIBUTES,
  LIVEKIT_TRANSCRIPTION_TOPIC,
  TRANSCRIPTION_FAILED_ATTRIBUTE,
  TRANSCRIPTION_TIME_ATTRIBUTES,
  TranscriptLedger,
  type LedgerItem,
} from '../voice-pipeline/transcriptLedger.js';
import type { TranscriptEvent } from '../voice-pipeline/types.js';

/**
 * The part of a connected room (rtc-node `Room`) the output uses: its local
 * participant, which sends the text streams. A real rtc-node `Room` satisfies
 * it as it is.
 */
export interface LiveKitTranscriptionRoomLike {
  /** The room's local participant; rtc-node leaves it unset until the room is connected. */
  readonly localParticipant?: {
    /** rtc-node's `LocalParticipant.sendText`, with the options the output sets. */
    sendText(
      text: string,
      options?: { topic?: string; attributes?: Record<string, string>; destinationIdentities?: string[] }
    ): Promise<unknown>;
  };
}

/** Options of {@link LiveKitTranscriptionOutput}. */
export interface LiveKitTranscriptionOutputOptions {
  /** A connected room (rtc-node `Room`) whose local participant sends the streams. */
  room: LiveKitTranscriptionRoomLike;
  /**
   * The SID of the track being transcribed, read at each send, a replay's
   * included; the attribute is left out when it answers nothing.
   */
  trackSid?: () => string | undefined;
  /** The topic. @defaultValue 'lk.transcription' */
  topic?: string;
  /** The ledger the finals are kept in; a new one when omitted. */
  ledger?: TranscriptLedger;
}

/** Transcripts written into a LiveKit room as transcription text streams. */
export class LiveKitTranscriptionOutput {
  /** The lines written so far, the finals among them. */
  readonly ledger: TranscriptLedger;
  private readonly topic: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: LiveKitTranscriptionOutputOptions) {
    this.ledger = options.ledger ?? new TranscriptLedger();
    this.topic = options.topic ?? LIVEKIT_TRANSCRIPTION_TOPIC;
  }

  /**
   * Writes one transcript to every participant. Resolves `true` once it is
   * sent, `false` when the ledger already held it (a repeated final, or an
   * interim after the final), which sends nothing. A final carries the
   * transcript's `startMs` and `endMs` as {@link TRANSCRIPTION_TIME_ATTRIBUTES},
   * each rounded to whole milliseconds and left out when the rounded time is
   * negative or not a safe integer; an interim carries neither.
   *
   * The ledger takes the line before it is sent, so a send that fails leaves
   * the line there: writing the same transcript again sends nothing, and
   * {@link LiveKitTranscriptionOutput.replayAfter} sends a final again to a
   * participant, as it does for one that rejoins.
   *
   * @param extra - `itemId` when the transcript carries none; `failed`, a short
   *   reason, for a line the provider could not transcribe.
   * @throws {RangeError} When neither the transcript nor `extra` gives a line id.
   * @throws {Error} When the room has no local participant, or the send fails.
   */
  write(event: TranscriptEvent, extra: { itemId?: string; failed?: string } = {}): Promise<boolean> {
    const itemId = extra.itemId ?? event.itemId;
    if (!itemId) {
      return Promise.reject(new RangeError('LiveKitTranscriptionOutput: the transcript has no itemId; pass one in the second argument'));
    }
    const changed = this.ledger.apply({
      itemId,
      text: event.text,
      isFinal: event.isFinal,
      ...(event.startMs !== undefined ? { startMs: event.startMs } : {}),
      ...(event.endMs !== undefined ? { endMs: event.endMs } : {}),
      ...(event.language !== undefined ? { language: event.language } : {}),
      ...(extra.failed !== undefined ? { failed: extra.failed } : {}),
    });
    if (!changed) return Promise.resolve(false);
    const line = this.ledger.get(itemId)!;
    return this.enqueue(() => this.send(line, undefined)).then(() => true);
  }

  /**
   * Sends again, to one participant, the final lines after the line with the
   * id, in order, a line taken back among them as its empty final, so a page
   * that missed the retraction drops the line; every one of them when the id
   * is `undefined` or unknown. Each final carries the times it was first
   * written with, read from the ledger's line. Resolves how many were sent.
   */
  replayAfter(itemId: string | undefined, participantIdentity: string): Promise<number> {
    const finals = this.ledger.finalsAfter(itemId, { takenBack: true });
    return this.enqueue(async () => {
      for (const line of finals) await this.send(line, [participantIdentity]);
      return finals.length;
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async send(line: LedgerItem, destinationIdentities: string[] | undefined): Promise<void> {
    const local = this.options.room.localParticipant;
    if (!local) throw new Error('LiveKitTranscriptionOutput: the room has no local participant; connect it first');
    const attributes: Record<string, string> = {
      [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.segmentId]: line.itemId,
      [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final]: line.isFinal ? 'true' : 'false',
      // The ledger's line keeps the times its final was written with, so a replay sends the same two.
      ...(line.isFinal ? timeAttributes(line) : {}),
    };
    const sid = this.options.trackSid?.();
    if (sid) attributes[LIVEKIT_TRANSCRIPTION_ATTRIBUTES.trackId] = sid;
    if (line.failed) attributes[TRANSCRIPTION_FAILED_ATTRIBUTE] = line.failed;
    await local.sendText(line.text, {
      topic: this.topic,
      attributes,
      ...(destinationIdentities ? { destinationIdentities } : {}),
    });
  }
}

/**
 * A final's time attributes ({@link TRANSCRIPTION_TIME_ATTRIBUTES}): each time
 * the line holds, rounded to whole milliseconds and written in decimal digits,
 * the form `transcriptEventFromLiveKit()` reads back. A time that is negative,
 * not a finite number or past the integers a number holds exactly is left out,
 * since a reader would not take it.
 */
function timeAttributes(line: Pick<LedgerItem, 'startMs' | 'endMs'>): Record<string, string> {
  const out: Record<string, string> = {};
  const startMs = wholeMs(line.startMs);
  if (startMs !== undefined) out[TRANSCRIPTION_TIME_ATTRIBUTES.startMs] = startMs;
  const endMs = wholeMs(line.endMs);
  if (endMs !== undefined) out[TRANSCRIPTION_TIME_ATTRIBUTES.endMs] = endMs;
  return out;
}

/** A time as whole milliseconds in decimal digits, or `undefined` for a time no such string holds. */
function wholeMs(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const whole = Math.round(ms);
  return whole >= 0 && Number.isSafeInteger(whole) ? String(whole) : undefined;
}
