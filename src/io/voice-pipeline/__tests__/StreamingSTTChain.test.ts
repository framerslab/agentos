import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StreamingSTTChain } from '../providers/StreamingSTTChain.js';
import { defaultCapabilities } from '../HealthyProvider.js';
import type { IStreamingSTT, StreamingSTTSession } from '../types.js';
import type { HealthyProvider } from '../HealthyProvider.js';

function mkSession(providerId: string): StreamingSTTSession {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    providerId,
    async pushAudio() {},
    async close() {},
  }) as unknown as StreamingSTTSession;
}

function mkFakeProvider(opts: {
  id: string;
  priority?: number;
  startBehavior: 'success' | 'fail';
  failMessage?: string;
}): IStreamingSTT & HealthyProvider {
  return {
    providerId: opts.id,
    priority: opts.priority ?? 10,
    capabilities: defaultCapabilities({ languages: ['en'] }),
    isStreaming: false,
    async startSession() {
      if (opts.startBehavior === 'fail') {
        throw new Error(opts.failMessage ?? `fake ${opts.id} fail`);
      }
      return mkSession(opts.id);
    },
    async healthCheck() {
      return { ok: true };
    },
  };
}

describe('StreamingSTTChain — init-time fallback', () => {
  it('picks the first provider when primary succeeds', async () => {
    const a = mkFakeProvider({ id: 'a', startBehavior: 'success', priority: 10 });
    const b = mkFakeProvider({ id: 'b', startBehavior: 'success', priority: 20 });
    const selected = vi.fn();
    const chain = new StreamingSTTChain([a, b], { onProviderSelected: selected });
    const session = await chain.startSession();
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'a' }));
    expect(chain.currentProviderId).toBe('a');
    await session.close();
  });

  it('sorts providers by priority', async () => {
    // b has lower priority (tried first) even though declared second.
    const a = mkFakeProvider({ id: 'a', startBehavior: 'success', priority: 30 });
    const b = mkFakeProvider({ id: 'b', startBehavior: 'success', priority: 5 });
    const chain = new StreamingSTTChain([a, b]);
    const session = await chain.startSession();
    expect(chain.currentProviderId).toBe('b');
    await session.close();
  });

  it('falls back to the next when primary throws', async () => {
    const a = mkFakeProvider({
      id: 'a',
      startBehavior: 'fail',
      failMessage: '401 Unauthorized',
    });
    const b = mkFakeProvider({ id: 'b', startBehavior: 'success' });
    const failed = vi.fn();
    const selected = vi.fn();
    const chain = new StreamingSTTChain([a, b], {
      onProviderFailed: failed,
      onProviderSelected: selected,
    });
    const session = await chain.startSession();
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'a', errorClass: 'auth' })
    );
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'b' }));
    expect(chain.currentProviderId).toBe('b');
    await session.close();
  });

  it('throws AggregateVoiceError when all fail', async () => {
    const a = mkFakeProvider({ id: 'a', startBehavior: 'fail' });
    const b = mkFakeProvider({ id: 'b', startBehavior: 'fail' });
    const chain = new StreamingSTTChain([a, b]);
    await expect(chain.startSession()).rejects.toMatchObject({
      name: 'AggregateVoiceError',
    });
  });

  it('respects circuit breaker: skips tripped providers', async () => {
    const { CircuitBreaker } = await import('../CircuitBreaker.js');
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });
    breaker.recordFailure('a', 'auth');
    const a = mkFakeProvider({ id: 'a', startBehavior: 'fail' });
    const b = mkFakeProvider({ id: 'b', startBehavior: 'success' });
    const chain = new StreamingSTTChain([a, b], { breaker });
    const session = await chain.startSession();
    expect(chain.currentProviderId).toBe('b');
    await session.close();
  });

  it('emits provider_selected metric on success', async () => {
    const { VoiceMetricsReporter } = await import('../VoiceMetricsReporter.js');
    const metrics = new VoiceMetricsReporter();
    const received: unknown[] = [];
    metrics.subscribe((e) => received.push(e));
    const a = mkFakeProvider({ id: 'a', startBehavior: 'success' });
    const chain = new StreamingSTTChain([a], { metrics });
    await chain.startSession();
    expect(received[0]).toEqual({
      type: 'provider_selected',
      kind: 'stt',
      providerId: 'a',
      attempt: 1,
    });
  });

  it('exposes providers getter for introspection', () => {
    const a = mkFakeProvider({ id: 'a', startBehavior: 'success', priority: 30 });
    const b = mkFakeProvider({ id: 'b', startBehavior: 'success', priority: 5 });
    const chain = new StreamingSTTChain([a, b]);
    expect(chain.providers.map((p) => p.providerId)).toEqual(['b', 'a']);
  });
});

