/**
 * @module io/segmentation/BackgroundRemovalProviderRegistry
 *
 * Resolves background removal providers by id. The built-in `fal` provider
 * is built from `FAL_API_KEY` on first use and kept; a call's own `apiKey` or
 * `baseUrl` builds one for that call alone. Custom providers and tests inject
 * instances with {@link registerBackgroundRemovalProvider}; a registered
 * instance is served as registered, whatever the call's `apiKey` or `baseUrl`.
 */
import { FalBackgroundRemovalProvider } from './providers/FalBackgroundRemovalProvider.js';
import type { BackgroundRemovalProviderId, IBackgroundRemovalProvider } from './types.js';

const instances = new Map<string, IBackgroundRemovalProvider>();

/** Credentials for a built-in provider, in place of its environment variables. */
export interface BackgroundRemovalProviderConfig {
  /** The provider's API key (fal: in place of `FAL_API_KEY`). */
  apiKey?: string;
  /** The provider's base URL (fal: default `https://fal.run`). */
  baseUrl?: string;
}

/** Register (or override) a provider instance under `id`. */
export function registerBackgroundRemovalProvider(id: string, provider: IBackgroundRemovalProvider): void {
  instances.set(id, provider);
}

/** Clear all cached and registered instances. */
export function resetBackgroundRemovalProviders(): void {
  instances.clear();
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
  const existing = instances.get(id);
  if (existing) return existing;

  if (id === 'fal') {
    const ownKey = config.apiKey?.trim();
    const ownBaseUrl = config.baseUrl?.trim();
    const apiKey = ownKey || process.env.FAL_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('Background removal provider "fal" requires FAL_API_KEY or an apiKey on the call.');
    }
    const provider = new FalBackgroundRemovalProvider();
    await provider.initialize({ apiKey, baseURL: ownBaseUrl });
    if (!ownKey && !ownBaseUrl) instances.set(id, provider);
    return provider;
  }

  throw new Error(`Unknown background removal provider "${id}".`);
}
