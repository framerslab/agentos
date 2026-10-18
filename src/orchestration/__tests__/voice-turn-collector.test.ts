/**
 * @file voice-turn-collector.test.ts
 * @description Unit tests for {@link VoiceTurnCollector}.
 *
 * Covers transcript buffering, turn counting, last-speaker tracking,
 * GraphEvent emission, checkpoint restore, defensive defaults, and
 * buffer immutability.
 *
 * All tests use a plain `EventEmitter` as the session mock.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { VoiceTurnCollector } from '../runtime/VoiceTurnCollector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh session emitter, event sink spy, and collector instance.
 *
 * @param initialTurnCount - Optional seed for checkpoint-restore tests.
 * @returns Object with `session` (EventEmitter to fire events on),
 *          `events` (collected GraphEvents), and `collector` (the instance
 *          under test).
 */
function setup(initialTurnCount = 0) {
  const session = new EventEmitter();
  const events: any[] = [];
  const sink = (evt: any) => events.push(evt);
  const collector = new VoiceTurnCollector(session, sink, 'test-node', initialTurnCount);
  return { session, events, collector };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceTurnCollector', () => {
  // -- interim_transcript forwarding (not buffered) -------------------------

  it('emits voice_transcript on interim_transcript', () => {
    const { session, events } = setup();
    session.emit('interim_transcript', { text: 'Hel', confidence: 0.5 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('voice_transcript');
    expect(events[0].isFinal).toBe(false);
  });

  it('sets nodeId on interim_transcript event', () => {
    const { session, events } = setup();
    session.emit('interim_transcript', { text: 'Hi' });
    expect(events[0].nodeId).toBe('test-node');
  });

  it('forwards text and confidence on interim_transcript', () => {
    const { session, events } = setup();
    session.emit('interim_transcript', { text: 'Hel', speaker: 'Speaker_1', confidence: 0.75 });
    expect(events[0].text).toBe('Hel');
    expect(events[0].confidence).toBe(0.75);
    expect(events[0].speaker).toBe('Speaker_1');
  });

  it('does NOT buffer interim transcripts', () => {
    // Interim transcripts are speculative and should not pollute the
    // canonical transcript buffer.
    const { session, collector } = setup();
    session.emit('interim_transcript', { text: 'part' });
    expect(collector.getTranscript()).toHaveLength(0);
  });

  // -- final_transcript buffering + forwarding ------------------------------

  it('buffers transcript on final_transcript', () => {
    const { session, collector } = setup();
    session.emit('final_transcript', { text: 'Hello', speaker: 'Speaker_0', confidence: 0.95 });
    expect(collector.getTranscript()).toHaveLength(1);
    expect(collector.getTranscript()[0].text).toBe('Hello');
    expect(collector.getLastSpeaker()).toBe('Speaker_0');
  });

  it('emits final voice_transcript on final_transcript', () => {
    const { session, events } = setup();
    session.emit('final_transcript', { text: 'Hello', speaker: 'Speaker_0', confidence: 0.95 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('voice_transcript');
    expect(events[0].isFinal).toBe(true);
    expect(events[0].text).toBe('Hello');
  });

  it('accumulates multiple final transcript entries in order', () => {
    const { session, collector } = setup();
    session.emit('final_transcript', { text: 'Hello', speaker: 'Speaker_0' });
    session.emit('final_transcript', { text: 'World', speaker: 'Speaker_1' });
    const t = collector.getTranscript();
    expect(t).toHaveLength(2);
    expect(t[0].text).toBe('Hello');
    expect(t[1].text).toBe('World');
  });

  // -- turn_complete counting + forwarding ----------------------------------

  it('increments turn count on turn_complete', () => {
    const { session, collector } = setup();
    session.emit('turn_complete', { transcript: 'Hello there', reason: 'punctuation' });
    expect(collector.getTurnCount()).toBe(1);
  });

  it('emits voice_turn_complete with correct turnIndex and endpointReason', () => {
    const { session, events } = setup();
    session.emit('turn_complete', { transcript: 'Hello there', reason: 'punctuation' });
    expect(events[0].type).toBe('voice_turn_complete');
    // turnIndex is 1 after the first turn_complete (post-increment).
    expect(events[0].turnIndex).toBe(1);
    expect(events[0].endpointReason).toBe('punctuation');
    expect(events[0].transcript).toBe('Hello there');
  });

  it('increments turn count across multiple turn_complete events', () => {
    const { session, events, collector } = setup();
    session.emit('turn_complete', { reason: 'silence' });
    session.emit('turn_complete', { reason: 'silence' });
    session.emit('turn_complete', { reason: 'silence' });
    expect(collector.getTurnCount()).toBe(3);
    expect(events[2].turnIndex).toBe(3);
  });

  // -- barge_in forwarding --------------------------------------------------

  it('emits voice_barge_in on barge_in', () => {
    const { session, events } = setup();
    session.emit('barge_in', { interruptedText: 'I was saying', userSpeech: 'Wait!' });
    expect(events[0].type).toBe('voice_barge_in');
    expect(events[0].interruptedText).toBe('I was saying');
    expect(events[0].userSpeech).toBe('Wait!');
    expect(events[0].nodeId).toBe('test-node');
  });

  // -- checkpoint restore ---------------------------------------------------

  it('supports initial turn count for checkpoint restore', () => {
    // Starting from turnIndex 5, the next turn_complete should yield 6.
    const { session, collector } = setup(5);
    session.emit('turn_complete', { transcript: 'Next', reason: 'silence' });
    expect(collector.getTurnCount()).toBe(6);
  });

  it('emits correct turnIndex after checkpoint restore', () => {
    const { session, events } = setup(5);
    session.emit('turn_complete', { reason: 'silence' });
    expect(events[0].turnIndex).toBe(6);
  });

  // -- defensive defaults ---------------------------------------------------

  it('defaults speaker to user when not provided on final_transcript', () => {
    // When the STT service doesn't provide diarization, speaker defaults
    // to 'user' so the transcript always has a speaker label.
    const { session, collector } = setup();
    session.emit('final_transcript', { text: 'Hi' });
    expect(collector.getLastSpeaker()).toBe('user');
    expect(collector.getTranscript()[0].speaker).toBe('user');
  });

  it('returns empty transcript initially', () => {
    const { collector } = setup();
    expect(collector.getTranscript()).toEqual([]);
    expect(collector.getTurnCount()).toBe(0);
    expect(collector.getLastSpeaker()).toBe('');
  });

  it('getTranscript() returns a copy -- mutations do not affect internal buffer', () => {
    const { session, collector } = setup();
    session.emit('final_transcript', { text: 'Immutable', speaker: 'user' });
    const copy = collector.getTranscript();
    // Mutating the returned copy should not affect the internal buffer.
    copy.push({ speaker: 'intruder', text: 'injected', timestamp: 0 });
    expect(collector.getTranscript()).toHaveLength(1);
  });

  it('defaults missing barge_in fields to empty strings', () => {
    const { session, events } = setup();
    session.emit('barge_in', {});
    expect(events[0].interruptedText).toBe('');
    expect(events[0].userSpeech).toBe('');
  });

  it('defaults missing turn_complete reason to unknown', () => {
    const { session, events } = setup();
    session.emit('turn_complete', {});
    expect(events[0].endpointReason).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// A started session's own events
// ---------------------------------------------------------------------------

describe("VoiceTurnCollector on a started session's own events", () => {
  /** A collector that reads `VoiceSessionEventMap`'s names, as VoiceNodeExecutor makes one for a started session. */
  function onSession(initialTurnCount = 0) {
    const session = new EventEmitter();
    const events: any[] = [];
    const collector = new VoiceTurnCollector(session, (evt) => events.push(evt), 'test-node', initialTurnCount, { events: 'session' });
    return { session, events, collector };
  }

  it("forwards interim transcripts, buffers finals, and counts each user item as a turn", () => {
    const { session, events, collector } = onSession();
    session.emit('user_input_transcribed', { transcript: 'Book a', isFinal: false, confidence: 0.5, createdAt: 1 });
    session.emit('user_input_transcribed', { transcript: 'Book a table.', isFinal: true, confidence: 0.9, speakerId: 'Speaker_1', createdAt: 2 });
    session.emit('conversation_item_added', { item: { role: 'user', text: 'Book a table.', source: 'speech', endpointReason: 'punctuation' }, createdAt: 3 });

    expect(events).toEqual([
      { type: 'voice_transcript', nodeId: 'test-node', text: 'Book a', isFinal: false, speaker: undefined, confidence: 0.5 },
      { type: 'voice_transcript', nodeId: 'test-node', text: 'Book a table.', isFinal: true, speaker: 'Speaker_1', confidence: 0.9 },
      { type: 'voice_turn_complete', nodeId: 'test-node', transcript: 'Book a table.', turnIndex: 1, endpointReason: 'punctuation' },
    ]);
    expect(collector.getTranscript()).toEqual([{ speaker: 'Speaker_1', text: 'Book a table.', timestamp: expect.any(Number) }]);
    expect(collector.getLastSpeaker()).toBe('Speaker_1');
    expect(collector.getTurnCount()).toBe(1);
  });

  it('counts a turn once, though the session emits turn_complete beside its user item, and no agent reply', () => {
    const { session, collector } = onSession(2);
    session.emit('turn_complete', { transcript: 'Book a table.', reason: 'punctuation' });
    session.emit('conversation_item_added', { item: { role: 'user', text: 'Book a table.', source: 'speech' }, createdAt: 1 });
    session.emit('conversation_item_added', { item: { role: 'assistant', text: 'Booked.', playedText: 'Booked.', interrupted: false }, createdAt: 2 });
    session.emit('final_transcript', { text: 'a relayed final' });

    expect(collector.getTurnCount()).toBe(3);
    expect(collector.getTranscript()).toEqual([]);
  });

  it('forwards a barge-in that cut the reply, and not the pause and resume of a false interruption', () => {
    const { session, events } = onSession();
    session.emit('barge_in', { speechDurationMs: 100, interruptedText: 'It is', playedDurationMs: 400, action: 'pause', createdAt: 1 });
    session.emit('barge_in', { speechDurationMs: 400, interruptedText: 'It is booked', playedDurationMs: 400, action: 'resume', createdAt: 2 });
    expect(events).toEqual([]);

    session.emit('barge_in', { speechDurationMs: 300, interruptedText: 'It is booked for', playedDurationMs: 900, action: 'cancel', createdAt: 3 });
    expect(events).toEqual([{ type: 'voice_barge_in', nodeId: 'test-node', interruptedText: 'It is booked for', userSpeech: '' }]);
  });

  it("defaults a turn's endpoint reason to unknown and a final's speaker to user, and forwards a barge-in", () => {
    const { session, events, collector } = onSession();
    session.emit('user_input_transcribed', { transcript: 'Wait.', isFinal: true, createdAt: 1 });
    session.emit('conversation_item_added', { item: { role: 'user', text: 'Wait.', source: 'client' }, createdAt: 2 });
    session.emit('barge_in', { speechDurationMs: 300, interruptedText: 'It is booked for', playedDurationMs: 800, action: 'cancel', createdAt: 3 });

    expect(collector.getLastSpeaker()).toBe('user');
    expect(events.slice(1)).toEqual([
      { type: 'voice_turn_complete', nodeId: 'test-node', transcript: 'Wait.', turnIndex: 1, endpointReason: 'unknown' },
      { type: 'voice_barge_in', nodeId: 'test-node', interruptedText: 'It is booked for', userSpeech: '' },
    ]);
  });
});

describe('VoiceTurnCollector.dispose', () => {
  it.each(['relayed', 'session'] as const)('removes every listener it added to a session read as %s, and stops collecting', (names) => {
    const session = new EventEmitter();
    const events: any[] = [];
    const collector = new VoiceTurnCollector(session, (evt) => events.push(evt), 'test-node', 0, { events: names });
    expect(session.eventNames().length).toBeGreaterThan(0);

    collector.dispose();
    collector.dispose();
    expect(session.eventNames()).toEqual([]);
    session.emit('turn_complete', { transcript: 'Late.', reason: 'silence' });
    session.emit('conversation_item_added', { item: { role: 'user', text: 'Late.', source: 'speech' }, createdAt: 1 });
    expect(events).toEqual([]);
    expect(collector.getTurnCount()).toBe(0);
  });
});
