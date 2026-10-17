/**
 * @fileoverview What every transcript reader shares: the text of a string or of a file's bytes, white space
 * collapsed, a caption file's cues and their timing lines, the times of a clock, the rule that finds a speaker's name
 * at the start of a line, and the numbering of the turns. Imports nothing outside this folder.
 * @module agentos/cognition/library/transcripts/shared
 */

import type { ReadTranscript, TranscriptFileLabel, TranscriptFileTurn, TranscriptFormat } from './types.js';

/** A turn before it is numbered: its times, its words and the speaker the file names, if any. */
export interface Segment {
  startMs: number | null;
  endMs: number | null;
  text: string;
  label: string | null;
}

/**
 * Bytes as text: UTF-16 when they open with its byte order mark, in either byte order, and UTF-8 otherwise. UTF-16
 * in big-endian order is read with each pair of bytes swapped, since every platform's `TextDecoder` reads
 * little-endian UTF-16 and a Node built without ICU reads no other.
 */
function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length);
    for (let at = 0; at + 1 < bytes.length; at += 2) {
      swapped[at] = bytes[at + 1];
      swapped[at + 1] = bytes[at];
    }
    if (bytes.length % 2 === 1) swapped[bytes.length - 1] = bytes[bytes.length - 1];
    return new TextDecoder('utf-16le').decode(swapped);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * The text of a file: bytes decoded as UTF-16 when they open with its byte order mark, in either byte order, and as
 * UTF-8 otherwise; a leading byte order mark dropped; and CRLF or CR line ends read as line feeds.
 */
export function textOf(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : decode(input);
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** A text with every run of white space made one space, and none at either end. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The lines of a text, split into blocks at lines that are empty or white space alone. */
export function blocksOf(text: string): string[][] {
  const blocks: string[][] = [];
  let block: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (block.length > 0) blocks.push(block);
      block = [];
    } else {
      block.push(line);
    }
  }
  if (block.length > 0) blocks.push(block);
  return blocks;
}

/**
 * Milliseconds of a clock written `M:SS` or `H:MM:SS`, with an optional fraction of a second after a full stop or a
 * comma. The leading part may run past 59 (`75:30` is 75 minutes and 30 seconds); the minutes and seconds after it
 * run to 59 at most. `null` for anything else, and for a time past the largest safe integer of milliseconds.
 */
