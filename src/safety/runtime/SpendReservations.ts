/**
 * @file SpendReservations.ts
 * @description A day's spending bound that outlives a process. Before a session or a call is admitted, its largest
 * cost is reserved in the UTC day it starts; once its use is known the reservation settles at what it cost, never above
 * what was reserved, or at its whole amount when its time runs out unconfirmed. A day's committed total is its open
 * reservations plus its settled ones, and an admission that would take that total past a cap is refused with
 * CostGuard's CostCapExceededError (cap type `daily`), reserving nothing. The rows live in a store the caller provides
 * on its own tables, which locks the day for the caller's transaction, so two admissions never read the same total.
 * On a store that holds fenced reservations, an admission made with `requireFence` outlives its time until a sweep
 * given a resolver decides it, and the resolver may defer it, still open and counted, until its work has stopped.
 * On a store that holds operation reservations, an operation keeps one row with a recorded figure and runs fenced by
 * their number: each run takes the row's lease as it begins, only the lease's holder puts its settled figure in place
 * of its bound, and the row settles once, at its recorded figure, when its time is up and no run holds a live lease.
 * Money is whole micro-dollars (millionths of a US dollar).
 */
import { CostCapExceededError } from './CostGuard.js';
import type { SpendExpiryDecision, SpendFenceEvidence } from './SpendMeter.js';

/** One open reservation, as a store lists it. */
export interface OpenReservation {
  /** The id the store gave it. */
  id: string;
  /** The amount reserved, in micro-dollars. */
  micro: number;
  /** Made with `requireFence`, or deferred before: only a sweep with a resolver settles it. */
  requireFence?: boolean;
  /** The last durable deferral evidence, copied on read. */
  evidence?: SpendFenceEvidence;
}

/**
 * The rows a day's bound needs, kept by the caller; every method runs inside the caller's transaction. A store that
 * holds fenced reservations says so with `fencedReservations` and implements `addFencedReservation` and
 * `deferReservation`, persisting the fence, the next check and the evidence in the caller's transaction. A store
 * without that capability cannot admit a fenced reservation or run a sweep with a resolver. A store that holds
 * operation reservations says so with `operationReservations` and implements `addOperationReservation`,
 * `openOperationReservation`, `beginRun`, `endRun` and `renewRun`; a store without them cannot admit an operation.
 */
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
  /**
   * The open reservations whose time is up at `at`. A store with `fencedReservations` leaves a deferred one out until
   * its next check has come, and lists each one's `requireFence` and last evidence. A store with
   * `operationReservations` lists an operation's row only once it is past its expiry with no live lease, its `micro`
   * the recorded figure, which `releaseExpiredSpend` settles it at.
   */
  expiredReservations(at: Date): Promise<OpenReservation[]>;
  /** True on a store that holds fenced reservations, with `addFencedReservation` and `deferReservation`. */
  readonly fencedReservations?: true;
  /** Records a reservation as `addReservation` does, made with `requireFence`, and answers its id. */
  addFencedReservation?(reservation: { day: string; kind: string; micro: number; created: Date; expires: Date }): Promise<string>;
  /** Atomically persists a permanent fence, next check and evidence; false for a closed or unknown row. */
  deferReservation?(id: string, retryAt: Date, evidence: SpendFenceEvidence | undefined): Promise<boolean>;
  /** True on a store that holds operation reservations, with the five methods below. */
  readonly operationReservations?: true;
  /**
   * Records an operation's row in the locked day with run 1's own row, its recorded figure run 1's bound and run 1
   * holding the lease, adds `micro` to the day's open total, and answers its id; null, changing nothing, when the
   * operation has a row already.
   */
  addOperationReservation?(row: { day: string; kind: string; micro: number; created: Date; expires: Date; operation: string; runMicro: number; leaseUntil: Date }): Promise<string | null>;
  /** The operation's row, or null. */
  openOperationReservation?(operation: string): Promise<OperationReservation | null>;
  /**
   * In one locked step: `gone` when the row is settled or past its expiry at `at`; `in_flight` while a lease is live;
   * `gone` when it has had `maxRuns` runs or `runMicro` would take its recorded figure past its amount; else the run's
   * bound added to the recorded figure, the run counted, its own row written and the lease given to it.
   */
  beginRun?(id: string, run: { runMicro: number; leaseUntil: Date; maxRuns: number; at: Date }): Promise<RunBegin>;
  /**
   * In one transaction, all or nothing: the run's own row takes `settledMicro` held to its bound, unless it ended
   * already, when nothing changes; then, only when `run` holds the lease of an open row, its bound in the recorded
   * figure is replaced by that figure, the lease cleared, and the row settled at its recorded figure when `at` is past
   * its expiry or `close` is set.
   */
  endRun?(id: string, end: { run: number; settledMicro: number; at: Date; close: boolean }): Promise<RunEnd>;
  /**
   * In one locked step: true, the lease moved to `leaseUntil`, only when `run` holds a lease still live at `at` on an
   * open row; false, changing nothing, otherwise. A run renews its lease before it settles what it holds outside the
   * row (a unit on another meter), so no other run can begin and take that unit over while it settles it.
   */
  renewRun?(id: string, renew: { run: number; leaseUntil: Date; at: Date }): Promise<boolean>;
}

