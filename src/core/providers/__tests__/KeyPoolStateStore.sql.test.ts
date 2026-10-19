import { afterAll, describe, expect, it } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { KEY_POOL_STATE_DDL, SqlKeyPoolStateStore, keyPoolStateDdl, type KeyState } from '../KeyPoolStateStore.js';
import { ApiKeyPool } from '../ApiKeyPool.js';

const databases: StorageAdapter[] = [];

async function db(): Promise<StorageAdapter> {
  const adapter = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  databases.push(adapter);
  return adapter;
}

afterAll(async () => {
  for (const adapter of databases) await adapter.close();
});

function state(partial: Partial<KeyState> & Pick<KeyState, 'fingerprint'>): KeyState {
  return { label: 'k0', status: 'ok', failures: 0, updatedAt: 1, version: 1, ...partial };
}

describe('SqlKeyPoolStateStore', () => {
  it('exports checked-prefix DDL', () => {
    expect(keyPoolStateDdl()).toBe(KEY_POOL_STATE_DDL);
    expect(keyPoolStateDdl('private')).toContain('CREATE TABLE IF NOT EXISTS private_key_pool_state');
    expect(() => keyPoolStateDdl('9bad')).toThrow();
    expect(() => keyPoolStateDdl('x'.repeat(39))).toThrow();
  });

  it('saves one row per pool and key, newest wins, and loads only version 1 rows', async () => {
    const store = new SqlKeyPoolStateStore({ db: await db(), tablePrefix: 'kp' });
    await store.save('p', state({ fingerprint: 'aaaaaaaaaaaa', status: 'failed', kind: 'auth', failures: 1, updatedAt: 10 }));
    await store.save('p', state({ fingerprint: 'aaaaaaaaaaaa', status: 'ok', updatedAt: 5 })); // older: ignored
    await store.save('p', state({ fingerprint: 'bbbbbbbbbbbb', status: 'resting', kind: 'quota', until: 99, updatedAt: 7 }));
    await store.save('q', state({ fingerprint: 'aaaaaaaaaaaa', status: 'ok', updatedAt: 20 }));
    const rows = await store.load('p');
    expect(rows?.map((r) => [r.fingerprint, r.status]).sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['aaaaaaaaaaaa', 'failed'],
      ['bbbbbbbbbbbb', 'resting'],
    ]);
    expect(await store.load('none')).toBeNull();
    await store.save('p', state({ fingerprint: 'aaaaaaaaaaaa', status: 'ok', updatedAt: 30 })); // newer: applied
    expect((await store.load('p'))?.find((r) => r.fingerprint === 'aaaaaaaaaaaa')?.status).toBe('ok');
  });

  it('skips a row of another version, and one that does not parse, with one warning per load', async () => {
    const adapter = await db();
    const lines: Array<{ event: string; meta?: Record<string, unknown> }> = [];
    const logger = {
      info: () => undefined,
      warn: (event: string, meta?: Record<string, unknown>) => {
        lines.push({ event, meta });
      },
      error: () => undefined,
    };
    const store = new SqlKeyPoolStateStore({ db: adapter, tablePrefix: 'kpv', logger });
    await store.save('p', state({ fingerprint: 'aaaaaaaaaaaa', status: 'failed', kind: 'auth', failures: 1, updatedAt: 10 }));
    // Rows a later version of the library wrote, and one whose state is not JSON.
    await adapter.run('INSERT INTO kpv_key_pool_state (pool_id, fingerprint, state, version, updated_at) VALUES (?, ?, ?, 2, ?)', [
      'p',
      'bbbbbbbbbbbb',
      JSON.stringify({ ...state({ fingerprint: 'bbbbbbbbbbbb' }), version: 2 }),
      20,
    ]);
    await adapter.run('INSERT INTO kpv_key_pool_state (pool_id, fingerprint, state, version, updated_at) VALUES (?, ?, ?, 1, ?)', ['p', 'cccccccccccc', 'not json', 30]);
    const rows = await store.load('p');
    expect(rows?.map((r) => r.fingerprint)).toEqual(['aaaaaaaaaaaa']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'key_pool.store_failed', meta: { poolId: 'p', op: 'load', reason: 'version', skipped: 2, version: 2 } });
    expect(JSON.stringify(lines)).not.toContain('not json');
    // A load with nothing to skip writes nothing.
    expect(await store.load('none')).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it('leaves the schema to host migrations when told to', async () => {
    const adapter = await db();
    const store = new SqlKeyPoolStateStore({ db: adapter, tablePrefix: 'manual', ensureSchema: false });
    await expect(store.load('p')).rejects.toThrow();
    await adapter.exec(keyPoolStateDdl('manual'));
    expect(await store.load('p')).toBeNull();
    expect(JSON.stringify(store)).toBe('"[SqlKeyPoolStateStore]"');
  });

  it('carries a pool\'s failed key across a restart and merges two instances by key', async () => {
    const adapter = await db();
    const store = new SqlKeyPoolStateStore({ db: adapter });
    const first = new ApiKeyPool('sk_credited,sk_paid', { strategy: 'ordered', id: 'anthropic:ANTHROPIC_API_KEY', store });
    await first.ready();
    first.markFailed('sk_credited', 'billing');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rows = await store.load('anthropic:ANTHROPIC_API_KEY');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('sk_credited');

    const second = new ApiKeyPool('sk_credited,sk_paid', { strategy: 'ordered', id: 'anthropic:ANTHROPIC_API_KEY', store });
    await second.ready();
    expect(second.snapshot()[0]).toMatchObject({ status: 'failed', kind: 'billing' });
    expect(second.next()).toBe('sk_paid');

    second.markSuccess('sk_credited');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const third = new ApiKeyPool('sk_credited,sk_paid', { strategy: 'ordered', id: 'anthropic:ANTHROPIC_API_KEY', store });
    await third.ready();
    expect(third.snapshot()[0].status).toBe('ok');
  });
});
