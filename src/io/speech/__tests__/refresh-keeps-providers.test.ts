import { describe, it, expect, vi } from 'vitest';
import { ExtensionManager } from '../../../extensions/ExtensionManager.js';
import { EXTENSION_KIND_STT_PROVIDER, EXTENSION_KIND_TTS_PROVIDER } from '../../../extensions/types.js';
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

  it('registers a pack provider under its own id, the one preferred lists name', async () => {
    const manager = new ExtensionManager();
    const tts = { id: 'pack-tts', getProviderName: () => 'Pack TTS', synthesize: vi.fn() };
    await manager
      .getRegistry(EXTENSION_KIND_TTS_PROVIDER)
      .register({ id: 'pack-tts-descriptor', kind: EXTENSION_KIND_TTS_PROVIDER, payload: tts });
    const resolver = new SpeechProviderResolver(undefined, {});

    await resolver.refresh(manager);

    expect(resolver.resolveTTS({ preferredIds: ['pack-tts'] })).toBe(tts);
  });

  it('resolves a pack provider under a catalog id although the resolver has no key for it', async () => {
    const manager = new ExtensionManager();
    // The pack built this instance with its own key; ELEVENLABS_API_KEY is not in the env below.
    const tts = { id: 'elevenlabs', getProviderName: () => 'ElevenLabs', synthesize: vi.fn() };
    await manager
      .getRegistry(EXTENSION_KIND_TTS_PROVIDER)
      .register({ id: 'elevenlabs', kind: EXTENSION_KIND_TTS_PROVIDER, payload: tts });
    const resolver = new SpeechProviderResolver(undefined, {});

    await resolver.refresh(manager);

    expect(resolver.resolveTTS()).toBe(tts);
  });

  it('stops resolving a pack provider once the manager no longer lists it', async () => {
    const manager = new ExtensionManager();
    const registry = manager.getRegistry(EXTENSION_KIND_STT_PROVIDER);
    const stt = { id: 'pack-stt', getProviderName: () => 'Pack STT', transcribe: vi.fn() };
    await registry.register({ id: 'pack-stt', kind: EXTENSION_KIND_STT_PROVIDER, payload: stt });
    const resolver = new SpeechProviderResolver(undefined, {});
    await resolver.refresh(manager);
    expect(resolver.resolveSTT()).toBe(stt);

    await registry.unregister('pack-stt');
    await resolver.refresh(manager);

    expect(resolver.listProviders('stt').some((r) => r.id === 'pack-stt')).toBe(false);
    expect(() => resolver.resolveSTT()).toThrow('No configured STT provider matches requirements');
  });

  it('keeps a speech-to-text and a text-to-speech provider that share an id', async () => {
    const manager = new ExtensionManager();
    const stt = { id: 'acme', getProviderName: () => 'Acme', transcribe: vi.fn() };
    const tts = { id: 'acme', getProviderName: () => 'Acme', synthesize: vi.fn() };
    await manager
      .getRegistry(EXTENSION_KIND_STT_PROVIDER)
      .register({ id: 'acme', kind: EXTENSION_KIND_STT_PROVIDER, payload: stt });
    await manager
      .getRegistry(EXTENSION_KIND_TTS_PROVIDER)
      .register({ id: 'acme', kind: EXTENSION_KIND_TTS_PROVIDER, payload: tts });
    const resolver = new SpeechProviderResolver(undefined, {});

    await resolver.refresh(manager);

    expect(resolver.resolveSTT()).toBe(stt);
    expect(resolver.resolveTTS()).toBe(tts);
  });

  it('keeps the registered priority when a boosted provider is registered again', async () => {
    const config = { tts: { preferred: ['openai-tts'] } };
    const resolver = new SpeechProviderResolver(config, { OPENAI_API_KEY: 'test-key' });
    await resolver.refresh();
    const entry = resolver.listProviders('tts').find((r) => r.id === 'openai-tts')!;
    expect(entry.priority).toBe(50);
    resolver.register({ ...entry, provider: { id: 'openai-tts', synthesize: vi.fn() } as any });

    config.tts.preferred = [];
    await resolver.refresh();

    expect(resolver.listProviders('tts').find((r) => r.id === 'openai-tts')?.priority).toBe(100);
  });

  it("matches a streaming requirement against a pack provider's own supportsStreaming", async () => {
    const manager = new ExtensionManager();
    // The catalog lists AssemblyAI as streaming; this pack's provider does not stream.
    const stt = { id: 'assemblyai', supportsStreaming: false, getProviderName: () => 'Pack', transcribe: vi.fn() };
    await manager
      .getRegistry(EXTENSION_KIND_STT_PROVIDER)
      .register({ id: 'assemblyai', kind: EXTENSION_KIND_STT_PROVIDER, payload: stt });
    const resolver = new SpeechProviderResolver(undefined, {});

    await resolver.refresh(manager);

    expect(resolver.resolveSTT({ streaming: false })).toBe(stt);
    expect(() => resolver.resolveSTT({ streaming: true })).toThrow('No configured STT provider matches requirements');
  });
});
