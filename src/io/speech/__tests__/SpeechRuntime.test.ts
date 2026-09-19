import { describe, expect, it } from 'vitest';
import { ExtensionManager } from '../../../extensions/ExtensionManager.js';
import { EXTENSION_KIND_TTS_PROVIDER } from '../../../extensions/types.js';
import { SpeechRuntime } from '../SpeechRuntime.js';

/**
 * Tests for {@link SpeechRuntime} — the high-level runtime that manages
 * provider registration, extension hydration, and session creation.
 *
 * SpeechRuntime wraps SpeechProviderResolver and provides a simpler API
 * for end-to-end speech workflows (transcribe, synthesize, VAD sessions).
 */
describe('SpeechRuntime', () => {
  it('should auto-register built-in and env-backed providers on construction', () => {
    const runtime = new SpeechRuntime({
      env: {
        OPENAI_API_KEY: 'sk-openai',
        ELEVENLABS_API_KEY: 'sk-elevenlabs',
        MINIMAX_API_KEY: 'sk-minimax',
      },
    });

    // VAD is always available (no env vars required)
    expect(runtime.getProvider('agentos-adaptive-vad')).toBeDefined();
    // STT and TTS providers should be registered based on env vars
    expect(runtime.getProvider('openai-whisper')).toBeDefined();
    expect(runtime.getProvider('openai-tts')).toBeDefined();
    expect(runtime.getProvider('elevenlabs')).toBeDefined();
    expect(runtime.getProvider('minimax-tts')).toBeDefined();
  });

  it('should hydrate speech providers from the extension manager', async () => {
    const manager = new ExtensionManager();
    // Register a test TTS provider descriptor via the extension system
    await manager.getRegistry(EXTENSION_KIND_TTS_PROVIDER).register(
      {
        id: 'test-tts-descriptor',
        kind: EXTENSION_KIND_TTS_PROVIDER,
        payload: {
          id: 'test-tts',
          getProviderName: () => 'Test TTS',
          synthesize: async () => ({
            audioBuffer: Buffer.from('ok'),
            mimeType: 'audio/mpeg',
            cost: 0,
          }),
        },
      },
    );

    const runtime = new SpeechRuntime({ autoRegisterFromEnv: false });
    runtime.hydrateFromExtensionManager(manager);

    // The extension-provided TTS should now be discoverable
    expect(runtime.getProvider('test-tts')).toBeDefined();
  });

  it('should prefer configured provider IDs over hardcoded defaults', async () => {
    const calls: string[] = [];
    const runtime = new SpeechRuntime({
      autoRegisterFromEnv: false,
      preferredSttProviderId: 'deepgram',
      preferredTtsProviderId: 'elevenlabs',
    });

    // Register two STT providers — deepgram should be preferred
    runtime.registerSttProvider({
      id: 'openai-whisper',
      getProviderName: () => 'OpenAI Whisper',
      transcribe: async () => {
        calls.push('openai-whisper');
        return { text: 'openai', cost: 0 };
      },
    });
    runtime.registerSttProvider({
      id: 'deepgram',
      getProviderName: () => 'Deepgram',
      transcribe: async () => {
        calls.push('deepgram');
        return { text: 'deepgram', cost: 0 };
      },
    });

    // Register two TTS providers — elevenlabs should be preferred
    runtime.registerTtsProvider({
      id: 'openai-tts',
      getProviderName: () => 'OpenAI TTS',
      synthesize: async () => {
        calls.push('openai-tts');
        return { audioBuffer: Buffer.from('openai'), mimeType: 'audio/mpeg', cost: 0 };
      },
    });
    runtime.registerTtsProvider({
      id: 'elevenlabs',
      getProviderName: () => 'ElevenLabs',
      synthesize: async () => {
        calls.push('elevenlabs');
        return { audioBuffer: Buffer.from('elevenlabs'), mimeType: 'audio/mpeg', cost: 0 };
      },
    });

    const session = runtime.createSession();
    await session.speak('hello');
    await session.transcribeAudio(Buffer.from('wav'));

    // Verify the preferred providers were used, not the first-registered ones
    expect(calls).toEqual(['elevenlabs', 'deepgram']);
  });
});
