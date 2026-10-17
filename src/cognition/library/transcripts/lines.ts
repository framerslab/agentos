/**
 * @fileoverview Plain lines: one turn a line, no times, a speaker's name at a line's start by the `Name: words` rule.
 * A Word file's text is read by the same rule once the caller's extractor has given it, unless it is laid out as
 * Otter's export.
 * @module agentos/cognition/library/transcripts/lines
 */

import { finish, namedSegments, squash, type Segment } from './shared.js';
import type { ReadTranscript, TranscriptFormat } from './types.js';

/**
 * Reads plain lines: each line that holds words is a turn, with no times. A line's leading `Name: ` is its speaker
 * when at least four lines in five open with one and the names are at most twelve.
 *
 * @param text - The file's text, its line ends already line feeds.
 * @param format - The format to answer with: `lines`, or the format of the file the lines came from.
 */
export function readLines(text: string, format: TranscriptFormat = 'lines'): ReadTranscript {
  const segments: Segment[] = text.split('\n').map((line) => ({ startMs: null, endMs: null, text: squash(line), label: null }));
  return finish(format, namedSegments(segments));
}