/** What an admission asks for: its kind, its largest cost, when it starts and until when, and the cap it must fit under. */
export interface SpendAdmission {
  /** What is admitted, such as `session` or `call`; the store records it and a refusal names it. */
  kind: string;
  /** Its largest cost in whole micro-dollars, zero or more. */
  micro: number;
  /** When it starts, a valid date; the reservation belongs to this time's UTC day. */
  at: Date;
  /**
   * When the reservation's time is up, a valid date, after which {@link releaseExpiredSpend} settles it: at its whole
   * amount, or as the sweep's resolver decides when it has one.
   */
  expires: Date;
  /**
   * The day's cap for this admission in whole micro-dollars, zero or more: the whole limit, or a share of it for a class
   * of admission. Any other cap, infinity included, refuses the admission.
   */
  capMicro: number;
  /** A reservation only a sweep with a resolver may settle once its time is up; see {@link releaseExpiredSpend}. */
  requireFence?: boolean;
}

/** One operation reservation as a store reads it. */
export interface OperationReservation {
  /** The id the store gave it. */
  id: string;
  /** The caller's operation, unique among the store's reservations. */
  operation: string;
  /** The amount reserved for every run the operation may have, in micro-dollars. */
  micro: number;
  /** What the row settles at: each ended run's settled figure and each other run's whole bound. */
  recordedMicro: number;
  /** The runs begun. */
  runs: number;
  /** When the lease of the run holding it ends, or null when no run holds it. */
  leaseUntil: Date | null;
  /** The number of the run holding the lease, or null. Run numbers only grow, so it is a fencing token. */
  leaseRun: number | null;
  /** When the row's window closes. */
  expires: Date;
  /** When it settled, or null while open. */
  settledAt: Date | null;
}

/** What a run's beginning answers. */
export type RunBegin = { status: 'begun'; run: number } | { status: 'in_flight'; leaseUntil: Date } | { status: 'gone' };

/** What a run's end answers: whether the run held the lease, and whether the row settled in that step. */
export interface RunEnd {
  /** True when the run held the lease as it ended. */
  holder: boolean;
  /** True when the row settled in the same step. */
  settled: boolean;
}

/**
 * An admission bound to an operation: the whole amount for every run, run 1's bound, and run 1's lease. The runs'
 * lease fences the row, so an operation admission never takes `requireFence`.
 */
export interface OperationAdmission extends SpendAdmission {
  /** The caller's name for the operation, unique among the store's reservations. */
  operation: string;
  /** Run 1's bound in whole micro-dollars, at most `micro`. */
  runMicro: number;
  /** When run 1's lease ends. */
  leaseUntil: Date;
}

/** What an operation admission answers: reserved with run 1's lease, or `in_flight` when the operation has a row already. */
export type OperationReserved = { status: 'reserved'; id: string; run: 1 } | { status: 'in_flight' };

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

/** Whether a store holds fenced reservations: it says so, and has the two methods they need. */
function supportsFencedReservations(store: SpendDayStore): boolean {
  return store.fencedReservations === true && typeof store.addFencedReservation === 'function' && typeof store.deferReservation === 'function';
}

