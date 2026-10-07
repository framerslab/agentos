import { describe, it, expect, vi } from 'vitest';
import { ExtensionManager } from '../../../extensions/ExtensionManager.js';
import { EXTENSION_KIND_STT_PROVIDER } from '../../../extensions/types.js';
import { SpeechRuntime } from '../SpeechRuntime.js';
import { SpeechProviderResolver } from '../SpeechProviderResolver.js';

/**
 * `refresh()` registers an entry for every core provider id. An id that already
 * holds a provider instance keeps it, and the resolve methods return only
 * entries that hold one, so a refresh never turns a working runtime into one
 * that resolves `null`.
 */
describe('SpeechProviderResolver.refresh and provider instances', () => {
  it('keeps the providers SpeechRuntime built and registered', async () => {
    const runtime = new SpeechRuntime({ env: { OPENAI_API_KEY: 'test-key' } });
    const stt = runtime.getSTT();
    const tts = runtime.getTTS();
    const vad = runtime.resolver.resolveVAD();
    expect(stt?.id).toBe('openai-whisper');
    expect(tts?.id).toBe('openai-tts');
    expect(vad.id).toBe('agentos-adaptive-vad');

    await runtime.resolver.refresh();

    expect(runtime.getSTT()).toBe(stt);
    expect(runtime.getTTS()).toBe(tts);
    expect(runtime.resolver.resolveVAD()).toBe(vad);
  });

  it('throws instead of resolving an entry that has no instance', async () => {
    const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'test-key' });
    await resolver.refresh();

    // The core entry exists and its key is set, but nothing has built the provider.
    expect(resolver.listProviders('tts').some((r) => r.id === 'openai-tts' && r.isConfigured)).toBe(true);
    expect(() => resolver.resolveTTS()).toThrow('No configured TTS provider matches requirements');
    expect(() => resolver.resolveSTT({ preferredIds: ['openai-whisper'] })).toThrow(
      'No configured STT provider matches requirements',
    );
    expect(() => resolver.resolveVAD()).toThrow('No VAD provider registered');
  });

  it('keeps a provider registered under a core id through a later refresh', async () => {
    const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'test-key' });
    await resolver.refresh();
    const provider = { id: 'openai-tts', synthesize: vi.fn(), getProviderName: () => 'test' };
    const entry = resolver.listProviders('tts').find((r) => r.id === 'openai-tts')!;
    resolver.register({ ...entry, provider: provider as any });

    expect(resolver.resolveTTS()).toBe(provider);
    await resolver.refresh();
    expect(resolver.resolveTTS()).toBe(provider);
  });

  it('registers the speech providers an ExtensionManager loaded from a pack', async () => {
    const manager = new ExtensionManager();
    const stt = { id: 'pack-stt', getProviderName: () => 'Pack STT', transcribe: vi.fn() };
    await manager.loadPackFromFactory(
      {
        name: 'speech-pack',
        version: '1.0.0',
        descriptors: [{ id: 'pack-stt', kind: EXTENSION_KIND_STT_PROVIDER, payload: stt }],
      },
      'speech-pack',
    );
    const resolver = new SpeechProviderResolver(undefined, {});

    await resolver.refresh(manager);

    expect(resolver.listProviders('stt').find((r) => r.id === 'pack-stt')?.source).toBe('extension');
    expect(resolver.resolveSTT()).toBe(stt);
  });

  it('drops the boost of a provider the preferred list no longer names', async () => {
    const config = { stt: { preferred: ['first'] } };
    const resolver = new SpeechProviderResolver(config, {});
    const entry = (id: string) => ({ id, kind: 'stt' as const, label: id, envVars: [], local: false, description: '' });
    const first = { id: 'first', transcribe: vi.fn() };
    const second = { id: 'second', transcribe: vi.fn() };
    resolver.register({ id: 'first', kind: 'stt', provider: first as any, catalogEntry: entry('first'), isConfigured: true, priority: 100, source: 'core' });
    resolver.register({ id: 'second', kind: 'stt', provider: second as any, catalogEntry: entry('second'), isConfigured: true, priority: 100, source: 'core' });

    await resolver.refresh();
    expect(resolver.resolveSTT()).toBe(first);

    config.stt.preferred = ['second'];
    await resolver.refresh();
    expect(resolver.listProviders('stt').find((r) => r.id === 'first')?.priority).toBe(100);
    expect(resolver.resolveSTT()).toBe(second);
  });
});
