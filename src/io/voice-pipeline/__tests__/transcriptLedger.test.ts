import { describe, expect, it } from 'vitest';
import {
  LIVEKIT_TRANSCRIPTION_ATTRIBUTES,
  readingOrder,
  TRANSCRIPTION_FAILED_ATTRIBUTE,
  TRANSCRIPTION_RUN_OF_ATTRIBUTE,
  TRANSCRIPTION_SPEAKER_ATTRIBUTE,
  TranscriptLedger,
  transcriptEventFromLiveKit,
  type LedgerItem,
} from '../transcriptLedger.js';
import type { TranscriptEvent } from '../types.js';

const line = (itemId: string, text: string, isFinal: boolean) => ({ itemId, text, isFinal });

describe('TranscriptLedger', () => {
  it('replaces an interim with the next interim of its item and closes it with the final, keeping first-seen order', () => {
    const ledger = new TranscriptLedger();
    expect(ledger.apply(line('item_a', 'The off', false))).toBe(true);
    expect(ledger.apply(line('item_b', 'Budget', false))).toBe(true);
    expect(ledger.apply(line('item_a', 'The offsite is', false))).toBe(true);
    expect(ledger.apply(line('item_a', 'The offsite is in Lisbon.', true))).toBe(true);
    expect(ledger.items().map((item) => [item.itemId, item.text, item.isFinal])).toEqual([
      ['item_a', 'The offsite is in Lisbon.', true],
      ['item_b', 'Budget', false],
    ]);
  });

  it('drops a final that arrives again, an interim after its final, the same interim twice and an event with no item', () => {
    const ledger = new TranscriptLedger();
    ledger.apply(line('item_a', 'Hello there.', true));
    expect(ledger.apply(line('item_a', 'Hello there.', true))).toBe(false);
    expect(ledger.apply(line('item_a', 'Hello th', false))).toBe(false);
    ledger.apply(line('item_b', 'So', false));
    expect(ledger.apply(line('item_b', 'So', false))).toBe(false);
    expect(ledger.apply({ text: 'no id', isFinal: true })).toBe(false);
    expect(ledger.size).toBe(2);
  });

  it('names the last final and lists the finals after an item, all of them for none or an unknown one', () => {
    const ledger = new TranscriptLedger();
    ledger.apply(line('i1', 'One.', true));
    ledger.apply(line('i2', 'Two.', true));
    ledger.apply(line('i3', 'Thr', false));
    ledger.apply(line('i4', 'Four.', true));
    expect(ledger.lastFinalId()).toBe('i4');
    expect(ledger.finalsAfter('i1').map((item) => item.itemId)).toEqual(['i2', 'i4']);
    expect(ledger.finalsAfter(undefined).map((item) => item.itemId)).toEqual(['i1', 'i2', 'i4']);
    expect(ledger.finalsAfter('unknown').map((item) => item.itemId)).toEqual(['i1', 'i2', 'i4']);
  });

  it('names the line a page resumes after: the last final before its first line still being heard', () => {
    // OpenAI: "Ordering between completion events from different speech turns isn't guaranteed."
    const ledger = new TranscriptLedger();
    ledger.apply(line('i1', 'One.', true));
    ledger.apply(line('i2', 'Tw', false));
    ledger.apply(line('i3', 'Three.', true));
    expect(ledger.lastFinalId()).toBe('i3');
    expect(ledger.resumeAfterId()).toBe('i1');
    ledger.apply(line('i2', 'Two.', true));
    expect(ledger.resumeAfterId()).toBe('i3');
    expect(new TranscriptLedger().resumeAfterId()).toBeUndefined();
  });

  it('keeps a failed line as an empty final with its reason', () => {
    const ledger = new TranscriptLedger();
    ledger.apply({ itemId: 'i9', text: '', isFinal: true, failed: 'audio_unintelligible' });
    expect(ledger.get('i9')).toMatchObject({ text: '', isFinal: true, failed: 'audio_unintelligible' });
  });

  it('takes an empty failure reason for none, as the LiveKit stream does, so the line is taken back', () => {
    const ledger = new TranscriptLedger();
    ledger.apply(line('i1', 'Ha', false));
    expect(ledger.apply({ itemId: 'i1', text: '', isFinal: true, failed: '' })).toBe(true);
    expect(ledger.items()).toEqual([]);
  });

  it('hides a line an empty final takes back, and ignores one for a line never shown', () => {
    const ledger = new TranscriptLedger();
    ledger.apply(line('i1', 'One.', true));
    ledger.apply(line('i2', 'Tw', false));
    expect(ledger.apply(line('i2', '', true))).toBe(true);
    expect(ledger.apply(line('i2', '', true))).toBe(false);
    expect(ledger.apply(line('i3', '', true))).toBe(false);
    expect(ledger.items().map((item) => item.itemId)).toEqual(['i1']);
    expect([ledger.size, ledger.lastFinalId()]).toEqual([1, 'i1']);
    expect(ledger.finalsAfter(undefined).map((item) => item.itemId)).toEqual(['i1']);
  });

  it('drops the oldest finals beyond its size, never a line still being heard', () => {
    const ledger = new TranscriptLedger({ maxItems: 2 });
    ledger.apply(line('i1', 'Open', false));
    ledger.apply(line('i2', 'Two.', true));
    ledger.apply(line('i3', 'Three.', true));
    expect(ledger.items().map((item) => item.itemId)).toEqual(['i1', 'i3']);
  });

  it('holds every line still being heard over its size, with the final it just took', () => {
    const ledger = new TranscriptLedger({ maxItems: 2 });
    ledger.apply(line('i1', 'Open', false));
    ledger.apply(line('i2', 'Also open', false));
    expect(ledger.apply(line('i3', 'Three.', true))).toBe(true);
    expect(ledger.items().map((item) => item.itemId)).toEqual(['i1', 'i2', 'i3']);
  });

  it('takes back the lines it held over its size, and holds no more than its size once they close', () => {
    const ledger = new TranscriptLedger({ maxItems: 2 });
    for (const id of ['i1', 'i2', 'i3']) ledger.apply(line(id, 'Open', false));
    for (const id of ['i1', 'i2', 'i3']) expect(ledger.apply(line(id, '', true))).toBe(true);
    expect(ledger.finalsAfter(undefined, { takenBack: true }).map((item) => item.itemId)).toEqual(['i2', 'i3']);
  });

  it('survives its JSON and skips a malformed line', () => {
    const ledger = new TranscriptLedger();
    ledger.apply({ itemId: 'i1', text: 'One.', isFinal: true, startMs: 0, endMs: 900, language: 'en' });
    const copy = TranscriptLedger.fromJSON({ ...ledger.toJSON(), items: [...ledger.toJSON().items, { itemId: 7 }, null] });
    expect(copy.items()).toEqual(ledger.items());
  });

  it("takes a TranscriptEvent as it is and keeps a line's fields of it", () => {
    const event: TranscriptEvent = { text: 'One.', confidence: 0.9, words: [], isFinal: true, itemId: 'i1', startMs: 0, endMs: 900, language: 'en' };
    const ledger = new TranscriptLedger();
    expect(ledger.apply(event)).toBe(true);
    expect(ledger.get('i1')).toEqual({ itemId: 'i1', text: 'One.', isFinal: true, startMs: 0, endMs: 900, language: 'en' });
  });
});

