import { describe, expect, it } from 'vitest';
import { computeRetryBackoffMs } from '../retry-backoff';

describe('computeRetryBackoffMs (equal-jitter exponential backoff)', () => {
  it('floors at half the exponential ceiling (random=0) — never retries near-instantly', () => {
    // attempt 0 -> ceiling = base(1000); equal jitter floor = ceiling/2
    expect(computeRetryBackoffMs(0, { random: () => 0 })).toBe(500);
    expect(computeRetryBackoffMs(1, { random: () => 0 })).toBe(1000); // ceiling 2000 -> 1000
    expect(computeRetryBackoffMs(2, { random: () => 0 })).toBe(2000); // ceiling 4000 -> 2000
  });

  it('tops out at the full exponential ceiling (random≈1)', () => {
    const r = () => 0.999999;
    expect(computeRetryBackoffMs(0, { random: r })).toBe(1000); // ~ceiling 1000
    expect(computeRetryBackoffMs(1, { random: r })).toBe(2000); // ~ceiling 2000
  });

  it('always lands within [ceiling/2, ceiling]', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ceiling = Math.min(30000, 1000 * 2 ** attempt);
      for (let i = 0; i < 50; i++) {
        const d = computeRetryBackoffMs(attempt);
        expect(d).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('caps the ceiling at 30s by default no matter how high the attempt climbs', () => {
    // attempt 10 -> 1000 * 1024 = 1,024,000ms, clamped to the 30s cap
    expect(computeRetryBackoffMs(10, { random: () => 0 })).toBe(15000);
    expect(computeRetryBackoffMs(10, { random: () => 0.999999 })).toBe(30000);
    expect(computeRetryBackoffMs(50, { random: () => 0.5 })).toBeLessThanOrEqual(30000);
  });

  it('honors an injected cap + base (deterministic, no Math.random)', () => {
    expect(computeRetryBackoffMs(3, { baseMs: 200, capMs: 5000, random: () => 0 })).toBe(800); // ceil 1600 -> 800
    expect(computeRetryBackoffMs(8, { baseMs: 200, capMs: 5000, random: () => 0 })).toBe(2500); // ceil capped 5000 -> 2500
  });

  it('actually jitters — distinct randoms produce distinct delays (breaks lockstep retries)', () => {
    const a = computeRetryBackoffMs(4, { random: () => 0.1 });
    const b = computeRetryBackoffMs(4, { random: () => 0.9 });
    expect(a).not.toBe(b);
  });

  it('treats negative attempts as 0 (no NaN / negative delay)', () => {
    expect(computeRetryBackoffMs(-3, { random: () => 0 })).toBe(500);
  });
});
