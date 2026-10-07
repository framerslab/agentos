/**
 * @file model.ts
 * Provider resolution utilities for the AgentOS high-level API.
 *
 * This module is responsible for parsing `provider:model` strings, resolving
 * credentials from environment variables or caller overrides, and constructing
 * an {@link AIModelProviderManager} ready for use by {@link generateText} and
 * {@link streamText}.
 */
import { AIModelProviderManager } from '../core/llm/providers/AIModelProviderManager.js';
import { PROVIDER_DEFAULTS, autoDetectProvider } from './runtime/provider-defaults.js';
import { getDefaultProvider } from './runtime/global-default.js';

/**
 * The result of splitting a `provider:model` string at the first colon.
 * Produced by {@link parseModelString}.
 */
export interface ParsedModel {
  /** The provider identifier (e.g. `"openai"`, `"anthropic"`, `"ollama"`). */
  providerId: string;
  /** The model identifier within the provider (e.g. `"gpt-4o"`, `"llama3.2"`). */
  modelId: string;
}

/**
 * A fully resolved provider configuration including optional credentials.
 * Produced by `resolveProvider()` and `resolveMediaProvider()`.
 */
export interface ResolvedProvider {
  /** Canonical provider identifier after any fallback remapping (e.g. anthropic → openrouter). */
  providerId: string;
  /** Model identifier, potentially rewritten for the remapped provider. */
  modelId: string;
  /** API key to use. Absent for providers that rely solely on a base URL (e.g. Ollama). */
  apiKey?: string;
  /** Base URL override forwarded to the provider SDK. */
  baseUrl?: string;
}

const ENV_KEY_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  stability: 'STABILITY_API_KEY',
  replicate: 'REPLICATE_API_TOKEN',
  fal: 'FAL_API_KEY',
  bfl: 'BFL_API_KEY',
};

const ENV_URL_MAP: Record<string, string> = {
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  stability: 'STABILITY_BASE_URL',
  replicate: 'REPLICATE_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  'stable-diffusion-local': 'STABLE_DIFFUSION_LOCAL_BASE_URL',
};

const KEYLESS_PROVIDER_IDS = new Set(['claude-code-cli', 'gemini-cli']);

/**
 * The provider id a `provider:model` string names, when its prefix is a key of
 * {@link PROVIDER_DEFAULTS}; undefined for a plain id and for a colon whose
 * prefix is not a provider (`qwen2.5:7b`, `meta-llama/llama-3.3-70b-instruct:free`).
 *
 * @param model - A model id, possibly `provider:model`.
 * @returns The provider id, or undefined.
 */
export function knownProviderPrefixOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const colon = model.indexOf(':');
  if (colon <= 0 || colon === model.length - 1) return undefined;
  const prefix = model.slice(0, colon);
  return Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, prefix) ? prefix : undefined;
}

/**
 * Splits a `provider:model` string into its constituent parts.
 *
 * The format is strict: the provider portion must be non-empty, separated from
 * the model portion by exactly one colon, and the model portion must also be
 * non-empty.
 *
 * @param model - A `provider:model` string such as `"openai:gpt-4o"`,
 *   `"ollama:llama3.2"`, or `"openrouter:anthropic/claude-sonnet-4-6"`.
 * @returns A `ParsedModel` with `providerId` and `modelId` fields.
 * @throws {Error} When the string is missing, not a string, or does not match
 *   the expected `provider:model` format.
 */
export function parseModelString(model: string): ParsedModel {
  if (!model || typeof model !== 'string') {
    throw new Error('Invalid model string. Expected "provider:model" (e.g. "openai:gpt-4o").');
  }
  const colonIdx = model.indexOf(':');
  if (colonIdx <= 0 || colonIdx === model.length - 1) {
    throw new Error(`Invalid model "${model}". Expected "provider:model" (e.g. "openai:gpt-4o").`);
  }
  return {
    providerId: model.slice(0, colonIdx),
    modelId: model.slice(colonIdx + 1),
  };
}

