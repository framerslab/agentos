import { describe, expect, it } from 'vitest';
import { DemoRunCapability, type DemoAuth } from '../DemoRunCapability.js';
import { InMemoryDemoRunStore } from '../stores/demo.js';
import { demoStoreContract, demoTestPolicy } from './demo-store.contract.js';

demoStoreContract('memory demo transactions', async () => {
  const store = new InMemoryDemoRunStore();
  return { first: store, second: store, close: async () => undefined };
});

async function fixture() {
  let at = 1_000_000; let outage = false;
  const cleaned: string[] = [];
  const store = new InMemoryDemoRunStore();
  const config = { store, policy: structuredClone(demoTestPolicy), issuer: 'service', audience: 'ui', scopeRef: 'scope', now: () => at,
    cleanup: async (input: { operationId: string; runId?: string; action: 'stop' | 'purge'; generation: number }) => {
      if (outage) throw new Error('cleanup unavailable');
      cleaned.push(`${input.operationId}:${input.action}:${input.generation}`);
      return { connectedSeconds: 0 };
    } };
  const service = new DemoRunCapability(config);
  const nonce = await service.createNonce('visitor', 'address');
  const admission = await service.claimStart(nonce, 'visitor', 'address');
  const token = await service.bindRun(admission.operationId, 'run');
  const auth: DemoAuth = { ...token, visitor: 'visitor', issuer: 'service', audience: 'ui', runId: 'run' };
  return { service, config, admission, auth, store, cleaned, advance: (ms: number) => { at += ms; }, outage: (value: boolean) => { outage = value; } };
}

describe('demonstration authority', () => {
  it('captures policy and refuses invalid or expanded operation sets', async () => {
    const h = await fixture(); h.config.policy.runMs = 1000; h.config.policy.operations = ['purge'];
    expect(await h.service.withRead(h.auth, 'read-status', async () => 'ok')).toBe('ok');
    const row = await h.store.transaction((tx) => tx.get(h.admission.operationId));
    expect(row?.policy).toEqual(demoTestPolicy);
    expect(() => new DemoRunCapability({ ...h.config, policy: { ...demoTestPolicy, runMs: -1 } })).toThrow('invalid demo policy');
    expect(() => new DemoRunCapability({ ...h.config, policy: { ...demoTestPolicy, operations: ['unknown' as never] } })).toThrow('invalid demo policy');
  });
  it.each(['read-status', 'read-events', 'read-usage', 'stop', 'purge'] as const)('refuses cross-visitor %s and guessed run ids', async (operation) => {
    const h = await fixture(); let touched = false;
    for (const bad of [{ ...h.auth, visitor: 'other' }, { ...h.auth, runId: 'other' }, { ...h.auth, issuer: 'other' }, { ...h.auth, audience: 'other' }]) {
      const call = operation === 'stop' || operation === 'purge'
        ? h.service.control(bad, operation, 'request')
        : h.service.withRead(bad, operation, async () => { touched = true; });
      await expect(call).rejects.toThrow('demo authority refused');
    }
    expect(touched).toBe(false); expect(h.cleaned).toEqual([]);
  });

  it('binds one run, stores hashes only and rotates without extending expiry', async () => {
    const h = await fixture();
    await expect(h.service.bindRun(h.admission.operationId, 'another')).rejects.toThrow();
    h.advance(1_000);
    const rotated = await h.service.bindRun(h.admission.operationId, 'run');
    expect(rotated.expiresAt).toBe(h.auth.expiresAt);
    expect(rotated.generation).toBe(h.auth.generation + 1);
    await expect(h.service.withRead(h.auth, 'read-status', async () => 'secret')).rejects.toThrow();
    const rows = await h.store.transaction((tx) => tx.list());
    expect(JSON.stringify(rows)).not.toContain(rotated.token);
    expect(JSON.stringify(rows)).not.toContain('"visitor"');
    expect(await h.service.withRead({ ...h.auth, ...rotated }, 'read-usage', async (binding, assertCurrent) => {
      assertCurrent(); return binding.scopeRef;
    })).toBe('scope');
  });

  it('serializes a bounded stream delivery with purge, then refuses all delayed events', async () => {
    const h = await fixture(); let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const read = h.service.withRead(h.auth, 'read-events', async (_binding, assertCurrent) => { entered(); await wait; assertCurrent(); return 'event'; });
    await ready;
    let done = false;
    const purge = h.service.control(h.auth, 'purge', 'purge-1').then((value) => { done = true; return value; });
    await Promise.resolve(); expect(done).toBe(false);
    release(); expect(await read).toBe('event');
    const receipt = await purge;
    expect(receipt).toMatchObject({ accepted: true, action: 'purge' });
    expect(await h.service.control(h.auth, 'purge', 'purge-1')).toEqual(receipt);
    await expect(h.service.control(h.auth, 'purge', 'purge-2')).rejects.toThrow();
    await expect(h.service.withRead(h.auth, 'read-events', async () => 'late')).rejects.toThrow();
  });

  it('persists cleanup intent before acknowledgement and recovers with no browser present', async () => {
    const h = await fixture(); h.outage(true);
    await expect(h.service.control(h.auth, 'purge', 'purge')).rejects.toThrow('cleanup unavailable');
    await expect(h.service.withRead(h.auth, 'read-status', async () => 'content')).rejects.toThrow();
    h.outage(false);
    const restarted = new DemoRunCapability(h.config);
    await restarted.sweep();
    expect(h.cleaned).toHaveLength(1);
    expect(await restarted.control(h.auth, 'purge', 'purge')).toMatchObject({ accepted: true });
  });

  it('permits grace purge using the held credential after an automatic stop and restart', async () => {
    const h = await fixture(); h.advance(demoTestPolicy.runMs);
    await h.service.sweep();
    expect(h.cleaned[0]).toContain(':stop:');
    await expect(h.service.withRead(h.auth, 'read-events', async () => 'late')).rejects.toThrow();
    const restarted = new DemoRunCapability(h.config);
    expect(await restarted.control(h.auth, 'purge', 'grace-purge')).toMatchObject({ accepted: true });
    h.advance(demoTestPolicy.controlGraceMs);
    await expect(restarted.control(h.auth, 'purge', 'grace-purge')).rejects.toThrow();
    await h.service.sweep();
  });

  it('abandonment purges and neither pending admission nor expired nonce can create another run', async () => {
    const h = await fixture();
    await h.service.abandon(h.admission.operationId);
    await expect(h.service.bindRun(h.admission.operationId, 'run')).rejects.toThrow();
    const nonce = await h.service.createNonce('new', 'new-address');
    h.advance(demoTestPolicy.nonceMs);
    await expect(h.service.claimStart(nonce, 'new', 'new-address')).rejects.toThrow();
    expect(h.cleaned[0]).toContain(':purge:');
  });
});
