import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StreamingTTSChain, type TTSProviderFailoverEvent } from '../providers/StreamingTTSChain.js';
import { CircuitBreaker } from '../CircuitBreaker.js';
import { defaultCapabilities } from '../HealthyProvider.js';
import type { EncodedAudioChunk, IStreamingTTS, StreamingTTSSession } from '../types.js';
import type { HealthyProvider } from '../HealthyProvider.js';

function mkSession(providerId: string) {
  const ee = new EventEmitter() as unknown as StreamingTTSSession & {
    _tokens: string[];
    _flushed: number;
    providerId: string;
  };
  (ee as any).providerId = providerId;
  (ee as any)._tokens = [];
  (ee as any)._flushed = 0;
  (ee as any).pushTokens = (t: string) => {
    (ee as any)._tokens.push(t);
  };
  (ee as any).flush = async () => {
    (ee as any)._flushed += 1;
  };
  (ee as any).cancel = () => {};
  (ee as any).close = () => {};
  return ee;
}

function mkFakeTTS(opts: {
  id: string;
  priority?: number;
  behavior: 'success' | 'fail';
  msg?: string;
}): IStreamingTTS & HealthyProvider {
  return {
    providerId: opts.id,
    priority: opts.priority ?? 10,
    capabilities: defaultCapabilities({ streaming: true }),
    async startSession() {
      if (opts.behavior === 'fail') throw new Error(opts.msg ?? 'fail');
      return mkSession(opts.id);
    },
    async healthCheck() {
      return { ok: true };
    },
  } as IStreamingTTS & HealthyProvider;
}

describe('StreamingTTSChain — init-time fallback', () => {
  it('selects the first healthy provider', async () => {
    const a = mkFakeTTS({ id: 'eleven', behavior: 'success', priority: 10 });
    const b = mkFakeTTS({ id: 'openai', behavior: 'success', priority: 20 });
    const chain = new StreamingTTSChain([a, b]);
    const s = await chain.startSession();
    expect(chain.currentProviderId).toBe('eleven');
    s.close();
  });

  it('falls back when primary throws', async () => {
    const a = mkFakeTTS({
      id: 'eleven',
      behavior: 'fail',
      msg: '503 Service Unavailable',
    });
    const b = mkFakeTTS({ id: 'openai', behavior: 'success' });
    const chain = new StreamingTTSChain([a, b]);
    const s = await chain.startSession();
    expect(chain.currentProviderId).toBe('openai');
    s.close();
  });

  it('throws AggregateVoiceError when all fail', async () => {
    const a = mkFakeTTS({ id: 'eleven', behavior: 'fail' });
    const b = mkFakeTTS({ id: 'openai', behavior: 'fail' });
    const chain = new StreamingTTSChain([a, b]);
    await expect(chain.startSession()).rejects.toMatchObject({
      name: 'AggregateVoiceError',
    });
  });

  it('sorts providers by priority', async () => {
    const a = mkFakeTTS({ id: 'a', behavior: 'success', priority: 30 });
    const b = mkFakeTTS({ id: 'b', behavior: 'success', priority: 5 });
    const chain = new StreamingTTSChain([a, b]);
    const s = await chain.startSession();
    expect(chain.currentProviderId).toBe('b');
    s.close();
  });
});

describe('StreamingTTSChain — mid-synthesis failover', () => {
  it('re-sends accumulated tokens to the backup when primary errors', async () => {
    // Primary accepts tokens, then emits error before flush.
    let aSessionRef: any;
    const a: IStreamingTTS & HealthyProvider = {
      providerId: 'a',
      priority: 10,
      capabilities: defaultCapabilities({ streaming: true }),
      async startSession() {
        const s = mkSession('a');
        aSessionRef = s;
        return s;
      },
      async healthCheck() {
        return { ok: true };
      },
    } as any;

    let bSessionRef: any;
    const b: IStreamingTTS & HealthyProvider = {
      providerId: 'b',
      priority: 20,
      capabilities: defaultCapabilities({ streaming: true }),
      async startSession() {
        const s = mkSession('b');
        bSessionRef = s;
        return s;
      },
      async healthCheck() {
        return { ok: true };
      },
    } as any;

    const failover = vi.fn();
    const chain = new StreamingTTSChain([a, b], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    session.pushTokens('Hello ');
    session.pushTokens('world.');

    // Force primary to error, which should trigger failover to b.
    (aSessionRef as EventEmitter).emit('error', new Error('ECONNRESET'));
    // Give the microtask queue time to run the failover.
    await new Promise((r) => setTimeout(r, 30));

    expect(failover).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'a', to: 'b', kind: 'tts' })
    );
    // Backup should have received the replayed tokens (joined or in order).
    expect(bSessionRef._tokens.join('')).toContain('Hello world.');
    session.close();
  });
});

