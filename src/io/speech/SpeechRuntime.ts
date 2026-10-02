import type { ExtensionManager } from '../../extensions/ExtensionManager.js';
import {
  EXTENSION_KIND_STT_PROVIDER,
  EXTENSION_KIND_TTS_PROVIDER,
  EXTENSION_KIND_VAD_PROVIDER,
  EXTENSION_KIND_WAKE_WORD_PROVIDER,
} from '../../extensions/types.js';
import { findSpeechProviderCatalogEntry, getSpeechProviderCatalog } from './providerCatalog.js';
import { SpeechProviderRegistry } from './SpeechProviderRegistry.js';
import { SpeechProviderResolver } from './SpeechProviderResolver.js';
import { SpeechSession } from './SpeechSession.js';
import { BuiltInAdaptiveVadProvider } from '../hearing/providers/BuiltInAdaptiveVadProvider.js';
import { ElevenLabsTextToSpeechProvider } from './providers/ElevenLabsTextToSpeechProvider.js';
import { OpenAITextToSpeechProvider } from './providers/OpenAITextToSpeechProvider.js';
import { MiniMaxTextToSpeechProvider } from './providers/MiniMaxTextToSpeechProvider.js';
import { OpenAIWhisperSpeechToTextProvider } from '../hearing/providers/OpenAIWhisperSpeechToTextProvider.js';
import type {
  ProviderRequirements,
  SpeechProviderCatalogEntry,
  SpeechResolverConfig,
  SpeechRuntimeConfig,
  SpeechRuntimeSessionConfig,
  SpeechToTextProvider,
  SpeechVadProvider,
  TextToSpeechProvider,
  WakeWordProvider,
} from './types.js';

export class SpeechRuntime {
  private readonly registry: SpeechProviderRegistry;
  private readonly preferredSttProviderId: string | undefined;
  private readonly preferredTtsProviderId: string | undefined;

  /** Prefer resolver-based provider resolution over direct registry lookups. */
  readonly resolver: SpeechProviderResolver;

  constructor(config: SpeechRuntimeConfig = {}) {
    const env = config.env ?? process.env;

    /* Build resolver config from legacy preferred-provider fields. */
    const resolverConfig: SpeechResolverConfig = {};
    if (config.preferredSttProviderId) {
      resolverConfig.stt = { preferred: [config.preferredSttProviderId] };
    }
    if (config.preferredTtsProviderId) {
      resolverConfig.tts = { preferred: [config.preferredTtsProviderId] };
    }

    this.resolver = new SpeechProviderResolver(resolverConfig, env);
    this.registry = new SpeechProviderRegistry();
    this.preferredSttProviderId =
      typeof config.preferredSttProviderId === 'string' && config.preferredSttProviderId.trim()
        ? config.preferredSttProviderId.trim()
        : undefined;
    this.preferredTtsProviderId =
      typeof config.preferredTtsProviderId === 'string' && config.preferredTtsProviderId.trim()
        ? config.preferredTtsProviderId.trim()
        : undefined;

    /* VAD — always registered. */
    const vadProvider = new BuiltInAdaptiveVadProvider();
    this.registry.registerVadProvider(vadProvider);
    this.registerProviderInResolver(vadProvider, 'vad');

    if (config.autoRegisterFromEnv !== false) {
      const openaiApiKey = env['OPENAI_API_KEY'];
      if (openaiApiKey) {
        const stt = new OpenAIWhisperSpeechToTextProvider({
          apiKey: openaiApiKey,
          model: env['WHISPER_MODEL_DEFAULT'] ?? 'whisper-1',
        });
        this.registry.registerSttProvider(stt);
        this.registerProviderInResolver(stt, 'stt');

        const tts = new OpenAITextToSpeechProvider({
          apiKey: openaiApiKey,
          model: env['OPENAI_TTS_DEFAULT_MODEL'] ?? 'tts-1',
          voice: env['OPENAI_TTS_DEFAULT_VOICE'] ?? 'nova',
        });
        this.registry.registerTtsProvider(tts);
        this.registerProviderInResolver(tts, 'tts');
      }

      const elevenLabsApiKey = env['ELEVENLABS_API_KEY'];
      if (elevenLabsApiKey) {
        const tts = new ElevenLabsTextToSpeechProvider({
          apiKey: elevenLabsApiKey,
          model: env['ELEVENLABS_TTS_MODEL'] ?? 'eleven_multilingual_v2',
          voiceId: env['ELEVENLABS_VOICE_ID'],
        });
        this.registry.registerTtsProvider(tts);
        this.registerProviderInResolver(tts, 'tts');
      }

      const miniMaxApiKey = env['MINIMAX_API_KEY'];
      if (miniMaxApiKey) {
        const tts = new MiniMaxTextToSpeechProvider({
          apiKey: miniMaxApiKey,
          region: env['MINIMAX_REGION'] === 'china' ? 'china' : 'global',
          model: env['MINIMAX_TTS_MODEL'] ?? 'speech-2.8-hd',
          voice: env['MINIMAX_TTS_VOICE'],
        });
        this.registry.registerTtsProvider(tts);
        this.registerProviderInResolver(tts, 'tts');
      }
    }
  }

