import { expect, it, vi } from 'vitest';
import { MeetingManager, type MeetingManagerStores } from '../MeetingManager.js';
import { MeetingRoom } from '../MeetingRoom.js';
import { contentFreeRun, type SupplierUsage } from '../types.js';
import { harness } from './manager-send-dispatch.test.js';

/** A manager as a host builds one with a logger, on the harness's stores (with any the test adds) and its provider. */
function withLogger(h: ReturnType<typeof harness>, stores: Partial<MeetingManagerStores> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new MeetingManager({ managerId: 'm1', stores: { ...h.stores, ...stores }, room: new MeetingRoom(h.rooms), reportUrlFor: (runId, p) => `https://product.test/events/${p}/${runId}`, logger });
  manager.registerProvider(h.provider);
  return { manager, logger };
}

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

it("takes a provider's usage only for the runs it was asked about: an answer about another run records no totals and ends nothing", async () => {
  const h = harness();
  const recordSupplierUsage = vi.fn(async (_reservationId: string, _usage: SupplierUsage) => undefined);
  Object.assign(h.entitlement, { recordSupplierUsage });
  const asked = await h.manager.sendBot(h.request);
  h.entitlement.reserveAnswer = { ok: true, reservationId: 'res-2', maxSeconds: 14_400 };
  const other = await h.manager.sendBot({ ...h.request, idempotencyKey: 'k2' });
  if (!asked.ok || !other.ok) throw new Error('send refused');
  await h.manager.tick();
  await h.report(asked.run.runId, 'joining');
  await h.report(other.run.runId, 'joining');
  // the other run has no dispatched job left, so the pass does not ask the provider about it
  await h.stores.jobs.remove(other.run.runId);
  vi.spyOn(h.provider, 'usage').mockResolvedValue([
    { runId: asked.run.runId, alive: true, seconds: 0 },
    { runId: other.run.runId, alive: false, seconds: 7, supplierUsage: { streamSeconds: 90, captureSeconds: 30, final: true } },
  ]);
  const { manager, logger } = withLogger(h);
  await manager.reconcile();
  expect(recordSupplierUsage).not.toHaveBeenCalled();
  expect((await h.stores.runs.get(other.run.runId))?.state).toBe('joining');
  expect(logger.warn).toHaveBeenCalledWith('[MeetingManager] usage of mock: 1 answer(s) about runs it was not asked about, ignored');
});
