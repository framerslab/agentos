/**
 * @fileoverview Otter's plain-text export: each turn a header line, a speaker's name, two spaces and the time the
 * turn starts (`Ana Silva  0:01`, `Ana Silva  1:02:10` past the hour), then its paragraph; the file may close with
 * `Transcribed by https://otter.ai`. A Word file laid out the same way, each header and paragraph a paragraph of its
 * own, reads by the same headers.
 * @module agentos/cognition/library/transcripts/otter
 */

import { readLines } from './lines.js';
import { clockMs, finish, isName, squash, type Segment } from './shared.js';
import type { ReadTranscript, TranscriptFormat } from './types.js';

/** A header's time: `M:SS`, or `H:MM:SS` past the hour. */
const HEADER_TIME = /^\d+:\d{2}(?::\d{2})?$/;

/** What stands between a header's name and its time: two spaces or more, or tabs. */
const HEADER_GAP = /^(?: {2,}|\t+)$/;

/** The line Otter closes an export with unless its branding is turned off. */
const CLOSING = /^Transcribed by https:\/\/otter\.ai\/?$/i;

/**
 * A header line's speaker and start, or `null` when the line is no header. A header is a name, two spaces or more
 * (or tabs), a time `M:SS` or `H:MM:SS`, and nothing after it but white space. The line is read from its end with no
 * pattern that backtracks, so a line of many spaces costs one pass over it.
 *
 * @param line - One line of an Otter export.
 */
export function otterHeader(line: string): { label: string; startMs: number } | null {
  const trimmed = line.trimEnd();
  const gapEnd = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\t')) + 1;
  const time = trimmed.slice(gapEnd);
  if (gapEnd === 0 || !HEADER_TIME.test(time)) return null;
  const name = trimmed.slice(0, gapEnd).trimEnd();
  if (!HEADER_GAP.test(trimmed.slice(name.length, gapEnd))) return null;
  const label = name.trim();
  const startMs = clockMs(time);
  return startMs === null || !isName(label) ? null : { label, startMs };
}

/** A text's lines without the blank lines at its end, and without the closing line where it closes the text. */
function bodyOf(text: string): string[] {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  if (end > 0 && CLOSING.test(lines[end - 1].trim())) end -= 1;
  return lines.slice(0, end);
}

/**
 * Whether a text is laid out as Otter's export, for a reader that is not told its format: from its first header on,
 * each line of words comes straight after a header, blank lines aside, and at least two headers have their line of
 * words. The lines before the first header and the closing line are not weighed. A line in other text that looks like
 * a header, such as `Break  10:30` in an agenda, does not make the text Otter's, and neither does a column of names
 * and times with no words under them.
 *
 * @param text - The text, its line ends already line feeds.
 */
export function isOtterLayout(text: string): boolean {
  let headed = false;
  let open = false;
  let turns = 0;
  for (const line of bodyOf(text)) {
    if (line.trim() === '') continue;
    if (otterHeader(line) !== null) {
      headed = true;
      open = true;
    } else if (headed) {
      // A line of words with no header of its own: this is no Otter export.
      if (!open) return false;
      open = false;
      turns += 1;
    }
  }
  return turns >= 2;
}

/**
 * Reads Otter's text. Each turn is a header's speaker and start with the lines up to the next header, joined with
 * spaces; a header with no words is left out, and so are the lines before the first header (a title, a date,
 * keywords) and the closing line where it closes the file. A header gives a start and no end, so `durationMs` is
 * `null`. A text with no header at all, as an export made without speaker names and times is, reads as plain lines.
 *
 * @param text - The file's text, its line ends already line feeds.
 * @param format - The format to answer with: `otter`, or `docx` for a Word file's text.
 */
export function readOtter(text: string, format: TranscriptFormat = 'otter'): ReadTranscript {
  const lines = bodyOf(text);
  const segments: Segment[] = [];
  let current: { label: string; startMs: number; words: string[] } | null = null;
  const close = (): void => {
    if (current !== null) segments.push({ startMs: current.startMs, endMs: null, text: squash(current.words.join(' ')), label: current.label });
  };
  for (const line of lines) {
    const header = otterHeader(line);
    if (header !== null) {
      close();
      current = { ...header, words: [] };
    } else if (current !== null) {
      current.words.push(line);
    }
  }
  close();
  if (segments.length === 0) return readLines(lines.join('\n'), format);
  return finish(format, segments);
}