  getProviderRegistry(): SpeechProviderRegistry {
    return this.registry;
  }

  registerSttProvider(provider: SpeechToTextProvider): void {
    this.registry.registerSttProvider(provider);
  }

  registerTtsProvider(provider: TextToSpeechProvider): void {
    this.registry.registerTtsProvider(provider);
  }

  registerVadProvider(provider: SpeechVadProvider): void {
    this.registry.registerVadProvider(provider);
  }

  registerWakeWordProvider(provider: WakeWordProvider): void {
    this.registry.registerWakeWordProvider(provider);
  }

  hydrateFromExtensionManager(manager: ExtensionManager): void {
    for (const descriptor of manager
      .getRegistry<SpeechToTextProvider>(EXTENSION_KIND_STT_PROVIDER)
      .listActive()) {
      this.registry.registerSttProvider(descriptor.payload);
      this.registerProviderInResolver(descriptor.payload, 'stt', 'extension');
    }
    for (const descriptor of manager
      .getRegistry<TextToSpeechProvider>(EXTENSION_KIND_TTS_PROVIDER)
      .listActive()) {
      this.registry.registerTtsProvider(descriptor.payload);
      this.registerProviderInResolver(descriptor.payload, 'tts', 'extension');
    }
    for (const descriptor of manager
      .getRegistry<SpeechVadProvider>(EXTENSION_KIND_VAD_PROVIDER)
      .listActive()) {
      this.registry.registerVadProvider(descriptor.payload);
      this.registerProviderInResolver(descriptor.payload, 'vad', 'extension');
    }
    for (const descriptor of manager
      .getRegistry<WakeWordProvider>(EXTENSION_KIND_WAKE_WORD_PROVIDER)
      .listActive()) {
      this.registry.registerWakeWordProvider(descriptor.payload);
      this.registerProviderInResolver(descriptor.payload, 'wake-word', 'extension');
    }
  }

