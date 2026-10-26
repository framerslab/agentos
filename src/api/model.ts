/**
 * @file model.ts
 * Provider resolution utilities for the AgentOS high-level API.
 *
 * This module is responsible for parsing `provider:model` strings, resolving
 * credentials from environment variables or caller overrides, and constructing
 * an {@link AIModelProviderManager} ready for use by {@link generateText} and
 * {@link streamText}.
 */
import { createHash } from 'node:crypto';
import { keyPoolConfigFor, keyPoolDefaultsVersion } from './keyPoolDefaults.js';

import { AIModelProviderManager } from '../core/llm/providers/AIModelProviderManager.js';
import { baseUrlCredentials } from '../core/llm/providers/url-secrets.js';
import { PROVIDER_DEFAULTS, autoDetectProvider } from './runtime/provider-defaults.js';
import { getDefaultProvider } from './runtime/global-default.js';
import { contentSafeConsole as console } from '../core/logging/contentSafeConsole.js';

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
  /**
   * Base URL override forwarded to the provider SDK: the first of the call's own, the applicable global default's
   * and the provider's base-URL variable that is set, never an empty or whitespace-only string (see
   * {@link resolveBaseUrl}). Absent when none is set, which sends the call to the provider's own endpoint.
   */
  baseUrl?: string;
  /**
   * The key pool's id for a key read from the environment, `<providerId>:<ENV_VAR>`, under which the pool's state
   * persists when a host set a store with `setKeyPoolDefaults()`; absent for an override or a global default.
   */
  poolId?: string;
}

const ENV_KEY_MAP: Record<string, string> = {
  minimax: 'MINIMAX_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  requesty: 'REQUESTY_API_KEY',
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
  minimax: 'MINIMAX_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  openrouter: 'OPENROUTER_BASE_URL',
  requesty: 'REQUESTY_BASE_URL',
  stability: 'STABILITY_BASE_URL',
  replicate: 'REPLICATE_BASE_URL',
  fal: 'FAL_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
  'stable-diffusion-local': 'STABLE_DIFFUSION_LOCAL_BASE_URL',
};

/**
 * The environment variables a provider's API key and base URL are read from,
 * when it has them. The model pool reads a seat's key and URL from them.
 *
 * @param providerId - A provider id such as `'openai'`.
 * @returns The variable names; either is undefined when the provider has none.
 */
export function providerEnvVars(providerId: string): { key?: string; url?: string } {
  return { key: ENV_KEY_MAP[providerId], url: ENV_URL_MAP[providerId] };
}

/**
 * `value` when it is a base URL that is set; undefined for an unset one, which
 * is an undefined, empty or whitespace-only string. Every place that reads a
 * base URL to decide the endpoint a provider's key is sent to reads it this
 * way: a blank value is read as absent, so the next source applies (the global
 * default's URL, then the provider's base-URL variable), and with none the
 * request goes to the provider's own endpoint. No request is built on a blank
 * base. The URL parser strips surrounding whitespace, which leaves a relative
 * reference such as `/embeddings`
 * (https://url.spec.whatwg.org/#concept-basic-url-parser); a browser's fetch
 * parses that against the page's API base URL and posts it to the page's own
 * origin with the key (https://fetch.spec.whatwg.org/#dom-request, the Request
 * constructor), and Node's fetch, with no page to parse against, rejects it as
 * unparseable (both read 2026-10-25).
 *
 * @param value - A base URL from a call, a global default or a variable.
 * @returns The value when it is set, else undefined.
 */
