import { describe, expect, it } from 'vitest';
import {
  componentMicro,
  deriveMeasuredRate,
  quoteCompoundLiability,
  type RateSnapshot,
} from '../CreditRates.js';

const perMinute = (micro: number) => ({ unit: 'second' as const, micro, per: 60 });
const perMillionTokens = (micro: number) => ({ unit: 'token' as const, micro, per: 1_000_000 });

const primary: RateSnapshot = {
  version: 'rates-2026-10-a',
  currency: 'USD',
  reasoningInOutput: true,
  components: {
    media_second: { customer: perMinute(83_117), supplier: perMinute(25_000) },
    input_token: { customer: perMillionTokens(150_000), supplier: perMillionTokens(150_000) },
    output_token: { customer: perMillionTokens(600_000), supplier: perMillionTokens(600_000) },
    reasoning_token: { customer: perMillionTokens(600_000), supplier: perMillionTokens(600_000) },
  },
};

describe('componentMicro', () => {
  it('rounds the exact product up once', () => {
    expect(componentMicro(600, perMinute(83_117))).toBe(831_170);
    // Synthetic rational fixture: ceil(61 * 83117 / 60) = 84503
    expect(componentMicro(61, perMinute(83_117))).toBe(84_503);
    expect(componentMicro(0, perMinute(83_117))).toBe(0);
    expect(componentMicro(10, { unit: 'second', micro: 0, per: 1 })).toBe(0);
  });

  it('keeps a product past 2^53 exact before the ceiling', () => {
    // 900,000,000 tokens at $15 per million: the product 1.35e16 is past Number's exact range
    expect(componentMicro(900_000_000, perMillionTokens(15_000_000))).toBe(13_500_000_000);
  });

  it('refuses what is not whole, a rate per nothing, and a charge past the exact range', () => {
    expect(() => componentMicro(1.5, perMinute(83_117))).toThrow(RangeError);
    expect(() => componentMicro(-1, perMinute(83_117))).toThrow(RangeError);
    expect(() => componentMicro(1, { unit: 'second', micro: 1, per: 0 })).toThrow(RangeError);
    expect(() => componentMicro(1, { unit: 'second', micro: 0.5, per: 1 })).toThrow(RangeError);
    expect(() => componentMicro(Number.MAX_SAFE_INTEGER, { unit: 'token', micro: 2, per: 1 })).toThrow(RangeError);
  });
});

describe('deriveMeasuredRate', () => {
  it('converts a measured cost to a rate per unit block, times the multiplier, rounded up', () => {
    const rate = deriveMeasuredRate(
      { costMicro: 1_000_000, quantity: 4_000_000, unit: 'token', evidence: 'sha256:bench-a' },
      { per: 1_000_000, multiplier: { numerator: 2, denominator: 1 } },
    );
    expect(rate).toEqual({ unit: 'token', micro: 500_000, per: 1_000_000, evidence: 'sha256:bench-a', multiplier: { numerator: 2, denominator: 1 } });
    const tiny = deriveMeasuredRate({ costMicro: 1, quantity: 3, unit: 'token', evidence: 'sha256:b' }, { per: 1, multiplier: { numerator: 2, denominator: 1 } });
    expect(tiny.micro).toBe(1);
  });

  it('refuses a measurement without units or evidence', () => {
    expect(() => deriveMeasuredRate({ costMicro: 1, quantity: 0, unit: 'token', evidence: 'x' }, { per: 1, multiplier: { numerator: 2, denominator: 1 } })).toThrow(RangeError);
    expect(() => deriveMeasuredRate({ costMicro: 1, quantity: 1, unit: 'token', evidence: '' }, { per: 1, multiplier: { numerator: 2, denominator: 1 } })).toThrow(RangeError);
  });
});

describe('quoteCompoundLiability', () => {
  const attempts = { maxAttempts: 64, perAttempt: { input_token: 8_192, output_token: 512, reasoning_token: 512 } };

  it('prices the full duration and every attempt at its maximum, reasoning counted once inside output', () => {
    const quote = quoteCompoundLiability({ rates: primary, mediaComponent: 'media_second', durationSeconds: 600, attempts });
    // per attempt: ceil(8192 * 0.15) + ceil(512 * 0.6) = 1229 + 308
    expect(quote.perAttempt).toEqual({ customerMicro: 1_537, supplierMicro: 1_537 });
    expect(quote.media).toEqual({ customerMicro: 831_170, supplierMicro: 250_000 });
    expect(quote.customerMicro).toBe(831_170 + 64 * 1_537);
    expect(quote.supplierMicro).toBe(250_000 + 64 * 1_537);
    expect(quote.maxAttempts).toBe(64);
    expect(quote.rateVersion).toBe('rates-2026-10-a');
  });

  it('counts reasoning separately when output does not include it, and takes the dearest fallback on each side', () => {
    const separate: RateSnapshot = { ...primary, version: 'rates-2026-10-b', reasoningInOutput: false };
    expect(quoteCompoundLiability({ rates: separate, mediaComponent: 'media_second', durationSeconds: 600, attempts }).perAttempt.customerMicro).toBe(1_537 + 308);
    const dearer: RateSnapshot = {
      ...primary,
      version: 'rates-fallback',
      components: { ...primary.components, output_token: { customer: perMillionTokens(600_000), supplier: perMillionTokens(2_000_000) } },
      attemptMinimum: { customerMicro: 0, supplierMicro: 10 },
    };
    const quote = quoteCompoundLiability({ rates: primary, fallbackRates: [dearer], mediaComponent: 'media_second', durationSeconds: 600, attempts });
    expect(quote.perAttempt).toEqual({ customerMicro: 1_537, supplierMicro: 1_229 + 1_024 + 10 });
  });

  it('refuses a unit no snapshot prices, since an unknown unit cannot be priced as zero', () => {
    expect(() => quoteCompoundLiability({ rates: primary, mediaComponent: 'media_second', durationSeconds: 600, attempts: { maxAttempts: 1, perAttempt: { cached_input_token: 100 } } })).toThrow(/cached_input_token/);
    expect(() => quoteCompoundLiability({ rates: primary, mediaComponent: 'missing', durationSeconds: 1, attempts })).toThrow(/missing/);
  });
});
