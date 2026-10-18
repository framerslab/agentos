/**
 * Unit tests for the TTS text boundaries: the sentence segmenter's cuts and
 * offsets over text that arrives in pieces, and the played-text tracker's
 * contiguous acknowledged prefix.
 */

import { describe, expect, it } from 'vitest';
import { PlayedTextTracker, SentenceSegmenter, boundaryOf } from '../ttsTextBoundaries.js';

describe('SentenceSegmenter', () => {
  it('cuts a sentence once whitespace has followed its mark, keeping every character and offset', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('Hel')).toEqual([]);
    expect(segmenter.push('lo there.')).toEqual([]);
    expect(segmenter.push(' How')).toEqual([{ segmentId: 'seg-1', start: 0, end: 12, text: 'Hello there.' }]);
    expect(segmenter.push(' are you?  Fine')).toEqual([{ segmentId: 'seg-2', start: 12, end: 25, text: ' How are you?' }]);
    expect(segmenter.flush()).toEqual({ segmentId: 'seg-3', start: 25, end: 31, text: '  Fine' });
    expect(segmenter.submitted).toBe('Hello there. How are you?  Fine');
    expect(segmenter.flush()).toBeUndefined();
  });

  it('cuts several sentences from one push, in order', () => {
    const segmenter = new SentenceSegmenter('r1-');
    expect(segmenter.push('One. Two! Three? Four')).toEqual([
      { segmentId: 'r1-1', start: 0, end: 4, text: 'One.' },
      { segmentId: 'r1-2', start: 4, end: 9, text: ' Two!' },
      { segmentId: 'r1-3', start: 9, end: 16, text: ' Three?' },
    ]);
    expect(segmenter.remainder).toBe(' Four');
  });

  it('keeps a run of marks and the closing quote or bracket with the sentence they end', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('"Really?!" (Yes.) Next')).toEqual([
      { segmentId: 'seg-1', start: 0, end: 10, text: '"Really?!"' },
      { segmentId: 'seg-2', start: 10, end: 17, text: ' (Yes.)' },
    ]);
  });

  it('does not cut at a decimal point, a mark inside a word, or a mark nothing has followed yet', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('Pi is 3.14 and e.g.')).toEqual([]);
    expect(segmenter.push('x')).toEqual([]);
    expect(segmenter.flush()).toEqual({ segmentId: 'seg-1', start: 0, end: 20, text: 'Pi is 3.14 and e.g.x' });
  });

  it('makes no segment of whitespace alone, and forgets its text on reset while the ids go on', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('Done. ')).toEqual([{ segmentId: 'seg-1', start: 0, end: 5, text: 'Done.' }]);
    expect(segmenter.flush()).toBeUndefined();
    segmenter.reset();
    expect(segmenter.submitted).toBe('');
    expect(segmenter.push('Again.')).toEqual([]);
    expect(segmenter.flush()).toEqual({ segmentId: 'seg-2', start: 0, end: 6, text: 'Again.' });
  });

  it('marks a boundary final with the segment kept whole', () => {
    expect(boundaryOf({ segmentId: 's', start: 3, end: 8, text: ' five' })).toEqual({ segmentId: 's', start: 3, end: 8, text: ' five', final: true });
  });
});

describe('PlayedTextTracker', () => {
  const first = { segmentId: 'a', start: 0, end: 6, text: 'First.', final: true as const };
  const second = { segmentId: 'b', start: 6, end: 14, text: ' Second.', final: true as const };
  const third = { segmentId: 'c', start: 14, end: 21, text: ' Third.', final: true as const };

  it('counts the contiguous prefix of acknowledged segments, whatever order the acknowledgements come in', () => {
    const tracker = new PlayedTextTracker();
    tracker.sent(1, first);
    tracker.sent(2, second);
    tracker.sent(3, third);
    expect(tracker.playedText).toBe('');
    tracker.acknowledged(3);
    // The third segment is heard, but the two before it are not proven: nothing counts yet.
    expect(tracker.playedText).toBe('');
    tracker.acknowledged(1);
    expect(tracker.playedText).toBe('First.');
    tracker.acknowledged(2);
    expect(tracker.playedText).toBe('First. Second. Third.');
  });

  it('records no chunk without a boundary and ignores a key it never sent', () => {
    const tracker = new PlayedTextTracker();
    tracker.sent(1, undefined);
    tracker.acknowledged(1);
    tracker.acknowledged('never');
    expect(tracker.playedText).toBe('');
  });

  it('advances nothing for a chunk a clear discarded, even when its acknowledgement comes late', () => {
    const tracker = new PlayedTextTracker();
    tracker.sent(1, first);
    tracker.acknowledged(1);
    tracker.sent(2, second);
    tracker.cleared();
    tracker.acknowledged(2);
    expect(tracker.playedText).toBe('First.');
    tracker.reset();
    expect(tracker.playedText).toBe('');
  });
});
