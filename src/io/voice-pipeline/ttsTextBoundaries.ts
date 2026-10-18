/**
 * @module voice-pipeline/ttsTextBoundaries
 *
 * The text a reply has proven spoken, from the text/audio boundaries a
 * streaming TTS adapter attaches to its chunks ({@link TtsTextBoundary}).
 *
 * {@link SentenceSegmenter} cuts the text a reply submits into immutable
 * sentence segments, each with its exact offsets in the submitted text: a
 * segment ends at a sentence-ending mark (`.`, `!`, `?` or `…`, with the
 * closing quotes and brackets right after it) once a whitespace character has
 * followed it, so a decimal point or an abbreviation inside a word never ends
 * one, and `flush()` cuts whatever remains as the final, unterminated segment.
 * An adapter synthesizes one segment at a time and attaches the segment's
 * boundary to the last audio frame its provider's completion message proves
 * complete.
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
/** A closing quote or bracket that stays with the sentence it closes. */
const CLOSER = /["'”’)\]]/;

/**
 * Cuts submitted text into immutable sentence segments with exact offsets.
 * Text is appended with {@link SentenceSegmenter.push}, which returns the
 * segments it completes, in order; {@link SentenceSegmenter.flush} returns the
 * final segment, the text after the last completed one, when it holds a
 * character besides whitespace.
 */
export class SentenceSegmenter {
  private pending = '';
  private offset = 0;
  private count = 0;
  private text = '';

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
   * Appends submitted text and returns the segments it completes: each ends at a
   * sentence-ending mark, with the closers right after it, once at least one
   * whitespace character has followed; the whitespace opens the next segment.
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

  /** Forgets every character: offsets start again at 0; the ids go on counting. */
  reset(): void {
    this.pending = '';
    this.offset = 0;
    this.text = '';
  }

  /** The end of the first complete sentence in the pending text, or `undefined`. */
  private cutPoint(): number | undefined {
    const text = this.pending;
    for (let i = 0; i < text.length; i++) {
      if (!SENTENCE_END.test(text[i])) continue;
      let end = i + 1;
      // A run of marks ("?!", "...") ends together.
      while (end < text.length && SENTENCE_END.test(text[end])) end++;
      while (end < text.length && CLOSER.test(text[end])) end++;
      // The sentence is complete once whitespace has followed; a mark inside a word, or at the very end of what was
      // submitted so far, waits for more text.
      if (end < text.length && /\s/.test(text[end])) return end;
      i = end - 1;
    }
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
