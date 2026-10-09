import { describe, expect, it } from 'vitest';
import { TranscriptLedger, transcriptEventFromLiveKit } from '../../voice-pipeline/transcriptLedger.js';
import { LiveKitTranscriptionOutput } from '../LiveKitTranscriptionOutput.js';
import { FakeRoom } from './livekit-fakes.js';

const final = (itemId: string, text: string) => ({ itemId, text, isFinal: true, confidence: 1, words: [] });
const interim = (itemId: string, text: string) => ({ itemId, text, isFinal: false, confidence: 1, words: [] });

describe('LiveKitTranscriptionOutput', () => {
  it("writes each transcript as a stream on lk.transcription with LiveKit's attributes, the item id as the segment", async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room, trackSid: () => 'TR_1' });
    await output.write(interim('item_a', 'The off'));
    await output.write(final('item_a', 'The offsite is in Lisbon.'));
    expect(room.localParticipant.sendText.mock.calls).toEqual([
      ['The off', { topic: 'lk.transcription', attributes: { 'lk.segment_id': 'item_a', 'lk.transcription_final': 'false', 'lk.transcribed_track_id': 'TR_1' } }],
      ['The offsite is in Lisbon.', { topic: 'lk.transcription', attributes: { 'lk.segment_id': 'item_a', 'lk.transcription_final': 'true', 'lk.transcribed_track_id': 'TR_1' } }],
    ]);
  });

  it('sends nothing for a repeated final or an interim after its final', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room });
    expect(await output.write(final('item_a', 'Done.'))).toBe(true);
    expect(await output.write(final('item_a', 'Done.'))).toBe(false);
    expect(await output.write(interim('item_a', 'Do'))).toBe(false);
    expect(room.localParticipant.sendText).toHaveBeenCalledTimes(1);
  });

  it('replays the finals after an item to one participant, in order, and all of them for an unknown item', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room });
    await output.write(final('i1', 'One.'));
    await output.write(final('i2', 'Two.'));
    await output.write(interim('i3', 'Thr'));
    room.localParticipant.sendText.mockClear();
    expect(await output.replayAfter('i1', 'user-1')).toBe(1);
    expect(room.localParticipant.sendText.mock.calls[0]).toEqual([
      'Two.',
      { topic: 'lk.transcription', attributes: { 'lk.segment_id': 'i2', 'lk.transcription_final': 'true' }, destinationIdentities: ['user-1'] },
    ]);
    expect(await output.replayAfter('gone', 'user-1')).toBe(2);
  });

  it('replays a line taken back as its empty final, so a page that missed the retraction drops the line', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room });
    const page = new TranscriptLedger();
    const deliver = (from: number) => {
      for (const [text, options] of room.localParticipant.sendText.mock.calls.slice(from)) {
        const event = transcriptEventFromLiveKit(text, (options as { attributes?: Record<string, string> } | undefined)?.attributes);
        if (event) page.apply(event);
      }
    };
    await output.write(final('i1', 'One.'));
    await output.write(interim('i2', 'Tw'));
    deliver(0);
    await output.write(final('i2', ''));
    const away = room.localParticipant.sendText.mock.calls.length;
    expect(await output.replayAfter(page.resumeAfterId(), 'user-1')).toBe(1);
    deliver(away);
    expect(page.items().map((item) => item.itemId)).toEqual(['i1']);
  });

  it('marks a failed line with its reason and keeps writes in the order they were asked for', async () => {
    const room = new FakeRoom();
    const sent: string[] = [];
    room.localParticipant.sendText.mockImplementation(async (text: string) => {
      await new Promise((resolve) => setTimeout(resolve, text === 'slow' ? 20 : 0));
      sent.push(text);
      return {};
    });
    const output = new LiveKitTranscriptionOutput({ room });
    await Promise.all([output.write(interim('i1', 'slow')), output.write(final('i2', 'fast')), output.write(final('i3', ''), { failed: 'audio_unintelligible' })]);
    expect(sent).toEqual(['slow', 'fast', '']);
    expect(room.localParticipant.sendText.mock.calls[2]?.[1]).toMatchObject({ attributes: { 'agentos.transcription_failed': 'audio_unintelligible' } });
  });

  it('refuses a transcript with no item id, and a room with no local participant', async () => {
    const output = new LiveKitTranscriptionOutput({ room: new FakeRoom() });
    await expect(output.write({ text: 'x', isFinal: true, confidence: 1, words: [] })).rejects.toBeInstanceOf(RangeError);
    const bare = Object.assign(new FakeRoom(), { localParticipant: undefined });
    await expect(new LiveKitTranscriptionOutput({ room: bare }).write(final('i1', 'x'))).rejects.toThrow('no local participant');
  });

  it('keeps a final whose send failed, so writing it again sends nothing and a replay still carries it', async () => {
    const room = new FakeRoom();
    room.localParticipant.sendText.mockRejectedValueOnce(new Error('data channel closed'));
    const output = new LiveKitTranscriptionOutput({ room });
    await expect(output.write(final('i1', 'One.'))).rejects.toThrow('data channel closed');
    expect(await output.write(final('i1', 'One.'))).toBe(false);
    expect(await output.replayAfter(undefined, 'user-1')).toBe(1);
    expect(room.localParticipant.sendText).toHaveBeenLastCalledWith('One.', expect.objectContaining({ destinationIdentities: ['user-1'] }));
  });
});

