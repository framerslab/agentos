/**
 * @file SpendReservations.ts
 * @description A day's spending bound that outlives a process. Before a session or a call is admitted, its largest
 * cost is reserved in the UTC day it starts; once its use is known the reservation settles at what it cost, never above
 * what was reserved, or at its whole amount when its time runs out unconfirmed. A day's committed total is its open
 * reservations plus its settled ones, and an admission that would take that total past a cap is refused with
 * CostGuard's CostCapExceededError (cap type `daily`), reserving nothing. The rows live in a store the caller provides
 * on its own tables, which locks the day for the caller's transaction, so two admissions never read the same total.
 * Money is whole micro-dollars (millionths of a US dollar).
 */
import { CostCapExceededError } from './CostGuard.js';

/** One open reservation, as a store lists it. */
export interface OpenReservation {
  /** The id the store gave it. */
  id: string;
  /** The amount reserved, in micro-dollars. */
  micro: number;
}

/** The rows a day's bound needs, kept by the caller; every method runs inside the caller's transaction. */
export interface SpendDayStore {
  /**
   * Makes the day's row when it is missing, locks it for the transaction, and answers its committed total in whole
   * micro-dollars; any other answer refuses the admission.
   */
  lockDay(day: string): Promise<number>;
  /** Records a reservation in the locked day, adds it to the day's open total, and answers its id. */
  addReservation(reservation: { day: string; kind: string; micro: number; created: Date; expires: Date }): Promise<string>;
  /**
   * Settles an open reservation once, at `settledMicro` held to the amount reserved: the day's open total loses the
   * amount and its settled total gains what settled. Answers false, changing nothing, for one already settled or unknown.
   */
  settleReservation(id: string, settledMicro: number, at: Date): Promise<boolean>;
  /** The open reservations whose time is up at `at`. */
  expiredReservations(at: Date): Promise<OpenReservation[]>;
}

/** What an admission asks for: its kind, its largest cost, when it starts and until when, and the cap it must fit under. */
export interface SpendAdmission {
  /** What is admitted, such as `session` or `call`; the store records it and a refusal names it. */
  kind: string;
  /** Its largest cost in whole micro-dollars, zero or more. */
  micro: number;
  /** When it starts, a valid date; the reservation belongs to this time's UTC day. */
  at: Date;
  /** When the reservation's time is up, a valid date, after which {@link releaseExpiredSpend} settles it at its whole amount. */
  expires: Date;
  /**
   * The day's cap for this admission in whole micro-dollars, zero or more: the whole limit, or a share of it for a class
   * of admission. Any other cap, infinity included, refuses the admission.
   */
  capMicro: number;
}

/** A whole number, zero or more, small enough to count exactly: a token count or an amount in micro-dollars. */
function isWholeCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Whether a date holds a time: `new Date(NaN)` does not. */
function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

/** The UTC day of a time, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** US dollars as whole micro-dollars (0.017 is 17,000). */
export function toMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/**
 * Seconds at a price per minute in micro-dollars, rounded up to the micro-dollar.
 *
 * @throws {RangeError} When `microPerMinute` is not whole micro-dollars, zero or more: a price in US dollars passed in
 *   its place (0.003 for 3,000) would price an hour at one micro-dollar.
 */
export function minutesMicro(seconds: number, microPerMinute: number): number {
  if (!isWholeCount(microPerMinute)) {
    throw new RangeError(`A price per minute is whole micro-dollars, zero or more, not ${microPerMinute}; toMicro() converts US dollars`);
  }
  return Math.ceil((seconds * microPerMinute) / 60);
}

/** Prompt and output tokens at a price row in US dollars per 1K tokens, each part rounded up to the micro-dollar. */
export function tokensMicro(promptTokens: number, outputTokens: number, price: { input: number; output: number }): number {
  // Micro-dollars per million tokens, rounded to the whole number every listed rate gives, so a floating-point error
  // in the multiplication cannot reach the sums below.
  const perMillion = (usdPer1K: number): number => Math.round(usdPer1K * 1_000_000_000);
  return Math.ceil((promptTokens * perMillion(price.input)) / 1_000_000) + Math.ceil((outputTokens * perMillion(price.output)) / 1_000_000);
}

/** A finished call's settled cost: its reported tokens at the price, never above the reservation; the whole reservation when a count is missing or is not a whole number. */
export function settledTokensMicro(promptTokens: unknown, completionTokens: unknown, reservedMicro: number, price: { input: number; output: number }): number {
  if (!isWholeCount(promptTokens) || !isWholeCount(completionTokens)) return reservedMicro;
  return Math.min(reservedMicro, tokensMicro(promptTokens, completionTokens, price));
}

/**
 * Reserves an admission's largest cost in the day it starts and answers the reservation's id, or throws
 * CostCapExceededError (`daily`) reserving nothing. A cost that is not whole micro-dollars, zero or more, is a
 * RangeError, and so is a start or an expiry that is not a valid date; a committed total the store does not answer as
 * whole micro-dollars, zero or more, refuses the admission, since the day's spending is then not known, and so does a
 * cap that is not whole micro-dollars, zero or more.
 */
