import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssemblyAISTTProvider } from '../../hearing/providers/AssemblyAISTTProvider.js';
import type { SpeechAudioInput } from '../types.js';

/** Minimal audio fixture used across all AssemblyAI tests. */
const AUDIO: SpeechAudioInput = {
  data: Buffer.from('fake-audio-bytes'),
  mimeType: 'audio/wav',
  durationSeconds: 4,
};

/**
 * Standard completed transcript response matching the AssemblyAI API shape.
 * Word timings are in milliseconds (AssemblyAI's native unit), which the
 * provider must convert to seconds.
 */
const COMPLETED_TRANSCRIPT = {
  id: 'tx_123',
  status: 'completed',
  text: 'hello there',
  confidence: 0.95,
  audio_duration: 4,
  language_code: 'en_us',
  words: [
    { text: 'hello', start: 0, end: 400, confidence: 0.96, speaker: 'A' },
    { text: 'there', start: 500, end: 900, confidence: 0.94, speaker: 'A' },
  ],
};

/**
 * Builds a mock fetch implementation that handles the three-step AssemblyAI flow:
 * upload -> submit -> poll (with configurable status sequence).
 *
 * The `pollStatuses` array controls what status each successive poll returns.
 * Once the array is exhausted, subsequent polls return 'completed'.
 */
function makeAssemblyFetch(pollStatuses: string[]) {
  let pollCallIndex = 0;

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    // Step 1 — upload: returns a CDN URL for the uploaded audio
    if (url === 'https://api.assemblyai.com/v2/upload') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ upload_url: 'https://cdn.assemblyai.com/audio/abc123' }),
        text: () => Promise.resolve(''),
      });
    }

    // Step 2 — submit transcript: returns a transcript ID for polling
    if (url === 'https://api.assemblyai.com/v2/transcript' && init?.method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'tx_123' }),
        text: () => Promise.resolve(''),
      });
    }

    // Step 3 — poll: returns the transcript with the configured status
    if (url === 'https://api.assemblyai.com/v2/transcript/tx_123') {
      const status = pollStatuses[pollCallIndex] ?? 'completed';
      const isCompleted = status === 'completed';
      const isError = status === 'error';
      pollCallIndex++;

      const body = isCompleted
        ? COMPLETED_TRANSCRIPT
        : isError
          ? { id: 'tx_123', status: 'error', error: 'Audio file could not be decoded' }
          : { id: 'tx_123', status };

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(''),
      });
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

/**
 * Tests for {@link AssemblyAISTTProvider} — verifies the three-step async
 * transcription pipeline (upload -> submit -> poll), polling state transitions,
 * word timing conversion (milliseconds -> seconds), timeout handling, and
 * error propagation at each step.
 */
describe('AssemblyAISTTProvider', () => {
  beforeEach(() => {
    // Fake timers are needed to control the polling interval (setTimeout)
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should report correct provider id, name, and streaming capability', () => {
    const provider = new AssemblyAISTTProvider({ apiKey: 'key' });
    expect(provider.id).toBe('assemblyai');
    expect(provider.supportsStreaming).toBe(false);
    expect(provider.getProviderName()).toBe('AssemblyAI');
  });

  it('should complete the upload -> submit -> poll flow successfully', async () => {
    const mockFetch = makeAssemblyFetch(['completed']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const promise = provider.transcribe(AUDIO);
    // Advance fake timers so the poll setTimeout resolves
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.text).toBe('hello there');
    expect(result.isFinal).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.durationSeconds).toBe(4);
  });

  it('should poll through queued -> processing -> completed states', async () => {
    const mockFetch = makeAssemblyFetch(['queued', 'processing', 'completed']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const promise = provider.transcribe(AUDIO);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.text).toBe('hello there');
    // Total fetch calls: upload(1) + submit(1) + 3 polls = 5
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('should send the Authorization header on all three request types', async () => {
    const mockFetch = makeAssemblyFetch(['completed']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'secret-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const promise = provider.transcribe(AUDIO);
    await vi.runAllTimersAsync();
    await promise;

    // Every request (upload, submit, poll) must include the API key
    for (const [, init] of mockFetch.mock.calls as [string, RequestInit][]) {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.['Authorization']).toBe('secret-key');
    }
  });

  it('should send audio body and correct content-type on the upload step', async () => {
    const mockFetch = makeAssemblyFetch(['completed']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const promise = provider.transcribe(AUDIO);
    await vi.runAllTimersAsync();
    await promise;

    // Find the upload call by URL
    const uploadCall = mockFetch.mock.calls.find(
      ([url]) => url === 'https://api.assemblyai.com/v2/upload'
    ) as [string, RequestInit] | undefined;

    expect(uploadCall).toBeDefined();
    const [, uploadInit] = uploadCall!;
    // Raw audio buffer is sent as the body
    expect(uploadInit.body).toBe(AUDIO.data);
    const headers = uploadInit.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('audio/wav');
  });

  it('should include speaker_labels in the submit body when diarization is requested', async () => {
    const mockFetch = makeAssemblyFetch(['completed']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const promise = provider.transcribe(AUDIO, { enableSpeakerDiarization: true });
    await vi.runAllTimersAsync();
    await promise;

    // Find the submit call by URL and method
    const submitCall = mockFetch.mock.calls.find(
      ([url, init]) =>
        url === 'https://api.assemblyai.com/v2/transcript' && init?.method === 'POST'
    ) as [string, RequestInit] | undefined;

    expect(submitCall).toBeDefined();
    const [, submitInit] = submitCall!;
    const body = JSON.parse(submitInit.body as string);
    expect(body.speaker_labels).toBe(true);
  });

  it('should convert word timings from milliseconds to seconds in segments', async () => {
    const mockFetch = makeAssemblyFetch(['completed']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const promise = provider.transcribe(AUDIO);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.segments).toHaveLength(2);
    // 0ms -> 0s, 400ms -> 0.4s
    expect(result.segments![0].startTime).toBe(0);
    expect(result.segments![0].endTime).toBeCloseTo(0.4);
    // Speaker labels are preserved as-is (string 'A')
    expect(result.segments![0].speaker).toBe('A');
  });

  it('should throw when the transcript status transitions to error', async () => {
    const mockFetch = makeAssemblyFetch(['error']);
    const provider = new AssemblyAISTTProvider({
      apiKey: 'key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const caught = provider.transcribe(AUDIO).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch('AssemblyAI transcription error');
  });

  it('should throw on timeout when the transcript never completes', async () => {
    // Always return 'processing' so the loop never exits naturally
    const mockFetch = makeAssemblyFetch(Array(200).fill('processing'));
    const provider = new AssemblyAISTTProvider({
      apiKey: 'key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const caught = provider.transcribe(AUDIO).catch((e: unknown) => e);
    // Advance well past the 120-second timeout
    await vi.advanceTimersByTimeAsync(125_000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it('should throw a descriptive error when the upload step returns non-2xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });
    const provider = new AssemblyAISTTProvider({
      apiKey: 'key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(provider.transcribe(AUDIO)).rejects.toThrow(
      'AssemblyAI upload failed (503): Service Unavailable'
    );
  });
});
