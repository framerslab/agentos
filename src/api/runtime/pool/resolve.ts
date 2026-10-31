/**
 * @fileoverview One resolver for every config seat, pool entry and chair:
 * provider, model, key and URL, written as own properties of the seated
 * config so nothing from the agency level survives that the resolver did
 * not put there. Availability (what the provider needs, and a closed
 * breaker) is read with the same rules.
 */
import { PROVIDER_DEFAULTS, isBinaryOnPathCached } from '../provider-defaults.js';
import { getDefaultProvider } from '../global-default.js';
import { baseUrlIfSet, knownProviderPrefixOf, providerEnvVars, resolveProvider } from '../../model.js';
import { providerHealthKey, type ProviderCredentials } from '../providerHealthKey.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { AgencyOptions } from '../../types.js';

/**
 * The text providers the provider manager builds (`AIModelProviderManager.ts`,
 * its provider switch) that resolve by name: each has a default text model and
 * a key or URL variable, or a CLI binary. `litellm`, which the manager also
 * builds, has neither a default model nor a key variable, and is left out.
 */
export const TEXT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'openai', 'openrouter', 'requesty', 'ollama', 'anthropic', 'groq', 'together', 'mistral', 'xai', 'gemini', 'claude-code-cli', 'gemini-cli',
]);
const CLI_BINARY: Record<string, string> = { 'claude-code-cli': 'claude', 'gemini-cli': 'gemini' };
const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

/**
 * The agency-level provider: the one the agency's own calls go to, which owns
 * the agency-level key and URL. A known prefix of `model` wins over `provider`
 * (never under `provider: 'ollama'`), as `resolveModelOption` routes the
 * agency's synthesizer, judge and manager and as `mergeDefaults` hands the key;
 * else `provider`.
 */
export function agencyProviderOf(agency: AgencyOptions): string | undefined {
  const prefix = agency.provider === 'ollama' ? undefined : knownProviderPrefixOf(agency.model);
  return prefix ?? agency.provider;
}

/** The agency-level model with a known provider prefix stripped; never split under `provider: 'ollama'`. */
export function agencyModelOf(agency: AgencyOptions): string | undefined {
  if (!agency.model) return undefined;
  const prefix = agency.provider === 'ollama' ? undefined : knownProviderPrefixOf(agency.model);
  return prefix ? agency.model.slice(prefix.length + 1) : agency.model;
}

/** What the resolver reads from one seat, pool entry, hop or chair. */
export interface ResolveInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** A fixed seat or the chair: may take the agency-level key and URL when it runs on the agency-level provider. */
  inherits: boolean;
  /**
   * Whether the provider's variables are the last source (the default). A
   * call that is not strict, the emergent judge's in an agency without a
   * pool, passes false: a key or URL it would read there is left to
   * generateText, whose usual order reads a `setDefaultProvider()` default
   * that names no provider ahead of the variables, as the agency's other
   * calls do.
   */
  variables?: boolean;
}

/** The provider, model, key and URL a seat's calls use. */
export interface ResolvedCredentials { provider: string; model: string; apiKey?: string; baseUrl?: string }

/** The resolved credentials, or why no provider or model could be determined. */
export type ResolveOutcome = { ok: true; value: ResolvedCredentials } | { ok: false; reason: string };

/**
 * Provider, model, key and URL for one seat, entry, hop or chair. Provider:
 * its own, else a known prefix of its model, else the agency-level provider
 * ({@link agencyProviderOf}). Model: its own, else the agency-level
 * model when it runs on the agency-level provider, else that provider's
 * default text model. Key and URL: the first non-empty of its own, the agency
 * level's (only with `inherits` and on the agency-level provider), a
 * `setDefaultProvider()` default that names this provider, the provider's
 * environment variable (left out when `variables` is false).
 *
 * @param input - The seat's own provider, model, key and URL, and whether it may inherit.
 * @param agency - The agency options.
 * @returns The resolved credentials, or the reason none could be determined.
 */
