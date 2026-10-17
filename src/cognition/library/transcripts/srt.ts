/**
 * @fileoverview SubRip (`.srt`): numbered cues, each a timing line `HH:MM:SS,mmm --> HH:MM:SS,mmm` and its text, the
 * cues apart by blank lines or each starting at its number and timing line. A speaker is a cue's leading `Name: ` by
 * the shared rule; SubRip's formatting tags are removed.
 * @module agentos/cognition/library/transcripts/srt
 */

import { blocksOf, cuesOf, finish, namedSegments, squash, type Segment } from './shared.js';
import type { ReadTranscript } from './types.js';

/** SubRip's formatting tags: bold, italics, underline and a font with its attributes, opening or closing. */
const FORMATTING = /<\/?(?:b|i|u|font)(?:\s[^<>]*)?>/gi;

/**
 * Reads SubRip. A cue is a timing line and the lines after it, joined with spaces, up to a blank line or the next
 * cue's number and timing line; a block's lines before its first timing line, the cue's number among them, are left
 * out, and so is a block with no timing line.
 *
 * @param text - The file's text, its line ends already line feeds.
 */
export function readSrt(text: string): ReadTranscript {
  const segments: Segment[] = cuesOf(blocksOf(text), true).map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: squash(cue.lines.join('\n').replace(FORMATTING, '')),
    label: null,
  }));
  return finish('srt', namedSegments(segments));
}
