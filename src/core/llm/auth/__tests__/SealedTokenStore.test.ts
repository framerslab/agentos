import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSecret, SealedSecretError, type SealingKey } from '../sealing.js';
import { SealedTokenStore, type SealedBytesStore } from '../SealedTokenStore.js';
import type { OAuthTokenSet } from '../types.js';

const k1: SealingKey = { id: 'k1', key: randomBytes(32) };
const k2: SealingKey = { id: 'k2', key: randomBytes(32) };

const GRANT: OAuthTokenSet = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 1_900_000_000_000,
  idToken: 'id-1',
  metadata: { scope: 'files.read' },
};

/** The three functions over a Map, as a caller's table gives them. */
function mapValues(): { rows: Map<string, string>; values: SealedBytesStore } {
  const rows = new Map<string, string>();
  return {
    rows,
    values: {
      get: async (key) => rows.get(key) ?? null,
      set: async (key, sealed) => {
        rows.set(key, sealed);
      },
      delete: async (key) => {
        rows.delete(key);
      },
    },
  };
}

/**
 * Tests for {@link SealedTokenStore}: a grant's refresh token and metadata kept sealed under the caller's key, bound
 * to the key it is kept under, and never an access token or an id token.
 */
describe('SealedTokenStore', () => {
  it('keeps one sealed text with the refresh token and metadata, and neither the access token nor the id token', async () => {
    const { rows, values } = mapValues();
    const store = new SealedTokenStore(values, { current: k1 });

    await store.save('connection-1', GRANT);

    expect([...rows.keys()]).toEqual(['connection-1']);
    const sealed = rows.get('connection-1') ?? '';
    expect(sealed.startsWith('v1.k1.')).toBe(true);
    for (const plain of ['access-1', 'refresh-1', 'id-1', 'files.read']) expect(sealed).not.toContain(plain);
    const kept = JSON.parse(Buffer.from(openSecret(sealed, [k1], 'connection-1')).toString('utf8')) as Record<string, unknown>;
    expect(kept).toEqual({ refreshToken: 'refresh-1', metadata: { scope: 'files.read' } });
    expect(kept).not.toHaveProperty('accessToken');
    expect(kept).not.toHaveProperty('idToken');
  });

  it('loads the refresh token and metadata with an empty access token that has expired, from the key it was kept under alone', async () => {
    const { rows, values } = mapValues();
    const store = new SealedTokenStore(values, { current: k1 });
    await store.save('connection-1', GRANT);

    expect(await store.load('connection-1')).toEqual({
      accessToken: '',
      expiresAt: 0,
      refreshToken: 'refresh-1',
      metadata: { scope: 'files.read' },
    });

    // The sealed text copied to another key does not open there.
    rows.set('connection-2', rows.get('connection-1') ?? '');
    await expect(store.load('connection-2')).rejects.toBeInstanceOf(SealedSecretError);
  });

  it('answers null for a key it does not keep', async () => {
    const store = new SealedTokenStore(mapValues().values, { current: k1 });

    expect(await store.load('connection-unknown')).toBeNull();
  });

  it('deletes a kept grant on clear', async () => {
    const { rows, values } = mapValues();
    const store = new SealedTokenStore(values, { current: k1 });
    await store.save('connection-1', GRANT);

    await store.clear('connection-1');

    expect(rows.has('connection-1')).toBe(false);
    expect(await store.load('connection-1')).toBeNull();
  });

  it('reads what a previous key sealed and seals anew with the current key at the next save', async () => {
    const { rows, values } = mapValues();
    await new SealedTokenStore(values, { current: k1 }).save('connection-1', GRANT);
    const turned = new SealedTokenStore(values, { current: k2, previous: [k1] });

    const loaded = await turned.load('connection-1');
    if (loaded === null) throw new Error('the grant kept under the previous key did not load');
    expect(loaded.refreshToken).toBe('refresh-1');

    await turned.save('connection-1', loaded);

    expect(rows.get('connection-1')?.startsWith('v1.k2.')).toBe(true);
    expect((await turned.load('connection-1'))?.refreshToken).toBe('refresh-1');
    // Once sealed anew, the previous key alone no longer opens it.
    await expect(new SealedTokenStore(values, { current: k1 }).load('connection-1')).rejects.toMatchObject({ reason: 'key' });
  });
});