/** Whether a store holds operation reservations: it says so, and has the five methods they need. */
function supportsOperationReservations(store: SpendDayStore): store is SpendDayStore & Required<Pick<SpendDayStore, 'addOperationReservation' | 'openOperationReservation' | 'beginRun' | 'endRun' | 'renewRun'>> {
  return store.operationReservations === true && typeof store.addOperationReservation === 'function' && typeof store.beginRun === 'function' && typeof store.endRun === 'function' && typeof store.openOperationReservation === 'function' && typeof store.renewRun === 'function';
}

/**
 * Reserves an admission's largest cost in the day it starts and answers the reservation's id, or throws
 * CostCapExceededError (`daily`) reserving nothing. A cost that is not whole micro-dollars, zero or more, is a
 * RangeError, and so is a start or an expiry that is not a valid date; a committed total the store does not answer as
 * whole micro-dollars, zero or more, refuses the admission, since the day's spending is then not known, and so does a
 * cap that is not whole micro-dollars, zero or more. An admission with `requireFence` is refused with an Error before
 * the day is read on a store that does not hold fenced reservations, and is recorded through `addFencedReservation`.
 */
export async function reserveSpend(store: SpendDayStore, admission: SpendAdmission): Promise<string> {
  if (admission.requireFence && !supportsFencedReservations(store)) throw new Error('fenced reservations unsupported');
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
  const row = { day, kind: admission.kind, micro: admission.micro, created: admission.at, expires: admission.expires };
  if (admission.requireFence && store.addFencedReservation) return store.addFencedReservation(row);
  return store.addReservation(row);
}

/**
 * Settles a reservation once at what its use cost, rounded down to whole micro-dollars; false when it was settled
 * already. A cost that is not a finite number, zero or more, was never known, so the reservation settles at its whole
 * amount, as an expired one does: a cost below zero settled at nothing would take the reservation's whole amount out of
 * the day's total.
 */
