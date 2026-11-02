import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StreamingTTSChain, type TTSProviderFailoverEvent } from '../providers/StreamingTTSChain.js';
import { CircuitBreaker } from '../CircuitBreaker.js';
import { AggregateVoiceError } from '../VoicePipelineError.js';
import { VoiceMetricsReporter, type VoiceMetricEvent } from '../VoiceMetricsReporter.js';
import { defaultCapabilities } from '../HealthyProvider.js';
import type { EncodedAudioChunk, IStreamingTTS, StreamingTTSSession } from '../types.js';
import type { HealthyProvider } from '../HealthyProvider.js';
import type { ProviderPolicy } from '../ProviderPolicy.js';

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
    return { chain, session, breaker, failover, errors, third };
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

  it('takes nothing from a provider after the error that began the switch, though it ends its segment and completes its flush within the same call: the backup takes the text and is flushed in its place', async () => {
    const a = pushSession();
    // As DeepgramAuraStreamingTTS does when its socket closes mid-reply: the error, then, in the same call, the frame it
    // held and the flush_complete that ends its flush, then its close.
    a.flush.mockImplementation(() => new Promise<void>(() => {}));
    const b = pushSession();
    b.flush.mockImplementation(async () => {
      b.emit('audio', { audio: Buffer.from([9, 9]), format: 'pcm', sampleRate: 24000, durationMs: 0, text: '' });
      b.emit('flush_complete');
    });
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const heard: number[] = [];
    const flushes = vi.fn();
    const errors = vi.fn();
    session.on('audio', (chunk: EncodedAudioChunk) => heard.push(chunk.audio[0]!));
    session.on('flush_complete', flushes);
    session.on('error', errors);
    session.pushTokens('One. Two.');
    const flushing = session.flush();
    await vi.waitFor(() => expect(a.flush).toHaveBeenCalledOnce());
    a.emit('error', new Error('deepgram aura ws closed (code 1011)'));
    a.emit('audio', { audio: Buffer.from([1, 1]), format: 'pcm', sampleRate: 24000, durationMs: 0, text: 'One.' });
    a.emit('flush_complete');
    a.emit('close');
    // Nothing of the failed provider's reaches the facade: its flush_complete would end the request as spoken.
    expect(flushes).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
    await flushing;
    expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(b.pushTokens).toHaveBeenCalledWith('One. Two.');
    expect(b.flush).toHaveBeenCalledOnce();
    expect(heard).toEqual([9]);
    expect(flushes).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it('goes on with a switch a cancel() comes in on: the backup takes the next request and none of the cut one, and the flush the cut request began flushes nothing of the next', async () => {
    const a = pushSession();
    // As a provider whose connection drops mid-flush: its flush waits for a reply that never comes.
    a.flush.mockImplementation(() => new Promise<void>(() => {}));
    const b = pushSession();
    b.flush.mockImplementation(async () => {
      b.emit('flush_complete');
    });
    const second = provider('b', 20, b);
    // The backup's connection takes a while to open, as a socket's does: the cancel and the next request come meanwhile.
    let opened!: () => void;
    second.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((resolve) => {
      opened = () => resolve(b);
    }));
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const flushes = vi.fn();
    const errors = vi.fn();
    const closes = vi.fn();
    session.on('flush_complete', flushes);
    session.on('error', errors);
    session.on('close', closes);
    session.pushTokens('One. Two.');
    const cut = session.flush();
    await vi.waitFor(() => expect(a.flush).toHaveBeenCalledOnce());
    a.emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(second.startSession).toHaveBeenCalledOnce());
    // A barge-in while the backup opens cuts the request, and the next request begins before the backup has opened.
    session.cancel();
    session.pushTokens('Three.');
    opened();
    await cut;
    // The backup takes the next request's text, none of the cut one's, and the flush the cut request began ends
    // without flushing it: its flush_complete would end the next request before its text has all come.
    expect(b.pushTokens.mock.calls).toEqual([['Three.']]);
    expect(failover).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b' }));
    expect(b.flush).not.toHaveBeenCalled();
    expect(flushes).not.toHaveBeenCalled();
    // The rest of the next request goes to the backup, and the request ends as a request does.
    session.pushTokens(' Four.');
    expect(b.pushTokens.mock.calls).toEqual([['Three.'], [' Four.']]);
    await session.flush();
    expect(b.flush).toHaveBeenCalledOnce();
    expect(flushes).toHaveBeenCalledOnce();
    expect(chain.currentProviderId).toBe('b');
    expect(errors).not.toHaveBeenCalled();
    expect(closes).not.toHaveBeenCalled();
  });

  it.each([
    ['once the switch has ended', false],
    ['while the backup still opens', true],
  ] as const)("ends a writeTokens() that waited on the switch with the cancel() that came meanwhile: the backup takes the next request's text alone, written %s, and a later switch replays none of the cut one's", async (_when, early) => {
    const a = pullSession();
    const b = pullSession();
    const c = pullSession();
    const second = provider('b', 20, b);
    // The backup's connection takes a while to open, as a socket's does: the cancel and the next request come meanwhile.
    let opened!: () => void;
    second.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((resolve) => {
      opened = () => resolve(b);
    }));
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts, provider('c', 30, c).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const errors = vi.fn();
    session.on('error', errors);
    session.setAudioSink!(async () => {});
    await session.writeTokens!('Hello world. ');
    // The provider in use fails, and the reply's next write waits on the switch while the backup opens.
    a.emit('error', new Error('socket hang up'));
    const cut = session.writeTokens!('How are you?');
    await vi.waitFor(() => expect(second.startSession).toHaveBeenCalledOnce());
    // A barge-in cuts the request before the backup has opened: the write that waited was issued before it and is the
    // cut request's. The next request's text comes once the switch has ended, or while the backup still opens.
    session.cancel();
    const next = early ? session.writeTokens!('Sure.') : undefined;
    opened();
    // A write the cancel cut resolves, as one cut in flight does, and admits nothing.
    await expect(cut).resolves.toBeUndefined();
    if (next) await next;
    else await session.writeTokens!('Sure.');
    expect(failover).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b' }));
    expect(b.writeTokens.mock.calls).toEqual([['Sure.']]);
    // The backup fails during the next request: the next provider takes that request's text and none of the cut one's,
    // which the facade never kept.
    b.emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(failover).toHaveBeenCalledTimes(2));
    expect(failover.mock.calls[1]![0]).toMatchObject({ from: 'b', to: 'c' });
    expect(c.writeTokens.mock.calls).toEqual([['Sure.']]);
    expect(chain.currentProviderId).toBe('c');
    expect(errors).not.toHaveBeenCalled();
  });

  it('resolves a writeTokens() that waited on the switch and that a cancel() cut, when the switch then finds no provider and ends the facade', async () => {
    const a = pullSession();
    const second = provider('b', 20, pullSession());
    // The backup's opening fails once the cancel has come, so no provider takes over and the facade ends on a failure.
    let refuse!: () => void;
    second.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((_resolve, reject) => {
      refuse = () => reject(new Error('connect ECONNREFUSED'));
    }));
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true });
    const session = await chain.startSession();
    const errors = vi.fn();
    const closes = vi.fn();
    session.on('error', errors);
    session.on('close', closes);
    session.setAudioSink!(async () => {});
    await session.writeTokens!('Hello world. ');
    a.emit('error', new Error('socket hang up'));
    const cut = session.writeTokens!('How are you?');
    await vi.waitFor(() => expect(second.startSession).toHaveBeenCalledOnce());
    session.cancel();
    refuse();
    // The write the cancel cut resolves and admits nothing, though the switch then ended the facade.
    await expect(cut).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledOnce();
    expect(closes).toHaveBeenCalledOnce();
    // A write issued after the end throws.
    await expect(session.writeTokens!('Sure.')).rejects.toThrow('synthesis closed');
  });

  it('throws from a writeTokens() that waited on the switch when close() came, cancel() or not', async () => {
    const a = pullSession();
    const b = pullSession();
    const second = provider('b', 20, b);
    let opened!: () => void;
    second.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((resolve) => {
      opened = () => resolve(b);
    }));
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true });
    const session = await chain.startSession();
    session.setAudioSink!(async () => {});
    await session.writeTokens!('Hello world. ');
    a.emit('error', new Error('socket hang up'));
    const waiting = session.writeTokens!('How are you?');
    await vi.waitFor(() => expect(second.startSession).toHaveBeenCalledOnce());
    session.cancel();
    session.close();
    opened();
    await expect(waiting).rejects.toThrow('synthesis closed');
    expect(b.writeTokens).not.toHaveBeenCalled();
  });

  it('takes nothing from a backup once its failure is recorded during the switch: an error and a flush_complete it emits in one call, as it takes text pushed after the replay, leave the text to the next provider', async () => {
    const a = pushSession();
    const b = pushSession();
    const c = pushSession();
    const failover = vi.fn();
    const completed = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts, provider('c', 30, c).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    session.on('flush_complete', completed);
    session.pushTokens('One.');
    // The backup takes the replay, and the caller's next text comes in the promise job after it, before the switch has
    // ended. The backup fails as it takes that text: it reports the lost connection and completes its flush in one call.
    b.pushTokens
      .mockImplementationOnce(() => {
        queueMicrotask(() => session.pushTokens(' Two.'));
      })
      .mockImplementationOnce(() => {
        b.emit('error', new Error('socket hang up'));
        b.emit('flush_complete');
      });
    a.emit('error', new Error('socket hang up'));
    await session.flush();
    // The request is not ended as spoken: the next provider takes all of its text and is flushed in its place.
    expect(completed).not.toHaveBeenCalled();
    expect(failover).toHaveBeenCalledTimes(2);
    expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(failover.mock.calls[1]![0]).toMatchObject({ from: 'b', to: 'c' });
    expect(c.pushTokens.mock.calls).toEqual([['One.'], [' Two.']]);
    expect(c.flush).toHaveBeenCalledOnce();
  });

  it("takes an error the backup reports after a cancel() during the switch as the cut request's, though the next request's text has come: the backup takes that text and is not passed over", async () => {
    const b = pullSession();
    let release: () => void = () => {};
    // The replay's write of the cut request is under way when the cancel comes, and settles only after the backup has
    // reported the cut as an error, once the next request's text has come.
    b.writeTokens.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const c = pullSession();
    const f = await switchingFacade(b, c);
    await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
    f.session.cancel();
    f.session.pushTokens('Next one.');
    b.emit('error', new Error('request cancelled'));
    release();
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
    expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(b.writeTokens.mock.calls).toEqual([['Hello world.'], ['Next one.']]);
    expect(f.third.startSession).not.toHaveBeenCalled();
    expect(f.chain.currentProviderId).toBe('b');
    expect(f.breaker.isAvailable('b')).toBe(true);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('sends the backup the text pushed in the promise job after it took the replay, before the switch has ended', async () => {
    const a = pushSession();
    const b = pushSession();
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    session.pushTokens('One.');
    // The caller's next text comes in the promise job after the backup took the replay, as the next token of a stream
    // under way does, while the switch has yet to end.
    b.pushTokens.mockImplementationOnce(() => {
      queueMicrotask(() => session.pushTokens(' Two.'));
    });
    a.emit('error', new Error('socket hang up'));
    await session.flush();
    expect(failover).toHaveBeenCalledOnce();
    // The backup takes that text as well, before its flush: the reply it speaks is the whole reply.
    expect(b.pushTokens.mock.calls).toEqual([['One.'], [' Two.']]);
    expect(b.flush).toHaveBeenCalledOnce();
  });

  it('counts a request as flushed by its own flush alone: the flush of a cut request that settles once the next one has begun leaves a close during the next one a failure, and the backup takes its text', async () => {
    const a = pushSession();
    // As a provider whose flush settles once its server has answered the cancel.
    let settle!: () => void;
    a.flush.mockImplementationOnce(() => new Promise<void>((resolve) => {
      settle = resolve;
    }));
    const b = pushSession();
    const failover = vi.fn();
    const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
      enableMidSynthesisFailover: true,
      onProviderFailover: failover,
    });
    const session = await chain.startSession();
    const closes = vi.fn();
    session.on('close', closes);
    session.pushTokens('One.');
    const cut = session.flush();
    await vi.waitFor(() => expect(a.flush).toHaveBeenCalledOnce());
    // A barge-in cuts the request, and the next one begins before the cut one's flush settles.
    session.cancel();
    session.pushTokens('Two.');
    settle();
    await cut;
    // The provider's connection drops while the next request is under way, before its flush: a failure, not the end of
    // a flushed request, so the facade goes on through the backup, which takes the next request's text.
    a.emit('close');
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    expect(b.pushTokens.mock.calls).toEqual([['Two.']]);
    expect(closes).not.toHaveBeenCalled();
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

  /** The answer a promise gives within a timer's wait: a switch here settles within the turn's promise jobs. */
  const settled = (promise: Promise<unknown>): Promise<string> =>
    Promise.race([
      promise.then(
        () => 'settled',
        (error: Error) => `rejected: ${error.message}`,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 20)),
    ]);

  /** As a provider whose connection dropped: the reply its write waits for never comes. */
  const parked = (): Promise<void> => new Promise<void>(() => {});

  /** One chunk of audio, marked by its first byte. */
  const chunk = (mark: number): EncodedAudioChunk => ({ audio: Buffer.from([mark]), format: 'pcm', sampleRate: 24000, durationMs: 0, text: '' });

  /** A hosted policy that permits the named providers and a mid-session switch among them. */
  function allowlisted(ids: string[], over: Partial<ProviderPolicy> = {}): ProviderPolicy {
    return {
      mode: 'hosted',
      fallback: 'allowlisted',
      identity: { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } },
      purposes: ['tts'],
      providers: ids.map((providerId) => ({ providerId, locality: 'remote' as const, purposes: ['tts' as const], priceVersion: `rate-${providerId}` })),
      authorize: vi.fn(async () => {}),
      onFallback: vi.fn(),
      ...over,
    };
  }

  describe('a write or a replay parked on a dead provider', () => {
    it.each(['error', 'close'] as const)('settles a writeTokens() parked on the provider when it reports %s: the backup takes the text', async (event) => {
      const a = pullSession();
      a.writeTokens.mockImplementation(parked);
      const b = pullSession();
      const failover = vi.fn();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], { enableMidSynthesisFailover: true, onProviderFailover: failover });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      const write = session.writeTokens!('Hi.');
      await vi.waitFor(() => expect(a.writeTokens).toHaveBeenCalledOnce());
      if (event === 'error') a.emit('error', new Error('socket hang up'));
      else a.emit('close');
      expect(await settled(write)).toBe('settled');
      expect(b.writeTokens.mock.calls).toEqual([['Hi.']]);
      expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
    });

    it('settles a writeTokens() when the provider fails in the call right after it: the failed provider is not left holding the write', async () => {
      const a = pullSession();
      a.writeTokens.mockImplementation(parked);
      const b = pullSession();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      const write = session.writeTokens!('Hi.');
      a.emit('error', new Error('socket hang up'));
      expect(await settled(write)).toBe('settled');
      expect(b.writeTokens.mock.calls).toEqual([['Hi.']]);
    });

    it('rejects a writeTokens() parked on the provider when no provider can take over', async () => {
      const a = pullSession();
      a.writeTokens.mockImplementation(parked);
      const chain = new StreamingTTSChain([provider('a', 10, a).tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.setAudioSink!(async () => {});
      const write = session.writeTokens!('Hi.');
      await vi.waitFor(() => expect(a.writeTokens).toHaveBeenCalledOnce());
      a.emit('error', new Error('socket hang up'));
      expect(await settled(write)).toBe('rejected: synthesis failed');
      expect(errors).toHaveBeenCalledOnce();
    });

    it('rejects a writeTokens() parked on the provider when close() comes', async () => {
      const a = pullSession();
      a.writeTokens.mockImplementation(parked);
      const chain = new StreamingTTSChain([provider('a', 10, a).tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      const write = session.writeTokens!('Hi.');
      await vi.waitFor(() => expect(a.writeTokens).toHaveBeenCalledOnce());
      session.close();
      expect(await settled(write)).toBe('rejected: synthesis failed');
    });

    it.each(['error', 'close'] as const)('passes over a backup that reports %s while a replayed write of it never settles, for the next provider', async (event) => {
      const b = pullSession();
      b.writeTokens.mockImplementation(parked);
      const c = pullSession();
      const f = await switchingFacade(b, c);
      await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
      if (event === 'error') b.emit('error', new Error('socket hang up'));
      else b.emit('close');
      expect(await settled(f.session.flush())).toBe('settled');
      expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
      expect(c.writeTokens).toHaveBeenCalledWith('Hello world.');
      expect(c.flush).toHaveBeenCalledOnce();
      expect(b.close).toHaveBeenCalled();
      expect(f.breaker.isAvailable('b')).toBe(false);
      expect(f.errors).not.toHaveBeenCalled();
    });

    it('passes over a backup that reports its failure within a replayed write that never settles', async () => {
      const b = pullSession();
      b.writeTokens.mockImplementation(() => {
        b.emit('close');
        return parked();
      });
      const c = pullSession();
      const f = await switchingFacade(b, c);
      await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
      expect(await settled(f.session.flush())).toBe('settled');
      expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
    });

    it('ends a flush() and a writeTokens() that wait on a replay parked on a backup when close() comes', async () => {
      const b = pullSession();
      b.writeTokens.mockImplementation(parked);
      const c = pullSession();
      const f = await switchingFacade(b, c);
      await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
      const flushing = f.session.flush();
      const writing = f.session.writeTokens!('Next.');
      f.session.close();
      expect(await settled(flushing)).toBe('settled');
      expect(await settled(writing)).toBe('rejected: synthesis closed');
      expect(b.close).toHaveBeenCalled();
      expect(f.third.startSession).not.toHaveBeenCalled();
    });

    it.each(['opening', 'authorization'] as const)("ends a flush() and a writeTokens() that wait on a backup's %s that never settles when close() comes", async (waitingOn) => {
      const a = pullSession();
      const b = pullSession();
      const second = provider('b', 20, b);
      let opened: () => void = () => {};
      if (waitingOn === 'opening') {
        second.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((resolve) => {
          opened = () => resolve(b);
        }));
      }
      const policy = allowlisted(['a', 'b'], {
        authorize: async (request) => {
          if (waitingOn === 'authorization' && request.to === 'b') await new Promise<void>(() => {});
        },
      });
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true, policy });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      await session.writeTokens!('Hello world. ');
      a.emit('error', new Error('socket hang up'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const flushing = session.flush();
      const writing = session.writeTokens!('How are you?');
      session.close();
      expect(await settled(flushing)).toBe('settled');
      expect(await settled(writing)).toBe('rejected: synthesis closed');
      // A backup that opens after the close is cancelled and closed, and takes nothing.
      opened();
      if (waitingOn === 'opening') await vi.waitFor(() => expect(b.close).toHaveBeenCalled());
      expect(b.writeTokens).not.toHaveBeenCalled();
    });
  });

  describe('a healthy session', () => {
    it("leaves nothing behind per write: no write races a promise that stays pending for the session's life, which would keep one reaction per token", async () => {
      const a = pullSession();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      const race = vi.spyOn(Promise, 'race');
      try {
        for (let i = 0; i < 10; i++) await session.writeTokens!('Hi. ');
        expect(race).not.toHaveBeenCalled();
      } finally {
        race.mockRestore();
      }
    });
  });

  describe('a host hook that throws', () => {
    it('goes on to the next backup when onProviderFailed throws during a switch', async () => {
      const a = pushSession();
      const second = provider('b', 20, pushSession());
      second.startSession.mockRejectedValue(new Error('401 unauthorized'));
      const c = pushSession();
      const failover = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts, provider('c', 30, c).tts], {
          enableMidSynthesisFailover: true,
          onProviderFailed: () => {
            throw new Error('host bug');
          },
          onProviderFailover: failover,
        });
        const session = await chain.startSession();
        const errors = vi.fn();
        session.on('error', errors);
        session.pushTokens('Hi.');
        a.emit('error', new Error('socket hang up'));
        await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
        expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
        expect(c.pushTokens).toHaveBeenCalledWith('Hi.');
        expect(errors).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([['[chain] onProviderFailed threw']]);
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps the backup that took the text when onProviderFailover throws', async () => {
      const a = pushSession();
      const b = pushSession();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
          enableMidSynthesisFailover: true,
          onProviderFailover: () => {
            throw new Error('host bug');
          },
        });
        const session = await chain.startSession();
        const errors = vi.fn();
        session.on('error', errors);
        session.pushTokens('Hi.');
        a.emit('error', new Error('socket hang up'));
        await session.flush();
        expect(b.flush).toHaveBeenCalledOnce();
        expect(errors).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([['[chain] onProviderFailover threw']]);
      } finally {
        warn.mockRestore();
      }
    });

    it.each(['onProviderSelected', 'onProviderFailed'] as const)('opens the session when %s throws at startup, with the provider that opened and none recorded failed for the hook', async (hook) => {
      const first = provider('a', 10, pushSession());
      if (hook === 'onProviderFailed') first.startSession.mockRejectedValue(new Error('401 unauthorized'));
      const second = pushSession();
      const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const chain = new StreamingTTSChain([first.tts, provider('b', 20, second).tts], {
          breaker,
          [hook]: () => {
            throw new Error('host bug');
          },
        });
        await chain.startSession();
        expect(chain.currentProviderId).toBe(hook === 'onProviderFailed' ? 'b' : 'a');
        expect(breaker.isAvailable(hook === 'onProviderFailed' ? 'b' : 'a')).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('a cut write the provider refuses late', () => {
    it("takes the refusal of a write a cancel() cut as the cut's, though the next request's text has come: the write resolves and the provider stays in use", async () => {
      const a = pullSession();
      let refuse: () => void = () => {};
      a.writeTokens.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        refuse = () => reject(new Error('stale synthesis'));
      }));
      const b = pullSession();
      const second = provider('b', 20, b);
      const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { breaker, enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.setAudioSink!(async () => {});
      const write = session.writeTokens!('old');
      await vi.waitFor(() => expect(a.writeTokens).toHaveBeenCalledOnce());
      session.cancel();
      session.pushTokens('new');
      refuse();
      expect(await settled(write)).toBe('settled');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(a.pushTokens.mock.calls).toEqual([['new']]);
      expect(a.close).not.toHaveBeenCalled();
      expect(second.startSession).not.toHaveBeenCalled();
      expect(breaker.isAvailable('a')).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    });

    it('still takes the refusal of a write no cancel() cut as a failure: the backup takes the text', async () => {
      const a = pullSession();
      a.writeTokens.mockRejectedValueOnce(new Error('socket closed'));
      const b = pullSession();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      await session.writeTokens!('Hi.');
      expect(b.writeTokens.mock.calls).toEqual([['Hi.']]);
      expect(chain.currentProviderId).toBe('b');
    });
  });

  describe('events of a backup that fails during a switch', () => {
    /** The chain's failure events, as `onProviderFailed` and the metrics report them. */
    function reports() {
      const metrics = new VoiceMetricsReporter();
      const events: VoiceMetricEvent[] = [];
      metrics.subscribe((event) => events.push(event));
      return { metrics, events, onProviderFailed: vi.fn(), failover: vi.fn() };
    }

    it('reports a backup whose opening fails during a switch, as a failed opening at startup is reported', async () => {
      const a = pushSession();
      const second = provider('b', 20, pushSession());
      second.startSession.mockRejectedValue(new Error('401 unauthorized'));
      const c = pushSession();
      const r = reports();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts, provider('c', 30, c).tts], {
        enableMidSynthesisFailover: true,
        metrics: r.metrics,
        onProviderFailed: r.onProviderFailed,
        onProviderFailover: r.failover,
      });
      const session = await chain.startSession();
      session.pushTokens('Hi.');
      a.emit('error', new Error('socket hang up'));
      await vi.waitFor(() => expect(r.failover).toHaveBeenCalledOnce());
      expect(r.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
      expect(r.onProviderFailed.mock.calls.map(([event]) => event)).toEqual([expect.objectContaining({ kind: 'tts', providerId: 'b', message: expect.stringContaining('401') })]);
      expect(r.events.filter((event) => event.type === 'provider_failed')).toEqual([expect.objectContaining({ kind: 'tts', providerId: 'b' })]);
      expect(c.pushTokens).toHaveBeenCalledWith('Hi.');
    });

    it('reports a backup that fails as it takes the text', async () => {
      const a = pushSession();
      const b = pushSession();
      b.pushTokens.mockImplementation(() => {
        b.emit('error', new Error('socket hang up'));
      });
      const c = pushSession();
      const r = reports();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts, provider('c', 30, c).tts], {
        enableMidSynthesisFailover: true,
        metrics: r.metrics,
        onProviderFailed: r.onProviderFailed,
        onProviderFailover: r.failover,
      });
      const session = await chain.startSession();
      session.pushTokens('Hi.');
      a.emit('error', new Error('connection reset'));
      await vi.waitFor(() => expect(r.failover).toHaveBeenCalledOnce());
      expect(r.onProviderFailed.mock.calls.map(([event]) => event)).toEqual([expect.objectContaining({ kind: 'tts', providerId: 'b' })]);
      expect(r.events.filter((event) => event.type === 'provider_failed')).toEqual([expect.objectContaining({ providerId: 'b' })]);
    });

    it('reports provider_unavailable and names every failure in the aggregate error when the switch finds no provider', async () => {
      const a = pushSession();
      const second = provider('b', 20, pushSession());
      second.startSession.mockRejectedValue(new Error('401 unauthorized'));
      const r = reports();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true, metrics: r.metrics });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('error', new Error('socket hang up'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      const failure = errors.mock.calls[0]![0] as AggregateVoiceError;
      expect(failure).toBeInstanceOf(AggregateVoiceError);
      expect(failure.attempts.map((attempt) => attempt.provider)).toEqual(['a', 'b']);
      expect(failure.message).toContain('401');
      expect(r.events.filter((event) => event.type === 'provider_unavailable')).toEqual([{ type: 'provider_unavailable', kind: 'tts', checkedProviders: ['a', 'b'] }]);
    });

    it('reports no provider_unavailable when close() came while the last backup opened and its opening then fails', async () => {
      const a = pushSession();
      const second = provider('b', 20, pushSession());
      let refuse!: (error: Error) => void;
      second.startSession.mockImplementation(() => new Promise<StreamingTTSSession>((_resolve, reject) => {
        refuse = reject;
      }));
      const r = reports();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true, metrics: r.metrics, onProviderFailed: r.onProviderFailed });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('error', new Error('socket hang up'));
      await vi.waitFor(() => expect(second.startSession).toHaveBeenCalledOnce());
      session.close();
      refuse(new Error('socket hang up'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // The opening did fail, and says so; the caller's close ended the session, so no provider is reported as what ended it.
      expect(r.onProviderFailed.mock.calls.map(([event]) => event.providerId)).toEqual(['b']);
      expect(r.events.filter((event) => event.type === 'provider_unavailable')).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    });

    it('carries no provider text in those events under a ProviderPolicy', async () => {
      const a = pushSession();
      const second = provider('b', 20, pushSession());
      second.startSession.mockRejectedValue(new Error('401 key sk-secret refused'));
      const c = pushSession();
      const r = reports();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts, provider('c', 30, c).tts], {
        enableMidSynthesisFailover: true,
        policy: allowlisted(['a', 'b', 'c']),
        metrics: r.metrics,
        onProviderFailed: r.onProviderFailed,
        onProviderFailover: r.failover,
      });
      const session = await chain.startSession();
      session.pushTokens('Hi.');
      a.emit('error', new Error('socket hang up'));
      await vi.waitFor(() => expect(r.failover).toHaveBeenCalledOnce());
      expect(r.onProviderFailed.mock.calls[0]![0]).toMatchObject({ providerId: 'b', message: 'provider opening failed' });
    });
  });

  describe('a session that throws as the switch lets it go', () => {
    it('goes on to the backup, closes the failed session and keeps the failure when cancel() of the failed session throws', async () => {
      const a = pushSession();
      a.cancel.mockImplementation(() => {
        throw new Error('not open');
      });
      const b = pushSession();
      const failover = vi.fn();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], { enableMidSynthesisFailover: true, onProviderFailover: failover });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('error', new Error('ECONNRESET'));
      await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
      expect(a.close).toHaveBeenCalled();
      expect(b.pushTokens).toHaveBeenCalledWith('Hi.');
      expect(errors).not.toHaveBeenCalled();
    });

    it('closes the session when its cancel() throws as the facade ends', async () => {
      const a = pushSession();
      a.cancel.mockImplementation(() => {
        throw new Error('not open');
      });
      const chain = new StreamingTTSChain([provider('a', 10, a).tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('error', new Error('ECONNRESET'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      expect((errors.mock.calls[0]![0] as Error).message).toContain('ECONNRESET');
      expect(a.close).toHaveBeenCalled();
    });
  });

  describe('a strict policy and audio', () => {
    it('switches on an idle error after a completed request: flush_complete ended it, so there is nothing to repeat', async () => {
      const a = pushSession();
      const b = pushSession();
      const failover = vi.fn();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
        enableMidSynthesisFailover: true,
        policy: allowlisted(['a', 'b']),
        onProviderFailover: failover,
      });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('audio', chunk(1));
      a.emit('flush_complete');
      a.emit('error', new Error('idle socket closed'));
      await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
      expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
      expect(b.pushTokens).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      session.pushTokens('Next.');
      expect(b.pushTokens.mock.calls).toEqual([['Next.']]);
    });

    it('still fails rather than repeat a request whose audio has gone out and that no flush_complete ended', async () => {
      const a = pushSession();
      const second = provider('b', 20, pushSession());
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true, policy: allowlisted(['a', 'b']) });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('audio', chunk(1));
      a.emit('error', new Error('socket hang up'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      expect((errors.mock.calls[0]![0] as Error).message).toBe('partial synthesis cannot be replayed');
      expect(second.startSession).not.toHaveBeenCalled();
    });

    it('fails rather than let a next provider repeat what a backup played before it failed', async () => {
      const a = pushSession();
      const b = pushSession();
      b.pushTokens.mockImplementation(() => {
        b.emit('audio', chunk(2));
        b.emit('error', new Error('socket hang up'));
      });
      const third = provider('c', 30, pushSession());
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts, third.tts], { enableMidSynthesisFailover: true, policy: allowlisted(['a', 'b', 'c']) });
      const session = await chain.startSession();
      const errors = vi.fn();
      const heard: number[] = [];
      session.on('error', errors);
      session.on('audio', (played: EncodedAudioChunk) => heard.push(played.audio[0]!));
      session.pushTokens('Hi.');
      a.emit('error', new Error('connection reset'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      expect((errors.mock.calls[0]![0] as Error).message).toBe('partial synthesis cannot be replayed');
      expect(heard).toEqual([2]);
      expect(third.startSession).not.toHaveBeenCalled();
    });

    it("goes on to the backup when a cancel() in the failure's own call cut the request whose audio went out", async () => {
      const a = pushSession();
      const b = pushSession();
      const failover = vi.fn();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], {
        enableMidSynthesisFailover: true,
        policy: allowlisted(['a', 'b']),
        onProviderFailover: failover,
      });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.pushTokens('Hi.');
      a.emit('audio', chunk(1));
      a.emit('error', new Error('socket hang up'));
      session.cancel();
      await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
      expect(failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
      expect(b.pushTokens).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    });

    it('counts a chunk that went through the sink as audio: the request is not sent again', async () => {
      const a = pullSession();
      const second = provider('b', 20, pullSession());
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true, policy: allowlisted(['a', 'b']) });
      const session = await chain.startSession();
      const errors = vi.fn();
      session.on('error', errors);
      session.setAudioSink!(async () => {});
      await session.writeTokens!('Hi.');
      await a.setAudioSink.mock.calls[0]![0](chunk(1));
      a.emit('error', new Error('socket hang up'));
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      expect((errors.mock.calls[0]![0] as Error).message).toBe('partial synthesis cannot be replayed');
      expect(second.startSession).not.toHaveBeenCalled();
    });
  });

  describe('the sink the facade hands a session', () => {
    it("passes the chunks of the session in use to the caller's sink and refuses a failed session's and a cut request's", async () => {
      const a = pullSession();
      const b = pullSession();
      const failover = vi.fn();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts], { enableMidSynthesisFailover: true, onProviderFailover: failover });
      const session = await chain.startSession();
      const heard: number[] = [];
      session.setAudioSink!(async (played) => {
        heard.push(played.audio[0]!);
      });
      await session.writeTokens!('Hi.');
      const aSink = a.setAudioSink.mock.calls[0]![0];
      await aSink(chunk(1));
      expect(heard).toEqual([1]);
      // Out of use from the moment of its failure, though the switch takes it out of use in a later promise job: the
      // backup repeats the text, so its chunk would play twice.
      a.emit('error', new Error('socket hang up'));
      await expect(aSink(chunk(2))).rejects.toThrow('stale synthesis');
      expect(heard).toEqual([1]);
      await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
      const bSink = b.setAudioSink.mock.calls[0]![0];
      await bSink(chunk(3));
      await expect(aSink(chunk(4))).rejects.toThrow('stale synthesis');
      expect(heard).toEqual([1, 3]);
      session.cancel();
      await expect(bSink(chunk(5))).rejects.toThrow('stale synthesis');
      expect(heard).toEqual([1, 3]);
    });
  });

  describe('a backup refused or failed in the switch window', () => {
    it("takes a replay write a cancel() cut and that rejects as the cut's: the backup takes the next request's text and is not passed over", async () => {
      const b = pullSession();
      let refuse: () => void = () => {};
      b.writeTokens.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        refuse = () => reject(new Error('request cancelled'));
      }));
      const c = pullSession();
      const f = await switchingFacade(b, c);
      await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
      f.session.cancel();
      f.session.pushTokens('Next one.');
      refuse();
      await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
      expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
      expect(b.writeTokens.mock.calls).toEqual([['Hello world.'], ['Next one.']]);
      expect(f.third.startSession).not.toHaveBeenCalled();
      expect(f.breaker.isAvailable('b')).toBe(true);
    });

    it("restarts the replay on the next request's text when a cancel() cuts a replay write that never settles: the switch ends and later writes go to the backup", async () => {
      const b = pullSession();
      b.writeTokens.mockImplementationOnce(parked);
      const c = pullSession();
      const f = await switchingFacade(b, c);
      await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
      f.session.cancel();
      f.session.pushTokens('Next one.');
      await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
      expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'b' });
      expect(await settled(f.session.writeTokens!(' More.'))).toBe('settled');
      expect(b.writeTokens.mock.calls).toEqual([['Hello world.'], ['Next one.'], [' More.']]);
      expect(f.third.startSession).not.toHaveBeenCalled();
      expect(f.breaker.isAvailable('b')).toBe(true);
      expect(f.errors).not.toHaveBeenCalled();
    });

    it('resolves a writeTokens() a cancel() cuts on a healthy session whose write never settles, and the next write goes to that session', async () => {
      const a = pullSession();
      a.writeTokens.mockImplementationOnce(parked);
      const b = pullSession();
      const second = provider('b', 20, b);
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, second.tts], { enableMidSynthesisFailover: true });
      const session = await chain.startSession();
      session.setAudioSink!(async () => {});
      const write = session.writeTokens!('old');
      await vi.waitFor(() => expect(a.writeTokens).toHaveBeenCalledOnce());
      session.cancel();
      expect(await settled(write)).toBe('settled');
      expect(await settled(session.writeTokens!('new'))).toBe('settled');
      expect(a.writeTokens.mock.calls).toEqual([['old'], ['new']]);
      expect(second.startSession).not.toHaveBeenCalled();
    });

    it('takes an error of a backup attached after the cut as its own: it is passed over', async () => {
      const b = pullSession();
      let release: () => void = () => {};
      b.writeTokens
        .mockImplementationOnce(() => new Promise<void>((resolve) => {
          release = resolve;
        }))
        .mockRejectedValueOnce(new Error('socket closed'));
      const c = pullSession();
      c.writeTokens.mockImplementation(async () => {
        c.emit('error', new Error('socket hang up'));
      });
      const f = await switchingFacade(b, c);
      await vi.waitFor(() => expect(b.writeTokens).toHaveBeenCalledWith('Hello world.'));
      f.session.cancel();
      f.session.pushTokens('Next one.');
      release();
      await vi.waitFor(() => expect(f.errors).toHaveBeenCalledOnce());
      expect(c.writeTokens.mock.calls).toEqual([['Next one.']]);
      expect(c.close).toHaveBeenCalled();
      expect(f.breaker.isAvailable('c')).toBe(false);
      expect(f.failover).not.toHaveBeenCalled();
    });

    it('passes over a backup that throws on text pushed after it took the replay, before the switch has ended: the next provider takes all of it', async () => {
      const a = pushSession();
      const b = pushSession();
      const c = pushSession();
      const failover = vi.fn();
      const chain = new StreamingTTSChain([provider('a', 10, a).tts, provider('b', 20, b).tts, provider('c', 30, c).tts], { enableMidSynthesisFailover: true, onProviderFailover: failover });
      const session = await chain.startSession();
      session.pushTokens('One.');
      b.pushTokens
        .mockImplementationOnce(() => {
          queueMicrotask(() => session.pushTokens(' Two.'));
        })
        .mockImplementationOnce(() => {
          throw new Error('socket closed');
        });
      a.emit('error', new Error('socket hang up'));
      await session.flush();
      expect(failover.mock.calls.map(([event]) => `${event.from}>${event.to}`)).toEqual(['a>b', 'b>c']);
      expect(c.pushTokens.mock.calls).toEqual([['One.'], [' Two.']]);
      expect(c.flush).toHaveBeenCalledOnce();
    });
  });
});

