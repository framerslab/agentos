import { describe, expect, it } from 'vitest';
import {
  selectLowestCostSttEntry, sttLanguageOptions,
  type LowestCostSttOptions,
  type SttCreditSnapshot,
  type SttPriceRow,
} from '../LowestCostStt.js';

// Synthetic rows and credit: they exercise the ordering and the credit rules, not any provider's tariff, and nothing
// here contacts a provider.
const dg = 'deepgram:nova-3';
const oa = 'openai:gpt-4o-mini-transcribe';
const nowMs = Date.UTC(2026, 9, 14, 12);
const rows: readonly SttPriceRow[] = [
  { entry: dg, microPerMinute: 4_800 },
  { entry: oa, microPerMinute: 3_000 },
];

function options(changes: Partial<LowestCostSttOptions> = {}): LowestCostSttOptions {
  return {
    availableVendors: ['deepgram', 'openai'],
    nowMs,
    estimatedSeconds: 60,
    creditVersion: 'credit-a',
    ...changes,
  };
}

function credit(changes: Partial<SttCreditSnapshot> = {}): SttCreditSnapshot {
  return {
    vendor: 'deepgram',
    version: 'credit-a',
    checkedAtMs: nowMs - 1_000,
    remainingMicro: 10_000,
    reservedMicro: 0,
    failedDays: 0,
    ...changes,
  };
}