describe('StreamingSTTChain: mid-utterance failover and close', () => {
  /** A session that emits 'close' when it is closed, as the built-in providers' sessions do. */
  function mkClosingSession(providerId: string) {
    const ee = new EventEmitter();
    let closed = false;
    const close = vi.fn(() => {
      if (closed) return;
      closed = true;
      ee.emit('close');
    });
    return Object.assign(ee, {
      providerId,
      pushAudio: vi.fn(),
      async flush() {},
      close,
    });
  }

  function mkProvider(
    id: string,
    priority: number,
    startSession: () => Promise<StreamingSTTSession>
  ): IStreamingSTT & HealthyProvider {
    return {
      providerId: id,
      priority,
      capabilities: defaultCapabilities({ languages: ['en'] }),
      isStreaming: true,
      startSession,
      async healthCheck() {
        return { ok: true };
      },
    };
  }

  /** Lets the chain's pending promise continuations run. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('moves to the next provider when the active session ends by itself', async () => {
    const sessionA = mkClosingSession('a');
    const sessionB = mkClosingSession('b');
    const startB = vi.fn(async () => sessionB);
    const failover = vi.fn();
    const chain = new StreamingSTTChain(
      [mkProvider('a', 10, async () => sessionA), mkProvider('b', 20, startB)],
      { enableMidUtteranceFailover: true, onProviderFailover: failover }
    );
    await chain.startSession();

    sessionA.emit('close');
    await settle();

    expect(startB).toHaveBeenCalledTimes(1);
    expect(failover).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b' }));
    expect(chain.currentProviderId).toBe('b');
  });

  it('starts no backup, records no failure and emits no error when the caller closes the session', async () => {
    const { CircuitBreaker } = await import('../CircuitBreaker.js');
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    const sessionA = mkClosingSession('a');
    const startB = vi.fn(async () => mkClosingSession('b'));
    const failover = vi.fn();
    const chain = new StreamingSTTChain(
      [mkProvider('a', 10, async () => sessionA), mkProvider('b', 20, startB)],
      { breaker, enableMidUtteranceFailover: true, onProviderFailover: failover }
    );
    const session = await chain.startSession();
    const errors = vi.fn();
    session.on('error', errors);

    session.close();
    await settle();

    expect(sessionA.close).toHaveBeenCalledTimes(1);
    expect(startB).not.toHaveBeenCalled();
    expect(failover).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(breaker.isAvailable('a')).toBe(true);
  });

  it('closes a backup that opens after the caller closed the session', async () => {
    const sessionA = mkClosingSession('a');
    const sessionB = mkClosingSession('b');
    let openB: (session: StreamingSTTSession) => void = () => {};
    const startB = vi.fn(
      () =>
        new Promise<StreamingSTTSession>((resolve) => {
          openB = resolve;
        })
    );
    const failover = vi.fn();
    const chain = new StreamingSTTChain(
      [mkProvider('a', 10, async () => sessionA), mkProvider('b', 20, startB)],
      { enableMidUtteranceFailover: true, onProviderFailover: failover }
    );
    const session = await chain.startSession();

    // The primary fails, and the backup is still connecting when the caller closes.
    sessionA.emit('error', new Error('socket dropped'));
    expect(startB).toHaveBeenCalledTimes(1);
    session.close();
    openB(sessionB);
    await settle();

    expect(sessionB.close).toHaveBeenCalledTimes(1);
    expect(failover).not.toHaveBeenCalled();
    expect(chain.currentProviderId).toBe('a');
  });

  it('forwards usage reports and warnings from its sessions: the one in use, one that failed, and the backup', async () => {
    const sessionA = mkClosingSession('a');
    const sessionB = mkClosingSession('b');
    const chain = new StreamingSTTChain(
      [mkProvider('a', 10, async () => sessionA), mkProvider('b', 20, async () => sessionB)],
      { enableMidUtteranceFailover: true }
    );
    const session = await chain.startSession();
    const usage = vi.fn();
    const warnings = vi.fn();
    session.on('usage', usage);
    session.on('warning', warnings);

    const open = { providerId: 'a', connectionIndex: 1, audioSeconds: 2, final: false };
    const warning = new Error('transcription failed for one item');
    sessionA.emit('usage', open);
    sessionA.emit('warning', warning);
    expect(usage.mock.calls).toEqual([[open]]);
    expect(warnings.mock.calls).toEqual([[warning]]);

    // The session fails, and reports its connection's last usage as it closes; the backup takes over.
    const last = { providerId: 'a', connectionIndex: 1, audioSeconds: 3, final: true };
    sessionA.emit('error', new Error('socket dropped'));
    sessionA.emit('usage', last);
    await settle();
    expect(chain.currentProviderId).toBe('b');
    const fromBackup = { providerId: 'b', connectionIndex: 1, audioSeconds: 1, final: false };
    sessionB.emit('usage', fromBackup);
    expect(usage.mock.calls).toEqual([[open], [last], [fromBackup]]);
  });

  it('prints a warning nobody listens for, as a provider session by itself does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sessionA = mkClosingSession('a');
    const chain = new StreamingSTTChain([mkProvider('a', 10, async () => sessionA)], {
      enableMidUtteranceFailover: true,
    });
    await chain.startSession();
    sessionA.emit('warning', new Error('transcription failed for one item'));
    expect(warn).toHaveBeenCalledWith('[a] transcription failed for one item');
    warn.mockRestore();
  });
});
