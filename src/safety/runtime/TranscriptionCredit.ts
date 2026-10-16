/**
 * @fileoverview Supplier credit for hosted transcription: a promotional balance a vendor granted the platform, reserved
 * before audio and allocated from measured usage, over the native compound credit rows (accounts, lots, holds,
 * allocations and immutable entries) plus versioned documents in the same {@link CreditTransaction}.
 *
 * One scope per promotional pool, in a store or table prefix of its own, separate from customer funding. A funding
 * record ({@link makeTranscriptionCreditRecord}) binds the vendor, the console amount, its read instant, the project,
 * the verified usage contract and the expiry into one version. Nothing is allocated before a successful usage check of
 * that version; a check older than 24 hours, three failed UTC check days, expiry or a disabled record stop allocation.
 * Local measured usage stays deducted until complete supplier evidence matches its finished request, and every gross
 * estimate stays outstanding until its reservation's final report, including reservations that hold no promotional
 * dollars. Every mutating operation locks the supplier scope first; hosts take this scope before their customer account
 * locks, retry the whole transaction on a credit conflict (`withCreditRetry`, or the host's own retry around
 * `SqlCompoundCreditStore.withStorageTransaction`), and make no network request inside it.
 *
 * Promotional allocation never authorizes audio. The host keeps its full gross spend reservation for every connection;
 * a zero promotional reservation is valid. Amounts are whole micro-dollars; times are epoch milliseconds.
 *
 * @module safety/runtime/TranscriptionCredit
 */
import { createHash } from 'node:crypto';
import { componentMicro } from './CreditRates.js';
import { minutesMicro } from './SpendReservations.js';
import { lotFreeMicro, type CallFence } from './CompoundCreditLedger.js';
import { creditDay, type CreditTransaction, type CreditLotRow, type CreditHoldRow } from './CompoundCreditStore.js';
import { parseSttEntry, type SttChainVendor } from '../../io/voice-pipeline/sttEntries.js';
import {
  selectLowestCostSttEntry, type SttCreditSnapshot, type SttPriceRow, type LowestCostSttSelection,
} from '../../io/voice-pipeline/LowestCostStt.js';
import type { DeepgramUsageEvidence } from '../../io/voice-pipeline/providers/DeepgramUsage.js';

