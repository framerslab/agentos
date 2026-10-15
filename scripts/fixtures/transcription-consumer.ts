// An independent consumer of the packed or published package: it compiles against the installed declarations alone and
// runs with network access refused. Every price, date, credit amount and identity in it is synthetic.
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import type {
  SttConnectionOpening, SttConnectionHooks, SttMeasuredUsageEvent,
  DeepgramUsageContract, DeepgramUsageEvidence, DeepgramUsageReadOptions,
  DeepgramUsageFetch, DeepgramRequestCost, DeepgramUsageFailureCode,
} from '@framers/agentos/io/voice-pipeline';
import type {
  SttPriceRow, SttCreditSnapshot, LowestCostSttOptions, LowestCostSttSelection,
  TranscriptionCreditRecordInput, TranscriptionCreditRecord, ReserveTranscriptionCreditInput,
  TranscriptionAdmission, TranscriptionIntervalInput, TranscriptionIntervalAllocation,
  CreditDocumentRow, CreditTransaction, TimedTextBudgetView,
} from '@framers/agentos/safety/runtime';

/** The installed declarations a host's transcription admission, connection and accounting code compiles against. */
export type InstalledContracts = [SttConnectionOpening, SttConnectionHooks, SttMeasuredUsageEvent,
  DeepgramUsageContract, DeepgramUsageEvidence, DeepgramUsageReadOptions, DeepgramUsageFetch,
  DeepgramRequestCost, DeepgramUsageFailureCode, SttPriceRow, SttCreditSnapshot, LowestCostSttOptions,
  LowestCostSttSelection, TranscriptionCreditRecordInput, TranscriptionCreditRecord,
  ReserveTranscriptionCreditInput, TranscriptionAdmission, TranscriptionIntervalInput,
  TranscriptionIntervalAllocation, CreditDocumentRow, CreditTransaction, TimedTextBudgetView];

const refuse = (): never => { throw new Error('installed transcription contract attempted network access'); };
net.Socket.prototype.connect = refuse; http.request = refuse; http.get = refuse;
https.request = refuse; https.get = refuse;
// The declared types of dns.lookup and dns.resolve carry a __promisify__ member that a plain function lacks.
dns.lookup = refuse as unknown as typeof dns.lookup;
dns.resolve = refuse as unknown as typeof dns.resolve;
dns.resolve4 = refuse as unknown as typeof dns.resolve4;
dns.resolve6 = refuse as unknown as typeof dns.resolve6;
// node:dns/promises is the same object as dns.promises, so these cover a promise-based import as well.
dns.promises.lookup = refuse as unknown as typeof dns.promises.lookup;
dns.promises.resolve = refuse as unknown as typeof dns.promises.resolve;
dns.promises.resolve4 = refuse as unknown as typeof dns.promises.resolve4;
dns.promises.resolve6 = refuse as unknown as typeof dns.promises.resolve6;
globalThis.fetch = refuse;
syncBuiltinESMExports();

const voice = await import('@framers/agentos/io/voice-pipeline');
const safety = await import('@framers/agentos/safety/runtime');

// Both entries serve one selector, and the server entry carries the price readers and the credit operations.
assert.equal(safety.selectLowestCostSttEntry, voice.selectLowestCostSttEntry);
assert.equal(safety.sttLanguageOptions, voice.sttLanguageOptions);
assert.equal(typeof voice.SttConnectionAuthorizationError, 'function');
assert.equal(typeof voice.readDeepgramUsage, 'function');
assert.equal(typeof voice.DeepgramUsageReadError, 'function');
assert.deepEqual(voice.sttLanguageOptions('openai:gpt-4o-mini-transcribe', null), {});
assert.equal(voice.sttLanguageOptions('deepgram:nova-3', null), null);
assert.deepEqual(voice.sttLanguageOptions('deepgram:nova-3', 'es'), { language: 'es' });
for (const operation of ['createTimedTextBudget', 'readTimedTextBudget', 'reportTimedTextBudget',
  'renewTimedTextBudget', 'settleTimedTextBudget'] as const) assert.equal(typeof safety[operation], 'function', operation);
