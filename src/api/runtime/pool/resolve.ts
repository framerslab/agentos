/**
 * @fileoverview One resolver for every config seat, pool entry and chair:
 * provider, model, key and URL, written as own properties of the seated
 * config so nothing from the agency level survives that the resolver did
 * not put there. Availability (what the provider needs, and a closed
 * breaker) is read with the same rules.
 */
import { PROVIDER_DEFAULTS, isBinaryOnPathCached } from '../provider-defaults.js';
import { getDefaultProvider } from '../global-default.js';
import { knownProviderPrefixOf, providerEnvVars } from '../../model.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { AgencyOptions } from '../../types.js';

/** The text providers the provider manager builds (`AIModelProviderManager.ts`, its provider switch). */
export const TEXT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'openai', 'openrouter', 'ollama', 'anthropic', 'groq', 'together', 'mistral', 'xai', 'gemini', 'claude-code-cli', 'gemini-cli',
]);
const CLI_BINARY: Record<string, string> = { 'claude-code-cli': 'claude', 'gemini-cli': 'gemini' };
const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

/** The agency-level provider, read as a seat's is: `provider`, else a known prefix of `model`. */
export function agencyProviderOf(agency: AgencyOptions): string | undefined {
  return agency.provider ?? knownProviderPrefixOf(agency.model);
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
}

/** The provider, model, key and URL a seat's calls use. */
export interface ResolvedCredentials { provider: string; model: string; apiKey?: string; baseUrl?: string }

/** The resolved credentials, or why no provider or model could be determined. */
export type ResolveOutcome = { ok: true; value: ResolvedCredentials } | { ok: false; reason: string };

/**
 * Provider, model, key and URL for one seat, entry, hop or chair. Provider:
 * its own, else a known prefix of its model, else the agency level read the
 * same way. Model: its own, else the agency-level
 * model when it runs on the agency-level provider, else that provider's
 * default text model. Key and URL: the first non-empty of its own, the agency
 * level's (only with `inherits` and on the agency-level provider), a
 * `setDefaultProvider()` default that names this provider, the provider's
 * environment variable.
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
    (env.key ? nonEmpty(process.env[env.key]) : undefined);
  const baseUrl =
    nonEmpty(input.baseUrl) ??
    (onAgencyProvider ? nonEmpty(agency.baseUrl) : undefined) ??
    (defNamesProvider ? nonEmpty(def?.baseUrl) : undefined) ??
    (env.url ? nonEmpty(process.env[env.url]) : undefined);
  return { ok: true, value: { provider, model, apiKey, baseUrl } };
}

/** The key variable named in an availability reason. */
export function keyVarOf(provider: string): string {
  return providerEnvVars(provider).key ?? `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Why resolved credentials cannot be used, or undefined when they can: a key
 * for an API provider, a base URL for Ollama, the binary on PATH for a CLI
 * provider, and a closed circuit breaker.
 *
 * @param c - Credentials from {@link resolveSeatCredentials}.
 * @param deps - Replacements for the binary probe and the breaker check.
 * @returns The reason (`no key (ANTHROPIC_API_KEY)`, `circuit open`, ...), or undefined.
 */
export function availabilityOf(
  c: ResolvedCredentials,
  deps: { binaryOnPath?: (name: string) => boolean; breakerOpen?: (provider: string) => boolean } = {},
): string | undefined {
  const binaryOnPath = deps.binaryOnPath ?? isBinaryOnPathCached;
  const breakerOpen = deps.breakerOpen ?? ((p: string) => globalLLMProviderHealth.isOpen(p));
  if (c.provider === 'ollama') {
    if (!c.baseUrl) return 'no base URL (OLLAMA_BASE_URL)';
  } else if (CLI_BINARY[c.provider]) {
    if (!binaryOnPath(CLI_BINARY[c.provider])) return `binary not found (${CLI_BINARY[c.provider]})`;
  } else if (!c.apiKey) {
    return `no key (${keyVarOf(c.provider)})`;
  }
  if (breakerOpen(c.provider)) return 'circuit open';
  return undefined;
}
