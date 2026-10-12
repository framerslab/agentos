/**
 * @file turnContent.test.ts
 * A multimodal turn as message parts, and a turn's content as text with no
 * image data.
 */
import { describe, expect, it, vi } from 'vitest';

import { multimodalTurnParts, turnContentText } from '../turnContent';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString('base64');

describe('multimodalTurnParts', () => {
  it('puts the text first, then an image part per vision input, typed by its MIME type or its bytes', () => {
    expect(
      multimodalTurnParts(
        'Compare these.',
        [
          { type: 'base64', data: PNG },
          { type: 'base64', data: 'aGVsbG8=', mimeType: 'image/webp' },
          { type: 'image_url', data: 'https://images.example.org/a.jpg' },
        ],
        undefined,
      ),
    ).toEqual([
      { type: 'text', text: 'Compare these.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,aGVsbG8=' } },
      { type: 'image_url', image_url: { url: 'https://images.example.org/a.jpg' } },
    ]);
  });

  it('reads base64 bytes it does not recognise as JPEG, takes a url field, and skips an input with no data', () => {
    expect(
      multimodalTurnParts(
        null,
        [
          { type: 'base64', data: 'aGVsbG8=' },
          { type: 'image_url', url: 'https://images.example.org/b.png' } as never,
          { type: 'image_url', data: '' },
        ],
        undefined,
      ),
    ).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
      { type: 'image_url', image_url: { url: 'https://images.example.org/b.png' } },
    ]);
  });

  it("keeps each vision input's description, as text before its image", () => {
    const parts = multimodalTurnParts('Which is newer?', [
      { type: 'image_url', data: 'https://images.example.org/a.jpg', description: 'Front of the 2019 model' },
      { type: 'image_url', data: 'https://images.example.org/b.jpg' },
    ], undefined);

    expect(parts).toEqual([
      { type: 'text', text: 'Which is newer?' },
      { type: 'text', text: 'Front of the 2019 model' },
      { type: 'image_url', image_url: { url: 'https://images.example.org/a.jpg' } },
      { type: 'image_url', image_url: { url: 'https://images.example.org/b.jpg' } },
    ]);
    expect(turnContentText(parts)).toBe('Which is newer?\nFront of the 2019 model\n[image]\n[image]');
    expect(turnContentText({ text: 'Look', vision: [{ type: 'image_url', data: 'x', description: 'A map' }] })).toBe('Look\nA map\n[image]');
  });

  it('sends a transcription as text, and audio data, which no chat provider here takes, as a note without the data', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(multimodalTurnParts('Notes:', undefined, { type: 'transcription', data: 'Buy milk.' })).toEqual([
      { type: 'text', text: 'Notes:' },
      { type: 'text', text: 'Buy milk.' },
    ]);
    const clip = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA';
    const parts = multimodalTurnParts('What did I say?', undefined, { type: 'base64', data: clip, mimeType: 'audio/wav' });
    expect(parts).toEqual([
      { type: 'text', text: 'What did I say?' },
      { type: 'text', text: '[An audio clip (audio/wav) came with this message. It was not transcribed, so what it says is not available.]' },
    ]);
    expect(JSON.stringify(parts)).not.toContain(clip);
    expect(multimodalTurnParts(null, undefined, { type: 'audio_url', data: 'https://audio.example.org/memo.mp3' })).toEqual([
      { type: 'text', text: '[An audio clip came with this message at https://audio.example.org/memo.mp3. It was not transcribed, so what it says is not available.]' },
    ]);
    // A data URL is the clip's data, so it stays out as base64 does.
    expect(JSON.stringify(multimodalTurnParts(null, undefined, { type: 'audio_url', data: `data:audio/wav;base64,${clip}` }))).not.toContain(clip);
    // One warning a process, however many turns carry audio.
    expect(warn.mock.calls.filter(([message]) => String(message).includes("pass it with type 'transcription'"))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('turnContentText', () => {
  it('reads parts as their text, with [image] for each image and no image data', () => {
    const text = turnContentText([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ]);
    expect(text).toBe('What is this?\n[image]');
    expect(text).not.toContain(PNG);
  });

  it('reads the earlier { text, vision, audio } object the same way, and anything else as JSON', () => {
    expect(turnContentText({ text: 'Look', vision: [{ type: 'base64', data: PNG }] })).toBe('Look\n[image]');
    expect(turnContentText('plain')).toBe('plain');
    expect(turnContentText({ toolCallId: 'c1', toolName: 't', output: { ok: true } })).toBe(
      '{"toolCallId":"c1","toolName":"t","output":{"ok":true}}',
    );
  });
});
