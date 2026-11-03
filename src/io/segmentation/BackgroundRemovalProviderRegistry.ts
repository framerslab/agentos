/**
 * @module io/segmentation/BackgroundRemovalProviderRegistry
 *
 * Resolves background removal providers by id. The built-in `fal` provider
 * is built from `FAL_API_KEY` on first use and kept for the calls that bring
 * no credentials; calls that miss the cache at the same time share one build.
 * A call's own `apiKey` or `baseUrl` gets a provider of its own, kept for the
 * next call with the same key and URL (the most recent
 * {@link MAX_CONFIGURED_PROVIDERS}), so a comma-separated key list rotates
 * across calls as the environment's does. Custom providers and tests inject
 * instances with {@link registerBackgroundRemovalProvider}; a registered
 * instance is served as registered, whatever the call's `apiKey` or `baseUrl`.
 */
import { FalBackgroundRemovalProvider } from './providers/FalBackgroundRemovalProvider.js';
import type { BackgroundRemovalProviderId, IBackgroundRemovalProvider } from './types.js';

/** Providers registered by the host, served first. */
const registered = new Map<string, IBackgroundRemovalProvider>();
/**
 * Built-in providers built from the environment, kept for the next call that
 * brings no credentials. The promise is kept from the first miss, so calls
 * that miss at the same time share one provider and its key pool.
 */
const fromEnvironment = new Map<string, Promise<IBackgroundRemovalProvider>>();
/** How many providers built from a call's own credentials are kept, the least recently used dropped first. */
export const MAX_CONFIGURED_PROVIDERS = 32;
/** Built-in providers built from a call's own credentials, by id, key and base URL, least recently used first. */
const fromCallConfig = new Map<string, Promise<IBackgroundRemovalProvider>>();

/** Credentials for a built-in provider, in place of its environment variables. */
export interface BackgroundRemovalProviderConfig {
  /** The provider's API key (fal: in place of `FAL_API_KEY`). */
  apiKey?: string;
  /** The provider's base URL (fal: default `https://fal.run`). */
  baseUrl?: string;
}

/** Register (or override) a provider instance under `id`. */
export function registerBackgroundRemovalProvider(id: string, provider: IBackgroundRemovalProvider): void {
  registered.set(id, provider);
}

/** Clear all cached and registered instances. */
export function resetBackgroundRemovalProviders(): void {
  registered.clear();
  fromEnvironment.clear();
  fromCallConfig.clear();
}

/** Build and initialize a fal provider; the cache entry is dropped when initialization fails. */
function buildFal(
  cache: Map<string, Promise<IBackgroundRemovalProvider>>,
  cacheKey: string,
  apiKey: string,
  baseURL: string | undefined,
): Promise<IBackgroundRemovalProvider> {
  const pending = (async () => {
    const provider = new FalBackgroundRemovalProvider();
    await provider.initialize({ apiKey, baseURL });
    return provider;
  })();
  cache.set(cacheKey, pending);
  pending.catch(() => {
    if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
  });
  return pending;
}

/**
 * Resolve a provider: a registered instance first, else a built-in.
 *
 * @param id - Provider id. Defaults to `'fal'`.
 * @param config - Credentials for a built-in provider; without them it is
 *   built from the environment. Either way it is kept for the next call
 *   with the same credentials, and calls that resolve it at the same time
 *   get the same instance.
 * @throws {Error} When the id is unknown or the provider's key is missing.
 */
export async function resolveBackgroundRemovalProvider(
  id: BackgroundRemovalProviderId = 'fal',
  config: BackgroundRemovalProviderConfig = {},
): Promise<IBackgroundRemovalProvider> {
  const host = registered.get(id);
  if (host) return host;

  if (id === 'fal') {
    const ownKey = config.apiKey?.trim();
    const ownBaseUrl = config.baseUrl?.trim();
    // A call's own credentials never reach the provider built from the
    // environment, which holds FAL_API_KEY and fal's URL.
    const fromCall = Boolean(ownKey || ownBaseUrl);
    if (!fromCall) {
      const cached = fromEnvironment.get(id);
      if (cached) return cached;
    }
    const apiKey = ownKey || process.env.FAL_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('Background removal provider "fal" requires FAL_API_KEY or an apiKey on the call.');
    }
    if (!fromCall) return buildFal(fromEnvironment, id, apiKey, undefined);

    const cacheKey = JSON.stringify([id, apiKey, ownBaseUrl ?? '']);
    const cached = fromCallConfig.get(cacheKey);
    if (cached) {
      // Most recently used last.
      fromCallConfig.delete(cacheKey);
      fromCallConfig.set(cacheKey, cached);
      return cached;
    }
    const pending = buildFal(fromCallConfig, cacheKey, apiKey, ownBaseUrl);
    while (fromCallConfig.size > MAX_CONFIGURED_PROVIDERS) {
      const oldest = fromCallConfig.keys().next().value;
      if (oldest === undefined) break;
      fromCallConfig.delete(oldest);
    }
    return pending;
  }

  throw new Error(`Unknown background removal provider "${id}".`);
}