describe("LiveKitTranscriptionOutput: a final's times", () => {
  const attributesOf = (options: unknown) => (options as { attributes?: Record<string, string> } | undefined)?.attributes;

  it('writes a final with times as agentos.start_ms and agentos.end_ms beside the three lk. attributes', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room, trackSid: () => 'TR_1' });
    await output.write({ ...final('item_a', 'The offsite is in Lisbon.'), startMs: 1200, endMs: 3400 });
    expect(room.localParticipant.sendText.mock.calls).toEqual([
      [
        'The offsite is in Lisbon.',
        {
          topic: 'lk.transcription',
          attributes: {
            'lk.segment_id': 'item_a',
            'lk.transcription_final': 'true',
            'lk.transcribed_track_id': 'TR_1',
            'agentos.start_ms': '1200',
            'agentos.end_ms': '3400',
          },
        },
      ],
    ]);
  });

  it('writes neither time on a final without them, nor on an interim that has them', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room, trackSid: () => 'TR_1' });
    await output.write({ ...interim('item_a', 'The off'), startMs: 1200, endMs: 1900 });
    await output.write(final('item_b', 'Budget.'));
    expect(room.localParticipant.sendText.mock.calls.map(([, options]) => attributesOf(options))).toEqual([
      { 'lk.segment_id': 'item_a', 'lk.transcription_final': 'false', 'lk.transcribed_track_id': 'TR_1' },
      { 'lk.segment_id': 'item_b', 'lk.transcription_final': 'true', 'lk.transcribed_track_id': 'TR_1' },
    ]);
  });

  it('replays a final with the times it was first written with, and a page reading the replay holds them on its line', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room });
    await output.write({ ...final('i1', 'One.'), startMs: 1200, endMs: 3400 });
    await output.write({ ...interim('i2', 'Tw'), startMs: 3600 });
    room.localParticipant.sendText.mockClear();
    expect(await output.replayAfter(undefined, 'user-1')).toBe(1);
    expect(room.localParticipant.sendText.mock.calls).toEqual([
      [
        'One.',
        {
          topic: 'lk.transcription',
          attributes: { 'lk.segment_id': 'i1', 'lk.transcription_final': 'true', 'agentos.start_ms': '1200', 'agentos.end_ms': '3400' },
          destinationIdentities: ['user-1'],
        },
      ],
    ]);
    const page = new TranscriptLedger();
    for (const [text, options] of room.localParticipant.sendText.mock.calls) {
      const event = transcriptEventFromLiveKit(text, attributesOf(options));
      if (event) page.apply(event);
    }
    expect(page.items()).toEqual([{ itemId: 'i1', text: 'One.', isFinal: true, startMs: 1200, endMs: 3400 }]);
  });

  it('writes whole milliseconds, the form a page reads back, and leaves out a time that is not one', async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room });
    await output.write({ ...final('i1', 'One.'), startMs: 1200.4, endMs: 3399.6 });
    await output.write({ ...final('i2', 'Two.'), startMs: -5, endMs: Number.NaN });
    expect(room.localParticipant.sendText.mock.calls.map(([, options]) => attributesOf(options))).toEqual([
      { 'lk.segment_id': 'i1', 'lk.transcription_final': 'true', 'agentos.start_ms': '1200', 'agentos.end_ms': '3400' },
      { 'lk.segment_id': 'i2', 'lk.transcription_final': 'true' },
    ]);
  });

  it("writes a time of zero as '0', and a page's line holds 0 rather than no time", async () => {
    const room = new FakeRoom();
    const output = new LiveKitTranscriptionOutput({ room });
    await output.write({ ...final('i1', 'Hello.'), startMs: 0, endMs: 850 });
    expect(room.localParticipant.sendText.mock.calls.map(([, options]) => attributesOf(options))).toEqual([
      { 'lk.segment_id': 'i1', 'lk.transcription_final': 'true', 'agentos.start_ms': '0', 'agentos.end_ms': '850' },
    ]);
    const page = new TranscriptLedger();
    for (const [text, options] of room.localParticipant.sendText.mock.calls) {
      const event = transcriptEventFromLiveKit(text, attributesOf(options));
      if (event) page.apply(event);
    }
    expect(page.items()).toEqual([{ itemId: 'i1', text: 'Hello.', isFinal: true, startMs: 0, endMs: 850 }]);
  });
});
