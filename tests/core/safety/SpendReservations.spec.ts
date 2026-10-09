import { describe, expect, it } from 'vitest';

import { CostCapExceededError } from '../../../src/safety/runtime/CostGuard.js';
import {
  InMemorySpendDayStore,
  minutesMicro,
  releaseExpiredSpend,
  releaseSpend,
  reserveSpend,
  settledTokensMicro,
  toMicro,
  tokensMicro,
  utcDay,
} from '../../../src/safety/runtime/SpendReservations.js';
import { openAIModelPricing, openAITranscriptionPricing } from '../../../src/core/llm/providers/implementations/openaiPricing.js';

const AT = new Date('2026-10-12T10:00:00Z');
const LATER = new Date('2026-10-12T11:00:00Z');
const LIMIT = 60_000_000;
const LUNA = { input: 0.0001, output: 0.0005 };

describe('the arithmetic', () => {
  it('prices seconds by the minute, a part rounded up to the micro-dollar', () => {
    expect(minutesMicro(3600, 3000)).toBe(180_000);
    expect(minutesMicro(1, 17_000)).toBe(284);
    expect(minutesMicro(3600, 17_000)).toBe(1_020_000);
    expect(toMicro(0.017)).toBe(17_000);
  });

  it('prices tokens at a row with each part rounded up, and settles never above the reservation', () => {
    expect(tokensMicro(1000, 160, LUNA)).toBe(180);
    expect(settledTokensMicro(1000, 160, 150, LUNA)).toBe(150);
    expect(settledTokensMicro(10, 10, 150, LUNA)).toBe(tokensMicro(10, 10, LUNA));
    expect(settledTokensMicro(undefined, 10, 150, LUNA)).toBe(150);
    expect(settledTokensMicro(1.5, 10, 150, LUNA)).toBe(150);
  });

  it("knows OpenAI's transcription prices by the minute, and none for a model without a row", () => {
    expect(openAITranscriptionPricing('gpt-4o-mini-transcribe')).toBe(0.003);
    expect(openAITranscriptionPricing('gpt-realtime-whisper')).toBe(0.017);
    expect(openAITranscriptionPricing('no-such-model')).toBeUndefined();
    expect(openAIModelPricing('gpt-6-luna')).toEqual(LUNA);
  });

  it('has no price for a model named after a member every object inherits', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'constructor-2026-01-01']) {
      expect(openAITranscriptionPricing(name)).toBeUndefined();
      expect(openAIModelPricing(name)).toBeUndefined();
    }
  });
});

describe("a day's reservations", () => {
  it('refuses an admission past its cap with the daily cap, reserving nothing', async () => {
    const store = new InMemorySpendDayStore();
    await reserveSpend(store, { kind: 'session', micro: LIMIT - 100, at: AT, expires: LATER, capMicro: LIMIT });
    await expect(reserveSpend(store, { kind: 'call', micro: 101, at: AT, expires: LATER, capMicro: LIMIT })).rejects.toMatchObject({
      name: 'CostCapExceededError',
      capType: 'daily',
    });
    expect(await store.lockDay(utcDay(AT))).toBe(LIMIT - 100);
  });

  it('holds a lower cap for one class of admission while the whole cap still admits the others', async () => {
    const store = new InMemorySpendDayStore();
    const share = (LIMIT * 600) / 1000;
    await reserveSpend(store, { kind: 'session', micro: share, at: AT, expires: LATER, capMicro: LIMIT });
    await expect(reserveSpend(store, { kind: 'session', micro: 1, at: AT, expires: LATER, capMicro: share })).rejects.toBeInstanceOf(CostCapExceededError);
    await expect(reserveSpend(store, { kind: 'session', micro: 1, at: AT, expires: LATER, capMicro: LIMIT })).resolves.toEqual(expect.any(String));
  });

  it('settles a reservation once, held to its amount', async () => {
    const store = new InMemorySpendDayStore();
    const id = await reserveSpend(store, { kind: 'call', micro: 500, at: AT, expires: LATER, capMicro: LIMIT });
    expect(await releaseSpend(store, id, 900, AT)).toBe(true);
    expect(await releaseSpend(store, id, 100, AT)).toBe(false);
    expect(await store.lockDay(utcDay(AT))).toBe(500);
  });

  it('settles each expired reservation at its whole amount, and counts each UTC day apart', async () => {
    const store = new InMemorySpendDayStore();
    await reserveSpend(store, { kind: 'session', micro: 1_020_000, at: AT, expires: LATER, capMicro: LIMIT });
    const next = new Date('2026-10-13T00:00:01Z');
    await reserveSpend(store, { kind: 'session', micro: 1_020_000, at: next, expires: new Date('2026-10-13T01:00:01Z'), capMicro: LIMIT });
    expect(await releaseExpiredSpend(store, new Date('2026-10-12T12:00:00Z'))).toBe(1);
    expect(await store.lockDay('2026-10-12')).toBe(1_020_000);
    expect(await store.lockDay('2026-10-13')).toBe(1_020_000);
  });

  it('refuses an amount that is not whole micro-dollars, and settles a cost that is not a number at the whole reservation', async () => {
    const store = new InMemorySpendDayStore();
    for (const micro of [Number.NaN, 1.5, -1]) {
      await expect(reserveSpend(store, { kind: 'call', micro, at: AT, expires: LATER, capMicro: LIMIT })).rejects.toBeInstanceOf(RangeError);
    }
    const id = await reserveSpend(store, { kind: 'call', micro: 500, at: AT, expires: LATER, capMicro: LIMIT });
    expect(await releaseSpend(store, id, Number.NaN, AT)).toBe(true);
    expect(await store.lockDay(utcDay(AT))).toBe(500);
    await expect(reserveSpend(store, { kind: 'call', micro: LIMIT - 500, at: AT, expires: LATER, capMicro: LIMIT })).resolves.toEqual(expect.any(String));
    await expect(reserveSpend(store, { kind: 'call', micro: 1, at: AT, expires: LATER, capMicro: LIMIT })).rejects.toBeInstanceOf(CostCapExceededError);
  });

  it('refuses every admission while its store answers a total that is not a number', async () => {
    const store = new InMemorySpendDayStore();
    store.lockDay = () => Promise.resolve(Number.NaN);
    await expect(reserveSpend(store, { kind: 'call', micro: 1, at: AT, expires: LATER, capMicro: LIMIT })).rejects.toBeInstanceOf(CostCapExceededError);
  });
});
