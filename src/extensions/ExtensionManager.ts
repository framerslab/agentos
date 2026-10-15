import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ExtensionRegistry } from './ExtensionRegistry';
import { SharedServiceRegistry } from './SharedServiceRegistry';
import type {
  ExtensionDescriptor,
  ExtensionKind,
  ExtensionLifecycleContext,
} from './types';
import type {
  ExtensionEventListener,
  ExtensionDescriptorEvent,
  ExtensionPackEvent,
} from './events';
import type {
  ExtensionManifest,
  ExtensionPack,
  ExtensionPackContext,
  ExtensionPackManifestEntry,
  ExtensionOverrides,
  DescriptorOverride,
} from './manifest';
import {
  EXTENSION_KIND_WORKFLOW_EXECUTOR,
  EXTENSION_KIND_PLANNING_STRATEGY,
  EXTENSION_KIND_HITL_HANDLER,
  EXTENSION_KIND_COMM_CHANNEL,
  EXTENSION_KIND_MEMORY_PROVIDER,
  EXTENSION_KIND_MESSAGING_CHANNEL,
  EXTENSION_KIND_PROVENANCE,
  EXTENSION_KIND_STT_PROVIDER,
  EXTENSION_KIND_TTS_PROVIDER,
  EXTENSION_KIND_VAD_PROVIDER,
  EXTENSION_KIND_WAKE_WORD_PROVIDER,
} from './types';
import { getSecretDefinition } from '../core/config/extensionSecrets';
import { EXTENSION_KIND_STREAMING_STT, EXTENSION_KIND_STREAMING_TTS, EXTENSION_KIND_VAD_SESSION, EXTENSION_KIND_AUDIO_ENDPOINT } from './types.js';
import { isScopedVoiceAdapter, type ScopedVoiceAdapter } from '../io/speech/VoiceAdapter.js';

const DEFAULT_EXTENSIONS_KIND_TOOL = 'tool';
const DEFAULT_EXTENSIONS_KIND_GUARDRAIL = 'guardrail';
const DEFAULT_EXTENSIONS_KIND_RESPONSE = 'response-processor';
const DEFAULT_EXTENSIONS_KIND_WORKFLOW = 'workflow';
const DEFAULT_EXTENSIONS_KIND_WORKFLOW_EXECUTOR = EXTENSION_KIND_WORKFLOW_EXECUTOR;
// New extension kinds (v1.1.0)
const DEFAULT_EXTENSIONS_KIND_PLANNING = EXTENSION_KIND_PLANNING_STRATEGY;
const DEFAULT_EXTENSIONS_KIND_HITL = EXTENSION_KIND_HITL_HANDLER;
const DEFAULT_EXTENSIONS_KIND_COMM = EXTENSION_KIND_COMM_CHANNEL;
const DEFAULT_EXTENSIONS_KIND_MEMORY = EXTENSION_KIND_MEMORY_PROVIDER;
const DEFAULT_EXTENSIONS_KIND_PROVENANCE = EXTENSION_KIND_PROVENANCE;
const DEFAULT_EXTENSIONS_KIND_STT = EXTENSION_KIND_STT_PROVIDER;
const DEFAULT_EXTENSIONS_KIND_TTS = EXTENSION_KIND_TTS_PROVIDER;
const DEFAULT_EXTENSIONS_KIND_VAD = EXTENSION_KIND_VAD_PROVIDER;
const DEFAULT_EXTENSIONS_KIND_WAKE_WORD = EXTENSION_KIND_WAKE_WORD_PROVIDER;

interface ExtensionManagerOptions {
  manifest?: ExtensionManifest;
  secrets?: Record<string, string>;
  overrides?: ExtensionOverrides;
}

/**
 * Coordinates discovery and lifecycle management for extension packs. Packs
 * emit descriptors which are registered into kind-specific registries.
 */