describe('StreamingTTSChain: a backup that fails as it takes over, and flush across a switch', () => {
  /** A push-contract session whose methods are spies; `close()` emits 'close', as the built-in sessions' do. */
  function pushSession() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      pushTokens: vi.fn((_text: string): void => {}),
      flush: vi.fn(async (): Promise<void> => {}),
      cancel: vi.fn((): void => {}),
      close: vi.fn((): void => {
        emitter.emit('close');
      }),
    });
  }

  /** A pull-contract session: it takes a sink and awaited writes as well. */
  function pullSession() {
    return Object.assign(pushSession(), {
      setAudioSink: vi.fn((_sink: (chunk: EncodedAudioChunk) => Promise<void>): void => {}),
      writeTokens: vi.fn(async (_text: string): Promise<void> => {}),
    });
  }

  /** A provider whose `startSession()` opens `session`. */
  function provider(id: string, priority: number, session: StreamingTTSSession) {
    const startSession = vi.fn(async (): Promise<StreamingTTSSession> => session);
    const tts: IStreamingTTS & HealthyProvider = {
      providerId: id,
      priority,
      capabilities: defaultCapabilities({ streaming: true }),
      startSession,
      async healthCheck() {
        return { ok: true };
      },
    };
    return { tts, startSession };
  }

  /**
   * A facade over the pull-contract provider `a` and the backups `b` and `c`, with a sink set and one write taken;
   * `a` then fails, so the facade switches.
   */
  async function switchingFacade(b: StreamingTTSSession, c: StreamingTTSSession) {
    const a = pullSession();
    const third = provider('c', 30, c);
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    const failover = vi.fn();
    const errors = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts, third.tts], {
      breaker,
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    session.on('error', errors);
    session.setAudioSink!(async () => {});
    await session.writeTokens!('Hello world.');
    a.emit('error', new Error('socket hang up'));
    return { chain, breaker, failover, errors, third };
  }

  it.each(['error', 'close'] as const)('passes over a backup that reports %s while it takes the replayed text, for the next provider', async (event) => {
    const b = pullSession();
    // The backup's connection fails as it takes the text; the write itself completes.
    b.writeTokens.mockImplementation(async () => {
      if (event === 'error') b.emit('error', new Error('socket hang up'));
      else b.emit('close');
    });
    const c = pullSession();
    const f = await switchingFacade(b, c);
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
    expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
    expect(c.writeTokens).toHaveBeenCalledWith('Hello world.');
    expect(f.chain.currentProviderId).toBe('c');
    expect(f.breaker.isAvailable('b')).toBe(false);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('tries the next provider when a backup refuses the replayed text', async () => {
    const b = pullSession();
    b.writeTokens.mockRejectedValue(new Error('socket closed'));
    const c = pullSession();
    const f = await switchingFacade(b, c);
    await vi.waitFor(() => expect(f.third.startSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
    expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
    expect(c.writeTokens).toHaveBeenCalledWith('Hello world.');
    expect(b.close).toHaveBeenCalled();
    expect(f.breaker.isAvailable('b')).toBe(false);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('closes a backup without setAudioSink() and writeTokens() when the audio goes to a sink, and opens the next', async () => {
    const b = pushSession();
    const c = pullSession();
    const f = await switchingFacade(b, c);
    await vi.waitFor(() => expect(f.third.startSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
    expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
    expect(c.writeTokens).toHaveBeenCalledWith('Hello world.');
    expect(b.close).toHaveBeenCalled();
    expect(b.pushTokens).not.toHaveBeenCalled();
    // The backup opened and did nothing wrong: it lacks what this facade needs.
    expect(f.breaker.isAvailable('b')).toBe(true);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('takes a provider close during a flush as a failure: the backup takes the text and is flushed in its place', async () => {
    let releaseFlush!: () => void;
    const a = pushSession();
    a.flush.mockImplementation(() => new Promise<void>((resolve) => {
      releaseFlush = resolve;
    }));
    const b = pushSession();
    const second = provider('b', 20, b);
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const closed = vi.fn();
    session.on('close', closed);
    session.pushTokens('Hello world.');
    const flushing = session.flush();
    await vi.waitFor(() => expect(a.flush).toHaveBeenCalledOnce());
    // The provider's connection drops while its flush is under way, before flush_complete.
    a.emit('close');
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(b.pushTokens).toHaveBeenCalledWith('Hello world.');
    expect(closed).not.toHaveBeenCalled();
    // The dropped session's flush settles late, as a provider's flush timeout does; the facade flushes the backup.
    releaseFlush();
    await flushing;
    expect(b.flush).toHaveBeenCalledOnce();
    expect(chain.currentProviderId).toBe('b');
  });

  it.each(['error', 'close'] as const)('flushes the backup when the provider reports %s during the flush and never settles its own flush', async (event) => {
    const a = pushSession();
    // As a provider whose connection drops mid-flush: its flush waits for a reply that never comes.
    a.flush.mockImplementation(() => new Promise<void>(() => {}));
    const b = pushSession();
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const errors = vi.fn();
    session.on('error', errors);
    session.pushTokens('Hello world.');
    const flushing = session.flush();
    await vi.waitFor(() => expect(a.flush).toHaveBeenCalledOnce());
    if (event === 'error') a.emit('error', new Error('socket hang up'));
    else a.emit('close');
    // The switch and the backup's flush settle within the turn's promise jobs, before any timer fires.
    const outcome = await Promise.race([
      flushing.then(() => 'flushed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 20)),
    ]);
    expect(outcome).toBe('flushed');
    expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(b.pushTokens).toHaveBeenCalledWith('Hello world.');
    expect(b.flush).toHaveBeenCalledOnce();
    expect(chain.currentProviderId).toBe('b');
    expect(errors).not.toHaveBeenCalled();
  });

  it('flushes the backup when the provider fails in the promise job right after flush() is called and never settles its own flush', async () => {
    const a = pushSession();
    a.flush.mockImplementation(() => new Promise<void>(() => {}));
    const b = pushSession();
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    session.pushTokens('Hello world.');
    // The provider's error is queued ahead of anything the flush awaits, so it lands before the flush resumes.
    void Promise.resolve().then(() => a.emit('error', new Error('socket hang up')));
    const flushing = session.flush();
    const outcome = await Promise.race([
      flushing.then(() => 'flushed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 20)),
    ]);
    expect(outcome).toBe('flushed');
    expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(b.pushTokens).toHaveBeenCalledWith('Hello world.');
    expect(b.flush).toHaveBeenCalledOnce();
    expect(chain.currentProviderId).toBe('b');
  });

  it('rejects flush() when the flush fails and no provider can take over', async () => {
    const a = pushSession();
    a.flush.mockRejectedValue(new Error('socket closed'));
    const chain = new StreamingTTSChain([provider('a', 10, a).tts], { enableMidSynthesisFailover: true });
    const session = await chain.startSession();
    const seen: string[] = [];
    session.on('error', () => seen.push('error'));
    session.on('close', () => seen.push('close'));
    session.pushTokens('Hello world.');
    await expect(session.flush()).rejects.toThrow('synthesis failed');
    expect(seen).toEqual(['error', 'close']);
  });

  it('rejects a flush() that waited on a switch no provider could take', async () => {
    const a = pushSession();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts], { enableMidSynthesisFailover: true });
    const session = await chain.startSession();
    const seen: string[] = [];
    session.on('error', () => seen.push('error'));
    session.on('close', () => seen.push('close'));
    session.pushTokens('Hello world.');
    // The provider fails before the flush: the flush waits on a switch that finds no provider.
    a.emit('error', new Error('socket hang up'));
    await expect(session.flush()).rejects.toThrow('synthesis failed');
    expect(seen).toEqual(['error', 'close']);
    expect(a.flush).not.toHaveBeenCalled();
  });

  it.each([
    ['at once', false],
    ['after a timer, as a connection does', true],
  ] as const)('flushes the provider a second switch opened when the backup fails as the first switch ends (the next opens %s)', async (_label, slow) => {
    const a = pushSession();
    const b = pushSession();
    const c = pushSession();
    const third = provider('c', 30, c);
    if (slow) third.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((resolve) => setTimeout(() => resolve(c), 0)));
    const failover = vi.fn((event: TTSProviderFailoverEvent): void => {
      // The backup's connection drops as the switch to it is reported, before that switch has ended.
      if (event.to === 'b') b.emit('error', new Error('socket hang up'));
    });
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts, third.tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const errors = vi.fn();
    session.on('error', errors);
    session.pushTokens('Hello world.');
    a.emit('error', new Error('socket hang up'));
    // The flush waits on the switch to b, which ends by starting the switch to c.
    await session.flush();
    expect(failover.mock.calls.map(([event]) => `${event.from}>${event.to}`)).toEqual(['a>b', 'b>c']);
    expect(c.pushTokens).toHaveBeenCalledWith('Hello world.');
    expect(c.flush).toHaveBeenCalledOnce();
    expect(b.flush).not.toHaveBeenCalled();
    expect(chain.currentProviderId).toBe('c');
    expect(errors).not.toHaveBeenCalled();
  });
});