export function resolveSeatCredentials(input: ResolveInput, agency: AgencyOptions): ResolveOutcome {
  const prefix = input.provider === 'ollama' ? undefined : knownProviderPrefixOf(input.model);
  if (prefix && input.provider && input.provider !== prefix) {
    return { ok: false, reason: `model "${input.model}" names provider "${prefix}" while provider is "${input.provider}"` };
  }
  const agencyProvider = agencyProviderOf(agency);
  const provider = input.provider ?? prefix ?? agencyProvider;
  if (!provider) return { ok: false, reason: 'no provider' };
  const ownModel = input.model ? (prefix ? input.model.slice(prefix.length + 1) : input.model) : undefined;
  const model = ownModel ?? (provider === agencyProvider ? agencyModelOf(agency) : undefined) ?? PROVIDER_DEFAULTS[provider]?.text;
  if (!model) return { ok: false, reason: 'no model' };
  const onAgencyProvider = input.inherits && provider === agencyProvider;
  const def = getDefaultProvider();
  const defNamesProvider = def?.provider === provider;
  const env = providerEnvVars(provider);
  const apiKey =
    nonEmpty(input.apiKey) ??
    (onAgencyProvider ? nonEmpty(agency.apiKey) : undefined) ??
    (defNamesProvider ? nonEmpty(def?.apiKey) : undefined) ??
    (env.key && input.variables !== false ? nonEmpty(process.env[env.key]) : undefined);
  // A URL is read as every call reads one (model.ts, baseUrlIfSet): empty or
  // whitespace alone counts as missing, so no seat's request is built on it.
  const baseUrl =
    baseUrlIfSet(input.baseUrl) ??
    (onAgencyProvider ? baseUrlIfSet(agency.baseUrl) : undefined) ??
    (defNamesProvider ? baseUrlIfSet(def?.baseUrl) : undefined) ??
    (env.url && input.variables !== false ? baseUrlIfSet(process.env[env.url]) : undefined);
  return { ok: true, value: { provider, model, apiKey, baseUrl } };
}

/** The key variable named in an availability reason. */
export function keyVarOf(provider: string): string {
  return providerEnvVars(provider).key ?? `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * The id the provider health registry keeps a seat's calls under, worked out
 * as generateText and streamText work it out for a seat's call, whose key
 * and URL resolve strictly: the provider's own id when the seat's key and URL
 * are the ones the provider's other callers reach with none of their own (a
 * global default that names this provider or no provider, else the
 * environment variable), else an id of the seat's key and URL (see
 * `providerHealthKey`).
 * A 401 on one key then opens the breaker for every seat on that key, and for
 * no seat or caller on another.
 *
 * @param c - Credentials from {@link resolveSeatCredentials}.
 * @returns The registry id the seat's calls record their health under.
 */
export function seatHealthId(c: ResolvedCredentials): string {
  let resolved: ProviderCredentials;
  try {
    resolved = resolveProvider(c.provider, c.model, { apiKey: c.apiKey, baseUrl: c.baseUrl, strict: true });
  } catch {
    // A call on these credentials fails before any request and records no health.
    return c.provider;
  }
  // A seat's call is strict, so generateText compares what it resolved with
  // the provider's shared credentials whether or not the seat brings a key or
  // URL of its own. Read quietly, as generateText reads them: the lookup sends
  // nothing.
  return providerHealthKey(resolved, () => resolveProvider(c.provider, c.model, { quiet: true }));
}

/**
 * Why resolved credentials cannot be used, or undefined when they can: a key
 * for an API provider, a base URL for Ollama, the binary on PATH for a CLI
 * provider, and a closed circuit breaker: the one the seat's calls record
 * under ({@link seatHealthId}).
 *
 * @param c - Credentials from {@link resolveSeatCredentials}.
 * @param deps - Replacements for the binary probe and the breaker check.
 * @returns The reason (`no key (ANTHROPIC_API_KEY)`, `circuit open`, ...), or undefined.
 */
export function availabilityOf(
  c: ResolvedCredentials,
  deps: { binaryOnPath?: (name: string) => boolean; breakerOpen?: (c: ResolvedCredentials) => boolean } = {},
): string | undefined {
  const binaryOnPath = deps.binaryOnPath ?? isBinaryOnPathCached;
  const breakerOpen = deps.breakerOpen ?? ((creds: ResolvedCredentials) => globalLLMProviderHealth.isOpen(seatHealthId(creds)));
  if (c.provider === 'ollama') {
    if (!c.baseUrl) return 'no base URL (OLLAMA_BASE_URL)';
  } else if (CLI_BINARY[c.provider]) {
    if (!binaryOnPath(CLI_BINARY[c.provider])) return `binary not found (${CLI_BINARY[c.provider]})`;
  } else if (!c.apiKey) {
    return `no key (${keyVarOf(c.provider)})`;
  }
  if (breakerOpen(c)) return 'circuit open';
  return undefined;
}