/** Verified funding inputs; the amount is a current console reading, never a grant inferred from an API key. */
export interface TranscriptionCreditRecordInput {
  vendor: 'deepgram';
  amountMicro: number;
  readAtMs: number;
  projectId: string;
  contractVersion: string;
  validUntilMs: number;
}
/** Immutable identity covering the complete funding record and its evidence scope. */
export interface TranscriptionCreditRecord extends TranscriptionCreditRecordInput { readonly version: string }
/** Inputs to a promotional reservation. The separate gross spend reservation is still mandatory. */
export interface ReserveTranscriptionCreditInput {
  scopeId: string;
  reservationId: string;
  entry: string;
  microPerMinute: number;
  estimatedSeconds: number;
  creditVersion?: string;
  at: number;
}
/** Persisted admission response; a retry returns the same order and reservation. */
export interface TranscriptionAdmission {
  selection: LowestCostSttSelection;
  reservationId: string;
  reservedMicro: number;
}
/** A cumulative report settled once by reportId; amounts here describe only this interval. */
export interface TranscriptionIntervalInput {
  scopeId: string;
  reservationId: string;
  connectionId: string;
  entry: string;
  reportId: string;
  audioSeconds: number;
  final: boolean;
  supplierRequestId?: string;
  at: number;
}
/** Receipt allocation in whole micro-dollars. A split interval has both prepaid and charged amounts. */
export interface TranscriptionIntervalAllocation {
  reportId: string;
  connectionId: string;
  entry: string;
  fromSeconds: number;
  toSeconds: number;
  grossMicro: number;
  prepaidMicro: number;
  chargedMicro: number;
  creditVersion: string | null;
  final: boolean;
}
interface Control { active: string | null; open: number; everConfigured: boolean; outstandingDeepgramMicro: number }
interface FundingState {
  record: TranscriptionCreditRecord;
  checkedAtMs: number | null;
  throughMs: number;
  reportedMicro: number;
  localMicro: number;
  reconciledMicro: number;
  localRequests: Record<string, { reservationId: string; grossMicro: number; final: boolean; reconciled: boolean; supplierCostMicro?: number }>;
  failedDays: number;
  lastFailureDay: string | null;
  lastFailureAt: number;
}
interface Reservation {
  id: string; entry: string; microPerMinute: number; estimatedSeconds: number;
  creditVersion: string | null; holdId: string; reservedMicro: number;
  connectionId: string | null; seconds: number; grossMicro: number; prepaidMicro: number;
  final: boolean; requestHash: string; supplierRequestId?: string; admission?: TranscriptionAdmission;
}
interface SavedReport { hash: string; allocation: TranscriptionIntervalAllocation }

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const whole = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid whole credit amount or time');
};
/** Refuses a non-string, an empty or over-long identity, and one holding a control character (U+0000 to U+001F). */
const identity = (value: string): void => {
  let controlCharacter = false;
  if (typeof value === 'string') {
    for (let i = 0; i < value.length && !controlCharacter; i += 1) controlCharacter = value.charCodeAt(i) < 0x20;
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || controlCharacter) {
    throw new RangeError('invalid credit identity');
  }
};
const key = (kind: string, id: string): string => `${kind}:${hash(id)}`;
const lotId = (scopeId: string, version: string): string => `stt_lot_${hash([scopeId, version])}`;
const holdId = (scopeId: string, id: string): string => `stt_hold_${hash([scopeId, id])}`;
async function lock(t: CreditTransaction, scope: string, at: number): Promise<void> {
  identity(scope); whole(at);
  if (!t.getDocument || !t.putDocument) throw new Error('credit store lacks document transactions');
  if (!await t.lockAccount(scope)) await t.putAccount({ scopeId: scope, currency: 'USD', frozen: false,
    openDisputes: 0, createdAt: at, version: 1 });
}
async function get<T>(t: CreditTransaction, scope: string, id: string): Promise<T | undefined> {
  const row = await t.getDocument!(scope, id);
  return row ? JSON.parse(row.value) as T : undefined;
}
async function put(t: CreditTransaction, scope: string, id: string, value: unknown): Promise<void> {
  const row = await t.getDocument!(scope, id);
  await t.putDocument!({ scopeId: scope, documentId: id, value: JSON.stringify(value), version: (row?.version ?? 0) + 1 });
}
async function control(t: CreditTransaction, scope: string): Promise<Control> {
  return await get<Control>(t, scope, 'control') ?? { active: null, open: 0, everConfigured: false, outstandingDeepgramMicro: 0 };
}
async function funding(t: CreditTransaction, scope: string, version: string): Promise<FundingState> {
  const state = await get<FundingState>(t, scope, key('funding', version));
  if (!state || state.record.version !== version) throw new Error('unknown credit version');
  return state;
}
function remaining(state: FundingState): number {
  return Math.max(0, state.record.amountMicro - state.reportedMicro - (state.localMicro - state.reconciledMicro));
}
function fresh(state: FundingState, at: number): boolean {
  return state.checkedAtMs !== null && state.checkedAtMs <= at && at - state.checkedAtMs < 86400000
    && state.failedDays < 3 && state.record.validUntilMs > at && state.record.readAtMs <= at;
}
async function append(t: CreditTransaction, scope: string, id: string, kind: 'hold_reserved' | 'hold_settled' | 'hold_released',
  amount: number, hold: string, at: number): Promise<void> {
  if (!await t.appendEntry({ entryId: id, scopeId: scope, kind, amountMicro: amount,
    lotId: null, holdId: hold, ref: null, at, day: creditDay(at) })) throw new Error('credit entry conflict');
}

/**
 * The canonical record: its version changes whenever any funding or verification input changes.
 *
 * @throws {RangeError} For a vendor other than `deepgram`, a project id that is not a UUID, an expiry at or before the
 *   read instant, an amount or time that is not a whole number, or a contract version that is not an identity.
 */
export function makeTranscriptionCreditRecord(input: TranscriptionCreditRecordInput): TranscriptionCreditRecord {
  whole(input.amountMicro); whole(input.readAtMs); whole(input.validUntilMs); identity(input.contractVersion);
  if (input.vendor !== 'deepgram' || input.validUntilMs <= input.readAtMs
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.projectId)) {
    throw new RangeError('invalid transcription credit record');
  }
  const normalized = { vendor: input.vendor, amountMicro: input.amountMicro, readAtMs: input.readAtMs,
    projectId: input.projectId.toLowerCase(), contractVersion: input.contractVersion, validUntilMs: input.validUntilMs };
  return Object.freeze({ ...normalized, version: hash(normalized) });
}

