import { EventEmitter } from 'events';
import type {
  SpeechProviderKind,
  SpeechToTextProvider,
  TextToSpeechProvider,
  SpeechVadProvider,
  WakeWordProvider,
  SpeechResolverConfig,
  ProviderRequirements,
  ProviderRegistration,
  SpeechProviderCatalogEntry,
} from './types.js';
import { FallbackSTTProxy, FallbackTTSProxy } from './FallbackProxy.js';
import { findSpeechProviderCatalogEntry } from './providerCatalog.js';
import { assertSpeechAvailable } from './retirements.js';
import { z } from 'zod';
import { isScopedVoiceAdapter, VoiceAdapterManifestSchema, VoiceAdapterRuntime, type ScopedVoiceAdapter, type VoiceAdapterKind, type VoiceAdapterSelection, type OpenedVoiceAdapter, type VoiceSupplierUsageSink } from './VoiceAdapter.js';
import { VoiceAgentSchema, type VoiceAgent } from '../voice-platform/contracts/index.js';
import { captureVoiceScope, type VoiceScopeContext } from '../voice-platform/VoiceScopeContext.js';
import type { IAttemptAuthorizer } from '../../safety/runtime/ModelAttemptBudget.js';
import { checkDestination, hostedEgressPolicy, localEgressPolicy } from '../../safety/egress/CheckedEgress.js';
import type { VoiceNetworkDependencies, VoiceStopEvidence } from '../voice-platform/reasoning/tools.js';
import type { VoiceGeneration, IStreamingSTT, IStreamingTTS, IVadSession, IAudioEndpointDetector } from '../voice-pipeline/types.js';
import { StreamingSTTChain } from '../voice-pipeline/providers/StreamingSTTChain.js';
import { ReconnectingSTT } from '../voice-pipeline/ReconnectingSTT.js';
import { StreamingTTSChain } from '../voice-pipeline/providers/StreamingTTSChain.js';
/** Scoped registered option lookup; options are parsed against the selected factory's closed schema. */
export interface VoiceOptionsStore { read(scopeId: string, ref: string): Promise<Record<string, unknown> | undefined> }
/** Constructed provider set with one combined native stop obligation. */
export interface OpenedVoicePlan {
  stt: IStreamingSTT; tts: IStreamingTTS; vad: IVadSession; endpoint: IAudioEndpointDetector;
  fence(generation: VoiceGeneration): Promise<VoiceStopEvidence>;
  fenceSynthesis(generation: VoiceGeneration): Promise<VoiceStopEvidence>;
  dispose(): Promise<void>;
}
/** Configuration is captured before admission; model construction is deferred until the authenticated binding starts. */
export interface FrozenVoicePlan {
  readonly agent: VoiceAgent;
  open(budget: IAttemptAuthorizer, onSupplierUsage?: VoiceSupplierUsageSink): Promise<OpenedVoicePlan>;
}
const freezeVoiceValue = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeVoiceValue(child); Object.freeze(value); } return value; };

/**
 * Central resolver for speech providers (STT, TTS, VAD, wake-word).
 *
 * ## Resolution Algorithm
 *
 * 1. **Registration** — Providers are registered via `register()` with a
 *    unique `id`, a `kind` (stt/tts/vad/wake-word), a numeric `priority`,
 *    and a boolean `isConfigured` flag.
 *
 * 2. **Filtering** — When a consumer calls `resolveSTT()`, `resolveTTS()`,
 *    `resolveVAD()`, or `resolveWakeWord()`, the resolver filters
 *    registrations by `kind`, `isConfigured === true` and a registered
 *    provider instance (`provider`). A core catalog entry with its keys set
 *    but no instance does not resolve.
 *
 * 3. **Requirements matching** — Optional {@link ProviderRequirements} further
 *    filter by `streaming`, `local`, and `features` capabilities from the
 *    provider's catalog entry.
 *
 * 4. **Priority ordering** — Remaining candidates are sorted by ascending
 *    `priority` (lower number = tried first). Core providers default to 100,
 *    extensions to 200, and user-preferred providers get boosted to 50+.
 *
 * 5. **Fallback wrapping** — When `config.stt.fallback` or `config.tts.fallback`
 *    is `true` and multiple candidates survive, they are wrapped in a
 *    {@link FallbackSTTProxy} or {@link FallbackTTSProxy} that tries each in
 *    order, emitting `provider_fallback` events on failure.
 *
 * ## Priority Tiers
 *
 * | Tier | Priority Range | Source |
 * |------|---------------|--------|
 * | User-preferred | 50–59 | `config.stt.preferred` / `config.tts.preferred` |
 * | Core | 100 | Built-in provider catalog |
 * | Extension | 200 | Discovered via ExtensionManager |
 *
 * ## Events
 *
 * | Event | Payload | When |
 * |-------|---------|------|
 * | `provider_registered` | `{ id, kind, source }` | A provider is registered via `register()` |
 *
 * @see {@link FallbackSTTProxy} for the STT fallback chain implementation
 * @see {@link FallbackTTSProxy} for the TTS fallback chain implementation
 * @see {@link ProviderRequirements} for available filtering criteria
 *
 * @example
 * ```ts
 * // SpeechRuntime builds the providers whose keys are set (DEEPGRAM_API_KEY
 * // for deepgram-batch) and registers them in its resolver.
 * const runtime = new SpeechRuntime({ env: process.env, preferredSttProviderId: 'deepgram-batch' });
 * await runtime.resolver.refresh(); // applies the preferred priorities
 * const stt = runtime.resolver.resolveSTT();
 * ```
 */
