import { describe, expect, it } from 'vitest';
import { InMemoryCompoundCreditStore, type CreditLotRow } from '../CompoundCreditStore.js';
import { promotionsFirstPolicy, withCreditRetry } from '../CompoundCreditLedger.js';
import { CreditConflictError } from '../CompoundCreditStore.js';
import { runCompoundCreditLedgerContract } from './compoundCreditLedger.contract.js';

runCompoundCreditLedgerContract('memory', async () => ({ store: new InMemoryCompoundCreditStore(), id: (s) => s }), { concurrent: true });

const lot = (over: Partial<CreditLotRow>): CreditLotRow => ({
  lotId: 'l', scopeId: 's', kind: 'paid', fundingRef: 'f', principalMicro: 100, consumedMicro: 0, heldMicro: 0, refundedMicro: 0, retiredMicro: 0,
  state: 'active', expiresAt: null, createdAt: 0, version: 1, ...over,
});

describe('promotionsFirstPolicy', () => {
  it('orders eligible promotions by expiry, then paid lots by creation, and leaves out spent, expired and disputed lots', () => {
    const ordered = promotionsFirstPolicy(
      [
        lot({ lotId: 'paid-b', createdAt: 2 }),
        lot({ lotId: 'paid-a', createdAt: 1 }),
        lot({ lotId: 'promo-late', kind: 'promotion', expiresAt: 900 }),
        lot({ lotId: 'promo-soon', kind: 'promotion', expiresAt: 500 }),
        lot({ lotId: 'expired', kind: 'promotion', expiresAt: 10 }),
        lot({ lotId: 'spent', consumedMicro: 100 }),
        lot({ lotId: 'disputed', state: 'disputed' }),
      ],
      100,
    );
    expect(ordered.map((l) => l.lotId)).toEqual(['promo-soon', 'promo-late', 'paid-a', 'paid-b']);
  });
});

describe('withCreditRetry', () => {
  it('runs a transaction again after a conflict, and gives up after three', async () => {
    const store = new InMemoryCompoundCreditStore();
    let tries = 0;
    await expect(withCreditRetry(store, async () => { tries += 1; if (tries < 3) throw new CreditConflictError('lots', 'l'); return 'done'; })).resolves.toBe('done');
    tries = 0;
    await expect(withCreditRetry(store, async () => { tries += 1; throw new CreditConflictError('lots', 'l'); })).rejects.toBeInstanceOf(CreditConflictError);
    expect(tries).toBe(3);
  });
});
