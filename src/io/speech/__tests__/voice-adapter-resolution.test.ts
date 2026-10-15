import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SpeechProviderResolver } from '../SpeechProviderResolver.js';
import { ExtensionManager } from '../../../extensions/ExtensionManager.js';
import { VoiceAdapterManifestSchema, VoiceAdapterRuntime, type ScopedVoiceAdapter } from '../VoiceAdapter.js';
import { scopeFixture } from '../../voice-platform/__tests__/VoiceScopeContext.test.js';
import { CountingAttemptBudget } from '../../../safety/runtime/ModelAttemptBudget.js';
import { captureVoiceScope } from '../../voice-platform/VoiceScopeContext.js';
import { defaultCapabilities } from '../../voice-pipeline/HealthyProvider.js';
const manifest = VoiceAdapterManifestSchema.parse({ providerId: 'stt', locality: 'local', modelId: 'model-a', modelRevision: 'weights-a', languages: ['en'],
  sampleRates: [16000], codecs: ['pcm_f32le'], voices: [], streaming: true, scoped: true, boundedRequests: true, cancellation: 'native_abort', usage: true, awaitedOutput: false, conformanceRef: 'fixture-a' });
/** Typed scoped descriptor fixture; provider construction itself makes no request. */
export function sttDescriptor(): ScopedVoiceAdapter<'streaming-stt'> {
  return { voiceAdapterVersion: 1, kind: 'streaming-stt', manifest, options: z.strictObject({}), create: vi.fn(async () => ({
    value: { providerId: 'stt', isStreaming: true, priority: 0, capabilities: defaultCapabilities(), healthCheck: async () => ({ ok: true }), startSession: async () => Object.assign(new EventEmitter(), { pushAudio: () => {}, pushAudioScoped: async () => {}, flush: async () => {}, reset: async () => {}, close: () => {} }) },
    fence: async () => ({ stopped: true as const, evidenceRef: 'stt-stopped' }), dispose: async () => {} })) };
}
describe('typed voice extension factories', () => {
  it('discovers typed payloads without replacing legacy batch registrations', async () => {
    const manager = new ExtensionManager(); const adapter = sttDescriptor();
    await manager.loadPackFromFactory({ name: 'fixture-voice', descriptors: [{ id: 'stt', kind: 'streaming-stt-provider', payload: adapter }] });
    expect(manager.getVoiceAdapters()).toHaveLength(1);
    const resolver = new SpeechProviderResolver(undefined, {}); resolver.registerVoiceAdapter(adapter);
    expect(resolver.listProviders('stt')).toEqual([]); expect(() => resolver.resolveSTT({ streaming: true })).toThrow();
    expect(adapter.create).not.toHaveBeenCalled(); await manager.shutdown();
  });
  it('rejects batch masquerading as streaming and unknown option keys before opening', () => {
    const resolver = new SpeechProviderResolver(undefined, {}); const adapter = sttDescriptor();
    expect(() => resolver.registerVoiceAdapter({ ...adapter, manifest: { ...adapter.manifest, streaming: false } })).toThrow('streaming');
    expect(() => resolver.registerVoiceAdapter({ ...adapter, voiceAdapterVersion: 2 } as never)).toThrow();
    expect(adapter.create).not.toHaveBeenCalled();
  });
  it('authorizes every actual request, records known usage, fences cancellation and rejects foreign identity', async () => {
    const scope = scopeFixture(); const budget = new CountingAttemptBudget({ maxAttempts: 1, perAttempt: { request: 1 } }); const record = vi.spyOn(budget, 'record');
    const runtime = new VoiceAdapterRuntime(scope, 'stt', 'stt', budget);
    const work = vi.fn(async () => ({ value: 'ok', usage: { request: 1 }, final: true })); const fence = vi.fn(async () => ({ stopped: true as const, evidenceRef: 'stopped' }));
    expect(await runtime.run(scope.policy.identity, 'initial', work, fence)).toBe('ok'); expect(record).toHaveBeenCalledWith('local_1', { request: 1 }, true);
    await expect(runtime.run(scope.policy.identity, 'retry', work, fence)).rejects.toThrow('attempt'); expect(work).toHaveBeenCalledOnce();
    await expect(runtime.run({ ...scope.policy.identity, scopeId: 'foreign' }, 'initial', work, fence)).rejects.toThrow('scope');
  });
  it('checks fixed-origin hosted egress and refuses any requested path escaping it', async () => {
    const base = scopeFixture(); const scope = captureVoiceScope({ ...base, policy: { ...base.policy, mode: 'hosted' } });
    const runtime = new VoiceAdapterRuntime(scope, 'stt', 'stt', new CountingAttemptBudget({ maxAttempts: 2, perAttempt: { request: 1 } }), { origin: 'https://speech.example.test', lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    const fence = async () => ({ stopped: true as const, evidenceRef: 'fixture-stopped' });
    await expect(runtime.run(scope.policy.identity, 'initial', async (request) => { await request.request('/v1/recognize', '{}'); return { value: '', usage: {}, final: false }; }, fence)).rejects.toThrow('egress');
    await expect(runtime.run(scope.policy.identity, 'retry', async (request) => { await request.request('//foreign.test/path', '{}'); return { value: '', usage: {}, final: false }; }, fence)).rejects.toThrow('path');
  });
});
