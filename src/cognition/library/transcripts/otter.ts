/**
 * @fileoverview Otter's plain-text export: each turn a header line, then its paragraph; the file may close with
 * `Transcribed by https://otter.ai`. The export can be made without the speakers' names, without the times or with
 * neither, and a header holds what it was made with: the speaker's name, two spaces and the time the turn starts
 * (`Ana Silva  0:01`, `Ana Silva  1:02:10` past the hour); the time alone (`0:01  `); or the name alone (`Ana Silva  `),
 * Otter writing two spaces after each part of a header. A text whose lines lost the spaces at their ends holds a time
 * alone without them (`0:01`). An export made with neither holds its paragraphs alone. Otter's export of a voice note
 * writes each header as the name, one space and the time, with nothing after it (`Unknown 0:00`). A Word file laid out
 * the same way, each header and paragraph a paragraph of its own, reads by the same headers. Otter writes a blank line
 * after each turn's words, and where a line of words can take a header's form, the blank lines tell the two apart.
 * @module agentos/cognition/library/transcripts/otter
 */

import { readLines } from './lines.js';
import { clockMs, finish, isName, squash, type Segment } from './shared.js';
import type { ReadTranscript, TranscriptFormat } from './types.js';

/** A header's time: `M:SS`, or `H:MM:SS` past the hour. */
const HEADER_TIME = /^\d+:\d{2}(?::\d{2})?$/;

/** What stands between a header's name and its time, and after a name with no time: two spaces or more, or tabs. */
const HEADER_GAP = /^(?: {2,}|\t+)$/;

/** The line Otter closes an export with unless its branding is turned off. */
const CLOSING = /^Transcribed by https:\/\/otter\.ai\/?$/i;

/** What a header gives: the speaker's name and the turn's start, each `null` when the export is made without it. */
interface Header {
  label: string | null;
  startMs: number | null;
}

/** A header and its words: the lines after it up to the next header. */
interface HeadedTurn extends Header {
  words: string[];
}

/**
 * A line read as a name and a time: the speaker's name, the white space between the name and the time, and the turn's
 * start; `null` when the line does not end in a time with nothing after it but white space, or holds no name before
 * the time. The line is read from its end with no pattern that backtracks.
 *
 * @param line - One line of an Otter export.
 */
function nameAndTime(line: string): { label: string; gap: string; startMs: number } | null {
  const trimmed = line.trimEnd();
  const gapEnd = Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\t')) + 1;
  const time = trimmed.slice(gapEnd);
  if (gapEnd === 0 || !HEADER_TIME.test(time)) return null;
  const name = trimmed.slice(0, gapEnd).trimEnd();
  const label = name.trim();
  const startMs = clockMs(time);
  if (startMs === null || !isName(label, { anyCase: true })) return null;
  return { label, gap: trimmed.slice(name.length, gapEnd), startMs };
}

/**
 * A header line's speaker and start, in an export made with the names and the times, or `null` when the line is no
 * such header. A header is a name, two spaces or more (or tabs), a time `M:SS` or `H:MM:SS`, and nothing after it but
 * white space. The name holds at most forty characters and no colon and starts with a letter of any case or script,
 * since a speaker named in Otter may be typed in lower case (`john  0:01`). The line is read from its end with no
 * pattern that backtracks, so a line of many spaces costs one pass over it.
 *
 * @param line - One line of an Otter export.
 */
export function otterHeader(line: string): { label: string; startMs: number } | null {
  const header = nameAndTime(line);
  return header === null || !HEADER_GAP.test(header.gap) ? null : { label: header.label, startMs: header.startMs };
}

/**
 * A header line's speaker and start, in Otter's export of a voice note: a name, as {@link otterHeader} takes one, one
 * space and a time, with nothing after it but white space (`Unknown 0:00`); `null` when the line is no such header. A
 * line of words can end the same way (`We meet at 10:30`).
 *
 * @param line - One line of an Otter export.
 */
function voiceNoteHeader(line: string): Header | null {
  const header = nameAndTime(line);
  return header === null || header.gap !== ' ' ? null : { label: header.label, startMs: header.startMs };
}

/** A header's start from a time `M:SS` or `H:MM:SS` alone; `null` for any other text. */
function startOf(time: string): Header | null {
  if (!HEADER_TIME.test(time)) return null;
  const startMs = clockMs(time);
  return startMs === null ? null : { label: null, startMs };
}

