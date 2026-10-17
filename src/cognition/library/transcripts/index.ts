/**
 * @fileoverview Transcript files from other notetakers read on the device: SubRip, WebVTT, Otter's text, Fireflies's
 * JSON, plain `Name: words` lines and Word files, each into one shape, `{ format, turns, labels, durationMs }`, with
 * the speakers' labels kept apart from the turns. Browser-safe: nothing here imports a Node module or a package.
 * @module agentos/cognition/library/transcripts
 */

import { readFireflies } from './fireflies.js';
import { readLines } from './lines.js';
import { isOtterLayout, readOtter } from './otter.js';
import { textOf } from './shared.js';
import { readSrt } from './srt.js';
import { TranscriptReadError, type ReadTranscript, type TranscriptFormat } from './types.js';
import { readVtt } from './vtt.js';

export {
  TranscriptReadError,
  type ReadTranscript,
  type TranscriptFileLabel,
  type TranscriptFileTurn,
  type TranscriptFormat,
} from './types.js';
export { readWordTranscript, type ExtractRawText, type ReadWordTranscriptOptions } from './word.js';

/**
 * Reads a transcript file's text, or its bytes, in the format given. Bytes are read as UTF-16 when they open with its
 * byte order mark, in either byte order, and as UTF-8 otherwise. A byte order mark is dropped and CRLF line ends are
 * read as line feeds. A file with no turn reads as none; a length bound is the caller's.
 *
 * @param input - The file's text, or its bytes.
 * @param format - Its format; a Word file is read from its bytes by `readWordTranscript`.
 * @throws {@link TranscriptReadError} for a WebVTT text whose first line is not `WEBVTT`, a Fireflies text that is
 * not JSON, and the format `docx`.
 */
export function readTranscript(input: string | Uint8Array, format: Exclude<TranscriptFormat, 'docx'>): ReadTranscript {
  if ((format as TranscriptFormat) === 'docx') {
    throw new TranscriptReadError('docx', 'a Word file is read from its bytes by readWordTranscript');
  }
  const text = textOf(input);
  switch (format) {
    case 'srt':
      return readSrt(text);
    case 'vtt':
      return readVtt(text);
    case 'otter':
      return readOtter(text);
    case 'fireflies':
      return readFireflies(text);
    case 'lines':
      return readLines(text);
    default:
      throw new TypeError(`readTranscript: no reader for the format ${JSON.stringify(format)}`);
  }
}

/** The first four bytes of a ZIP archive, which a Word file is. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

/** Whether the first bytes are a ZIP archive's. */
function isZip(head: Uint8Array): boolean {
  return ZIP.every((byte, at) => head[at] === byte);
}

/**
 * The format of a transcript file, by its name's extension and its first bytes, which must be the format the name
 * claims; `null` when it is none of them. A `.srt` holds a timing line; a `.vtt` opens with `WEBVTT`; a `.json` holds
 * Fireflies's keys; a `.docx` is a ZIP archive; a `.txt` or `.md` is text, `otter` when it is laid out as Otter's
 * export and `lines` otherwise. The bytes are read as {@link readTranscript} reads them. A PDF is no transcript,
 * whatever its name.
 *
 * @param name - The file's name or path.
 * @param head - The file's first bytes (4 KB is enough), or its text. Its last line is weighed for Otter's layout only
 * when a line feed ends it, since the first bytes of a file can stop inside a line.
 */
export function transcriptFormatOf(name: string, head: Uint8Array | string): TranscriptFormat | null {
  const dot = name.lastIndexOf('.');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (dot <= slash + 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const bytes = typeof head === 'string' ? null : head;
  if (extension === 'docx') return bytes !== null && isZip(bytes) ? 'docx' : null;
  if (bytes !== null && isZip(bytes)) return null;
  const text = textOf(head);
  if (text.startsWith('%PDF-') || text.includes('\u0000')) return null;
  switch (extension) {
    case 'srt':
      return !/^WEBVTT/.test(text) && /\d:\d{2}[,.]\d{1,3}\s*-->/.test(text) ? 'srt' : null;
    case 'vtt':
      return /^WEBVTT(?:[ \t\n]|$)/.test(text) ? 'vtt' : null;
    case 'json':
      return /^\s*[[{]/.test(text) && /"(?:sentences|speaker_name)"\s*:/.test(text) ? 'fireflies' : null;
    case 'txt':
    case 'md':
      return isOtterLayout(text.slice(0, text.lastIndexOf('\n') + 1)) ? 'otter' : 'lines';
    default:
      return null;
  }
}
