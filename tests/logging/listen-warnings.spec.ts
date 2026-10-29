/**
 * Optional fixed-word warnings preserve hearing and ordinary legacy diagnostics.
 *
 * @module
 */
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