export function baseUrlIfSet(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/**
 * The base URL a call to `providerId` is sent with: the call's own, else the
 * global default's (when the default applies to the provider), else the
 * provider's base-URL variable, each read with {@link baseUrlIfSet} so a blank
 * one is passed over; undefined when every source is unset, which sends the
 * call to the provider's own endpoint. This is the one reading of a base URL:
 * resolveProvider and resolveMediaProvider send with this URL, withGlobalDefault
 * decides by it whether a global default's model goes to a custom endpoint (a
 * root the provider documents for its own service is not one; see
 * {@link PROVIDER_API_ROOTS}), generateImage chooses the global default's
 * image model by it, importAgent decides by it whether a redacted base URL can
 * be dropped, and the model pool reads a seat's URL sources with
 * {@link baseUrlIfSet}, so every decision follows the endpoint the call is
 * sent to.
 *
 * @param providerId - The provider the call is sent to.
 * @param inline - The call's own `baseUrl`.
 * @param defaultBaseUrl - The global default's `baseUrl`, when the default
 *   applies to `providerId`.
 * @returns The base URL, or undefined when no source sets one.
 */
export function resolveBaseUrl(providerId: string, inline: string | undefined, defaultBaseUrl: string | undefined): string | undefined {
  const envVar = ENV_URL_MAP[providerId];
  return baseUrlIfSet(inline) ?? baseUrlIfSet(defaultBaseUrl) ?? baseUrlIfSet(envVar ? process.env[envVar] : undefined);
}

/**
 * The value of every provider key variable that is set and the credentials in
 * every provider URL variable that is set, for a call's redaction list: a
 * failover hop resolved at call time reads its key and URL from them.
 *
 * @returns The key values as set (a comma-separated key pool is one value)
 *   and the `user:password` part of each URL that has one.
 */
export function providerEnvSecrets(): { keys: string[]; urlCredentials: string[] } {
  const valuesOf = (variables: Record<string, string>): string[] =>
    Object.values(variables)
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value));
  return {
    keys: valuesOf(ENV_KEY_MAP),
    urlCredentials: valuesOf(ENV_URL_MAP)
      .map((url) => baseUrlCredentials(url))
      .filter((credentials): credentials is string => Boolean(credentials)),
  };
}

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
 * The provider {@link resolveModelOption} sends these options to, without
 * auto-detection: a known `provider:` prefix (never under `ollama`), else a
 * known `provider/` prefix when `provider` is unset or repeats it, else
 * `provider`. Undefined when the provider would come from auto-detection.
 *
 * @param opts - A `provider` and a `model`, either of which may be unset.
 * @returns The provider id, or undefined.
 */
export function routedProviderOf(opts: { provider?: string; model?: string }): string | undefined {
  const { provider, model } = opts;
  if (model && provider !== 'ollama') {
    const prefixed = knownProviderPrefixOf(model);
    if (prefixed) return prefixed;
    // A colon id no known prefix split takes the slash form only when
    // `provider` repeats its prefix, as in resolveModelOption.
    const slash = model.includes(':') && !provider ? -1 : model.indexOf('/');
    if (slash > 0) {
      const maybe = model.slice(0, slash);
      if (Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULTS, maybe) && (!provider || provider === maybe)) return maybe;
    }
  }
  return provider;
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
 * Refuses a call whose own `apiKey` or `baseUrl` would reach a provider the
 * call did not name for it:
 *
 * - a `provider:` model prefix that names another provider than `provider`,
 *   since the prefix wins (`provider: 'openai', model: 'replicate:...'`
 *   would send the OpenAI key to Replicate);
 * - for an image task, a provider left to auto-detection, which picks the
 *   first image vendor with a key in the environment.
 *
 * A call with neither field, and a provider the global default names, pass.
 *
 * @throws {Error} Naming the provider the credentials would have gone to.
 */