export function releaseSpend(store: SpendDayStore, id: string, settledMicro: number, at: Date): Promise<boolean> {
  // The store holds what settles to the amount reserved, so the largest exact amount settles a reservation whole.
  const known = Number.isFinite(settledMicro) && settledMicro >= 0;
  const settled = known ? Math.min(Math.floor(settledMicro), Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  return store.settleReservation(id, settled, at);
}

/**
 * Settles each reservation whose time is up and answers how many it settled. Without a resolver, an ordinary one
 * settles at its whole amount, since its use was never confirmed, and one made with `requireFence` is left reserved.
 * With `resolve`, each is decided by the host: consumed (its whole amount), released (nothing), or deferred until
 * `retryAt`, still open and counted; a resolver that throws defers for 15 seconds, never settling on a failure.
 * A sweep with `resolve` throws on a store that does not hold fenced reservations, and a reservation another process
 * settled in the meantime is not counted. An operation's row is listed only once its time is up and no run holds a
 * live lease, its amount the recorded figure, so a sweep without a resolver settles it there.
 */
export async function releaseExpiredSpend(
  store: SpendDayStore,
  at: Date,
  options: { resolve?: (reservation: OpenReservation) => Promise<SpendExpiryDecision> } = {},
): Promise<number> {
  if (options.resolve && !supportsFencedReservations(store)) throw new Error('fenced reservations unsupported');
  const expired = await store.expiredReservations(at);
  let settled = 0;
  for (const reservation of expired) {
    if (!options.resolve) {
      if (reservation.requireFence) continue;
      if (await store.settleReservation(reservation.id, reservation.micro, at)) settled += 1;
      continue;
    }
    let decision: SpendExpiryDecision;
    try {
      decision = await options.resolve(reservation);
    } catch {
      decision = { outcome: 'deferred', retryAt: at.getTime() + 15_000, evidence: { transportClosed: false, inferenceTerminated: false, observedAt: at.getTime(), note: 'resolver_failed' } };
    }
    if (decision.outcome === 'deferred') {
      await store.deferReservation?.(reservation.id, new Date(Math.max(decision.retryAt, at.getTime() + 1)), decision.evidence);
      continue;
    }
    const micro = decision.outcome === 'consumed' ? reservation.micro : 0;
    if (await store.settleReservation(reservation.id, micro, at)) settled += 1;
  }
  return settled;
}

/**
 * Admits an operation under the day's cap as {@link reserveSpend} admits a reservation, records run 1 and gives it
 * the lease. A store without operation reservations is refused with an Error before the day is read, and so is an
 * admission with `requireFence`, with a RangeError: the runs' lease fences an operation's row.
 * @throws {CostCapExceededError} Past the cap, with nothing reserved.
 */
export async function reserveOperationSpend(store: SpendDayStore, admission: OperationAdmission): Promise<OperationReserved> {
  if (!supportsOperationReservations(store)) throw new Error('operation reservations unsupported');
  if (!isWholeCount(admission.micro) || !isWholeCount(admission.runMicro) || admission.runMicro > admission.micro) {
    throw new RangeError('An operation reserves whole micro-dollars, its run at most its amount');
  }
  if (!isValidDate(admission.at) || !isValidDate(admission.expires) || !isValidDate(admission.leaseUntil)) {
    throw new RangeError('An operation starts, expires and leases at valid dates');
  }
  if (admission.operation === '') throw new RangeError('An operation has a name');
  if (admission.requireFence) throw new RangeError('An operation is fenced by its runs, not by requireFence');
  const day = utcDay(admission.at);
  const committed = await store.lockDay(day);
  if (!isWholeCount(committed) || !isWholeCount(admission.capMicro) || !(committed + admission.micro <= admission.capMicro)) {
    throw new CostCapExceededError(admission.kind, 'daily', committed / 1_000_000, admission.capMicro / 1_000_000);
  }
  const id = await store.addOperationReservation({
    day,
    kind: admission.kind,
    micro: admission.micro,
    created: admission.at,
    expires: admission.expires,
    operation: admission.operation,
    runMicro: admission.runMicro,
    leaseUntil: admission.leaseUntil,
  });
  return id === null ? { status: 'in_flight' } : { status: 'reserved', id, run: 1 };
}

/** Begins a further run of an operation's row; see {@link SpendDayStore.beginRun}. */
export async function beginOperationRun(store: SpendDayStore, id: string, run: { runMicro: number; leaseUntil: Date; maxRuns: number; at: Date }): Promise<RunBegin> {
  if (!supportsOperationReservations(store)) throw new Error('operation reservations unsupported');
  if (!isWholeCount(run.runMicro) || !Number.isInteger(run.maxRuns) || run.maxRuns < 1 || !isValidDate(run.at) || !isValidDate(run.leaseUntil)) {
    throw new RangeError('A run has a whole bound, a run count of 1 or more and valid dates');
  }
  return store.beginRun(id, run);
}

/**
 * Ends a run; see {@link SpendDayStore.endRun}. A figure that is not a finite number, zero or more, was never known,
 * so the run settles at its whole bound, as {@link releaseSpend} settles an unknown cost. An end that names no run
 * from 1 or no valid date is a RangeError, since a time that is not a date would settle the row at once.
 */
export async function endOperationRun(store: SpendDayStore, id: string, end: { run: number; settledMicro: number; at: Date; close: boolean }): Promise<RunEnd> {
  if (!supportsOperationReservations(store)) throw new Error('operation reservations unsupported');
  if (!Number.isInteger(end.run) || end.run < 1 || !isValidDate(end.at)) {
    throw new RangeError('An end names a run from 1 and a valid date');
  }
  const known = Number.isFinite(end.settledMicro) && end.settledMicro >= 0;
  const settledMicro = known ? Math.min(Math.floor(end.settledMicro), Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  return store.endRun(id, { ...end, settledMicro });
}

/** Renews a run's lease while it holds it; see {@link SpendDayStore.renewRun}. False for a run that no longer holds it. */
export async function renewOperationRun(store: SpendDayStore, id: string, renew: { run: number; leaseUntil: Date; at: Date }): Promise<boolean> {
  if (!supportsOperationReservations(store)) throw new Error('operation reservations unsupported');
  if (!Number.isInteger(renew.run) || renew.run < 1 || !isValidDate(renew.leaseUntil) || !isValidDate(renew.at)) {
    throw new RangeError('A renewal names a run from 1 and valid dates');
  }
  return store.renewRun(id, renew);
}

/** A run's own row in {@link InMemorySpendDayStore}: its bound, and its settled figure once it ended. */
type InMemoryRunRow = { boundMicro: number; settledMicro: number | null; started: Date; ended: Date | null };

/**
 * A store held in memory, for tests and for one process that admits one reservation at a time. It takes no lock, so
 * two admissions awaited at once can both read the same total; a service that admits concurrently implements
 * {@link SpendDayStore} on tables whose day row its transaction locks. It holds fenced and operation reservations, and
 * each of its operation methods reads and writes its rows in one step on the event loop, before it awaits anything.
 */
export class InMemorySpendDayStore implements SpendDayStore {
  /** It holds fenced reservations. */
  readonly fencedReservations = true as const;
  /** It holds operation reservations. */
  readonly operationReservations = true as const;
  private readonly days = new Map<string, { reserved: number; settled: number }>();
  private readonly reservations = new Map<string, { day: string; micro: number; expires: Date; settledAt: Date | null; requireFence: boolean; nextCheck: Date | null; evidence?: SpendFenceEvidence; operation?: string; recorded?: number; runs?: number; leaseUntil?: Date | null; leaseRun?: number | null }>();
  private made = 0;
  private readonly operations = new Map<string, string>();
  private readonly runRows = new Map<string, Map<number, InMemoryRunRow>>();

  /** Makes the day when missing and answers its committed total (it takes no lock: see the class). */
  lockDay(day: string): Promise<number> {
    const row = this.days.get(day) ?? { reserved: 0, settled: 0 };
    this.days.set(day, row);
    return Promise.resolve(row.reserved + row.settled);
  }

  /** Records a reservation made with `requireFence` and adds it to its day's open total. */
  addFencedReservation(reservation: { day: string; kind: string; micro: number; created: Date; expires: Date }): Promise<string> {
    return this.addReservation({ ...reservation, requireFence: true });
  }

  /** Records a reservation and adds it to its day's open total. */
  addReservation(reservation: { day: string; kind: string; micro: number; created: Date; expires: Date; requireFence?: boolean }): Promise<string> {
    return Promise.resolve(this.insertReservation(reservation));
  }

  /** Records a reservation and adds it to its day's open total in one synchronous step, answering its id. */
  private insertReservation(reservation: { day: string; micro: number; expires: Date; requireFence?: boolean }): string {
    const id = `reservation-${++this.made}`;
    this.reservations.set(id, { day: reservation.day, micro: reservation.micro, expires: reservation.expires, settledAt: null, requireFence: reservation.requireFence === true, nextCheck: null });
    const row = this.days.get(reservation.day) ?? { reserved: 0, settled: 0 };
    row.reserved += reservation.micro;
    this.days.set(reservation.day, row);
    return id;
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

  /**
   * The open reservations whose time is up and whose next check, when deferred, has come; an operation's row only once
   * no run holds a live lease, listed at its recorded figure.
   */
  expiredReservations(at: Date): Promise<OpenReservation[]> {
    const due = [...this.reservations.entries()].filter(
      ([, r]) =>
        r.settledAt === null &&
        r.expires.getTime() <= at.getTime() &&
        (r.nextCheck === null || r.nextCheck.getTime() <= at.getTime()) &&
        !(r.leaseUntil != null && r.leaseUntil.getTime() > at.getTime()),
    );
    return Promise.resolve(due.map(([id, r]) => ({ id, micro: r.recorded ?? r.micro, ...(r.requireFence ? { requireFence: true } : {}), ...(r.evidence ? { evidence: structuredClone(r.evidence) } : {}) })));
  }

  /** Defers an open reservation's next check. */
  deferReservation(id: string, retryAt: Date, evidence: SpendFenceEvidence | undefined): Promise<boolean> {
    const reservation = this.reservations.get(id);
    if (reservation === undefined || reservation.settledAt !== null) return Promise.resolve(false);
    reservation.nextCheck = retryAt;
    reservation.requireFence = true;
    if (evidence) reservation.evidence = structuredClone(evidence);
    return Promise.resolve(true);
  }

  /**
   * Records an operation's row and run 1, or answers null when the operation has one. The check and the record are one
   * synchronous step, so of two admissions of one operation made at once, one records the row.
   */
  addOperationReservation(row: { day: string; kind: string; micro: number; created: Date; expires: Date; operation: string; runMicro: number; leaseUntil: Date }): Promise<string | null> {
    if (this.operations.has(row.operation)) return Promise.resolve(null);
    const id = this.insertReservation(row);
    const made = this.reservations.get(id)!;
    Object.assign(made, { operation: row.operation, recorded: row.runMicro, runs: 1, leaseUntil: row.leaseUntil, leaseRun: 1 });
    this.operations.set(row.operation, id);
    this.runRows.set(id, new Map<number, InMemoryRunRow>([[1, { boundMicro: row.runMicro, settledMicro: null, started: row.created, ended: null }]]));
    return Promise.resolve(id);
  }

  /** The operation's row, copied. */
  openOperationReservation(operation: string): Promise<OperationReservation | null> {
    const id = this.operations.get(operation);
    const r = id === undefined ? undefined : this.reservations.get(id);
    if (id === undefined || r === undefined) return Promise.resolve(null);
    return Promise.resolve({ id, operation, micro: r.micro, recordedMicro: r.recorded!, runs: r.runs!, leaseUntil: r.leaseUntil ?? null, leaseRun: r.leaseRun ?? null, expires: r.expires, settledAt: r.settledAt });
  }

  /** A run's beginning; the store takes no lock and runs one call at a time on the event loop (see the class). */
  async beginRun(id: string, run: { runMicro: number; leaseUntil: Date; maxRuns: number; at: Date }): Promise<RunBegin> {
    const r = this.reservations.get(id);
    if (r === undefined || r.operation === undefined || r.settledAt !== null || r.expires.getTime() <= run.at.getTime()) return { status: 'gone' };
    if (r.leaseUntil != null && r.leaseUntil.getTime() > run.at.getTime()) return { status: 'in_flight', leaseUntil: r.leaseUntil };
    if (r.runs! >= run.maxRuns || r.recorded! + run.runMicro > r.micro) return { status: 'gone' };
    r.recorded = r.recorded! + run.runMicro;
    r.runs = r.runs! + 1;
    r.leaseUntil = run.leaseUntil;
    r.leaseRun = r.runs;
    this.runRows.get(id)!.set(r.runs, { boundMicro: run.runMicro, settledMicro: null, started: run.at, ended: null });
    return { status: 'begun', run: r.runs };
  }

  /** A run's end, in one step. */
  async endRun(id: string, end: { run: number; settledMicro: number; at: Date; close: boolean }): Promise<RunEnd> {
    const r = this.reservations.get(id);
    const own = this.runRows.get(id)?.get(end.run);
    if (r === undefined || own === undefined || own.settledMicro !== null) return { holder: false, settled: false };
    own.settledMicro = Math.min(Math.max(0, end.settledMicro), own.boundMicro);
    own.ended = end.at;
    if (r.leaseRun !== end.run || r.settledAt !== null) return { holder: false, settled: false };
    r.recorded = r.recorded! - own.boundMicro + own.settledMicro;
    r.leaseUntil = null;
    r.leaseRun = null;
    if (!end.close && r.expires.getTime() > end.at.getTime()) return { holder: true, settled: false };
    await this.settleReservation(id, r.recorded, end.at);
    return { holder: true, settled: true };
  }

  /** A lease's renewal by the run that holds it, in one step. */
  renewRun(id: string, renew: { run: number; leaseUntil: Date; at: Date }): Promise<boolean> {
    const r = this.reservations.get(id);
    if (r === undefined || r.settledAt !== null || r.leaseRun !== renew.run || r.leaseUntil == null || r.leaseUntil.getTime() <= renew.at.getTime()) return Promise.resolve(false);
    r.leaseUntil = renew.leaseUntil;
    return Promise.resolve(true);
  }

  /** A run's own row, for tests. */
  runOf(id: string, run: number): { boundMicro: number; settledMicro: number | null } | undefined {
    return this.runRows.get(id)?.get(run);
  }
}
