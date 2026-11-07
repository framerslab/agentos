/**
 * @file deepgram-first-transcription.test.ts
 * A host that writes down a recording through the speech layer with Deepgram first, from the public speech entry
 * (`@framers/agentos/speech`): a runtime built from the environment resolves Deepgram's pre-recorded provider ahead
 * of OpenAI when both keys are set, as an `ISttProvider`; the provider takes the recording as a `SpeechAudioInput`
 * and answers its text, its segments and its duration; with no Deepgram key the same order resolves OpenAI, and with
 * neither key it resolves nothing. Deepgram's API is answered by a stubbed fetch, and any other request fails the case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSpeechRuntimeFromEnv,
  type ISttProvider,
  type ITranscriptionResult,
  type SpeechAudioInput,
} from '../index.js';

/** The order a host passes: Deepgram first, OpenAI when Deepgram is not configured. */
const DEEPGRAM_FIRST = ['deepgram-batch', 'openai-whisper'];

/** Deepgram's pre-recorded answer (https://developers.deepgram.com/reference/pre-recorded), trimmed to what is read. */
const DEEPGRAM_ANSWER = {
  metadata: { duration: 2.4 },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: 'A researcher in our Slack.',
            confidence: 0.97,
            words: [
              { word: 'a', start: 0.1, end: 0.2, confidence: 0.99 },
              { word: 'researcher', start: 0.2, end: 0.8, confidence: 0.98 },
              { word: 'in', start: 0.8, end: 0.9, confidence: 0.99 },
              { word: 'our', start: 0.9, end: 1.1, confidence: 0.97 },
              { word: 'slack', start: 1.1, end: 1.6, confidence: 0.95 },
            ],
          },
        ],
      },
    ],
  },
};

interface Sent {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers Deepgram's listen endpoint; records every request and refuses the rest. */
function stubDeepgram(): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    if (!url.startsWith('https://api.deepgram.com/v1/listen?')) throw new Error(`unexpected request: ${url}`);
    return new Response(JSON.stringify(DEEPGRAM_ANSWER), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('transcription through the speech layer, Deepgram first', () => {
  it("writes down a recording on Deepgram's pre-recorded provider when both keys are set", async () => {
    // The provider keeps the fetch it was built with, so the stub goes in before the runtime is built.
    const sent = stubDeepgram();
    const runtime = createSpeechRuntimeFromEnv({ OPENAI_API_KEY: 'sk-openai-0001', DEEPGRAM_API_KEY: 'dg-0001' });

    const stt: ISttProvider | undefined = runtime.getSTT({ preferredIds: DEEPGRAM_FIRST });
    expect(stt?.id).toBe('deepgram-batch');

    // A browser's MediaRecorder hands the host webm; the host passes it on with its type.
    const audio: SpeechAudioInput = { data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]), mimeType: 'audio/webm', fileName: 'speech.webm' };
    const result: ITranscriptionResult = await stt!.transcribe(audio);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toContain('model=nova-3');
    expect(sent[0].headers).toMatchObject({ Authorization: 'Token dg-0001', 'Content-Type': 'audio/webm' });
    expect(sent[0].body).toBe(audio.data);

    expect(result.text).toBe('A researcher in our Slack.');
    expect(result.durationSeconds).toBe(2.4);
    expect(result.usage?.durationMinutes).toBeCloseTo(0.04, 10);
    expect(result.segments?.map((s) => [s.text, s.startTime, s.endTime])).toEqual([
      ['a', 0.1, 0.2],
      ['researcher', 0.2, 0.8],
      ['in', 0.8, 0.9],
      ['our', 0.9, 1.1],
      ['slack', 1.1, 1.6],
    ]);
    expect(result.isFinal).toBe(true);
  });

  it('takes the duration the host measured when Deepgram reports none', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ results: DEEPGRAM_ANSWER.results }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const stt = createSpeechRuntimeFromEnv({ DEEPGRAM_API_KEY: 'dg-0002' }).getSTT({ preferredIds: DEEPGRAM_FIRST });

    const result = await stt!.transcribe({ data: Buffer.from([1, 2, 3]), mimeType: 'audio/webm', durationSeconds: 12 });

    expect(result.durationSeconds).toBe(12);
  });

  it("names Deepgram's status when it refuses the recording", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"err_code":"Bad Request"}', { status: 400 }));
    const stt = createSpeechRuntimeFromEnv({ DEEPGRAM_API_KEY: 'dg-0003' }).getSTT({ preferredIds: DEEPGRAM_FIRST });

    await expect(stt!.transcribe({ data: Buffer.from([1]), mimeType: 'audio/webm' })).rejects.toThrow(
      'Deepgram transcription failed (400)',
    );
  });

  it('resolves OpenAI in the same order when no Deepgram key is set, and nothing with neither key', () => {
    expect(createSpeechRuntimeFromEnv({ OPENAI_API_KEY: 'sk-openai-0002' }).getSTT({ preferredIds: DEEPGRAM_FIRST })?.id).toBe(
      'openai-whisper',
    );
    expect(createSpeechRuntimeFromEnv({}).getSTT({ preferredIds: DEEPGRAM_FIRST })).toBeUndefined();
  });
});
