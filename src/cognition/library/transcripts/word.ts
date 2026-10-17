/**
 * @fileoverview A Word transcript (`.docx`): its text taken out by an extractor the caller passes, such as mammoth's
 * `extractRawText`, then read by Otter's headers when it is laid out as Otter's export and as plain lines otherwise.
 * This module imports no package, so the entry that holds it stays free of one; a page passes mammoth's browser build,
 * which opens `{ arrayBuffer }`.
 * @module agentos/cognition/library/transcripts/word
 */

import { readLines } from './lines.js';
import { isOtterLayout, readOtter } from './otter.js';
import { textOf } from './shared.js';
import { TranscriptReadError, type ReadTranscript } from './types.js';

/** mammoth's `extractRawText`, or any function of its shape: a Word file's bytes in, its text out. */
export type ExtractRawText = (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;

/** What `readWordTranscript` needs from its caller. */
export interface ReadWordTranscriptOptions {
  /** Takes the text out of a Word file. */
  extractRawText: ExtractRawText;
}

/**
 * Reads a Word transcript. The extractor is handed a copy of the file's own bytes (a view such as a Node `Buffer` may
 * share its memory with other data). The text it answers is read by Otter's headers when it is laid out as Otter's
 * export, each header and its paragraph a paragraph of their own, and otherwise as plain lines, `Name: words` naming
 * the speakers by the shared rule.
 *
 * @param bytes - The Word file's bytes.
 * @param options - The extractor.
 * @throws {@link TranscriptReadError} when the extractor fails, with what it threw as `cause`, or answers no text.
 */
export async function readWordTranscript(bytes: Uint8Array, options: ReadWordTranscriptOptions): Promise<ReadTranscript> {
  const copy = new Uint8Array(bytes);
  let extracted: { value: string };
  try {
    extracted = await options.extractRawText({ arrayBuffer: copy.buffer });
  } catch (error) {
    throw new TranscriptReadError('docx', 'the extractor could not read the file', error);
  }
  if (typeof extracted?.value !== 'string') throw new TranscriptReadError('docx', 'the extractor answered no text');
  const text = textOf(extracted.value);
  return isOtterLayout(text) ? readOtter(text, 'docx') : readLines(text, 'docx');
}
