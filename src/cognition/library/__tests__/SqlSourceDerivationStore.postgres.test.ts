import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { createSourceDerivation, type SourceDependencyState, type SourceDeliveryContext } from '../SourceDerivations.js';
import {
  SqlSourceDerivationStore, type SourceDerivationBindings,
  type SourceOwnerScope, type SourceFenceTicket,
} from '../SqlSourceDerivationStore.js';
import { sourceDerivationSchema } from '../sourceDerivationSchema.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const prefix = `sd_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const scope: SourceOwnerScope = { tenantId: 'tenant-a', ownerId: 'owner-a' };
const context: SourceDeliveryContext = { ...scope, surface: 'ask', liveOptIn: false };
const state = (sourceId = 'source-a'): SourceDependencyState => ({
  ...scope, connectionId: 'connection-a', sourceId, generation: 1,
  messageIds: [`${sourceId}-message`], version: 'v1', expiresAt: 4_000,
  connected: true, paused: false, searchAskEnabled: true, liveEnabled: true,
});
const envelope = () => createSourceDerivation([state(), state('source-b')]);

function latch() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

describe.skipIf(!url)('durable personal-source derivations', () => {
  let db: StorageAdapter;
  let other: StorageAdapter;
  let store: SqlSourceDerivationStore;
  let peer: SqlSourceDerivationStore;
  let now = 1_000;
  let failPurge = false;
  let bindings: SourceDerivationBindings;

  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 8 });
    other = createPostgresAdapter({ connectionString: url!, max: 4 });
    await db.open();
    await other.open();
    for (const sql of sourceDerivationSchema(prefix)) await db.exec(sql);
    await db.exec(`CREATE TABLE "${prefix}_fixture_sources" (
      tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      source_id TEXT NOT NULL, state JSONB NOT NULL,
      PRIMARY KEY (tenant_id, owner_id, connection_id, source_id))`);
    await db.exec(`CREATE TABLE "${prefix}_fixture_results" (
      tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (tenant_id, owner_id, id))`);
    bindings = {
      async readCurrent(tx, derivation) {
        const states: SourceDependencyState[] = [];
        for (const dep of derivation.dependencies) {
          const row = await tx.get<{ state: SourceDependencyState }>(
            `SELECT state FROM "${prefix}_fixture_sources"
             WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND source_id=$4`,
            [dep.tenantId, dep.ownerId, dep.connectionId, dep.sourceId],
          );
          if (row) states.push(row.state);
        }
        return states;
      },
      async purgeResults(tx, owner, ids) {
        if (failPurge) throw new Error('fixture_purge_failed');
        await tx.run(`DELETE FROM "${prefix}_fixture_results"
          WHERE tenant_id=$1 AND owner_id=$2 AND id=ANY($3::text[])`,
        [owner.tenantId, owner.ownerId, [...ids]]);
      },
      async purgeSources(tx, owner, affected) {
        await tx.run(`DELETE FROM "${prefix}_fixture_sources"
          WHERE tenant_id=$1 AND owner_id=$2
          AND ($3::text IS NULL OR connection_id=$3)
          AND ($4::text IS NULL OR source_id=$4)`,
        [owner.tenantId, owner.ownerId,
          affected.kind === 'owner' ? null : affected.connectionId,
          affected.kind === 'source' ? affected.sourceId : null]);
      },
    };
    store = new SqlSourceDerivationStore(db, { tablePrefix: prefix, bindings, clock: () => now });
    peer = new SqlSourceDerivationStore(other, { tablePrefix: prefix, bindings, clock: () => now });
  });

  afterAll(async () => {
    if (db) {
      for (const suffix of ['fixture_results', 'fixture_sources', 'edges', 'results', 'tombstones', 'journal', 'owners']) {
        await db.exec(`DROP TABLE IF EXISTS "${prefix}_${suffix}" CASCADE`);
      }
      await db.close();
    }
    await other?.close();
  });

  async function seed(): Promise<SourceFenceTicket> {
    now = 1_000;
    failPurge = false;
    await store.invalidate(scope, { kind: 'owner' }, async () => {});
    expect(await store.activateOwner(scope, async () => true)).toBe(true);
    const ticket = await store.capture(scope);
    if (!ticket) throw new Error('fixture_no_ticket');
    const applied = await store.apply(ticket, async (tx) => {
      for (const source of [state(), state('source-b')]) {
        await tx.run(`INSERT INTO "${prefix}_fixture_sources"
          (tenant_id,owner_id,connection_id,source_id,state) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [source.tenantId, source.ownerId, source.connectionId, source.sourceId, JSON.stringify(source)]);
      }
    });
    expect(applied.kind).toBe('applied');
    return ticket;
  }

  async function save(ticket: SourceFenceTicket, id = 'answer-a') {
    expect(await store.commit(ticket, id, envelope(), 'synthetic mixed answer', context)).toBe(true);
    await store.apply(ticket, (tx) => tx.run(`INSERT INTO "${prefix}_fixture_results"
      (tenant_id,owner_id,id,payload) VALUES ($1,$2,$3,$4)`,
    [scope.tenantId, scope.ownerId, id, 'synthetic saved mark']));
  }

  it('requires explicit active-account authorization and preserves personal mixed provenance', async () => {
    const unused = { tenantId: 'tenant-denied', ownerId: 'owner-denied' };
    expect(await store.capture(unused)).toBeNull();
    expect(await store.activateOwner(unused, async () => false)).toBe(false);
    expect(await store.capture(unused)).toBeNull();
    const ticket = await seed();
    await save(ticket);
    const sent: string[] = [];
    expect(await peer.deliver('answer-a', context, (text) => { sent.push(text); return true; })).toBe(true);
    expect(sent).toEqual(['synthetic mixed answer']);
    for (const surface of ['team', 'guest', 'share', 'export', 'outbound'] as const) {
      expect(await peer.deliver('answer-a', { ...context, surface }, () => {
        throw new Error('fixture_private_result_leaked');
      })).toBe(false);
    }
    expect(await peer.deliver('answer-a', { ...context, ownerId: 'owner-b' }, () => true)).toBe(false);
    expect(await peer.deliver('answer-a', { ...context, tenantId: 'tenant-b' }, () => true)).toBe(false);
  });

  it('deletes the whole mixed result and its saved mark when one source is removed', async () => {
    const ticket = await seed();
    await save(ticket);
    await store.invalidate(scope, { kind: 'source', connectionId: 'connection-a', sourceId: 'source-a' }, async () => {});
    expect(await peer.deliver('answer-a', context, () => true)).toBe(false);
    expect(await db.get(`SELECT id FROM "${prefix}_results" WHERE id=$1`, ['answer-a'])).toBeNull();
    expect(await db.get(`SELECT id FROM "${prefix}_fixture_results" WHERE id=$1`, ['answer-a'])).toBeNull();
    const left = await db.all<{ source_id: string }>(`SELECT source_id FROM "${prefix}_fixture_sources"`);
    expect(left.map((row) => row.source_id)).toEqual(['source-b']);
    expect(await store.commit(ticket, 'late-answer', envelope(), 'late completion', context)).toBe(false);
    expect((await store.apply(ticket, async () => { throw new Error('fixture_stale_write'); })).kind).toBe('stale');
  });

  it('checks expiry without a running cleanup job and purges external expired results', async () => {
    const ticket = await seed();
    await save(ticket);
    now = 4_000;
    expect(await store.deliver('answer-a', context, () => true)).toBe(false);
    expect(await store.commit(ticket, 'expired-answer', envelope(), 'expired', context)).toBe(false);
    expect(await store.expireResults(scope, 10)).toBe(1);
    expect(await db.get(`SELECT id FROM "${prefix}_fixture_results" WHERE id=$1`, ['answer-a'])).toBeNull();
  });

  it('rereads current switches, versions and message membership at delivery', async () => {
    const ticket = await seed();
    await save(ticket);
    for (const patch of [
      { paused: true }, { connected: false }, { searchAskEnabled: false },
      { generation: 2 }, { version: 'v2' }, { messageIds: ['other-message'] },
    ]) {
      await store.apply(ticket, (tx) => tx.run(`UPDATE "${prefix}_fixture_sources"
        SET state=$1::jsonb WHERE source_id=$2`, [JSON.stringify({ ...state(), ...patch }), 'source-a']));
      expect(await store.deliver('answer-a', context, () => true)).toBe(false);
    }
    await store.apply(ticket, (tx) => tx.run(`UPDATE "${prefix}_fixture_sources"
      SET state=$1::jsonb WHERE source_id=$2`, [JSON.stringify(state()), 'source-a']));
    expect(await store.deliver('answer-a', { ...context, surface: 'live', liveOptIn: false }, () => true)).toBe(false);
    expect(await store.deliver('answer-a', { ...context, surface: 'live', liveOptIn: true }, () => true)).toBe(true);
  });

  it('serializes a second worker behind a committed deletion fence', async () => {
    const ticket = await seed();
    await save(ticket);
    const locked = latch();
    const release = latch();
    const removing = store.invalidate(scope, { kind: 'connection', connectionId: 'connection-a' }, async () => {
      locked.release();
      await release.ready;
    });
    await locked.ready;
    const delivery = peer.deliver('answer-a', context, () => { throw new Error('fixture_late_delivery'); });
    release.release();
    await removing;
    expect(await delivery).toBe(false);
    expect(await peer.commit(ticket, 'late', envelope(), 'late', context)).toBe(false);
  });
  it('retains the committed block when content purge fails', async () => { const ticket = await seed(); await save(ticket); await store.blockOwner(scope, async () => {}); failPurge = true; await expect(store.invalidate(scope, { kind: 'owner' }, async () => {})).rejects.toThrow('fixture_purge_failed'); failPurge = false; expect(await store.capture(scope)).toBeNull(); expect(await peer.deliver('answer-a', context, () => true)).toBe(false); expect(await peer.commit(ticket, 'late-blocked', envelope(), 'late', context)).toBe(false); });
  it('rolls back the epoch and the purge together if a binding fails, and writes no deletion record', async () => {
    const ticket = await seed();
    await save(ticket);
    const before = (await store.readTombstones(0, 1_000)).at(-1)!.sequence;
    failPurge = true;
    await expect(store.invalidate(scope, { kind: 'owner' }, async () => {}))
      .rejects.toThrow('fixture_purge_failed');
    failPurge = false;
    expect(await store.capture(scope)).toEqual(ticket);
    expect(await peer.deliver('answer-a', context, () => true)).toBe(true);
    // The record is written last, after every binding, so this failure leaves none to roll back.
    expect(await store.readTombstones(before, 1_000)).toEqual([]);
  });

  it('keeps account deletion disabled, rejects stale CAS invalidation and exports only tombstones', async () => {
    const ticket = await seed();
    await save(ticket);
    await store.invalidate(scope, { kind: 'owner' }, async () => {}, { disableOwner: true });
    expect(await store.capture(scope)).toBeNull();
    expect(await store.activateOwner(scope, async () => false)).toBe(false);
    const stale = await store.invalidate(scope, { kind: 'owner' }, async () => {
      throw new Error('fixture_stale_mutation');
    }, { expected: ticket });
    expect(stale.kind).toBe('stale');
    const records = await store.readTombstones(0, 1_000);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain('synthetic mixed answer');
    expect(JSON.stringify(records)).not.toContain('source-a-message');
  });
  it('does not skip a slower invalidation when a journal cursor advances', async () => { await seed(); const before = (await store.readTombstones(0, 1000)).at(-1)!.sequence; const entered = latch(); const release = latch(); const slow = store.invalidate(scope, { kind: 'source', connectionId: 'connection-a', sourceId: 'source-a' }, async () => { entered.release(); await release.ready; }); await entered.ready; await peer.invalidate({ tenantId: 'tenant-b', ownerId: 'owner-b' }, { kind: 'owner' }, async () => {}); const cursor = (await store.readTombstones(before, 1000)).at(-1)!.sequence; release.release(); await slow; const following = await store.readTombstones(cursor, 1000); expect(following.map((record) => record.ownerId)).toEqual(['owner-a']); });
  it('replays an independent tombstone record before restored reads or jobs resume', async () => {
    const ticket = await seed();
    await save(ticket);
    const before = (await store.readTombstones(0, 1_000)).at(-1)?.sequence ?? 0;
    await store.invalidate(scope, { kind: 'connection', connectionId: 'connection-a' }, async () => {});
    const journal = await store.readTombstones(before, 1_000);
    expect(journal.length).toBe(1);
    // A restored content snapshot must lose all private source material for the affected account.
    await seed();
    const restoredTicket = await store.capture(scope);
    await save(restoredTicket!);
    await store.replayTombstones(journal);
    await store.replayTombstones(journal);
    expect(await store.capture(scope)).toBeNull();
    expect(await store.deliver('answer-a', context, () => true)).toBe(false);
    expect(await db.get(`SELECT id FROM "${prefix}_fixture_results" LIMIT 1`)).toBeNull();
    expect(await db.get(`SELECT source_id FROM "${prefix}_fixture_sources" LIMIT 1`)).toBeNull();
  });

  it('keeps only an invalidation\'s kind and keys in its deletion record, also when replayed', async () => {
    await seed();
    const before = (await store.readTombstones(0, 1_000)).at(-1)!.sequence;
    // A caller without the types can pass more than the scope's keys; a deletion record keeps none of it.
    const note = 'fixture-private-note';
    const source = { kind: 'source' as const, connectionId: 'connection-a', sourceId: 'source-a', note };
    await store.invalidate(scope, source, async () => {});
    const [written] = await store.readTombstones(before, 1_000);
    expect(written?.affected).toEqual({ kind: 'source', connectionId: 'connection-a', sourceId: 'source-a' });
    const connection = { kind: 'connection' as const, connectionId: 'connection-a', note };
    const owner = { kind: 'owner' as const, note };
    await store.replayTombstones([
      { ...written!, id: randomUUID(), affected: connection },
      { ...written!, id: randomUUID(), affected: owner },
    ]);
    const records = await store.readTombstones(before, 1_000);
    expect(records.map((record) => record.affected)).toEqual([
      { kind: 'source', connectionId: 'connection-a', sourceId: 'source-a' },
      { kind: 'connection', connectionId: 'connection-a' },
      { kind: 'owner' },
    ]);
    expect(JSON.stringify(records)).not.toContain(note);
  });

  it('runs in the caller\'s transaction when it is made on a transaction view', async () => {
    const ticket = await seed();
    await save(ticket);
    const before = (await store.readTombstones(0, 1_000)).at(-1)!.sequence;
    await expect(db.transaction(async (tx) => {
      const inner = new SqlSourceDerivationStore(tx, { tablePrefix: prefix, bindings, clock: () => now });
      await inner.invalidate(scope, { kind: 'owner' }, async () => {}, { disableOwner: true });
      expect(await inner.capture(scope)).toBeNull();
      expect(await inner.readTombstones(before, 1_000)).toHaveLength(1);
      throw new Error('fixture_caller_rollback');
    })).rejects.toThrow('fixture_caller_rollback');
    // The caller's rollback takes the epoch, the purge and the deletion record with it.
    expect(await store.capture(scope)).toEqual(ticket);
    expect(await peer.deliver('answer-a', context, () => true)).toBe(true);
    expect(await store.readTombstones(before, 1_000)).toEqual([]);
  });

  /** Waits until PostgreSQL shows a session blocked by the session `pid`, or until `settled` answers true. */
  async function blockedBehind(pid: number, settled: () => boolean): Promise<void> {
    for (let poll = 0; poll < 500 && !settled(); poll += 1) {
      if (await db.get(`SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid])) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('holds a delivery behind an open deletion fence until the fence commits', async () => {
    const ticket = await seed();
    await save(ticket);
    const entered = latch();
    const release = latch();
    let fence = 0;
    const removing = store.invalidate(scope, { kind: 'connection', connectionId: 'connection-a' }, async (tx) => {
      fence = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
      entered.release();
      await release.ready;
    });
    let delivery: Promise<boolean> = Promise.resolve(false);
    try {
      await Promise.race([entered.ready, removing]);
      let settled = false;
      delivery = peer.deliver('answer-a', context, () => { throw new Error('fixture_late_delivery'); });
      delivery.then(() => { settled = true; }, () => { settled = true; });
      await blockedBehind(fence, () => settled);
      expect(settled).toBe(false);
    } finally {
      release.release();
      await Promise.allSettled([removing, delivery]);
    }
    expect((await removing).kind).toBe('applied');
    expect(await delivery).toBe(false);
  });

  it('holds a delivery behind open work under the owner lock', async () => {
    const ticket = await seed();
    await save(ticket);
    const entered = latch();
    const release = latch();
    let holder = 0;
    // Pausing a source in `apply` writes no owner row, so only the owner lock can hold the delivery back.
    const pausing = store.apply(ticket, async (tx) => {
      await tx.run(`UPDATE "${prefix}_fixture_sources" SET state=$1::jsonb WHERE source_id=$2`,
        [JSON.stringify({ ...state(), paused: true }), 'source-a']);
      holder = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
      entered.release();
      await release.ready;
    });
    let delivery: Promise<boolean> = Promise.resolve(false);
    try {
      await Promise.race([entered.ready, pausing]);
      let settled = false;
      delivery = peer.deliver('answer-a', context, () => { throw new Error('fixture_paused_delivery'); });
      delivery.then(() => { settled = true; }, () => { settled = true; });
      await blockedBehind(holder, () => settled);
      expect(settled).toBe(false);
    } finally {
      release.release();
      await Promise.allSettled([pausing, delivery]);
    }
    expect((await pausing).kind).toBe('applied');
    expect(await delivery).toBe(false);
  });

  it('commits no later deletion record while an earlier sequence is open', async () => {
    await seed();
    const before = (await store.readTombstones(0, 1_000)).at(-1)!.sequence;
    const drawn = latch();
    const release = latch();
    let writer = 0;
    // Another writer in the state a deletion record's writer is in just before it commits: it holds the journal row
    // and has drawn the next sequence.
    const open = other.transaction(async (tx) => {
      await tx.run(`INSERT INTO "${prefix}_journal" (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      await tx.get(`SELECT id FROM "${prefix}_journal" WHERE id=1 FOR UPDATE`);
      writer = (await tx.get<{ pid: number }>('SELECT pg_backend_pid() AS pid'))!.pid;
      await tx.run(`INSERT INTO "${prefix}_tombstones" (id,tenant_id,owner_id,epoch,at_ms,affected,owner_disabled)
        VALUES ($1,'tenant-c','owner-c',1,1,'{"kind":"owner"}'::jsonb,TRUE)`, [randomUUID()]);
      drawn.release();
      await release.ready;
    });
    let later: Promise<unknown> = Promise.resolve();
    try {
      await Promise.race([drawn.ready, open]);
      let settled = false;
      later = store.invalidate({ tenantId: 'tenant-b', ownerId: 'owner-b' }, { kind: 'owner' }, async () => {});
      later.then(() => { settled = true; }, () => { settled = true; });
      await blockedBehind(writer, () => settled);
      expect(settled).toBe(false);
      expect(await store.readTombstones(before, 1_000)).toEqual([]);
    } finally {
      release.release();
      await Promise.allSettled([open, later]);
    }
    await open;
    await later;
    const records = await store.readTombstones(before, 1_000);
    expect(records.map((record) => record.ownerId)).toEqual(['owner-c', 'owner-b']);
  });
});
