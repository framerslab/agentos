import { describe, it, expect } from 'vitest';
import { TranscriptDedupe, normalizeTranscriptText } from '../TranscriptDedupe.js';

describe('normalizeTranscriptText', () => {
  it('lowers the case, drops punctuation and joins runs of white space', () => {
    expect(normalizeTranscriptText('Hello, World!  Again.')).toBe('hello world again');
  });
});

describe('TranscriptDedupe', () => {
  it('returns isDuplicate=false on first observation', () => {
    const dedupe = new TranscriptDedupe();
    const r = dedupe.evaluate({
      provider: 'deepgram',
      text: 'hello world',
      audioStartMs: 0,
      audioEndMs: 600,
      isFinal: false,
    });
    expect(r.isDuplicate).toBe(false);
  });

  it('suppresses exact duplicates within overlap window', () => {
    const dedupe = new TranscriptDedupe();
    dedupe.evaluate({
      provider: 'deepgram',
      text: 'hello world',
      audioStartMs: 0,
      audioEndMs: 600,
      isFinal: true,
    });
    const r = dedupe.evaluate({
      provider: 'elevenlabs',
      text: 'hello world',
      audioStartMs: 100,
      audioEndMs: 700,
      isFinal: true,
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.reason).toBe('exact');
  });

  it('suppresses fuzzy matches above threshold', () => {
    const dedupe = new TranscriptDedupe();
    dedupe.evaluate({
      provider: 'deepgram',
      text: 'i said hello world',
      audioStartMs: 0,
      audioEndMs: 900,
      isFinal: true,
    });
    const r = dedupe.evaluate({
      provider: 'elevenlabs',
      text: 'i said hello world.',
      audioStartMs: 100,
      audioEndMs: 1000,
      isFinal: true,
    });
    expect(r.isDuplicate).toBe(true);
  });

  it('does NOT suppress legitimate continuations', () => {
    const dedupe = new TranscriptDedupe();
    dedupe.evaluate({
      provider: 'deepgram',
      text: 'hello world',
      audioStartMs: 0,
      audioEndMs: 600,
      isFinal: true,
    });
    const r = dedupe.evaluate({
      provider: 'elevenlabs',
      text: 'how are you today',
      audioStartMs: 800,
      audioEndMs: 1800,
      isFinal: true,
    });
    expect(r.isDuplicate).toBe(false);
  });

  it('does NOT suppress same-provider repeated transcripts', () => {
    // Interim transcripts from the same provider shouldn't be deduped;
    // they're a legitimate part of the streaming protocol.
    const dedupe = new TranscriptDedupe();
    dedupe.evaluate({
      provider: 'deepgram',
      text: 'hello',
      audioStartMs: 0,
      audioEndMs: 300,
      isFinal: false,
    });
    const r = dedupe.evaluate({
      provider: 'deepgram',
      text: 'hello world',
      audioStartMs: 0,
      audioEndMs: 600,
      isFinal: false,
    });
    expect(r.isDuplicate).toBe(false);
  });

  it('suppresses supersets: shorter transcript contained in longer one', () => {
    const dedupe = new TranscriptDedupe();
    dedupe.evaluate({
      provider: 'deepgram',
      text: 'the quick brown fox jumps',
      audioStartMs: 0,
      audioEndMs: 1500,
      isFinal: true,
    });
    const r = dedupe.evaluate({
      provider: 'elevenlabs',
      text: 'quick brown fox',
      audioStartMs: 200,
      audioEndMs: 1000,
      isFinal: true,
    });
    expect(r.isDuplicate).toBe(true);
    expect(r.reason).toBe('superset');
  });

  it('reset() clears memory', () => {
    const dedupe = new TranscriptDedupe();
    dedupe.evaluate({
      provider: 'a',
      text: 'hello world',
      audioStartMs: 0,
      audioEndMs: 600,
      isFinal: true,
    });
    dedupe.reset();
    const r = dedupe.evaluate({
      provider: 'b',
      text: 'hello world',
      audioStartMs: 0,
      audioEndMs: 600,
      isFinal: true,
    });
    expect(r.isDuplicate).toBe(false);
  });
});