export class SpeechProviderResolver extends EventEmitter {
  /**
   * Internal registry of all providers, keyed by kind and id (`keyOf()`), so a
   * speech-to-text and a text-to-speech provider can share an id. Overwrites
   * are allowed — re-registering the same kind and id replaces the previous
   * entry, which lets hot-reload and extension refresh work seamlessly.
   */
  private registrations = new Map<string, ProviderRegistration>();

  /**
   * The priority each provider was registered with. `refresh()` restores it
   * before applying the preferred lists, so a provider that is no longer
   * preferred loses its boost.
   */
  private basePriorities = new Map<string, number>();

  /**
   * The providers the last `refresh(extensionManager)` read from the manager,
   * by key, so the next one can drop those the manager no longer lists.
   */
  private discovered = new Map<string, unknown>();

  /** Map key of a registration: providers of different kinds may share an id. */
  private static keyOf(kind: SpeechProviderKind, id: string): string {
    return `${kind}:${id}`;
  }

  /**
   * Creates a new SpeechProviderResolver.
   *
   * @param config - Optional resolver configuration controlling preferred
   *   providers and fallback behaviour for each provider kind.
   * @param env - Environment variable map used to check whether a provider's
   *   required API keys are present. Defaults to `process.env` so unit tests
   *   can inject a controlled map without polluting the real environment.
   *
   * @example
   * ```ts
   * // Production: use real env vars
   * const resolver = new SpeechProviderResolver({ stt: { fallback: true } });
   *
   * // Testing: inject controlled env
   * const resolver = new SpeechProviderResolver(undefined, { OPENAI_API_KEY: 'test' });
   * ```
   */
  constructor(
    private readonly config?: SpeechResolverConfig,
    private readonly env: Record<string, string | undefined> = process.env
  ) {
    super();
  }

  /**
   * Register a provider, overwriting any existing registration with the same
   * kind and id. Re-registering at the priority the resolver shows (a preferred
   * boost included), as `register({ ...entry, provider })` does, keeps the
   * priority the provider was first registered with.
   *
   * Emits a `provider_registered` event with `{ id, kind, source }` so that
   * listeners (e.g. UI dashboards, logging middleware) can track what's available.
   *
   * @param reg - The full registration object including the provider instance,
   *   catalog entry, priority, and configuration status.
   *
   * @example
   * ```ts
   * resolver.register({
   *   id: 'custom-stt',
   *   kind: 'stt',
   *   provider: myCustomProvider,
   *   catalogEntry: { id: 'custom-stt', kind: 'stt', label: 'Custom', envVars: [], local: false, description: '' },
   *   isConfigured: true,
   *   priority: 150,
   *   source: 'extension',
   * });
   * ```
   */
  register(reg: ProviderRegistration): void {
    const key = SpeechProviderResolver.keyOf(reg.kind, reg.id);
    const current = this.registrations.get(key);
    const base =
      current && reg.priority === current.priority
        ? (this.basePriorities.get(key) ?? reg.priority)
        : reg.priority;
    this.registrations.set(key, reg);
    this.basePriorities.set(key, base);
    this.emit('provider_registered', { id: reg.id, kind: reg.kind, source: reg.source });
  }