describe('StreamingTTSChain: warnings of the provider session in use', () => {
  /** A provider whose sessions are kept as they open. */
  function recording(id: string, priority: number) {
    const sessions: Array<ReturnType<typeof mkSession>> = [];
    const tts = {
      providerId: id,
      priority,
      capabilities: defaultCapabilities({ streaming: true }),
      async startSession() {
        const session = mkSession(id);
        sessions.push(session);
        return session;
      },
      async healthCheck() {
        return { ok: true };
      },
    } as IStreamingTTS & HealthyProvider;
    return { tts, sessions };
  }

  it('carries a warning of the session in use to the facade whole, and none of a session the facade moved off', async () => {
    const a = recording('a', 10);
    const b = recording('b', 20);
    const failover = vi.fn();
    const facade = await new StreamingTTSChain([a.tts, b.tts], { enableMidSynthesisFailover: true, onProviderFailover: failover }).startSession();
    const warnings: Error[] = [];
    facade.on('warning', (warning: Error) => warnings.push(warning));
    const first = a.sessions[0]! as unknown as EventEmitter;
    const refused = new Error('a ws failed to open for a reply (HTTP 400); the reply ends unplayed');
    first.emit('warning', refused);
    expect(warnings).toEqual([refused]);

    // The session in use fails and the backup takes over: what the failed session reports afterwards is not the facade's.
    facade.pushTokens('Hello world.');
    first.emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    first.emit('warning', new Error('a late warning'));
    (b.sessions[0]! as unknown as EventEmitter).emit('warning', new Error('b segment spoken again'));
    expect(warnings.map((warning) => warning.message)).toEqual([refused.message, 'b segment spoken again']);
    facade.close();
  });

  it('carries a warning as Error(provider warning) under a ProviderPolicy, without the provider text, and prints one nobody listens for only under the legacy policy', async () => {
    const identity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } };
    const a = recording('a', 10);
    const policy: ProviderPolicy = {
      mode: 'hosted',
      fallback: 'none',
      identity,
      purposes: ['tts'],
      providers: [{ providerId: 'a', locality: 'remote', purposes: ['tts'], priceVersion: 'rate-a' }],
      authorize: vi.fn(async () => {}),
      onFallback: vi.fn(),
    };
    const strict = await new StreamingTTSChain([a.tts], { enableMidSynthesisFailover: true, policy }).startSession();
    const warnings: Error[] = [];
    strict.on('warning', (warning: Error) => warnings.push(warning));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (a.sessions[0]! as unknown as EventEmitter).emit('warning', new Error('a ws rejected: HTTP 400: {"err_msg":"voice not found"}'));
      expect(warnings.map((warning) => warning.message)).toEqual(['provider warning']);
      // Nobody listens on the strict facade: nothing is printed.
      strict.removeAllListeners('warning');
      (a.sessions[0]! as unknown as EventEmitter).emit('warning', new Error('a ws rejected: HTTP 400'));
      expect(warn).not.toHaveBeenCalled();

      // Nobody listens on the legacy facade: one line names the provider and the warning, as the provider would.
      const legacy = recording('b', 10);
      const facade = await new StreamingTTSChain([legacy.tts], { enableMidSynthesisFailover: true }).startSession();
      (legacy.sessions[0]! as unknown as EventEmitter).emit('warning', new Error('b ws failed to open for a reply'));
      expect(warn.mock.calls).toEqual([['[b] b ws failed to open for a reply']]);
      facade.close();
    } finally {
      warn.mockRestore();
      strict.close();
    }
  });
});