describe('transcriptEventFromLiveKit', () => {
  it("reads a stream's text and attributes, and nothing without a segment id", () => {
    const attributes = { [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.segmentId]: 'item_x', [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final]: 'true' };
    expect(transcriptEventFromLiveKit('Hi.', attributes)).toEqual({ itemId: 'item_x', text: 'Hi.', isFinal: true });
    expect(transcriptEventFromLiveKit('Hi', { ...attributes, [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final]: 'false' })?.isFinal).toBe(false);
    expect(transcriptEventFromLiveKit('', { ...attributes, [TRANSCRIPTION_FAILED_ATTRIBUTE]: 'audio_unintelligible' })?.failed).toBe('audio_unintelligible');
    expect(transcriptEventFromLiveKit('Hi', {})).toBeNull();
    expect(transcriptEventFromLiveKit('Hi', undefined)).toBeNull();
  });

  const finalStream = { [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.segmentId]: 'item_x', [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final]: 'true' };

  it("reads a final's agentos.start_ms and agentos.end_ms as numbers, and leaves both undefined without them", () => {
    expect(transcriptEventFromLiveKit('Hi.', { ...finalStream, 'agentos.start_ms': '1200', 'agentos.end_ms': '3400' })).toEqual({
      itemId: 'item_x',
      text: 'Hi.',
      isFinal: true,
      startMs: 1200,
      endMs: 3400,
    });
    const untimed = transcriptEventFromLiveKit('Hi.', finalStream);
    expect(untimed?.itemId).toBe('item_x');
    expect(untimed?.startMs).toBeUndefined();
    expect(untimed?.endMs).toBeUndefined();
  });

  it('ignores a time that is not whole milliseconds in decimal digits, and still reads the other', () => {
    const bad = ['', ' 1200', '1200 ', '-5', '+5', '12.5', '1e3', '0x10', '1,200', 'NaN', 'Infinity', '9'.repeat(400), '9007199254740993'];
    for (const value of bad) {
      const event = transcriptEventFromLiveKit('Hi.', { ...finalStream, 'agentos.start_ms': value, 'agentos.end_ms': '3400' });
      expect([value, event?.startMs, event?.endMs]).toEqual([value, undefined, 3400]);
    }
  });

  it("gives a page's ledger line the times its final carries, and none for a final without them", () => {
    const stream = (itemId: string, text: string, isFinal: boolean, times: Record<string, string> = {}) =>
      transcriptEventFromLiveKit(text, {
        [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.segmentId]: itemId,
        [LIVEKIT_TRANSCRIPTION_ATTRIBUTES.final]: isFinal ? 'true' : 'false',
        ...times,
      });
    const ledger = new TranscriptLedger();
    for (const event of [
      stream('i1', 'The off', false),
      stream('i1', 'The offsite is in Lisbon.', true, { 'agentos.start_ms': '1200', 'agentos.end_ms': '3400' }),
      stream('i2', 'Bud', false),
      stream('i2', 'Budget.', true),
    ]) {
      if (event) ledger.apply(event);
    }
    expect(ledger.items()).toEqual([
      { itemId: 'i1', text: 'The offsite is in Lisbon.', isFinal: true, startMs: 1200, endMs: 3400 },
      { itemId: 'i2', text: 'Budget.', isFinal: true },
    ]);
  });
});

