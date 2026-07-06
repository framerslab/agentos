import { describe, it, expect, vi } from 'vitest';
import type { IBatchSTT, BatchSTTResult } from '../types.js';
import { BatchSTTFallback, EmptyTranscriptError } from '../providers/BatchSTTFallback.js';

function mockProvider(id: string, result?: BatchSTTResult, error?: Error): IBatchSTT {
  return {
    providerId: id,
    transcribe: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(result),
  };
}

const okResult: BatchSTTResult = {
  transcript: 'hello there',
  durationMs: 1200,
  provider: 'provider-a',
};

const AUDIO = Buffer.from('bytes');

describe('BatchSTTFallback', () => {
  it('returns the first provider result on success', async () => {
    const a = mockProvider('a', okResult);
    const b = mockProvider('b', { ...okResult, provider: 'b' });
    const fallback = new BatchSTTFallback([a, b]);

    const result = await fallback.transcribe(AUDIO);

    expect(result.provider).toBe('provider-a');
    expect(a.transcribe).toHaveBeenCalledOnce();
    expect(b.transcribe).not.toHaveBeenCalled();
  });

  it('falls back to the next provider on a transport failure', async () => {
    const a = mockProvider('a', undefined, new Error('deepgram_http_503'));
    const b = mockProvider('b', { ...okResult, provider: 'provider-b' });
    const fallback = new BatchSTTFallback([a, b]);

    const result = await fallback.transcribe(AUDIO);

    expect(result.provider).toBe('provider-b');
    expect(a.transcribe).toHaveBeenCalledOnce();
    expect(b.transcribe).toHaveBeenCalledOnce();
  });

  it('rethrows EmptyTranscriptError immediately without trying the next provider', async () => {
    const a = mockProvider('a', undefined, new EmptyTranscriptError('a'));
    const b = mockProvider('b', okResult);
    const fallback = new BatchSTTFallback([a, b]);

    await expect(fallback.transcribe(AUDIO)).rejects.toBeInstanceOf(EmptyTranscriptError);
    expect(b.transcribe).not.toHaveBeenCalled();
  });

  it('throws an aggregate error when every provider fails', async () => {
    const a = mockProvider('a', undefined, new Error('deepgram_http_500'));
    const b = mockProvider('b', undefined, new Error('whisper_http_429'));
    const fallback = new BatchSTTFallback([a, b]);

    await expect(fallback.transcribe(AUDIO)).rejects.toThrow(/All STT providers failed/);
  });

  it('throws when no providers are configured', async () => {
    const fallback = new BatchSTTFallback([]);
    await expect(fallback.transcribe(AUDIO)).rejects.toThrow(/No STT providers configured/);
  });
});