/**
 * Activate a new, unchecked baseline or disable credit immediately. Re-enabling a previously used
 * version is forbidden. Replacing a baseline requires drained reservations and positive stop evidence
 * observed at or before the new console read. The host also fences nonlocal spending before that read.
 *
 * @throws {Error} While any reservation is open, for a retired version, for a record whose version does not match its
 *   fields, is read in the future or has expired, and for a replacement without its fence.
 */
export async function configureTranscriptionCredit(t: CreditTransaction, input: {
  scopeId: string; record: TranscriptionCreditRecord | null; at: number; baselineFence?: CallFence;
}): Promise<void> {
  await lock(t, input.scopeId, input.at);
  const c = await control(t, input.scopeId);
  if (!input.record) { await put(t, input.scopeId, 'control', { ...c, active: null }); return; }
  const r = makeTranscriptionCreditRecord(input.record);
  if (r.version !== input.record.version || r.readAtMs > input.at || r.validUntilMs <= input.at) {
    throw new Error('invalid credit version');
  }
  if (c.active === r.version) return;
  if (c.open !== 0) throw new Error('open reservations prevent a new baseline');
  if (await get(t, input.scopeId, key('funding', r.version))) throw new Error('retired credit version cannot be reactivated');
  const fence = input.baselineFence;
  if (c.everConfigured && (!fence?.mediaClosed || !fence.inferenceTerminated || !fence.evidence
    || !Number.isSafeInteger(fence.observedAt) || fence.observedAt < 0 || fence.observedAt > r.readAtMs)) {
    throw new Error('new baseline requires a fence before its console read');
  }
  const lot: CreditLotRow = { lotId: lotId(input.scopeId, r.version), scopeId: input.scopeId,
    kind: 'promotion', fundingRef: r.version, principalMicro: r.amountMicro,
    consumedMicro: 0, heldMicro: 0, refundedMicro: 0, retiredMicro: 0, state: 'active',
    expiresAt: r.validUntilMs, createdAt: input.at, version: 1 };
  await t.putLot(lot);
  await put(t, input.scopeId, key('funding', r.version), { record: r, checkedAtMs: null,
    throughMs: r.readAtMs, reportedMicro: 0, localMicro: 0, reconciledMicro: 0, localRequests: {}, failedDays: 0,
    lastFailureDay: null, lastFailureAt: 0 } satisfies FundingState);
  await put(t, input.scopeId, 'control', { ...c, active: r.version, everConfigured: true });
}

/**
 * Replace a checked interval only for the active full record; never erase local liabilities. A finished local request
 * that the evidence lists is reconciled once: its supplier cost counts through the reported total and its local gross
 * leaves the unreported deduction.
 *
 * @throws {Error} For an inactive version, evidence of another project, contract or baseline, evidence from the future
 *   or older than the last check or failure, a total or interval that regressed, a duplicate request, or a reconciled
 *   request that is missing or changed.
 */
