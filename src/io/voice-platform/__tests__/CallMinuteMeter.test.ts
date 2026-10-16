import { describe, expect, it } from 'vitest';
import { CallMinuteMeter, connectedUnionMs } from '../CallMinuteMeter.js';
import type { SupplierUsageComponent } from '../contracts/index.js';
import { storedCall } from './callFixtures.js';

const meter = new CallMinuteMeter();
const component: SupplierUsageComponent = { providerId: 'stt-a', component: 'audio', unit: 'millisecond', quantity: 10, generation: 1, status: 'pending' };
function active() {
  const s = storedCall(); s.call.workerGeneration = 1; s.call.transportEpoch = 1; s.call.state = 'connected'; return s;
}
describe('connected-time quantities', () => {
  it('unions duplicate and overlapping intervals and rounds only the final total', () => {
    const intervals = [
      { intervalId: 'a', workerGeneration: 1, transportEpoch: 1, startedAt: 1000, endedAt: 1600 },
      { intervalId: 'b', workerGeneration: 1, transportEpoch: 2, startedAt: 1500, endedAt: 1800 },
      { intervalId: 'c', workerGeneration: 1, transportEpoch: 3, startedAt: 9000, endedAt: 9300 },
    ];
    expect(connectedUnionMs([...intervals, intervals[0]!], 10000)).toBe(1100);
    const s = active(); s.call.connectionTimeline = intervals;
    expect(meter.snapshot(s, false)).toMatchObject({ connectedMs: 1100, billableSeconds: 0, final: false });
    expect(meter.snapshot(s, true)).toMatchObject({ connectedMs: 1100, billableSeconds: 2, final: true });
  });
  it('excludes setup and gaps, counts silence, and cannot reopen a closed epoch', () => {
    const s = active();
    expect(meter.snapshot(s, true).billableSeconds).toBe(0);
    meter.open(s, 10000); meter.open(s, 10000);
    meter.acknowledge(s, { sequence: 1, workerGeneration: 1, transportEpoch: 1, supplierComponents: [] }, 10500);
    meter.close(s, 10600);
    expect(() => meter.open(s, 10600)).toThrow('closed interval');
    s.call.transportEpoch = 2;
    meter.open(s, 20000); meter.close(s, 20500);
    expect(meter.snapshot(s, true)).toMatchObject({ connectedMs: 1100, billableSeconds: 2 });
  });
  it('deduplicates reports and refuses conflicting, stale and regressing reports', () => {
    const s = active(); meter.open(s, 1000);
    const report = { sequence: 1, workerGeneration: 1, transportEpoch: 1, supplierComponents: [component] };
    expect(meter.acknowledge(s, report, 1500)).toBe(true);
    expect(meter.acknowledge(s, report, 2000)).toBe(false);
    expect(s.acknowledgedAt).toBe(1500);
    expect(() => meter.acknowledge(s, { ...report, supplierComponents: [] }, 2000)).toThrow('conflicting report');
    expect(() => meter.acknowledge(s, { ...report, sequence: 2, workerGeneration: 2 }, 2000)).toThrow('stale report');
    expect(() => meter.acknowledge(s, { ...report, sequence: 2, supplierComponents: [{ ...component, quantity: 9 }] }, 2000)).toThrow('regressing supplier usage');
    expect(s.call.usage.supplierComponents).toEqual([component]);
  });
  it('worker loss bills only acknowledged time and rejects reports after finalization', () => {
    const s = active(); meter.open(s, 1000);
    meter.acknowledge(s, { sequence: 1, workerGeneration: 1, transportEpoch: 1, supplierComponents: [] }, 1600);
    meter.close(s, 9000, true);
    s.call.state = 'ending';
    expect(meter.snapshot(s, true)).toMatchObject({ connectedMs: 600, billableSeconds: 1 });
    expect(() => meter.acknowledge(s, { sequence: 2, workerGeneration: 1, transportEpoch: 1, supplierComponents: [] }, 10000)).toThrow('stale report');
  });
  it('rejects reverse time and preserves terminal supplier results', () => {
    const s = active(); meter.open(s, 1000);
    expect(() => meter.close(s, 999)).toThrow();
    meter.acknowledge(s, { sequence: 1, workerGeneration: 1, transportEpoch: 1, supplierComponents: [{ ...component, status: 'complete' }] }, 1500);
    expect(() => meter.acknowledge(s, { sequence: 2, workerGeneration: 1, transportEpoch: 1, supplierComponents: [{ ...component, quantity: 11 }] }, 1600)).toThrow('final supplier usage');
    expect(() => connectedUnionMs([{ intervalId: 'x', workerGeneration: 1, transportEpoch: 1, startedAt: 2, endedAt: 1 }], 3)).toThrow();
  });
});
