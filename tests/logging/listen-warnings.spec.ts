/**
 * Optional fixed-word warnings preserve hearing and ordinary legacy diagnostics.
 *
 * @module
 */
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { startListenSession } from '../../src/io/voice-pipeline/ListenSession.js';
import { StreamingSTTChain } from '../../src/io/voice-pipeline/providers/StreamingSTTChain.js';
import { PRIVATE, Sink, final, hostile, provider, transport } from './voice-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); });

it.each(['direct', 'reconnect', 'chain'] as const)('reports only fixed warning words through %s and still writes turns', async (mode) => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const source = provider();
  const sink = new Sink();
  const warnings: string[] = [];
  const options = {
    streamingSTT: mode === 'chain' ? new StreamingSTTChain([source.peer], { enableMidUtteranceFailover: true }) : source.peer,
    runId: 'fixture-run', reconnect: mode === 'reconnect', drainMs: 0,
    /** The callback gets no original argument even when it throws. */
    onWarning(kind: string): void { warnings.push(kind); if (kind === 'speaker_failed') throw new Error(PRIVATE); },
    /** Speaker failure must not discard the turn. */
    speaker(): string { throw hostile(); },
  };
  const session = await startListenSession(transport(), sink, options);
  try {
    expect(() => source.sessions[0].emit('warning', hostile())).not.toThrow();
    source.sessions[0].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    expect(sink.turns[0].text).toBe(PRIVATE);
    expect(sink.turns[0].speaker).toBeUndefined();
    expect(session.state).toBe('listening');
    expect(warnings).toEqual(['stt_warning', 'speaker_failed']);
    source.sessions[0].flush = async () => { source.sessions[0].emit('warning', hostile()); };
    await session.close('stopped');
    expect(warnings).toEqual(['stt_warning', 'speaker_failed', 'stt_warning']);
    expect(session.state).toBe('ended');
    expect(native).not.toHaveBeenCalled();
    expect(JSON.stringify(warnings).includes(PRIVATE)).toBe(false);
    if (mode === 'direct') expect(source.sessions[0].listenerCount('warning')).toBe(0);
  } finally { await session.close('purged'); }
});

it('keeps a replacement provider connected to the same callback and ignores post-end warnings', async () => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const source = provider(); const warnings: string[] = []; const sink = new Sink();
  const options = { streamingSTT: source.peer, runId: 'fixture-run', drainMs: 0, onWarning: (kind: string): void => { warnings.push(kind); } };
  const session = await startListenSession(transport(), sink, options);
  try {
    source.sessions[0].emit('error', new Error('fixture reconnect'));
    await vi.waitFor(() => expect(source.sessions).toHaveLength(2));
    source.sessions[1].emit('warning', new Error(PRIVATE));
    source.sessions[1].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    expect(warnings).toEqual(['stt_warning']);
    expect(session.stats().reconnects).toBe(1);
    await session.close('purged');
    source.sessions[1].emit('warning', new Error(PRIVATE));
    expect(warnings).toEqual(['stt_warning']);
    expect(native).not.toHaveBeenCalled();
  } finally { await session.close('purged'); }
});

it('keeps the old no-callback speaker warning and does not install a swallowing STT listener', async () => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const source = provider(); const sink = new Sink();
  const session = await startListenSession(transport(), sink, {
    streamingSTT: source.peer, runId: 'fixture-run', reconnect: false, drainMs: 0,
    speaker: () => { throw new Error('fixed speaker failure'); },
  });
  try {
    expect(source.sessions[0].listenerCount('warning')).toBe(0);
    source.sessions[0].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    expect(native).toHaveBeenCalledWith('[listen-session] the speaker option threw; the turn is written with no speaker:', 'fixed speaker failure');
  } finally { await session.close('purged'); }
});

it('consumes the rejection of an asynchronous callback, so a failing callback cannot end the process', async () => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const escaped = vi.fn();
  process.on('unhandledRejection', escaped);
  const source = provider(); const sink = new Sink(); const warnings: string[] = [];
  const session = await startListenSession(transport(), sink, {
    streamingSTT: source.peer, runId: 'fixture-run', reconnect: false, drainMs: 0,
    /** The void return type admits an async callback, whose failure is a rejected promise rather than a throw. */
    async onWarning(kind: string): Promise<void> { warnings.push(kind); throw new Error(PRIVATE); },
    speaker: () => { throw hostile(); },
  });
  try {
    source.sessions[0].emit('warning', hostile());
    source.sessions[0].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    // Node reports a rejection nothing handles once the microtasks of the turn have run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).toEqual(['stt_warning', 'speaker_failed']);
    expect(escaped).not.toHaveBeenCalled();
    expect(sink.turns[0].speaker).toBeUndefined();
    expect(session.state).toBe('listening');
    expect(native).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', escaped);
    await session.close('purged');
  }
});

/** A rejected promise from another realm, which `instanceof Promise` does not recognize here. */
const foreignRejection = (): unknown => runInNewContext('Promise.reject(new Error(text))', { text: PRIVATE });
/** A thenable that is no native promise: its then settles through the rejected native promise it wraps. */
const thenableRejection = (): unknown => {
  const wrapped = Promise.reject(new Error(PRIVATE));
  return { then: (onFulfilled?: any, onRejected?: any) => wrapped.then(onFulfilled, onRejected) };
};
/** An object whose then getter throws, which await turns into a rejection. */
const throwingThenGetter = (): unknown => Object.defineProperty({}, 'then', { get() { throw new Error(PRIVATE); } });
/** A thenable whose then throws when called, which await also turns into a rejection. */
const throwingThenCall = (): unknown => ({ then(): never { throw new Error(PRIVATE); } });
/** What a callback can return besides a promise of this realm, each rejecting when awaited. */
const rejections: ReadonlyArray<[string, () => unknown]> = [
  ['a promise from another realm', foreignRejection],
  ['a thenable that is no native promise', thenableRejection],
  ['an object whose then getter throws', throwingThenGetter],
  ['a thenable whose then throws', throwingThenCall],
];

