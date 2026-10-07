import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpeechProviderResolver } from '../SpeechProviderResolver.js';

/**
 * Integration tests for {@link SpeechProviderResolver} — exercises the full
 * lifecycle of provider registration, env-based configuration, requirement
 * filtering, fallback wrapping, and extension discovery using the real
 * provider catalog (not mocked).
 *
 * These tests complement the unit tests in SpeechProviderResolver.spec.ts
 * by testing against real catalog entries rather than synthetic mocks.
 */
describe('SpeechProviderResolver Integration', () => {
  it('should register core providers and mark them configured based on env vars', async () => {
    const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'test-key' });
    await resolver.refresh();
    const stts = resolver.listProviders('stt');
    // OpenAI Whisper should be configured because OPENAI_API_KEY is set
    expect(stts.some(p => p.id === 'openai-whisper' && p.isConfigured)).toBe(true);
    // Deepgram should NOT be configured because DEEPGRAM_API_KEY is absent
    expect(stts.some(p => p.id === 'deepgram-batch' && !p.isConfigured)).toBe(true);
  });

  it('should resolve the first configured STT provider after refresh', async () => {
    const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'key' });
    await resolver.refresh();
    // Give the core entry an instance (refresh registers core ids without one)
    const regs = resolver.listProviders('stt');
    const whisperReg = regs.find(r => r.id === 'openai-whisper');
    if (whisperReg) {
      (whisperReg as any).provider = {
        id: 'openai-whisper',
        transcribe: vi.fn(),
        getProviderName: () => 'openai',
        supportsStreaming: false,
      };
    }

    const result = resolver.resolveSTT();
    expect(result).toBeDefined();
  });

  it('should respect preferredIds to override default priority ordering', async () => {
    const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'k', DEEPGRAM_API_KEY: 'k' });
    await resolver.refresh();
    // Patch all STT providers with mock instances
    for (const reg of resolver.listProviders('stt')) {
      (reg as any).provider = {
        id: reg.id,
        transcribe: vi.fn(),
        getProviderName: () => reg.id,
        supportsStreaming: false,
      };
    }
    // Explicitly request deepgram-batch first
    const result = resolver.resolveSTT({ preferredIds: ['deepgram-batch'] });
    expect(result.id).toBe('deepgram-batch');
  });

  it('should throw when filtering by streaming requirement excludes all configured providers', async () => {
    const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'k' });
    await resolver.refresh();
    // openai-whisper has streaming: false in the catalog, so no match
    expect(() => resolver.resolveSTT({ streaming: true })).toThrow();
  });

  it('should always resolve the built-in AdaptiveVAD provider', async () => {
    const resolver = new SpeechProviderResolver(undefined, {});
    await resolver.refresh();
    // VAD has no env var requirements, so it's always configured
    const vads = resolver.listProviders('vad');
    expect(vads.length).toBeGreaterThan(0);
    // Patch with a mock for resolution
    (vads[0] as any).provider = {
      id: 'agentos-adaptive-vad',
      processFrame: vi.fn(),
      reset: vi.fn(),
    };
    const vad = resolver.resolveVAD();
    expect(vad.id).toBe('agentos-adaptive-vad');
  });

  it('should return null for wake-word when none is configured', async () => {
    const resolver = new SpeechProviderResolver(undefined, {});
    await resolver.refresh();
    // Wake-word providers require specific env vars that aren't set
    expect(resolver.resolveWakeWord()).toBeNull();
  });

  it('should fall back from a failing first provider to the second in a fallback chain', async () => {
    const resolver = new SpeechProviderResolver(
      { stt: { fallback: true } },
      { OPENAI_API_KEY: 'k', DEEPGRAM_API_KEY: 'k' },
    );
    await resolver.refresh();
    // Patch: first provider (whisper) throws, second (deepgram) succeeds
    const stts = resolver.listProviders('stt');
    for (const reg of stts) {
      if (reg.id === 'openai-whisper') {
        (reg as any).provider = {
          id: 'openai-whisper',
          transcribe: vi.fn().mockRejectedValue(new Error('fail')),
          getProviderName: () => 'openai',
          supportsStreaming: false,
        };
      } else if (reg.id === 'deepgram-batch') {
        (reg as any).provider = {
          id: 'deepgram-batch',
          transcribe: vi.fn().mockResolvedValue({ text: 'hello', cost: 0 }),
          getProviderName: () => 'deepgram',
          supportsStreaming: false,
        };
      }
    }
    const fallbackHandler = vi.fn();
    resolver.on('provider_fallback', fallbackHandler);
    const stt = resolver.resolveSTT();
    const result = await stt.transcribe({ data: Buffer.from([]) });
    // Deepgram's result should be returned after whisper fails
    expect(result.text).toBe('hello');
    // A fallback event should have been emitted
    expect(fallbackHandler).toHaveBeenCalled();
  });

  it('should discover extension providers from an ExtensionManager', async () => {
    const mockEM = {
      getDescriptorsByKind: vi.fn((kind: string) => {
        if (kind === 'stt-provider') {
          return [{
            id: 'ext-custom-stt',
            payload: {
              id: 'ext-custom-stt',
              transcribe: vi.fn(),
              getProviderName: () => 'custom',
            },
          }];
        }
        return [];
      }),
    };
    const resolver = new SpeechProviderResolver(undefined, {});
    await resolver.refresh(mockEM);
    const stts = resolver.listProviders('stt');
    const ext = stts.find(r => r.id === 'ext-custom-stt');
    expect(ext).toBeDefined();
    expect(ext!.source).toBe('extension');
    // Extensions default to priority 200 (below core's 100)
    expect(ext!.priority).toBe(200);
  });

  it('should apply preferred priority overrides from config during refresh', async () => {
    const resolver = new SpeechProviderResolver(
      { stt: { preferred: ['assemblyai', 'openai-whisper'] } },
      { OPENAI_API_KEY: 'k', ASSEMBLYAI_API_KEY: 'k' }
    );
    await resolver.refresh();
    const stts = resolver.listProviders('stt');
    const aai = stts.find(r => r.id === 'assemblyai');
    const whisper = stts.find(r => r.id === 'openai-whisper');
    // First preferred gets priority 50, second gets 51
    expect(aai!.priority).toBe(50);
    expect(whisper!.priority).toBe(51);
  });
});
