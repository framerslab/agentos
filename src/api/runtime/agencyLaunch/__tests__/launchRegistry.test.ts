/**
 * The launch registry (spec 4.7): admission counts the running and closing entries of a scope, and a root scope's
 * launch pool is one per turn. Pure logic over module state: every case uses scope keys of its own.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SpendBudget } from '../../spendBudget.js';
import { launchRegistry, type LaunchEntry } from '../launchRegistry.js';
import { resolveLaunchLimits } from '../types.js';

const limits = resolveLaunchLimits({ maxConcurrent: 2 });
const entry = (scopeKey: string, state: LaunchEntry['state'] = 'running'): LaunchEntry => ({
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
  state,
});

describe('launchRegistry', () => {
  it('admits up to maxConcurrent per scope, counting closing entries, and frees a slot on removal', () => {
    const scope = `scope-${randomUUID()}`;
    const first = entry(scope);
    const closing = entry(scope, 'closing');
    expect(launchRegistry.admit(first)).toEqual({ ok: true });
    expect(launchRegistry.admit(closing)).toEqual({ ok: true });
    expect(launchRegistry.admit(entry(scope))).toEqual({ ok: false, inFlight: 2 });
    // Another scope is counted apart.
    const other = entry(`scope-${randomUUID()}`);
    expect(launchRegistry.admit(other)).toEqual({ ok: true });
    launchRegistry.remove(closing.launchId);
    const next = entry(scope);
    expect(launchRegistry.admit(next)).toEqual({ ok: true });
    for (const e of [first, other, next]) launchRegistry.remove(e.launchId);
    expect(launchRegistry.get(first.launchId)).toBeUndefined();
  });

  it('marks an entry closing', () => {
    const e = entry(`scope-${randomUUID()}`);
    launchRegistry.admit(e);
    launchRegistry.markClosing(e.launchId);
    expect(launchRegistry.get(e.launchId)?.state).toBe('closing');
    launchRegistry.remove(e.launchId);
  });

  it("keeps one launch pool per root scope's turn, under the turn's budget", () => {
    const scope = `root-${randomUUID()}`;
    const turnBudget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 100_000 });
    const pool = launchRegistry.rootPool(scope, 'turn-1', limits, turnBudget);
    expect(launchRegistry.rootPool(scope, 'turn-1', limits, turnBudget)).toBe(pool);
    // A call with no turn id shares the scope's current pool; a later turn gets a new one.
    expect(launchRegistry.rootPool(scope, undefined, limits)).toBe(pool);
    expect(launchRegistry.rootPool(scope, 'turn-2', limits, turnBudget)).not.toBe(pool);
    expect(pool.remaining()).toEqual({ usd: Number.POSITIVE_INFINITY, tokens: 200_000 });
    // Records reach the turn's budget.
    pool.record(undefined, 1_000, 'seat');
    expect(turnBudget.tokensUsed()).toBe(1_000);
  });
});
