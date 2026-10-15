import { describe, expect, it } from 'vitest';
import { DemoRunCapability } from '../DemoRunCapability.js';
import type { DemoPolicy, IDemoRunStore } from '../stores/demo.js';

/** Synthetic policies exercise configuration without encoding a product allowance. */
export const demoTestPolicy: DemoPolicy = { version: 'fixture-a', credentialMs: 29000, runMs: 11000, nonceMs: 7000,
  allowanceWindowMs: 97000, allowanceSeconds: 31, addressWindowMs: 23000, addressAttempts: 4,
  maxActiveRuns: 1, controlGraceMs: 18000, operations: ['read-status', 'read-events', 'read-usage', 'stop', 'purge'] };

/** Runs unchanged against a host's durable adapter, including two instances sharing a database. */
export function demoStoreContract(name: string, open: () => Promise<{ first: IDemoRunStore; second: IDemoRunStore; close(): Promise<void> }>): void {
  describe(name, () => {
    it('shares connected-second allowance across visitors using the same address', async () => {
      const db = await open();
      try {
        const policy = { ...demoTestPolicy, allowanceSeconds: 13, addressAttempts: 9 }; let seconds = 0;
        const options = { policy, issuer: 'service', audience: 'ui', scopeRef: 'scope', now: () => 1000, cleanup: async () => ({ connectedSeconds: seconds }) };
        const a = new DemoRunCapability({ ...options, store: db.first }); const b = new DemoRunCapability({ ...options, store: db.second });
        const first = await a.claimStart(await a.createNonce('v1', 'shared'), 'v1', 'shared');
        seconds = 11; await a.abandon(first.operationId);
        const next = await b.claimStart(await b.createNonce('v2', 'shared'), 'v2', 'shared');
        expect(next.stopAt - 1000).toBe(2000); seconds = 2; await b.abandon(next.operationId);
        await expect(a.claimStart(await a.createNonce('v3', 'shared'), 'v3', 'shared')).rejects.toThrow('demo authority refused');
        const independent = await a.claimStart(await a.createNonce('v3', 'other'), 'v3', 'other');
        expect(independent.stopAt - 1000).toBe(policy.runMs);
      } finally { await db.close(); }
    });
    it('captures configured concurrency and operation permissions instead of product defaults', async () => {
      const db = await open();
      try {
        const policy: DemoPolicy = { ...demoTestPolicy, maxActiveRuns: 2, operations: ['purge'] };
        const service = new DemoRunCapability({ store: db.first, policy, issuer: 'service', audience: 'ui', scopeRef: 'scope', now: () => 1000, cleanup: async () => ({ connectedSeconds: 0 }) });
        policy.maxActiveRuns = 1; policy.operations = ['stop'];
        const first = await service.claimStart(await service.createNonce('visitor', 'address'), 'visitor', 'address');
        await service.claimStart(await service.createNonce('visitor', 'address'), 'visitor', 'address');
        await expect(service.claimStart(await service.createNonce('visitor', 'address'), 'visitor', 'address')).rejects.toThrow('demo authority refused');
        const credential = await service.bindRun(first.operationId, 'run');
        const auth = { ...credential, visitor: 'visitor', issuer: 'service', audience: 'ui', runId: 'run' };
        await expect(service.control(auth, 'stop', 'stop')).rejects.toThrow('demo authority refused');
        await expect(service.withRead(auth, 'read-status', async () => 'unreachable')).rejects.toThrow('demo authority refused');
        expect(await service.control(auth, 'purge', 'purge')).toMatchObject({ accepted: true, action: 'purge' });
      } finally { await db.close(); }
    });
    it('atomically consumes one nonce, holds both slots and accounts for rolling allowances', async () => {
      const db = await open();
      try {
        let at = 1_000_000;
        const make = (store: IDemoRunStore) => new DemoRunCapability({ store, policy: demoTestPolicy, issuer: 'demo-service', audience: 'demo-ui', scopeRef: 'demo-scope', now: () => at, cleanup: async () => ({ connectedSeconds: 3 }) });
        const a = make(db.first); const b = make(db.second);
        const nonce = await a.createNonce('visitor-a', 'address-a');
        const claims = await Promise.allSettled([a.claimStart(nonce, 'visitor-a', 'address-a'), b.claimStart(nonce, 'visitor-a', 'address-a')]);
        expect(claims.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const won = claims.find((r) => r.status === 'fulfilled');
        if (!won || won.status !== 'fulfilled') throw new Error('admission missing');
        const other = await b.createNonce('visitor-b', 'address-a');
        await expect(b.claimStart(other, 'visitor-b', 'address-a')).rejects.toThrow('demo authority refused');
        const bound = await a.bindRun(won.value.operationId, 'run-a');
        const auth = { ...bound, visitor: 'visitor-a', issuer: 'demo-service', audience: 'demo-ui', runId: 'run-a' };
        await a.control(auth, 'purge', 'delete-a');
        await expect(b.claimStart(nonce, 'visitor-a', 'address-a')).rejects.toThrow('demo authority refused');
        const again = await b.createNonce('visitor-a', 'address-a');
        const resumed = await b.claimStart(again, 'visitor-a', 'address-a');
        expect(resumed.stopAt - at).toBe(11000);
        await b.abandon(resumed.operationId);
        at += demoTestPolicy.allowanceWindowMs + 1;
        const fresh = await b.createNonce('visitor-a', 'address-a');
        expect((await b.claimStart(fresh, 'visitor-a', 'address-a')).operationId).not.toBe(won.value.operationId);
      } finally { await db.close(); }
    });

    it.each([demoTestPolicy, { ...demoTestPolicy, version: 'fixture-b', runMs: 7000, allowanceSeconds: 17, credentialMs: 19000, controlGraceMs: 12000 }])('reconciles seconds under $version across instances', async (policy) => {
      const db = await open();
      try {
        let at = 1000000; let connectedSeconds = 0;
        const options = { policy, issuer: 'service', audience: 'ui', scopeRef: 'scope', now: () => at, cleanup: async () => ({ connectedSeconds }) };
        const first = new DemoRunCapability({ ...options, store: db.first });
        const second = new DemoRunCapability({ ...options, store: db.second });
        const admit = async (service: DemoRunCapability) => service.claimStart(await service.createNonce('visitor', 'address'), 'visitor', 'address');
        const failed = await admit(first); await first.abandon(failed.operationId);
        const partial = await admit(second); connectedSeconds = 3; await second.abandon(partial.operationId);
        const full = await admit(first); connectedSeconds = policy.runMs / 1000; await first.abandon(full.operationId);
        const remaining = await admit(second);
        expect(remaining.stopAt - at).toBe(Math.min(policy.runMs / 1000, policy.allowanceSeconds - 3 - connectedSeconds) * 1000);
        connectedSeconds = (remaining.stopAt - at) / 1000; await second.abandon(remaining.operationId);
        await expect(admit(first)).rejects.toThrow('demo authority refused');
        at += policy.addressWindowMs + 1;
        const used = 3 + policy.runMs / 1000 + connectedSeconds;
        if (used < policy.allowanceSeconds) {
          const last = await admit(first); expect(last.stopAt - at).toBe((policy.allowanceSeconds - used) * 1000);
          connectedSeconds = policy.allowanceSeconds - used; await first.abandon(last.operationId);
        }
        await expect(admit(second)).rejects.toThrow('demo authority refused');
        at += policy.allowanceWindowMs + 1;
        expect((await admit(second)).stopAt - at).toBe(policy.runMs);
      } finally { await db.close(); }
    });

    it('rolls back nonce consumption when allowance admission fails', async () => {
      const db = await open();
      try {
        const make = (store: IDemoRunStore) => new DemoRunCapability({ store, policy: demoTestPolicy, issuer: 'service', audience: 'ui', scopeRef: 'scope', now: () => 1_000, cleanup: async () => ({ connectedSeconds: 0 }) });
        const a = make(db.first); const b = make(db.second);
        const n1 = await a.createNonce('v1', 'address');
        const first = await a.claimStart(n1, 'v1', 'address');
        const n2 = await b.createNonce('v2', 'address');
        await expect(b.claimStart(n2, 'v2', 'address')).rejects.toThrow();
        const bound = await a.bindRun(first.operationId, 'run');
        await a.control({ ...bound, visitor: 'v1', issuer: 'service', audience: 'ui', runId: 'run' }, 'purge', 'purge');
        expect((await b.claimStart(n2, 'v2', 'address')).operationId).toBeTruthy();
      } finally { await db.close(); }
    });
  });
}
