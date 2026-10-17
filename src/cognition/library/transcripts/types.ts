/**
 * @fileoverview What the transcript readers answer: a file's turns with their times, the speakers' labels kept apart
 * from the turns, and the error a reader throws for a text that is not its format.
 * @module agentos/cognition/library/transcripts/types
 */

/** A turn as read from a transcript file. */
export interface TranscriptFileTurn {
  /** The turn's number in the file, from 1, rising. */
  seq: number;
  /** Where the turn starts, in milliseconds from the recording's start, when the file says. */
  startMs: number | null;
  /** Where the turn ends, in milliseconds, when the file says. */
  endMs: number | null;
  /** The turn's words, white space collapsed to single spaces, with no speaker's name in them. */
  text: string;
}

/** A turn's speaker as the file names it, kept apart from the turn so a caller keeps labels where it chooses. */
export interface TranscriptFileLabel {
  /** The `seq` of the turn this speaker said. */
  seq: number;
  /** The speaker's name as the file writes it. */
  label: string;
}

/**
 * The formats read: SubRip (`srt`), WebVTT (`vtt`), Otter's plain-text export (`otter`), Fireflies's JSON
 * (`fireflies`), plain `Name: words` lines (`lines`) and a Word file (`docx`), whose text the caller's extractor gives.
 */
export type TranscriptFormat = 'srt' | 'vtt' | 'otter' | 'fireflies' | 'lines' | 'docx';

/** What a reader answers. */
export interface ReadTranscript {
  /** The format the file was read as. */
  format: TranscriptFormat;
  /** The turns, in the file's order, numbered from 1. */
  turns: TranscriptFileTurn[];
  /** One entry for each turn the file names a speaker for, in the turns' order. */
  labels: TranscriptFileLabel[];
  /** The last turn's end, when the file gives it; `null` otherwise. */
  durationMs: number | null;
}

/** A text a reader could not read as its format, or a Word file the caller's extractor could not read. */
export class TranscriptReadError extends Error {
  /** The format the input was read as. */
  readonly format: TranscriptFormat;
  /** What the extractor threw, for a Word file it could not read. */
  readonly cause?: unknown;

  /**
   * @param format - The format the input was read as; the message opens with it.
   * @param message - What is wrong with the input.
   * @param cause - What the reader caught, when it caught something.
   */
  constructor(format: TranscriptFormat, message: string, cause?: unknown) {
    super(`${format}: ${message}`);
    this.name = 'TranscriptReadError';
    this.format = format;
    if (cause !== undefined) this.cause = cause;
  }
}
