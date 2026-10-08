import { describe, expect, it } from 'vitest';
import {
  LIVEKIT_TRANSCRIPTION_ATTRIBUTES,
  TRANSCRIPTION_FAILED_ATTRIBUTE,
  TranscriptLedger,
  transcriptEventFromLiveKit,
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

  it('holds every line still being heard over its size, with the final it just took, so a later retraction finds its line', () => {
    const ledger = new TranscriptLedger({ maxItems: 2 });
    ledger.apply(line('i1', 'Open', false));
    ledger.apply(line('i2', 'Also open', false));
    expect(ledger.apply(line('i3', 'Three.', true))).toBe(true);
    expect(ledger.items().map((item) => item.itemId)).toEqual(['i1', 'i2', 'i3']);
    expect(ledger.apply(line('i1', '', true))).toBe(true);
    expect(ledger.apply(line('i2', 'Two.', true))).toBe(true);
    expect(ledger.items().map((item) => item.itemId)).toEqual(['i2', 'i3']);
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
});
