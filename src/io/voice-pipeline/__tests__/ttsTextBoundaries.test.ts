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

  it('ends the first segment of a reply at a clause mark once it holds 20 characters, while a long sentence still streams', () => {
    const segmenter = new SentenceSegmenter();
    // "Sure," holds 5 characters, too few to end the first segment; the comma after "afternoon" ends it once whitespace
    // has followed, though the sentence has no sentence-ending mark yet.
    expect(segmenter.push('Sure, here are the three times I have open on Friday afternoon,')).toEqual([]);
    expect(segmenter.push(' two')).toEqual([
      { segmentId: 'seg-1', start: 0, end: 63, text: 'Sure, here are the three times I have open on Friday afternoon,' },
    ]);
    // A later segment ends at a clause mark only once it holds 40 characters: " two thirty," holds 12.
    expect(segmenter.push(' thirty, three fifteen and four')).toEqual([]);
    expect(segmenter.flush()).toEqual({ segmentId: 'seg-2', start: 63, end: 98, text: ' two thirty, three fifteen and four' });
  });

  it('ends a later segment at a clause mark only once it holds 40 characters, and at a sentence-ending mark at any length', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('Yes. I can move it to Thursday morning; the room is free then, and nobody else has asked for it. Ok')).toEqual([
      { segmentId: 'seg-1', start: 0, end: 4, text: 'Yes.' },
      // The semicolon comes 35 characters into this segment, too few for one after the reply's first.
      { segmentId: 'seg-2', start: 4, end: 62, text: ' I can move it to Thursday morning; the room is free then,' },
      { segmentId: 'seg-3', start: 62, end: 96, text: ' and nobody else has asked for it.' },
    ]);
    expect(segmenter.remainder).toBe(' Ok');
  });

  it('ends a segment at a dash with whitespace after it, and keeps a closing quote with the clause it closes', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('I looked at the calendar for you — Friday is free – and so is the larger room - so I booked both')).toEqual([
      { segmentId: 'seg-1', start: 0, end: 34, text: 'I looked at the calendar for you —' },
      // The en dash comes 17 characters into this segment, too few; a hyphen between a word and whitespace is a dash too.
      { segmentId: 'seg-2', start: 34, end: 79, text: ' Friday is free – and so is the larger room -' },
    ]);
    // reset() starts a new reply, whose first segment ends at a clause mark from 20 characters again.
    segmenter.reset();
    expect(segmenter.push('He said "fine, go ahead," and then he hung up')).toEqual([
      { segmentId: 'seg-3', start: 0, end: 25, text: 'He said "fine, go ahead,"' },
    ]);
  });

  it('does not end a segment at a comma, colon or dash inside a number, a time, a word or a range, or at a list bullet', () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push('Tickets for the well-known 1990–2000 tour cost 1,250 dollars at 10:30, or less later')).toEqual([
      { segmentId: 'seg-1', start: 0, end: 70, text: 'Tickets for the well-known 1990–2000 tour cost 1,250 dollars at 10:30,' },
    ]);
    segmenter.reset();
    expect(segmenter.push('Here are the times I can do\n- two thirty\n- three fifteen\n- four in the afternoon\n- five')).toEqual([]);
  });

  it('ends a segment with no mark to end at at its last whitespace within 120 characters, with the same cuts however the text arrives', () => {
    const list =
      'Here are the slots I have open\nMonday at nine in the morning\nTuesday at ten in the morning\nWednesday at noon\nThursday at two in the afternoon\nFriday at four';
    const expected = [
      {
        segmentId: 'seg-1',
        start: 0,
        end: 120,
        text: 'Here are the slots I have open\nMonday at nine in the morning\nTuesday at ten in the morning\nWednesday at noon\nThursday at',
      },
      { segmentId: 'seg-2', start: 120, end: 156, text: ' two in the afternoon\nFriday at four' },
    ];
    const whole = new SentenceSegmenter();
    expect([...whole.push(list), whole.flush()]).toEqual(expected);
    // Character by character, the cut waits for the 121st character, which settles whether a mark ends the segment
    // within 120.
    const piecewise = new SentenceSegmenter();
    const segments = list.split('').flatMap((character) => piecewise.push(character));
    expect([...segments, piecewise.flush()]).toEqual(expected);
  });

  it('ends a run of more than 120 characters without whitespace at the first whitespace after it', () => {
    const link = `https://example.com/${'a'.repeat(130)}`;
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push(link)).toEqual([]);
    expect(segmenter.push(' is the link')).toEqual([{ segmentId: 'seg-1', start: 0, end: 150, text: link }]);
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
