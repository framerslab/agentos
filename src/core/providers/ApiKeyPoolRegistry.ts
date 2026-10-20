/**
 * @module core/providers/ApiKeyPoolRegistry
 *
 * Singleton registry for API key pools keyed by environment variable name.
 * Providers that share the same env var (e.g., all ElevenLabs providers
 * share ELEVENLABS_API_KEY) get the same pool instance so exhaustion
 * state is consistent across the process.
 */

import { createLogger } from '../logging/index.js';
import { ApiKeyPool, type ApiKeyPoolConfig } from './ApiKeyPool.js';

const pools = new Map<string, ApiKeyPool>();
/** The variables whose dropped later config has been logged, so each writes its warning once. */
const ignoredConfigLogged = new Set<string>();

/**
 * Get or create an ApiKeyPool for the given environment variable.
 * Returns a singleton -- the same pool is returned on subsequent calls
 * with the same env var name. The first call's config builds the pool; a
 * config passed to a later call is ignored (the pool keeps its strategy,
 * store, id and timings) and logged once per variable as
 * `key_pool.registry_config_ignored`, naming the variable and none of the
 * config's values.
 */
export function getKeyPool(envVar: string, config?: ApiKeyPoolConfig): ApiKeyPool {
  let pool = pools.get(envVar);
  if (!pool) {
    pool = new ApiKeyPool(process.env[envVar] ?? '', config);
    pools.set(envVar, pool);
  } else if (config && !ignoredConfigLogged.has(envVar)) {
    ignoredConfigLogged.add(envVar);
    createLogger('key-pool').warn('key_pool.registry_config_ignored', { envVar });
  }
  return pool;
}

/** Reset all pools. For testing only. */
export function resetAllPools(): void {
  pools.clear();
  ignoredConfigLogged.clear();
}