/**
 * Resolves a complete provider configuration for LLM text providers.
 *
 * Reads API keys and base URLs from well-known environment variables
 * (e.g. `OPENAI_API_KEY`, `OLLAMA_BASE_URL`) and merges caller-supplied
 * `overrides`.  Applies the Anthropic → OpenRouter fallback when
 * `ANTHROPIC_API_KEY` is absent but `OPENROUTER_API_KEY` is set.
 *
 * @param providerId - Provider identifier (e.g. `"openai"`, `"anthropic"`, `"ollama"`).
 * @param modelId - Model identifier within the provider.
 * @param overrides - Optional explicit API key and/or base URL that take precedence
 *   over environment variable lookups.
 * @returns A `ResolvedProvider` ready for `createProviderManager()`.
 * @throws {Error} When no credentials can be resolved for the given provider.
 */
export function resolveProvider(
  providerId: string,
  modelId: string,
  overrides?: { apiKey?: string; baseUrl?: string }
): ResolvedProvider {
  // Global-default credentials apply when their `provider` matches the
  // provider being resolved (or when no provider was pinned in the
  // default — in which case the default's apiKey is treated as
  // applicable to whichever provider the auto-detect chain picked).
  const def = getDefaultProvider();
  const defAppliesToThisProvider = def && (!def.provider || def.provider === providerId);
  const defApiKey = defAppliesToThisProvider ? def?.apiKey : undefined;
  const defBaseUrl = defAppliesToThisProvider ? def?.baseUrl : undefined;

  const apiKey =
    overrides?.apiKey ??
    defApiKey ??
    (ENV_KEY_MAP[providerId] ? process.env[ENV_KEY_MAP[providerId]] : undefined);
  const baseUrl =
    overrides?.baseUrl ??
    defBaseUrl ??
    (ENV_URL_MAP[providerId] ? process.env[ENV_URL_MAP[providerId]] : undefined);

  if (providerId === 'ollama') {
    if (!baseUrl) {
      throw new Error(`No base URL for ollama. Set OLLAMA_BASE_URL or pass baseUrl.`);
    }
    return { providerId, modelId, baseUrl };
  }

  if (KEYLESS_PROVIDER_IDS.has(providerId)) {
    return { providerId, modelId };
  }

  // Anthropic fallback: when ANTHROPIC_API_KEY is missing, fall back to OpenRouter
  // if available. This is a convenience — OpenRouter proxies Anthropic models.
  if (providerId === 'anthropic' && !apiKey) {
    const orKey = process.env['OPENROUTER_API_KEY'];
    if (orKey) {
      // Anthropic's native API takes dated model IDs (e.g. "claude-haiku-4-5-20251001").
      // OpenRouter exposes Anthropic models under dateless slugs (e.g. "anthropic/claude-haiku-4-5").
      // Strip a trailing -YYYYMMDD release-date suffix when remapping so the OR call resolves.
      const orModelId = modelId.replace(/-\d{8}$/, '');
      console.warn(
        `[AgentOS] ANTHROPIC_API_KEY not set — falling back to OpenRouter for model "${modelId}" ` +
        `(routed as "anthropic/${orModelId}"). Set ANTHROPIC_API_KEY for direct access.`
      );
      return { providerId: 'openrouter', modelId: `anthropic/${orModelId}`, apiKey: orKey };
    }
    throw new Error(`No API key for anthropic. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.`);
  }

  if (!apiKey) {
    const envVar = ENV_KEY_MAP[providerId] ?? `${providerId.toUpperCase()}_API_KEY`;
    throw new Error(`No API key for ${providerId}. Set ${envVar} or pass apiKey.`);
  }

  return { providerId, modelId, apiKey, baseUrl };
}

