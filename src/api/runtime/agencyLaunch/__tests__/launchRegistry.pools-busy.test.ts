/**
 * The launch registry's bound on root pools while scopes are busy: past MAX_POOL_SCOPES the pools of scopes with a
 * launch in flight are kept, and once those launches end the registry is brought back to the bound. Its own file, so
 * the registry's module state holds no other case's scopes and the count is exact.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SpendBudget } from '../../spendBudget.js';
import { MAX_POOL_SCOPES, launchRegistry, type LaunchEntry } from '../launchRegistry.js';
import { resolveLaunchLimits } from '../types.js';

const limits = resolveLaunchLimits({ maxConcurrent: 1 });
const entry = (scopeKey: string): LaunchEntry => ({
  launchId: `agency-${randomUUID()}`,
  depth: 1,
  limits,
  scopeKey,
  budget: new SpendBudget({ maxCostUSD: 1 }),
  signal: new AbortController().signal,
  namespace: '',
  toolHooks: [],
  seatTools: new Map(),
  outputEstimateTokens: 4_096,
  state: 'running',
});

describe('launchRegistry root pools of busy scopes', () => {
  it('keeps every busy scope past the bound, and drops the excess once their launches end', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // One more busy scope than the bound: none of their pools can go while its launch runs.
    const running: LaunchEntry[] = [];
    const pools: SpendBudget[] = [];
    for (let i = 0; i <= MAX_POOL_SCOPES; i += 1) {
      const launch = entry(`gmi:busy-${i}`);
      expect(launchRegistry.admit(launch)).toEqual({ ok: true });
      running.push(launch);
      pools.push(launchRegistry.rootPool(`gmi:busy-${i}`, 'turn-1', limits));
    }
    expect(launchRegistry.rootPool('gmi:busy-0', 'turn-1', limits)).toBe(pools[0]);

    // busy-1's launch ends first: its pool, now the least recently used idle one, goes, which brings the registry back
    // to the bound; the other launches then end with nothing more to drop.
    launchRegistry.remove(running[1].launchId);
    for (const launch of running) launchRegistry.remove(launch.launchId);
    expect(launchRegistry.rootPool('gmi:busy-2', 'turn-1', limits)).toBe(pools[2]);
    expect(launchRegistry.rootPool('gmi:busy-1', 'turn-1', limits)).not.toBe(pools[1]);
    warn.mockRestore();
  });
});