describe('speaker fields and independent reading order', () => {
  it('round trips a concrete label, null and absence without changing the stored order', () => {
    const ledger = new TranscriptLedger();
    ledger.apply({ itemId: 'a', text: 'A', isFinal: true, speaker: 'connection:0' });
    ledger.apply({ itemId: 'b', text: 'B', isFinal: true, speaker: null });
    ledger.apply({ itemId: 'a.2', text: 'C', isFinal: true, runOf: 'a' });
    const copy = TranscriptLedger.fromJSON(ledger.toJSON());
    expect(copy.items()).toEqual(ledger.items());
    expect(copy.get('b')?.speaker).toBeNull();
    expect(copy.get('a.2')).not.toHaveProperty('speaker');
    expect(copy.items().map((item) => item.itemId)).toEqual(['a', 'b', 'a.2']);
    expect(readingOrder(copy.items()).map((item) => item.itemId)).toEqual(['a', 'a.2', 'b']);
    expect(copy.resumeAfterId()).toBe('a.2');
    expect(copy.finalsAfter('b')).toEqual([copy.get('a.2')]);
  });

  it('changes a same-text interim label, drops it and keeps a final immutable', () => {
    const ledger = new TranscriptLedger();
    const event = { itemId: 'a', text: 'Same', isFinal: false };
    expect(ledger.apply({ ...event, speaker: 'connection:0' })).toBe(true);
    expect(ledger.apply({ ...event, speaker: 'connection:1' })).toBe(true);
    expect(ledger.get('a')?.speaker).toBe('connection:1');
    expect(ledger.apply({ ...event, speaker: null })).toBe(true);
    expect(ledger.apply({ ...event, speaker: null })).toBe(false);
    expect(ledger.get('a')?.speaker).toBeNull();
    expect(ledger.apply(event)).toBe(true);
    expect(ledger.get('a')).not.toHaveProperty('speaker');
    expect(ledger.apply(event)).toBe(false);
    expect(ledger.apply({ ...event, isFinal: true, speaker: 'connection:2' })).toBe(true);
    expect(ledger.apply({ ...event, isFinal: true, speaker: null })).toBe(false);
    expect(ledger.get('a')?.speaker).toBe('connection:2');
  });

  it('ignores malformed optional JSON fields without losing a valid line', () => {
    const ledger = TranscriptLedger.fromJSON({ v: 1, items: [
      { itemId: 'a', text: 'A', isFinal: true, speaker: 3, runOf: {} },
      { itemId: 'b', text: 'B', isFinal: true, speaker: null },
    ] });
    expect(ledger.get('a')).toEqual({ itemId: 'a', text: 'A', isFinal: true });
    expect(ledger.get('b')?.speaker).toBeNull();
  });

  it('decodes the empty attribute as null and keeps an absent attribute absent', () => {
    const attrs = { 'lk.segment_id': 'a', 'lk.transcription_final': 'true' };
    expect(TRANSCRIPTION_SPEAKER_ATTRIBUTE).toBe('agentos.speaker');
    expect(TRANSCRIPTION_RUN_OF_ATTRIBUTE).toBe('agentos.run_of');
    expect(transcriptEventFromLiveKit('A', { ...attrs, 'agentos.speaker': '' })?.speaker).toBeNull();
    expect(transcriptEventFromLiveKit('A', attrs)).not.toHaveProperty('speaker');
    expect(transcriptEventFromLiveKit('A', { ...attrs, 'agentos.speaker': 'c:0', 'agentos.run_of': 'parent' }))
      .toMatchObject({ speaker: 'c:0', runOf: 'parent' });
  });

  it.each([
    [['a', 'a.3', 'a.2'], ['a', 'a.2', 'a.3']],
    [['a.3', 'b', 'a', 'a.2', 'c'], ['a', 'a.2', 'a.3', 'b', 'c']],
    [['x', 'a', 'a.2', 'b', 'a.3', 'y'], ['x', 'a', 'a.2', 'a.3', 'b', 'y']],
    [['a.10', 'a.3', 'a.2'], ['a.2', 'a.3', 'a.10']],
    [['x', 'b', 'a'], ['x', 'b', 'a']],
  ])('reads %j in family order without mutating first-seen order', (ids, expected) => {
    const items: LedgerItem[] = ids.map((itemId) => ({
      itemId, text: itemId, isFinal: true, ...(itemId.startsWith('a.') ? { runOf: 'a' } : {}),
    }));
    const frozen = Object.freeze(items.map((item) => Object.freeze(item)));
    expect(readingOrder(frozen).map((item) => item.itemId)).toEqual(expected);
    expect(frozen.map((item) => item.itemId)).toEqual(ids);
  });

  it('keeps malformed or tied child suffixes stable after the valid runs', () => {
    const ids = ['a.bad', 'a.3', 'a.2', 'a.02', 'a'];
    const items: LedgerItem[] = ids.map((itemId) => ({
      itemId, text: itemId, isFinal: true, ...(itemId === 'a' ? {} : { runOf: 'a' }),
    }));
    expect(readingOrder(items).map((item) => item.itemId)).toEqual(['a', 'a.2', 'a.02', 'a.3', 'a.bad']);
  });
});
