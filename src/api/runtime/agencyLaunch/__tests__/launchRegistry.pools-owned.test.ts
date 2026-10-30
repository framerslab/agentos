/**
 * The launch registry's root pools kept by an owner (on gmi(), the GMI that runs the turn): the bound on root scopes
 * never drops them, a later turn of the owner gets a new one, and two owners never share one. Its own file, so the
 * registry's module state holds no other case's scopes.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_POOL_SCOPES, launchRegistry } from '../launchRegistry.js';
import { resolveLaunchLimits } from '../types.js';

const limits = resolveLaunchLimits({});

describe('launchRegistry root pools kept by an owner', () => {
  it('keeps a turn its pool past the bound, gives a later turn a new one, and never shares one between owners', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = {};
    const first = launchRegistry.rootPool('gmi:owned', 'turn-1', limits, undefined, owner);
    // More scopes than the bound open a pool each, kept by scope: none of them can push the owned pool out.
    for (let i = 0; i <= MAX_POOL_SCOPES; i += 1) launchRegistry.rootPool(`gmi:scope-${i}`, 'turn-1', limits);
    expect(launchRegistry.rootPool('gmi:owned', 'turn-1', limits, undefined, owner)).toBe(first);
    // A call with no turn id shares the turn's pool; a later turn of the owner starts a new one.
    expect(launchRegistry.rootPool('gmi:owned', undefined, limits, undefined, owner)).toBe(first);
    const second = launchRegistry.rootPool('gmi:owned', 'turn-2', limits, undefined, owner);
    expect(second).not.toBe(first);
    expect(launchRegistry.rootPool('gmi:owned', 'turn-2', limits, undefined, owner)).toBe(second);
    // Another owner of the same scope and turn has a pool of its own.
    expect(launchRegistry.rootPool('gmi:owned', 'turn-2', limits, undefined, {})).not.toBe(second);
    warn.mockRestore();
  });
});
