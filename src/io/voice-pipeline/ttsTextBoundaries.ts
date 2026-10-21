/**
 * @module voice-pipeline/ttsTextBoundaries
 *
 * The text a reply has proven spoken, from the text/audio boundaries a
 * streaming TTS adapter attaches to its chunks ({@link TtsTextBoundary}).
 *
 * {@link SentenceSegmenter} cuts the text a reply submits into immutable
 * sentence segments, each with its exact offsets in the submitted text. A
 * segment ends at a sentence-ending mark (`.`, `!`, `?` or `…`, with the
 * closing quotes and brackets right after it) once a whitespace character has
 * followed it, so a decimal point or an abbreviation inside a word never ends
 * one. So that a long sentence reaches the provider while the reply still
 * streams, a segment also ends at a clause mark (a comma, a semicolon, a
 * colon, an en or em dash, or a hyphen set off by a space from the word before
 * it, with the closers right after it, again once whitespace has followed)
 * when it holds at least 40 characters, or 20 for a reply's first segment, so
 * its audio starts sooner; a mark inside a number, a time, a word or a range
 * (`1,250`, `10:30`, `well-known`, `1990–2000`) has no whitespace after it and
 * ends none. A segment that runs past 120 characters with no mark to end at
 * ends at its last whitespace within them, or, with none there, at the first
 * whitespace after them. The cuts depend on the text alone, never on the
 * pieces it arrives in, and `flush()` cuts whatever remains as the final,
 * unterminated segment. An adapter synthesizes one segment at a time and
 * attaches the segment's boundary to the last audio frame its provider's
 * completion message proves complete.
 *
 * {@link PlayedTextTracker} turns the transport's playback acknowledgements of
 * those frames into the reply's played text: only the contiguous prefix of
 * acknowledged segments counts, a chunk a clear discarded never advances it,
 * and the legacy cumulative `EncodedAudioChunk.text` is never read. What it
 * cannot prove stays unknown: its `playedText` is empty until the first
 * segment's last frame is acknowledged.
 *
 * @example
 * ```typescript
 * const segmenter = new SentenceSegmenter();
 * segmenter.push('Hello there.'); // []: no whitespace has followed the mark yet
 * segmenter.push(' How are'); // [{ segmentId: 'seg-1', start: 0, end: 12, text: 'Hello there.' }]
 * segmenter.flush(); // { segmentId: 'seg-2', start: 12, end: 20, text: ' How are' }
 * ```
 */

import type { TtsTextBoundary } from './types.js';

/** One sentence segment of a reply's submitted text, with its exact offsets. */
export interface TextSegment {
  /** The segment's id, unique within the segmenter. */
  segmentId: string;
  /** Offset of the segment's first character in the submitted text. */
  start: number;
  /** Offset past the segment's last character in the submitted text. */
  end: number;
  /** The segment's text, `submitted.slice(start, end)`, kept exactly. */
  text: string;
}

