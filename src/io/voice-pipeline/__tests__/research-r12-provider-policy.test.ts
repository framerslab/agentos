/**
 * Explicit provider policy for the STT and TTS chains: a strict policy opens
 * only the providers it permits, authorizes every opening (an initialization
 * fallback and a mid-session switch among them) before the provider is asked
 * for work, reports a fallback with its scope and tariff version, keeps
 * remote providers out of local mode, and never replays synthesis that has
 * already produced audio. A chain built without a policy keeps its priority
 * order, the call boundary refuses the legacy policy, and the entry parser
 * reads a vendor only from the registry it is given.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { StreamingSTTChain } from '../providers/StreamingSTTChain.js';
import { StreamingTTSChain } from '../providers/StreamingTTSChain.js';
import { defaultCapabilities } from '../HealthyProvider.js';
import { assertCallProviderPolicy, legacyProviderPolicy, type ProviderPolicy } from '../ProviderPolicy.js';
import { parseSttEntry } from '../sttEntries.js';
import { createRegisteredSttChain } from '../env-constructor.js';

const identity = { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-a', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } };

/** A hosted policy over a local provider `a` and a remote provider `b`, with no fallback unless `over` permits one. */
function policy(over: Partial<ProviderPolicy> = {}): ProviderPolicy {
  return {
    mode: 'hosted',
    fallback: 'none',
    identity,
    purposes: ['stt', 'tts'],
    providers: [
      { providerId: 'a', locality: 'local', purposes: ['stt', 'tts'], priceVersion: 'rate-a' },
      { providerId: 'b', locality: 'remote', purposes: ['stt', 'tts'], priceVersion: 'rate-b' },
    ],
    authorize: vi.fn(async () => {}),
    onFallback: vi.fn(),
    ...over,
  };
}

/** Provider `a` (priority 20) and provider `b` (priority 10); each opens one session that serves as STT or TTS. */
function providers() {
  const a = Object.assign(new EventEmitter(), { pushAudio: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(), pushTokens: vi.fn(), cancel: vi.fn() });
  const b = Object.assign(new EventEmitter(), { pushAudio: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(), pushTokens: vi.fn(), cancel: vi.fn() });
  const make = (id: string, inner: typeof a) => ({
    providerId: id,
    isStreaming: true,
    priority: id === 'a' ? 20 : 10,
    capabilities: defaultCapabilities(),
    healthCheck: async () => ({ ok: true }),
    startSession: vi.fn(async () => inner),
  });
  return { a, b, first: make('a', a), second: make('b', b) };
}

