import { voiceInteger, voiceKey, type VoiceRow, type VoiceSlotLease, type VoiceStore, type VoiceTransaction } from './stores/types.js';

/** Capacity from a host-verified bench snapshot; absence means zero public admission. */
export interface SlotCapacity { version: string; validUntil: number; scopeSlots: number; hostSlots: number }
/** Admission binds a logical call, a physical host and a lease owner. */
export interface SlotRequest {
  scopeId: string; callId: string; hostId: string; holder: string; ttlMs: number; capacity?: SlotCapacity;
}
/** A generation-bearing handle; every renewal and release compares all its identity fields. */
export interface SlotLeaseHandle extends VoiceSlotLease { scopeId: string; leaseId: string }
/** Refusal never creates a queue or partially occupies one limit. */
export type SlotAdmission = { ok: true; lease: SlotLeaseHandle } | { ok: false; reason: 'capacity_unavailable' | 'scope_limit' | 'host_limit' | 'call_in_flight'; retryable: true; retryAfterMs: number };
/** Trusted host evidence; expiry and a lost control connection cannot set stopped to true. */
export interface SlotReleaseEvidence { generation: number; stopped: boolean; evidenceRef: string }
/** Clock and transactional store, with no product capacity defaults. */
export interface SlotLimiterOptions { store: VoiceStore; now: () => number }
/** Bounded, abortable initialization with mandatory stop evidence on failure. */
export interface SlotInitialization<T> {
  timeoutMs: number; signal?: AbortSignal;
  initialize(lease: SlotLeaseHandle, signal: AbortSignal): Promise<T>;
  fence(lease: SlotLeaseHandle): Promise<SlotReleaseEvidence>;
}
function handle(row: VoiceRow<VoiceSlotLease>): SlotLeaseHandle { return { ...row.value, scopeId: row.scopeId, leaseId: row.id }; }
function same(row: VoiceRow<VoiceSlotLease> | undefined, lease: SlotLeaseHandle): row is VoiceRow<VoiceSlotLease> {
  return !!row && row.scopeId === lease.scopeId && row.id === lease.leaseId && row.value.callId === lease.callId && row.value.hostId === lease.hostId && row.value.holder === lease.holder && row.value.generation === lease.generation && !row.value.released;
}
/** Atomic scope/host slot leases over either supplied VoiceStore implementation. */
export class SlotLimiter {
  constructor(private readonly options: SlotLimiterOptions) {}
  private denied(reason: Extract<SlotAdmission, { ok: false }>['reason']): SlotAdmission { return { ok: false, reason, retryable: true, retryAfterMs: 1000 }; }
  /** Counts unreleased leases under both anchors; expired work remains occupied until fenced. */
  async acquire(request: SlotRequest): Promise<SlotAdmission> {
    const now = voiceInteger(this.options.now()); voiceInteger(request.ttlMs, 1);
    if (![request.scopeId, request.callId, request.hostId, request.holder].every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) throw new Error('invalid slot identity');
    const cap = request.capacity;
    if (!cap) return this.denied('capacity_unavailable');
    voiceInteger(cap.scopeSlots); voiceInteger(cap.hostSlots); voiceInteger(cap.validUntil);
    if (!cap.version || cap.validUntil <= now || cap.scopeSlots === 0 || cap.hostSlots === 0) return this.denied('capacity_unavailable');
    return this.options.store.withTransaction(request.scopeId, async (tx) => {
      const host = await tx.lockHost(request.hostId); const scope = await tx.list('slots');
      const own = scope.filter((r) => r.value.callId === request.callId);
      const active = own.find((r) => !r.value.released);
      if (active) {
        if (active.value.hostId === request.hostId && active.value.holder === request.holder && active.value.expiresAt > now) return { ok: true, lease: handle(active) };
        return this.denied('call_in_flight');
      }
      if (scope.filter((r) => !r.value.released).length >= cap.scopeSlots) return this.denied('scope_limit');
      if (host.filter((r) => !r.value.released).length >= cap.hostSlots) return this.denied('host_limit');
      const id = voiceKey(request.callId, request.hostId); const previous = scope.find((r) => r.id === id);
      const generation = voiceInteger(Math.max(0, ...own.map((r) => r.value.generation)) + 1, 1);
      const value: VoiceSlotLease = { callId: request.callId, hostId: request.hostId, holder: request.holder, generation, expiresAt: voiceInteger(now + request.ttlMs), released: false };
      await tx.put('slots', id, value, previous?.version ?? 0);
      return { ok: true, lease: { ...value, scopeId: request.scopeId, leaseId: id } };
    });
  }
  private async locked(tx: VoiceTransaction, lease: SlotLeaseHandle): Promise<VoiceRow<VoiceSlotLease> | undefined> {
    await tx.lockHost(lease.hostId); return tx.get('slots', lease.leaseId);
  }
  /** Expired or replaced generations cannot renew; a successful renewal extends monotonically. */
  async renew(lease: SlotLeaseHandle, ttlMs: number): Promise<SlotLeaseHandle | undefined> {
    voiceInteger(ttlMs, 1); const now = voiceInteger(this.options.now());
    return this.options.store.withTransaction(lease.scopeId, async (tx) => {
      const row = await this.locked(tx, lease);
      if (!same(row, lease) || row.value.expiresAt <= now) return undefined;
      row.value.expiresAt = Math.max(row.value.expiresAt, voiceInteger(now + ttlMs));
      await tx.put('slots', row.id, row.value, row.version); return handle(row);
    });
  }
  /** One row releases both shares, only after this exact generation is known stopped. */
  async release(lease: SlotLeaseHandle, evidence: SlotReleaseEvidence): Promise<boolean> {
    if (!evidence.stopped || !evidence.evidenceRef || evidence.generation !== lease.generation) return false;
    return this.options.store.withTransaction(lease.scopeId, async (tx) => {
      const row = await this.locked(tx, lease); if (!same(row, lease)) return false;
      await tx.put('slots', row.id, { ...row.value, released: true }, row.version); return true;
    });
  }
  /** A bounded initialization owns its lease until success, or fenced release after cancellation/failure. */
  async initialize<T>(request: SlotRequest, options: SlotInitialization<T>): Promise<{ lease: SlotLeaseHandle; value: T }> {
    voiceInteger(options.timeoutMs, 1);
    if (options.signal?.aborted) throw new Error('initialization cancelled');
    const admission = await this.acquire(request);
    if (!admission.ok) throw new Error(admission.reason);
    const lease = admission.lease; const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined; let rejectAbort!: (error: Error) => void;
    const abort = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = (): void => { controller.abort(); rejectAbort(new Error('initialization cancelled')); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); rejectAbort(new Error('initialization timed out')); }, options.timeoutMs);
    try {
      if (options.signal?.aborted) cancel();
      const work = controller.signal.aborted ? abort : options.initialize(lease, controller.signal);
      const value = await Promise.race([work, abort]);
      if (controller.signal.aborted) throw new Error('initialization cancelled');
      const renewed = await this.renew(lease, request.ttlMs); if (!renewed || controller.signal.aborted) throw new Error('initialization lease expired'); return { lease: renewed, value };
    } catch (error) {
      controller.abort();
      let released = false;
      try { released = await this.release(lease, await options.fence(lease)); } catch { released = false; }
      if (!released) throw new Error('slot cleanup deferred');
      throw error;
    } finally {
      if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
    }
  }
  /** Bounded sweep. Checks external evidence outside the transaction, then fences the exact lease on release. */
  async reconcileExpired(scopeId: string, fence: (lease: SlotLeaseHandle) => Promise<SlotReleaseEvidence | undefined>, limit: number): Promise<{ released: number; pending: number }> {
    voiceInteger(limit, 1); const now = voiceInteger(this.options.now());
    const due = await this.options.store.withTransaction(scopeId, async (tx) => (await tx.list('slots')).filter((r) => !r.value.released && r.value.expiresAt <= now).sort((a, b) => a.value.expiresAt - b.value.expiresAt).slice(0, limit).map(handle));
    const result = { released: 0, pending: 0 };
    for (const lease of due) {
      try {
        const evidence = await fence(lease);
        if (evidence && await this.release(lease, evidence)) result.released++;
        else result.pending++;
      } catch { result.pending++; }
    }
    return result;
  }
  /** Redacts store and injected policy. */
  toJSON(): string { return '[SlotLimiter]'; }
}
