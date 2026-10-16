import { createHash } from 'node:crypto';
import { creditDay, type ICompoundCreditStore } from '../../../safety/runtime/CompoundCreditStore.js';
import { reserveCompoundCredit, settleCompoundCredit, type CallFence } from '../../../safety/runtime/CompoundCreditLedger.js';
import { assertMeetingFundingChange, meetingFundingIdentity, type MeetingFundingPhase, type MeetingFundingSnapshot, type MeetingRunRecord } from './types.js';
import type { DispatchAllowance, IEntitlementHook, IRunStore, ReserveResult } from './stores/types.js';

/** Existing block entitlement bound by the host to one immutable block policy version. */
export interface MeetingBlockEntitlement extends IEntitlementHook {
  /** Returns the same allocation by run id even after a response is lost. */
  reserveOnce(input: { ownerRef: string; runId: string; platform: MeetingRunRecord['platform']; maxSeconds: number }): Promise<ReserveResult>;
  /** Read-only recovery; never allocates and never falls through to another funding source. */
  findByRun(runId: string): Promise<ReserveResult | undefined>;
}
/** Host checks authority and capacity, while this class owns branch selection and ledger mechanics. */
export interface CompositeMeetingEntitlementOptions {
  /** The manager's run store, where each run's snapshot, reservation link and settlement intent are persisted. */
  runs: IRunStore;
  /** The compound credit store a cash-funded run's hold is reserved and settled in. */
  credit: ICompoundCreditStore;
  /** The current time, in milliseconds: a whole number, zero or more. */
  now(): number;
  /** Current platform-wide cap, passed unchanged to the compound ledger and checked at admission. */
  supplierDailyCapMicro(): number;
  /** Resolves the original block policy, not the current subscription's preferred source. */
  blocks(snapshot: Extract<MeetingFundingSnapshot, { fundingMode: 'bot_blocks' }>): MeetingBlockEntitlement;
  /**
   * Checks active account/scope, caller permission, original tariff eligibility and supplier capacity. Handed a copy
   * of the run as the store holds it when asked: an allocation link this class has just recovered is on it.
   */
  check(run: MeetingRunRecord, phase: MeetingFundingPhase): Promise<DispatchAllowance>;
  /**
   * Idempotently prevents dispatch/re-dispatch, closes media and inference, and supplies final metered
   * media duration. A never-dispatched run still needs a positive dispatch fence under the owner lock.
   * A kill request, terminal state, elapsed lease or missing worker is not positive evidence.
   * Return false fence flags while termination or final usage remains unknown. Handed a copy of the run as `check` is.
   */
  close(run: MeetingRunRecord): Promise<{ connectedMs: number; fence: CallFence }>;
}

