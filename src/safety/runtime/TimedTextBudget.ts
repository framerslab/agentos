/**
 * @fileoverview Text funding by elapsed time for a listening session, independent of its provider sockets. A part of
 * `partMicro` funds each `sliceMs` of wall time from the session's start; the first part is the reservation the host
 * made at admission, and each later part is reserved through the host's own spend adapter when its boundary passes and
 * the host has proved the session's current allowance. Reconnects, rollovers and fallbacks of the transcription sockets
 * change nothing here. Text cost is reported cumulatively from the session's one serialized text lane, and every part
 * settles once. The state is one versioned document in the host's {@link CreditTransaction}, under the scope and
 * customer locks the host already holds. Amounts are whole micro-dollars; times are epoch milliseconds.
 *
 * @module safety/runtime/TimedTextBudget
 */
import { createHash } from 'node:crypto';
import type { CreditTransaction } from './CompoundCreditStore.js';

/** What the current part has left, when the next part may be reserved, and the session's cumulative text cost. */
export interface TimedTextBudgetView { leftMicro: number; renewAtMs: number; totalMicro: number }
interface Part { bucket: number; reservationId: string; usedMicro: number }
interface Budget {
  startedAt: number; sliceMs: number; partMicro: number; totalMicro: number;
  parts: Part[]; settled: boolean;
}
const key = (id: string): string => 'text-budget:' + createHash('sha256').update(id).digest('hex');
const whole = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid text budget quantity');
  return n;
};
function requireDocuments(t: CreditTransaction): void {
  if (!t.getDocument || !t.putDocument) throw new Error('credit store lacks documents');
}
async function read(t: CreditTransaction, scope: string, id: string): Promise<Budget> {
  requireDocuments(t);
  const row = await t.getDocument!(scope, key(id));
  if (!row) throw new Error('missing text budget');
  return JSON.parse(row.value) as Budget;
}
async function write(t: CreditTransaction, scope: string, id: string, value: Budget): Promise<void> {
  const row = await t.getDocument!(scope, key(id));
  await t.putDocument!({ scopeId: scope, documentId: key(id), value: JSON.stringify(value), version: (row?.version ?? 0) + 1 });
}

/**
 * Starts a session's text funding before its first text request; the caller holds the supplier scope and customer
 * locks in its existing transaction, where it also made `initialReservationId`.
 *
 * @throws {Error} For a quantity that is not a whole number, a zero slice or part, a missing reservation id, a store
 *   without documents, or a budget id already used in the scope.
 */
export async function createTimedTextBudget(t: CreditTransaction, input: {
  scopeId: string; budgetId: string; at: number; sliceMs: number; partMicro: number; initialReservationId: string;
}): Promise<void> {
  whole(input.at); whole(input.sliceMs); whole(input.partMicro);
  if (!input.sliceMs || !input.partMicro || !input.initialReservationId) throw new Error('invalid text budget');
  requireDocuments(t);
  if (await t.getDocument!(input.scopeId, key(input.budgetId))) throw new Error('text budget already exists');
  await write(t, input.scopeId, input.budgetId, { startedAt: input.at, sliceMs: input.sliceMs,
    partMicro: input.partMicro, totalMicro: 0, settled: false,
    parts: [{ bucket: 0, reservationId: input.initialReservationId, usedMicro: 0 }] });
}

/** The current part's remainder (zero once settled), its renewal instant and the cumulative text cost. */
export async function readTimedTextBudget(t: CreditTransaction, scope: string, id: string): Promise<TimedTextBudgetView> {
  const b = await read(t, scope, id); const part = b.parts[b.parts.length - 1]!;
  return { leftMicro: b.settled ? 0 : Math.max(0, b.partMicro - part.usedMicro),
    renewAtMs: b.startedAt + (part.bucket + 1) * b.sliceMs, totalMicro: b.totalMicro };
}

/**
 * Records the session's cumulative text cost against the current part. Reports use the one serialized text lane;
 * renewal first drains its in-flight request. A total at or below the recorded one changes nothing.
 *
 * @throws {Error} For a total that is not a whole number, or a larger total after settlement.
 */
export async function reportTimedTextBudget(t: CreditTransaction, scope: string, id: string,
  cumulativeMicro: number): Promise<void> {
  whole(cumulativeMicro);
  const b = await read(t, scope, id);
  if (cumulativeMicro <= b.totalMicro) return;
  if (b.settled) throw new Error('text budget settled');
  const part = b.parts[b.parts.length - 1]!;
  part.usedMicro = whole(part.usedMicro + cumulativeMicro - b.totalMicro);
  b.totalMicro = cumulativeMicro;
  await write(t, scope, id, b);
}

/**
 * Reserves the next part once its slice boundary has passed. The host proves current wall-time allowance and team
 * membership (`allowed`) and reserves through its native spend adapter (`reserve`); a renewal inside the current
 * slice answers the current view without reserving again.
 *
 * @throws {Error} When the allowance is refused, before the first boundary, after settlement, or when `reserve`
 *   answers an empty or already used reservation id.
 */
export async function renewTimedTextBudget(t: CreditTransaction, input: {
  scopeId: string; budgetId: string; at: number; cumulativeMicro: number; allowed: boolean;
}, reserve: (micro: number, expiresAtMs: number) => Promise<string>): Promise<TimedTextBudgetView> {
  whole(input.at);
  if (!input.allowed) throw new Error('text allowance refused');
  await reportTimedTextBudget(t, input.scopeId, input.budgetId, input.cumulativeMicro);
  const b = await read(t, input.scopeId, input.budgetId);
  if (b.settled) throw new Error('text budget settled');
  const bucket = Math.floor((input.at - b.startedAt) / b.sliceMs);
  const prior = b.parts[b.parts.length - 1]!;
  if (bucket < prior.bucket || bucket < 1) throw new Error('text renewal before boundary');
  if (bucket > prior.bucket) {
    const expiresAtMs = whole(b.startedAt + (bucket + 1) * b.sliceMs + 300000);
    const reservationId = await reserve(b.partMicro, expiresAtMs);
    if (!reservationId || b.parts.some((part) => part.reservationId === reservationId)) throw new Error('invalid text reservation');
    b.parts.push({ bucket, reservationId, usedMicro: 0 });
    await write(t, input.scopeId, input.budgetId, b);
  }
  return readTimedTextBudget(t, input.scopeId, input.budgetId);
}

/**
 * Combines the initial audio with its capped text part and settles subsequent text-only reservations once; each part
 * settles at most its `partMicro` of text. A second call changes nothing.
 */
export async function settleTimedTextBudget(t: CreditTransaction, input: {
  scopeId: string; budgetId: string; initialAudioMicro: number;
}, settle: (reservationId: string, grossMicro: number) => Promise<void>): Promise<void> {
  whole(input.initialAudioMicro);
  const b = await read(t, input.scopeId, input.budgetId);
  if (b.settled) return;
  for (const [index, part] of b.parts.entries()) {
    const micro = whole(Math.min(part.usedMicro, b.partMicro) + (index === 0 ? input.initialAudioMicro : 0));
    await settle(part.reservationId, micro);
  }
  await write(t, input.scopeId, input.budgetId, { ...b, settled: true });
}
