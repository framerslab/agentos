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
