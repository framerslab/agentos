/**
 * @module api/keyPoolDefaults
 *
 * The key pool defaults a host sets once at boot for every provider that
 * `generateText()`, `streamText()` and the completion gateway build through
 * `createProviderManager()`: a store that persists each key's standing, a
 * strategy, and the timings. A key read from the environment gets the pool id
 * `<providerId>:<ENV_VAR>` (see `ResolvedProvider.poolId`), under which the
 * store keeps its rows; an override or a global default names no pool, so the
 * store does not apply to it. Set the defaults before the first call: a
 * manager already built and cached keeps the pool it was built with.
 *
 * @example
 * ```ts
 * import { setKeyPoolDefaults, SqlKeyPoolStateStore } from '@framers/agentos';
 * setKeyPoolDefaults({ strategy: 'ordered', store: new SqlKeyPoolStateStore({ db }) });
 * ```
 */
import type { ApiKeyPoolConfig } from '../core/providers/ApiKeyPool.js';

/** What a host may set for every pool the API builds: the persisted-state store, the strategy and the timings. */
export type KeyPoolDefaults = Pick<ApiKeyPoolConfig, 'strategy' | 'store' | 'cooldownMs' | 'recheckMs' | 'maxRecheckMs' | 'maxRetryAfterMs'>;

let defaults: KeyPoolDefaults | null = null;

/** Sets the defaults for every pool the API builds from here on; `null` clears them. */
export function setKeyPoolDefaults(next: KeyPoolDefaults | null): void {
  defaults = next ? { ...next } : null;
}

/** The defaults set with {@link setKeyPoolDefaults}, or null. */
export function getKeyPoolDefaults(): KeyPoolDefaults | null {
  return defaults ? { ...defaults } : null;
}

/** The `keyPool` config for one provider: the defaults plus the pool id, or undefined when there is neither. */
export function keyPoolConfigFor(poolId: string | undefined): (KeyPoolDefaults & { id?: string }) | undefined {
  if (!defaults && !poolId) return undefined;
  return { ...(defaults ?? {}), ...(poolId ? { id: poolId } : {}) };
}