/** A sentence-ending mark. */
const SENTENCE_END = /[.!?…]/;
/** A clause mark: a comma, a semicolon, a colon, an en dash or an em dash. A hyphen is one only as a dash (`clauseMarkAt`). */
const CLAUSE_MARK = /[,;:\u2013\u2014]/;
/** A character that continues a run of clause marks, such as the second hyphen of `--`. */
const CLAUSE_RUN = /[,;:\u2013\u2014-]/;
/** A closing quote or bracket that stays with the sentence or clause it closes. */
const CLOSER = /["'”’)\]]/;
/** A whitespace character. */
const WHITESPACE = /\s/;
/** How many characters a segment after its reply's first holds before a clause mark may end it. */
const CLAUSE_MIN_LENGTH = 40;
/** How many characters a reply's first segment holds before a clause mark may end it: fewer, so the reply's audio starts sooner. */
const FIRST_CLAUSE_MIN_LENGTH = 20;
/** With no mark to end at, a segment ends at its last whitespace within this many characters. */
const MAX_LENGTH = 120;

/**
 * Whether a clause mark starts at `at`: a `CLAUSE_MARK`, or a hyphen used
 * as a dash, a space or tab between it and the word before it, so that a
 * hyphenated word, a negative number and a list bullet at a line's start are
 * none.
 */
function clauseMarkAt(text: string, at: number): boolean {
  if (CLAUSE_MARK.test(text[at])) return true;
  return text[at] === '-' && at >= 2 && /[ \t]/.test(text[at - 1]) && !WHITESPACE.test(text[at - 2]);
}

/** Whether a word ends at `at`: a whitespace character there, after a character besides whitespace. */
function wordEndsAt(text: string, at: number): boolean {
  return at > 0 && WHITESPACE.test(text[at]) && !WHITESPACE.test(text[at - 1]);
}

/**
 * Cuts submitted text into immutable sentence segments with exact offsets: at
 * a sentence's end, at a clause mark once the segment holds enough characters,
 * or at a word's end once it runs past 120 characters with no mark to end at,
 * as the module describes. Text is appended with
 * {@link SentenceSegmenter.push}, which returns the segments it completes, in
 * order; {@link SentenceSegmenter.flush} returns the final segment, the text
 * after the last completed one, when it holds a character besides whitespace;
 * {@link SentenceSegmenter.reset} starts the next reply.
 */
export class SentenceSegmenter {
  private pending = '';
  private offset = 0;
  private count = 0;
  private text = '';
  /** Whether a segment of this reply has been cut: the first one ends at a clause mark sooner. */
  private cutThisReply = false;

  /**
   * @param idPrefix - The prefix of the segment ids, followed by a counter from 1. @defaultValue 'seg-'
   */
  constructor(private readonly idPrefix = 'seg-') {}

  /** All the text submitted so far, exactly. */
  get submitted(): string {
    return this.text;
  }

  /** The text after the last completed segment, not yet cut. */
  get remainder(): string {
    return this.pending;
  }

  /**
   * Appends submitted text and returns the segments it completes, in order: each
   * ends at a sentence-ending mark, or at a clause mark once it holds 40
   * characters (20 for the reply's first), with the closers right after the
   * mark, once at least one whitespace character has followed; with no mark to
   * end at within 120 characters, it ends at its last whitespace within them,
   * once a character past them has arrived. The whitespace opens the next
   * segment.
   *
   * @param tokens - The text, as the reply submits it.
   */
  push(tokens: string): TextSegment[] {
    if (!tokens) return [];
    this.text += tokens;
    this.pending += tokens;
    const segments: TextSegment[] = [];
    for (;;) {
      const cut = this.cutPoint();
      if (cut === undefined) return segments;
      segments.push(this.cut(cut));
    }
  }

  /**
   * Cuts what remains as the final segment, when it holds a character besides
   * whitespace; whitespace alone is left where it is and makes no segment.
   */
  flush(): TextSegment | undefined {
    if (!this.pending.trim()) return undefined;
    return this.cut(this.pending.length);
  }

  /** Forgets every character and starts the next reply: offsets start again at 0, and the next segment is the reply's first; the ids go on counting. */
  reset(): void {
    this.pending = '';
    this.offset = 0;
    this.text = '';
    this.cutThisReply = false;
  }

  /**
   * Where the first segment of the pending text ends, or `undefined` while no cut is settled: at the first mark that
   * ends a segment within `MAX_LENGTH` characters; else, once the text runs past them, at the last word end
   * within them, or, with none there, at the first word end after them.
   */
  private cutPoint(): number | undefined {
    const text = this.pending;
    const clauseMinLength = this.cutThisReply ? CLAUSE_MIN_LENGTH : FIRST_CLAUSE_MIN_LENGTH;
    for (let i = 0; i < text.length && i < MAX_LENGTH; i++) {
      const sentence = SENTENCE_END.test(text[i]);
      if (!sentence && !clauseMarkAt(text, i)) continue;
      const run = sentence ? SENTENCE_END : CLAUSE_RUN;
      let end = i + 1;
      // A run of marks ("?!", "...", "--") ends together.
      while (end < text.length && run.test(text[end])) end++;
      while (end < text.length && CLOSER.test(text[end])) end++;
      if (end > MAX_LENGTH) break;
      // A mark ends the segment once whitespace has followed, and a clause mark only a segment that holds enough
      // characters; a mark inside a word, or at the very end of what was submitted so far, waits for more text.
      if (end < text.length && WHITESPACE.test(text[end]) && (sentence || end >= clauseMinLength)) return end;
      i = end - 1;
    }
    // With no mark to end at within the bound, the cut waits for a character past it, which settles whether a mark
    // ends the segment right at the bound, so the cuts are the same however the text arrives.
    if (text.length <= MAX_LENGTH) return undefined;
    for (let at = MAX_LENGTH; at > 0; at--) if (wordEndsAt(text, at)) return at;
    // A run without whitespace past the bound, such as a long link, ends at the first word end after it.
    for (let at = MAX_LENGTH + 1; at < text.length; at++) if (wordEndsAt(text, at)) return at;
    return undefined;
  }

  private cut(length: number): TextSegment {
    const segment: TextSegment = {
      segmentId: `${this.idPrefix}${++this.count}`,
      start: this.offset,
      end: this.offset + length,
      text: this.pending.slice(0, length),
    };
    this.pending = this.pending.slice(length);
    this.offset += length;
    this.cutThisReply = true;
    return segment;
  }
}

/**
 * The boundary an adapter attaches to the last frame of a segment its provider
 * reported complete.
 *
 * @param segment - The segment.
 */
export function boundaryOf(segment: TextSegment): TtsTextBoundary {
  return { segmentId: segment.segmentId, start: segment.start, end: segment.end, text: segment.text, final: true };
}

/**
 * The played text of one reply, from acknowledged boundaries. A chunk that
 * carries a boundary is recorded as sent under a key (its playback sequence);
 * the transport's acknowledgement of that key makes its segment heard; a
 * clear forgets every chunk sent and not yet acknowledged, so a late
 * acknowledgement of one advances nothing. The played text is the contiguous
 * prefix of acknowledged segments, from offset 0, each starting where the one
 * before it ended.
 */
export class PlayedTextTracker {
  private readonly sentChunks = new Map<string, TtsTextBoundary>();
  private heard: TtsTextBoundary[] = [];

  /**
   * A chunk that carries a boundary was handed to the transport.
   *
   * @param key - The chunk's playback sequence, or any key the acknowledgement will name.
   * @param boundary - The chunk's boundary; a chunk without one is not recorded.
   */
  sent(key: number | string, boundary: TtsTextBoundary | undefined): void {
    if (!boundary) return;
    this.sentChunks.set(String(key), boundary);
  }

  /**
   * The transport acknowledged a chunk as played. A key not sent, or one a clear forgot, changes nothing.
   *
   * @param key - The key it was sent under.
   */
  acknowledged(key: number | string): void {
    const boundary = this.sentChunks.get(String(key));
    if (!boundary) return;
    this.sentChunks.delete(String(key));
    const at = this.heard.findIndex((other) => other.start > boundary.start);
    if (at === -1) this.heard.push(boundary);
    else this.heard.splice(at, 0, boundary);
  }

  /** A clear, a pause's drop or a newer generation discarded every chunk sent and not yet acknowledged. */
  cleared(): void {
    this.sentChunks.clear();
  }

  /** The text proven played: the contiguous prefix of acknowledged segments, exactly; empty while none is. */
  get playedText(): string {
    let end = 0;
    let text = '';
    for (const boundary of this.heard) {
      if (boundary.start !== end) break;
      text += boundary.text;
      end = boundary.end;
    }
    return text;
  }

  /** Forgets everything, for the next reply. */
  reset(): void {
    this.sentChunks.clear();
    this.heard = [];
  }
}
