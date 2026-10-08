/**
 * @fileoverview Who trained the model a seat runs on. A native provider on
 * its own endpoint gives its maker; a host of other makers' models gives the
 * model id's `<maker>/` prefix; Ollama, a custom endpoint and an id with no
 * prefix give undefined, and undefined never counts as a vendor.
 */
import { providerEnvVars } from '../../model.js';

const NATIVE_VENDORS: Record<string, string> = {
  anthropic: 'anthropic',
  'claude-code-cli': 'anthropic',
  openai: 'openai',
  gemini: 'google',
  'gemini-cli': 'google',
  xai: 'xai',
  mistral: 'mistral',
};

const HOST_PROVIDERS = new Set(['openrouter', 'together', 'groq']);

/** Spellings of one maker, lower-cased, mapped to one name. */
const VENDOR_ALIASES: Record<string, string> = {
  'meta-llama': 'meta',
  meta: 'meta',
  mistralai: 'mistral',
  mistral: 'mistral',
  'x-ai': 'xai',
  xai: 'xai',
  google: 'google',
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
  qwen: 'qwen',
  alibaba: 'alibaba',
  microsoft: 'microsoft',
  nvidia: 'nvidia',
  cohere: 'cohere',
  perplexity: 'perplexity',
  amazon: 'amazon',
  moonshotai: 'moonshot',
  moonshot: 'moonshot',
};

/** The endpoints a native provider serves its own models from. */
const OWN_ENDPOINTS: Record<string, RegExp> = {
  openai: /^https:\/\/api\.openai\.com(\/|$)/i,
  anthropic: /^https:\/\/api\.anthropic\.com(\/|$)/i,
  gemini: /^https:\/\/generativelanguage\.googleapis\.com(\/|$)/i,
  xai: /^https:\/\/api\.x\.ai(\/|$)/i,
  mistral: /^https:\/\/api\.mistral\.ai(\/|$)/i,
};

function isProviderOwnEndpoint(provider: string, baseUrl: string): boolean {
  const own = OWN_ENDPOINTS[provider];
  return own ? own.test(baseUrl) : false;
}

/** A vendor name, lower-cased and passed through the alias table. */
export function normalizeVendor(name: string): string {
  const lower = name.trim().toLowerCase();
  return VENDOR_ALIASES[lower] ?? lower;
}

/** The maker a hosted model id names (`meta-llama/...` → `meta`), or undefined (`openrouter/auto`, no prefix). */
export function makerOfHostedModel(model: string): string | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0) return undefined;
  const prefix = model.slice(0, slash).toLowerCase();
  if (prefix === 'openrouter') return undefined;
  return normalizeVendor(prefix);
}

/** Two ids are one model when the text after the last `/` matches, ignoring case. */
export function sameModelId(a: string, b: string): boolean {
  const tail = (s: string) => s.slice(s.lastIndexOf('/') + 1).toLowerCase();
  return tail(a) === tail(b);
}

/**
 * Who trained the model a seat ran on, or undefined when that cannot be
 * determined. `opts.vendor` (declared on the pool entry or the fixed seat)
 * wins; a native provider on its own endpoint gives its maker, and on a
 * custom base URL (`opts.baseUrl`, or the provider's URL variable when none
 * is given) gives undefined; a host gives the model id's maker prefix.
 *
 * @param provider - The provider id the seat runs on, such as `'openrouter'`.
 * @param model - The model id sent to that provider.
 * @param opts - A declared `vendor`, and the `baseUrl` the call goes to.
 * @returns The vendor, lower-cased (`'anthropic'`, `'meta'`), or undefined.
 */
export function vendorOf(provider: string, model: string, opts: { vendor?: string; baseUrl?: string } = {}): string | undefined {
  if (opts.vendor) return normalizeVendor(opts.vendor);
  const native = NATIVE_VENDORS[provider];
  if (native) {
    const urlVar = providerEnvVars(provider).url;
    const baseUrl = opts.baseUrl ?? (urlVar ? process.env[urlVar] : undefined);
    if (baseUrl && !isProviderOwnEndpoint(provider, baseUrl)) return undefined;
    return native;
  }
  if (HOST_PROVIDERS.has(provider)) return makerOfHostedModel(model);
  return undefined;
}
