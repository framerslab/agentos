/**
 * @module voice-pipeline/transcriptLedger
 * A live transcript as lines keyed by their item id. An interim replaces the
 * line's earlier interim, a final closes the line, and a final that arrives
 * again (a replay after a reconnect) or an interim after its final changes
 * nothing; lines keep the order they were first seen in. An empty final with
 * no failure takes a line back, and the ledger hides it. LiveKit carries
 * transcripts as text streams on its `lk.transcription` topic with the
 * attributes its own transcription output sets: `transcriptEventFromLiveKit()`
 * reads one, and `LiveKitTranscriptionOutput`
 * (`@framers/agentos/io/hearing/livekit`) writes them. The module imports
 * nothing at run time, so a browser bundle takes it from
 * `@framers/agentos/io/voice-pipeline/browser`.
 */

import type { TranscriptEvent } from './types.js';

/** LiveKit's topic for transcription text streams. */
export const LIVEKIT_TRANSCRIPTION_TOPIC = 'lk.transcription';

/** The attributes LiveKit's own transcription output sets on each stream. */
export const LIVEKIT_TRANSCRIPTION_ATTRIBUTES = {
  /** The line's id; this library writes the transcript's `itemId` here. */
  segmentId: 'lk.segment_id',
  /** `'true'` on the line's final stream, `'false'` on an interim. */
  final: 'lk.transcription_final',
  /** The SID of the audio track the line was heard on. */
  trackId: 'lk.transcribed_track_id',
} as const;

/** The attribute this library adds to a line the provider could not transcribe, holding a short reason. */
export const TRANSCRIPTION_FAILED_ATTRIBUTE = 'agentos.transcription_failed';

/** One line of a ledger. */
export interface LedgerItem {
  /** The line's id: the provider's item id. */
  readonly itemId: string;
  /** The line's text: the newest interim, or the final. */
  readonly text: string;
  /** `true` once the final arrived; the line no longer changes. */
  readonly isFinal: boolean;
  /** Start of the line on the session's audio clock, when the provider gives it. */
  readonly startMs?: number;
  /** End of the line on the session's audio clock, when the provider gives it. */
  readonly endMs?: number;
  /** The line's language, when the provider gives it. */
  readonly language?: string;
  /** Why the provider could not transcribe the line; its text is then empty. */
  readonly failed?: string;
}

/** What a ledger takes: a transcript's text, finality and id, with the optional timing, language and failure. */
export type LedgerEvent = Pick<TranscriptEvent, 'text' | 'isFinal'> &
  Partial<Pick<TranscriptEvent, 'itemId' | 'startMs' | 'endMs' | 'language'>> & { failed?: string };

/** Options of {@link TranscriptLedger}. */
export interface TranscriptLedgerOptions {
  /**
   * The most lines held, a line taken back among them (it stays, hidden, so a
   * later event for its id changes nothing); beyond it the oldest final lines
   * are dropped, never the line just applied.
   * @defaultValue 20000
   */
  maxItems?: number;
}

/** A live transcript's lines keyed by item id, in the order first seen. */
export class TranscriptLedger {
  private readonly lines = new Map<string, LedgerItem>();
  private readonly retracted = new Set<string>();
  private readonly maxItems: number;

  /** @throws {RangeError} When `maxItems` is below 1. */
  constructor(options: TranscriptLedgerOptions = {}) {
    this.maxItems = options.maxItems ?? 20_000;
    if (!(this.maxItems >= 1)) throw new RangeError('TranscriptLedger: maxItems must be at least 1');
  }

  /** How many lines the ledger shows. */
  get size(): number {
    return this.lines.size - this.retracted.size;
  }

  /**
   * Applies one transcript. Answers `true` when the ledger changed: a new
   * line, a new interim text, the final, or a line taken back. An empty final
   * with no failure takes back the text a line showed so far (a device
   * session's retraction when it closes), and the line is hidden from then on.
   * An event with no item id, a final for a line already final, an interim
   * after the final, an interim with the same text and the retraction of a
   * line never shown change nothing.
   */
  apply(event: LedgerEvent): boolean {
    const itemId = event.itemId;
    if (!itemId) return false;
    const held = this.lines.get(itemId);
    if (held?.isFinal) return false;
    if (event.isFinal && event.text === '' && event.failed === undefined) {
      if (held === undefined) return false;
      this.retracted.add(itemId);
      this.lines.set(itemId, { itemId, text: '', isFinal: true });
      return true;
    }
    if (!event.isFinal && held !== undefined && held.text === event.text) return false;
    const line: { -readonly [K in keyof LedgerItem]: LedgerItem[K] } = { itemId, text: event.text, isFinal: event.isFinal };
    if (event.startMs !== undefined) line.startMs = event.startMs;
    if (event.endMs !== undefined) line.endMs = event.endMs;
    if (event.language !== undefined) line.language = event.language;
    if (event.failed !== undefined) line.failed = event.failed;
    // Setting a key a Map already holds keeps its place, so a line stays where it was first seen.
    this.lines.set(itemId, line);
    this.trim(itemId);
    return true;
  }

