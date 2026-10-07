import { describe, expect, it, vi } from 'vitest';
import { OpenAIWhisperSpeechToTextProvider } from '../../hearing/providers/OpenAIWhisperSpeechToTextProvider.js';
import type { SpeechAudioInput } from '../types.js';

const AUDIO: SpeechAudioInput = {
  data: Buffer.from('fake-audio-bytes'),
  mimeType: 'audio/wav',
  durationSeconds: 3,
};

/**
 * A fetch stand-in that answers every call with the given JSON body and keeps
 * the multipart form each call sent.
 */
function jsonFetch(body: object) {
  const forms: FormData[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    forms.push(init?.body as unknown as FormData);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { forms, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/**
 * Tests for {@link OpenAIWhisperSpeechToTextProvider}: the model and response
 * format it picks, the language field each model takes, and how it reads the
 * `json` answer of gpt-transcribe and the `verbose_json` answer of whisper-1.
 */
describe('OpenAIWhisperSpeechToTextProvider', () => {
  it('runs on gpt-transcribe with json and a languages list when no model is set', async () => {
    const { forms, fetchImpl } = jsonFetch({
      text: 'bonjour',
      languages: [{ code: 'fr' }],
      usage: { type: 'duration', seconds: 2.5 },
    });
    const provider = new OpenAIWhisperSpeechToTextProvider({ apiKey: 'sk-test', fetchImpl });

    const result = await provider.transcribe(AUDIO, { language: 'fr' });

    expect(forms[0].get('model')).toBe('gpt-transcribe');
    expect(forms[0].get('response_format')).toBe('json');
    // OpenAI's guide: gpt-transcribe takes `languages`, and a request must not carry both fields.
    expect(forms[0].getAll('languages[]')).toEqual(['fr']);
    expect(forms[0].has('language')).toBe(false);
    expect(result.text).toBe('bonjour');
    expect(result.language).toBe('fr');
    expect(result.durationSeconds).toBe(2.5);
    expect(result.segments).toBeUndefined();
    expect(result.usage?.modelUsed).toBe('gpt-transcribe');
  });

  it('keeps a configured whisper-1 on verbose_json with the singular language field', async () => {
    const { forms, fetchImpl } = jsonFetch({
      text: 'hello',
      language: 'english',
      duration: 4,
      segments: [{ id: 0, start: 0, end: 4, text: 'hello' }],
    });
    const provider = new OpenAIWhisperSpeechToTextProvider({
      apiKey: 'sk-test',
      model: 'whisper-1',
      fetchImpl,
    });

    const result = await provider.transcribe(AUDIO, { language: 'en' });

    expect(forms[0].get('model')).toBe('whisper-1');
    expect(forms[0].get('response_format')).toBe('verbose_json');
    expect(forms[0].get('language')).toBe('en');
    expect(forms[0].has('languages[]')).toBe(false);
    expect(result.durationSeconds).toBe(4);
    expect(result.segments).toHaveLength(1);
  });

  it('serves timestamped formats from whisper-1 unless the call names a model', async () => {
    const { forms, fetchImpl } = jsonFetch({ text: 'hello', duration: 1, segments: [] });
    const provider = new OpenAIWhisperSpeechToTextProvider({ apiKey: 'sk-test', fetchImpl });

    await provider.transcribe(AUDIO, { responseFormat: 'verbose_json' });
    await provider.transcribe(AUDIO, { responseFormat: 'verbose_json', model: 'gpt-transcribe' });

    expect(forms[0].get('model')).toBe('whisper-1');
    expect(forms[1].get('model')).toBe('gpt-transcribe');
    expect(forms[1].get('response_format')).toBe('verbose_json');
  });
});
