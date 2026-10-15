/**
 * The supplier transcription credit allocator's behaviour over the memory and PostgreSQL stores. Every amount follows
 * from synthetic rows: Deepgram at 4,800 and OpenAI at 3,000 micro-dollars a minute, a one-minute admission estimate
 * and a promotional record of the amount each case names. None of them is a verified tariff or an account reading.
 */
import { describe, expect, it } from 'vitest';
import type { ICompoundCreditStore } from '../CompoundCreditStore.js';
import { withCreditRetry } from '../CompoundCreditLedger.js';
import type { DeepgramUsageEvidence } from '../../../io/voice-pipeline/providers/DeepgramUsage.js';
import {
  makeTranscriptionCreditRecord, configureTranscriptionCredit, refreshTranscriptionCredit,
  failTranscriptionCreditCheck, transcriptionCreditSnapshot, admitLowestCostTranscription,
  reserveTranscriptionCredit, bindTranscriptionConnection, settleTranscriptionInterval,
  type TranscriptionCreditRecord,
} from '../TranscriptionCredit.js';

const at = Date.UTC(2026, 9, 14, 12);
const scopeId = 'supplier-fixture';
const dg = 'deepgram:nova-3';
const oa = 'openai:gpt-4o-mini-transcribe';
const prices = [{ entry: dg, microPerMinute: 4800 }, { entry: oa, microPerMinute: 3000 }];
const projectId = '00000000-0000-4000-8000-000000000001';
function record(amountMicro = 4800, readAtMs = at - 3600000): TranscriptionCreditRecord {
  return makeTranscriptionCreditRecord({ vendor: 'deepgram', amountMicro, readAtMs,
    projectId, contractVersion: 'synthetic-contract', validUntilMs: at + 7 * 86400000 });
}
function evidence(r: TranscriptionCreditRecord, costMicro = 0, checkedAtMs = at): DeepgramUsageEvidence {
  return { projectId, fromMs: r.readAtMs, throughMs: checkedAtMs - 120000,
    checkedAtMs, contractVersion: r.contractVersion, costMicro, requests: [] };
}