  /**
   * Resolve an STT provider via the new {@link SpeechProviderResolver}.
   * Returns `undefined` instead of throwing when no provider matches.
   */
  getSTT(requirements?: ProviderRequirements): SpeechToTextProvider | undefined {
    try {
      return this.resolver.resolveSTT(requirements);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a TTS provider via the new {@link SpeechProviderResolver}.
   * Returns `undefined` instead of throwing when no provider matches.
   */
  getTTS(requirements?: ProviderRequirements): TextToSpeechProvider | undefined {
    try {
      return this.resolver.resolveTTS(requirements);
    } catch {
      return undefined;
    }
  }

  createSession(config: SpeechRuntimeSessionConfig = {}): SpeechSession {
    const providers = {
      stt: config.sttProviderId
        ? this.registry.getSttProvider(config.sttProviderId)
        : this.resolveDefaultSttProvider(),
      tts: config.ttsProviderId
        ? this.registry.getTtsProvider(config.ttsProviderId)
        : this.resolveDefaultTtsProvider(),
      vad: config.vadProviderId
        ? this.registry.getVadProvider(config.vadProviderId)
        : this.resolveDefaultVadProvider(),
      wakeWord: config.wakeWordProviderId
        ? this.registry.getWakeWordProvider(config.wakeWordProviderId)
        : this.resolveDefaultWakeWordProvider(),
    };
    return new SpeechSession(config, providers);
  }

  listProviders(): Array<SpeechProviderCatalogEntry & { registered: boolean }> {
    return getSpeechProviderCatalog().map((entry) => ({
      ...entry,
      registered: this.isProviderRegistered(entry),
    }));
  }

  getProvider(
    id: string
  ):
    | SpeechToTextProvider
    | TextToSpeechProvider
    | SpeechVadProvider
    | WakeWordProvider
    | undefined {
    return (
      this.registry.getSttProvider(id) ??
      this.registry.getTtsProvider(id) ??
      this.registry.getVadProvider(id) ??
      this.registry.getWakeWordProvider(id)
    );
  }

  private isProviderRegistered(entry: SpeechProviderCatalogEntry): boolean {
    switch (entry.kind) {
      case 'stt':
        return Boolean(this.registry.getSttProvider(entry.id));
      case 'tts':
        return Boolean(this.registry.getTtsProvider(entry.id));
      case 'vad':
        return Boolean(this.registry.getVadProvider(entry.id));
      case 'wake-word':
        return Boolean(this.registry.getWakeWordProvider(entry.id));
      default:
        return false;
    }
  }

  /**
   * Bridge helper — registers a provider instance into the resolver with
   * sensible defaults derived from the static catalog.
   */
  private registerProviderInResolver(
    provider: { id: string; getProviderName?: () => string },
    kind: 'stt' | 'tts' | 'vad' | 'wake-word',
    source: 'core' | 'extension' = 'core'
  ): void {
    const catalogEntry = findSpeechProviderCatalogEntry(provider.id) ?? {
      id: provider.id,
      kind,
      label: provider.getProviderName?.() ?? provider.id,
      envVars: [],
      local: false,
      description: '',
    };
    this.resolver.register({
      id: provider.id,
      kind,
      provider: provider as any,
      catalogEntry,
      isConfigured: true,
      priority: source === 'extension' ? 200 : 100,
      source,
    });
  }

  private resolveDefaultSttProvider(): SpeechToTextProvider | undefined {
    if (this.preferredSttProviderId) {
      const preferred = this.registry.getSttProvider(this.preferredSttProviderId);
      if (preferred) return preferred;
    }
    return (
      this.registry.getSttProvider('openai-whisper') ??
      (this.registry.list('stt')[0] as SpeechToTextProvider | undefined)
    );
  }

  private resolveDefaultTtsProvider(): TextToSpeechProvider | undefined {
    if (this.preferredTtsProviderId) {
      const preferred = this.registry.getTtsProvider(this.preferredTtsProviderId);
      if (preferred) return preferred;
    }
    return (
      this.registry.getTtsProvider('openai-tts') ??
      this.registry.getTtsProvider('elevenlabs') ??
      (this.registry.list('tts')[0] as TextToSpeechProvider | undefined)
    );
  }

  private resolveDefaultVadProvider(): SpeechVadProvider | undefined {
    return (
      this.registry.getVadProvider('agentos-adaptive-vad') ??
      (this.registry.list('vad')[0] as SpeechVadProvider | undefined)
    );
  }

  private resolveDefaultWakeWordProvider(): WakeWordProvider | undefined {
    return this.registry.list('wake-word')[0] as WakeWordProvider | undefined;
  }
}

export function createSpeechRuntime(config: SpeechRuntimeConfig = {}): SpeechRuntime {
  return new SpeechRuntime(config);
}

export function createSpeechRuntimeFromEnv(
  env: Record<string, string | undefined> = process.env,
  config: Omit<SpeechRuntimeConfig, 'env'> = {}
): SpeechRuntime {
  return new SpeechRuntime({
    ...config,
    autoRegisterFromEnv: config.autoRegisterFromEnv ?? true,
    env,
  });
}

export function getDefaultSpeechProviderId(kind: 'stt' | 'tts'): string | undefined {
  if (kind === 'stt') {
    return findSpeechProviderCatalogEntry('openai-whisper')?.id;
  }
  return findSpeechProviderCatalogEntry('openai-tts')?.id;
}