function refuseMisdirectedCredentials(opts: ModelOption, task: TaskType): void {
  const inline = opts as { apiKey?: unknown; baseUrl?: unknown };
  if (typeof inline.apiKey !== 'string' && typeof inline.baseUrl !== 'string') return;
  const prefixed = opts.provider === 'ollama' ? undefined : knownProviderPrefixOf(opts.model);
  if (opts.provider && prefixed && prefixed !== opts.provider) {
    throw new Error(
      `Model '${opts.model}' names provider '${prefixed}', not '${opts.provider}': the apiKey or baseUrl ` +
        `given for one would go to the other. Name one provider.`,
    );
  }
  if (task === 'image' && !routedProviderOf(opts)) {
    throw new Error(
      "An apiKey or baseUrl for an image call needs provider (or a model such as 'openai:gpt-image-2.5-flare'): " +
        'without one, the provider is detected from the environment and the key would go to it.',
    );
  }
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
 *   over environment variable lookups. The base URL is the override's, else the
 *   global default's, else the provider's base-URL variable, each read as
 *   {@link resolveBaseUrl} reads it: an empty or whitespace-only one is unset
 *   and the next source applies, so no request is built on a blank base.
 *   `strict` (set for an agency seat) admits
 *   only a `setDefaultProvider()` default that names this provider, for the key
 *   and for the URL, and turns off the Anthropic → OpenRouter fallback, so a
 *   provider with no key of its own fails. `quiet` is for a lookup that sends
 *   no request, such as the read of the provider's shared credentials that
 *   `providerHealthKey` compares a call's own with: it resolves the same way
 *   and prints no notice that a request goes to OpenRouter.
 * @returns A `ResolvedProvider` ready for `createProviderManager()`.
 * @throws {Error} When no credentials can be resolved for the given provider.
 */
export function resolveProvider(
  providerId: string,
  modelId: string,
  overrides?: { apiKey?: string; baseUrl?: string; strict?: boolean; quiet?: boolean }
): ResolvedProvider {
  // Global-default credentials apply when their `provider` matches the
  // provider being resolved (or when no provider was pinned in the
  // default — in which case the default's apiKey is treated as
  // applicable to whichever provider the auto-detect chain picked),
  // unless the caller is strict (an agency seat): then only a default
  // that names this provider applies, and Anthropic is never rerouted.
  const def = getDefaultProvider();
  const defAppliesToThisProvider = def && (def.provider === providerId || (!def.provider && !overrides?.strict));
  const defApiKey = defAppliesToThisProvider ? def?.apiKey : undefined;
  const defBaseUrl = defAppliesToThisProvider ? def?.baseUrl : undefined;

  const apiKey =
    overrides?.apiKey ??
    defApiKey ??
    (ENV_KEY_MAP[providerId] ? process.env[ENV_KEY_MAP[providerId]] : undefined);
  const baseUrl = resolveBaseUrl(providerId, overrides?.baseUrl, defBaseUrl);

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
  // Not when the call or the global default gave a base URL: that is where
  // the caller sends Anthropic requests, and OpenRouter would drop it.
  // A strict caller fails below instead: its key must be Anthropic's own.
  if (providerId === 'anthropic' && !apiKey && !baseUrl && !overrides?.strict) {
    const orKey = process.env['OPENROUTER_API_KEY'];
    if (orKey) {
      // Anthropic's native API takes dated model IDs (e.g. "claude-haiku-4-5-20251001").
      // OpenRouter exposes Anthropic models under dateless slugs (e.g. "anthropic/claude-haiku-4-5").
      // Strip a trailing -YYYYMMDD release-date suffix when remapping so the OR call resolves.
      const orModelId = modelId.replace(/-\d{8}$/, '');
      // A lookup that sends no request sends none to OpenRouter.
      if (!overrides?.quiet) {
        console.warn(
          `[AgentOS] ANTHROPIC_API_KEY not set — falling back to OpenRouter for model "${modelId}" ` +
          `(routed as "anthropic/${orModelId}"). Set ANTHROPIC_API_KEY for direct access.`
        );
      }
      return { providerId: 'openrouter', modelId: `anthropic/${orModelId}`, apiKey: orKey, poolId: 'openrouter:OPENROUTER_API_KEY' };
    }
    throw new Error(`No API key for anthropic. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.`);
  }

  if (!apiKey) {
    const envVar = ENV_KEY_MAP[providerId] ?? `${providerId.toUpperCase()}_API_KEY`;
    throw new Error(`No API key for ${providerId}. Set ${envVar} or pass apiKey.`);
  }

  // A key read from the environment names its pool, so the pool's state can persist under that name.
  const fromEnv = overrides?.apiKey === undefined && defApiKey === undefined && ENV_KEY_MAP[providerId] !== undefined;
  return { providerId, modelId, apiKey, baseUrl, ...(fromEnv ? { poolId: `${providerId}:${ENV_KEY_MAP[providerId]}` } : {}) };
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
  const baseUrl = resolveBaseUrl(providerId, overrides?.baseUrl, defAppliesToThisProvider ? def?.baseUrl : undefined);

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
  /**
   * Base URL override (useful for local proxies or Ollama). An empty or
   * whitespace-only value is unset: the global default's URL, then the
   * provider's base-URL variable, apply as with no `baseUrl`, and with none the
   * call goes to the provider's own endpoint.
   */
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
  opts = withGlobalDefault(opts, task);
  refuseMisdirectedCredentials(opts, task);

  // 1. Explicit model string (backwards compat and direct override)
  if (opts.model) {
    // A colon splits the id only when its prefix is a known provider id, and
    // never under provider 'ollama', whose tags carry colons and may be named
    // after providers (`mistral:7b`). A known prefix wins over `provider`.
    if (opts.provider !== 'ollama') {
      // A first colon with nothing before or after it (`openai:`, `:gpt-4.1`)
      // is a malformed id, rejected as parseModelString always has.
      const colon = opts.model.indexOf(':');
      if (colon === 0 || (colon > 0 && colon === opts.model.length - 1)) return parseModelString(opts.model);
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
    // A colon id that no known prefix split (an Ollama tag, an OpenRouter
    // `:free` id) takes the slash form only when `provider` repeats its
    // prefix, so with no provider `openai/gpt-4o:free` never goes to OpenAI
    // as `gpt-4o:free`.
    const slashIdx = opts.model.includes(':') && !opts.provider ? -1 : opts.model.indexOf('/');
    if (slashIdx > 0) {
      const maybeProvider = opts.model.slice(0, slashIdx);
      if (PROVIDER_DEFAULTS[maybeProvider] && (!opts.provider || opts.provider === maybeProvider)) {
        return { providerId: maybeProvider, modelId: opts.model.slice(slashIdx + 1) };
      }
    }
    // Plain model name with explicit provider
    if (opts.provider) return { providerId: opts.provider, modelId: opts.model };
    // A colon id whose prefix is not a provider agentos knows (an Ollama tag,
    // a fine-tune id) needs `provider`: auto-detection would send it, with
    // the detected vendor's key, to whichever provider the environment names.
    if (opts.model.includes(':')) {
      throw new Error(
        `Model "${opts.model}" has a colon, but "${opts.model.slice(0, opts.model.indexOf(':'))}" is not a provider agentos knows; ` +
          `pass \`provider\` (for an Ollama tag, provider: 'ollama').`,
      );
    }
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
 * (`openrouter:openai/gpt-4o`). MiniMax's text models are `MiniMax-` names
 * (`MiniMax-M3.1-Flash`); the hyphen keeps a bare `minimax:` provider prefix
 * or `minimax/` gateway prefix from reading as the family.
 */
const CHAT_MODEL_FAMILY =
  /^(?:[\w.-]+:)?(?:[\w.-]+\/)?(?:gpt-|chatgpt|o\d|claude|gemini|gemma|llama|mistral|mixtral|codestral|ministral|magistral|grok|deepseek|qwen|command|phi-|sonar|kimi|glm|minimax-)/i;

/** Names that mark a non-chat model inside a chat family (gpt-image-2.5-flare, gemini-embedding-2). */
const NON_CHAT_MODEL_MARKER = /embed|image|dall-e|imagen|tts|whisper|transcri|audio|realtime|moderation/i;

/**
 * API roots a provider documents for its own service, each serving the
 * provider's own model names: a base URL among them picks a region, not a
 * custom endpoint. The base URL compared with them is the one
 * {@link resolveBaseUrl} gives, the first set source of the call's, the global
 * default's and the provider's base-URL variable, so an empty or
 * whitespace-only value at the call or the default never reaches the
 * comparison: the next source does. MiniMax's global root is https://api.minimax.io/v1
 * (https://platform.minimax.io/docs/api-reference/text-openai-api; images at
 * https://platform.minimax.io/docs/api-reference/image-generation-t2i). Its
 * China root here, https://api.minimaxi.com/v1, is UNVERIFIED: MiniMax's China
 * documentation names https://api.minimax.cn/v1
 * (https://platform.minimax.cn/docs/api-reference/text-openai-api).
 */
const PROVIDER_API_ROOTS: Record<string, readonly string[]> = {
  minimax: ['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1'],
};

/**
 * `url` as a request built on it is sent: surrounding whitespace and every
 * trailing slash removed, as MiniMax's image provider removes them before it
 * appends a path, then parsed as fetch parses a URL, which lowercases the
 * scheme and the host and drops a default port
 * (https://url.spec.whatwg.org/#scheme-state,
 * https://url.spec.whatwg.org/#concept-domain-to-ascii,
 * https://url.spec.whatwg.org/#port-state). Undefined when nothing is left
 * or the URL does not parse.
 */
function normalizedBaseUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).href;
  } catch {
    return undefined;
  }
}

/**
 * Whether `url`, the base URL {@link resolveBaseUrl} gives, is one other than
 * an API root `provider` documents for its own service (see
 * {@link PROVIDER_API_ROOTS}). The two are compared as the request is sent
 * (see {@link normalizedBaseUrl}): the letter case of the scheme and the host,
 * a default port, surrounding whitespace and trailing slashes make no
 * difference. An unset URL is not custom: the call then goes to the provider's
 * own endpoint. An empty or whitespace-only URL never reaches here, since
 * resolveBaseUrl reads it as unset and the next source applies. A URL that
 * does not parse is custom, as any other is.
 */
function isCustomBaseUrl(provider: string, url: string | undefined): boolean {
  if (url === undefined) return false;
  const roots = PROVIDER_API_ROOTS[provider];
  if (!roots) return true;
  const sent = normalizedBaseUrl(url);
  return sent === undefined || !roots.some((root) => normalizedBaseUrl(root) === sent);
}

/**
 * `opts` with the global default's `provider` and `model` filled in when the
 * call inlines neither. Inline options always win; the default applies only
 * when the caller supplied nothing, and env-var auto-detection stays the last
 * fallback if the default pins no provider. The default's model applies only
 * to a task it can serve (see {@link globalModelForTask}); otherwise the
 * provider's default model for the task is used.
 */
function withGlobalDefault(opts: ModelOption, task: TaskType): ModelOption {
  if (opts.provider || opts.model) return opts;
  const def = getDefaultProvider();
  const provider = def?.provider;
  if (!def || !provider) return opts;
  // A custom endpoint may serve any model under any name, so the default's
  // model stays. The endpoint is the base URL the call is sent with, which
  // resolveBaseUrl gives here as it gives resolveProvider and
  // resolveMediaProvider the URL they send with: an inline baseUrl on callers
  // such as embedText, else the default's baseUrl, else the provider's
  // base-URL env var, an empty or whitespace-only one passed over; with none
  // the call goes to the provider's own endpoint, and the default's model is
  // kept only for a task it can serve there. A regional root the provider
  // documents serves the provider's own names and is not custom, even when a
  // setting the call does not use names a custom endpoint.
  const inlineBaseUrl = (opts as { baseUrl?: unknown }).baseUrl;
  const customEndpoint = isCustomBaseUrl(
    provider,
    resolveBaseUrl(provider, typeof inlineBaseUrl === 'string' ? inlineBaseUrl : undefined, def.baseUrl),
  );
  return {
    ...opts,
    provider,
    model: customEndpoint ? def.model : globalModelForTask(def, task),
  };
}

/**
 * Whether {@link resolveModelOption} takes the model for `task` from a name:
 * the call's `model`, or the global default's. False when the model is the
 * provider's default for the task.
 *
 * The image operations use it: a call that names no model runs on the
 * provider's own default for the operation, not on the text-to-image default
 * `resolveModelOption` returns for the provider.
 */
export function modelIsNamed(opts: ModelOption, task: TaskType = 'text'): boolean {
  return Boolean(withGlobalDefault(opts, task).model);
}

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
 * instances, keyed by the provider id and a digest of the key and base URL.
 * Every LLM call inside agentos goes through `createProviderManager`, and
 * without memoisation each call allocates a fresh manager (four init log
 * lines per call) and repeats provider listing. The key and base URL are in
 * the cache key so a config swap picks up a new manager, and identical
 * configs reuse the same one; at most
 * {@link MAX_CACHED_PROVIDER_MANAGERS} are kept, the least recently used
 * dropped first.
 */
const managerCache = new Map<string, Promise<AIModelProviderManager>>();

/**
 * The most managers {@link createProviderManager} keeps. A service that
 * passes each user's own key would otherwise keep one initialized manager
 * per key for the life of the process; past this many, the one used least
 * recently is dropped (a call that still holds it finishes with it).
 */
export const MAX_CACHED_PROVIDER_MANAGERS = 64;

/** The number of managers cached now, for tests. @internal */
export function cachedProviderManagerCount(): number {
  return managerCache.size;
}

/**
 * The {@link shutdownProviderManagers} call in progress, if any. A manager
 * {@link createProviderManager} builds while it runs waits for it, so the
 * new manager's pools load the state the replaced pools are writing instead
 * of the rows from before it.
 */
let shutdownInProgress: Promise<void> | undefined;

/**
 * Shuts down every provider manager {@link createProviderManager} has cached
 * and empties the cache. Each provider's `shutdown()` closes its key pool,
 * which stops the pool's recheck timer and writes the keys' standing at once,
 * so a short-lived host (a CLI, a job) that calls this before it exits keeps
 * the last quarter second of key state its pools would otherwise lose to the
 * save debounce. A manager still initializing is awaited first; one whose
 * initialization failed is skipped. Calls after this one build new managers
 * as the first call did, and a manager built before it has finished waits
 * for it, so its pools start from what the old pools wrote.
 */
export async function shutdownProviderManagers(): Promise<void> {
  const pending = Array.from(managerCache.values());
  managerCache.clear();
  const shuttingDown = Promise.all(
    pending.map(async (initializing) => {
      let manager: AIModelProviderManager;
      try {
        manager = await initializing;
      } catch {
        return;
      }
      await manager.shutdown().catch(() => undefined);
    }),
  ).then(() => undefined);
  const previous = shutdownInProgress;
  const all = previous ? Promise.all([previous, shuttingDown]).then(() => undefined) : shuttingDown;
  shutdownInProgress = all;
  try {
    await all;
  } finally {
    if (shutdownInProgress === all) shutdownInProgress = undefined;
  }
}

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

/** The cache key: the provider, and a digest of its key and base URL, so the map holds no key. */
function buildCacheKey(resolved: ResolvedProvider): string {
  // The pool id and the defaults' version are part of the key: the same key string from the environment (a named,
  // persisted pool) and from an override (no pool id) builds two managers, and a change of the key pool defaults
  // gives later calls a manager built with them.
  const digest = createHash('sha256')
    .update(`${resolved.apiKey ?? ''}\n${resolved.baseUrl ?? ''}\n${resolved.poolId ?? ''}\n${keyPoolDefaultsVersion()}`)
    .digest('hex');
  return `${resolved.providerId}::${digest}`;
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
  if (cached) {
    // Most recently used last: the map's order is the eviction order.
    managerCache.delete(key);
    managerCache.set(key, cached);
    return cached;
  }

  const pending = (async () => {
    // A manager built while shutdownProviderManagers() runs waits for it: the replaced pools write their pending
    // state first, so this manager's pools load that state rather than the rows from before it.
    if (shutdownInProgress) await shutdownInProgress;
    const manager = new AIModelProviderManager();

    const providerConfig: Record<string, unknown> = {};
    if (resolved.apiKey) providerConfig.apiKey = resolved.apiKey;
    if (resolved.baseUrl) {
      providerConfig.baseURL = resolved.baseUrl;
      providerConfig.baseUrl = resolved.baseUrl;
    }
    // The host's key pool defaults (a store, a strategy) and the pool's id for a key from the environment.
    const keyPool = keyPoolConfigFor(resolved.poolId);
    if (keyPool) providerConfig.keyPool = keyPool;

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
  pending.catch(() => {
    if (managerCache.get(key) === pending) managerCache.delete(key);
  });
  managerCache.set(key, pending);
  while (managerCache.size > MAX_CACHED_PROVIDER_MANAGERS) {
    const oldest = managerCache.keys().next().value;
    if (oldest === undefined) break;
    managerCache.delete(oldest);
  }
  return pending;
}