export async function refreshTranscriptionCredit(t: CreditTransaction, input: {
  scopeId: string; recordVersion: string; evidence: DeepgramUsageEvidence; at: number;
}): Promise<void> {
  await lock(t, input.scopeId, input.at);
  if ((await control(t, input.scopeId)).active !== input.recordVersion) throw new Error('inactive credit version');
  const state = await funding(t, input.scopeId, input.recordVersion);
  const e = input.evidence;
  whole(e.costMicro); whole(e.fromMs); whole(e.throughMs); whole(e.checkedAtMs);
  for (const request of e.requests) {
    identity(request.requestId); whole(request.costMicro); whole(request.createdAtMs); whole(request.completedAtMs);
    if (request.createdAtMs < e.fromMs || request.completedAtMs < request.createdAtMs
      || request.completedAtMs > e.throughMs) throw new Error('invalid completed request evidence');
  }
  if (e.projectId !== state.record.projectId || e.contractVersion !== state.record.contractVersion
    || e.fromMs !== state.record.readAtMs || e.throughMs < e.fromMs || e.throughMs > e.checkedAtMs
    || e.checkedAtMs > input.at || e.checkedAtMs < (state.checkedAtMs ?? 0)
    || e.checkedAtMs < state.lastFailureAt || state.record.validUntilMs <= input.at) throw new Error('invalid usage evidence');
  if (e.costMicro < state.reportedMicro || e.throughMs < state.throughMs) throw new Error('usage evidence regressed');
  const localRequests = { ...state.localRequests };
  let reconciledMicro = state.reconciledMicro;
  const requests = new Map(e.requests.map((request) => [request.requestId, request]));
  if (requests.size !== e.requests.length) throw new Error('duplicate supplier request');
  for (const [id, local] of Object.entries(localRequests)) {
    const request = requests.get(id);
    if (local.reconciled && (!request || request.costMicro !== local.supplierCostMicro)) {
      throw new Error('reconciled request evidence regressed');
    }
    if (!local.final || local.reconciled || !request) continue;
    if (request.createdAtMs < state.record.readAtMs || request.completedAtMs > e.throughMs) continue;
    reconciledMicro += local.grossMicro;
    localRequests[id] = { ...local, reconciled: true, supplierCostMicro: request.costMicro };
  }
  whole(reconciledMicro);
  await put(t, input.scopeId, key('funding', input.recordVersion), { ...state, localRequests, reconciledMicro,
    checkedAtMs: e.checkedAtMs, throughMs: e.throughMs, reportedMicro: e.costMicro,
    failedDays: 0, lastFailureDay: null, lastFailureAt: 0 });
}

/** Count at most one failure per UTC day; an older in-flight result cannot undo a success. */
export async function failTranscriptionCreditCheck(t: CreditTransaction, input: {
  scopeId: string; recordVersion: string; at: number;
}): Promise<void> {
  await lock(t, input.scopeId, input.at);
  if ((await control(t, input.scopeId)).active !== input.recordVersion) return;
  const state = await funding(t, input.scopeId, input.recordVersion);
  if (input.at <= (state.checkedAtMs ?? -1) || input.at < state.lastFailureAt) return;
  const day = creditDay(input.at);
  await put(t, input.scopeId, key('funding', input.recordVersion), { ...state,
    failedDays: state.failedDays + (day === state.lastFailureDay ? 0 : 1),
    lastFailureDay: day, lastFailureAt: input.at });
}

/**
 * Snapshot consumed by the pure selector under this same account lock. Stale figures stay diagnostic: the selector
 * refuses a snapshot whose check is 24 hours old or has three failed days. Undefined before the first successful check
 * of the active version, after expiry, and for any other version.
 */
export async function transcriptionCreditSnapshot(t: CreditTransaction, scopeId: string,
  version: string | undefined, at: number): Promise<SttCreditSnapshot | undefined> {
  await lock(t, scopeId, at);
  const c = await control(t, scopeId);
  if (!version || c.active !== version) return undefined;
  const state = await funding(t, scopeId, version);
  if (state.checkedAtMs === null || state.record.validUntilMs <= at) return undefined;
  const lot = await t.getLot(lotId(scopeId, version));
  if (!lot) throw new Error('missing supplier lot');
  return { vendor: state.record.vendor, version, checkedAtMs: state.checkedAtMs,
    remainingMicro: Math.min(remaining(state), lotFreeMicro(lot) + lot.heldMicro),
    reservedMicro: c.outstandingDeepgramMicro, failedDays: state.failedDays };
}

/**
 * Reserve up to the available promotion; zero is valid because gross spend authorization is separate. The full gross
 * estimate of a Deepgram entry stays outstanding until the reservation's final report, whatever was reserved.
 *
 * @returns The promotional micro-dollars held; a retry with identical inputs answers the first reservation's amount.
 * @throws {Error} For a retry with other inputs (`reservation conflict`).
 * @throws {RangeError} For a malformed entry or identity, or an amount or estimate that is not a positive whole number.
 */