const denied = (): ReserveResult => ({ ok: false, reason: 'allowance', message: 'meeting funding unavailable' });
const seconds = (value: number): number => { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid meeting seconds'); return value; };
const inputFor = (run: MeetingRunRecord) => ({ ownerRef: run.ownerRef, runId: run.runId, platform: run.platform, maxSeconds: run.funding!.maxSeconds });
const requestHash = (snapshot: MeetingFundingSnapshot): string => createHash('sha256').update(meetingFundingIdentity(snapshot)).digest('hex');

/** Chooses one durable funding branch for every lifecycle operation, with no cross-funding fallback. */
export class CompositeMeetingEntitlement implements IEntitlementHook {
  /** Stores are shared with the manager; the caller supplies policy and positive teardown evidence. */
  constructor(private readonly options: CompositeMeetingEntitlementOptions) {}
  private at(): number {
    const at = this.options.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid funding clock');
    return at;
  }
  private cap(): number {
    const cap = this.options.supplierDailyCapMicro();
    if (!Number.isSafeInteger(cap) || cap < 0) throw new Error('invalid supplier cap');
    return cap;
  }
  private async run(runId: string): Promise<MeetingRunRecord & { funding: MeetingFundingSnapshot }> {
    const run = await this.options.runs.get(runId);
    if (!run?.funding) throw new Error('durable funding snapshot required');
    assertMeetingFundingChange(undefined, run);
    return run as MeetingRunRecord & { funding: MeetingFundingSnapshot };
  }
  private async byReference(reference: string): Promise<MeetingRunRecord & { funding: MeetingFundingSnapshot }> {
    if (!reference.startsWith('meeting-funding:')) throw new Error('invalid funding reference');
    const run = await this.run(reference.slice('meeting-funding:'.length));
    if (run.funding.reservationRef !== reference) throw new Error('funding reference mismatch');
    return run;
  }
  private async link(runId: string, backend: string): Promise<void> {
    const updated = await this.options.runs.update(runId, { fundingReservationId: backend });
    if (!updated) throw new Error('funding run missing');
  }
  private async backend(run: MeetingRunRecord & { funding: MeetingFundingSnapshot }): Promise<string | undefined> {
    const snapshot = run.funding;
    let backend: string | undefined;
    if (snapshot.fundingMode === 'bot_blocks') {
      const found = await this.options.blocks(snapshot).findByRun(run.runId);
      if (found?.ok) backend = found.reservationId;
    } else {
      const hold = await this.options.credit.withTransaction(async (tx) => {
        await tx.lockAccount(snapshot.accountRef);
        return tx.findHoldByOperation(snapshot.accountRef, run.runId);
      });
      if (hold && (hold.requestHash !== requestHash(snapshot) || hold.kind !== 'meeting_run')) throw new Error('funding hold conflict');
      backend = hold?.holdId;
    }
    if (run.fundingReservationId !== undefined && backend !== run.fundingReservationId) throw new Error('funding allocation missing or changed');
    if (backend !== undefined && run.fundingReservationId === undefined) {
      await this.link(run.runId, backend);
      // a caller may hand this run to the host's check or close next: it carries the link the store now holds
      run.fundingReservationId = backend;
    }
    return backend;
  }
  /** The legacy method is supported only for an already persisted, snapshotted run. */
  async reserve(input: { ownerRef: string; runId: string; platform: MeetingRunRecord['platform']; maxSeconds: number }): Promise<ReserveResult> {
    return this.reserveOnce(input);
  }
  /** Resumes the same allocation after every interruption; an ineligible run releases only its own branch. */
  async reserveOnce(input: { ownerRef: string; runId: string; platform: MeetingRunRecord['platform']; maxSeconds: number }): Promise<ReserveResult> {
    const run = await this.run(input.runId); const snapshot = run.funding;
    if (input.ownerRef !== run.ownerRef || input.platform !== run.platform || seconds(input.maxSeconds) > snapshot.maxSeconds) throw new Error('funding request mismatch');
    if (run.fundingSettlement || !['requested', 'scheduled'].includes(run.state)) return denied();
    let backend = await this.backend(run);
    const allowance = await this.options.check(structuredClone(run), 'reserve');
    if (!allowance.ok || !Number.isSafeInteger(allowance.maxSeconds) || allowance.maxSeconds <= 0 || this.at() >= snapshot.expiresAt) {
      if (backend) await this.release(snapshot.reservationRef);
      return denied();
    }
    let blockMax = snapshot.maxSeconds;
    if (!backend) {
      if (snapshot.fundingMode === 'bot_blocks') {
        const held = await this.options.blocks(snapshot).reserveOnce(inputFor(run));
        if (!held.ok) return held;
        backend = held.reservationId; blockMax = seconds(held.maxSeconds);
      } else {
        const held = await reserveCompoundCredit(this.options.credit, { scopeId: snapshot.accountRef, operationId: run.runId, kind: 'meeting_run', requestHash: requestHash(snapshot),
          rates: { primary: snapshot.rates }, mediaComponent: snapshot.mediaComponent, durationSeconds: snapshot.maxSeconds, attempts: { maxAttempts: 0, perAttempt: {} },
          supplierDailyCapMicro: this.cap(), at: this.at(), expiresAt: snapshot.expiresAt });
        if (held.status === 'refused') return denied();
        if (held.status === 'conflict') throw new Error('funding hold conflict');
        if (held.hold.state !== 'held') return denied();
        backend = held.hold.holdId;
      }
      await this.link(run.runId, backend);
    }
    const valid = await this.checkRun(run.runId, 'reserve');
    if (!valid.ok) { await this.release(snapshot.reservationRef); return denied(); }
    return { ok: true, reservationId: snapshot.reservationRef, maxSeconds: Math.min(input.maxSeconds, snapshot.maxSeconds, blockMax, allowance.maxSeconds, valid.maxSeconds) };
  }
  /** Checks the stored branch and allocation, including every dispatch/recovery and heartbeat. */
  async checkRun(runId: string, phase: MeetingFundingPhase): Promise<DispatchAllowance> {
    const run = await this.run(runId); const snapshot = run.funding;
    if (run.fundingSettlement || this.at() >= snapshot.expiresAt || ['done', 'failed', 'left', 'leaving', 'purging'].includes(run.state)) return { ok: false };
    const policy = await this.options.check(structuredClone(run), phase);
    if (!policy.ok || !Number.isSafeInteger(policy.maxSeconds) || policy.maxSeconds <= 0) return { ok: false };
    const backend = await this.backend(run);
    if (!backend) return { ok: false };
    let maxSeconds = Math.min(snapshot.maxSeconds, policy.maxSeconds);
    if (snapshot.fundingMode === 'bot_blocks') {
      const blocks = this.options.blocks(snapshot);
      const original = await blocks.findByRun(run.runId);
      if (!original?.ok || !Number.isSafeInteger(original.maxSeconds) || original.maxSeconds <= 0) return { ok: false };
      maxSeconds = Math.min(maxSeconds, original.maxSeconds);
      if (blocks.revalidateAllowance) {
        const valid = await blocks.revalidateAllowance(backend);
        if (!valid.ok || !Number.isSafeInteger(valid.maxSeconds) || valid.maxSeconds <= 0) return { ok: false };
        maxSeconds = Math.min(maxSeconds, valid.maxSeconds);
      } else if (!(await blocks.revalidate(backend))) return { ok: false };
    } else {
      const valid = await this.options.credit.withTransaction(async (tx) => {
        const account = await tx.lockAccount(snapshot.accountRef);
        const hold = await tx.getHold(backend);
        if (!account || account.frozen || !hold || hold.scopeId !== snapshot.accountRef || hold.operationId !== run.runId || hold.state !== 'held' || hold.expiresAt <= this.at() || hold.requestHash !== requestHash(snapshot)) return false;
        const day = await tx.lockSupplierDay(creditDay(this.at()));
        return day.settledMicro + await tx.openSupplierMicro() <= this.cap();
      });
      if (!valid) return { ok: false };
    }
    return { ok: true, maxSeconds };
  }
  /** Compatible boolean revalidation for existing manager extension points. */
  async revalidate(reference: string): Promise<boolean> { return (await this.revalidateAllowance(reference)).ok; }
  /** Revalidates without increasing the original duration or changing its funding source. */
  async revalidateAllowance(reference: string): Promise<DispatchAllowance> {
    const run = await this.byReference(reference); return this.checkRun(run.runId, 'revalidate');
  }
  /** Block usage keeps its existing meter; cash is settled from final measured media by the ledger. */
  async meter(reference: string, cumulativeSeconds: number): Promise<void> {
    seconds(cumulativeSeconds); const run = await this.byReference(reference);
    if (cumulativeSeconds > run.funding.maxSeconds || cumulativeSeconds < (run.reportedSeconds ?? 0)) throw new Error('meeting funding usage refused');
    const finalizing = ['leaving', 'left', 'purging'].includes(run.state) && !run.fundingCleanup?.complete;
    if (!finalizing && !(await this.checkRun(run.runId, 'heartbeat')).ok) throw new Error('meeting funding unavailable');
    const backend = await this.backend(run);
    if (!backend) throw new Error('funding allocation missing');
    if (run.funding.fundingMode === 'bot_blocks') await this.options.blocks(run.funding).meter(backend, cumulativeSeconds);
    const updated = await this.options.runs.update(run.runId, { reportedSeconds: cumulativeSeconds });
    if (!updated) throw new Error('funding run missing');
  }
  private async finish(runId: string, unbilled: boolean): Promise<void> {
    let run = await this.run(runId);
    if (run.fundingCleanup?.complete) return;
    if (!run.fundingCleanup) {
      const next = await this.options.runs.update(runId, { fundingCleanup: { unbilled, complete: false } });
      if (!next) throw new Error('funding run missing');
      run = await this.run(runId);
    }
    const backend = await this.backend(run);
    const closed = await this.options.close(structuredClone(run));
    if (!Number.isSafeInteger(closed.connectedMs) || closed.connectedMs < 0 || !closed.fence.evidence || !Number.isSafeInteger(closed.fence.observedAt) || closed.fence.observedAt < run.requestedAt || closed.fence.observedAt > this.at()) throw new Error('invalid funding close evidence');
    if (!closed.fence.mediaClosed || !closed.fence.inferenceTerminated) {
      if (backend && run.funding.fundingMode === 'developer_credit') await settleCompoundCredit(this.options.credit, { holdId: backend, connectedMs: closed.connectedMs, fence: closed.fence, at: this.at(), unbilled: run.fundingCleanup!.unbilled });
      throw new Error('funding cleanup pending');
    }
    const finalSeconds = Math.ceil(closed.connectedMs / 1000);
    if (!Number.isSafeInteger(finalSeconds) || finalSeconds > run.funding.maxSeconds) throw new Error('funding duration bound');
    if (!run.fundingSettlement) {
      await this.options.runs.update(runId, { fundingSettlement: { connectedMs: closed.connectedMs, billedSeconds: run.fundingCleanup!.unbilled ? 0 : finalSeconds, unbilled: run.fundingCleanup!.unbilled } });
      run = await this.run(runId);
    }
    const intent = run.fundingSettlement!;
    if (intent.connectedMs !== closed.connectedMs) throw new Error('conflicting funding close quantity');
    if (!backend) {
      if (run.fundingReservationId !== undefined) throw new Error('funding allocation missing');
      if (!closed.fence.mediaClosed || !closed.fence.inferenceTerminated || closed.connectedMs !== 0) throw new Error('funding cleanup pending');
      await this.options.runs.update(runId, { fundingCleanup: { unbilled: intent.unbilled, complete: true } });
      return;
    }
    if (run.funding.fundingMode === 'bot_blocks') {
      if (!closed.fence.mediaClosed || !closed.fence.inferenceTerminated) throw new Error('funding cleanup pending');
      const blocks = this.options.blocks(run.funding);
      if (intent.unbilled) await blocks.release(backend); else await blocks.settle(backend, intent.billedSeconds);
    } else {
      const settled = await settleCompoundCredit(this.options.credit, { holdId: backend, connectedMs: closed.connectedMs, fence: closed.fence, at: this.at(), unbilled: intent.unbilled });
      if (settled.status === 'deferred') throw new Error('funding cleanup pending');
      if (settled.status === 'not_found') throw new Error('funding allocation missing');
    }
    await this.options.runs.update(runId, { fundingCleanup: { unbilled: intent.unbilled, complete: true } });
  }
  /** Records the billed terminal decision once, then settles under positive close evidence. */
  async settle(reference: string, billedSeconds: number): Promise<void> { seconds(billedSeconds); await this.finalize(reference, { unbilled: billedSeconds === 0 }); }
  /** Derives quantity exclusively from acknowledged close evidence under the supplied billing decision. */
  async finalize(reference: string, decision: { unbilled: boolean }): Promise<void> { const run = await this.byReference(reference); await this.finish(run.runId, decision.unbilled); }
  /** Customer-free settlement still accounts for actual supplier use and requires positive fencing. */
  async release(reference: string): Promise<void> { await this.finalize(reference, { unbilled: true }); }
  /** Restarts only an existing terminal intent; active runs are checked by the manager's recovery pass. */
  async recover(runId: string): Promise<void> { const run = await this.run(runId); if (run.fundingCleanup && !run.fundingCleanup.complete) await this.finish(runId, run.fundingCleanup.unbilled); }
  /** Redacts dependencies and account state from generic serialization. */
  toJSON(): string { return '[CompositeMeetingEntitlement]'; }
}
