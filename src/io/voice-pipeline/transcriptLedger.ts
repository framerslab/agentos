/**
 * @module voice-pipeline/transcriptLedger
 * A live transcript as lines keyed by their item id. An interim replaces the
 * line's earlier interim, a final closes the line, and a final that arrives
 * again (a replay after a reconnect) or an interim after its final changes
 * nothing; lines keep the order they were first seen in. An empty final with
 * no failure takes a line back, and the ledger hides it. LiveKit carries
 * transcripts as text streams on its `lk.transcription` topic with the
 * attributes its own transcription output sets, to which this library adds
 * `agentos.transcription_failed` on a line the provider could not transcribe
 * and `agentos.start_ms` and `agentos.end_ms` on a final with times:
 * `transcriptEventFromLiveKit()` reads such a stream, and
 * `LiveKitTranscriptionOutput` (`@framers/agentos/io/hearing/livekit`) writes
 * them. The module imports nothing, its types included, so a browser bundle
 * takes it from `@framers/agentos/io/voice-pipeline/browser` and a type check
 * of it needs no Node types.
 */

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

/** A line's connection-scoped label, or the empty string for explicit null. */
export const TRANSCRIPTION_SPEAKER_ATTRIBUTE = 'agentos.speaker';

/** The parent item id on a later run of a split final. */
export const TRANSCRIPTION_RUN_OF_ATTRIBUTE = 'agentos.run_of';

/**
 * The attributes this library adds to a final: the line's start and end on the
 * session's audio clock, when the provider gave them, each as whole
 * milliseconds in decimal digits (`'1200'`). An interim carries neither.
 */
export const TRANSCRIPTION_TIME_ATTRIBUTES = {
  /** The line's `startMs`. */
  startMs: 'agentos.start_ms',
  /** The line's `endMs`. */
  endMs: 'agentos.end_ms',
} as const;

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
  /** One known voice, null for requested but uncertain attribution, absent when not requested. */
  readonly speaker?: string | null;
  /** The original item id on a later run of a split final. */
  readonly runOf?: string;
}

/**
 * What a ledger takes: a transcript's text, finality and id, with the optional
 * timing, language and failure. A `TranscriptEvent` fits it as it is; the shape
 * is declared here so the browser entry's typings import nothing.
 */
export interface LedgerEvent {
  /** The line's id: the provider's item id. An event without one changes nothing. */
  itemId?: string;
  /** The line's text: an interim's text so far, or the final text. */
  text: string;
  /** `true` on the line's final, `false` on an interim. */
  isFinal: boolean;
  /** Start of the line on the session's audio clock, when the provider gives it. */
  startMs?: number;
  /** End of the line on the session's audio clock, when the provider gives it. */
  endMs?: number;
  /** The line's language, when the provider gives it. */
  language?: string;
  /** Why the provider could not transcribe the line; its text is then empty. An empty reason counts as none. */
  failed?: string;
  /** One known voice, null for requested but uncertain attribution, absent when not requested. */
  speaker?: string | null;
  /** The original item id on a later run of a split final. */
  runOf?: string;
}

/** Options of {@link TranscriptLedger}. */
export interface TranscriptLedgerOptions {
  /**
   * The most lines held, a line taken back among them (it stays, hidden, so a
   * later event for its id changes nothing and a replay carries it); beyond it
   * the oldest final lines are dropped, never the line just applied nor a line
   * still being heard, so while more lines than that are open the ledger holds
   * them all.
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
   * Applies a new line, changed interim text or speaker, final or retraction.
   * An empty final with no failure hides a previously shown line. First-seen
   * order never changes. An interim with identical text and speaker, a
   * repeated final and an interim after a final change nothing. Omitting a
   * previously present speaker removes it; null remains distinct from absent.
   */
  apply(event: LedgerEvent): boolean {
    const itemId = event.itemId;
    if (itemId === undefined || itemId === '') return false;
    const held = this.lines.get(itemId);
    if (held?.isFinal) return false;
    const failed = event.failed || undefined;
    const fields = {
      ...(event.speaker === undefined ? {} : { speaker: event.speaker }),
      ...(event.runOf === undefined ? {} : { runOf: event.runOf }),
    };
    if (event.isFinal && event.text === '' && failed === undefined) {
      if (held === undefined) return false;
      this.retracted.add(itemId);
      this.lines.set(itemId, { itemId, text: '', isFinal: true, ...fields });
      this.trim(itemId);
      return true;
    }
    if (event.isFinal === false && held && held.text === event.text && held.speaker === event.speaker) return false;
    const line: LedgerItem = {
      itemId,
      text: event.text,
      isFinal: event.isFinal,
      ...fields,
      ...(event.startMs === undefined ? {} : { startMs: event.startMs }),
      ...(event.endMs === undefined ? {} : { endMs: event.endMs }),
      ...(event.language === undefined ? {} : { language: event.language }),
      ...(failed === undefined ? {} : { failed }),
    };
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

  /**
   * The final lines shown after the line with the id, in order; every one of
   * them when the id is `undefined` or unknown. With `takenBack`, a line taken
   * back comes too, as its empty final in its place: what a participant that
   * rejoins is sent again, so a page that missed the retraction drops the line.
   */
  finalsAfter(itemId: string | undefined, options: { takenBack?: boolean } = {}): LedgerItem[] {
    const lines = options.takenBack ? [...this.lines.values()] : this.items();
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
        ...(typeof line.speaker === 'string' || line.speaker === null ? { speaker: line.speaker } : {}),
        ...(typeof line.runOf === 'string' ? { runOf: line.runOf } : {}),
      });
    }
    return ledger;
  }

  /**
   * Drops the oldest final lines while the ledger is over its size, never the
   * line just applied nor a line still being heard: a later final or
   * retraction of an open line must find it, so open lines are held over the
   * size until they close.
   */
  private trim(keep: string): void {
    while (this.lines.size > this.maxItems) {
      let drop: string | undefined;
      for (const line of this.lines.values()) {
        if (line.isFinal && line.itemId !== keep) {
          drop = line.itemId;
          break;
        }
      }
      if (drop === undefined) return;
      this.lines.delete(drop);
      this.retracted.delete(drop);
    }
  }
}