/**
 * Resolves a provider configuration for image and other media providers.
 *
 * Behaves like {@link resolveProvider} but relaxes the API-key requirement:
 * when the provider is not listed in the known key map, the call succeeds
 * without a key (allowing custom or keyless providers).  Ollama still
 * requires a `baseUrl`.
 *
 * @param providerId - Provider identifier (e.g. `"stability"`, `"replicate"`, `"ollama"`).
 * @param modelId - Model identifier within the provider.
 * @param overrides - Optional explicit API key and/or base URL overrides.
 * @returns A `ResolvedProvider` ready for use with an image provider factory.
 * @throws {Error} When a known provider is missing its required API key or base URL.
 */
export function resolveMediaProvider(
  providerId: string,
  modelId: string,
  overrides?: { apiKey?: string; baseUrl?: string }
): ResolvedProvider {
  // The global default's credentials apply when it names this provider, as
  // in resolveProvider. A default without a provider does not lend its key
  // here: media calls auto-detect across vendors (Stability, Replicate, ...)
  // and would send that key to the wrong one.
  const def = getDefaultProvider();
  const defAppliesToThisProvider = def?.provider === providerId;
  const apiKey =
    overrides?.apiKey ??
    (defAppliesToThisProvider ? def?.apiKey : undefined) ??
    (ENV_KEY_MAP[providerId] ? process.env[ENV_KEY_MAP[providerId]] : undefined);
  const baseUrl =
    overrides?.baseUrl ??
    (defAppliesToThisProvider ? def?.baseUrl : undefined) ??
    (ENV_URL_MAP[providerId] ? process.env[ENV_URL_MAP[providerId]] : undefined);

  if (providerId === 'ollama') {
    if (!baseUrl) {
      throw new Error(`No base URL for ollama. Set OLLAMA_BASE_URL or pass baseUrl.`);
    }
    return { providerId, modelId, baseUrl };
  }

  if (providerId === 'stable-diffusion-local') {
    if (!baseUrl) {
      throw new Error(
        `No base URL for stable-diffusion-local. Set STABLE_DIFFUSION_LOCAL_BASE_URL or pass baseUrl.`
      );
    }
    return { providerId, modelId, baseUrl };
  }

  const envVar = ENV_KEY_MAP[providerId];
  if (envVar && !apiKey) {
    throw new Error(`No API key for ${providerId}. Set ${envVar} or pass apiKey.`);
  }

  return { providerId, modelId, apiKey, baseUrl };
}

// ---------------------------------------------------------------------------
// Provider-first resolution (new API surface)
// ---------------------------------------------------------------------------

/**
 * Supported task types used when looking up a provider's default model.
 *
 * - `"text"` — text completion / chat (generateText, streamText, agent)
 * - `"image"` — image generation (generateImage)
 * - `"embedding"` — embedding generation
 */
export type TaskType = 'text' | 'image' | 'embedding';

/**
 * Flexible model option accepted by the high-level API functions.
 *
 * At least one of `provider` or `model` must be supplied, or an appropriate
 * API key environment variable must be set for auto-detection.
 */
export interface ModelOption {
  /**
   * Provider name.  When set without `model`, the default model for the
   * requested task is looked up in {@link PROVIDER_DEFAULTS}.
   *
   * @example `"openai"`, `"anthropic"`, `"ollama"`
   */
  provider?: string;
  /**
   * Explicit model identifier.  Accepted in two formats:
   * - `"provider:model"` (e.g. `"openai:gpt-4o"`), split only when the prefix
   *   is a provider id agentos knows; the prefix then wins over `provider`.
   *   Under `provider: 'ollama'` an id is never split (Ollama tags carry
   *   colons: `"qwen2.5:7b"`), and an id whose prefix is not a provider
   *   (`"meta-llama/llama-3.3-70b-instruct:free"`) is kept whole.
   * - `"model"` — plain name (e.g. `"gpt-4o-mini"`).  Requires `provider` or env-var auto-detect.
   */
  model?: string;
  /** API key override (takes precedence over environment variables). */
  apiKey?: string;
  /** Base URL override (useful for local proxies or Ollama). */
  baseUrl?: string;
}

