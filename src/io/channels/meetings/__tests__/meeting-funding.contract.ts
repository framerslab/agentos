import { describe, expect, it } from 'vitest';
import { CompositeMeetingEntitlement, type MeetingBlockEntitlement } from '../CompositeMeetingEntitlement.js';
import { DEFAULT_RUN_LIMITS, contentFreeRun, type MeetingFundingSnapshot, type MeetingRunRecord } from '../types.js';
import type { IRunStore, ReserveResult } from '../stores/types.js';
import type { ICompoundCreditStore } from '../../../../safety/runtime/CompoundCreditStore.js';
import { grantCreditLot } from '../../../../safety/runtime/CompoundCreditLedger.js';
import { quoteCompoundLiability, type RateSnapshot } from '../../../../safety/runtime/CreditRates.js';

/** Fixed neutral test tariff, not a published price. */
export const fundingTestRates: RateSnapshot = { version: 'tariff-1', currency: 'USD', reasoningInOutput: false,
  components: { media: { customer: { unit: 'second', micro: 5, per: 1 }, supplier: { unit: 'second', micro: 2, per: 1 } } } };
/** A pending record with the funding snapshot already durable before reservation. */
export function fundedRun(runId: string, mode: 'bot_blocks' | 'developer_credit' = 'developer_credit'): MeetingRunRecord {
  const base = { accountRef: 'account', policyVersion: 'tariff-1', reservationRef: `meeting-funding:${runId}`, maxSeconds: 600, expiresAt: 2_000_000 };
  const quote = quoteCompoundLiability({ rates: fundingTestRates, mediaComponent: 'media', durationSeconds: 600, attempts: { maxAttempts: 0, perAttempt: {} } });
  const funding: MeetingFundingSnapshot = mode === 'developer_credit'
    ? { ...base, fundingMode: mode, rates: fundingTestRates, mediaComponent: 'media', maxLiability: { customerMicro: quote.customerMicro, supplierMicro: quote.supplierMicro } }
    : { ...base, fundingMode: mode, blockSeconds: 600, maxLiability: { blocks: 1 } };
  return { runId, ownerRef: 'account', providerName: 'mock', platform: 'google_meet', state: 'requested', keep: 'none',
    meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Example notes', notice: { text: 'Notice', version: '1', lateArrivalText: 'Notice' },
    stopPhrase: 'stop notes', limits: { ...DEFAULT_RUN_LIMITS, totalMs: 600_000 }, requestedAt: 1_000_000, joinAt: 1_000_000,
    billedSeconds: 0, idempotencyKey: runId, creationPending: true, creationContext: 'sealed-preparation', funding };
}
/** A version-bound block adapter with an observable allocation and replay-safe settlement. */
export class TestMeetingBlocks implements MeetingBlockEntitlement {
  readonly holds = new Map<string, ReserveResult>();
  readonly settlements = new Map<string, number>();
  readonly releases = new Set<string>();
  allowed = true;
  async findByRun(runId: string): Promise<ReserveResult | undefined> { return this.holds.get(runId); }
  async reserveOnce(input: Parameters<MeetingBlockEntitlement['reserveOnce']>[0]): Promise<ReserveResult> {
    const existing = this.holds.get(input.runId); if (existing) return existing;
    const held: ReserveResult = { ok: true, reservationId: `block:${input.runId}`, maxSeconds: input.maxSeconds };
    this.holds.set(input.runId, held); return held;
  }
  async reserve(input: Parameters<MeetingBlockEntitlement['reserve']>[0]): Promise<ReserveResult> { return this.reserveOnce(input); }
  async revalidate(): Promise<boolean> { return this.allowed; }
  async revalidateAllowance(): Promise<{ ok: true; maxSeconds: number } | { ok: false }> { return this.allowed ? { ok: true, maxSeconds: 600 } : { ok: false }; }
  async meter(): Promise<void> {}
  async settle(id: string, seconds: number): Promise<void> { if (!this.settlements.has(id)) this.settlements.set(id, seconds); }
  async release(id: string): Promise<void> { this.releases.add(id); }
}
/** Both durable stores and their second client; teardown only drops this fixture's tables. */
export interface FundingFixture {
  runs: IRunStore;
  peerRuns: IRunStore;
  credit: ICompoundCreditStore;
  peerCredit: ICompoundCreditStore;
  close(): Promise<void>;
}
/** Exercises the same funding races against memory and real PostgreSQL clients. */
export function meetingFundingContract(name: string, open: () => Promise<FundingFixture>): void {
  describe(name, () => {
    it('pages pending cleanup without returning completed history across clients', async () => {
      const h = await open();
      try {
        for (let index = 0; index < 67; index++) {
          const run = fundedRun(`pending-${String(index).padStart(3, '0')}`);
          run.state = 'left'; run.fundingCleanup = { unbilled: true, complete: false }; await h.runs.insert(run);
        }
        const historical = fundedRun('completed'); historical.state = 'done';
        historical.fundingCleanup = { unbilled: true, complete: true };
        historical.fundingSettlement = { connectedMs: 0, billedSeconds: 0, unbilled: true }; await h.runs.insert(historical);
        if (!h.peerRuns.listFundingPending) throw new Error('bounded recovery unavailable');
        const first = await h.peerRuns.listFundingPending(64); expect(first).toHaveLength(64);
        expect(first.every((run) => run.runId.startsWith('pending-'))).toBe(true);
        const second = await h.peerRuns.listFundingPending(64, first[63].runId);
        expect(second.map((run) => run.runId)).toEqual(['pending-064', 'pending-065', 'pending-066']);
        await expect(h.peerRuns.listFundingPending(65)).rejects.toThrow('funding scan bound');
        await expect(h.peerRuns.update('completed', { fundingCleanup: { unbilled: true, complete: false } })).rejects.toThrow('immutable funding cleanup');
      } finally { await h.close(); }
    });
    it('keeps the snapshot across restart and content removal and refuses every rewrite path', async () => {
      const h = await open();
      try {
        const run = fundedRun('immutable'); await h.runs.insert(run);
        expect((await h.peerRuns.get(run.runId))?.funding).toEqual(run.funding);
        await expect(h.peerRuns.update(run.runId, { funding: fundedRun('immutable', 'bot_blocks').funding })).rejects.toThrow('immutable funding');
        await expect(h.peerRuns.update(run.runId, { funding: undefined })).rejects.toThrow('immutable funding');
        await expect(h.peerRuns.replace({ ...run, funding: undefined })).rejects.toThrow('immutable funding');
        await expect(h.peerRuns.update(run.runId, { ownerRef: 'another' })).rejects.toThrow('immutable funding');
        const free = contentFreeRun(run); await h.runs.replace(free);
        expect((await h.peerRuns.get(run.runId))?.funding).toEqual(run.funding);
        const legacy = { ...fundedRun('legacy'), funding: undefined }; await h.runs.insert(legacy);
        await expect(h.peerRuns.update('legacy', { funding: fundedRun('legacy').funding })).rejects.toThrow('immutable funding');
      } finally { await h.close(); }
    });

    it('races one cash hold, defers without positive fences, then charges once after restart', async () => {
      const h = await open();
      try {
        await grantCreditLot(h.credit, { scopeId: 'account', kind: 'paid', fundingRef: 'payment', principalMicro: 100_000, at: 1_000_000 });
        const run = fundedRun('cash'); await h.runs.insert(run);
        const blocks = new TestMeetingBlocks(); let fenced = false;
        const options = { runs: h.runs, credit: h.credit, now: () => 1_000_100, supplierDailyCapMicro: () => 1_000_000,
          blocks: () => blocks, check: async () => ({ ok: true as const, maxSeconds: 600 }),
          close: async () => ({ connectedMs: 40_000, fence: { mediaClosed: fenced, inferenceTerminated: fenced, evidence: fenced ? 'worker-exit-and-room-close' : 'close-pending', observedAt: 1_000_100 } }) };
        const a = new CompositeMeetingEntitlement(options);
        const b = new CompositeMeetingEntitlement({ ...options, runs: h.peerRuns, credit: h.peerCredit });
        const input = { runId: run.runId, ownerRef: run.ownerRef, platform: run.platform, maxSeconds: 600 };
        const answers = await Promise.all([a.reserveOnce(input), b.reserveOnce(input)]);
        expect(answers).toEqual([{ ok: true, reservationId: 'meeting-funding:cash', maxSeconds: 600 }, { ok: true, reservationId: 'meeting-funding:cash', maxSeconds: 600 }]);
        const holds = await h.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' }));
        expect(holds).toHaveLength(1); expect(blocks.holds.size).toBe(0);
        await h.runs.update('cash', { state: 'left', captureStartedAt: 1_000_000, leftAt: 1_040_000, reportedSeconds: 40 });
        await expect(a.settle('meeting-funding:cash', 40)).rejects.toThrow('funding cleanup pending');
        expect((await h.credit.withTransaction((tx) => tx.getHold(holds[0]!.holdId)))?.state).toBe('deferred');
        fenced = true;
        await Promise.all([b.recover('cash'), a.settle('meeting-funding:cash', 40)]);
        const hold = await h.credit.withTransaction((tx) => tx.getHold(holds[0]!.holdId));
        expect(hold).toMatchObject({ state: 'settled', chargedMicro: 200, supplierSettledMicro: 80 });
        expect((await h.peerRuns.get('cash'))?.fundingSettlement).toEqual({ connectedMs: 40_000, billedSeconds: 40, unbilled: false });
        expect((await h.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' })))).toHaveLength(1);
      } finally { await h.close(); }
    });
    it('refuses insufficient, frozen and expired cash without using blocks', async () => { const h = await open(); try { let at = 1_000_100; const blocks = new TestMeetingBlocks(); const e = new CompositeMeetingEntitlement({ runs: h.runs, credit: h.credit, now: () => at, supplierDailyCapMicro: () => 1_000_000, blocks: () => blocks, check: async () => ({ ok: true, maxSeconds: 600 }), close: async () => ({ connectedMs: 0, fence: { mediaClosed: true, inferenceTerminated: true, evidence: 'closed-before-dispatch', observedAt: at } }) }); await h.runs.insert(fundedRun('empty')); expect(await e.reserveOnce({ runId: 'empty', ownerRef: 'account', platform: 'google_meet', maxSeconds: 600 })).toMatchObject({ ok: false }); await grantCreditLot(h.credit, { scopeId: 'account', kind: 'paid', fundingRef: 'payment', principalMicro: 100_000, at }); await h.runs.insert(fundedRun('frozen')); expect(await e.reserveOnce({ runId: 'frozen', ownerRef: 'account', platform: 'google_meet', maxSeconds: 600 })).toMatchObject({ ok: true }); await h.credit.withTransaction(async (tx) => { const account = await tx.lockAccount('account'); if (!account) throw new Error('account missing'); await tx.putAccount({ ...account, frozen: true, version: account.version + 1 }); }); expect(await e.checkRun('frozen', 'heartbeat')).toEqual({ ok: false }); at = 2_000_001; expect(await e.revalidate('meeting-funding:frozen')).toBe(false); await e.release('meeting-funding:frozen'); expect(blocks.holds.size).toBe(0); expect((await h.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' })))[0]?.chargedMicro).toBe(0); } finally { await h.close(); } });
    it('keeps block funding when eligibility changes and refuses cash fallback', async () => {
      const h = await open();
      try {
        await grantCreditLot(h.credit, { scopeId: 'account', kind: 'paid', fundingRef: 'payment', principalMicro: 100_000, at: 1_000_000 });
        const run = fundedRun('blocks', 'bot_blocks'); await h.runs.insert(run);
        const blocks = new TestMeetingBlocks(); let eligible = true;
        const entitlement = new CompositeMeetingEntitlement({ runs: h.runs, credit: h.credit, now: () => 1_000_100,
          supplierDailyCapMicro: () => 1_000_000, blocks: (snapshot) => { expect(snapshot.policyVersion).toBe('tariff-1'); return blocks; },
          check: async () => eligible ? { ok: true, maxSeconds: 600 } : { ok: false },
          close: async () => ({ connectedMs: 0, fence: { mediaClosed: true, inferenceTerminated: true, evidence: 'no-dispatch-fenced', observedAt: 1_000_100 } }) });
        expect(await entitlement.reserveOnce({ runId: 'blocks', ownerRef: 'account', platform: 'google_meet', maxSeconds: 600 })).toMatchObject({ ok: true });
        eligible = false;
        expect(await entitlement.checkRun('blocks', 'dispatch')).toEqual({ ok: false });
        await entitlement.release('meeting-funding:blocks');
        expect(blocks.releases).toEqual(new Set(['block:blocks']));
        expect(await h.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' }))).toEqual([]);
      } finally { await h.close(); }
    });

    it('finds a committed hold when its response and run link were lost', async () => {
      const h = await open();
      try {
        await grantCreditLot(h.credit, { scopeId: 'account', kind: 'paid', fundingRef: 'payment', principalMicro: 100_000, at: 1_000_000 });
        await h.runs.insert(fundedRun('lost'));
        let fail = true; const update = h.runs.update.bind(h.runs);
        const failing: IRunStore = { insert: (r) => h.runs.insert(r), get: (id) => h.runs.get(id), replace: (r) => h.runs.replace(r), list: (f) => h.runs.list(f), findByIdempotencyKey: (o, k) => h.runs.findByIdempotencyKey(o, k),
          update: async (id, patch, state) => { if (patch.fundingReservationId && fail) { fail = false; throw new Error('response lost'); } return update(id, patch, state); } };
        const options = { runs: failing, credit: h.credit, now: () => 1_000_100, supplierDailyCapMicro: () => 1_000_000,
          blocks: () => new TestMeetingBlocks(), check: async () => ({ ok: true as const, maxSeconds: 600 }),
          close: async () => ({ connectedMs: 0, fence: { mediaClosed: true, inferenceTerminated: true, evidence: 'no-dispatch-fenced', observedAt: 1_000_100 } }) };
        const first = new CompositeMeetingEntitlement(options);
        const input = { runId: 'lost', ownerRef: 'account', platform: 'google_meet' as const, maxSeconds: 600 };
        await expect(first.reserveOnce(input)).rejects.toThrow('response lost');
        const recovered = new CompositeMeetingEntitlement({ ...options, runs: h.peerRuns, credit: h.peerCredit });
        expect(await recovered.reserveOnce(input)).toMatchObject({ ok: true, reservationId: 'meeting-funding:lost' });
        await recovered.release('meeting-funding:lost');
        const holds = await h.credit.withTransaction((tx) => tx.listHolds({ scopeId: 'account' }));
        expect(holds).toHaveLength(1); expect(holds[0]).toMatchObject({ chargedMicro: 0, supplierSettledMicro: 0 });
      } finally { await h.close(); }
    });
  });
}
