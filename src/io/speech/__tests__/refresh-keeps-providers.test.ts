import { describe, it, expect, vi } from 'vitest';
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
});