/**
 * A header line's start, in an export made without the speakers' names: a time `M:SS` or `H:MM:SS` alone and after it
 * the two spaces or more (or tabs) Otter writes after each part of a header (`0:04  `); `null` when the line is no such
 * header.
 *
 * @param line - One line of an Otter export.
 */
function timeHeader(line: string): Header | null {
  const time = line.trimEnd();
  return HEADER_GAP.test(line.slice(time.length)) ? startOf(time) : null;
}

/**
 * A header line's start, in an export made without the speakers' names whose lines lost the spaces at their ends: a
 * time alone without two spaces after it (`0:04`); `null` when the line is no such header. A paragraph can be a time
 * alone written the same way (`2:30`).
 *
 * @param line - One line of an Otter export.
 */
function bareTimeHeader(line: string): Header | null {
  const time = line.trimEnd();
  return HEADER_GAP.test(line.slice(time.length)) ? null : startOf(time);
}

/**
 * A header line's speaker, in an export made without the times: a name, as {@link otterHeader} takes one, and after
 * it the two spaces or more (or tabs) Otter writes after each part of a header (`Ana Silva  `); `null` when the line
 * is no such header. A name with no spaces after it is a paragraph: Otter ends a paragraph's line with one space at
 * most.
 *
 * @param line - One line of an Otter export.
 */
function nameHeader(line: string): Header | null {
  const name = line.trimEnd();
  if (!HEADER_GAP.test(line.slice(name.length))) return null;
  const label = name.trim();
  return isName(label, { anyCase: true }) ? { label, startMs: null } : null;
}

/** One layout of a header, by what the export is made with. */
interface Layout {
  /** The header a line holds in this layout, or `null`. */
  headerOf: (line: string) => Header | null;
  /**
   * Whether the header is a weaker sign than a name, two spaces and a time, as a time alone, a name alone and a voice
   * note's header are. Such a header heads turns only in an export that opens with one, as {@link opensWith} reads it.
   */
  opens: boolean;
  /**
   * Whether a line of words can take the header's form, as it can a time with no spaces after it (`2:30`) and a name,
   * one space and a time (`We meet at 10:30`). Such a header heads a turn only where Otter writes one. In a text laid
   * out in blocks, as {@link inBlocks} reads it, that is the start of a block, with the header's words on the line
   * straight after it. In a text that is not, it is any line but the one straight after a header, which is that
   * header's words whatever it holds, since Otter writes a header's words on the line after it. A header of the other
   * layouts heads a turn wherever it stands, straight after a header too: a name, two spaces and a time, and a time or
   * a name alone with the two spaces after it, since Otter ends a paragraph's line with one space at most.
   */
  loose: boolean;
  /** Whether the header heads turns only in a text that closes with Otter's closing line. */
  closed: boolean;
}

/** The header of an export made with the names and the times. */
const NAMES_AND_TIMES: Layout = { headerOf: otterHeader, opens: false, loose: false, closed: false };

/**
 * The layouts of a header, one for each way an export is made but with neither the names nor the times, in the order
 * a tie between two is settled: the names and the times, a voice note's name and time, the times alone with the two
 * spaces after them and without, the names alone.
 */
const LAYOUTS: readonly Layout[] = [
  NAMES_AND_TIMES,
  { headerOf: voiceNoteHeader, opens: true, loose: true, closed: true },
  { headerOf: timeHeader, opens: true, loose: false, closed: false },
  { headerOf: bareTimeHeader, opens: true, loose: true, closed: false },
  { headerOf: nameHeader, opens: true, loose: false, closed: false },
];

/**
 * A text's lines without the blank lines at its end, and without the closing line where it closes the text; `closed`
 * says whether it did. Every line kept stays at its place in the text.
 */
function bodyOf(text: string): { lines: string[]; closed: boolean } {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  const closed = end > 0 && CLOSING.test(lines[end - 1].trim());
  return { lines: lines.slice(0, closed ? end - 1 : end), closed };
}

/** Whether a line holds more than white space; `false` for a place before a text's first line or past its last. */
function holdsWords(line: string | undefined): boolean {
  return line !== undefined && line.trim() !== '';
}