it.each(rejections)('consumes the rejection of %s that the callback returns, for both warning words', async (_kind, rejection) => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const escaped = vi.fn();
  process.on('unhandledRejection', escaped);
  const source = provider(); const sink = new Sink(); const warnings: string[] = [];
  const session = await startListenSession(transport(), sink, {
    streamingSTT: source.peer, runId: 'fixture-run', reconnect: false, drainMs: 0,
    /** The void return type admits any value; the rejection of what the callback returns must not reach the process. */
    onWarning: (kind: string): unknown => { warnings.push(kind); return rejection(); },
    speaker: () => { throw hostile(); },
  });
  try {
    source.sessions[0].emit('warning', hostile());
    source.sessions[0].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    // Node reports a rejection nothing handles once the microtasks of the turn have run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).toEqual(['stt_warning', 'speaker_failed']);
    expect(escaped).not.toHaveBeenCalled();
    expect(sink.turns[0].speaker).toBeUndefined();
    expect(session.state).toBe('listening');
    expect(native).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', escaped);
    await session.close('purged');
  }
});

it('reports no warning the then of a returned thenable raises, so the callback gets each warning once and none loops back', async () => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const escaped = vi.fn();
  process.on('unhandledRejection', escaped);
  const source = provider(); const sink = new Sink(); const warnings: string[] = [];
  /** Bounds a loop, so a then run outside the session's guard fails this test instead of starving the event loop. */
  const bound = 25;
  const session = await startListenSession(transport(), sink, {
    streamingSTT: source.peer, runId: 'fixture-run', reconnect: false, drainMs: 0,
    onWarning: (kind: string): unknown => {
      warnings.push(kind);
      return {
        /** Makes the transcriber warn again, then settles as a rejection. */
        then(_onFulfilled?: unknown, onRejected?: (reason: unknown) => unknown): void {
          if (warnings.length < bound) source.sessions[0].emit('warning', hostile());
          onRejected?.(new Error(PRIVATE));
        },
      };
    },
  });
  try {
    source.sessions[0].emit('warning', hostile());
    // A loop through promise jobs runs to the bound before the microtasks of the turn end.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).toEqual(['stt_warning']);
    // A warning after the then has run is unrelated, and reaches the callback once.
    source.sessions[0].emit('warning', hostile());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).toEqual(['stt_warning', 'stt_warning']);
    source.sessions[0].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    expect(session.state).toBe('listening');
    expect(escaped).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', escaped);
    await session.close('purged');
  }
});

it.each(['returns', 'throws'] as const)('reports no warning raised while the callback runs, so a callback that makes the transcriber warn again and %s gets each warning once', async (ending) => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const source = provider(); const sink = new Sink(); const warnings: string[] = [];
  /** Bounds the recursion, so a callback run outside the session's guard fails this test instead of overflowing the stack. */
  const bound = 25;
  const session = await startListenSession(transport(), sink, {
    streamingSTT: source.peer, runId: 'fixture-run', reconnect: false, drainMs: 0,
    /** Makes the transcriber warn again before it returns or throws. */
    onWarning: (kind: string): void => {
      warnings.push(kind);
      if (warnings.length < bound) source.sessions[0].emit('warning', hostile());
      if (ending === 'throws') throw new Error(PRIVATE);
    },
  });
  try {
    expect(() => source.sessions[0].emit('warning', hostile())).not.toThrow();
    expect(warnings).toEqual(['stt_warning']);
    // A provider warning after the callback has ended is a new one, and reaches the callback once.
    expect(() => source.sessions[0].emit('warning', hostile())).not.toThrow();
    expect(warnings).toEqual(['stt_warning', 'stt_warning']);
    source.sessions[0].emit('transcript', final());
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    expect(session.state).toBe('listening');
    expect(native).not.toHaveBeenCalled();
  } finally { await session.close('purged'); }
});

it('delivers a speaker_failed raised while an asynchronous callback is still pending, and consumes its later rejection', async () => {
  const native = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const escaped = vi.fn();
  process.on('unhandledRejection', escaped);
  const source = provider(); const sink = new Sink(); const warnings: string[] = [];
  let release: () => void = () => undefined;
  /** Keeps the stt_warning callback's promise pending until the test opens it. */
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = await startListenSession(transport(), sink, {
    streamingSTT: source.peer, runId: 'fixture-run', reconnect: false, drainMs: 0,
    /** Rejects for stt_warning only after the gate opens, so its promise is pending when the speaker fails. */
    async onWarning(kind: string): Promise<void> {
      warnings.push(kind);
      if (kind === 'stt_warning') { await gate; throw new Error(PRIVATE); }
    },
    speaker: () => { throw hostile(); },
  });
  try {
    source.sessions[0].emit('warning', hostile());
    source.sessions[0].emit('transcript', final());
    // The speaker runs as the final is written, before the first callback's promise has settled.
    expect(warnings).toEqual(['stt_warning', 'speaker_failed']);
    release();
    await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
    // Node reports a rejection nothing handles once the microtasks of the turn have run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(escaped).not.toHaveBeenCalled();
    expect(sink.turns[0].speaker).toBeUndefined();
    expect(session.state).toBe('listening');
    expect(native).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', escaped);
    await session.close('purged');
  }
});