export function clockMs(clock: string): number | null {
  const match = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/.exec(clock.trim());
  if (match === null) return null;
  const [, first, second, third, fraction] = match;
  if (Number(second) > 59 || (third !== undefined && Number(third) > 59)) return null;
  const seconds = third === undefined ? Number(first) * 60 + Number(second) : (Number(first) * 60 + Number(second)) * 60 + Number(third);
  const ms = seconds * 1000 + (fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')));
  return Number.isSafeInteger(ms) ? ms : null;
}

/** A cue's timing line: a start, an arrow and an end, anything after the end (WebVTT's cue settings) ignored. */
const TIMING = /^\s*(\S+?)\s*-->\s*(\S+)(?:\s.*)?$/;

/**
 * The start and end of a timing line, `00:00:01,000 --> 00:00:04,200` or `00:01.000 --> 00:04.200`, in milliseconds;
 * `null` when the line is no timing line, as a line of words that holds `-->` is not.
 *
 * @param line - A line that may hold `start --> end`.
 */
export function cueTimes(line: string): { startMs: number; endMs: number } | null {
  const match = TIMING.exec(line);
  if (match === null) return null;
  const startMs = clockMs(match[1]);
  const endMs = clockMs(match[2]);
  return startMs === null || endMs === null ? null : { startMs, endMs };
}

/** A caption file's cue: its times and the lines of its text. */
export interface Cue {
  startMs: number;
  endMs: number;
  /** The lines after the timing line. */
  lines: string[];
}

/**
 * A caption file's cues, cut from its blocks as WebVTT's parser cuts them: each timing line starts a cue whose text
 * is the lines after it, up to the block's end or the next timing line, so cues written with no blank line between
 * them read as cues. The lines before a block's first timing line, a cue's identifier or anything else, are no part of
 * a cue, and a block with no timing line, such as WebVTT's `NOTE`, `STYLE` and `REGION` blocks, is no cue. With
 * `numbered`, as SubRip's cues are, a line of digits just before a timing line is that cue's number, not the words of
 * the cue before it, unless it is that cue's only line. A line that holds `-->` and is no timing line is a line of
 * words.
 *
 * @param blocks - The file's blocks, as {@link blocksOf} cuts them.
 * @param numbered - Whether a cue opens with its number.
 */
export function cuesOf(blocks: readonly string[][], numbered: boolean): Cue[] {
  const cues: Cue[] = [];
  for (const block of blocks) {
    let cue: Cue | null = null;
    for (const line of block) {
      const times = cueTimes(line);
      if (times === null) {
        cue?.lines.push(line);
        continue;
      }
      if (cue !== null) {
        const last = cue.lines[cue.lines.length - 1];
        if (numbered && cue.lines.length > 1 && /^\d+$/.test(last.trim())) cue.lines.pop();
        cues.push(cue);
      }
      cue = { ...times, lines: [] };
    }
    if (cue !== null) cues.push(cue);
  }
  return cues;
}

/** A letter a speaker's name may start with: a capital, a title-case letter, or a letter of a script with no case. */
const NAME_START = /^[\p{Lu}\p{Lt}\p{Lo}]/u;

/** A letter of any case or script, as the start of a name a header gives. */
const LETTER_START = /^\p{L}/u;

/** The most characters a speaker's name holds. */
const NAME_LENGTH = 40;

/** A colon that ends a speaker's name: the ASCII colon, or the full-width colon of Chinese and Japanese text. */
const COLON = /[:：]/;

/**
 * Whether a text, already trimmed, can be a speaker's name: forty characters at most, no colon, and the right start.
 * In running text, where `Name: words` tells a name from a sentence only by its start, the start is a capital or a
 * letter of a script with no case, so `note: one` is a sentence. With `anyCase`, for a name a header gives on a line of
 * its own (Otter's `john  0:01`), any letter starts it, since a name typed in lower case is still the speaker's.
 *
 * @param text - The text, already trimmed.
 * @param options - `anyCase` to take a name that starts with a letter of any case.
 */
export function isName(text: string, options: { anyCase?: boolean } = {}): boolean {
  // A code point is one or two UTF-16 units, so a longer text is no name and is never split into code points.
  if (text.length === 0 || text.length > 2 * NAME_LENGTH) return false;
  const start = options.anyCase === true ? LETTER_START : NAME_START;
  return Array.from(text).length <= NAME_LENGTH && !COLON.test(text) && start.test(text);
}

/**
 * A text's leading speaker, `Name: words`: the name is what comes before the first colon, trimmed, and must pass
 * {@link isName}. An ASCII colon is followed by white space and words, so a time such as `10:30` names no one; the
 * full-width colon `：` is followed by words, with or without a space. `null` when the text opens with no such name.
 */
export function splitLabel(text: string): { label: string; text: string } | null {
  const colon = COLON.exec(text);
  if (colon === null || colon.index === 0) return null;
  const label = text.slice(0, colon.index).trim();
  const rest = text.slice(colon.index + 1);
  const words = colon[0] === ':' ? /^\s+\S/ : /^\s*\S/;
  if (!words.test(rest) || !isName(label)) return null;
  return { label, text: rest.trim() };
}

/** The most distinct names the `Name: words` rule takes as speakers. */
const MOST_NAMES = 12;

/**
 * Speakers by the `Name: words` rule: taken only when at least four texts in five open with a name and the names are
 * at most twelve, else no text has a speaker and every text stays whole. A text with no name keeps its words.
 */
export function namedSegments(segments: readonly Segment[]): Segment[] {
  const spoken = segments.filter((segment) => segment.text.length > 0);
  const splits = spoken.map((segment) => splitLabel(segment.text));
  const named = splits.filter((split) => split !== null);
  const holds =
    spoken.length > 0 &&
    named.length * 5 >= spoken.length * 4 &&
    new Set(named.map((split) => split.label)).size <= MOST_NAMES;
  if (!holds) return spoken.map((segment) => ({ ...segment, label: null }));
  return spoken.map((segment, at) => {
    const split = splits[at];
    return split === null ? { ...segment, label: null } : { ...segment, text: split.text, label: split.label };
  });
}

/**
 * The reader's answer: segments with no words left out, the rest numbered from 1 in order, their speakers listed
 * apart, and the length the last turn's end.
 */
export function finish(format: TranscriptFormat, segments: readonly Segment[]): ReadTranscript {
  const turns: TranscriptFileTurn[] = [];
  const labels: TranscriptFileLabel[] = [];
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const seq = turns.length + 1;
    turns.push({ seq, startMs: segment.startMs, endMs: segment.endMs, text: segment.text });
    if (segment.label !== null) labels.push({ seq, label: segment.label });
  }
  const last = turns[turns.length - 1];
  return { format, turns, labels, durationMs: last === undefined ? null : last.endMs };
}
