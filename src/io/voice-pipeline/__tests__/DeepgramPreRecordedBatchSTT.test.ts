import { describe, it, expect } from 'vitest';
import { DeepgramPreRecordedBatchSTT } from '../providers/DeepgramPreRecordedBatchSTT.js';
import { EmptyTranscriptError } from '../providers/BatchSTTFallback.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const AUDIO = Buffer.from('opus-bytes');

describe('DeepgramPreRecordedBatchSTT', () => {
  it('transcribes and reports duration + provider id', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const provider = new DeepgramPreRecordedBatchSTT({
      apiKey: 'dg-key',
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return jsonResponse({
          metadata: { duration: 2.5 },
          results: { channels: [{ alternatives: [{ transcript: '  Hello world  ' }] }] },
        });
      },
    });

    const result = await provider.transcribe(AUDIO, { mimeType: 'audio/webm' });

    expect(result.transcript).toBe('Hello world');
    expect(result.durationMs).toBe(2500);
    expect(result.provider).toBe('deepgram-prerecorded');
    expect(capturedUrl).toContain('model=nova-3');
    expect(capturedUrl).toContain('smart_format=true');
    expect(capturedHeaders.Authorization).toBe('Token dg-key');
    expect(capturedHeaders['Content-Type']).toBe('audio/webm');
  });

  it('surfaces a silent clip as EmptyTranscriptError (not a provider failure)', async () => {
    const provider = new DeepgramPreRecordedBatchSTT({
      apiKey: 'dg-key',
      fetchImpl: async () =>
        jsonResponse({ results: { channels: [{ alternatives: [{ transcript: '   ' }] }] } }),
    });

    await expect(provider.transcribe(AUDIO)).rejects.toBeInstanceOf(EmptyTranscriptError);
  });

  it('throws a labeled error on an HTTP failure', async () => {
    const provider = new DeepgramPreRecordedBatchSTT({
      apiKey: 'dg-key',
      fetchImpl: async () => jsonResponse('rate limited', false, 429),
    });

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(/deepgram_http_429/);
  });
});