export async function reserveTranscriptionCredit(t: CreditTransaction, input: ReserveTranscriptionCreditInput): Promise<number> {
  await lock(t, input.scopeId, input.at); identity(input.reservationId);
  whole(input.microPerMinute); whole(input.estimatedSeconds);
  if (input.estimatedSeconds === 0) throw new RangeError('positive estimated seconds required');
  const vendor = parseSttEntry(input.entry).vendor;
  const fingerprint = hash([input.entry, input.microPerMinute, input.estimatedSeconds, input.creditVersion ?? null]);
  const existing = await get<Reservation>(t, input.scopeId, key('reservation', input.reservationId));
  if (existing) {
    if (existing.requestHash !== fingerprint) throw new Error('reservation conflict');
    return existing.reservedMicro;
  }
  const c = await control(t, input.scopeId);
  const state = c.active ? await funding(t, input.scopeId, c.active) : undefined;
  const matching = state?.record.vendor === vendor ? state : undefined;
  const quote = componentMicro(input.estimatedSeconds, { unit: 'second', micro: input.microPerMinute, per: 60 });
  let reservedMicro = 0;
  let lot: CreditLotRow | undefined;
  if (matching && input.creditVersion === c.active && fresh(matching, input.at)) {
    lot = await t.getLot(lotId(input.scopeId, matching.record.version));
    if (!lot) throw new Error('missing supplier lot');
    reservedMicro = Math.min(quote, lotFreeMicro(lot), Math.max(0, remaining(matching) - c.outstandingDeepgramMicro));
  }
  const id = holdId(input.scopeId, input.reservationId);
  const rate = { version: `stt:${input.entry}:${input.microPerMinute}`, currency: 'USD' as const,
    components: { audio: { customer: { unit: 'second' as const, micro: input.microPerMinute, per: 60 },
      supplier: { unit: 'second' as const, micro: 0, per: 60 } } }, reasoningInOutput: false };
  const hold: CreditHoldRow = { holdId: id, scopeId: input.scopeId, operationId: input.reservationId,
    kind: 'supplier_transcription', requestHash: fingerprint, customerMicro: reservedMicro, supplierMicro: 0,
    mediaCustomerMicro: reservedMicro, mediaSupplierMicro: 0, attemptCustomerMicro: 0, attemptSupplierMicro: 0,
    maxAttempts: 0, attemptLimits: JSON.stringify({ maxAttempts: 0, perAttempt: {} }),
    rateVersion: rate.version, rates: JSON.stringify({ primary: rate, fallbacks: [] }), mediaComponent: 'audio',
    state: 'held', chargedMicro: 0, supplierSettledMicro: 0, supplierOpenMicro: 0,
    createdAt: input.at, expiresAt: input.at + input.estimatedSeconds * 1000,
    settledAt: null, deferredUntil: null, fenceEvidence: null, version: 1 };
  whole(hold.expiresAt);
  await t.putHold(hold);
  if (lot && reservedMicro > 0) {
    await t.putLot({ ...lot, heldMicro: lot.heldMicro + reservedMicro, version: lot.version + 1 });
    await t.putAllocation({ holdId: id, seq: 1, lotId: lot.lotId, amountMicro: reservedMicro,
      consumedMicro: 0, releasedMicro: 0, retiredMicro: 0, settled: false });
  }
  await put(t, input.scopeId, key('reservation', input.reservationId), {
    id: input.reservationId, entry: input.entry, microPerMinute: input.microPerMinute,
    estimatedSeconds: input.estimatedSeconds, creditVersion: matching?.record.version ?? null,
    holdId: id, reservedMicro, connectionId: null, seconds: 0, grossMicro: 0,
    prepaidMicro: 0, final: false, requestHash: fingerprint } satisfies Reservation);
  await put(t, input.scopeId, 'control', { ...c, open: c.open + 1,
    outstandingDeepgramMicro: c.outstandingDeepgramMicro + (vendor === 'deepgram' ? quote : 0) });
  await append(t, input.scopeId, `stt-reserve:${id}`, 'hold_reserved', reservedMicro, id, input.at);
  return reservedMicro;
}

/**
 * Select and reserve in one transaction; callers persist their session before this transaction commits.
 *
 * @returns The selection and its reservation; a retry with identical inputs answers the stored admission.
 * @throws {Error} When no offered vendor is available, or for a retry with other inputs (`admission conflict`).
 */
