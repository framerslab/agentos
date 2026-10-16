/**
 * @fileoverview Fireflies's JSON, in either shape it comes in: a transcript's `sentences` as Fireflies's API answers
 * them (`text`, `speaker_name`, `start_time` and `end_time` in seconds), or the list a download from Fireflies holds
 * (`sentence`, `speaker_name`, `startTime` and `endTime` as clocks).
 * @module agentos/cognition/library/transcripts/fireflies
 */

import { clockMs, finish, squash, type Segment } from './shared.js';
import { TranscriptReadError, type ReadTranscript } from './types.js';

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Milliseconds of a time as Fireflies writes one: seconds as a number or as numeric text, or a clock `MM:SS` or
 * `HH:MM:SS`. `null` for anything else.
 */
function timeMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  return clockMs(text);
}

/**
 * Reads Fireflies's JSON: the `sentences` of an object, or a list at the top. Each entry that is an object with words
 * in `text` (or `sentence`) is a turn, its speaker the entry's `speaker_name`; an entry with no words, or one that is
 * no object, is left out. JSON of another shape has no turns.
 *
 * @param text - The file's text.
 * @throws {@link TranscriptReadError} when the text is not JSON.
 */
export function readFireflies(text: string): ReadTranscript {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new TranscriptReadError('fireflies', 'the text is not JSON', error);
  }
  const entries = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.sentences) ? data.sentences : [];
  const segments: Segment[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const words = typeof entry.text === 'string' ? entry.text : typeof entry.sentence === 'string' ? entry.sentence : '';
    const speaker = typeof entry.speaker_name === 'string' ? squash(entry.speaker_name) : '';
    segments.push({
      startMs: timeMs(entry.start_time ?? entry.startTime),
      endMs: timeMs(entry.end_time ?? entry.endTime),
      text: squash(words),
      label: speaker.length > 0 ? speaker : null,
    });
  }
  return finish('fireflies', segments);
}
