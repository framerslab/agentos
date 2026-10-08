import { describe, expect, it, vi } from 'vitest';
import { ExtensionManager } from '../../../extensions/ExtensionManager.js';
import { EXTENSION_KIND_TTS_PROVIDER } from '../../../extensions/types.js';
import { SpeechRuntime } from '../SpeechRuntime.js';
import type { SpeechToTextProvider, TextToSpeechProvider } from '../types.js';

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

  it('should transcribe on gpt-transcribe by default and keep timestamped formats on whisper-1', async () => {
    // The env-registered provider captures the global fetch when it is built,
    // so the stub goes in before the runtime is constructed.
    const forms: FormData[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        forms.push(init?.body as unknown as FormData);
        return new Response(JSON.stringify({ text: 'hello', languages: [{ code: 'en' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    try {
      const audio = { data: Buffer.from('wav'), mimeType: 'audio/wav' };
      const runtime = new SpeechRuntime({ env: { OPENAI_API_KEY: 'sk-openai' } });
      const stt = runtime.getProvider('openai-whisper') as SpeechToTextProvider;

      const result = await stt.transcribe(audio, { language: 'en' });
      expect(forms[0].get('model')).toBe('gpt-transcribe');
      expect(forms[0].get('response_format')).toBe('json');
      expect(forms[0].getAll('languages[]')).toEqual(['en']);
      expect(forms[0].has('language')).toBe(false);
      expect(result.language).toBe('en');

      // Segment timestamps exist only on whisper-1, so a verbose_json call
      // with no configured model runs there.
      await stt.transcribe(audio, { responseFormat: 'verbose_json' });
      expect(forms[1].get('model')).toBe('whisper-1');
      expect(forms[1].get('response_format')).toBe('verbose_json');

      // WHISPER_MODEL_DEFAULT still pins the model for every call.
      const pinned = new SpeechRuntime({
        env: { OPENAI_API_KEY: 'sk-openai', WHISPER_MODEL_DEFAULT: 'whisper-1' },
      });
      await (pinned.getProvider('openai-whisper') as SpeechToTextProvider).transcribe(audio);
      expect(forms[2].get('model')).toBe('whisper-1');
      expect(forms[2].get('response_format')).toBe('verbose_json');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SpeechRuntime MiniMax URL output', () => {
  // The env-registered provider captures the global fetch when it is built,
  // so the stub goes in before the runtime is constructed.
  function stubMiniMax(link: string) {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('https://api.minimax.io/')
        ? new Response(
            JSON.stringify({ data: { audio: link, status: 2 }, base_resp: { status_code: 0 } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response('audio'),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const urlOutput = { providerSpecificOptions: { outputFormat: 'url' } };

  it('downloads from a host listed in MINIMAX_TTS_AUDIO_URL_HOSTS', async () => {
    const fetchMock = stubMiniMax('https://audio.cdn.example.net/a.mp3');
    try {
      const runtime = new SpeechRuntime({
        env: {
          MINIMAX_API_KEY: 'sk-minimax',
          MINIMAX_TTS_AUDIO_URL_HOSTS: 'cdn.example.com, *.cdn.example.net',
        },
      });
      const tts = runtime.getProvider('minimax-tts') as TextToSpeechProvider;

      const result = await tts.synthesize('hello', urlOutput);
      expect(result.audioBuffer.toString()).toBe('audio');
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        'https://api.minimax.io/v1/t2a_v2',
        'https://audio.cdn.example.net/a.mp3',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('downloads nothing when MINIMAX_TTS_AUDIO_URL_HOSTS is unset', async () => {
    const fetchMock = stubMiniMax('https://audio.cdn.example.net/a.mp3');
    try {
      const runtime = new SpeechRuntime({ env: { MINIMAX_API_KEY: 'sk-minimax' } });
      const tts = runtime.getProvider('minimax-tts') as TextToSpeechProvider;

      await expect(tts.synthesize('hello', urlOutput)).rejects.toThrow('not in audioUrlHosts');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SpeechRuntime providers built from the environment', () => {
  const ids = ['deepgram-batch', 'deepgram-aura', 'assemblyai', 'azure-speech-stt', 'azure-speech-tts'];

  it('builds the Deepgram, AssemblyAI and Azure providers when their keys are set', () => {
    const runtime = new SpeechRuntime({
      env: {
        DEEPGRAM_API_KEY: 'dg',
        ASSEMBLYAI_API_KEY: 'aai',
        AZURE_SPEECH_KEY: 'az',
        AZURE_SPEECH_REGION: 'eastus',
      },
    });

    for (const id of ids) {
      expect(runtime.getProvider(id)?.id).toBe(id);
    }
    expect(runtime.resolver.resolveSTT({ preferredIds: ['assemblyai'] }).id).toBe('assemblyai');
    expect(runtime.resolver.resolveTTS({ preferredIds: ['azure-speech-tts'] }).id).toBe('azure-speech-tts');
  });

  it('builds the Azure providers only with both the key and the region', () => {
    const runtime = new SpeechRuntime({ env: { AZURE_SPEECH_KEY: 'az' } });

    expect(runtime.getProvider('azure-speech-stt')).toBeUndefined();
    expect(runtime.getProvider('azure-speech-tts')).toBeUndefined();
  });

  it('keeps OpenAI as the default and resolves a preferred core provider after refresh', async () => {
    const env = { OPENAI_API_KEY: 'op', DEEPGRAM_API_KEY: 'dg' };
    const plain = new SpeechRuntime({ env });
    await plain.resolver.refresh();
    expect(plain.getSTT()?.id).toBe('openai-whisper');

    const preferring = new SpeechRuntime({ env, preferredSttProviderId: 'deepgram-batch' });
    await preferring.resolver.refresh();
    expect(preferring.getSTT()?.id).toBe('deepgram-batch');
  });

  it('resolves a provider passed to registerSttProvider', () => {
    const runtime = new SpeechRuntime({ autoRegisterFromEnv: false });
    const custom = {
      id: 'custom-stt',
      getProviderName: () => 'Custom',
      transcribe: async () => ({ text: 'custom', cost: 0 }),
    };

    runtime.registerSttProvider(custom);

    expect(runtime.getSTT()).toBe(custom);
  });

  it('matches a streaming requirement against what the provider instance does', () => {
    // The catalog lists AssemblyAI as streaming; this provider uploads and polls.
    const runtime = new SpeechRuntime({ env: { ASSEMBLYAI_API_KEY: 'aai' } });

    expect(runtime.getSTT({ streaming: true })).toBeUndefined();
    expect(runtime.getSTT({ streaming: false })?.id).toBe('assemblyai');
  });

  it('reads a streaming feature requirement as the streaming capability', () => {
    // AssemblyAI's catalog features list 'streaming'; this provider uploads and polls.
    const runtime = new SpeechRuntime({ env: { ASSEMBLYAI_API_KEY: 'aai' } });

    expect(runtime.getSTT({ features: ['streaming'] })).toBeUndefined();
    expect(runtime.getSTT({ features: ['diarization'] })?.id).toBe('assemblyai');
  });

  it('ignores a catalog entry of another kind, and treats an undeclared provider as not streaming', () => {
    // 'elevenlabs' is a text-to-speech id in the catalog, listed as streaming.
    const runtime = new SpeechRuntime({ autoRegisterFromEnv: false });
    const custom = {
      id: 'elevenlabs',
      getProviderName: () => 'Custom',
      transcribe: async () => ({ text: 'custom', cost: 0 }),
    };

    runtime.registerSttProvider(custom);

    expect(runtime.getSTT({ streaming: false })).toBe(custom);
    expect(runtime.getSTT({ streaming: true })).toBeUndefined();
  });
});
