import { SupplierUsageComponentSchema, UsageRecordSchema, type ConnectionInterval, type SupplierUsageComponent, type UsageRecord } from './contracts/index.js';
import { voiceInteger, voiceKey, type StoredVoiceCall } from './stores/types.js';

/** Authenticated worker report; receivedAt is supplied separately by the trusted control plane. */
export interface CallQuantityReport {
  sequence: number; workerGeneration: number; transportEpoch: number;
  supplierComponents: SupplierUsageComponent[];
}
/** Union of closed intervals and the acknowledged part of open intervals, in integer milliseconds. */
export function connectedUnionMs(intervals: readonly ConnectionInterval[], acknowledgedAt: number): number {
  voiceInteger(acknowledgedAt);
  const spans = intervals.map((i) => {
    const start = voiceInteger(i.startedAt);
    const end = i.endedAt === null ? Math.max(start, acknowledgedAt) : voiceInteger(i.endedAt);
    if (end < start) throw new Error('reverse connection time');
    return [start, end] as const;
  }).sort((a, b) => a[0] - b[0]);
  let total = 0; let right = 0;
  for (const [start, end] of spans) {
    if (end > right) total = voiceInteger(total + end - Math.max(start, right));
    right = Math.max(right, end);
  }
  return total;
}
function supplierKey(c: SupplierUsageComponent): string {
  return voiceKey(c.providerId, c.attemptId ?? '', String(c.generation ?? 0), c.component, c.unit);
}
/** Stateless quantity operations on a transaction-owned call copy; the caller commits call and usage together. */
export class CallMinuteMeter {
  /** Opens one authoritative interval for the current worker and transport epoch. Duplicate readiness is harmless. */
  open(s: StoredVoiceCall, at: number): void {
    voiceInteger(at); voiceInteger(s.call.workerGeneration, 1); voiceInteger(s.call.transportEpoch, 1);
    const intervalId = `w${s.call.workerGeneration}:t${s.call.transportEpoch}`;
    const previous = s.call.connectionTimeline.find((i) => i.intervalId === intervalId);
    if (previous) {
      if (previous.endedAt !== null) throw new Error('closed interval');
      return;
    }
    if (s.call.connectionTimeline.some((i) => i.endedAt === null)) throw new Error('interval already open');
    const last = s.call.connectionTimeline[s.call.connectionTimeline.length - 1];
    if (last && at < (last.endedAt ?? last.startedAt)) throw new Error('reverse connection time');
    if (s.call.connectionTimeline.length >= 4096) throw new Error('connection history full');
    s.call.connectionTimeline.push({ intervalId, workerGeneration: s.call.workerGeneration, transportEpoch: s.call.transportEpoch, startedAt: at, endedAt: null });
    s.acknowledgedAt = at;
  }
  /** Closes at a server-observed boundary; worker loss clips unknown tail time to the last acknowledgement. */
  close(s: StoredVoiceCall, at: number, acknowledgedOnly = false): void {
    voiceInteger(at);
    const current = s.call.connectionTimeline.find((i) => i.endedAt === null);
    if (!current) return;
    const end = acknowledgedOnly ? Math.min(at, s.acknowledgedAt) : at;
    if (end < current.startedAt) throw new Error('reverse connection time');
    current.endedAt = end;
    s.acknowledgedAt = Math.max(s.acknowledgedAt, end);
  }
  /** True only for a newly accepted report. Exact retries cannot move the acknowledgement clock. */
  acknowledge(s: StoredVoiceCall, report: CallQuantityReport, receivedAt: number): boolean {
    voiceInteger(report.sequence, 1); voiceInteger(receivedAt);
    if (!['connected', 'reconnecting'].includes(s.call.state) || report.workerGeneration !== s.call.workerGeneration || report.transportEpoch !== s.call.transportEpoch) throw new Error('stale report');
    const parsed = report.supplierComponents.map((c) => SupplierUsageComponentSchema.parse(c));
    parsed.sort((a, b) => supplierKey(a).localeCompare(supplierKey(b)));
    if (parsed.length > 4096 || new Set(parsed.map(supplierKey)).size !== parsed.length) throw new Error('invalid supplier report');
    const hash = JSON.stringify([report.workerGeneration, report.transportEpoch, parsed]);
    if (report.sequence < s.reportSequence) return false;
    if (report.sequence === s.reportSequence) {
      if (s.reportHash !== hash) throw new Error('conflicting report');
      return false;
    }
    if (receivedAt < s.acknowledgedAt) throw new Error('reverse acknowledgement time');
    const merged = new Map(s.call.usage.supplierComponents.map((c) => [supplierKey(c), c]));
    for (const next of parsed) {
      const old = merged.get(supplierKey(next));
      if (old && next.quantity < old.quantity) throw new Error('regressing supplier usage');
      if (old && old.status !== 'pending' && JSON.stringify(old) !== JSON.stringify(next)) throw new Error('final supplier usage');
      merged.set(supplierKey(next), next);
    }
    if (merged.size > 4096) throw new Error('supplier history full');
    s.call.usage.supplierComponents = [...merged.values()];
    s.reportSequence = report.sequence; s.reportHash = hash;
    if (s.call.state === 'connected') s.acknowledgedAt = receivedAt;
    const usage = this.snapshot(s, false);
    s.call.usage.connectedMs = usage.connectedMs; s.call.usage.billableSeconds = 0;
    return true;
  }
  /** Final rounding happens once across the complete call, never per interval, heartbeat or supplier. */
  snapshot(s: StoredVoiceCall, final: boolean): UsageRecord {
    const connectedMs = connectedUnionMs(s.call.connectionTimeline, s.acknowledgedAt);
    return UsageRecordSchema.parse({
      version: 1, scopeId: s.call.scopeId, operationId: s.call.callId, productKind: 'voice_call',
      connectedMs, billableSeconds: final ? Math.ceil(connectedMs / 1000) : 0,
      supplierComponents: s.call.usage.supplierComponents,
      terminalReason: s.call.endReason, final,
    });
  }
}
