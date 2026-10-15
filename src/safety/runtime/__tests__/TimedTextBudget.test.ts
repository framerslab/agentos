import { describe, expect, it, vi } from 'vitest';
import { InMemoryCompoundCreditStore } from '../CompoundCreditStore.js';
import { withCreditRetry } from '../CompoundCreditLedger.js';
import { createTimedTextBudget, readTimedTextBudget, reportTimedTextBudget, renewTimedTextBudget,
  settleTimedTextBudget } from '../TimedTextBudget.js';

describe('time-based text funding', () => {
  it('renews once per hour independently of sockets and settles every part once', async () => {
    const store = new InMemoryCompoundCreditStore();
    const scopeId = 'text-fixture'; const budgetId = 'session';
    const run = <T>(work: Parameters<typeof withCreditRetry<T>>[1]) => withCreditRetry(store, work);
    const reserve = vi.fn(async () => 'next-hour');
    const settle = vi.fn(async () => undefined);
    await run((t) => createTimedTextBudget(t, { scopeId, budgetId, at: 0, sliceMs: 3600000,
      partMicro: 100, initialReservationId: 'initial' }));
    await run((t) => reportTimedTextBudget(t, scopeId, budgetId, 75));
    await expect(run((t) => renewTimedTextBudget(t, { scopeId, budgetId, at: 3599999,
      cumulativeMicro: 75, allowed: true }, reserve))).rejects.toThrow('boundary');
    await run((t) => renewTimedTextBudget(t, { scopeId, budgetId, at: 3600000, cumulativeMicro: 75, allowed: true }, reserve));
    await run((t) => renewTimedTextBudget(t, { scopeId, budgetId, at: 3600001, cumulativeMicro: 75, allowed: true }, reserve));
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(await run((t) => readTimedTextBudget(t, scopeId, budgetId))).toMatchObject({ leftMicro: 100, renewAtMs: 7200000 });
    await run((t) => reportTimedTextBudget(t, scopeId, budgetId, 95));
    expect(await run((t) => readTimedTextBudget(t, scopeId, budgetId))).toMatchObject({ leftMicro: 80 });
    await expect(run((t) => renewTimedTextBudget(t, { scopeId, budgetId, at: 7200000,
      cumulativeMicro: 95, allowed: false }, reserve))).rejects.toThrow('allowance');
    expect(reserve).toHaveBeenCalledTimes(1);
    for (let retry = 0; retry < 2; retry++) {
      await run((t) => settleTimedTextBudget(t, { scopeId, budgetId, initialAudioMicro: 30 }, settle));
    }
    expect(settle.mock.calls).toEqual([['initial', 105], ['next-hour', 20]]);
  });
});
