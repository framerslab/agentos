/**
 * @module hearing/LiveKitTranslationOutput
 *
 * Writes a transcript's translations into a LiveKit room as text streams on `lk.translation`, each to the identities
 * the caller names and never to the room: a list left empty sends nothing. Lines are numbered per target from 1 and
 * kept in a ledger per target, so a participant that reconnects is sent again every line of its target above the
 * number it holds. `send` carries a message that is not a line (a status) to the same identities under the same rule.
 * The output takes the room through a structural type and imports no LiveKit package.
 *
 * @example
 * ```ts
 * import { LiveKitTranslationOutput } from '@framers/agentos/io/hearing/livekit';
 *
 * const output = new LiveKitTranslationOutput({ room }); // a connected @livekit/rtc-node Room
 * await output.write({ itemId, target: 'fr', source: 'en', status: 'translated', text }, { destinationIdentities: readersOf('fr') });
 * // A reader of French reconnected holding line 41:
 * await output.replayAfter(41, 'fr', identity);
 * ```
 */
import type { LiveKitTranscriptionRoomLike } from './LiveKitTranscriptionOutput.js';

/** The topic the translation streams are sent on. */
export const LIVEKIT_TRANSLATION_TOPIC = 'lk.translation';

/** The attributes each translation stream carries: the line's item, target and source, its status and its number. */
export const LIVEKIT_TRANSLATION_ATTRIBUTES = {
  itemId: 'translation.item_id',
  target: 'translation.target',
  source: 'translation.source',
  status: 'translation.status',
  seq: 'translation.seq',
} as const;

/** One translated line, or a line that was skipped or failed, for one target. */
export interface TranslationOutputLine {
  itemId: string;
  target: string;
  /** The line's source language, or null when it is not known; written as an empty attribute then. */
  source: string | null;
  status: 'translated' | 'skipped' | 'failed';
  /** The translation; null for a line that was skipped or failed. */
  text: string | null;
  /** Why a line was skipped or failed, in a short word. */
  reason?: string;
}

/** Options of {@link LiveKitTranslationOutput}. */
export interface LiveKitTranslationOutputOptions {
  /** A connected room (rtc-node `Room`) whose local participant sends the streams. */
  room: LiveKitTranscriptionRoomLike;
  /** The topic. @defaultValue 'lk.translation' */
  topic?: string;
  /** How a line is written as the stream's text; the default is JSON of the line with its `seq`. */
  encode?: (line: TranslationOutputLine, seq: number) => string;
}

/** A line as it was numbered and written, kept for a replay. */
interface Written {
  seq: number;
  line: TranslationOutputLine;
  text: string;
}

/** Translations written into a LiveKit room as text streams to the participants that read them. */
export class LiveKitTranslationOutput {
  private readonly topic: string;
  private readonly encode: (line: TranslationOutputLine, seq: number) => string;
  private readonly ledgers = new Map<string, Written[]>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: LiveKitTranslationOutputOptions) {
    this.topic = options.topic ?? LIVEKIT_TRANSLATION_TOPIC;
    this.encode = options.encode ?? ((line, seq) => JSON.stringify({ ...line, seq }));
  }

  /**
   * Numbers the line for its target and sends it to the identities; an empty list sends nothing, numbers nothing and
   * resolves. The line and the identities are copied as they are when it is called, so a caller that changes either
   * afterwards changes neither this send nor a replay of it. A send that fails rejects this write and leaves the line
   * in the ledger, so a replay sends it.
   */
  write(line: TranslationOutputLine, to: { destinationIdentities: readonly string[] }): Promise<void> {
    if (to.destinationIdentities.length === 0) return Promise.resolve();
    const kept: TranslationOutputLine = { ...line };
    const destinationIdentities = [...to.destinationIdentities];
    const ledger = this.ledgers.get(kept.target) ?? [];
    this.ledgers.set(kept.target, ledger);
    const last = ledger[ledger.length - 1];
    const seq = (last?.seq ?? 0) + 1;
    const written: Written = { seq, line: kept, text: this.encode(kept, seq) };
    ledger.push(written);
    return this.enqueue(() => this.sendLine(written, destinationIdentities));
  }

  /** Sends again every line of the target numbered above `afterSeq` (every line when null) to one identity, in order; resolves how many. */
  replayAfter(afterSeq: number | null, target: string, participantIdentity: string): Promise<number> {
    const lines = (this.ledgers.get(target) ?? []).filter((each) => afterSeq === null || each.seq > afterSeq);
    return this.enqueue(async () => {
      for (const each of lines) await this.sendLine(each, [participantIdentity]);
      return lines.length;
    });
  }

  /** Sends a message that is not a line, such as a status, to the identities alone; an empty list sends nothing. */
  send(text: string, to: { topic?: string; destinationIdentities: readonly string[] }): Promise<void> {
    if (to.destinationIdentities.length === 0) return Promise.resolve();
    const destinationIdentities = [...to.destinationIdentities];
    return this.enqueue(() =>
      this.local()
        .sendText(text, { topic: to.topic ?? this.topic, destinationIdentities })
        .then(() => undefined)
    );
  }

  private local(): NonNullable<LiveKitTranscriptionRoomLike['localParticipant']> {
    const local = this.options.room.localParticipant;
    if (!local) throw new Error('LiveKitTranslationOutput: the room has no local participant; connect it first');
    return local;
  }

  private async sendLine(written: Written, destinationIdentities: string[]): Promise<void> {
    const { line, seq } = written;
    await this.local().sendText(written.text, {
      topic: this.topic,
      destinationIdentities,
      attributes: {
        [LIVEKIT_TRANSLATION_ATTRIBUTES.itemId]: line.itemId,
        [LIVEKIT_TRANSLATION_ATTRIBUTES.target]: line.target,
        [LIVEKIT_TRANSLATION_ATTRIBUTES.source]: line.source ?? '',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.status]: line.status,
        [LIVEKIT_TRANSLATION_ATTRIBUTES.seq]: String(seq),
      },
    });
  }

  /** Runs the sends one at a time in the order they were asked for; one that fails rejects its own promise alone. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
