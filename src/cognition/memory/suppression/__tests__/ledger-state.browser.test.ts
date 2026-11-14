/**
 * @file ledger-state.browser.test.ts
 * The forgotten-user ledger's identity and state mark in a real browser: the identity is 16 bytes from the browser's
 * secure random source, and a mark rises on every advance, at the same millisecond and with a clock set back.
 */
import { describe, expect, it } from 'vitest';

/** The calls of the module this case loads. */
interface LedgerState {
  newLedgerIdentity(): string;
  advanceStateMark(previous: string | undefined, nowMs: number): string;
}

/** A mark as the number it is. */
const numberOf = (mark: string): bigint => BigInt(`0x${mark}`);

describe("the ledger's identity and state mark in a browser", () => {
  it('makes an identity and advances a mark in a browser', async () => {
    const state = (await import('../ledgerState.js' as string)) as LedgerState;

    const identity = state.newLedgerIdentity();
    expect(identity).toMatch(/^[0-9a-f]{32}$/);
    expect(state.newLedgerIdentity()).not.toBe(identity);

    const t = Date.now();
    const first = state.advanceStateMark(undefined, t);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.parseInt(first.slice(0, 16), 16)).toBe(t);

    // The same millisecond again: the mark still rises.
    const second = state.advanceStateMark(first, t);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(numberOf(second) > numberOf(first)).toBe(true);

    // A clock set back an hour: the mark still rises.
    const third = state.advanceStateMark(second, t - 3_600_000);
    expect(numberOf(third) > numberOf(second)).toBe(true);
  });
});