describe('explicit provider policy', () => {
  it('does not fall back on init failure, even with a healthy lower-priority remote provider', async () => {
    const f = providers();
    f.first.startSession.mockRejectedValue(new Error('failed'));
    const p = policy();
    await expect(new StreamingSTTChain([f.second, f.first], { policy: p }).startSession()).rejects.toThrow();
    expect(f.second.startSession).not.toHaveBeenCalled();
    expect(p.authorize).toHaveBeenCalledOnce();
    await expect(new StreamingTTSChain([f.second, f.first], { policy: p }).startSession()).rejects.toThrow();
    expect(f.second.startSession).not.toHaveBeenCalled();
  });

  it('authorizes and emits a scoped tariff event before an allowlisted initialization fallback', async () => {
    const f = providers();
    f.first.startSession.mockRejectedValue(new Error('failed'));
    const events: string[] = [];
    const p = policy({
      fallback: 'allowlisted',
      authorize: async (r) => { events.push(`authorize:${r.to}`); },
      onFallback: (e) => { events.push(`fallback:${e.to}:${e.priceVersion}:${e.scopeId}`); },
    });
    f.second.startSession.mockImplementation(async () => {
      events.push('open:b');
      return f.b;
    });
    const session = await new StreamingSTTChain([f.first, f.second], { policy: p }).startSession();
    expect(events).toEqual(['authorize:a', 'authorize:b', 'fallback:b:rate-b:scope-a', 'open:b']);
    session.close();
  });

  it('excludes commercial providers in local mode and refuses budget denial before any request', async () => {
    const f = providers();
    f.first.startSession.mockRejectedValue(new Error('failed'));
    await expect(new StreamingSTTChain([f.first, f.second], { policy: policy({ mode: 'local', fallback: 'allowlisted' }) }).startSession()).rejects.toThrow();
    expect(f.second.startSession).not.toHaveBeenCalled();
    const g = providers();
    await expect(new StreamingTTSChain([g.first, g.second], { policy: policy({ authorize: async () => { throw new Error('no hold'); } }) }).startSession()).rejects.toThrow('authorization refused');
    expect(g.first.startSession).not.toHaveBeenCalled();
    expect(g.second.startSession).not.toHaveBeenCalled();
  });

  it('applies the same allowlist mid-session and preserves flush and one terminal close', async () => {
    const f = providers();
    const p = policy({ fallback: 'allowlisted' });
    const session = await new StreamingSTTChain([f.first, f.second], { policy: p, enableMidUtteranceFailover: true }).startSession();
    session.on('error', () => {});
    f.a.emit('error', new Error('drop'));
    await vi.waitFor(() => expect(f.second.startSession).toHaveBeenCalledOnce());
    await session.flush();
    expect(f.b.flush).toHaveBeenCalledOnce();
    const close = vi.fn();
    session.on('close', close);
    f.b.emit('close');
    expect(close).toHaveBeenCalledOnce();
    session.close();
    expect(close).toHaveBeenCalledOnce();
    expect(p.onFallback).toHaveBeenCalledWith(expect.objectContaining({ from: 'a', to: 'b', reason: 'mid_session_failure', scopeId: 'scope-a' }));
  });

  it('refuses mid-call fallback-none and never replays partially emitted strict synthesis', async () => {
    const f = providers();
    const s = await new StreamingSTTChain([f.first, f.second], { policy: policy(), enableMidUtteranceFailover: true }).startSession();
    const error = vi.fn();
    s.on('error', error);
    f.a.emit('error', new Error('failed'));
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(f.second.startSession).not.toHaveBeenCalled();
    s.close();
    const g = providers();
    const t = await new StreamingTTSChain([g.first, g.second], { policy: policy({ fallback: 'allowlisted' }), enableMidSynthesisFailover: true }).startSession();
    const errors = vi.fn();
    t.on('error', errors);
    t.pushTokens('hello');
    g.a.emit('audio', { audio: Buffer.alloc(640), format: 'pcm', sampleRate: 16000, durationMs: 20, text: 'hello' });
    g.a.emit('error', new Error('failed'));
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
    expect(g.second.startSession).not.toHaveBeenCalled();
    t.close();
  });

  it('keeps legacy priorities, refuses legacy in the call factory, and resolves only registered vendors', async () => {
    const f = providers();
    const chain = new StreamingSTTChain([f.first, f.second]);
    await chain.startSession();
    expect(f.second.startSession).toHaveBeenCalledOnce();
    expect(() => assertCallProviderPolicy(legacyProviderPolicy)).toThrow('legacy');
    expect(parseSttEntry('sherpa-onnx:model-a', ['sherpa-onnx'])).toEqual({ vendor: 'sherpa-onnx', model: 'model-a' });
    expect(() => parseSttEntry('sherpa-onnx:model-a')).toThrow();
    expect(() => parseSttEntry('other:model-a', ['sherpa-onnx'])).toThrow();
    const factory = vi.fn(() => f.first);
    const selected = createRegisteredSttChain(['sherpa-onnx:model-a'], new Map([['sherpa-onnx', factory]]), { policy: policy() });
    await selected.startSession();
    expect(factory).toHaveBeenCalledWith('model-a', 10);
  });
});
