import { describe, it, expect, vi } from 'vitest';
import { ElevenLabsTextToSpeechProvider } from '../providers/ElevenLabsTextToSpeechProvider.js';

type FetchMock = ReturnType<typeof vi.fn>;

/**
 * Audio bytes a re-encode or a text round trip would change: an ID3 tag start, a NUL, an MP3 frame sync (0xFF 0xFB)
 * and bytes above 0x7F.
 */
const AUDIO = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x80, 0xfe, 0x01]);

const LINES = [
  { text: 'Can you hear me?', voiceId: 'voice-a' },
  { text: 'Loud and clear.', voiceId: 'voice-b' },
];

/** A 200 answer of POST /v1/text-to-dialogue/with-timestamps, in the shape ElevenLabs' API reference gives. */
function dialogueAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audio_base64: Buffer.from(AUDIO).toString('base64'),
    voice_segments: [
      {
        voice_id: 'voice-a',
        start_time_seconds: 0,
        end_time_seconds: 1.25,
        character_start_index: 0,
        character_end_index: 16,
        dialogue_input_index: 0,
      },
      {
        voice_id: 'voice-b',
        start_time_seconds: 1.4,
        end_time_seconds: 2.65,
        character_start_index: 16,
        character_end_index: 31,
        dialogue_input_index: 1,
      },
    ],
    alignment: {
      characters: ['C', 'a'],
      character_start_times_seconds: [0, 0.08],
      character_end_times_seconds: [0.08, 0.15],
    },
    normalized_alignment: {
      characters: ['C', 'a'],
      character_start_times_seconds: [0, 0.07],
      character_end_times_seconds: [0.07, 0.15],
    },
    ...overrides,
  };
}

function answering(...answers: Array<{ status: number; body: unknown }>): typeof fetch {
  const queue = [...answers];
  return vi.fn(async () => {
    const answer = queue.shift() ?? answers[answers.length - 1];
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }) as unknown as typeof fetch;
}

function call(fetchImpl: typeof fetch, index = 0): { url: URL; init: RequestInit } {
  const [url, init] = (fetchImpl as unknown as FetchMock).mock.calls[index];
  return { url: new URL(String(url)), init: init as RequestInit };
}

