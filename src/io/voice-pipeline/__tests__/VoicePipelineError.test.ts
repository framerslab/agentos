import { describe, it, expect } from 'vitest';
import {
  VoicePipelineError,
  AggregateVoiceError,
  type HealthErrorClass,
} from '../VoicePipelineError.js';

describe('VoicePipelineError', () => {
  it('carries structured fields and a cause', () => {
    const cause = new Error('upstream');
    const err = new VoicePipelineError({
      kind: 'stt',
      provider: 'deepgram',
      errorClass: 'auth',
      message: 'invalid api key',
      cause,
      retryable: false,
    });

    expect(err.kind).toBe('stt');
    expect(err.provider).toBe('deepgram');
    expect(err.errorClass).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('invalid api key');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('VoicePipelineError');
  });

  it('classifyError maps common error shapes', () => {
    const auth = VoicePipelineError.classifyError(
      new Error('401 Unauthorized'),
      { kind: 'stt', provider: 'deepgram' }
    );
    expect(auth.errorClass).toBe('auth');
    expect(auth.retryable).toBe(false);

    const quota = VoicePipelineError.classifyError(
      new Error('429 Too Many Requests'),
      { kind: 'tts', provider: 'elevenlabs' }
    );
    expect(quota.errorClass).toBe('quota');
    expect(quota.retryable).toBe(true);

    const network = VoicePipelineError.classifyError(
      Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
      { kind: 'stt', provider: 'deepgram' }
    );
    expect(network.errorClass).toBe('network');
    expect(network.retryable).toBe(true);

    const service = VoicePipelineError.classifyError(
      new Error('500 Internal Server Error'),
      { kind: 'tts', provider: 'openai-realtime' }
    );
    expect(service.errorClass).toBe('service');
    expect(service.retryable).toBe(true);

    const unknown = VoicePipelineError.classifyError(
      new Error('something weird'),
      { kind: 'stt', provider: 'deepgram' }
    );
    expect(unknown.errorClass).toBe('unknown');
  });

  describe('classifyError on spent credit and timeouts', () => {
    const meta = { kind: 'tts' as const, provider: 'some-tts' };
    /** A TTS provider's 402 answer once its credit is spent: the status, then the first 200 characters of the body. */
    const spentCredit =
      'TTS failed: 402 {"error_code":"quota_exceeded","message":"Please upgrade your subscription at https://example.com/subscription to increase your credit limit or enable overages for your account.","title":"Model c';

    it('classes a 402 quota_exceeded answer as quota, retryable', () => {
      const classified = VoicePipelineError.classifyError(new Error(spentCredit), meta);
      expect(classified.errorClass).toBe('quota');
      expect(classified.retryable).toBe(true);
    });

    it.each([
      ['insufficient_quota', 'request failed: {"error":{"code":"insufficient_quota"}}'],
      ['quota_exceeded', 'request failed: {"error_code":"QUOTA_EXCEEDED"}'],
      ['resource_exhausted', 'request failed: RESOURCE_EXHAUSTED'],
      ['overloaded_error', 'request failed: {"type":"overloaded_error"}'],
      ['rate_limit_exceeded', 'request failed: {"code":"rate_limit_exceeded"}'],
    ])('classes a body naming %s, with no status, as quota', (_signal, message) => {
      expect(VoicePipelineError.classifyError(new Error(message), meta).errorClass).toBe('quota');
    });

    it.each(['HTTP 402', 'HTTP 456', 'TTS failed: 456 Quota Exceeded'])('classes %s as quota', (message) => {
      expect(VoicePipelineError.classifyError(new Error(message), meta).errorClass).toBe('quota');
    });

    it('still classes a 401 as auth, ahead of a quota signal in the same message', () => {
      const classified = VoicePipelineError.classifyError(new Error('401 unauthorized: insufficient_quota'), meta);
      expect(classified.errorClass).toBe('auth');
      expect(classified.retryable).toBe(false);
    });

    it('classes a TimeoutError, as AbortSignal.timeout() rejects a fetch with, as network, retryable', () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      const classified = VoicePipelineError.classifyError(timeout, meta);
      expect(classified.errorClass).toBe('network');
      expect(classified.retryable).toBe(true);
      expect(classified.cause).toBe(timeout);
    });

    it('classes the TimeoutError a real AbortSignal.timeout() gives as network', async () => {
      const signal = AbortSignal.timeout(1);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      expect((signal.reason as Error).name).toBe('TimeoutError');
      expect(VoicePipelineError.classifyError(signal.reason, meta).errorClass).toBe('network');
    });

    it("leaves a caller's own abort (AbortError) unknown", () => {
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';
      expect(VoicePipelineError.classifyError(abort, meta).errorClass).toBe('unknown');
    });
  });

  /**
   * A provider can fail with any value, and String() throws for some: an object without a prototype, and a revoked
   * proxy, which refuses even an instanceof check and the read of its code. classifyError names such a value by its
   * type and keeps it as the cause.
   */
  it.each<[string, () => unknown]>([
    ['an object without a prototype', () => Object.create(null)],
    [
      'a revoked proxy',
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      },
    ],
  ])('classifyError names %s, which String() cannot print, without throwing', (_name, unprintable) => {
    const failure = unprintable();
    const classify = (): VoicePipelineError =>
      VoicePipelineError.classifyError(failure, { kind: 'stt', provider: 'deepgram' });

    expect(classify).not.toThrow();
    const classified = classify();
    expect(classified.message).toBe('an unprintable object');
    expect(classified.errorClass).toBe('unknown');
    expect(classified.cause).toBe(failure);
  });
});

describe('AggregateVoiceError', () => {
  it('summarizes per-provider attempts', () => {
    const attempts: VoicePipelineError[] = [
      new VoicePipelineError({
        kind: 'stt',
        provider: 'deepgram',
        errorClass: 'auth',
        message: 'invalid key',
        retryable: false,
      }),
      new VoicePipelineError({
        kind: 'stt',
        provider: 'elevenlabs',
        errorClass: 'network',
        message: 'ECONNRESET',
        retryable: true,
      }),
    ];
    const agg = new AggregateVoiceError(attempts);
    expect(agg.attempts).toHaveLength(2);
    expect(agg.name).toBe('AggregateVoiceError');
    expect(agg.message).toContain('deepgram');
    expect(agg.message).toContain('elevenlabs');
    expect(agg.message).toContain('auth');
  });
});

// Compile-time check that HealthErrorClass is exported and usable.
const _typeCheck: HealthErrorClass = 'auth';
void _typeCheck;