export function runTranscriptionCreditContract(name: string, make: () => Promise<ICompoundCreditStore>): void {
  describe(name, () => {
    async function fixture(amount = 4800) {
      const store = await make();
      const r = record(amount);
      await withCreditRetry(store, (t) => configureTranscriptionCredit(t, { scopeId, record: r, at }));
      const refresh = (cost = 0, time = at) => withCreditRetry(store, (t) => refreshTranscriptionCredit(t, {
        scopeId, recordVersion: r.version, evidence: evidence(r, cost, time), at: time,
      }));
      const snapshot = (time = at) => withCreditRetry(store, (t) => transcriptionCreditSnapshot(t, scopeId, r.version, time));
      const admit = (id: string, time = at) => withCreditRetry(store, (t) => admitLowestCostTranscription(t, {
        scopeId, reservationId: id, entries: [dg, oa], prices, availableVendors: ['deepgram', 'openai'],
        estimatedSeconds: 60, creditVersion: r.version, at: time,
      }));
      const bind = (id: string, entry = dg) => withCreditRetry(store, (t) => bindTranscriptionConnection(t, {
        scopeId, reservationId: id, connectionId: `connection-${id}`, entry, at,
      }));
      const settle = (id: string, seconds: number, final: boolean, time = at + 1000) =>
        withCreditRetry(store, (t) => settleTranscriptionInterval(t, {
          scopeId, reservationId: id, connectionId: `connection-${id}`, entry: dg,
          reportId: `${id}:${seconds}:${final}`, audioSeconds: seconds, final, at: time,
        }));
      return { store, r, refresh, snapshot, admit, bind, settle };
    }

    it('deducts an unchecked explicit socket before competing refreshed admissions', async () => {
      const f = await fixture(4800);
      await withCreditRetry(f.store, (t) => reserveTranscriptionCredit(t, {
        scopeId, reservationId: 'unchecked', entry: dg, microPerMinute: 4800,
        estimatedSeconds: 60, at,
      }));
      await f.bind('unchecked');
      await f.refresh();
      expect((await f.snapshot())?.reservedMicro).toBe(4800);
      const starts = await Promise.all([f.admit('a'), f.admit('b')]);
      expect(starts.map((s) => s.selection.serving)).toEqual([oa, oa]);
      await f.settle('unchecked', 30, false);
      expect((await f.snapshot())?.reservedMicro).toBe(2400);
      expect((await f.admit('c')).selection.serving).toBe(oa);
      await f.settle('unchecked', 30, true);
      expect((await f.snapshot())?.reservedMicro).toBe(0);
      expect((await f.snapshot())?.remainingMicro).toBe(2400);
    });

    it('reconciles matched final requests once while retaining external and unreported costs', async () => {
      const f = await fixture(19200);
      await f.refresh(); await f.admit('matched'); await f.bind('matched');
      await withCreditRetry(f.store, (t) => settleTranscriptionInterval(t, {
        scopeId, reservationId: 'matched', connectionId: 'connection-matched', entry: dg,
        reportId: 'matched-final', audioSeconds: 60, final: true,
        supplierRequestId: 'request-matched', at: at + 1000,
      }));
      await f.admit('unreported'); await f.bind('unreported'); await f.settle('unreported', 60, true);
      const time = at + 300000;
      const checked = { ...evidence(f.r, 7200, time), requests: [
        { requestId: 'request-matched', createdAtMs: at, completedAtMs: at + 1000, costMicro: 4800 },
        { requestId: 'request-external', createdAtMs: at, completedAtMs: at + 1000, costMicro: 2400 },
      ] };
      for (let i = 0; i < 2; i++) {
        await withCreditRetry(f.store, (t) => refreshTranscriptionCredit(t, {
          scopeId, recordVersion: f.r.version, evidence: checked, at: time,
        }));
        expect((await f.snapshot(time))?.remainingMicro).toBe(7200);
      }
    });

    it('requires the first successful check and gives only one concurrent admission the last minute', async () => {
      const f = await fixture();
      expect((await f.admit('before')).selection.serving).toBe(oa);
      await f.refresh();
      const starts = await Promise.all(Array.from({ length: 12 }, (_, i) => f.admit(`s${i}`)));
      expect(starts.filter((s) => s.selection.serving === dg)).toHaveLength(1);
      expect((await f.snapshot())?.reservedMicro).toBe(4800);
      const winner = starts.find((s) => s.selection.serving === dg)!;
      const replay = await f.admit(winner.reservationId);
      expect(replay).toEqual(winner);
      expect((await f.snapshot())?.reservedMicro).toBe(4800);
    });

    it('allocates interval deltas once, splits an overrun, and releases only on final', async () => {
      const f = await fixture();
      await f.refresh(); await f.admit('s'); await f.bind('s');
      const first = await f.settle('s', 30, false);
      expect(first).toMatchObject({ grossMicro: 2400, prepaidMicro: 2400, chargedMicro: 0, fromSeconds: 0, toSeconds: 30 });
      expect(await f.settle('s', 30, false)).toEqual(first);
      expect((await f.snapshot())?.reservedMicro).toBe(2400);
      const last = await f.settle('s', 90, true);
      expect(last).toMatchObject({ grossMicro: 4800, prepaidMicro: 2400, chargedMicro: 2400, fromSeconds: 30, toSeconds: 90 });
      expect((await f.snapshot())?.reservedMicro).toBe(0);
      expect((await f.admit('spent')).selection.serving).toBe(oa);
      await expect(f.settle('s', 91, true)).rejects.toThrow('closed');
    });

    it('retains unmatched local use alongside unrelated external supplier cost', async () => {
      const f = await fixture(9600);
      await f.refresh(); await f.admit('s'); await f.bind('s');
      await f.settle('s', 60, true);
      await f.refresh(0, at + 2000);
      expect((await f.snapshot(at + 2000))?.remainingMicro).toBe(4800);
      await f.refresh(4800, at + 3000);
      expect((await f.snapshot(at + 3000))?.remainingMicro).toBe(0);
      await expect(f.refresh(0, at + 4000)).rejects.toThrow('regressed');
    });

    it('records actual uncovered usage and never labels all usage from one vendor prepaid', async () => {
      const f = await fixture(2400); await f.refresh();
      await withCreditRetry(f.store, (t) => reserveTranscriptionCredit(t, {
        scopeId, reservationId: 'explicit', entry: dg, microPerMinute: 4800,
        estimatedSeconds: 60, creditVersion: f.r.version, at,
      }));
      await f.bind('explicit');
      expect(await f.settle('explicit', 60, true)).toMatchObject({ prepaidMicro: 2400, chargedMicro: 2400 });
      await withCreditRetry(f.store, (t) => reserveTranscriptionCredit(t, {
        scopeId, reservationId: 'empty', entry: dg, microPerMinute: 4800,
        estimatedSeconds: 60, creditVersion: f.r.version, at: at + 2000,
      }));
      await f.bind('empty');
      expect(await f.settle('empty', 60, true, at + 3000)).toMatchObject({ prepaidMicro: 0, chargedMicro: 4800 });
    });

    it('deducts external exhaustion even from an existing promotional reservation', async () => {
      const f = await fixture(); await f.refresh(); await f.admit('s'); await f.bind('s');
      await f.refresh(4800, at + 1000);
      expect(await f.settle('s', 60, true, at + 2000)).toMatchObject({ prepaidMicro: 0, chargedMicro: 4800 });
    });

    it('binds each reservation once and rolls a cancelled acquisition back', async () => {
      const f = await fixture(); await f.refresh(); await f.admit('s'); await f.bind('s');
      await expect(withCreditRetry(f.store, (t) => bindTranscriptionConnection(t, {
        scopeId, reservationId: 's', connectionId: 'other', entry: dg, at,
      }))).rejects.toThrow('binding');
      await expect(withCreditRetry(f.store, (t) => bindTranscriptionConnection(t, {
        scopeId, reservationId: 's', connectionId: 'connection-s', entry: oa, at,
      }))).rejects.toThrow('binding');
      const g = await fixture(); await g.refresh();
      const abort = new AbortController();
      await expect(withCreditRetry(g.store, async (t) => {
        await admitLowestCostTranscription(t, { scopeId, reservationId: 'cancel', entries: [dg, oa], prices,
          availableVendors: ['deepgram', 'openai'], estimatedSeconds: 60, creditVersion: g.r.version, at });
        abort.abort(); abort.signal.throwIfAborted();
      })).rejects.toThrow();
      expect((await g.snapshot())?.reservedMicro).toBe(0);
    });

    it('treats stale checks as spent and counts failed UTC days once', async () => {
      const f = await fixture(9600); await f.refresh();
      expect((await f.admit('stale', at + 86400000)).selection.serving).toBe(oa);
      for (const time of [at + 1000, at + 2000, at + 86400000, at + 2 * 86400000]) {
        await withCreditRetry(f.store, (t) => failTranscriptionCreditCheck(t, {
          scopeId, recordVersion: f.r.version, at: time,
        }));
      }
      expect((await f.snapshot(at + 2 * 86400000))?.failedDays).toBe(3);
      await f.refresh(0, at + 2 * 86400000 + 1000);
      expect((await f.snapshot(at + 2 * 86400000 + 1000))?.failedDays).toBe(0);
    });

    it('invalidates disabled and changed records without discarding old holds', async () => {
      const f = await fixture(); await f.refresh(); await f.admit('s');
      await withCreditRetry(f.store, (t) => configureTranscriptionCredit(t, { scopeId, record: null, at: at + 1 }));
      expect(await f.snapshot()).toBeUndefined();
      const next = record(20000, at + 1000);
      await expect(withCreditRetry(f.store, (t) => configureTranscriptionCredit(t, {
        scopeId, record: next, at: at + 2000,
        baselineFence: { mediaClosed: true, inferenceTerminated: true, evidence: 'fixture-stop', observedAt: at + 500 },
      }))).rejects.toThrow('open reservations');
      await f.bind('s');
      expect(await f.settle('s', 0, true)).toMatchObject({ prepaidMicro: 0, chargedMicro: 0 });
      await withCreditRetry(f.store, (t) => configureTranscriptionCredit(t, {
        scopeId, record: next, at: at + 2000,
        baselineFence: { mediaClosed: true, inferenceTerminated: true, evidence: 'fixture-stop', observedAt: at + 500 },
      }));
      expect(await f.snapshot(at + 2000)).toBeUndefined();
      await expect(f.refresh()).rejects.toThrow('version');
    });

    it('refuses altered retries, nonmonotone reports, future evidence and wrong scope', async () => {
      const f = await fixture(); await f.refresh(); await f.admit('s'); await f.bind('s');
      await f.settle('s', 30, false);
      await expect(f.settle('s', 29, false)).rejects.toThrow('monotone');
      await expect(withCreditRetry(f.store, (t) => settleTranscriptionInterval(t, {
        scopeId, reservationId: 's', connectionId: 'connection-s', entry: dg,
        reportId: 's:30:false', audioSeconds: 31, final: false, at: at + 1000,
      }))).rejects.toThrow('report conflict');
      await expect(withCreditRetry(f.store, (t) => refreshTranscriptionCredit(t, {
        scopeId, recordVersion: f.r.version, evidence: evidence(f.r, 0, at + 1), at,
      }))).rejects.toThrow('evidence');
      await expect(withCreditRetry(f.store, (t) => settleTranscriptionInterval(t, {
        scopeId: 'other', reservationId: 's', connectionId: 'connection-s', entry: dg,
        reportId: 'wrong', audioSeconds: 31, final: true, at,
      }))).rejects.toThrow('reservation');
    });
  });
}
