import { describe, expect, it } from 'vitest';
import { OpenAIWhisperBatchSTT } from '../providers/OpenAIWhisperBatchSTT.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const AUDIO = Buffer.from('opus-bytes');

describe('OpenAIWhisperBatchSTT', () => {
  it('runs on gpt-transcribe with json and a languages list, reading the duration from usage', async () => {
    const forms: FormData[] = [];
    const provider = new OpenAIWhisperBatchSTT({
      apiKey: 'sk-test',
      fetchImpl: async (_url, init) => {
        forms.push(init?.body as unknown as FormData);
        return jsonResponse({
          text: '  hello  ',
          languages: [{ code: 'en' }],
          usage: { type: 'duration', seconds: 2.5 },
        });
      },
    });

    const result = await provider.transcribe(AUDIO, { mimeType: 'audio/webm' });

    expect(forms[0].get('model')).toBe('gpt-transcribe');
    expect(forms[0].get('response_format')).toBe('json');
    expect(forms[0].getAll('languages[]')).toEqual(['en']);
    expect(forms[0].has('language')).toBe(false);
    expect(result.transcript).toBe('hello');
    expect(result.durationMs).toBe(2500);
  });

  it('keeps a configured whisper-1 on verbose_json with the singular language field', async () => {
    const forms: FormData[] = [];
    const provider = new OpenAIWhisperBatchSTT({
      apiKey: 'sk-test',
      model: 'whisper-1',
      fetchImpl: async (_url, init) => {
        forms.push(init?.body as unknown as FormData);
        return jsonResponse({ text: 'hi', duration: 1.2 });
      },
    });

    const result = await provider.transcribe(AUDIO);

    expect(forms[0].get('model')).toBe('whisper-1');
    expect(forms[0].get('response_format')).toBe('verbose_json');
    expect(forms[0].get('language')).toBe('en');
    expect(forms[0].has('languages[]')).toBe(false);
    expect(result.durationMs).toBe(1200);
  });

  it('asks a whisper-compatible server for verbose_json, so the duration is read', async () => {
    const forms: FormData[] = [];
    const provider = new OpenAIWhisperBatchSTT({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:8000/v1/audio/transcriptions',
      model: 'distil-large-v3',
      fetchImpl: async (_url, init) => {
        forms.push(init?.body as unknown as FormData);
        return jsonResponse({ text: 'hi', duration: 2.5 });
      },
    });

    const result = await provider.transcribe(AUDIO);

    expect(forms[0].get('model')).toBe('distil-large-v3');
    expect(forms[0].get('response_format')).toBe('verbose_json');
    expect(forms[0].get('language')).toBe('en');
    expect(result.durationMs).toBe(2500);
  });
});
