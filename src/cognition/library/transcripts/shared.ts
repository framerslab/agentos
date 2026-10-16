/**
 * @fileoverview What every transcript reader shares: the text of a string or of UTF-8 bytes, white space collapsed,
 * the times of a clock, the rule that finds a speaker's name at the start of a line, and the numbering of the turns.
 * Imports nothing outside this folder.
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
 * The text of a file: bytes decoded as UTF-8, a leading byte order mark dropped, and CRLF or CR line ends read as
 * line feeds.
 */
export function textOf(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
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
 * comma; the leading part may run past 59 (`75:30` is 75 minutes and 30 seconds). `null` for anything else.
 */
export function clockMs(clock: string): number | null {
  const match = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?$/.exec(clock.trim());
  if (match === null) return null;
  const [, first, second, third, fraction] = match;
  const seconds = third === undefined ? Number(first) * 60 + Number(second) : (Number(first) * 60 + Number(second)) * 60 + Number(third);
  return seconds * 1000 + (fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')));
}

/** A letter a speaker's name may start with: a capital, a title-case letter, or a letter of a script with no case. */
const NAME_START = /^[\p{Lu}\p{Lt}\p{Lo}]/u;

/** The most characters a speaker's name holds. */
const NAME_LENGTH = 40;

/** Whether a text, already trimmed, can be a speaker's name: forty characters at most, no colon, the right start. */
export function isName(text: string): boolean {
  // A code point is one or two UTF-16 units, so a longer text is no name and is never split into code points.
  if (text.length === 0 || text.length > 2 * NAME_LENGTH) return false;
  return Array.from(text).length <= NAME_LENGTH && !text.includes(':') && NAME_START.test(text);
}

/**
 * A text's leading speaker, `Name: words`: the name is what comes before the first colon, trimmed, and must pass
 * {@link isName}; the colon is followed by white space and words. `null` when the text opens with no such name.
 */
export function splitLabel(text: string): { label: string; text: string } | null {
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const label = text.slice(0, colon).trim();
  const rest = text.slice(colon + 1);
  if (!/^\s+\S/.test(rest) || !isName(label)) return null;
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
