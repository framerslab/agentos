/**
 * @fileoverview A Word transcript (`.docx`): its text taken out by an extractor the caller passes, such as mammoth's
 * `extractRawText`, then read with each paragraph a line, by the layout the caller names, or by Otter's headers when
 * it is laid out as Otter's export and as plain lines otherwise.
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
  /**
   * How the file's text is laid out, for a caller that knows where the file came from: `otter` reads it by Otter's
   * headers, `lines` by the `Name: words` rule. Left out, the text is read by Otter's headers when it is laid out as
   * Otter's export, and as plain lines otherwise.
   */
  layout?: 'otter' | 'lines';
}

/**
 * A Word file's text with each paragraph on a line of its own, as the text the file is laid out from holds them.
 * mammoth's text follows each paragraph with a blank line, so there a paragraph ends with a blank line and an empty
 * paragraph adds a second; here a paragraph ends with its line and an empty paragraph is a blank line. The line
 * straight after an Otter header is then the paragraph after it, as it is in Otter's text.
 */
function paragraphLines(text: string): string {
  return text.replace(/\n\n/g, '\n');
}

/**
 * Reads a Word transcript. The extractor is handed a copy of the file's own bytes (a view such as a Node `Buffer` may
 * share its memory with other data). The text it answers is read with each paragraph a line, by the caller's
 * `layout`, or, without one, by Otter's headers when it is laid out as Otter's export (a header and its words in
 * paragraphs of their own) and otherwise as plain lines, `Name: words` naming the speakers by the shared rule. A Word
 * file with no text reads as no turns.
 *
 * @param bytes - The Word file's bytes.
 * @param options - The extractor, and the layout when the caller knows it.
 * @throws {@link TranscriptReadError} when the extractor fails, with what it threw as `cause`, or answers something
 * other than a text, an object with no `value` string.
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
  const text = paragraphLines(textOf(extracted.value));
  const otter = options.layout === undefined ? isOtterLayout(text) : options.layout === 'otter';
  return otter ? readOtter(text, 'docx') : readLines(text, 'docx');
}
