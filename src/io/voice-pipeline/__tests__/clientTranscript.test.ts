/**
 * Unit tests for the client transcript message's helpers.
 *
 * A client that transcribes on its own device sends its transcripts as
 * `transcript` messages: `toClientTranscriptMessage()` makes one from a
 * TranscriptEvent, `isClientTranscriptMessage()` checks one a server received
 * (untrusted input), and `transcriptEventFromClient()` turns it back into a
 * TranscriptEvent.
 */

import { describe, it, expect } from 'vitest';
import {
  isClientTranscriptMessage,
  toClientTranscriptMessage,
  transcriptEventFromClient,
} from '../clientTranscript.js';
import type { ClientTranscriptMessage, TranscriptEvent } from '../types.js';

/** A final with every field the message carries, and the words it leaves out. */
function finalEvent(): TranscriptEvent {
  return {
    text: 'Hello there.',
    confidence: 0.8,
    words: [{ word: 'Hello', start: 0, end: 300, confidence: 0.8 }],
    isFinal: true,
    durationMs: 900,
    itemId: '7',
    startMs: 1200,
    endMs: 2100,
    language: 'en',
  };
}

describe('client transcript messages', () => {
  it('makes a message from a transcript event, and the event again from the message', () => {
    const message = toClientTranscriptMessage(finalEvent());
    expect(message).toStrictEqual({
      type: 'transcript',
      text: 'Hello there.',
      itemId: '7',
      isFinal: true,
      confidence: 0.8,
      startMs: 1200,
      endMs: 2100,
      language: 'en',
    });
    const received: unknown = JSON.parse(JSON.stringify(message));
    expect(isClientTranscriptMessage(received)).toBe(true);
    expect(transcriptEventFromClient(received as ClientTranscriptMessage)).toStrictEqual({
      text: 'Hello there.',
      confidence: 0.8,
      words: [],
      isFinal: true,
      durationMs: 900,
      itemId: '7',
      startMs: 1200,
      endMs: 2100,
      language: 'en',
    });
  });

  it('takes the line id it is given, leaves out what the event lacks, and refuses an event with no id', () => {
    const interim: TranscriptEvent = { text: 'Hello', confidence: 1, words: [], isFinal: false };
    expect(toClientTranscriptMessage(interim, 'line-1')).toStrictEqual({
      type: 'transcript',
      text: 'Hello',
      itemId: 'line-1',
      isFinal: false,
      confidence: 1,
    });
    expect(() => toClientTranscriptMessage(interim)).toThrow(RangeError);
  });

  it('reads a message with no confidence as 1, and gives a duration only to a final with both offsets', () => {
    expect(transcriptEventFromClient({ type: 'transcript', text: 'Hi.', itemId: '8', isFinal: true })).toStrictEqual({
      text: 'Hi.',
      confidence: 1,
      words: [],
      isFinal: true,
      itemId: '8',
    });
    expect(
      transcriptEventFromClient({ type: 'transcript', text: 'Hi', itemId: '8', isFinal: false, startMs: 0, endMs: 400 })
    ).toStrictEqual({ text: 'Hi', confidence: 1, words: [], isFinal: false, itemId: '8', startMs: 0, endMs: 400 });
  });

  it('refuses every malformed shape a client could send', () => {
    const valid = { type: 'transcript', text: 'Hi', itemId: '8', isFinal: false };
    expect(isClientTranscriptMessage(valid)).toBe(true);
    expect(
      isClientTranscriptMessage({ ...valid, text: 'a'.repeat(4_000), itemId: '8'.repeat(128), language: 'e'.repeat(64) })
    ).toBe(true);
    const malformed: Array<[string, unknown]> = [
      ['null', null],
      ['a string', 'transcript'],
      ['an array', [valid]],
      ['another message type', { ...valid, type: 'control' }],
      ['no text', { type: 'transcript', itemId: '8', isFinal: false }],
      ['text that is not a string', { ...valid, text: 42 }],
      ['no item id', { type: 'transcript', text: 'Hi', isFinal: false }],
      ['an empty item id', { ...valid, itemId: '' }],
      ['an item id that is not a string', { ...valid, itemId: 8 }],
      ['isFinal that is not a boolean', { ...valid, isFinal: 'true' }],
      ['a confidence above 1', { ...valid, confidence: 1.5 }],
      ['a confidence that is not a number', { ...valid, confidence: 'high' }],
      ['a confidence that is not finite', { ...valid, confidence: Number.NaN }],
      ['a negative start', { ...valid, startMs: -1 }],
      ['an end that is not finite', { ...valid, endMs: Number.POSITIVE_INFINITY }],
      ['an end before its start', { ...valid, startMs: 500, endMs: 400 }],
      ['a language that is not a string', { ...valid, language: 7 }],
      ['text over 4,000 characters', { ...valid, text: 'a'.repeat(4_001) }],
      ['an item id over 128 characters', { ...valid, itemId: '8'.repeat(129) }],
      ['a language over 64 characters', { ...valid, language: 'e'.repeat(65) }],
    ];
    for (const [label, value] of malformed) {
      expect(isClientTranscriptMessage(value), label).toBe(false);
    }
  });
});
