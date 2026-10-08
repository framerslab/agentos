import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramBatchSTTProvider } from '../../hearing/providers/DeepgramBatchSTTProvider.js';
import type { SpeechAudioInput } from '../types.js';

/** Minimal audio fixture used across all Deepgram tests. */
const AUDIO: SpeechAudioInput = {
  data: Buffer.from('fake-audio-bytes'),
  mimeType: 'audio/wav',
  durationSeconds: 5,
};

/**
 * Builds a minimal valid Deepgram REST API response payload.
 * The structure mirrors `results.channels[0].alternatives[0]` from the real API.
 */
function makeDeepgramResponse(
  transcript: string,
  confidence = 0.98,
  words: object[] = [],
  durationSeconds = 5
) {
  return {
    metadata: { duration: durationSeconds },
    results: {
      channels: [
        {
          alternatives: [{ transcript, confidence, words }],
        },
      ],
    },
  };
}

/**
 * Creates a mock fetch that returns a JSON response with the given body.
 * The `ok` flag is automatically derived from the status code.
 */
function makeFetch(body: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
}

/**
 * Tests for {@link DeepgramBatchSTTProvider} — verifies the REST API request
 * format, header authentication, response parsing, word-level diarization
 * mapping, and error handling for the Deepgram pre-recorded API.
 */
describe('DeepgramBatchSTTProvider', () => {
  let provider: DeepgramBatchSTTProvider;
  let mockFetch: ReturnType<typeof makeFetch>;

  beforeEach(() => {
    mockFetch = makeFetch(makeDeepgramResponse('hello world'));
    provider = new DeepgramBatchSTTProvider({
      apiKey: 'test-key',
      model: 'nova-2',
      language: 'en-US',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
  });

  it('should send POST to the correct Deepgram URL with query parameters', async () => {
    await provider.transcribe(AUDIO);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.deepgram.com/v1/listen');
    expect(url).toContain('model=nova-2');
    expect(url).toContain('punctuate=true');
    expect(url).toContain('language=en-US');
  });

  it('should include Authorization Token and Content-Type headers', async () => {
    await provider.transcribe(AUDIO);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Deepgram uses "Token" prefix, not "Bearer"
    expect(headers['Authorization']).toBe('Token test-key');
    expect(headers['Content-Type']).toBe('audio/wav');
  });

  it('should send the raw audio buffer as the request body', async () => {
    await provider.transcribe(AUDIO);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(AUDIO.data);
  });

  it('should use the audio mimeType as Content-Type when provided', async () => {
    const mp3Audio: SpeechAudioInput = { ...AUDIO, mimeType: 'audio/mpeg' };
    await provider.transcribe(mp3Audio);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/mpeg');
  });

  it('should return transcript text, confidence, and duration from the response', async () => {
    mockFetch = makeFetch(makeDeepgramResponse('hello world', 0.97, [], 3.5));
    provider = new DeepgramBatchSTTProvider({ apiKey: 'k', fetchImpl: mockFetch as unknown as typeof fetch });

    const result = await provider.transcribe(AUDIO);

    expect(result.text).toBe('hello world');
    expect(result.confidence).toBe(0.97);
    expect(result.durationSeconds).toBe(3.5);
    expect(result.isFinal).toBe(true);
    // Language should come from the config default
    expect(result.language).toBe('en-US');
  });

  it('should map word-level data to segments with speaker attribution', async () => {
    const words = [
      { word: 'hello', start: 0.0, end: 0.4, confidence: 0.99, speaker: 0 },
      { word: 'world', start: 0.5, end: 0.9, confidence: 0.98, speaker: 1 },
    ];
    mockFetch = makeFetch(makeDeepgramResponse('hello world', 0.99, words));
    provider = new DeepgramBatchSTTProvider({ apiKey: 'k', fetchImpl: mockFetch as unknown as typeof fetch });

    const result = await provider.transcribe(AUDIO);

    // Each word becomes its own segment for fine-grained timing
    expect(result.segments).toHaveLength(2);
    expect(result.segments![0]).toMatchObject({
      text: 'hello',
      startTime: 0.0,
      endTime: 0.4,
      speaker: 0,
    });
    // Second word should have speaker index 1 (different speaker)
    expect(result.segments![1].speaker).toBe(1);
  });

  it('should omit segments when the word list is empty', async () => {
    const result = await provider.transcribe(AUDIO);
    // No words = no segments (undefined, not empty array)
    expect(result.segments).toBeUndefined();
  });

  it('should set diarize=true in the URL when speaker diarization is requested', async () => {
    await provider.transcribe(AUDIO, { enableSpeakerDiarization: true });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('diarize=true');
  });

  it('should respect language override from transcription options', async () => {
    await provider.transcribe(AUDIO, { language: 'fr-FR' });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('language=fr-FR');
  });

  it('should throw a descriptive error including status code on non-2xx response', async () => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });
    provider = new DeepgramBatchSTTProvider({ apiKey: 'bad-key', fetchImpl: mockFetch as unknown as typeof fetch });

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(
      'Deepgram transcription failed (401): Unauthorized'
    );
  });

  it('should return cost 0 and attach the raw providerResponse', async () => {
    const result = await provider.transcribe(AUDIO);
    // Cost tracking is handled at a higher layer
    expect(result.cost).toBe(0);
    expect(result.providerResponse).toBeDefined();
  });

  it('should report correct provider id, name, and streaming capability', () => {
    expect(provider.id).toBe('deepgram-batch');
    expect(provider.supportsStreaming).toBe(false);
    expect(provider.getProviderName()).toBe('Deepgram (Batch)');
  });

  it('should default to nova-3 and send mip_opt_out only when configured', async () => {
    const defaultsFetch = makeFetch(makeDeepgramResponse('hello world'));
    const defaults = new DeepgramBatchSTTProvider({
      apiKey: 'test-key',
      fetchImpl: defaultsFetch as unknown as typeof fetch,
    });
    await defaults.transcribe(AUDIO);
    const [defaultUrl] = defaultsFetch.mock.calls[0] as [string, RequestInit];
    expect(defaultUrl).toContain('model=nova-3');
    expect(defaultUrl).not.toContain('mip_opt_out');

    const optedOutFetch = makeFetch(makeDeepgramResponse('hello world'));
    const optedOut = new DeepgramBatchSTTProvider({
      apiKey: 'test-key',
      mipOptOut: true,
      fetchImpl: optedOutFetch as unknown as typeof fetch,
    });
    await optedOut.transcribe(AUDIO);
    const [optedOutUrl] = optedOutFetch.mock.calls[0] as [string, RequestInit];
    expect(optedOutUrl).toContain('mip_opt_out=true');
  });
});