/**
 * Presentation order without changing replay order. Each parent and its
 * children occupy the family's first-seen position, parent first, then child
 * suffixes in numeric order. Other lines retain first-seen order. Missing
 * parents are allowed; malformed suffixes follow valid ones in arrival order.
 */
export function readingOrder(items: readonly LedgerItem[]): LedgerItem[] {
  const families = new Map<string, LedgerItem[]>();
  for (const item of items) {
    const key = item.runOf ?? item.itemId;
    const family = families.get(key);
    if (family) family.push(item);
    else families.set(key, [item]);
  }
  const ordered: LedgerItem[] = [];
  for (const [parent, family] of families) {
    const ranked = family.map((item, index) => ({ item, index, rank: runPosition(item, parent) }));
    ranked.sort((left, right) => {
      if (left.rank < right.rank) return -1;
      if (left.rank > right.rank) return 1;
      return left.index - right.index;
    });
    ordered.push(...ranked.map(({ item }) => item));
  }
  return ordered;
}

/** Parent first, then safe numeric child suffixes, then malformed children. */
function runPosition(item: LedgerItem, parent: string): number {
  if (item.itemId === parent) return 0;
  const prefix = `${parent}.`;
  if (item.itemId.startsWith(prefix) === false) return Infinity;
  const suffix = item.itemId.slice(prefix.length);
  if (/^\d+$/.test(suffix) === false) return Infinity;
  const position = Number(suffix);
  return Number.isSafeInteger(position) && position >= 2 ? position : Infinity;
}

/**
 * Reads one LiveKit transcription stream (its text and attributes) as a
 * {@link LedgerEvent}, or `null` when it carries no segment id. The stream's
 * {@link TRANSCRIPTION_TIME_ATTRIBUTES} become the event's `startMs` and
 * `endMs`, each only when it holds whole milliseconds in decimal digits; a time
 * the stream does not carry, or carries in any other form, is left undefined.
 *
 * A speaker attribute is read on interims and finals: an empty string means
 * null, while absence means no requested speaker information. A split run's
 * parent attribute becomes runOf. Neither field changes the replay cursor.
 */
export function transcriptEventFromLiveKit(text: string, attributes: Readonly<Record<string, string>> | undefined): LedgerEvent | null {
  if (attributes === undefined) return null;
  const itemId = attributes[LIVEKIT_TRANSCRIPTION_ATTRIBUTES.segmentId];
  if (!itemId) return null;
  const event: LedgerEvent = { itemId, text, isFinal: attributes[LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final] === 'true' };
  const speaker = attributes[TRANSCRIPTION_SPEAKER_ATTRIBUTE];
  if (typeof speaker === 'string') event.speaker = speaker === '' ? null : speaker;
  const runOf = attributes[TRANSCRIPTION_RUN_OF_ATTRIBUTE];
  if (typeof runOf === 'string') event.runOf = runOf;
  const failed = attributes[TRANSCRIPTION_FAILED_ATTRIBUTE];
  if (failed) event.failed = failed;
  const startMs = readMs(attributes[TRANSCRIPTION_TIME_ATTRIBUTES.startMs]);
  if (startMs !== undefined) event.startMs = startMs;
  const endMs = readMs(attributes[TRANSCRIPTION_TIME_ATTRIBUTES.endMs]);
  if (endMs !== undefined) event.endMs = endMs;
  return event;
}

/**
 * A time attribute's value as milliseconds: a string of decimal digits alone,
 * read as a number while it is an integer a number holds exactly; `undefined`
 * for anything else (no value, an empty string, a sign, a space, a fraction,
 * an exponent, a hexadecimal form, a separator).
 */
function readMs(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const ms = Number(value);
  return Number.isSafeInteger(ms) ? ms : undefined;
}
