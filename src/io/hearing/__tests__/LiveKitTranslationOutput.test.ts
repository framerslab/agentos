import { describe, expect, it } from 'vitest';
import { FakeRoom } from './livekit-fakes.js';
import { LIVEKIT_TRANSLATION_ATTRIBUTES, LIVEKIT_TRANSLATION_TOPIC, LiveKitTranslationOutput, type TranslationOutputLine } from '../LiveKitTranslationOutput.js';

const made = (itemId: string, text: string, target = 'en'): TranslationOutputLine => ({ itemId, target, source: 'es', status: 'translated', text });

/** The options a sent stream carried, as `sendText` was given them. */
interface SentOptions {
  topic?: string;
  attributes: Record<string, string>;
  destinationIdentities?: string[];
}

/** Every text stream the room's local participant sent: its text and its options. */
const sent = (room: FakeRoom) =>
  room.localParticipant.sendText.mock.calls.map(([text, options]) => ({ text, options: options as SentOptions }));

describe('LiveKitTranslationOutput', () => {
  it('sends one stream per line on lk.translation to the given identities alone, numbered per target from 1', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    await output.write(made('item_a', 'Hello.'), { destinationIdentities: ['p-1'] });
    await output.write(made('item_b', 'Bye.'), { destinationIdentities: ['p-1'] });
    await output.write(made('item_a', 'Bonjour.', 'fr'), { destinationIdentities: ['p-2'] });
    const calls = sent(room);
    expect(calls).toHaveLength(3);
    expect(LIVEKIT_TRANSLATION_TOPIC).toBe('lk.translation');
    expect(calls[0].options).toEqual({
      topic: 'lk.translation',
      destinationIdentities: ['p-1'],
      attributes: {
        [LIVEKIT_TRANSLATION_ATTRIBUTES.itemId]: 'item_a',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.target]: 'en',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.source]: 'es',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.seq]: '1',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.status]: 'translated',
      },
    });
    expect(calls[1].options.attributes[LIVEKIT_TRANSLATION_ATTRIBUTES.seq]).toBe('2');
    expect(calls[2].options.attributes[LIVEKIT_TRANSLATION_ATTRIBUTES.seq]).toBe('1');
    expect(calls[2].options.destinationIdentities).toEqual(['p-2']);
    expect(JSON.parse(calls[0].text)).toMatchObject({ itemId: 'item_a', target: 'en', text: 'Hello.', seq: 1 });
  });

  it('writes a line that failed or was skipped with an empty source attribute when its source is unknown', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    await output.write({ itemId: 'item_a', target: 'en', source: null, status: 'failed', text: null, reason: 'timeout' }, { destinationIdentities: ['p-1'] });
    const [call] = sent(room);
    expect(call.options.attributes[LIVEKIT_TRANSLATION_ATTRIBUTES.source]).toBe('');
    expect(call.options.attributes[LIVEKIT_TRANSLATION_ATTRIBUTES.status]).toBe('failed');
    expect(JSON.parse(call.text)).toMatchObject({ text: null, reason: 'timeout', seq: 1 });
  });

  it('refuses an empty identity list: sends nothing and resolves', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    await output.write(made('item_a', 'Hello.'), { destinationIdentities: [] });
    await output.send('{"kind":"status"}', { destinationIdentities: [] });
    expect(room.localParticipant.sendText).not.toHaveBeenCalled();
    expect(await output.replayAfter(null, 'en', 'p-1')).toBe(0);
  });

  it('sends a message that is not a line to the identities alone, on the topic unless another is named', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    await output.send('{"kind":"status"}', { destinationIdentities: ['p-1'] });
    await output.send('{"kind":"other"}', { topic: 'lk.other', destinationIdentities: ['p-2'] });
    expect(sent(room)).toEqual([
      { text: '{"kind":"status"}', options: { topic: 'lk.translation', destinationIdentities: ['p-1'] } },
      { text: '{"kind":"other"}', options: { topic: 'lk.other', destinationIdentities: ['p-2'] } },
    ]);
  });

  it('replays every line of one target above a seq to one identity, in order, a line sent and not read among them', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    for (const [id, text] of [['a', 'One.'], ['b', 'Two.'], ['c', 'Three.']]) await output.write(made(id, text), { destinationIdentities: ['p-1'] });
    await output.write(made('a', 'Un.', 'fr'), { destinationIdentities: ['p-2'] });
    room.localParticipant.sendText.mockClear();
    expect(await output.replayAfter(1, 'en', 'p-1')).toBe(2);
    const replayed = sent(room).map(({ text, options }) => [JSON.parse(text).itemId, options.attributes[LIVEKIT_TRANSLATION_ATTRIBUTES.seq], options.destinationIdentities]);
    expect(replayed).toEqual([['b', '2', ['p-1']], ['c', '3', ['p-1']]]);
    expect(await output.replayAfter(null, 'fr', 'p-2')).toBe(1);
    expect(await output.replayAfter(3, 'en', 'p-1')).toBe(0);
  });

  it('gives a line written again for the same item a new number', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    await output.write(made('a', 'One.'), { destinationIdentities: ['p-1'] });
    await output.write({ ...made('a', 'One!'), status: 'translated' }, { destinationIdentities: ['p-1'] });
    expect(sent(room)[1].options.attributes[LIVEKIT_TRANSLATION_ATTRIBUTES.seq]).toBe('2');
  });

  it('keeps sends in the order they were asked for, and a failed send rejects its write alone', async () => {
    const room = new FakeRoom();
    const order: string[] = [];
    room.localParticipant.sendText.mockImplementation(async (text: string) => {
      const itemId = JSON.parse(text).itemId as string;
      await new Promise((resolve) => setTimeout(resolve, itemId === 'slow' ? 20 : 0));
      if (itemId === 'broken') throw new Error('send failed');
      order.push(itemId);
      return {};
    });
    const output = new LiveKitTranslationOutput({ room });
    const writes = [
      output.write(made('slow', 'One.'), { destinationIdentities: ['p-1'] }),
      output.write(made('broken', 'Two.'), { destinationIdentities: ['p-1'] }),
      output.write(made('fast', 'Three.'), { destinationIdentities: ['p-1'] }),
    ];
    await expect(writes[1]).rejects.toThrow('send failed');
    await Promise.all([writes[0], writes[2]]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('writes the stream text the encode option gives, with the seq', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room, encode: (line, seq) => JSON.stringify({ v: 1, kind: 'line', seq, ...line }) });
    await output.write(made('a', 'One.'), { destinationIdentities: ['p-1'] });
    expect(JSON.parse(sent(room)[0].text)).toEqual({ v: 1, kind: 'line', seq: 1, itemId: 'a', target: 'en', source: 'es', status: 'translated', text: 'One.' });
  });

  it('rejects a write when the room has no local participant', async () => {
    const output = new LiveKitTranslationOutput({ room: {} });
    await expect(output.write(made('a', 'One.'), { destinationIdentities: ['p-1'] })).rejects.toThrow(/no local participant/);
  });

  it('sends a write to the identities it was given, though the caller changes its list before the send', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    const readers = ['p-1'];
    const first = output.write(made('a', 'One.'), { destinationIdentities: readers });
    readers.splice(0, readers.length, 'p-9');
    const second = output.write(made('b', 'Two.'), { destinationIdentities: readers });
    readers.length = 0;
    await Promise.all([first, second]);
    expect(sent(room).map(({ options }) => options.destinationIdentities)).toEqual([['p-1'], ['p-9']]);
  });

  it('sends and replays a line as it was written, though the caller changes the object afterwards', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranslationOutput({ room });
    const line = made('a', 'One.');
    const pending = output.write(line, { destinationIdentities: ['p-1'] });
    Object.assign(line, { itemId: 'z', target: 'fr', status: 'failed', text: null });
    await pending;
    expect(await output.replayAfter(null, 'en', 'p-1')).toBe(1);
    expect(await output.replayAfter(null, 'fr', 'p-1')).toBe(0);
    const calls = sent(room);
    expect(calls).toHaveLength(2);
    for (const { text, options } of calls) {
      expect(JSON.parse(text)).toMatchObject({ itemId: 'a', target: 'en', status: 'translated', text: 'One.', seq: 1 });
      expect(options.attributes).toMatchObject({
        [LIVEKIT_TRANSLATION_ATTRIBUTES.itemId]: 'a',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.target]: 'en',
        [LIVEKIT_TRANSLATION_ATTRIBUTES.status]: 'translated',
      });
    }
  });

  it('is exported from the livekit entry', async () => {
    const entry = await import('../livekit.js');
    expect(typeof entry.LiveKitTranslationOutput).toBe('function');
    expect(entry.LIVEKIT_TRANSLATION_TOPIC).toBe('lk.translation');
  });
});
