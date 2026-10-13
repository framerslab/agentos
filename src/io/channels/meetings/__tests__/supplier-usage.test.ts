import { expect, it, vi } from 'vitest';
import { contentFreeRun } from '../types.js';
import { harness } from './manager-send-dispatch.test.js';

it('preserves connection provenance after content is removed and records supplier usage independently', async () => {
  const h = harness();
  const recordSupplierUsage = vi.fn(async () => undefined);
  Object.assign(h.entitlement, { recordSupplierUsage });
  const sent = await h.manager.sendBot(h.request);
  if (!sent.ok) throw new Error('send refused');
  const runId = sent.run.runId;
  await h.stores.runs.update(runId, { providerConnectionRef: 'generation-1' });
  await h.manager.tick();
  await h.report(runId, 'joining');
  const usage = { streamSeconds: 90, captureSeconds: 0, final: true };
  await h.report(runId, 'usage', { seconds: 0, supplierUsage: usage });
  expect(recordSupplierUsage).toHaveBeenCalledWith('res-1', usage);
  recordSupplierUsage.mockClear();
  vi.spyOn(h.provider, 'usage').mockResolvedValue([{ runId, alive: true, seconds: 0, supplierUsage: usage }]);
  await h.manager.reconcile();
  expect(recordSupplierUsage).toHaveBeenCalledWith('res-1', usage);
  const run = (await h.stores.runs.get(runId))!;
  expect(contentFreeRun(run)).toMatchObject({ providerName: 'mock', providerConnectionRef: 'generation-1', meetingUrl: '' });
});