/**
 * Resolves a `{ providerId, modelId }` pair from flexible caller-supplied options.
 *
 * Resolution priority:
 * 1. **Explicit `model` string** — a `provider:model` id is split when its
 *    prefix is a known provider id (a key of {@link PROVIDER_DEFAULTS}),
 *    whatever `provider` says, except under `provider: 'ollama'`, where an id
 *    is never split. Any other id is kept whole: with `provider` set, the pair
 *    is used as-is; without it, auto-detection from env vars is attempted.
 * 2. **`provider` only** — default model for the requested `task` is looked up
 *    in {@link PROVIDER_DEFAULTS}.
 * 3. **Neither** — auto-detect the first provider with a set API key/URL env
 *    var and use its default model for the requested `task`.
 *
 * @param opts - Caller options containing optional `provider` and/or `model`.
 * @param task - Task type used to select the correct default model. Defaults to `"text"`.
 * @returns A `ParsedModel` with `providerId` and `modelId`.
 * @throws {Error} When no provider can be determined, the provider is unknown,
 *   or the provider has no default model for the requested task.
 */
export function resolveModelOption(opts: ModelOption, task: TaskType = 'text'): ParsedModel {
  // Apply global default for `provider` / `model` when neither is inlined.
  // Inline opts always win; the default kicks in only when the caller
  // supplied nothing. Env-var auto-detect happens later as a final
  // fallback if the default also doesn't pin a provider. The default's
  // model applies only to a task it can serve (see globalModelForTask);
  // otherwise the provider's default model for the task is used.
  if (!opts.provider && !opts.model) {
    const def = getDefaultProvider();
    if (def?.provider) {
      // A custom endpoint (the default's baseUrl, an inline baseUrl on
      // callers such as embedText, or the provider's base-URL env var) may
      // serve any model under any name, so the default's model stays.
      const inlineBaseUrl = (opts as { baseUrl?: unknown }).baseUrl;
      const envBaseUrlVar = def.provider ? ENV_URL_MAP[def.provider] : undefined;
      const customEndpoint = Boolean(
        def.baseUrl ||
          (typeof inlineBaseUrl === 'string' && inlineBaseUrl) ||
          (envBaseUrlVar && process.env[envBaseUrlVar]),
      );
      opts = {
        ...opts,
        provider: def.provider,
        model: customEndpoint ? def.model : globalModelForTask(def, task),
      };
    }
  }

  // 1. Explicit model string (backwards compat and direct override)
  if (opts.model) {
    // A colon splits the id only when its prefix is a known provider id, and
    // never under provider 'ollama', whose tags carry colons and may be named
    // after providers (`mistral:7b`). A known prefix wins over `provider`.
    if (opts.provider !== 'ollama') {
      const prefixed = knownProviderPrefixOf(opts.model);
      if (prefixed) return { providerId: prefixed, modelId: opts.model.slice(prefixed.length + 1) };
    }
    // Alternative "provider/model" format — check if the prefix before the
    // first "/" is a known provider ID. This avoids misinterpreting OpenRouter
    // model paths like "meta-llama/llama-3.1-8b" as provider "meta-llama".
    // An explicit provider wins over another provider's prefix: a gateway
    // names models `vendor/model` (OpenRouter's `openai/gpt-5.6-sol`), and
    // that id belongs to the gateway, not to the vendor's own API. A prefix
    // that repeats the explicit provider is dropped.
    const slashIdx = opts.model.indexOf('/');
    if (slashIdx > 0) {
      const maybeProvider = opts.model.slice(0, slashIdx);
      if (PROVIDER_DEFAULTS[maybeProvider] && (!opts.provider || opts.provider === maybeProvider)) {
        return { providerId: maybeProvider, modelId: opts.model.slice(slashIdx + 1) };
      }
    }
    // Plain model name with explicit provider
    if (opts.provider) return { providerId: opts.provider, modelId: opts.model };
    // Plain model name — try auto-detect for provider
    const detected = autoDetectProvider(task);
    if (detected) return { providerId: detected, modelId: opts.model };
    throw new Error(
      'model without ":" requires either a provider option or a configured runtime (API key env var, local CLI install, etc.).'
    );
  }

  // 2. Provider specified without model — look up default model for task
  if (opts.provider) {
    const defaults = PROVIDER_DEFAULTS[opts.provider];
    if (!defaults) {
      throw new Error(
        `Unknown provider "${opts.provider}". Known providers: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}.`
      );
    }
    const modelId = defaults[task];
    if (!modelId) {
      throw new Error(
        `Provider "${opts.provider}" has no default ${task} model. Specify model explicitly.`
      );
    }
    return { providerId: opts.provider, modelId };
  }

  // 3. Neither — auto-detect provider from environment
  const detected = autoDetectProvider(task);
  if (detected) {
    const defaults = PROVIDER_DEFAULTS[detected];
    const modelId = defaults?.[task];
    if (modelId) return { providerId: detected, modelId };
  }

  throw new Error(
    'Either "provider" or "model" is required. Or configure a supported runtime (API key env var, Claude Code CLI, Gemini CLI, etc.).'
  );
}

