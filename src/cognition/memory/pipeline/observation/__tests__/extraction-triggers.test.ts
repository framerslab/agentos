import { describe, it, expect } from 'vitest';
import { ObservationBuffer } from '../ObservationBuffer.js';
import { MemoryReflector } from '../MemoryReflector.js';
import type { ObservationNote } from '../MemoryObserver.js';

// CR5: in normal chat, conversation turns are ~100-300 tokens, so the
// token-only activation gates (observer 30k, reflector 40k) never fire — the
// durable extraction/consolidation pipeline never runs and memory falls off a
// cliff once the recent-message snapshot scrolls past. The fix is an additive
// count-based trigger on both gates: fire on EITHER the token threshold (for
// batch ingestion of large single messages) OR a conversational message/note
// count (for chat). These tests pin both behaviours.

const defaultTraits = {
  honesty: 0.5, emotionality: 0.8, extraversion: 0.5,
  agreeableness: 0.5, conscientiousness: 0.5, openness: 0.5,
};

function makeNote(i: number): ObservationNote {
  return {
    id: `n${i}`, type: 'emotional', content: 'a short observation note',
    importance: 0.5, entities: ['user'], timestamp: 1_700_000_000_000 + i,
  };
}

describe('ObservationBuffer — message-count trigger (CR5)', () => {
  it('activates after activationThresholdMessages short messages, far below the token threshold', () => {
    const buf = new ObservationBuffer({ activationThresholdTokens: 30_000, activationThresholdMessages: 4 });
    expect(buf.push('user', 'hi')).toBe(false);
    expect(buf.push('assistant', 'hello there')).toBe(false);
    expect(buf.push('user', 'how are you')).toBe(false);
    expect(buf.push('assistant', 'doing well')).toBe(true); // 4th message → activates by count
  });

  it('re-activates only after another batch of messages following a drain', () => {
    const buf = new ObservationBuffer({ activationThresholdTokens: 30_000, activationThresholdMessages: 2 });
    buf.push('user', 'a');
    expect(buf.push('user', 'b')).toBe(true); // 2 since start → activate
    buf.drain();
    expect(buf.push('user', 'c')).toBe(false); // 1 since drain
    expect(buf.push('user', 'd')).toBe(true);  // 2 since drain → activate again
  });

  it('still activates on the token threshold regardless of message count (batch ingestion unchanged)', () => {
    const oneBigMessage = 'x'.repeat(40_000 * 4); // ~40k tokens in a single message
    const buf = new ObservationBuffer({ activationThresholdTokens: 30_000, activationThresholdMessages: 1_000 });
    expect(buf.push('user', oneBigMessage)).toBe(true); // token gate fires on 1 message
  });

  it('default threshold fires well within a chat session (regression guard on the cliff)', () => {
    const buf = new ObservationBuffer(); // defaults only
    let activated = false;
    for (let i = 0; i < 50 && !activated; i++) {
      activated = buf.push(i % 2 === 0 ? 'user' : 'assistant', 'a short conversational turn');
    }
    expect(activated).toBe(true); // must fire within 50 short messages — was ~30k tokens ≈ never
  });
});

describe('MemoryReflector — note-count trigger (CR5)', () => {
  it('shouldActivate() after activationThresholdNotes notes, far below the token threshold', async () => {
    const reflector = new MemoryReflector(defaultTraits, {
      activationThresholdTokens: 40_000, activationThresholdNotes: 3,
    });
    // No llmInvoker → addNotes only accumulates (returns null), letting us
    // assert shouldActivate() directly without stubbing the reflection LLM.
    await reflector.addNotes([makeNote(1), makeNote(2)]);
    expect(reflector.shouldActivate()).toBe(false); // 2 notes, below count + below tokens
    await reflector.addNotes([makeNote(3)]);
    expect(reflector.shouldActivate()).toBe(true); // 3 notes → activates by count
  });

  it('default threshold fires well within a chat session (regression guard on the cliff)', async () => {
    const reflector = new MemoryReflector(defaultTraits); // defaults only
    for (let i = 0; i < 20; i++) await reflector.addNotes([makeNote(i)]);
    expect(reflector.shouldActivate()).toBe(true); // must fire within 20 short notes — was ~40k tokens ≈ never
  });
});