describe('selectLowestCostSttEntry', () => {
  it('keeps automatic language on its priced native route and explicit Spanish on monolingual Nova', () => {
    expect(sttLanguageOptions(dg, null)).toBeNull();
    expect(sttLanguageOptions(oa, null)).toEqual({});
    expect(sttLanguageOptions(dg, 'es')).toEqual({ language: 'es' });
    expect(selectLowestCostSttEntry([dg, oa], rows, options({ language: null, credit: credit() })))
      .toMatchObject({ serving: oa, fallbacks: [] });
    expect(selectLowestCostSttEntry([dg, oa], rows, options({ language: 'es', credit: credit() })))
      .toMatchObject({ serving: dg, fallbacks: [oa] });
  });

  it('selects the cheaper list-price entry and retains the other vendor', () => {
    expect(selectLowestCostSttEntry([dg, oa], rows, options())).toEqual({
      serving: oa,
      fallbacks: [dg],
      effectiveMicroPerMinute: 3_000,
      creditVersion: null,
    });
  });

  it('selects an entry covered by fresh matching credit', () => {
    expect(selectLowestCostSttEntry([oa, dg], rows, options({ credit: credit() }))).toEqual({
      serving: dg,
      fallbacks: [oa],
      effectiveMicroPerMinute: 0,
      creditVersion: 'credit-a',
    });
  });

  it('deducts outstanding reservations and requires the complete estimate to fit', () => {
    const exact = options({ credit: credit({ remainingMicro: 10_000, reservedMicro: 5_200 }) });
    expect(selectLowestCostSttEntry([dg, oa], rows, exact)?.serving).toBe(dg);
    const short = options({ credit: credit({ remainingMicro: 10_000, reservedMicro: 5_201 }) });
    expect(selectLowestCostSttEntry([dg, oa], rows, short)?.serving).toBe(oa);
    const overdrawn = options({ credit: credit({ remainingMicro: 10_000, reservedMicro: 10_001 }) });
    expect(selectLowestCostSttEntry([dg, oa], rows, overdrawn)?.serving).toBe(oa);
  });

  it('uses the library rounding for a fractional-minute estimate', () => {
    const covered = options({ estimatedSeconds: 1.001, credit: credit({ remainingMicro: 81 }) });
    expect(selectLowestCostSttEntry([dg, oa], rows, covered)?.serving).toBe(dg);
    const uncovered = options({ estimatedSeconds: 1.001, credit: credit({ remainingMicro: 80 }) });
    expect(selectLowestCostSttEntry([dg, oa], rows, uncovered)?.serving).toBe(oa);
  });

  it.each([
    ['spent', { remainingMicro: 0 }],
    ['negative', { remainingMicro: -1 }],
    ['non-finite', { remainingMicro: Number.NaN }],
    ['fractional reservation', { reservedMicro: 0.5 }],
    ['wrong version', { version: 'credit-previous' }],
    ['future check', { checkedAtMs: nowMs + 1 }],
    ['24 hours old', { checkedAtMs: nowMs - 86_400_000 }],
    ['three failed days', { failedDays: 3 }],
    ['invalid failure count', { failedDays: -1 }],
  ] satisfies Array<[string, Partial<SttCreditSnapshot>]>)('ignores %s credit', (_name, change) => {
    const result = selectLowestCostSttEntry([dg, oa], rows, options({ credit: credit(change) }));
    expect(result?.serving).toBe(oa);
    expect(result?.creditVersion).toBeNull();
  });

  it('uses a valid cache before its age limit but never assumes a missing version', () => {
    const valid = credit({ checkedAtMs: nowMs - 86_399_999, failedDays: 2 });
    expect(selectLowestCostSttEntry([dg, oa], rows, options({ credit: valid }))?.serving).toBe(dg);
    const withoutVersion: LowestCostSttOptions = { availableVendors: ['deepgram', 'openai'], nowMs, estimatedSeconds: 60, credit: valid };
    expect(selectLowestCostSttEntry([dg, oa], rows, withoutVersion)?.serving).toBe(oa);
  });

  it('filters an unavailable vendor before looking up its price or applying its credit', () => {
    const offered = options({ availableVendors: ['openai'], credit: credit() });
    expect(selectLowestCostSttEntry([dg, oa], [rows[1]!], offered)).toEqual({
      serving: oa,
      fallbacks: [],
      effectiveMicroPerMinute: 3_000,
      creditVersion: null,
    });
    expect(selectLowestCostSttEntry([dg, oa], rows, options({ availableVendors: [] }))).toBeUndefined();
    expect(selectLowestCostSttEntry([], rows, options())).toBeUndefined();
  });

  it('keeps the caller order for tied prices', () => {
    const tied = rows.map((row) => ({ ...row, microPerMinute: 3_000 }));
    expect(selectLowestCostSttEntry([dg, oa], tied, options())?.serving).toBe(dg);
    expect(selectLowestCostSttEntry([oa, dg], tied, options())?.serving).toBe(oa);
  });

  it('retains one best entry per other vendor as the fallback', () => {
    const second = 'openai:gpt-4o-transcribe';
    const priced = [...rows, { entry: second, microPerMinute: 6_000 }];
    const result = selectLowestCostSttEntry([second, dg, oa], priced, options({ credit: credit() }));
    expect(result?.serving).toBe(dg);
    expect(result?.fallbacks).toEqual([oa]);
  });

  it('refuses an unpriced offered vendor, invalid units and ambiguous inputs', () => {
    expect(() => selectLowestCostSttEntry([dg, oa], [rows[1]!], options())).toThrow('price row');
    expect(() => selectLowestCostSttEntry([dg, dg], rows, options())).toThrow('duplicate');
    expect(() => selectLowestCostSttEntry([dg], [rows[0]!, rows[0]!], options())).toThrow('duplicate');
    expect(() => selectLowestCostSttEntry(['device:moonshine-auto'], rows, options())).toThrow(RangeError);
    for (const bad of [-1, 0.0048, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => selectLowestCostSttEntry([dg], [{ entry: dg, microPerMinute: bad }], options())).toThrow(RangeError);
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => selectLowestCostSttEntry([dg], rows, options({ estimatedSeconds: bad }))).toThrow(RangeError);
    }
    expect(() => selectLowestCostSttEntry([dg], rows, options({ nowMs: Number.NaN }))).toThrow(RangeError);
  });

  it('leaves the offered entries and prices unchanged and freezes its result', () => {
    const entries = Object.freeze([dg, oa]);
    const immutableRows = Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    const result = selectLowestCostSttEntry(entries, immutableRows, options());
    expect(entries).toEqual([dg, oa]);
    expect(immutableRows).toEqual(rows);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.fallbacks)).toBe(true);
  });
});
