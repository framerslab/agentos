import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  CostGuard,
  CostCapExceededError,
} from '../../../src/safety/runtime/CostGuard.js';

describe('CostGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('canAfford allows within limits', () => {
    const guard = new CostGuard();
    const result = guard.canAfford('agent-1', 0.10);
    expect(result.allowed).toBe(true);
    expect(result.capType).toBeUndefined();
  });

  it('single operation cap rejects over limit', () => {
    const guard = new CostGuard({ maxSingleOperationCostUsd: 0.50 });
    const result = guard.canAfford('agent-1', 0.60);
    expect(result.allowed).toBe(false);
    expect(result.capType).toBe('single_operation');
  });

  it('session cap rejects when accumulated cost exceeds limit', () => {
    const guard = new CostGuard({ maxSessionCostUsd: 1.00 });

    guard.recordCost('agent-1', 0.40);
    guard.recordCost('agent-1', 0.40);

    // 0.80 + 0.30 = 1.10 > 1.00
    const result = guard.canAfford('agent-1', 0.30);
    expect(result.allowed).toBe(false);
    expect(result.capType).toBe('session');
  });

  it('daily cap rejects when accumulated cost exceeds limit', () => {
    const guard = new CostGuard({
      maxSessionCostUsd: 100, // high so session cap doesn't interfere
      maxDailyCostUsd: 5.00,
      maxSingleOperationCostUsd: 10.00, // high so single op cap doesn't interfere
    });

    // Accumulate close to daily limit across multiple sessions
    guard.recordCost('agent-1', 2.00);
    guard.recordCost('agent-1', 2.00);

    // Reset session but daily should persist
    guard.resetSession('agent-1');

    guard.recordCost('agent-1', 0.50);

    // 4.50 daily + 0.60 = 5.10 > 5.00
    const result = guard.canAfford('agent-1', 0.60);
    expect(result.allowed).toBe(false);
    expect(result.capType).toBe('daily');
  });

  it('a refusal carries the total under the cap that refused and that cap', () => {
    const guard = new CostGuard({
      maxSessionCostUsd: 1.00,
      maxDailyCostUsd: 1.50,
      maxSingleOperationCostUsd: 0.50,
    });

    guard.recordCost('agent-1', 0.75);

    // Single operation: the estimate itself against the per-operation cap
    expect(guard.canAfford('agent-1', 0.60)).toMatchObject({ capType: 'single_operation', currentCostUsd: 0.60, limitUsd: 0.50 });

    // Session: 0.75 so far against 1.00
    expect(guard.canAfford('agent-1', 0.30)).toMatchObject({ capType: 'session', currentCostUsd: 0.75, limitUsd: 1.00 });

    // Daily: a new session of 0.50 leaves 1.25 for the day against 1.50
    guard.resetSession('agent-1');
    guard.recordCost('agent-1', 0.50);
    expect(guard.canAfford('agent-1', 0.30)).toMatchObject({ capType: 'daily', currentCostUsd: 1.25, limitUsd: 1.50 });

    // An operation that fits carries neither
    expect(guard.canAfford('agent-1', 0.10)).toEqual({ allowed: true });
  });

  it('recordCost() accumulates correctly', () => {
    const guard = new CostGuard();

    guard.recordCost('agent-1', 0.10, 'op-1');
    guard.recordCost('agent-1', 0.20, 'op-2');

    const snapshot = guard.getSnapshot('agent-1');
    expect(snapshot.sessionCostUsd).toBeCloseTo(0.30, 4);
    expect(snapshot.dailyCostUsd).toBeCloseTo(0.30, 4);
  });

  it('onCapReached callback fires when session cap hit', () => {
    const onCap = vi.fn();
    const guard = new CostGuard({
      maxSessionCostUsd: 0.50,
      onCapReached: onCap,
    });

    guard.recordCost('agent-1', 0.50);

    expect(onCap).toHaveBeenCalledWith('agent-1', 'session', 0.50, 0.50);
  });

  it('onCapReached callback fires when daily cap hit', () => {
    const onCap = vi.fn();
    const guard = new CostGuard({
      maxSessionCostUsd: 100,
      maxDailyCostUsd: 1.00,
      onCapReached: onCap,
    });

    guard.recordCost('agent-1', 1.00);

    expect(onCap).toHaveBeenCalledWith('agent-1', 'daily', 1.00, 1.00);
  });

  it('resetSession() clears session cost but daily remains', () => {
    const guard = new CostGuard();

    guard.recordCost('agent-1', 0.50);
    guard.resetSession('agent-1');

    const snapshot = guard.getSnapshot('agent-1');
    expect(snapshot.sessionCostUsd).toBe(0);
    expect(snapshot.dailyCostUsd).toBeCloseTo(0.50, 4);
  });

  it('resetDailyAll() clears daily for all agents', () => {
    const guard = new CostGuard();

    guard.recordCost('agent-1', 0.50);
    guard.recordCost('agent-2', 0.75);

    guard.resetDailyAll();

    const snap1 = guard.getSnapshot('agent-1');
    const snap2 = guard.getSnapshot('agent-2');
    expect(snap1.dailyCostUsd).toBe(0);
    expect(snap2.dailyCostUsd).toBe(0);
  });

  it('setAgentLimits() applies per-agent overrides', () => {
    const guard = new CostGuard({
      maxSessionCostUsd: 1.00,
    });

    // Give agent-1 a lower session limit
    guard.setAgentLimits('agent-1', { maxSessionCostUsd: 0.20 });

    guard.recordCost('agent-1', 0.15);

    // 0.15 + 0.10 = 0.25 > 0.20 custom limit
    const result = guard.canAfford('agent-1', 0.10);
    expect(result.allowed).toBe(false);
    expect(result.capType).toBe('session');

    // agent-2 still uses global limit
    guard.recordCost('agent-2', 0.15);
    const result2 = guard.canAfford('agent-2', 0.10);
    expect(result2.allowed).toBe(true);
  });

  it('daily auto-reset at midnight', () => {
    const guard = new CostGuard({
      maxSessionCostUsd: 100,
      maxDailyCostUsd: 5.00,
    });

    guard.recordCost('agent-1', 4.00);
    const beforeReset = guard.getSnapshot('agent-1');
    expect(beforeReset.dailyCostUsd).toBeCloseTo(4.00, 4);

    // Advance past midnight
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const msToMidnight = midnight.getTime() - now.getTime();
    vi.advanceTimersByTime(msToMidnight + 1);

    // Daily cost should have reset
    const afterReset = guard.getSnapshot('agent-1');
    expect(afterReset.dailyCostUsd).toBe(0);
  });

  it('getSnapshot() returns accurate data', () => {
    const guard = new CostGuard({
      maxSessionCostUsd: 2.00,
      maxDailyCostUsd: 10.00,
    });

    guard.recordCost('agent-1', 0.25);

    const snapshot = guard.getSnapshot('agent-1');
    expect(snapshot.agentId).toBe('agent-1');
    expect(snapshot.sessionCostUsd).toBeCloseTo(0.25, 4);
    expect(snapshot.dailyCostUsd).toBeCloseTo(0.25, 4);
    expect(snapshot.sessionLimit).toBe(2.00);
    expect(snapshot.dailyLimit).toBe(10.00);
    expect(snapshot.isSessionCapReached).toBe(false);
    expect(snapshot.isDailyCapReached).toBe(false);
  });

  it('CostCapExceededError has correct fields', () => {
    const error = new CostCapExceededError('agent-42', 'session', 1.50, 1.00);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CostCapExceededError');
    expect(error.agentId).toBe('agent-42');
    expect(error.capType).toBe('session');
    expect(error.currentCost).toBe(1.50);
    expect(error.limit).toBe(1.00);
    expect(error.message).toContain('session');
    expect(error.message).toContain('agent-42');
  });
});
