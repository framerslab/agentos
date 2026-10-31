/** Pure speaker contracts, including the public browser entry. */
import { describe, expect, it } from 'vitest';
import { lineSpeaker, splitFinalBySpeaker } from '../browser.js';
import type { TranscriptEvent, TranscriptWord } from '../types.js';

/** A timed word with an optional raw provider label. */
function word(text: string, start: number, speaker?: string): TranscriptWord {
  return { word: text, start, end: start + 100, confidence: 1, ...(speaker === undefined ? {} : { speaker }) };
}

/** A provider event with a connection-scoped identity and requested diarization. */
function final(words: TranscriptWord[]): TranscriptEvent {
  return {
    itemId: 'connection:1', text: words.map((part) => part.word).join(' '),
    isFinal: true, confidence: 0.9, words, speaker: null,
    startMs: 0, endMs: 900, durationMs: 900, language: 'en', beforeSpeechEnd: true,
  };
}

describe('lineSpeaker', () => {
  it('answers a label only when every word has that one label', () => {
    expect(lineSpeaker([word('One', 0, '0'), word('two', 100, '0')], true)).toBe('0');
    expect(lineSpeaker([word('One', 0, '0'), word('two', 100, '1')], true)).toBeNull();
    expect(lineSpeaker([word('One', 0, '0'), word('two', 100)], true)).toBeNull();
    expect(lineSpeaker([word('One', 0), word('two', 100, '0')], true)).toBeNull();
    expect(lineSpeaker([word('One', 0)], true)).toBeNull();
    expect(lineSpeaker([], true)).toBeNull();
    expect(lineSpeaker(undefined, true)).toBeNull();
  });

  it('does not add information when diarization was not requested', () => {
    expect(lineSpeaker([word('One', 0, '0')], false)).toBeUndefined();
    expect(lineSpeaker([], false)).toBeUndefined();
  });
});

describe('splitFinalBySpeaker', () => {
  it('splits three consecutive voice runs, keeps punctuation and gives each its own times', () => {
    const event = final([
      word('Hello,', 0, '0'), word('there.', 100, '0'),
      word('Yes?', 300, '1'), word('Agreed.', 700, '0'),
    ]);
    const before = JSON.stringify(event);
    const runs = splitFinalBySpeaker(event);
    expect(runs.map((run) => ({
      id: run.itemId, parent: run.runOf, speaker: run.speaker, text: run.text,
      start: run.startMs, end: run.endMs, duration: run.durationMs,
    }))).toEqual([
      { id: 'connection:1', parent: undefined, speaker: 'connection:0', text: 'Hello, there.', start: 0, end: 200, duration: 200 },
      { id: 'connection:1.2', parent: 'connection:1', speaker: 'connection:1', text: 'Yes?', start: 300, end: 400, duration: 100 },
      { id: 'connection:1.3', parent: 'connection:1', speaker: 'connection:0', text: 'Agreed.', start: 700, end: 800, duration: 100 },
    ]);
    expect(runs.map((run) => run.words.length)).toEqual([2, 1, 1]);
    expect(runs.every((run) => run.isFinal && run.language === 'en' && run.beforeSpeechEnd === true)).toBe(true);
    expect(JSON.stringify(event)).toBe(before);
    expect(runs.flatMap((run) => run.words)).toEqual(event.words);
    expect(runs.flatMap((run) => run.words.map((part) => part.speaker))).toEqual(['0', '0', '1', '0']);
  });

  it('gives an unlabelled run null and never borrows either neighbor', () => {
    const event = final([
      word('One.', 0, '0'), word('Unknown', 200), word('words.', 300), word('Two.', 500, '1'),
    ]);
    expect(splitFinalBySpeaker(event).map((run) => [run.speaker, run.text])).toEqual([
      ['connection:0', 'One.'], [null, 'Unknown words.'], ['connection:1', 'Two.'],
    ]);
    const leading = final([word('Unknown.', 0), word('One.', 200, '0')]);
    expect(splitFinalBySpeaker(leading)[0]?.speaker).toBeNull();
  });

  it('returns homogeneous, unlabelled, interim and empty events unchanged', () => {
    const one = { ...final([word('One.', 0, '0')]), speaker: 'connection:0' };
    const unknown = final([word('Unknown.', 0)]);
    const interim = { ...final([word('One.', 0, '0'), word('Two.', 200, '1')]), isFinal: false };
    const empty = final([]);
    for (const event of [one, unknown, interim, empty]) {
      const runs = splitFinalBySpeaker(event);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toBe(event);
    }
  });

  it('does not opt in another provider or split an unkeyed event', () => {
    const mixed = final([word('One.', 0, '0'), word('Two.', 200, '1')]);
    const { speaker: ignoredSpeaker, ...unrequested } = mixed;
    const { itemId: ignoredId, ...unkeyed } = mixed;
    expect(ignoredSpeaker).toBeNull();
    expect(ignoredId).toBe('connection:1');
    expect(splitFinalBySpeaker(unrequested)[0]).toBe(unrequested);
    expect(splitFinalBySpeaker(unkeyed)[0]).toBe(unkeyed);
  });

  it('retains a generic caller raw label and does not split an existing child again', () => {
    const event = { ...final([word('One.', 0, '0'), word('Two.', 200, '1')]), itemId: 'generic' };
    expect(splitFinalBySpeaker(event).map((run) => run.speaker)).toEqual(['0', '1']);
    const child = { ...event, itemId: 'generic.2', runOf: 'generic' };
    expect(splitFinalBySpeaker(child)[0]).toBe(child);
  });
});