export async function admitLowestCostTranscription(t: CreditTransaction, input: {
  scopeId: string; reservationId: string; entries: readonly string[]; prices: readonly SttPriceRow[];
  availableVendors: readonly SttChainVendor[]; estimatedSeconds: number; language?: string | null; creditVersion?: string; at: number;
}): Promise<TranscriptionAdmission> {
  await lock(t, input.scopeId, input.at);
  whole(input.estimatedSeconds);
  const previous = await get<Reservation>(t, input.scopeId, key('reservation', input.reservationId));
  const admissionHash = hash([input.entries, input.prices, input.availableVendors, input.estimatedSeconds, input.creditVersion ?? null, input.language === undefined ? { legacyDefault: true } : input.language]);
  const priorHash = await get<string>(t, input.scopeId, key('admission', input.reservationId));
  if (previous) {
    if (!previous.admission || priorHash !== admissionHash) throw new Error('admission conflict');
    return previous.admission;
  }
  const credit = await transcriptionCreditSnapshot(t, input.scopeId, input.creditVersion, input.at);
  const selection = selectLowestCostSttEntry(input.entries, input.prices, {
    availableVendors: input.availableVendors, nowMs: input.at, estimatedSeconds: input.estimatedSeconds, language: input.language,
    creditVersion: input.creditVersion, credit,
  });
  if (!selection) throw new Error('no available transcription vendor');
  const row = input.prices.find((price) => price.entry === selection.serving)!;
  const reservedMicro = await reserveTranscriptionCredit(t, { scopeId: input.scopeId,
    reservationId: input.reservationId, entry: selection.serving, microPerMinute: row.microPerMinute,
    estimatedSeconds: input.estimatedSeconds, creditVersion: input.creditVersion, at: input.at });
  const admission = { selection, reservationId: input.reservationId, reservedMicro };
  const saved = (await get<Reservation>(t, input.scopeId, key('reservation', input.reservationId)))!;
  await put(t, input.scopeId, key('reservation', input.reservationId), { ...saved, admission });
  await put(t, input.scopeId, key('admission', input.reservationId), admissionHash);
  return admission;
}

/**
 * Claim one admission hold for exactly one socket; a second socket must reserve its own actual entry.
 *
 * @throws {Error} For an unknown or closed reservation, another entry, or a reservation or connection already bound
 *   elsewhere (`invalid connection binding`).
 */
export async function bindTranscriptionConnection(t: CreditTransaction, input: {
  scopeId: string; reservationId: string; connectionId: string; entry: string; at: number;
}): Promise<void> {
  await lock(t, input.scopeId, input.at); identity(input.connectionId);
  const r = await get<Reservation>(t, input.scopeId, key('reservation', input.reservationId));
  const used = await get<string>(t, input.scopeId, key('connection', input.connectionId));
  if (!r || r.final || r.entry !== input.entry || (r.connectionId && r.connectionId !== input.connectionId)
    || (used && used !== input.reservationId)) throw new Error('invalid connection binding');
  await put(t, input.scopeId, key('connection', input.connectionId), input.reservationId);
  await put(t, input.scopeId, key('reservation', input.reservationId), { ...r, connectionId: input.connectionId });
}

/**
 * Allocate a cumulative report once and keep its exact interval receipt. Smaller totals, altered retries,
 * or usage after final are errors. A new report id with an identical nonfinal total creates a zero interval.
 * Credit freshness is required for every allocation; already committed receipts remain immutable.
 * A final report must come from the authenticated provider lifecycle or the host's positively fenced recovery.
 *
 * @returns This interval's receipt; a retry of the same report answers the stored receipt.
 * @throws {Error} For an unknown or unbound reservation (`invalid transcription reservation`), an altered retry
 *   (`report conflict`), a report after final (`closed`), a smaller total (`monotone`) or a reused supplier request.
 */
