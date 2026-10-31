/**
 * The launch registry's bound on root pools: past MAX_POOL_SCOPES root scopes, the least recently used scope whose
 * pool is not in use goes, and a warning says so. Its own file, so the registry's module state holds no other case's
 * scopes and the count is exact.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SpendBudget } from '../../spendBudget.js';
import { MAX_POOL_SCOPES, launchRegistry, type LaunchEntry } from '../launchRegistry.js';
import { resolveLaunchLimits } from '../types.js';

const limits = resolveLaunchLimits({});
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

describe('launchRegistry root pools', () => {
  it('drops the least recently used pool past MAX_POOL_SCOPES, never one whose scope has a launch in flight, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The oldest scope has a launch in flight; the next two have none, and the first of them is used again.
    const busy = launchRegistry.rootPool('gmi:busy', 'turn-1', limits);
    const inFlight = entry('gmi:busy');
    expect(launchRegistry.admit(inFlight)).toEqual({ ok: true });
    const touched = launchRegistry.rootPool('gmi:touched', 'turn-1', limits);
    const idle = launchRegistry.rootPool('gmi:idle', 'turn-1', limits);
    expect(launchRegistry.rootPool('gmi:touched', 'turn-1', limits)).toBe(touched);

    // One scope more than the bound: one pool goes, the idle scope's.
    for (let i = 3; i <= MAX_POOL_SCOPES; i += 1) launchRegistry.rootPool(`gmi:fill-${i}`, 'turn-1', limits);
    expect(launchRegistry.rootPool('gmi:busy', 'turn-1', limits)).toBe(busy);
    expect(launchRegistry.rootPool('gmi:touched', 'turn-1', limits)).toBe(touched);
    expect(launchRegistry.rootPool('gmi:idle', 'turn-1', limits)).not.toBe(idle);
    const lines = warn.mock.calls.map((call) => call.map(String).join(' '));
    expect(lines.filter((line) => line.includes('launch pool'))).toHaveLength(1);

    launchRegistry.remove(inFlight.launchId);
    warn.mockRestore();
  });
});