export async function reserveSpend(store: SpendDayStore, admission: SpendAdmission): Promise<string> {
  if (!isWholeCount(admission.micro)) {
    throw new RangeError(`A reservation is whole micro-dollars, zero or more, not ${admission.micro}`);
  }
  // A start that is not a date has no day. An expiry that is not one is never at or before any time, so
  // releaseExpiredSpend would never settle the reservation and its amount would stay in its day's total.
  if (!isValidDate(admission.at) || !isValidDate(admission.expires)) {
    throw new RangeError('A reservation starts and expires at valid dates');
  }
  const day = utcDay(admission.at);
  const committed = await store.lockDay(day);
  // A total that is not whole micro-dollars, zero or more, is not one a store keeping whole amounts answers, so the
  // day's spending is not known, and minus infinity or a total below zero would pass the cap check. A cap that is not
  // whole micro-dollars, zero or more, is refused too: a cap of infinity would admit every amount.
  if (!isWholeCount(committed) || !isWholeCount(admission.capMicro) || !(committed + admission.micro <= admission.capMicro)) {
    throw new CostCapExceededError(admission.kind, 'daily', committed / 1_000_000, admission.capMicro / 1_000_000);
  }
  return store.addReservation({ day, kind: admission.kind, micro: admission.micro, created: admission.at, expires: admission.expires });
}

/**
 * Settles a reservation once at what its use cost, in whole micro-dollars and never below zero; false when it was
 * settled already. A cost that is not a finite number was never known, so the reservation settles at its whole amount,
 * as an expired one does.
 */
export function releaseSpend(store: SpendDayStore, id: string, settledMicro: number, at: Date): Promise<boolean> {
  // The store holds what settles to the amount reserved, so the largest exact amount settles a reservation whole.
  const settled = Number.isFinite(settledMicro)
    ? Math.min(Math.max(0, Math.floor(settledMicro)), Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  return store.settleReservation(id, settled, at);
}

/**
 * Settles each reservation whose time is up at its whole amount, since its use was never confirmed; answers how many
 * it settled (one that another process released in the meantime is not counted).
 */
export async function releaseExpiredSpend(store: SpendDayStore, at: Date): Promise<number> {
  const expired = await store.expiredReservations(at);
  let settled = 0;
  for (const reservation of expired) {
    if (await store.settleReservation(reservation.id, reservation.micro, at)) settled += 1;
  }
  return settled;
}

/**
 * A store held in memory, for tests and for one process that admits one reservation at a time. It takes no lock, so
 * two admissions awaited at once can both read the same total; a service that admits concurrently implements
 * {@link SpendDayStore} on tables whose day row its transaction locks.
 */
export class InMemorySpendDayStore implements SpendDayStore {
  private readonly days = new Map<string, { reserved: number; settled: number }>();
  private readonly reservations = new Map<string, { day: string; micro: number; expires: Date; settledAt: Date | null }>();
  private made = 0;

  /** Makes the day when missing and answers its committed total (it takes no lock: see the class). */
  lockDay(day: string): Promise<number> {
    const row = this.days.get(day) ?? { reserved: 0, settled: 0 };
    this.days.set(day, row);
    return Promise.resolve(row.reserved + row.settled);
  }

  /** Records a reservation and adds it to its day's open total. */
  addReservation(reservation: { day: string; kind: string; micro: number; created: Date; expires: Date }): Promise<string> {
    const id = `reservation-${++this.made}`;
    this.reservations.set(id, { day: reservation.day, micro: reservation.micro, expires: reservation.expires, settledAt: null });
    const row = this.days.get(reservation.day) ?? { reserved: 0, settled: 0 };
    row.reserved += reservation.micro;
    this.days.set(reservation.day, row);
    return Promise.resolve(id);
  }

  /** Settles an open reservation once, held to its amount. */
  settleReservation(id: string, settledMicro: number, at: Date): Promise<boolean> {
    const reservation = this.reservations.get(id);
    if (reservation === undefined || reservation.settledAt !== null) return Promise.resolve(false);
    reservation.settledAt = at;
    const row = this.days.get(reservation.day) ?? { reserved: 0, settled: 0 };
    row.reserved -= reservation.micro;
    row.settled += Math.min(Math.max(0, settledMicro), reservation.micro);
    this.days.set(reservation.day, row);
    return Promise.resolve(true);
  }

  /** The open reservations whose time is up. */
  expiredReservations(at: Date): Promise<OpenReservation[]> {
    const due = [...this.reservations.entries()].filter(([, r]) => r.settledAt === null && r.expires.getTime() <= at.getTime());
    return Promise.resolve(due.map(([id, r]) => ({ id, micro: r.micro })));
  }
}
