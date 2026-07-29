/**
 * @file provider-defaults.ts
 * Default model mappings for each supported provider.
 *
 * When a user specifies `provider: 'openai'` without an explicit `model`,
 * the system looks up the default model for the requested task type here.
 */

import { spawnSync } from 'node:child_process';
import { getProviderPriority } from './provider-priority.js';

/**
 * Default model identifiers for a given provider, keyed by task type.
 * Only fields relevant to the provider need to be populated.
 */
export interface ProviderDefaults {
  /** Default model for generateText / streamText */
  text?: string;
  /** Default model for generateImage */
  image?: string;
  /** Default embedding model */
  embedding?: string;
  /** Cheapest model for internal/discovery use */
  cheap?: string;
}

/** Task keys supported by the default-model registry. */
export type ProviderDefaultTask = 'text' | 'image' | 'embedding';

/**
 * Registry of default models per provider, keyed by provider identifier.
 *
 * These defaults are used when a caller specifies `provider: 'openai'` without
 * an explicit `model` field.  The task type (`'text'`, `'image'`, `'embedding'`)
 * selects which sub-key to read.
 */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  openai: {
    text: 'gpt-4o',
    image: 'gpt-image-1',
    embedding: 'text-embedding-3-small',
    cheap: 'gpt-4o-mini',
  },
  anthropic: {
    text: 'claude-sonnet-4-6',
    cheap: 'claude-haiku-4-5-20251001',
  },
  ollama: {
    text: 'llama3.2',
    image: 'stable-diffusion',
    embedding: 'nomic-embed-text',
    cheap: 'llama3.2',
  },
  openrouter: {
    text: 'openai/gpt-4o',
    cheap: 'openai/gpt-4o-mini',
  },
  requesty: {
    text: 'openai/gpt-4o',
    cheap: 'openai/gpt-4o-mini',
  },
  gemini: {
    text: 'gemini-2.5-flash',
    cheap: 'gemini-2.0-flash',
  },
  'claude-code-cli': {
    text: 'claude-sonnet-4-6',
    cheap: 'claude-haiku-4-5-20251001',
  },
  'gemini-cli': {
    text: 'gemini-2.5-flash',
    cheap: 'gemini-2.0-flash-lite',
  },
  stability: {
    image: 'stable-diffusion-xl-1024-v1-0',
  },
  replicate: {
    image: 'black-forest-labs/flux-1.1-pro',
  },
  'stable-diffusion-local': {
    image: 'v1-5-pruned-emaonly',
  },
  bfl: {
    image: 'flux-pro-1.1',
  },
  fal: {
    image: 'fal-ai/flux/dev',
  },
  groq: {
    text: 'llama-3.3-70b-versatile',
    cheap: 'gemma2-9b-it',
  },
  together: {
    text: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
    cheap: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
  },
  mistral: {
    text: 'mistral-large-latest',
    cheap: 'mistral-small-latest',
  },
  xai: {
    text: 'grok-2',
    cheap: 'grok-2-mini',
  },
};

/** Runtime probes checked for auto-detection, in priority order. */
type AutoDetectProbe =
  | { provider: string; envKey: string }
  | { provider: string; binaryName: string };

/**
 * Auto-detection priority order for providers.
 *
 * OpenAI is first because it supports ALL task types (text, image, embedding).
 * OpenRouter is second — it supports text but NOT embeddings, so putting it
 * first caused embedding failures when both keys were set.
 * Anthropic third — it supports text but not image/embedding.
 *
 * The task filter in autoDetectProvider() skips providers that don't support
 * the requested task type, so the order matters most for the default (text) case.
 */
const AUTO_DETECT_ORDER: AutoDetectProbe[] = [
  // OpenRouter first: users who set OPENROUTER_API_KEY alongside a
  // direct-provider key typically intend the OpenRouter aggregator
  // to mediate (failover, cost routing, etc.). Matches the documented
  // priority comment below and the provider-defaults.test.ts pin that
  // "openrouter wins when both OPENROUTER_API_KEY and OPENAI_API_KEY
  // are set".
  { envKey: 'OPENROUTER_API_KEY', provider: 'openrouter' },
  { envKey: 'OPENAI_API_KEY', provider: 'openai' },
  { envKey: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { envKey: 'GEMINI_API_KEY', provider: 'gemini' },
  { envKey: 'GROQ_API_KEY', provider: 'groq' },
  { envKey: 'TOGETHER_API_KEY', provider: 'together' },
  { envKey: 'MISTRAL_API_KEY', provider: 'mistral' },
  { envKey: 'XAI_API_KEY', provider: 'xai' },
  { envKey: 'REQUESTY_API_KEY', provider: 'requesty' },
  { binaryName: 'claude', provider: 'claude-code-cli' },
  { binaryName: 'gemini', provider: 'gemini-cli' },
  { envKey: 'OLLAMA_BASE_URL', provider: 'ollama' },
  { envKey: 'STABILITY_API_KEY', provider: 'stability' },
  { envKey: 'REPLICATE_API_TOKEN', provider: 'replicate' },
  { envKey: 'STABLE_DIFFUSION_LOCAL_BASE_URL', provider: 'stable-diffusion-local' },
  { envKey: 'BFL_API_KEY', provider: 'bfl' },
  { envKey: 'FAL_API_KEY', provider: 'fal' },
];

function isBinaryOnPath(binaryName: string): boolean {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookupCommand, [binaryName], { stdio: 'ignore' });
  return result.status === 0;
}

// Provider-id → probe lookup so a custom priority list (just provider
// ids) can be resolved back to its env-var or CLI-binary probe. Stays
// in sync automatically with `AUTO_DETECT_ORDER`.
const PROBE_BY_PROVIDER: Record<string, AutoDetectProbe> = Object.fromEntries(
  AUTO_DETECT_ORDER.map((probe) => [probe.provider, probe])
);

/**
 * Auto-detects the active provider by scanning well-known environment variables
 * and CLI binaries in priority order.
 *
 * Returns the identifier of the first provider whose key/URL env var is non-empty
 * or whose CLI binary is on PATH, or `undefined` when no recognisable runtime is present.
 *
 * Default priority: openrouter → openai → anthropic → gemini → claude-code-cli → gemini-cli → ollama → …
 *
 * The order can be overridden process-wide via `setProviderPriority(['anthropic', 'openai', ...])`.
 * When a custom list is installed, only the providers in that list are
 * considered (in the order given); pass the full set you want detection
 * to consider.
 */
export function autoDetectProvider(task?: ProviderDefaultTask): string | undefined {
  const customOrder = getProviderPriority();
  const order: AutoDetectProbe[] = customOrder
    ? customOrder
        .map((p) => PROBE_BY_PROVIDER[p])
        .filter((probe): probe is AutoDetectProbe => Boolean(probe))
    : AUTO_DETECT_ORDER;

  for (const probe of order) {
    const available = 'envKey' in probe
      ? Boolean(process.env[probe.envKey])
      : isBinaryOnPath(probe.binaryName);

    if (!available) continue;
    const { provider } = probe;
    if (task && !PROVIDER_DEFAULTS[provider]?.[task]) continue;
    return provider;
  }
  return undefined;
}