  /**
   * List all registrations for a given provider kind, sorted ascending by
   * priority (lower number = higher priority = tried first).
   *
   * This returns both configured and unconfigured providers — use
   * `.filter(r => r.isConfigured && r.provider)` for the ones the resolve
   * methods can return (keys set and an instance registered).
   *
   * @param kind - The provider kind to filter by.
   * @returns A new array of registrations sorted by ascending priority.
   *
   * @example
   * ```ts
   * const allSTT = resolver.listProviders('stt');
   * const ready = allSTT.filter(r => r.isConfigured && r.provider);
   * console.log(`${ready.length} of ${allSTT.length} STT providers ready`);
   * ```
   */
  listProviders(kind: SpeechProviderKind): ProviderRegistration[] {
    return [...this.registrations.values()]
      .filter((r) => r.kind === kind)
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Resolve the best STT provider matching optional {@link ProviderRequirements}.
   *
   * When `config.stt.fallback` is `true` and multiple candidates exist, wraps
   * them in a {@link FallbackSTTProxy} that tries providers in priority order.
   * Otherwise returns the single highest-priority match.
   *
   * @param requirements - Optional filtering criteria (streaming, local, features,
   *   preferredIds).
   * @returns The resolved STT provider, possibly wrapped in a FallbackSTTProxy.
   * @throws {Error} When no configured STT provider with an instance matches the requirements.
   *
   * @see {@link FallbackSTTProxy} for fallback chain behaviour
   * @see {@link ProviderRequirements} for available filter options
   *
   * @example
   * ```ts
   * // Simple: best available
   * const stt = resolver.resolveSTT();
   *
   * // With requirements
   * const stt = resolver.resolveSTT({ streaming: true, features: ['diarization'] });
   *
   * // With explicit preference ordering
   * const stt = resolver.resolveSTT({ preferredIds: ['deepgram-batch', 'openai-whisper'] });
   * ```
   */
  resolveSTT(requirements?: ProviderRequirements): SpeechToTextProvider {
    const candidates = this.resolveByKind('stt', requirements);
    if (candidates.length === 0) {
      throw new Error('No configured STT provider matches requirements');
    }

    // Wrap in a fallback proxy when the user has opted into fallback mode
    // and there are multiple viable providers to chain together.
    if (this.config?.stt?.fallback && candidates.length > 1) {
      return new FallbackSTTProxy(
        candidates.map((r) => r.provider as SpeechToTextProvider),
        this
      );
    }
    return candidates[0].provider as SpeechToTextProvider;
  }

  /**
   * Resolve the best TTS provider matching optional {@link ProviderRequirements}.
   *
   * When `config.tts.fallback` is `true` and multiple candidates exist, wraps
   * them in a {@link FallbackTTSProxy} that tries providers in priority order.
   * Otherwise returns the single highest-priority match.
   *
   * @param requirements - Optional filtering criteria (streaming, local, features,
   *   preferredIds).
   * @returns The resolved TTS provider, possibly wrapped in a FallbackTTSProxy.
   * @throws {Error} When no configured TTS provider with an instance matches the requirements.
   *
   * @see {@link FallbackTTSProxy} for fallback chain behaviour
   * @see {@link ProviderRequirements} for available filter options
   *
   * @example
   * ```ts
   * const tts = resolver.resolveTTS();
   * const result = await tts.synthesize('Hello!');
   * ```
   */
  resolveTTS(requirements?: ProviderRequirements): TextToSpeechProvider {
    const candidates = this.resolveByKind('tts', requirements);
    if (candidates.length === 0) {
      throw new Error('No configured TTS provider matches requirements');
    }

    // Same fallback wrapping logic as STT — see resolveSTT for commentary.
    if (this.config?.tts?.fallback && candidates.length > 1) {
      return new FallbackTTSProxy(
        candidates.map((r) => r.provider as TextToSpeechProvider),
        this
      );
    }
    return candidates[0].provider as TextToSpeechProvider;
  }

  /**
   * Resolve the highest-priority configured VAD provider.
   *
   * VAD providers don't support fallback chains because voice activity detection
   * is a real-time frame-by-frame operation where mid-session provider switching
   * would cause state inconsistency.
   *
   * @returns The resolved VAD provider instance.
   * @throws {Error} When no configured VAD provider with an instance is registered.
   *
   * @example
   * ```ts
   * const vad = resolver.resolveVAD();
   * const decision = vad.processFrame(audioFrame);
   * ```
   */
  resolveVAD(): SpeechVadProvider {
    const vads = this.listProviders('vad').filter((r) => r.isConfigured && r.provider != null);
    if (vads.length === 0) {
      throw new Error('No VAD provider registered');
    }
    return vads[0].provider as SpeechVadProvider;
  }

  /**
   * Resolve the highest-priority configured wake-word provider, or `null`
   * when none is registered.
   *
   * Returns `null` instead of throwing because wake-word detection is an
   * optional feature — many deployments operate without it.
   *
   * @returns The resolved wake-word provider, or `null` if none is available.
   *
   * @example
   * ```ts
   * const wakeWord = resolver.resolveWakeWord();
   * if (wakeWord) {
   *   const detection = await wakeWord.detect(frame, sampleRate);
   * }
   * ```
   */
  resolveWakeWord(): WakeWordProvider | null {
    const wakeWords = this.listProviders('wake-word').filter((r) => r.isConfigured);
    return wakeWords.length > 0 ? (wakeWords[0].provider as WakeWordProvider) : null;
  }

  // ---------------------------------------------------------------------------
  // Bulk registration helpers
  // ---------------------------------------------------------------------------

  /**
   * Populate the resolver by registering core providers from the static catalog,
   * optionally discovering extension providers, and applying user-configured
   * preferred priorities.
   *
   * The refresh sequence is:
   * 1. `discoverExtensionProviders()` — if an ExtensionManager is provided, read
   *    the speech providers it lists as active, and drop the ones an earlier
   *    refresh read from it that it no longer lists.
   * 2. `registerCoreProviders()` — register all built-in providers from the
   *    static catalog, marking each as configured/unconfigured based on env vars.
   * 3. Register the providers read in step 1, at priority 200.
   * 4. `applyPreferredPriorities()` — boost priority for providers listed in
   *    the user's `config.stt.preferred` / `config.tts.preferred` arrays.
   *
   * @param extensionManager - Optional `ExtensionManager` (its speech provider
   *   registries are read through `getRegistry(kind).listActive()`), or any
   *   object exposing `getDescriptorsByKind(kind)`. Uses `any` type because
   *   importing the ExtensionManager type here would create a circular dependency.
   *
   * @example
   * ```ts
   * const runtime = new SpeechRuntime({ env: process.env });
   * await runtime.resolver.refresh(extensionManager);
   * // The manager's speech providers now resolve beside the runtime's own.
   * ```
   */
  async refresh(extensionManager?: any): Promise<void> {
    const discovered = extensionManager ? this.discoverExtensionProviders(extensionManager) : null;
    if (discovered) {
      this.dropProvidersNoLongerDiscovered(discovered);
    }

    this.registerCoreProviders();

    if (discovered) {
      for (const reg of discovered) this.register(reg);
      this.discovered = new Map<string, unknown>(
        discovered.map((reg): [string, unknown] => [SpeechProviderResolver.keyOf(reg.kind, reg.id), reg.provider]),
      );
    }

    this.applyPreferredPriorities();
  }

  private readonly voiceAdapters = new Map<string, ScopedVoiceAdapter>();
  /** Registers an explicit scoped factory. Legacy catalog metadata cannot satisfy this API. */
  registerVoiceAdapter(adapter: ScopedVoiceAdapter): void {
    if (!isScopedVoiceAdapter(adapter)) throw new Error('scoped voice adapter required');
    const manifest = VoiceAdapterManifestSchema.parse(adapter.manifest);
    if ((adapter.kind.startsWith('streaming-') && !manifest.streaming) || (adapter.kind.startsWith('batch-') && manifest.streaming)) throw new Error('streaming capability mismatch');
    if (adapter.kind === 'streaming-tts' && !manifest.awaitedOutput) throw new Error('awaited synthesis required');
    const captured = Object.freeze({ voiceAdapterVersion: adapter.voiceAdapterVersion, kind: adapter.kind,
      manifest: freezeVoiceValue(manifest), options: adapter.options.strict(), create: adapter.create.bind(adapter) });
    this.voiceAdapters.set(`${adapter.kind}:${manifest.providerId}`, captured);
  }
  /** Reads typed descriptors without triggering legacy environment discovery or creating providers. */
  refreshVoiceAdapters(manager: { getVoiceAdapters(): ScopedVoiceAdapter[] }): void {
    const entries = manager.getVoiceAdapters(); this.voiceAdapters.clear();
    for (const entry of entries) this.registerVoiceAdapter(entry);
  }
  /** Validates language, PCM format, immutable models/voices, options and every fallback before construction. */
  async resolveVoicePlan(rawScope: VoiceScopeContext, rawAgent: VoiceAgent, options: VoiceOptionsStore, network: VoiceNetworkDependencies = {}): Promise<FrozenVoicePlan> {
    const scope = captureVoiceScope(rawScope); const agent = freezeVoiceValue(VoiceAgentSchema.parse(rawAgent));
    if (agent.scopeId !== scope.scopeId || agent.state !== 'active' || agent.providerPolicy.mode !== scope.policy.mode || agent.providerPolicy.fallback !== scope.policy.fallback || JSON.stringify(agent.providerPolicy.providerIds) !== JSON.stringify(scope.policy.providers.map((p) => p.providerId)) || JSON.stringify(agent.providerPolicy.purposes) !== JSON.stringify(scope.policy.purposes) || JSON.stringify(agent.allowedToolRefs) !== JSON.stringify(scope.allowedToolRefs)) throw new Error('agent scope or policy refused');
    if (agent.stt.mode !== 'streaming' || agent.tts.mode !== 'streaming' || agent.stt.sampleRate !== 16000 || agent.stt.codec !== 'pcm_f32le' || !['pcm_s16le', 'wav'].includes(agent.tts.codec)) throw new Error('call streaming format refused');
    const selected: Array<{ adapter: ScopedVoiceAdapter; selection: VoiceAdapterSelection }> = [];
    for (const [purpose, kind, primary] of [['stt', 'streaming-stt', agent.stt], ['tts', 'streaming-tts', agent.tts], ['vad', 'vad-session', agent.vad], ['endpoint', 'audio-endpoint', agent.endpoint]] as const) {
      const permitted = scope.policy.providers.filter((p) => p.purposes.includes(purpose) && (scope.policy.mode !== 'local' || p.locality === 'local'));
      if (permitted[0]?.providerId !== primary.providerId) throw new Error('primary provider order refused');
      const ids = scope.policy.fallback === 'allowlisted' && (purpose === 'stt' || purpose === 'tts') ? permitted.map((p) => p.providerId) : [primary.providerId];
      for (const providerId of ids) {
        const adapter = this.voiceAdapters.get(`${kind}:${providerId}`); if (!adapter) throw new Error('typed voice adapter missing');
        const m = adapter.manifest; const permission = permitted.find((p) => p.providerId === providerId)!;
        assertSpeechAvailable(m.providerId, m.modelId, Date.now(), scope.policy.mode);
        if (m.locality !== permission.locality || !m.languages.includes(agent.language) || !m.sampleRates.includes(purpose === 'tts' ? agent.tts.sampleRate : 16000) || !m.codecs.includes(purpose === 'tts' ? agent.tts.codec : 'pcm_f32le')) throw new Error('voice manifest capability refused');
        if (providerId === primary.providerId && (m.modelId !== primary.modelId || m.modelRevision !== primary.modelRevision)) throw new Error('voice model revision refused');
        if (purpose === 'tts' && !m.voices.some((v) => v.id === agent.voice.id && v.revision === agent.voice.revision)) throw new Error('voice revision refused');
        if ('credentialRef' in primary && providerId === primary.providerId && primary.credentialRef !== m.credentialRef) throw new Error('voice credential revision refused');
        const values = primary.optionsRef ? await options.read(scope.scopeId, primary.optionsRef) : {};
        if (!values) throw new Error('voice options missing'); const parsed = z.record(z.string(), z.unknown()).parse(adapter.options.parse(values));
        // Model-specific fallback options must accept the same closed values or admission fails.
        if (m.origin) await checkDestination(m.origin, (scope.policy.mode === 'hosted' ? hostedEgressPolicy : localEgressPolicy)(), network.lookup);
        const selection: VoiceAdapterSelection = freezeVoiceValue({ modelId: m.modelId, modelRevision: m.modelRevision, language: agent.language, sampleRate: purpose === 'tts' ? agent.tts.sampleRate : 16000, codec: purpose === 'tts' ? agent.tts.codec : 'pcm_f32le', options: parsed,
          ...(purpose === 'tts' ? { voice: agent.voice } : {}), ...(purpose === 'vad' ? { threshold: agent.vad.threshold } : {}) });
        selected.push({ adapter, selection });
      }
    }
    return Object.freeze({ agent, open: async (budget: IAttemptAuthorizer, onSupplierUsage?: VoiceSupplierUsageSink): Promise<OpenedVoicePlan> => {
      const opened: Array<{ kind: VoiceAdapterKind; value: OpenedVoiceAdapter<VoiceAdapterKind>; runtime: VoiceAdapterRuntime }> = [];
      try {
        for (const entry of selected) {
          scope.signal.throwIfAborted(); const kind = entry.adapter.kind;
          const purpose = kind === 'streaming-stt' ? 'stt' : kind === 'streaming-tts' ? 'tts' : kind === 'vad-session' ? 'vad' : 'endpoint';
          const runtime = new VoiceAdapterRuntime(scope, entry.adapter.manifest.providerId, purpose, budget, { ...network, origin: entry.adapter.manifest.origin, credentialRef: entry.adapter.manifest.credentialRef, onSupplierUsage });
          const value = await entry.adapter.create(scope, entry.selection, runtime); opened.push({ kind, value, runtime });
          if (typeof value.fence !== 'function' || typeof value.dispose !== 'function') throw new Error('voice adapter lifetime refused');
        }
        const stt = opened.filter((p) => p.kind === 'streaming-stt').map((p) => p.value.value as OpenedVoiceAdapter<'streaming-stt'>['value']);
        const tts = opened.filter((p) => p.kind === 'streaming-tts').map((p) => p.value.value as OpenedVoiceAdapter<'streaming-tts'>['value']);
        if (stt.some((p) => !p.isStreaming || typeof p.startSession !== 'function') || tts.some((p) => typeof p.startSession !== 'function')) throw new Error('actual streaming capability refused');
        const vad = opened.find((p) => p.kind === 'vad-session')!.value.value as IVadSession;
        const endpoint = opened.find((p) => p.kind === 'audio-endpoint')!.value.value as IAudioEndpointDetector;
        if (typeof vad.pushAudio !== 'function' || typeof vad.reset !== 'function' || typeof vad.flush !== 'function' || typeof vad.dispose !== 'function' || typeof endpoint.pushAudio !== 'function' || typeof endpoint.pushVadEvent !== 'function' || typeof endpoint.pushTranscript !== 'function' || typeof endpoint.reset !== 'function' || typeof endpoint.dispose !== 'function') throw new Error('audio detector capability refused');
        const reconnecting = stt.map((provider) => {
          const retry = new ReconnectingSTT(provider);
          return new Proxy(provider, { get(target, key) {
            if (key === 'startSession') return retry.startSession.bind(retry);
            const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
          } });
        });
        return { stt: new StreamingSTTChain(reconnecting, { policy: scope.policy }), tts: new StreamingTTSChain(tts, { policy: scope.policy }), vad, endpoint,
          fenceSynthesis: async (generation) => {
            const synthesis = opened.filter((p) => p.kind === 'streaming-tts');
            for (const p of synthesis) p.runtime.fenceGeneration(generation);
            const proofs = await Promise.all(synthesis.map((p) => p.value.fence(generation)));
            await Promise.all(synthesis.map((p) => p.runtime.whenIdle()));
            if (proofs.some((p) => !p.stopped || !p.evidenceRef)) throw new Error('synthesis fence incomplete');
            return { stopped: true, evidenceRef: proofs.map((p) => p.evidenceRef).join(':') };
          },
          fence: async (generation) => { for (const p of opened) p.runtime.fenceGeneration(generation); const proofs = await Promise.all(opened.map((p) => p.value.fence(generation))); await Promise.all(opened.map((p) => p.runtime.whenIdle()));
            if (proofs.some((p) => p.stopped !== true || !p.evidenceRef)) throw new Error('voice fence incomplete'); return { stopped: true, evidenceRef: proofs.map((p) => p.evidenceRef).join(':') }; },
          dispose: async () => { const results = await Promise.allSettled(opened.map((p) => p.value.dispose())); if (results.some((r) => r.status === 'rejected')) throw new Error('voice disposal incomplete'); },
        };
      } catch (error) {
        const cleanup = await Promise.allSettled(opened.map(async (p) => { await p.value.dispose(); await p.runtime.whenIdle(); }));
        if (cleanup.some((r) => r.status === 'rejected')) throw new Error('voice initialization fence incomplete'); throw error;
      }
    } });
  }
  /** Resolves a scoped batch provider through the same registered options, credentials and request budget. */
  async resolveScopedBatch<K extends 'batch-stt' | 'batch-tts'>(kind: K, providerId: string, rawScope: VoiceScopeContext, selection: VoiceAdapterSelection,
    budget: IAttemptAuthorizer, network: VoiceNetworkDependencies = {}, onSupplierUsage?: VoiceSupplierUsageSink): Promise<OpenedVoiceAdapter<K>> {
    const scope = captureVoiceScope(rawScope); const adapter = this.voiceAdapters.get(`${kind}:${providerId}`);
    const purpose = kind === 'batch-stt' ? 'stt' : 'tts'; const permission = scope.policy.providers.find((p) => p.providerId === providerId && p.purposes.includes(purpose));
    if (!adapter || adapter.kind !== kind || !permission || !scope.policy.purposes.includes(purpose)) throw new Error('batch provider refused');
    const m = adapter.manifest;
    assertSpeechAvailable(m.providerId, m.modelId, Date.now(), scope.policy.mode);
    if (m.streaming || m.locality !== permission.locality || (scope.policy.mode === 'local' && m.locality !== 'local') || m.modelId !== selection.modelId || m.modelRevision !== selection.modelRevision || !m.languages.includes(selection.language) || !m.sampleRates.includes(selection.sampleRate) || !m.codecs.includes(selection.codec)) throw new Error('batch capability refused');
    if (kind === 'batch-tts' && (!selection.voice || !m.voices.some((voice) => voice.id === selection.voice!.id && voice.revision === selection.voice!.revision))) throw new Error('batch voice refused');
    if (m.origin) await checkDestination(m.origin, (scope.policy.mode === 'hosted' ? hostedEgressPolicy : localEgressPolicy)(), network.lookup);
    const parsed = freezeVoiceValue({ ...selection, options: z.record(z.string(), z.unknown()).parse(adapter.options.parse(selection.options)) });
    const runtime = new VoiceAdapterRuntime(scope, providerId, purpose, budget, { ...network, origin: m.origin, credentialRef: m.credentialRef, onSupplierUsage });
    const value = await adapter.create(scope, parsed, runtime) as OpenedVoiceAdapter<K>;
    return { value: value.value, fence: async (generation) => { runtime.fenceGeneration(generation); const proof = await value.fence(generation); await runtime.whenIdle(); if (!proof.stopped || !proof.evidenceRef) throw new Error('batch fence incomplete'); return proof; },
      dispose: async () => { await value.dispose(); await runtime.whenIdle(); } };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Core resolution algorithm shared by `resolveSTT()` and `resolveTTS()`.
   *
   * ## Algorithm
   *
   * **Path A — Preferred IDs provided:**
   * When `requirements.preferredIds` is set, iterate through the IDs in the
   * caller's specified order. For each ID, look up the registration and include
   * it only if it matches the kind, is configured, holds a provider instance,
   * and satisfies all other requirements. This preserves the caller's explicit ordering preference.
   *
   * **Path B — No preferred IDs:**
   * Return all configured providers of the requested kind that hold an
   * instance and match the requirements, sorted by ascending priority (lower = better). This is the
   * default path for most callers.
   *
   * @param kind - The provider kind to resolve ('stt', 'tts', etc.).
   * @param requirements - Optional filtering criteria.
   * @returns An ordered array of matching registrations (best first).
   *
   * @example
   * ```ts
   * // Internal usage — called by resolveSTT/resolveTTS:
   * const candidates = this.resolveByKind('stt', { streaming: true });
   * ```
   */
  private resolveByKind(
    kind: SpeechProviderKind,
    requirements?: ProviderRequirements
  ): ProviderRegistration[] {
    // Path A: explicit preferred ordering from the caller
    if (requirements?.preferredIds?.length) {
      const results: ProviderRegistration[] = [];
      for (const id of requirements.preferredIds) {
        const reg = this.registrations.get(SpeechProviderResolver.keyOf(kind, id));
        if (
          reg &&
          reg.kind === kind &&
          reg.isConfigured &&
          reg.provider != null &&
          this.matchesRequirements(reg, requirements)
        ) {
          results.push(reg);
        }
      }
      return results;
    }

    // Path B: all matching providers sorted by priority
    return this.listProviders(kind)
      .filter((r) => r.isConfigured && r.provider != null)
      .filter((r) => this.matchesRequirements(r, requirements));
  }

  /**
   * Check whether a registration satisfies the given requirements.
   *
   * Each requirement field is independently checked. A `undefined` requirement
   * field means "no constraint" — only explicitly set fields are enforced.
   * All specified fields must match for the provider to qualify.
   *
   * @param reg - The provider registration to test.
   * @param req - The requirements to match against. If `undefined`, all
   *   providers match.
   * @returns `true` if the registration satisfies all specified requirements.
   *
   * @example
   * ```ts
   * // Matches: streaming=true required, provider has streaming=true
   * this.matchesRequirements(reg, { streaming: true }); // true
   *
   * // Fails: feature 'diarization' required but provider only has ['cloud']
   * this.matchesRequirements(reg, { features: ['diarization'] }); // false
   * ```
   */
  private matchesRequirements(reg: ProviderRegistration, req?: ProviderRequirements): boolean {
    if (!req) return true;

    // Check streaming capability match
    // A catalog entry that does not say it streams counts as not streaming.
    if (req.streaming !== undefined && (reg.catalogEntry.streaming ?? false) !== req.streaming) return false;

    // Check local/cloud deployment match
    if (req.local !== undefined && reg.catalogEntry.local !== req.local) return false;

    // Check that the provider supports ALL requested features (AND semantics).
    // A 'streaming' feature is the streaming capability above, which the
    // provider instance can override, not the catalog's feature list: AssemblyAI's
    // catalog entry lists 'streaming', while its core provider uploads and polls.
    if (req.features?.length) {
      const providerFeatures = reg.catalogEntry.features ?? [];
      const streams = reg.catalogEntry.streaming ?? false;
      if (!req.features.every((f) => (f === 'streaming' ? streams : providerFeatures.includes(f)))) return false;
    }

    return true;
  }

  /**
   * Register providers from the static core catalog.
   *
   * Each provider is marked `isConfigured` based on whether ALL of its required
   * environment variables are set (non-empty). Providers with `available === false`
   * in the catalog are skipped entirely — they represent planned but not yet
   * implemented backends (e.g. NVIDIA NeMo, Bark).
   *
   * Core providers are registered with `priority: 100` and `source: 'core'`.
   * A core entry has no instance (`provider` is `null`): it records the id and
   * whether its keys are set. `SpeechRuntime` registers the instances it builds
   * under the same ids, and an id that already holds an instance is skipped, so
   * a refresh keeps it. The resolve methods skip entries without an instance.
   *
   * @example
   * ```ts
   * // Called internally by refresh():
   * this.registerCoreProviders();
   * ```
   */
  private registerCoreProviders(): void {
    /**
     * Static list of core provider definitions. Each entry maps a provider id
     * to its kind and the environment variables required for configuration.
     * Order here does not determine resolution order — that is controlled by
     * the priority system.
     */
    const coreProviders = [
      { id: 'openai-whisper', kind: 'stt' as const, envVars: ['OPENAI_API_KEY'] },
      { id: 'deepgram-batch', kind: 'stt' as const, envVars: ['DEEPGRAM_API_KEY'] },
      { id: 'assemblyai', kind: 'stt' as const, envVars: ['ASSEMBLYAI_API_KEY'] },
      {
        id: 'azure-speech-stt',
        kind: 'stt' as const,
        envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
      },
      { id: 'openai-tts', kind: 'tts' as const, envVars: ['OPENAI_API_KEY'] },
      { id: 'elevenlabs', kind: 'tts' as const, envVars: ['ELEVENLABS_API_KEY'] },
      { id: 'deepgram-aura', kind: 'tts' as const, envVars: ['DEEPGRAM_API_KEY'] },
      { id: 'minimax-tts', kind: 'tts' as const, envVars: ['MINIMAX_API_KEY'] },
      {
        id: 'azure-speech-tts',
        kind: 'tts' as const,
        envVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
      },
      { id: 'agentos-adaptive-vad', kind: 'vad' as const, envVars: [] as string[] },
    ];

    for (const def of coreProviders) {
      // Keep an instance that SpeechRuntime or an extension registered under this id.
      if (this.registrations.get(SpeechProviderResolver.keyOf(def.kind, def.id))?.provider) continue;

      const catalogEntry = findSpeechProviderCatalogEntry(def.id);
      // Skip providers not found in the catalog (should not happen, but defensive)
      if (!catalogEntry) continue;
      // Skip providers explicitly marked as unavailable (planned but unimplemented)
      if (catalogEntry.available === false) continue;

      // A provider is configured when it has no required env vars (e.g. local VAD)
      // or when ALL required env vars are present and non-empty.
      const isConfigured =
        def.envVars.length === 0 || def.envVars.every((v) => Boolean(this.env[v]));

      this.register({
        id: def.id,
        kind: def.kind,
        provider: null as any, // No instance: SpeechRuntime or an extension registers one under this id.
        catalogEntry,
        isConfigured,
        priority: 100,
        source: 'core',
      });
    }
  }

  /**
   * Read the speech providers an ExtensionManager lists as active, as
   * registrations for `refresh()` to register.
   *
   * Extension providers are registered with `priority: 200` (lower than core's
   * 100) so they serve as fallbacks unless the user explicitly boosts them via
   * `config.stt.preferred` / `config.tts.preferred`. Each is registered under
   * the provider's own `id` (the descriptor id when the provider has none), the
   * id preferred lists and `SpeechRuntime` use, and counts as configured: the
   * pack built the instance with its own options and secrets.
   *
   * The `extensionManager` parameter uses `any` because the ExtensionManager
   * type lives in the extensions package — importing it would create a circular
   * dependency. An `ExtensionManager` is read through
   * `getRegistry(kind).listActive()`; another object can expose
   * `getDescriptorsByKind(kind)` instead.
   *
   * @param extensionManager - An `ExtensionManager`, or an object exposing
   *   `getDescriptorsByKind(kind)`; either returns `{ id: string; payload: unknown }`
   *   descriptors.
   * @returns One registration per active descriptor that carries a provider.
   *
   * @example
   * ```ts
   * // Called internally by refresh():
   * const discovered = this.discoverExtensionProviders(extensionManager);
   * ```
   */
  private discoverExtensionProviders(extensionManager: any): ProviderRegistration[] {
    /**
     * Maps extension descriptor kind strings to the normalized
     * {@link SpeechProviderKind} used internally. Extensions use hyphenated
     * kind names with a `-provider` suffix.
     */
    const kindMap: Record<string, SpeechProviderKind> = {
      'stt-provider': 'stt',
      'tts-provider': 'tts',
      'vad-provider': 'vad',
      'wake-word-provider': 'wake-word',
    };

    const found: ProviderRegistration[] = [];
    for (const descriptorKind of Object.keys(kindMap)) {
      const kind = kindMap[descriptorKind] ?? 'stt';
      const descriptors: any[] =
        typeof extensionManager.getDescriptorsByKind === 'function'
          ? (extensionManager.getDescriptorsByKind(descriptorKind) ?? [])
          : typeof extensionManager.getRegistry === 'function'
            ? (extensionManager.getRegistry(descriptorKind)?.listActive?.() ?? [])
            : [];

      for (const desc of descriptors) {
        const provider = desc?.payload;
        if (!provider) continue;
        const id = typeof provider.id === 'string' && provider.id ? provider.id : desc.id;
        // Known providers keep their catalog entry (capabilities), when it is of
        // the same kind; others get a synthetic one. The provider's own
        // supportsStreaming, when it declares one, decides streaming.
        const listed = findSpeechProviderCatalogEntry(id);
        const entry: SpeechProviderCatalogEntry =
          listed?.kind === kind
            ? listed
            : { id, kind, label: id, envVars: [], local: false, description: '' };
        const catalogEntry =
          typeof provider.supportsStreaming === 'boolean'
            ? { ...entry, streaming: provider.supportsStreaming }
            : entry;

        found.push({
          id,
          kind,
          provider,
          catalogEntry,
          isConfigured: true,
          priority: 200, // Extensions rank below core by default
          source: 'extension',
        });
      }
    }
    return found;
  }

  /**
   * Remove the providers an earlier `refresh(extensionManager)` read that the
   * manager no longer lists as active (an unloaded pack or a deactivated
   * descriptor), so the resolve methods stop returning them. A registration
   * that now holds a different provider is left alone.
   *
   * @param discovered - The registrations read from the manager this refresh.
   */
  private dropProvidersNoLongerDiscovered(discovered: ProviderRegistration[]): void {
    const current = new Set(discovered.map((reg) => SpeechProviderResolver.keyOf(reg.kind, reg.id)));
    for (const [key, provider] of this.discovered) {
      if (!current.has(key) && this.registrations.get(key)?.provider === provider) {
        this.registrations.delete(key);
        this.basePriorities.delete(key);
      }
    }
  }

  /**
   * Boost priority for providers listed in `config.stt.preferred` /
   * `config.tts.preferred`.
   *
   * Earlier entries in the preferred array get lower priority numbers
   * (= higher priority). The sequence starts at 50, so the first preferred
   * provider gets priority 50, second gets 51, etc. This places them above
   * all core (100) and extension (200) providers but still allows the
   * priority to be numerically distinguished.
   *
   * @example
   * ```ts
   * // config.stt.preferred = ['assemblyai', 'openai-whisper']
   * // Result: assemblyai.priority = 50, openai-whisper.priority = 51
   * this.applyPreferredPriorities();
   * ```
   */
  private applyPreferredPriorities(): void {
    // Start from the registered priorities, so a provider dropped from a
    // preferred list does not keep the boost an earlier refresh gave it.
    for (const [key, reg] of this.registrations) {
      reg.priority = this.basePriorities.get(key) ?? reg.priority;
    }
    if (this.config?.stt?.preferred) {
      for (let i = 0; i < this.config.stt.preferred.length; i++) {
        const reg = this.registrations.get(SpeechProviderResolver.keyOf('stt', this.config.stt.preferred[i]));
        if (reg) reg.priority = 50 + i;
      }
    }
    if (this.config?.tts?.preferred) {
      for (let i = 0; i < this.config.tts.preferred.length; i++) {
        const reg = this.registrations.get(SpeechProviderResolver.keyOf('tts', this.config.tts.preferred[i]));
        if (reg) reg.priority = 50 + i;
      }
    }
  }
}
