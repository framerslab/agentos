/**
 * @fileoverview SubRip (`.srt`): numbered cues, each a timing line `HH:MM:SS,mmm --> HH:MM:SS,mmm` and its text, the
 * cues apart by blank lines. A speaker is a cue's leading `Name: ` by the shared rule; SubRip's formatting tags are
 * removed.
 * @module agentos/cognition/library/transcripts/srt
 */

import { blocksOf, clockMs, finish, namedSegments, squash, type Segment } from './shared.js';
import type { ReadTranscript } from './types.js';

/** A cue's timing line: a start, an arrow and an end, anything after the end ignored. */
const TIMING = /^\s*(\S+?)\s*-->\s*(\S+)(?:\s.*)?$/;

/** SubRip's formatting tags: bold, italics, underline and a font with its attributes, opening or closing. */
const FORMATTING = /<\/?(?:b|i|u|font)(?:\s[^<>]*)?>/gi;

/**
 * The start and end of a timing line, in milliseconds; `null` when the line is no timing line.
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

/**
 * Reads SubRip. A block is a cue when its first line, or its second after a cue number, is a timing line; its text
 * is every line after the timing line, joined with spaces. Other blocks are left out.
 *
 * @param text - The file's text, its line ends already line feeds.
 */
export function readSrt(text: string): ReadTranscript {
  const segments: Segment[] = [];
  for (const block of blocksOf(text)) {
    const at = block.findIndex((line) => line.includes('-->'));
    if (at < 0 || at > 1) continue;
    const times = cueTimes(block[at]);
    if (times === null) continue;
    segments.push({ ...times, text: squash(block.slice(at + 1).join('\n').replace(FORMATTING, '')), label: null });
  }
  return finish('srt', namedSegments(segments));
}