/**
 * Whether a text is laid out in blocks, as Otter's text is, for a layout whose header a line of words can take. Otter
 * writes a header's words on the line straight after it and a blank line after each turn's words, the last turn's
 * before the closing line, so each of its headers after the first stands straight after a blank line. Weighed are the
 * lines of the header's form after the text's first line that holds words, each with words on the line straight after
 * it: the text is laid out in blocks when as many of them stand straight after a blank line as straight after a line
 * that holds words, or more, and one does, a blank line before the closing line counting as one more that does. A
 * Word file with no empty paragraphs holds no blank line and is not, and neither is one in which fewer of those lines
 * stand after an empty paragraph than after a paragraph of words.
 *
 * @param lines - The text's lines, as {@link bodyOf} keeps them, so a blank line at their end stood before the closing
 * line.
 * @param layout - The layout whose headers are weighed.
 */
function inBlocks(lines: readonly string[], layout: Layout): boolean {
  const first = lines.findIndex(holdsWords);
  if (first === -1) return false;
  let afterBlank = holdsWords(lines[lines.length - 1]) ? 0 : 1;
  let afterWords = 0;
  for (let at = first + 1; at + 1 < lines.length; at += 1) {
    if (!holdsWords(lines[at + 1]) || layout.headerOf(lines[at]) === null) continue;
    if (holdsWords(lines[at - 1])) afterWords += 1;
    else afterBlank += 1;
  }
  return afterBlank > 0 && afterBlank >= afterWords;
}

/**
 * A text's turns by the headers of one layout: each header with its words, the lines after it up to the next header;
 * the lines before the first header are no turn's. A header of a layout whose header a line of words can take heads a
 * turn only where Otter writes one. In a text laid out in blocks, as {@link inBlocks} reads it, that is the start of a
 * block, the text's first line or one straight after a blank line, with words on the line straight after it, so a
 * later line of a turn's words heads no turn whatever it holds, and a line of the header's form with a blank line
 * after it is a paragraph. In a text that is not, as a Word file with no empty paragraphs is not, nothing but its
 * place tells such a line from a header: the line straight after a header is that header's words, and any other line
 * of the header's form heads a turn. A header of the other layouts heads a turn wherever it stands.
 *
 * @param lines - The text's lines.
 * @param layout - The layout whose headers are read.
 * @param cut - The place of a line read as words, never as a header, as the cut last line of a file's first bytes is;
 * `-1` for none.
 */
function turnsOf(lines: readonly string[], layout: Layout, cut = -1): HeadedTurn[] {
  const blocks = layout.loose && inBlocks(lines, layout);
  const turns: HeadedTurn[] = [];
  let afterHeader = false;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    const placed = blocks ? !holdsWords(lines[at - 1]) && holdsWords(lines[at + 1]) : !(layout.loose && afterHeader);
    const header: Header | null = at === cut || !placed ? null : layout.headerOf(line);
    afterHeader = header !== null;
    if (header !== null) turns.push({ ...header, words: [] });
    else if (turns.length > 0) turns[turns.length - 1].words.push(line);
  }
  return turns;
}

/**
 * Whether a text opens with a header of one layout: the first of its lines that holds more than white space is such a
 * header, and, in a layout whose header a line of words can take, the line straight after it holds that header's
 * words, as Otter writes a header's words. Each paragraph of an export made with neither the names nor the times has a
 * blank line after it, so a first paragraph that takes the form of such a header, `We meet at 10:30` or `2:30`, opens
 * no export of those headers.
 *
 * @param lines - The text's lines, as {@link bodyOf} keeps them.
 * @param layout - The layout whose header is read.
 */
function opensWith(lines: readonly string[], layout: Layout): boolean {
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1 || layout.headerOf(lines[first]) === null) return false;
  return !layout.loose || (first + 1 < lines.length && lines[first + 1].trim() !== '');
}

/**
 * The turns of an export by its own headers, or `null` when it holds none, as an export made with neither the names
 * nor the times does. An export has one layout of header, the one most of its headers are, a tie settled by the order
 * of {@link LAYOUTS}, so a paragraph that is a time alone in an export of names, or of names and times, is words. A
 * header weaker than a name, two spaces and a time heads turns only in an export that opens with one, so in an export
 * of paragraphs a paragraph further down that is a time alone is words, and the paragraphs before it are turns, not
 * lines before a first header; a first paragraph that takes the form of a voice note's header or of a time with no
 * spaces after it, with a blank line after it, is a paragraph too. A voice note's header heads turns only in a text
 * that closes with Otter's closing line, since a line of words can end as it does.
 *
 * @param lines - The text's lines, as {@link bodyOf} keeps them.
 * @param closed - Whether the text closes with Otter's closing line.
 */
