/**
 * @module io/segmentation/BackgroundRemovalProviderRegistry
 *
 * Resolves background removal providers by id. The built-in `fal` provider
 * is built from `FAL_API_KEY` on first use and kept for the calls that bring
 * no credentials; a call's own `apiKey` or `baseUrl` always builds one for
 * that call alone. Custom providers and tests inject
 * instances with {@link registerBackgroundRemovalProvider}; a registered
 * instance is served as registered, whatever the call's `apiKey` or `baseUrl`.
 */
import { FalBackgroundRemovalProvider } from './providers/FalBackgroundRemovalProvider.js';
import type { BackgroundRemovalProviderId, IBackgroundRemovalProvider } from './types.js';

/** Providers registered by the host, served first. */
const registered = new Map<string, IBackgroundRemovalProvider>();
/** Built-in providers built from the environment, kept for the next call that brings no credentials. */
const fromEnvironment = new Map<string, IBackgroundRemovalProvider>();

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
}

/**
 * Resolve a provider: a registered instance first, else a built-in.
 *
 * @param id - Provider id. Defaults to `'fal'`.
 * @param config - Credentials for a built-in provider; without them it is
 *   built from the environment and cached.
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
    // A call's own credentials always build a provider of its own: the
    // provider built from the environment holds FAL_API_KEY and fal's URL.
    if (!ownKey && !ownBaseUrl) {
      const cached = fromEnvironment.get(id);
      if (cached) return cached;
    }
    const apiKey = ownKey || process.env.FAL_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('Background removal provider "fal" requires FAL_API_KEY or an apiKey on the call.');
    }
    const provider = new FalBackgroundRemovalProvider();
    await provider.initialize({ apiKey, baseURL: ownBaseUrl });
    if (!ownKey && !ownBaseUrl) fromEnvironment.set(id, provider);
    return provider;
  }

  throw new Error(`Unknown background removal provider "${id}".`);
}
