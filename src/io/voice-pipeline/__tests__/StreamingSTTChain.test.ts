import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StreamingSTTChain, type ProviderFailoverEvent } from '../providers/StreamingSTTChain.js';
import { defaultCapabilities } from '../HealthyProvider.js';
import type {
  AudioFrame,
  AudioIdentity,
  IStreamingSTT,
  ScopedAudioFrame,
  ScopedStreamingSTTSession,
  StreamingSTTSession,
  TranscriptEvent,
} from '../types.js';
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

  it('keeps two providers with the same providerId apart in its breaker and its events', async () => {
    const { CircuitBreaker } = await import('../CircuitBreaker.js');
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    // Two sizes of one on-device model: the larger cannot load here, the smaller can.
    const larger = mkFakeProvider({ id: 'device', startBehavior: 'fail', failMessage: 'out of memory', priority: 10 });
    const smaller = mkFakeProvider({ id: 'device', startBehavior: 'success', priority: 20 });
    const startLarger = vi.spyOn(larger, 'startSession');
    const failed = vi.fn();
    const selected = vi.fn();
    const chain = new StreamingSTTChain([larger, smaller], {
      breaker,
      onProviderFailed: failed,
      onProviderSelected: selected,
    });
    await chain.startSession();
    await chain.startSession();
    expect(startLarger).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls.map(([event]) => event.providerId)).toEqual(['device#1']);
    expect(selected.mock.calls.map(([event]) => event.providerId)).toEqual(['device#2', 'device#2']);
    expect(breaker.isAvailable('device#1')).toBe(false);
    expect(breaker.isAvailable('device#2')).toBe(true);
    expect(chain.currentProviderId).toBe('device');
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

  it('flush drains the active provider session', async () => {
    const inner = Object.assign(new EventEmitter(), { pushAudio: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), close: vi.fn() }) as unknown as StreamingSTTSession;
    const provider: IStreamingSTT & HealthyProvider = {
      providerId: 'flushing',
      priority: 10,
      capabilities: defaultCapabilities({ languages: ['en'] }),
      isStreaming: true,
      async startSession() {
        return inner;
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    const chain = new StreamingSTTChain([provider], { enableMidUtteranceFailover: true });
    const session = await chain.startSession();
    await session.flush();
    expect(inner.flush).toHaveBeenCalledTimes(1);
  });

  it('starts no backup when the provider ends its stream after a flush', async () => {
    const sessionA = mkClosingSession('a');
    const startB = vi.fn(async () => mkClosingSession('b'));
    const failover = vi.fn();
    const chain = new StreamingSTTChain(
      [mkProvider('a', 10, async () => sessionA), mkProvider('b', 20, startB)],
      { enableMidUtteranceFailover: true, onProviderFailover: failover }
    );
    const session = await chain.startSession();

    await session.flush();
    sessionA.emit('close'); // the provider sends its last final and closes, as the session contract has it
    await settle();

    expect(startB).not.toHaveBeenCalled();
    expect(failover).not.toHaveBeenCalled();
    expect(chain.currentProviderId).toBe('a');
  });

  it('forwards a flushed provider close once and ignores audio after terminal close', async () => {
    const sessionA = mkClosingSession('a');
    const startB = vi.fn(async () => mkClosingSession('b'));
    const chain = new StreamingSTTChain(
      [mkProvider('a', 10, async () => sessionA), mkProvider('b', 20, startB)],
      { enableMidUtteranceFailover: true }
    );
    const session = await chain.startSession();
    const closed = vi.fn();
    const errors = vi.fn();
    session.on('close', closed);
    session.on('error', errors);
    await session.flush();
    sessionA.emit('close');
    sessionA.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
    await session.pushAudio({ samples: new Float32Array(320), sampleRate: 16_000, timestamp: 0 });
    await session.flush();
    await session.close();
    sessionA.emit('error', new Error('late error'));
    await settle();
    expect(sessionA.pushAudio).not.toHaveBeenCalled();
    expect(sessionA.close).not.toHaveBeenCalled();
    expect(startB).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('StreamingSTTChain: the mid-utterance failover facade', () => {
  /** A provider whose sessions record the frames pushed into them, for a test to drive. */
  function recordingProvider(id: string, priority: number) {
    const sessions: Array<StreamingSTTSession & { pushed: AudioFrame[] }> = [];
    const provider: IStreamingSTT & HealthyProvider = {
      providerId: id,
      priority,
      capabilities: defaultCapabilities({ languages: ['en'] }),
      isStreaming: false,
      async startSession() {
        const pushed: AudioFrame[] = [];
        const session = Object.assign(new EventEmitter(), {
          pushed,
          pushAudio(frame: AudioFrame) {
            pushed.push(frame);
          },
          async flush() {},
          // As a real session does, it emits 'close' when closed.
          close(this: EventEmitter) {
            this.emit('close');
          },
        }) as unknown as StreamingSTTSession & { pushed: AudioFrame[] };
        sessions.push(session);
        return session;
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    return { provider, sessions };
  }

  /** Half a second of 16 kHz audio, over the facade's 400 ms replay floor. */
  function halfSecond(): AudioFrame {
    return { samples: new Float32Array(8_000), sampleRate: 16_000, timestamp: Date.now() };
  }

  /**
   * A provider whose sessions, as the Moonshine browser provider's do, retract the interim text of a line still open
   * with an empty final when they close, before their 'close'. `show()` emits an interim line and keeps it open.
   */
  function retractingProvider(id: string, priority: number) {
    const sessions: Array<StreamingSTTSession & { show(event: TranscriptEvent): void }> = [];
    const provider: IStreamingSTT & HealthyProvider = {
      providerId: id,
      priority,
      capabilities: defaultCapabilities({ languages: ['en'] }),
      isStreaming: true,
      async startSession() {
        const emitter = new EventEmitter();
        let open: TranscriptEvent | undefined;
        const session = Object.assign(emitter, {
          show(event: TranscriptEvent) {
            open = event;
            emitter.emit('transcript', event);
          },
          pushAudio() {},
          async flush() {},
          close() {
            const line = open;
            open = undefined;
            if (line) emitter.emit('transcript', { ...line, text: '', words: [], isFinal: true });
            emitter.emit('close');
          },
        }) as unknown as StreamingSTTSession & { show(event: TranscriptEvent): void };
        sessions.push(session);
        return session;
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    return { provider, sessions };
  }

  /** A line of a session's own, from the start of its audio to `endMs`. */
  function lineEvent(itemId: string, text: string, endMs: number, isFinal = false): TranscriptEvent {
    return { text, confidence: 1, words: [], isFinal, itemId, startMs: 0, endMs };
  }

  /** What a facade emits, in order: each transcript as `interim|final <itemId> <text>`, then 'error' and 'close'. */
  function watch(facade: StreamingSTTSession): string[] {
    const seen: string[] = [];
    facade.on('transcript', (event: TranscriptEvent) =>
      seen.push(`${event.isFinal ? 'final' : 'interim'} ${event.itemId} ${event.text}`)
    );
    facade.on('error', () => seen.push('error'));
    facade.on('close', () => seen.push('close'));
    return seen;
  }

  it('forwards transcripts and speech events from the active session', async () => {
    const a = recordingProvider('a', 10);
    const chain = new StreamingSTTChain([a.provider], { enableMidUtteranceFailover: true });
    const facade = await chain.startSession();
    const seen: string[] = [];
    facade.on('speech_start', () => seen.push('speech_start'));
    facade.on('transcript', (event: TranscriptEvent) => seen.push(`transcript ${event.text}`));
    facade.on('speech_end', () => seen.push('speech_end'));
    a.sessions[0].emit('speech_start');
    a.sessions[0].emit('transcript', { text: 'hello', confidence: 1, words: [], isFinal: true });
    a.sessions[0].emit('speech_end');
    expect(seen).toEqual(['speech_start', 'transcript hello', 'speech_end']);
  });

  it('moves to the next provider when the active session fails, replaying the buffered audio', async () => {
    const a = recordingProvider('a', 10);
    const b = recordingProvider('b', 20);
    const failover = vi.fn();
    const chain = new StreamingSTTChain([a.provider, b.provider], {
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    const frame = halfSecond();
    await facade.pushAudio(frame);
    a.sessions[0].emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    expect(failover.mock.calls[0][0]).toMatchObject({ kind: 'stt', from: 'a', to: 'b', reason: 'network' });
    expect(b.sessions).toHaveLength(1);
    expect(b.sessions[0].pushed).toEqual([frame]);
    expect(chain.currentProviderId).toBe('b');
  });

  it('emits error on the facade once no backup is left', async () => {
    const a = recordingProvider('a', 10);
    const chain = new StreamingSTTChain([a.provider], { enableMidUtteranceFailover: true });
    const facade = await chain.startSession();
    const errors: Error[] = [];
    facade.on('error', (err: Error) => errors.push(err));
    a.sessions[0].emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].name).toBe('AggregateVoiceError');
  });

  it('flushes the active session', async () => {
    const a = recordingProvider('a', 10);
    const chain = new StreamingSTTChain([a.provider], { enableMidUtteranceFailover: true });
    const facade = await chain.startSession();
    const flush = vi.spyOn(a.sessions[0], 'flush');
    await facade.flush();
    expect(flush).toHaveBeenCalledOnce();
  });

  it('closes the active session when asked, opening no backup, and emits close once', async () => {
    const a = recordingProvider('a', 10);
    const b = recordingProvider('b', 20);
    const failover = vi.fn();
    const chain = new StreamingSTTChain([a.provider, b.provider], {
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    const closed = vi.fn();
    facade.on('close', closed);
    await facade.close();
    await facade.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(b.sessions).toHaveLength(0);
    expect(failover).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("passes on the empty final a session emits as the caller closes it, before the facade's close", async () => {
    const a = retractingProvider('a', 10);
    const chain = new StreamingSTTChain([a.provider], { enableMidUtteranceFailover: true });
    const facade = await chain.startSession();
    const seen = watch(facade);
    a.sessions[0].show(lineEvent('1', 'Half a', 300));
    facade.close();
    expect(seen).toEqual(['interim 1 Half a', 'final 1 ', 'close']);
  });

  it('passes on the empty final when a frame over the bound ends the facade: the error, the final, then close', async () => {
    const a = retractingProvider('a', 10);
    const chain = new StreamingSTTChain([a.provider], { enableMidUtteranceFailover: true });
    const facade = await chain.startSession();
    const seen = watch(facade);
    a.sessions[0].show(lineEvent('1', 'Half a', 300));
    // Four seconds of audio, past the default 3000 ms bound.
    await facade.pushAudio({ samples: new Float32Array(64_000), sampleRate: 16_000, timestamp: 0 });
    expect(seen).toEqual(['interim 1 Half a', 'error', 'final 1 ', 'close']);
  });

  it('passes on the empty final a failed session emits as the facade switches away from it', async () => {
    const a = retractingProvider('a', 10);
    const b = retractingProvider('b', 20);
    const failover = vi.fn();
    const chain = new StreamingSTTChain([a.provider, b.provider], {
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    const seen = watch(facade);
    a.sessions[0].show(lineEvent('1', 'Half a', 300));
    a.sessions[0].emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    expect(seen).toEqual(['interim 1 Half a', 'final 1 ']);
  });

  it("passes on a backup's empty final at close though the failed provider gave a final over the same audio", async () => {
    const a = retractingProvider('a', 10);
    const b = retractingProvider('b', 20);
    const failover = vi.fn();
    const chain = new StreamingSTTChain([a.provider, b.provider], {
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    const seen = watch(facade);
    a.sessions[0].emit('transcript', lineEvent('1', 'Hello there.', 800, true));
    a.sessions[0].emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    b.sessions[0].show(lineEvent('7', 'Hello', 400));
    facade.close();
    expect(seen).toEqual(['final 1 Hello there.', 'interim 7 Hello', 'final 7 ', 'close']);
  });

  it("drops a backup's repeat of a final when both providers have the same providerId", async () => {
    const a = recordingProvider('device', 10);
    const b = recordingProvider('device', 20);
    const failover = vi.fn();
    const chain = new StreamingSTTChain([a.provider, b.provider], {
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    const finals: string[] = [];
    facade.on('transcript', (event: TranscriptEvent) => finals.push(event.text));
    await facade.pushAudio(halfSecond());
    const said = lineEvent('1', 'Hello there.', 500, true);
    a.sessions[0].emit('transcript', said);
    a.sessions[0].emit('error', new Error('socket hang up'));
    await vi.waitFor(() => expect(failover).toHaveBeenCalledOnce());
    expect(failover.mock.calls[0][0]).toMatchObject({ from: 'device#1', to: 'device#2' });
    // The backup transcribes the replayed audio again.
    b.sessions[0].emit('transcript', { ...said, itemId: '9' });
    expect(finals).toEqual(['Hello there.']);
  });
});

describe('StreamingSTTChain: a backup that fails as it takes over', () => {
  /** A session whose methods are spies; `close()` emits 'close', as a real session's does. */
  function spySession() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      pushAudio: vi.fn(async (_frame: AudioFrame): Promise<void> => {}),
      flush: vi.fn(async (): Promise<void> => {}),
      close: vi.fn((): void => {
        emitter.emit('close');
      }),
    });
  }

  /** A provider whose `startSession()` opens `session`. */
  function spyProvider(id: string, priority: number, session: StreamingSTTSession) {
    const startSession = vi.fn(async (): Promise<StreamingSTTSession> => session);
    const stt: IStreamingSTT & HealthyProvider = {
      providerId: id,
      priority,
      capabilities: defaultCapabilities({ languages: ['en'] }),
      isStreaming: true,
      startSession,
      async healthCheck() {
        return { ok: true };
      },
    };
    return { stt, startSession };
  }

  /** Half a second of 16 kHz audio, over the facade's 400 ms replay floor. */
  const halfSecond = (timestamp = 0): AudioFrame => ({ samples: new Float32Array(8_000), sampleRate: 16_000, timestamp });

  /** A facade over `a` and the backups `b` and `c` that has taken half a second of audio; `a` then fails. */
  async function switchingFacade(b: StreamingSTTSession, c: StreamingSTTSession) {
    const { CircuitBreaker } = await import('../CircuitBreaker.js');
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    const a = spySession();
    const third = spyProvider('c', 30, c);
    const failover = vi.fn();
    const errors = vi.fn();
    const chain = new StreamingSTTChain([spyProvider('a', 10, a).stt, spyProvider('b', 20, b).stt, third.stt], {
      breaker,
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    facade.on('error', errors);
    const frame = halfSecond();
    await facade.pushAudio(frame);
    a.emit('error', new Error('socket hang up'));
    return { chain, breaker, failover, errors, third, frame };
  }

  it.each(['error', 'close'] as const)('passes over a backup that reports %s while it takes the replay, for the next provider', async (event) => {
    const b = spySession();
    // The backup's connection fails as it takes the replayed audio; the push itself completes.
    b.pushAudio.mockImplementation(async () => {
      if (event === 'error') b.emit('error', new Error('socket hang up'));
      else b.emit('close');
    });
    const c = spySession();
    const f = await switchingFacade(b, c);
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
    expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
    expect(c.pushAudio).toHaveBeenCalledWith(f.frame);
    expect(f.chain.currentProviderId).toBe('c');
    expect(f.breaker.isAvailable('b')).toBe(false);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('tries the next provider when a backup refuses a replayed frame', async () => {
    const b = spySession();
    b.pushAudio.mockRejectedValue(new Error('socket closed'));
    const c = spySession();
    const f = await switchingFacade(b, c);
    await vi.waitFor(() => expect(f.third.startSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledOnce());
    expect(f.failover.mock.calls[0]![0]).toMatchObject({ from: 'a', to: 'c' });
    expect(c.pushAudio).toHaveBeenCalledWith(f.frame);
    expect(b.close).toHaveBeenCalled();
    expect(f.breaker.isAvailable('b')).toBe(false);
    expect(f.errors).not.toHaveBeenCalled();
  });

  it('ends a scoped facade at a frame without its identity, with no provider blamed for it or sent it', async () => {
    const { CircuitBreaker } = await import('../CircuitBreaker.js');
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    const scoped = () =>
      Object.assign(spySession(), {
        pushAudioScoped: vi.fn(async (_frame: ScopedAudioFrame): Promise<void> => {}),
        reset: vi.fn(async (_identity: AudioIdentity): Promise<void> => {}),
      });
    const a = scoped();
    const second = spyProvider('b', 20, scoped());
    const chain = new StreamingSTTChain([spyProvider('a', 10, a).stt, second.stt], { breaker, enableMidUtteranceFailover: true });
    const generation = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };
    const identity: AudioIdentity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation };
    const facade = (await chain.startSession({ call: identity })) as ScopedStreamingSTTSession;
    const seen: string[] = [];
    facade.on('error', (error: Error) => seen.push(`error ${error.message}`));
    facade.on('close', () => seen.push('close'));
    await facade.pushAudioScoped({ ...halfSecond(), ...identity, generation, sampleRate: 16_000, channels: 1, sequence: 1 });
    // The legacy entry, with a frame that carries no scope, turn or generation.
    await facade.pushAudio(halfSecond(500));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(second.startSession).not.toHaveBeenCalled();
    expect(breaker.isAvailable('a')).toBe(true);
    expect(seen).toEqual(['error scoped STT input required', 'close']);
    expect(a.pushAudioScoped).toHaveBeenCalledTimes(1);
  });

  /** Changes that leave a scoped frame without a usable identity, each refused before a provider receives it. */
  const malformed: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['a scope id that is undefined', { scopeId: undefined }],
    ['an empty call id', { callId: '' }],
    ['a turn id that is not a string', { turnId: 7 }],
    ['a generation without its transport epoch', { generation: { workerGeneration: 1, inferenceGeneration: 1 } }],
  ];

  it.each(malformed)('ends a scoped facade at a frame with %s, with no provider sent it', async (_label, change) => {
    const { CircuitBreaker } = await import('../CircuitBreaker.js');
    const breaker = new CircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
    const scoped = () =>
      Object.assign(spySession(), {
        pushAudioScoped: vi.fn(async (_frame: ScopedAudioFrame): Promise<void> => {}),
        reset: vi.fn(async (_identity: AudioIdentity): Promise<void> => {}),
      });
    const a = scoped();
    const second = spyProvider('b', 20, scoped());
    const chain = new StreamingSTTChain([spyProvider('a', 10, a).stt, second.stt], { breaker, enableMidUtteranceFailover: true });
    const generation = { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 };
    const identity: AudioIdentity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation };
    const facade = (await chain.startSession({ call: identity })) as ScopedStreamingSTTSession;
    const seen: string[] = [];
    facade.on('error', (error: Error) => seen.push(`error ${error.message}`));
    facade.on('close', () => seen.push('close'));
    const frame: ScopedAudioFrame = { ...halfSecond(), ...identity, generation, sampleRate: 16_000, channels: 1, sequence: 1 };
    await facade.pushAudioScoped(frame);
    // A caller outside the type system: the fields are present, but one of them does not identify the frame.
    await facade.pushAudioScoped({ ...frame, timestamp: 500, sequence: 2, ...change } as unknown as ScopedAudioFrame);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(a.pushAudioScoped).toHaveBeenCalledTimes(1);
    expect(second.startSession).not.toHaveBeenCalled();
    expect(breaker.isAvailable('a')).toBe(true);
    expect(seen).toEqual(['error scoped STT input required', 'close']);
  });

  it.each([
    ['at once', false],
    ['after a timer, as a connection does', true],
  ] as const)('flushes the provider a second switch opened when the backup fails as the first switch ends (the next opens %s)', async (_label, slow) => {
    const a = spySession();
    const b = spySession();
    const c = spySession();
    const third = spyProvider('c', 30, c);
    if (slow) third.startSession.mockImplementation(() => new Promise<StreamingSTTSession>((resolve) => setTimeout(() => resolve(c), 0)));
    const failover = vi.fn((event: ProviderFailoverEvent): void => {
      // The backup's connection drops as the switch to it is reported, before that switch has ended.
      if (event.to === 'b') b.emit('error', new Error('socket hang up'));
    });
    const chain = new StreamingSTTChain([spyProvider('a', 10, a).stt, spyProvider('b', 20, b).stt, third.stt], {
      enableMidUtteranceFailover: true,
      onProviderFailover: failover,
    });
    const facade = await chain.startSession();
    const errors = vi.fn();
    facade.on('error', errors);
    const frame = halfSecond();
    await facade.pushAudio(frame);
    a.emit('error', new Error('socket hang up'));
    // The flush waits on the switch to b, which ends by starting the switch to c.
    await facade.flush();
    expect(failover.mock.calls.map(([event]) => `${event.from}>${event.to}`)).toEqual(['a>b', 'b>c']);
    expect(c.pushAudio).toHaveBeenCalledWith(frame);
    expect(c.flush).toHaveBeenCalledOnce();
    expect(b.flush).not.toHaveBeenCalled();
    expect(chain.currentProviderId).toBe('c');
    expect(errors).not.toHaveBeenCalled();
  });
});
