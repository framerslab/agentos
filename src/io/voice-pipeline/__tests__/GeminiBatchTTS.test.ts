import { describe, expect, it, vi } from 'vitest';
import { GeminiBatchTTS, GeminiTtsError } from '../providers/GeminiBatchTTS.js';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';

function wav24kMono(samples = 24_000): Buffer {
  const dataBytes = samples * 2;
  // A padded, odd-sized JUNK chunk keeps the PCM data off the usual offset.
  const wav = Buffer.alloc(54 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('JUNK', 36);
  wav.writeUInt32LE(1, 40);
  wav.write('data', 46);
  wav.writeUInt32LE(dataBytes, 50);
  return wav;
}

function audioResponse(wav = wav24kMono()) {
  return {
    steps: [
      { content: [{ type: 'text', text: 'metadata' }] },
      { content: [{ type: 'audio', data: wav.toString('base64') }] },
    ],
    usage: { total_input_tokens: 17, total_output_tokens: 25 },
  };
}

function fakeFetch(payload: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload, { status }));
}

describe('GeminiBatchTTS', () => {
  it('sends a directed line with inline tags and one speech style', async () => {
    const wav = wav24kMono();
    const fetchImpl = fakeFetch(audioResponse(wav));
    const tts = new GeminiBatchTTS({ apiKey: 'k', fetchImpl });
    const result = await tts.synthesize('Steer left and right. Hold drift while turning.', {
      voice: 'Kore',
      direction: {
        emotion: 'eager',
        delivery: 'a race announcer',
        pace: 'brisk',
        emphasis: ['drift'],
        pauses: [{ after: 'left and right', length: 'short' }],
      },
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('k');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gemini-3.8-flash-tts',
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text: 'Steer left and right. <short pause> Hold DRIFT while turning.',
          annotations: [{ type: 'speech_metadata', style: 'eager, a race announcer, brisk pace' }],
        }],
      }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });
    expect(result.audio).toEqual(wav);
    expect(result.format).toBe('wav');
    expect(result.durationMs).toBe(1000);
    expect(result.appliedDirection).toEqual(['emotion', 'delivery', 'pace', 'emphasis', 'pauses']);
  });

  it('sends an undirected line verbatim with the configured model and voice', async () => {
    const fetchImpl = fakeFetch(audioResponse());
    const tts = new GeminiBatchTTS({
      apiKey: 'k',
      model: 'gemini-3.8-flash-lite-tts',
      voice: 'Puck',
      fetchImpl,
    });

    const result = await tts.synthesize('Wait, then go.');
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('gemini-3.8-flash-lite-tts');
    expect(body.generation_config.speech_config).toEqual([{ voice: 'Puck' }]);
    expect(body.input[0].content[0]).toEqual({ type: 'text', text: 'Wait, then go.' });
    expect(result.appliedDirection).toBeUndefined();
  });

  it('applies bursts and pauses to the original words and keeps punctuation', async () => {
    const fetchImpl = fakeFetch(audioResponse());
    const tts = new GeminiBatchTTS({ apiKey: 'k', fetchImpl });

    const result = await tts.synthesize('A drifter waits. Say drift! Then drift again.', {
      direction: {
        emphasis: ['drift'],
        pauses: [{ after: 'DRIFT', length: 'long' }],
        bursts: [{ after: 'drifter waits', kind: 'sigh' }],
      },
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.input[0].content[0].text).toBe(
      'A drifter waits. <sigh> Say DRIFT! <long pause> Then drift again.',
    );
    expect(result.appliedDirection).toEqual(['emphasis', 'pauses', 'bursts']);
  });

  it('drops direction cues whose words are absent', async () => {
    const fetchImpl = fakeFetch(audioResponse());
    const tts = new GeminiBatchTTS({ apiKey: 'k', fetchImpl });

    const result = await tts.synthesize('Keep going.', {
      direction: {
        emphasis: ['stop'],
        pauses: [{ after: 'turn', length: 'short' }],
        bursts: [{ after: 'wait', kind: 'gasp' }],
      },
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.input[0].content[0]).toEqual({ type: 'text', text: 'Keep going.' });
    expect(result.appliedDirection).toBeUndefined();
  });

  it.each([
    { status: 429, payload: { error: { status: 'RESOURCE_EXHAUSTED' } }, kind: 'quota' },
    { status: 400, payload: { error: { message: 'Unknown voice: InvalidName' } }, kind: 'unknown_voice' },
    { status: 200, payload: { steps: [{ content: [{ type: 'text', text: 'Blocked' }] }] }, kind: 'safety' },
    { status: 400, payload: { error: { message: 'Invalid input' } }, kind: 'bad_request' },
    { status: 503, payload: { error: { message: 'Unavailable' } }, kind: 'server' },
    { status: 200, payload: audioResponse(Buffer.from('not a wave')), kind: 'server' },
    { status: 200, payload: audioResponse(wav24kMono().subarray(0, 60)), kind: 'server' },
  ])('classifies HTTP $status response as $kind', async ({ status, payload, kind }) => {
    const tts = new GeminiBatchTTS({ apiKey: 'k', fetchImpl: fakeFetch(payload, status) });

    const response = tts.synthesize('Speak.');
    await expect(response).rejects.toBeInstanceOf(GeminiTtsError);
    await expect(response).rejects.toMatchObject({ kind });
  });

  it('tries the next API key when the first runs out of quota', async () => {
    const fetchImpl = fakeFetch(audioResponse()).mockResolvedValueOnce(
      Response.json({ error: { status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }),
    );
    const tts = new GeminiBatchTTS({ apiKey: 'first,second', fetchImpl });

    await expect(tts.synthesize('Keep going.')).resolves.toMatchObject({ format: 'wav' });
    expect(fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-goog-api-key')))
      .toEqual(['first', 'second']);
  });
});