describe('ElevenLabsTextToSpeechProvider.synthesizeDialogue', () => {
  it('posts each line with its voice id, the model and the seed, and puts the output format in the query', async () => {
    const fetchImpl = answering({ status: 200, body: dialogueAnswer() });
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl });

    await provider.synthesizeDialogue(LINES, { model: 'eleven_v4', outputFormat: 'mp3_44100_192', seed: 4294967295 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const { url, init } = call(fetchImpl);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps');
    expect(url.searchParams.get('output_format')).toBe('mp3_44100_192');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'xi-api-key': 'xi-test', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      inputs: [
        { text: 'Can you hear me?', voice_id: 'voice-a' },
        { text: 'Loud and clear.', voice_id: 'voice-b' },
      ],
      model_id: 'eleven_v4',
      seed: 4294967295,
    });
  });

  it('names eleven_v4 and mp3_44100_128 when the call names neither, sends no seed, and keeps the base URL', async () => {
    const fetchImpl = answering({ status: 200, body: dialogueAnswer() });
    // The constructor's model is synthesize()'s default; Text to Dialogue runs on Eleven v4 and v3 only.
    const provider = new ElevenLabsTextToSpeechProvider({
      apiKey: 'xi-test',
      baseUrl: 'https://proxy.example/elevenlabs/v1',
      model: 'eleven_multilingual_v2',
      fetchImpl,
    });

    const result = await provider.synthesizeDialogue(LINES);

    const { url, init } = call(fetchImpl);
    expect(`${url.origin}${url.pathname}`).toBe('https://proxy.example/elevenlabs/v1/text-to-dialogue/with-timestamps');
    expect(url.searchParams.get('output_format')).toBe('mp3_44100_128');
    const body = JSON.parse(init.body as string);
    expect(body.model_id).toBe('eleven_v4');
    expect('seed' in body).toBe(false);
    expect(result.usage).toEqual({ characters: 31, modelUsed: 'eleven_v4' });
    expect(result.outputFormat).toBe('mp3_44100_128');
  });

  it('returns the audio bytes as sent, each segment with its line index and times, and both alignments', async () => {
    const fetchImpl = answering({ status: 200, body: dialogueAnswer() });
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl });

    const result = await provider.synthesizeDialogue(LINES, { seed: 7 });

    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(result.audioBuffer.equals(Buffer.from(AUDIO))).toBe(true);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.providerName).toBe('ElevenLabs');
    expect(result.segments).toEqual([
      { lineIndex: 0, voiceId: 'voice-a', startSeconds: 0, endSeconds: 1.25, characterStartIndex: 0, characterEndIndex: 16 },
      { lineIndex: 1, voiceId: 'voice-b', startSeconds: 1.4, endSeconds: 2.65, characterStartIndex: 16, characterEndIndex: 31 },
    ]);
    expect(result.alignment).toEqual({
      characters: ['C', 'a'],
      characterStartTimesSeconds: [0, 0.08],
      characterEndTimesSeconds: [0.08, 0.15],
    });
    expect(result.normalizedAlignment).toEqual({
      characters: ['C', 'a'],
      characterStartTimesSeconds: [0, 0.07],
      characterEndTimesSeconds: [0.07, 0.15],
    });
  });

  it('leaves the alignments out when the answer has none', async () => {
    const withNull = answering({ status: 200, body: dialogueAnswer({ alignment: null, normalized_alignment: null }) });
    const nullResult = await new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl: withNull })
      .synthesizeDialogue(LINES);
    expect(nullResult.alignment).toBeUndefined();
    expect(nullResult.normalizedAlignment).toBeUndefined();
    expect(nullResult.segments).toHaveLength(2);

    const bare = dialogueAnswer();
    delete bare.alignment;
    delete bare.normalized_alignment;
    const without = answering({ status: 200, body: bare });
    const absentResult = await new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl: without })
      .synthesizeDialogue(LINES);
    expect(absentResult.alignment).toBeUndefined();
    expect(absentResult.normalizedAlignment).toBeUndefined();
    expect(absentResult.audioBuffer.equals(Buffer.from(AUDIO))).toBe(true);
  });

  it('surfaces an error answer with its status and body', async () => {
    const detail = { detail: [{ loc: ['body', 'inputs', 0, 'voice_id'], msg: 'voice not found', type: 'value_error' }] };
    const fetchImpl = answering({ status: 422, body: detail });
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl });

    const error = await provider.synthesizeDialogue(LINES).then(
      () => undefined,
      (caught: unknown) => caught as Error & { status?: number }
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.status).toBe(422);
    expect(error?.message).toContain('(422)');
    expect(error?.message).toContain('voice not found');
  });

  it('refuses a 200 answer that carries no audio', async () => {
    const fetchImpl = answering({ status: 200, body: dialogueAnswer({ audio_base64: undefined }) });
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl });

    await expect(provider.synthesizeDialogue(LINES)).rejects.toThrow(/audio_base64/);
  });

  it('moves to the next key when the first answers with a spent quota', async () => {
    const fetchImpl = answering(
      { status: 429, body: { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } } },
      { status: 200, body: dialogueAnswer() }
    );
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-one,xi-two', fetchImpl });

    const result = await provider.synthesizeDialogue(LINES);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = (call(fetchImpl, 0).init.headers as Record<string, string>)['xi-api-key'];
    const second = (call(fetchImpl, 1).init.headers as Record<string, string>)['xi-api-key'];
    expect(new Set([first, second])).toEqual(new Set(['xi-one', 'xi-two']));
    expect(result.audioBuffer.equals(Buffer.from(AUDIO))).toBe(true);
  });

  it('refuses an empty dialogue, a line with no text or voice, and a seed outside 0 to 4294967295 before any request', async () => {
    const fetchImpl = answering({ status: 200, body: dialogueAnswer() });
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'xi-test', fetchImpl });

    await expect(provider.synthesizeDialogue([])).rejects.toThrow(RangeError);
    await expect(provider.synthesizeDialogue([{ text: '', voiceId: 'voice-a' }])).rejects.toThrow(/line 0/);
    await expect(provider.synthesizeDialogue([{ text: 'Hi.', voiceId: '' }])).rejects.toThrow(/line 0/);
    await expect(provider.synthesizeDialogue(LINES, { seed: -1 })).rejects.toThrow(/seed/);
    await expect(provider.synthesizeDialogue(LINES, { seed: 4294967296 })).rejects.toThrow(/seed/);
    await expect(provider.synthesizeDialogue(LINES, { seed: 1.5 })).rejects.toThrow(/seed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