assert.equal(typeof safety.SqlCompoundCreditStore.prototype.withStorageTransaction, 'function');
assert.match(safety.compoundCreditDdl('fixture_credit'), /fixture_credit_documents/);
assert.equal(safety.deepgramStreamingPricing('nova-3'), voice.deepgramStreamingPricing('nova-3'));
assert.equal(safety.deepgramPreRecordedPricing('nova-3'), voice.deepgramPreRecordedPricing('nova-3'));
assert.equal(safety.deepgramStreamingPricing('unknown'), undefined);

// List-price order without credit: the cheaper row serves.
const rows: SttPriceRow[] = [
  { entry: 'deepgram:nova-3', microPerMinute: 4800 },
  { entry: 'openai:gpt-4o-mini-transcribe', microPerMinute: 3000 },
];
const at = Date.UTC(2026, 9, 14, 12);
const options: LowestCostSttOptions = { availableVendors: ['openai', 'deepgram'], nowMs: at, estimatedSeconds: 60 };
assert.equal(safety.selectLowestCostSttEntry(rows.map((r) => r.entry), rows, options)?.serving,
  'openai:gpt-4o-mini-transcribe');

// One checked minute of supplier credit: two simultaneous admissions, and only one of them is funded by it.
const store = new safety.InMemoryCompoundCreditStore();
const scopeId = 'installed-supplier';
const record = safety.makeTranscriptionCreditRecord({ vendor: 'deepgram', amountMicro: 4800,
  readAtMs: at - 3600000, validUntilMs: at + 86400000,
  projectId: '00000000-0000-4000-8000-000000000001', contractVersion: 'synthetic-contract' });
await safety.withCreditRetry(store, async (t) => {
  await safety.configureTranscriptionCredit(t, { scopeId, record, at });
  await safety.refreshTranscriptionCredit(t, { scopeId, recordVersion: record.version, at,
    evidence: { projectId: record.projectId, fromMs: record.readAtMs, throughMs: at - 120000,
      checkedAtMs: at, contractVersion: record.contractVersion, costMicro: 0, requests: [] } });
});
const starts = await Promise.all(['one', 'two'].map((reservationId) => safety.withCreditRetry(store, (t) =>
  safety.admitLowestCostTranscription(t, { scopeId, reservationId,
    entries: rows.map((r) => r.entry), prices: rows, availableVendors: ['openai', 'deepgram'],
    estimatedSeconds: 60, creditVersion: record.version, at }))));
assert.equal(starts.filter((r) => r.selection.serving === 'deepgram:nova-3').length, 1);
const selected = starts.find((r) => r.selection.serving === 'deepgram:nova-3')!;

// The credited socket runs 90 seconds: the first minute is prepaid, the rest is charged, in one split receipt.
const connectionId = 'installed-connection';
await safety.withCreditRetry(store, (t) => safety.bindTranscriptionConnection(t, {
  scopeId, reservationId: selected.reservationId, connectionId, entry: selected.selection.serving, at,
}));
const usage: TranscriptionIntervalInput = { scopeId, reservationId: selected.reservationId, connectionId,
  entry: selected.selection.serving, reportId: 'installed-final', audioSeconds: 90, final: true, at: at + 1000 };
const receipt = await safety.withCreditRetry(store, (t) => safety.settleTranscriptionInterval(t, usage));
assert.equal(receipt.grossMicro, 7200);
assert.equal(receipt.prepaidMicro, 4800);
assert.equal(receipt.chargedMicro, 2400);
assert.deepEqual(await safety.withCreditRetry(store, (t) => safety.settleTranscriptionInterval(t, usage)), receipt);

// Text funded by elapsed time: the second part is reserved at the hour, and each part settles once.
await safety.withCreditRetry(store, async (t) => {
  await safety.createTimedTextBudget(t, { scopeId, budgetId: 'text', at, sliceMs: 3600000,
    partMicro: 100, initialReservationId: 'text-initial' });
  await safety.reportTimedTextBudget(t, scopeId, 'text', 50);
  const renewed = await safety.renewTimedTextBudget(t, { scopeId, budgetId: 'text', at: at + 3600000,
    cumulativeMicro: 50, allowed: true }, async () => 'text-next');
  assert.equal(renewed.leftMicro, 100);
  const settled: Array<[string, number]> = [];
  await safety.settleTimedTextBudget(t, { scopeId, budgetId: 'text', initialAudioMicro: 0 },
    async (id, micro) => { settled.push([id, micro]); });
  assert.deepEqual(settled, [['text-initial', 50], ['text-next', 0]]);
});
console.log('installed transcription contracts pass');