/**
 * Chat model families, optionally behind a provider prefix such as `openai:`
 * and a gateway prefix such as `openai/` or `meta-llama/`
 * (`openrouter:openai/gpt-4o`).
 */
const CHAT_MODEL_FAMILY =
  /^(?:[\w.-]+:)?(?:[\w.-]+\/)?(?:gpt-|chatgpt|o\d|claude|gemini|gemma|llama|mistral|mixtral|codestral|ministral|magistral|grok|deepseek|qwen|command|phi-|sonar|kimi|glm)/i;

/** Names that mark a non-chat model inside a chat family (gpt-image-1, gemini-embedding-2). */
const NON_CHAT_MODEL_MARKER = /embed|image|dall-e|imagen|tts|whisper|transcri|audio|realtime|moderation/i;

/**
 * The global default's model when it can serve `task` on the provider's own
 * endpoint (a custom endpoint keeps the default's model; see
 * resolveModelOption). The default model is the text model (`generateText`,
 * agents). An embedding or image call drops it only when it is recognizably
 * a chat model, which would fail there (the provider's default model for the
 * task applies instead); any other name is kept, since it may be an embedding
 * or image model. An embedding call on Ollama keeps any model: Ollama embeds
 * with whatever model is pulled, and forcing nomic-embed-text would break
 * hosts that never pulled it.
 *
 * @param def - The global default provider config.
 * @param task - The task being resolved.
 * @returns The model to apply, or undefined to use the provider's task default.
 */
function globalModelForTask(
  def: { provider?: string; model?: string },
  task: TaskType,
): string | undefined {
  if (!def.model) return undefined;
  if (task === 'text') return def.model;
  if (task === 'embedding' && def.provider === 'ollama') return def.model;
  const isChatModel = CHAT_MODEL_FAMILY.test(def.model) && !NON_CHAT_MODEL_MARKER.test(def.model);
  return isChatModel ? undefined : def.model;
}

// ---------------------------------------------------------------------------

/**
 * Process-scoped cache of initialised {@link AIModelProviderManager}
 * instances, keyed by `providerId + apiKey + baseUrl`. Every LLM call
 * inside agentos goes through `createProviderManager`, and without
 * memoisation each call allocates a fresh manager (four init log lines
 * per call) and repeats provider listing. Cache key includes the key
 * + base URL so a config swap picks up a new manager, but identical
 * configs reuse the same one for the life of the process.
 */
const managerCache = new Map<string, Promise<AIModelProviderManager>>();