export class ExtensionManager {
  private readonly emitter = new EventEmitter();
  private readonly registries: Map<ExtensionKind, ExtensionRegistry<unknown>> = new Map();
  private readonly options: ExtensionManagerOptions;
  private readonly overrides?: ExtensionOverrides;
  private readonly secrets = new Map<string, string>();
  private readonly services = new SharedServiceRegistry();
  private readonly loadedPacks: ExtensionPack[] = [];
  private readonly loadedPackKeys = new Set<string>();
  private readonly loadedPackRecords: Array<{
    key: string;
    name: string;
    version?: string;
    identifier?: string;
    packageName?: string;
    module?: string;
    loadedAt: string;
  }> = [];

  constructor(options: ExtensionManagerOptions = {}) {
    this.options = options;
    if (options.secrets) {
      for (const [key, value] of Object.entries(options.secrets)) {
        if (value) {
          this.secrets.set(key, value);
        }
      }
    }
    this.overrides = mergeOverrides(options.manifest?.overrides, options.overrides);
    this.ensureDefaultRegistries();
  }

  /**
    * Loads packs defined in the manifest, registering their descriptors in the
    * appropriate registries. Supports factory-based packs as well as resolving
    * packs from `package` and `module` manifest entries.
    */
  public async loadManifest(context?: ExtensionLifecycleContext): Promise<void> {
    const manifest = this.options.manifest;
    if (!manifest) {
      return;
    }

    for (const entry of manifest.packs) {
      await this.loadPackEntry(entry, context);
    }
  }

  /**
   * Registers a listener for extension lifecycle events.
   */
  public on(listener: ExtensionEventListener): void {
    this.emitter.on('event', listener);
  }

  public off(listener: ExtensionEventListener): void {
    this.emitter.off('event', listener);
  }