function exportTurns(lines: readonly string[], closed: boolean): HeadedTurn[] | null {
  let chosen: HeadedTurn[] | null = null;
  for (const layout of LAYOUTS) {
    if (layout.closed && !closed) continue;
    if (layout.opens && !opensWith(lines, layout)) continue;
    const turns = turnsOf(lines, layout);
    if (turns.length > (chosen === null ? 0 : chosen.length)) chosen = turns;
  }
  return chosen;
}

/**
 * Whether a text is laid out as Otter's export, for a reader that is not told its format: it closes with Otter's
 * closing line, or at least two of its headers of a name and a time have words under them. A turn's words may run over
 * several lines, as a Word file's paragraphs do, and the lines before the first header are not weighed. One line in
 * other text that looks like a header, such as `Break  10:30` in an agenda, does not make the text Otter's, and neither
 * does a column of names and times with no words under them. Times or names alone on lines of their own are not told
 * from an agenda or a page of headings, and a voice note's header, a name, one space and a time, ends as a line of
 * words can, so an export made without the names or without the times, one made with neither and one of a voice note
 * are told by the closing line. Without that line, as when Otter's branding is turned off, such an export and an export
 * of one turn are not told apart from other text.
 *
 * @param text - The text, its line ends already line feeds.
 * @param options - `cutLastLine` when the text is a file's first bytes and its last line may stop short: that line is
 * then read as words, never as a header, since a header cut short is no header.
 */
export function isOtterLayout(text: string, options: { cutLastLine?: boolean } = {}): boolean {
  const { lines, closed } = bodyOf(text);
  if (closed) return true;
  const cut = options.cutLastLine === true ? text.split('\n').length - 1 : -1;
  const worded = turnsOf(lines, NAMES_AND_TIMES, cut).filter((turn) => turn.words.some((line) => line.trim() !== ''));
  return worded.length >= 2;
}

/**
 * Reads Otter's text by the headers of its layout. Each turn is a header's speaker and start, whichever of them the
 * export is made with, and the lines up to the next header, joined with spaces; a header with no words is left out,
 * and so are the lines before the first header (a title, a date, keywords) and the closing line where it closes the
 * file. A header gives a start and no end, so `durationMs` is `null`. A text with no header, as an export made with
 * neither the names nor the times is, reads as plain lines, one turn a paragraph as Otter writes each on a line of its
 * own, without the closing line; so does a voice note's export without the closing line.
 *
 * A line of words can end as a voice note's header does (`We meet at 10:30`). Otter writes a blank line after each
 * turn's words, so in a text laid out so, its headers standing after a blank line at least as often as after a line of
 * words, such a line inside a turn, or at the turn's end, is that turn's words. A Word file with no empty paragraphs
 * holds no blank line, and there such a line straight before the next header reads as a header whose words are that
 * next header's line: the paragraphs `Unknown 0:00`, `Good morning.`, `We meet at 10:30`, `Unknown 0:09`,
 * `Shall we start?` and the closing line read as a turn by `Unknown` at 0 ms, `Good morning.`, and one by `We meet at`
 * at 630,000 ms, `Unknown 0:09 Shall we start?`. Nothing in such a file tells the two apart, and the order of the times
 * does not either, since a header's words can end in an earlier time: `Unknown 10:30` with the words
 * `The bus left at 9:09` and `Shall we start?` has the same layout, its times in the same order.
 *
 * @param text - The file's text, its line ends already line feeds.
 * @param format - The format to answer with: `otter`, or `docx` for a Word file's text.
 */
export function readOtter(text: string, format: TranscriptFormat = 'otter'): ReadTranscript {
  const { lines, closed } = bodyOf(text);
  const turns = exportTurns(lines, closed);
  if (turns === null) return readLines(lines.join('\n'), format);
  const segments: Segment[] = turns.map((turn) => ({
    startMs: turn.startMs,
    endMs: null,
    text: squash(turn.words.join(' ')),
    label: turn.label,
  }));
  return finish(format, segments);
}
