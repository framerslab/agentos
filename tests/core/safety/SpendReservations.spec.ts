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
import {
  OPENAI_MODEL_PRICING,
  OPENAI_TRANSCRIPTION_PRICING,
  openAIModelPricing,
  openAITranscriptionPricing,
} from '../../../src/core/llm/providers/implementations/openaiPricing.js';

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

  it('refuses a price per minute that is not whole micro-dollars, as a price in US dollars passed in its place is', () => {
    // 0.003 US dollars a minute read as micro-dollars would price an hour at one micro-dollar instead of 180,000.
    expect(() => minutesMicro(3600, 0.003)).toThrow(RangeError);
    expect(() => minutesMicro(3600, Number.NaN)).toThrow(RangeError);
    expect(minutesMicro(3600, toMicro(0.003))).toBe(180_000);
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

  it('keeps every price row as it is listed: a caller can change neither a row nor a table', () => {
    // The provider, every budget and every caller read the same rows. Reflect.set answers false for a frozen object,
    // where an assignment would throw in strict code.
    expect(Reflect.set(OPENAI_MODEL_PRICING['gpt-6-luna'], 'input', 0)).toBe(false);
    expect(Reflect.set(OPENAI_MODEL_PRICING, 'gpt-6-luna', { input: 0, output: 0 })).toBe(false);
    expect(Reflect.set(OPENAI_MODEL_PRICING, 'my-model', { input: 0, output: 0 })).toBe(false);
    expect(Reflect.set(OPENAI_TRANSCRIPTION_PRICING, 'gpt-4o-mini-transcribe', 0)).toBe(false);
    expect(openAIModelPricing('gpt-6-luna')).toEqual(LUNA);
    expect(openAIModelPricing('my-model')).toBeUndefined();
    expect(openAITranscriptionPricing('gpt-4o-mini-transcribe')).toBe(0.003);
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
    const expired = await reserveSpend(store, { kind: 'session', micro: 1_020_000, at: AT, expires: LATER, capMicro: LIMIT });
    const next = new Date('2026-10-13T00:00:01Z');
    await reserveSpend(store, { kind: 'session', micro: 1_020_000, at: next, expires: new Date('2026-10-13T01:00:01Z'), capMicro: LIMIT });
    expect(await releaseExpiredSpend(store, new Date('2026-10-12T12:00:00Z'))).toBe(1);
    expect(await store.lockDay('2026-10-12')).toBe(1_020_000);
    expect(await store.lockDay('2026-10-13')).toBe(1_020_000);
    // An open reservation and one settled whole leave the same total, so the release that follows tells them apart:
    // it finds nothing open to settle and changes nothing.
    expect(await releaseSpend(store, expired, 0, new Date('2026-10-12T12:00:01Z'))).toBe(false);
    expect(await store.lockDay('2026-10-12')).toBe(1_020_000);
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

  it('refuses every admission whose cap is not whole micro-dollars, reserving nothing', async () => {
    // A cap of infinity, or one with a fraction, would admit the amount; NaN and a cap below zero never do.
    const store = new InMemorySpendDayStore();
    for (const capMicro of [Number.POSITIVE_INFINITY, LIMIT + 0.5, Number.NaN, -1]) {
      await expect(
        reserveSpend(store, { kind: 'call', micro: 1, at: AT, expires: LATER, capMicro }),
        `a cap of ${capMicro}`,
      ).rejects.toBeInstanceOf(CostCapExceededError);
    }
    expect(await store.lockDay(utcDay(AT))).toBe(0);
  });

  it('refuses every admission while its store answers a total that is not whole micro-dollars, which the cap alone would admit', async () => {
    // Each passes the cap check alone: added to the admission, minus infinity, a total below zero and a fraction all fit.
    for (const total of [Number.NEGATIVE_INFINITY, -1_000_000, 2.5]) {
      const store = new InMemorySpendDayStore();
      store.lockDay = () => Promise.resolve(total);
      await expect(
        reserveSpend(store, { kind: 'call', micro: 1, at: AT, expires: LATER, capMicro: LIMIT }),
        `a total of ${total}`,
      ).rejects.toBeInstanceOf(CostCapExceededError);
    }
  });
});