  /**
   * Directly loads a pack instance (typically produced by an inline factory)
   * and registers all of its descriptors.
   */
  public async loadPackFromFactory(
    pack: ExtensionPack,
    identifier?: string,
    options?: Record<string, unknown>,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<void> {
    const entry: ExtensionPackManifestEntry = {
      factory: async () => pack,
      identifier,
      options,
    };

    const outcome = await this.loadPackEntry(entry, lifecycleContext);
    if (!outcome.loaded) {
      if (outcome.skipped && outcome.reason === 'already_loaded') {
        return;
      }
      const err = outcome.skipped ? new Error(outcome.reason || 'Unknown extension pack load failure') : outcome.error;
      throw err;
    }
  }

  /**
   * Load a single manifest entry at runtime, applying the same resolution,
   * secret hydration, registration, and event emission logic as {@link loadManifest}.
   *
   * This enables schema-on-demand / lazy-loading flows where an agent can
   * enable an extension pack mid-session.
   */
  public async loadPackEntry(
    entry: ExtensionPackManifestEntry,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<
    | { loaded: true; key: string; pack: { name: string; version?: string; identifier?: string } }
    | { loaded: false; skipped: true; reason: 'disabled' | 'already_loaded' | 'unresolved'; key?: string }
    | { loaded: false; skipped: false; reason: 'failed'; key?: string; error: Error; sourceName: string }
  > {
    if (entry.enabled === false) {
      return { loaded: false, skipped: true, reason: 'disabled' };
    }

    const preKey = this.resolvePackKey(entry);
    if (preKey && this.loadedPackKeys.has(preKey)) {
      return { loaded: false, skipped: true, reason: 'already_loaded', key: preKey };
    }

    try {
      this.hydrateSecretsFromPackEntry(entry);
      const pack = await this.resolvePack(entry, lifecycleContext);
      if (!pack) {
        return { loaded: false, skipped: true, reason: 'unresolved', key: preKey ?? undefined };
      }

      const key = this.resolvePackKey(entry, pack);
      if (key && this.loadedPackKeys.has(key)) {
        return { loaded: false, skipped: true, reason: 'already_loaded', key };
      }

      await this.registerPack(pack, entry, lifecycleContext);

      if (key) {
        this.loadedPackKeys.add(key);
        this.loadedPackRecords.push({
          key,
          name: pack.name,
          version: pack.version ?? undefined,
          identifier: entry.identifier,
          packageName: 'package' in entry ? entry.package : undefined,
          module: 'module' in entry ? entry.module : undefined,
          loadedAt: new Date().toISOString(),
        });
      }

      this.emitPackEvent({
        type: 'pack:loaded',
        timestamp: new Date().toISOString(),
        source: {
          sourceName: pack.name,
          sourceVersion: pack.version,
          identifier: entry.identifier,
        },
      });

      return {
        loaded: true,
        key: key ?? pack.name,
        pack: { name: pack.name, version: pack.version ?? undefined, identifier: entry.identifier ?? undefined },
      };
    } catch (error) {
      const sourceName =
        'package' in entry
          ? entry.package
          : 'module' in entry
          ? entry.module
          : entry.identifier ?? 'inline-pack';
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitPackEvent({
        type: 'pack:failed',
        timestamp: new Date().toISOString(),
        source: {
          sourceName,
          identifier: entry.identifier,
        },
        error: err,
      });
      return { loaded: false, skipped: false, reason: 'failed', key: preKey ?? undefined, error: err, sourceName };
    }
  }

  /**
   * Convenience: load an extension pack by npm package name at runtime.
   */
  public async loadPackFromPackage(
    packageName: string,
    options?: Record<string, unknown>,
    identifier?: string,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<
    | { loaded: true; key: string; pack: { name: string; version?: string; identifier?: string } }
    | { loaded: false; skipped: true; reason: 'disabled' | 'already_loaded' | 'unresolved'; key?: string }
    | { loaded: false; skipped: false; reason: 'failed'; key?: string; error: Error; sourceName: string }
  > {
    const entry: ExtensionPackManifestEntry = {
      package: packageName,
      identifier: identifier ?? `runtime:${packageName}`,
      options,
    };
    return this.loadPackEntry(entry, lifecycleContext);
  }

  /**
   * Convenience: load an extension pack by local module specifier at runtime.
   */
  public async loadPackFromModule(
    moduleSpecifier: string,
    options?: Record<string, unknown>,
    identifier?: string,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<
    | { loaded: true; key: string; pack: { name: string; version?: string; identifier?: string } }
    | { loaded: false; skipped: true; reason: 'disabled' | 'already_loaded' | 'unresolved'; key?: string }
    | { loaded: false; skipped: false; reason: 'failed'; key?: string; error: Error; sourceName: string }
  > {
    const entry: ExtensionPackManifestEntry = {
      module: moduleSpecifier,
      identifier: identifier ?? `runtime:${moduleSpecifier}`,
      options,
    };
    return this.loadPackEntry(entry, lifecycleContext);
  }

  /**
   * List pack metadata for packs loaded during this process lifetime.
   */
  public listLoadedPacks(): Array<{
    key: string;
    name: string;
    version?: string;
    identifier?: string;
    packageName?: string;
    module?: string;
    loadedAt: string;
  }> {
    return [...this.loadedPackRecords];
  }

  /**
   * Provides the registry for a particular kind, creating it if necessary.
   */
  public getRegistry<TPayload>(kind: ExtensionKind): ExtensionRegistry<TPayload> {
    let registry = this.registries.get(kind) as ExtensionRegistry<TPayload> | undefined;
    if (!registry) {
      registry = new ExtensionRegistry<TPayload>(kind);
      this.registries.set(kind, registry as ExtensionRegistry<unknown>);
    }
    return registry;
  }

  /** Lists active scoped factories only, without invoking them or reading a process credential. */
  public getVoiceAdapters(): ScopedVoiceAdapter[] {
    const result: ScopedVoiceAdapter[] = [];
    const kinds = [EXTENSION_KIND_STREAMING_STT, EXTENSION_KIND_STREAMING_TTS, EXTENSION_KIND_VAD_SESSION, EXTENSION_KIND_AUDIO_ENDPOINT, EXTENSION_KIND_STT_PROVIDER, EXTENSION_KIND_TTS_PROVIDER];
    const expected = ['streaming-stt', 'streaming-tts', 'vad-session', 'audio-endpoint', 'batch-stt', 'batch-tts'];
    for (let i = 0; i < kinds.length; i++) for (const descriptor of this.getRegistry<unknown>(kinds[i]!).listActive()) {
      const payload = descriptor.payload;
      if (!payload || typeof payload !== 'object' || !('voiceAdapterVersion' in payload)) continue;
      if (!isScopedVoiceAdapter(payload) || payload.kind !== expected[i] || descriptor.id !== payload.manifest.providerId || descriptor.requiredSecrets?.some((s) => !s.optional)) throw new Error('scoped voice descriptor refused');
      result.push(payload);
    }
    return result;
  }

  /**
   * Deactivates all loaded descriptors and extension packs.
   *
   * This is intentionally best-effort: one failing deactivation should not
   * prevent other packs/descriptors from shutting down.
   */
  public async shutdown(context?: ExtensionLifecycleContext): Promise<void> {
    const lifecycleContext = this.enrichLifecycleContext(context);

    for (const registry of this.registries.values()) {
      await registry.clear(lifecycleContext).catch((err) => {
        console.warn(`ExtensionManager: Failed clearing registry during shutdown`, err);
      });
    }

    for (const pack of [...this.loadedPacks].reverse()) {
      try {
        await pack.onDeactivate?.(lifecycleContext);
      } catch (err) {
        console.warn(`ExtensionManager: Pack '${pack.name}' onDeactivate failed`, err);
      }
    }

    this.loadedPacks.length = 0;
    this.loadedPackKeys.clear();
    this.loadedPackRecords.length = 0;
    await this.services.releaseAll().catch((err) => {
      console.warn(`ExtensionManager: Failed releasing shared services during shutdown`, err);
    });
  }

  private ensureDefaultRegistries(): void {
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_TOOL);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_GUARDRAIL);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_RESPONSE);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_WORKFLOW);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_WORKFLOW_EXECUTOR);
    // New extension registries (v1.1.0)
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_PLANNING);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_HITL);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_COMM);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_MEMORY);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_STT);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_TTS);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_VAD);
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_WAKE_WORD);
    this.getRegistry(EXTENSION_KIND_STREAMING_STT);
    this.getRegistry(EXTENSION_KIND_STREAMING_TTS);
    this.getRegistry(EXTENSION_KIND_VAD_SESSION);
    this.getRegistry(EXTENSION_KIND_AUDIO_ENDPOINT);
    // Messaging Channels — external human-facing platforms (v1.3.0)
    this.getRegistry(EXTENSION_KIND_MESSAGING_CHANNEL);
    // Provenance & Audit (v1.2.0)
    this.getRegistry(DEFAULT_EXTENSIONS_KIND_PROVENANCE);
  }

  private resolvePackKey(entry: ExtensionPackManifestEntry, pack?: ExtensionPack): string | null {
    if (entry.identifier && String(entry.identifier).trim()) {
      return `id:${String(entry.identifier).trim()}`;
    }
    if ('package' in entry && typeof entry.package === 'string' && entry.package.trim()) {
      return `pkg:${entry.package.trim()}`;
    }
    if ('module' in entry && typeof entry.module === 'string' && entry.module.trim()) {
      return `mod:${entry.module.trim()}`;
    }
    if (pack?.name && typeof pack.name === 'string' && pack.name.trim()) {
      return `name:${pack.name.trim()}`;
    }
    return null;
  }

  private async resolvePack(
    entry: ExtensionPackManifestEntry,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<ExtensionPack | null> {
    if ('factory' in entry && typeof entry.factory === 'function') {
      return await entry.factory();
    }

    const ctx = this.enrichLifecycleContext(lifecycleContext);

    if ('package' in entry && typeof entry.package === 'string' && entry.package.trim()) {
      const mod = await import(entry.package);
      return this.resolvePackFromModule(mod, entry, ctx);
    }

    if ('module' in entry && typeof entry.module === 'string' && entry.module.trim()) {
      const spec = normalizeModuleSpecifier(entry.module);
      const mod = await import(spec);
      return this.resolvePackFromModule(mod, entry, ctx);
    }

    return null;
  }

  private resolvePackFromModule(
    mod: any,
    entry: ExtensionPackManifestEntry,
    lifecycleContext: ExtensionLifecycleContext,
  ): ExtensionPack {
    const factory = mod?.createExtensionPack ?? mod?.default?.createExtensionPack ?? mod?.default;
    if (typeof factory === 'function') {
      const packContext: ExtensionPackContext = {
        manifestEntry: entry,
        options: entry.options,
        logger: lifecycleContext.logger,
        getSecret: lifecycleContext.getSecret,
        services: lifecycleContext.services,
      };
      return factory(packContext) as ExtensionPack;
    }

    const candidate = mod?.default ?? mod;
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.name === 'string' &&
      Array.isArray(candidate.descriptors)
    ) {
      return candidate as ExtensionPack;
    }

    const source =
      'package' in entry ? entry.package : 'module' in entry ? entry.module : entry.identifier ?? 'unknown';
    throw new Error(
      `ExtensionManager: Failed to resolve pack from ${source} — expected createExtensionPack() or a default ExtensionPack export.`,
    );
  }

  private async registerPack(
    pack: ExtensionPack,
    entry: ExtensionPackManifestEntry,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<void> {
    const enrichedLifecycleContext = this.enrichLifecycleContext(lifecycleContext);

    let packActivated = false;
    // Pack-level lifecycle hook (used by several curated packs for initialization).
    await pack.onActivate?.(enrichedLifecycleContext);
    packActivated = true;

    const ctx: ExtensionPackContext = {
      manifestEntry: entry,
      source: {
        sourceName: pack.name,
        sourceVersion: pack.version,
        identifier: entry.identifier,
      },
      options: entry.options,
      logger: enrichedLifecycleContext.logger,
      getSecret: enrichedLifecycleContext.getSecret,
      services: enrichedLifecycleContext.services,
    };

    try {
      for (const descriptor of pack.descriptors) {
        await this.registerDescriptor(descriptor, ctx, lifecycleContext);
      }
      this.loadedPacks.push(pack);
    } catch (err) {
      // Best-effort cleanup to avoid leaking resources for partially-registered packs.
      if (packActivated) {
        try {
          await pack.onDeactivate?.(enrichedLifecycleContext);
        } catch (cleanupErr) {
          console.warn(`ExtensionManager: Pack '${pack.name}' onDeactivate failed after registration error`, cleanupErr);
        }
      }
      throw err;
    }
  }

  private async registerDescriptor(
    descriptor: ExtensionDescriptor,
    ctx: ExtensionPackContext,
    lifecycleContext?: ExtensionLifecycleContext,
  ): Promise<void> {
    const override = this.resolveOverride(descriptor.kind, descriptor.id);
    if (override?.enabled === false) {
      ctx.logger?.info?.(
        `ExtensionManager: Skipping descriptor '${descriptor.id}' (${descriptor.kind}) due to override`,
      );
      return;
    }

    if (descriptor.requiredSecrets?.length) {
      const missing = descriptor.requiredSecrets.filter((req) => !this.resolveSecret(req.id));
      const blocking = missing.filter((req) => !req.optional);
      if (blocking.length > 0) {
        console.warn(
          `ExtensionManager: Skipping descriptor '${descriptor.id}' (${descriptor.kind}) because required secrets are missing: ${blocking
            .map((req) => req.id)
            .join(', ')}`,
        );
        return;
      }
    }

    const registry = this.getRegistry(descriptor.kind);
    const payloadDescriptor = {
      ...descriptor,
      priority: override?.priority ?? descriptor.priority ?? ctx.manifestEntry?.priority ?? 0,
      source: descriptor.source ?? ctx.source,
    };
    await registry.register(payloadDescriptor, this.enrichLifecycleContext(lifecycleContext));
    this.emitDescriptorEvent({
      type: 'descriptor:activated',
      timestamp: new Date().toISOString(),
      kind: descriptor.kind,
      descriptor: payloadDescriptor,
    });
  }

  private enrichLifecycleContext(
    context?: ExtensionLifecycleContext,
  ): ExtensionLifecycleContext {
    return {
      ...(context ?? {}),
      getSecret: (id: string) => this.resolveSecret(id),
      services: context?.services ?? this.services,
    };
  }

  private resolveSecret(id: string): string | undefined {
    const direct = this.secrets.get(id);
    if (direct) {
      return direct;
    }

    // Fall back to environment variables for known secret ids.
    const definition = getSecretDefinition(id);
    const envVar = definition?.envVar;
    const envValue = envVar && typeof process !== 'undefined' ? process.env?.[envVar] : undefined;
    if (typeof envValue === 'string' && envValue.trim()) {
      return envValue;
    }

    return undefined;
  }

  private resolveOverride(kind: ExtensionKind, id: string): DescriptorOverride | undefined {
    if (!this.overrides) {
      return undefined;
    }

    // Overrides are currently supported for tools, guardrails, and response processors.
    if (kind === DEFAULT_EXTENSIONS_KIND_TOOL) {
      return this.overrides.tools?.[id];
    }
    if (kind === DEFAULT_EXTENSIONS_KIND_GUARDRAIL) {
      return this.overrides.guardrails?.[id];
    }
    if (kind === DEFAULT_EXTENSIONS_KIND_RESPONSE) {
      return this.overrides.responses?.[id];
    }

    return undefined;
  }

  private hydrateSecretsFromPackEntry(entry: ExtensionPackManifestEntry): void {
    const opts = entry.options as Record<string, unknown> | undefined;
    const secrets = opts?.secrets;
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
      return;
    }

    for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      // Allow explicit ExtensionManager.secrets to win over per-pack secrets.
      if (!this.secrets.has(key)) {
        this.secrets.set(key, trimmed);
      }
    }
  }

  private emitDescriptorEvent(event: ExtensionDescriptorEvent): void {
    this.emitter.emit('event', event);
  }

  private emitPackEvent(event: ExtensionPackEvent): void {
    this.emitter.emit('event', event);
  }
}

function mergeOverrides(base?: ExtensionOverrides, extra?: ExtensionOverrides): ExtensionOverrides | undefined {
  if (!base && !extra) {
    return undefined;
  }

  const merged: ExtensionOverrides = {
    tools: { ...(base?.tools ?? {}) },
    guardrails: { ...(base?.guardrails ?? {}) },
    responses: { ...(base?.responses ?? {}) },
  };

  for (const [key, value] of Object.entries(extra?.tools ?? {})) {
    merged.tools![key] = { ...(merged.tools![key] ?? {}), ...value };
  }
  for (const [key, value] of Object.entries(extra?.guardrails ?? {})) {
    merged.guardrails![key] = { ...(merged.guardrails![key] ?? {}), ...value };
  }
  for (const [key, value] of Object.entries(extra?.responses ?? {})) {
    merged.responses![key] = { ...(merged.responses![key] ?? {}), ...value };
  }

  return merged;
}

function normalizeModuleSpecifier(raw: string): string {
  const spec = raw.trim();
  if (!spec) return spec;
  if (spec.startsWith('file://')) return spec;

  // Support workspace-relative paths for convenience.
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const abs = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
    return pathToFileURL(abs).href;
  }

  return spec;
}
