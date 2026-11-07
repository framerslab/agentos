/**
 * @module hearing/LiveKitTranslationOutput
 *
 * Writes a transcript's translations into a LiveKit room as text streams on `lk.translation`, each to the identities
 * the caller names and never to the room: a list left empty sends nothing. Lines are numbered per target from 1 and
 * kept in a ledger per target, a line written to nobody among them, so a participant that reconnects is sent again
 * every line of its target above the number it holds. The ledger lives as long as the output and is never trimmed, so
 * a replay reaches back to the first line: a host makes one output per room session and drops it with the session.
 * `send` carries a message that is not a line (a status) to the same identities under the same rule.
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
  /** Whether `encode` is running, so a write, a send or a replay asked for from inside it waits for the line being encoded. */
  private encoding = false;
  /**
   * The writes, sends and replays asked for from inside `encode`, in the order they were asked for. They run as soon
   * as the line being encoded is numbered, kept and queued, or refused, before the write of that line returns, so an
   * operation the caller asks for after that write comes after them.
   */
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly options: LiveKitTranslationOutputOptions) {
    this.topic = options.topic ?? LIVEKIT_TRANSLATION_TOPIC;
    this.encode = options.encode ?? ((line, seq) => JSON.stringify({ ...line, seq }));
  }

  /**
   * Numbers the line for its target, keeps it and sends it to the identities. An empty list sends nothing and resolves,
   * and the line is still numbered and kept, so a reader of the target that was away while nobody was named is sent
   * it by `replayAfter`. The line and the identities are copied as they are when it is called, so a caller that changes
   * either afterwards changes neither this send nor a replay of it, and `encode` is given a copy of its own. A send
   * that fails rejects this write and leaves the line in the ledger, so a replay sends it. An `encode` that throws
   * rejects this write too, never throwing at the caller, and the line is neither numbered nor kept. A write made from
   * inside `encode` waits for the line being encoded, so it goes out after that line with the next number, or takes
   * that line's number when the encode throws; the ledger holds finished lines alone, so a replay never sees one being
   * encoded. What `encode` asks for is numbered and queued before the write that encodes returns, in the order it was
   * asked for, so a write, a send or a replay the caller asks for next comes after it.
   */
  async write(line: TranslationOutputLine, to: { destinationIdentities: readonly string[] }): Promise<void> {
    const kept: TranslationOutputLine = { ...line };
    const destinationIdentities = [...to.destinationIdentities];
    if (this.encoding) return this.afterEncoding(() => this.writeNow(kept, destinationIdentities));
    return this.writeNow(kept, destinationIdentities);
  }

  /**
   * Numbers, keeps and queues the line at once, then runs what its `encode` asked for; an `encode` that throws rejects
   * the returned promise, the line neither numbered nor kept, and what it asked for still runs.
   */
  private writeNow(kept: TranslationOutputLine, destinationIdentities: string[]): Promise<void> {
    const ledger = this.ledgers.get(kept.target) ?? [];
    this.ledgers.set(kept.target, ledger);
    const last = ledger[ledger.length - 1];
    const seq = (last?.seq ?? 0) + 1;
    let text: string;
    try {
      text = this.encoded(kept, seq);
    } catch (error) {
      this.runWaiting();
      return Promise.reject(error);
    }
    const written: Written = { seq, line: kept, text };
    ledger.push(written);
    // Never to the room: LiveKit sends a stream with no destination identities to every participant.
    const sent = destinationIdentities.length === 0 ? Promise.resolve() : this.enqueue(() => this.sendLine(written, destinationIdentities));
    this.runWaiting();
    return sent;
  }

  /**
   * Sends again every line of the target numbered above `afterSeq` (every line when null) to one identity, in order;
   * resolves how many. Asked for from inside `encode`, it waits for the line being encoded, as a write does.
   */
  async replayAfter(afterSeq: number | null, target: string, participantIdentity: string): Promise<number> {
    const replay = (): Promise<number> => {
      const lines = (this.ledgers.get(target) ?? []).filter((each) => afterSeq === null || each.seq > afterSeq);
      return this.enqueue(async () => {
        for (const each of lines) await this.sendLine(each, [participantIdentity]);
        return lines.length;
      });
    };
    return this.encoding ? this.afterEncoding(replay) : replay();
  }

  /**
   * Sends a message that is not a line, such as a status, to the identities alone, on `topic` or the output's own; an
   * empty list sends nothing. The topic and the identities are read when it is called. Asked for from inside `encode`,
   * it waits for the line being encoded, as a write does.
   */
  async send(text: string, to: { topic?: string; destinationIdentities: readonly string[] }): Promise<void> {
    if (to.destinationIdentities.length === 0) return;
    // Read when it is called, as the identities are, so a caller that reuses its options changes no queued send.
    const topic = to.topic ?? this.topic;
    const destinationIdentities = [...to.destinationIdentities];
    const send = (): Promise<void> =>
      this.enqueue(() =>
        this.local()
          .sendText(text, { topic, destinationIdentities })
          .then(() => undefined)
      );
    return this.encoding ? this.afterEncoding(send) : send();
  }

  /** Runs `operation` once the line being encoded is numbered, kept and queued, or refused; resolves as it does. */
  private afterEncoding<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        try {
          operation().then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Runs the operations asked for from inside `encode`, oldest first. One that encodes a line runs what its own `encode`
   * asked for through this same list, so every operation runs in the order it was asked for.
   */
  private runWaiting(): void {
    for (let next = this.waiting.shift(); next; next = this.waiting.shift()) next();
  }

  /** The line's stream text, with `encoding` set while the option runs. */
  private encoded(line: TranslationOutputLine, seq: number): string {
    this.encoding = true;
    try {
      // The encode option is given a copy, so one that changes or keeps its argument never reaches the ledger's line.
      return this.encode({ ...line }, seq);
    } finally {
      this.encoding = false;
    }
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