export async function settleTranscriptionInterval(t: CreditTransaction, input: TranscriptionIntervalInput): Promise<TranscriptionIntervalAllocation> {
  await lock(t, input.scopeId, input.at); identity(input.reportId);
  const r = await get<Reservation>(t, input.scopeId, key('reservation', input.reservationId));
  if (!r || !r.connectionId || r.connectionId !== input.connectionId || r.entry !== input.entry) {
    throw new Error('invalid transcription reservation');
  }
  if (!Number.isFinite(input.audioSeconds) || input.audioSeconds < 0) throw new RangeError('invalid measured seconds');
  const fingerprint = hash([input.reservationId, input.connectionId, input.entry, input.audioSeconds, input.final, input.supplierRequestId ?? null]);
  const saved = await get<SavedReport>(t, input.scopeId, key('report', input.reportId));
  if (saved) {
    if (saved.hash !== fingerprint) throw new Error('report conflict');
    return saved.allocation;
  }
  if (r.final) throw new Error('transcription reservation is closed');
  if (input.audioSeconds < r.seconds) throw new Error('usage must be monotone');
  const total = minutesMicro(input.audioSeconds, r.microPerMinute); whole(total);
  const delta = total - r.grossMicro;
  const c = await control(t, input.scopeId);
  const state = r.creditVersion ? await funding(t, input.scopeId, r.creditVersion) : undefined;
  const hold = await t.getHold(r.holdId);
  if (!hold || hold.kind !== 'supplier_transcription' || hold.state !== 'held') throw new Error('invalid supplier hold');
  const allocations = await t.listAllocations(r.holdId);
  if (allocations.length > 1) throw new Error('unexpected supplier allocation count');
  const a = allocations[0];
  let prepaid = 0;
  if (a) {
    const lot = await t.getLot(a.lotId);
    if (!lot) throw new Error('missing supplier lot');
    const held = a.amountMicro - a.consumedMicro;
    const otherHolds = lot.heldMicro - held;
    if (state && c.active === r.creditVersion && fresh(state, input.at)) {
      prepaid = Math.min(delta, held, Math.max(0, remaining(state) - otherHolds));
    }
    const release = input.final ? held - prepaid : 0;
    await t.putLot({ ...lot, heldMicro: lot.heldMicro - prepaid - release,
      consumedMicro: lot.consumedMicro + prepaid, version: lot.version + 1 });
    await t.putAllocation({ ...a, consumedMicro: a.consumedMicro + prepaid,
      releasedMicro: a.releasedMicro + release, settled: input.final });
  }
  const requestId = input.supplierRequestId ?? r.supplierRequestId;
  if (requestId !== undefined) {
    identity(requestId);
    if (parseSttEntry(r.entry).vendor !== 'deepgram'
      || (r.supplierRequestId && r.supplierRequestId !== requestId)) throw new Error('supplier request binding conflict');
  }
  if (state) {
    const localMicro = state.localMicro + delta; whole(localMicro);
    const localRequests = { ...state.localRequests };
    if (requestId) {
      const old = localRequests[requestId];
      if (old && (old.reservationId !== r.id || old.reconciled)) throw new Error('supplier request reused');
      localRequests[requestId] = { reservationId: r.id, grossMicro: total, final: input.final, reconciled: false };
    }
    await put(t, input.scopeId, key('funding', state.record.version), { ...state, localMicro, localRequests });
  }
  const allocation: TranscriptionIntervalAllocation = { reportId: input.reportId, connectionId: input.connectionId,
    entry: input.entry, fromSeconds: r.seconds, toSeconds: input.audioSeconds,
    grossMicro: delta, prepaidMicro: prepaid, chargedMicro: delta - prepaid,
    creditVersion: prepaid > 0 ? r.creditVersion : null, final: input.final };
  await t.putHold({ ...hold, chargedMicro: r.prepaidMicro + prepaid,
    state: input.final ? (r.prepaidMicro + prepaid > 0 ? 'settled' : 'released') : 'held',
    settledAt: input.final ? input.at : null, version: hold.version + 1 });
  await put(t, input.scopeId, key('reservation', r.id), { ...r, seconds: input.audioSeconds,
    grossMicro: total, prepaidMicro: r.prepaidMicro + prepaid, final: input.final,
    ...(requestId === undefined ? {} : { supplierRequestId: requestId }) });
  const estimate = minutesMicro(r.estimatedSeconds, r.microPerMinute);
  const oldOutstanding = Math.max(0, estimate - r.grossMicro);
  const newOutstanding = input.final ? 0 : Math.max(0, estimate - total);
  await put(t, input.scopeId, 'control', { ...c, open: c.open - (input.final ? 1 : 0),
    outstandingDeepgramMicro: c.outstandingDeepgramMicro
      + (parseSttEntry(r.entry).vendor === 'deepgram' ? newOutstanding - oldOutstanding : 0) });
  await put(t, input.scopeId, key('report', input.reportId), { hash: fingerprint, allocation } satisfies SavedReport);
  await append(t, input.scopeId, `stt-report:${hash([input.scopeId, input.reportId])}`,
    input.final && prepaid === 0 ? 'hold_released' : 'hold_settled', prepaid, r.holdId, input.at);
  return allocation;
}