  /** The line with the id (a line taken back answers its empty final), or `undefined`. */
  get(itemId: string): LedgerItem | undefined {
    return this.lines.get(itemId);
  }

  /** Every line shown, in the order first seen; a line taken back is left out. */
  items(): LedgerItem[] {
    return [...this.lines.values()].filter((line) => !this.retracted.has(line.itemId));
  }

  /** The id of the last final line shown, or `undefined` when none is final. */
  lastFinalId(): string | undefined {
    let last: string | undefined;
    for (const line of this.items()) if (line.isFinal) last = line.itemId;
    return last;
  }

  /**
   * The id a page that rejoins sends, so it is given every final it may lack: the last final line before the first
   * line not yet final (a final that arrived out of order while the page was away comes after it), the last final
   * when every line is final, `undefined` when none is. A final the page already holds comes again and is dropped.
   */
  resumeAfterId(): string | undefined {
    let last: string | undefined;
    for (const line of this.items()) {
      if (!line.isFinal) return last;
      last = line.itemId;
    }
    return last;
  }

  /** The final lines shown after the line with the id, in order; every one of them when the id is `undefined` or unknown. */
  finalsAfter(itemId: string | undefined): LedgerItem[] {
    const lines = this.items();
    const index = itemId === undefined ? -1 : lines.findIndex((line) => line.itemId === itemId);
    return lines.slice(index + 1).filter((line) => line.isFinal);
  }

  /** The ledger as plain JSON. */
  toJSON(): { v: 1; items: LedgerItem[] } {
    return { v: 1, items: this.items() };
  }

  /** A ledger from {@link TranscriptLedger.toJSON}'s output; a malformed line is skipped. */
  static fromJSON(value: unknown, options: TranscriptLedgerOptions = {}): TranscriptLedger {
    const ledger = new TranscriptLedger(options);
    const items = (value as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return ledger;
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const line = item as Partial<Record<keyof LedgerItem, unknown>>;
      if (typeof line.itemId !== 'string' || typeof line.text !== 'string' || typeof line.isFinal !== 'boolean') continue;
      ledger.apply({
        itemId: line.itemId,
        text: line.text,
        isFinal: line.isFinal,
        ...(typeof line.startMs === 'number' ? { startMs: line.startMs } : {}),
        ...(typeof line.endMs === 'number' ? { endMs: line.endMs } : {}),
        ...(typeof line.language === 'string' ? { language: line.language } : {}),
        ...(typeof line.failed === 'string' ? { failed: line.failed } : {}),
      });
    }
    return ledger;
  }

  /**
   * Drops the oldest final lines while the ledger is over its size, never the
   * line just applied; the oldest other line when no other line is final.
   */
  private trim(keep: string): void {
    while (this.lines.size > this.maxItems) {
      let oldest: string | undefined;
      let drop: string | undefined;
      for (const line of this.lines.values()) {
        if (line.itemId === keep) continue;
        if (oldest === undefined) oldest = line.itemId;
        if (line.isFinal) {
          drop = line.itemId;
          break;
        }
      }
      // Over a size of at least 1 the ledger holds two lines or more, so one other than `keep` is there.
      const id = (drop ?? oldest)!;
      this.lines.delete(id);
      this.retracted.delete(id);
    }
  }
}

/**
 * Reads one LiveKit transcription stream (its text and attributes) as a
 * {@link LedgerEvent}, or `null` when it carries no segment id.
 */
export function transcriptEventFromLiveKit(text: string, attributes: Readonly<Record<string, string>> | undefined): LedgerEvent | null {
  if (attributes === undefined) return null;
  const itemId = attributes[LIVEKIT_TRANSCRIPTION_ATTRIBUTES.segmentId];
  if (!itemId) return null;
  const event: LedgerEvent = { itemId, text, isFinal: attributes[LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final] === 'true' };
  const failed = attributes[TRANSCRIPTION_FAILED_ATTRIBUTE];
  if (failed) event.failed = failed;
  return event;
}