/**
 * Thrown by {@link createProviderManager} when the requested provider did not
 * initialize: a rejected or revoked API key (the provider's model listing
 * answers 401), an unreachable endpoint, or a provider id the manager does
 * not know. The fallback walker treats it as retryable, so a primary whose
 * key stopped working fails over like one that answers 401 on the call.
 *
 * `httpStatus` repeats the cause's HTTP status when it has one, which the
 * provider health registry uses to pick its cooldown.
 */
export class ProviderInitializationError extends Error {
  /** Provider that failed to initialize. */
  public readonly providerId: string;
  /** HTTP status of the underlying failure, when it had one. */
  public readonly httpStatus?: number;
  /** The error the provider threw during initialization, when there was one. */
  public readonly cause?: unknown;

  constructor(providerId: string, cause?: unknown) {
    const detail =
      cause instanceof Error
        ? cause.message
        : cause !== undefined
          ? String(cause)
          : 'the provider was not registered';
    super(`Provider '${providerId}' failed to initialize: ${detail}`);
    this.name = 'ProviderInitializationError';
    this.providerId = providerId;
    this.cause = cause;
    const status = httpStatusOf(cause);
    if (status !== undefined) this.httpStatus = status;
  }
}

/** Reads a numeric HTTP status from the fields provider errors use. */
function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { httpStatus?: unknown; status?: unknown; statusCode?: unknown };
  for (const value of [e.httpStatus, e.status, e.statusCode]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function buildCacheKey(resolved: ResolvedProvider): string {
  return `${resolved.providerId}::${resolved.apiKey ?? ''}::${resolved.baseUrl ?? ''}`;
}

/**
 * Instantiates and initialises an {@link AIModelProviderManager} for a single provider.
 *
 * Constructs the provider config object from the `resolved` credentials and calls
 * `manager.initialize()` before returning. The returned manager is ready for
 * immediate use via `manager.getProvider(providerId)`.
 *
 * The manager is cached process-wide by resolved key + base URL, so repeated
 * calls with the same credentials reuse one manager instead of allocating
 * a new one per LLM call. A provider that fails to initialize is not cached:
 * the call throws and the next call with the same credentials initializes
 * again, so a transient failure (a network blip, a 503 from the model
 * listing) does not disable the provider for the life of the process.
 *
 * @param resolved - A `ResolvedProvider` produced by {@link resolveProvider}
 *   or `resolveMediaProvider()`.
 * @returns A fully initialised {@link AIModelProviderManager} instance.
 * @throws {ProviderInitializationError} When the requested provider did not
 *   initialize.
 */
export async function createProviderManager(
  resolved: ResolvedProvider
): Promise<AIModelProviderManager> {
  const key = buildCacheKey(resolved);
  const cached = managerCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const manager = new AIModelProviderManager();

    const providerConfig: Record<string, unknown> = {};
    if (resolved.apiKey) providerConfig.apiKey = resolved.apiKey;
    if (resolved.baseUrl) {
      providerConfig.baseURL = resolved.baseUrl;
      providerConfig.baseUrl = resolved.baseUrl;
    }

    await manager.initialize({
      providers: [
        {
          providerId: resolved.providerId,
          enabled: true,
          isDefault: true,
          config: providerConfig,
        },
      ],
    });

    // initialize() logs a provider's failure and leaves it unregistered.
    // Surface it with its cause so callers can fail over, and reject so the
    // handler below drops this manager from the cache.
    if (!manager.getProvider(resolved.providerId)) {
      throw new ProviderInitializationError(
        resolved.providerId,
        manager.getProviderInitError(resolved.providerId),
      );
    }

    return manager;
  })();

  // Drop from cache if init rejected so the next call retries cleanly
  // instead of surfacing the stale rejection forever.
  pending.catch(() => managerCache.delete(key));
  managerCache.set(key, pending);
  return pending;
}
