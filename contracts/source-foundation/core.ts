import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { PostgresVectorStore } from '@framers/agentos/cognition/rag';
import {
  createSourceDerivation, canDeliverSourceDerivation, sourceDerivationSchema,
  SqlSourceDerivationStore, type SourceDependencyState, type SourceDerivationBindings,
} from '@framers/agentos/cognition/library';
import {
  RedirectOAuthFlow, SealedTokenStore, type RedirectOAuthConfig,
  type SealedBytesStore, type SealingKeys,
} from '@framers/agentos/auth';
import {
  createLogger, enableContentSafeTelemetry, isContentSafeTelemetryEnabled,
  type ContentSafeLogEvent,
} from '@framers/agentos/logging';

const database = process.env.AGENTOS_TEST_POSTGRES_URL;
assert.ok(database, 'foundation_database_required');
const prefix = `fc_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const owner = { tenantId: 'tenant-a', ownerId: 'owner-a' };
const now = 1_000_000;
const dependency: SourceDependencyState = {
  ...owner, connectionId: 'connection-a', sourceId: 'source-a', generation: 1,
  messageIds: ['message-a'], version: 'version-a', expiresAt: now + 60_000,
  connected: true, paused: false, searchAskEnabled: true, liveEnabled: false,
};
const context = { ...owner, surface: 'ask' as const, liveOptIn: false };

class FixtureOAuthFlow extends RedirectOAuthFlow {
  readonly providerId = 'fixture';
  protected getConfig(): RedirectOAuthConfig {
    return { clientId: 'fixture-client', scopes: ['fixture.read'],
      authorizationEndpoint: 'https://provider.invalid/authorize',
      tokenEndpoint: 'https://provider.invalid/token', revocationEndpoint: 'https://provider.invalid/revoke' };
  }
}

test('installed core exports preserve atomic vectors, derivation fences and sealed grants', async () => {
  const db = createPostgresAdapter({ connectionString: database, max: 6 });
  const observer = createPostgresAdapter({ connectionString: database, max: 3 });
  let vectors: PostgresVectorStore | undefined;
  try {
    await db.open(); await observer.open();
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    for (const sql of sourceDerivationSchema(prefix)) await db.exec(sql);
    for (const sql of PostgresVectorStore.schemaSql('chunks', 3, {
      tablePrefix: `${prefix}_`, textSearchConfig: 'simple',
    })) await db.exec(sql);
    await db.exec(`CREATE TABLE "${prefix}_host" (id TEXT PRIMARY KEY,body TEXT NOT NULL)`);
    vectors = new PostgresVectorStore({ id: 'consumer', type: 'postgres', adapter: db,
      manageSchema: false, defaultDimension: 3, tablePrefix: `${prefix}_`, textSearchConfig: 'simple' });
    await vectors.initialize();
    const bindings: SourceDerivationBindings = {
      readCurrent: async () => [dependency],
      purgeResults: async (tx, _scope, ids) => {
        await tx.run(`DELETE FROM "${prefix}_host" WHERE id=ANY($1::text[])`, [[...ids]]);
      },
      purgeSources: async () => {},
    };
    const fence = new SqlSourceDerivationStore(db, { tablePrefix: prefix, clock: () => now, bindings });
    const peer = new SqlSourceDerivationStore(observer, { tablePrefix: prefix, clock: () => now, bindings });
    assert.equal(await fence.activateOwner(owner, async () => true), true);
    const ticket = await fence.capture(owner); assert.ok(ticket);
    let borrowed: PostgresVectorStore | undefined;
    await assert.rejects(db.transaction(async (tx: StorageAdapter) => {
      await tx.transaction(async (nested: StorageAdapter) => {
        await nested.run(`INSERT INTO "${prefix}_host" VALUES($1,$2)`, ['rollback', 'fixture body']);
      });
      await vectors!.withStorageTransaction(tx, async (view) => {
        borrowed = view;
        await view.upsert('chunks', [{ id: 'rollback', embedding: [1, 0, 0],
          textContent: 'fixture budget', metadata: { tenantId: owner.tenantId, sourceId: 'source-a' } }]);
        assert.equal((await view.fetchByIds('chunks', ['rollback'])).length, 1);
      });
      assert.equal(await observer.get(`SELECT id FROM "${prefix}_host" WHERE id=$1`, ['rollback']), null);
      assert.equal(await observer.get(`SELECT id FROM "${prefix}_chunks" WHERE id=$1`, ['rollback']), null);
      throw new Error('fixture_rollback');
    }), /fixture_rollback/);
    assert.equal(await db.get(`SELECT id FROM "${prefix}_host" WHERE id=$1`, ['rollback']), null);
    assert.equal((await vectors.fetchByIds('chunks', ['rollback'])).length, 0);
    await assert.rejects(borrowed!.fetchByIds('chunks', ['rollback']), /vector_transaction_closed/);

    const installed = await fence.apply(ticket, async (tx) => {
      await tx.run(`INSERT INTO "${prefix}_host" VALUES($1,$2)`, ['source-a', 'fixture budget']);
      await vectors!.withStorageTransaction(tx, async (view) => {
        await view.upsert('chunks', [{ id: 'source-a', embedding: [1, 0, 0],
          textContent: 'fixture budget', metadata: { tenantId: owner.tenantId, sourceId: 'source-a' } }]);
      });
      return 'committed';
    });
    assert.equal(installed.kind, 'applied');
    const filter = { tenantId: owner.tenantId, sourceId: { $exists: true } };
    assert.deepEqual((await vectors.lexicalSearch('chunks', 'budget', { filter })).documents.map((d) => d.id), ['source-a']);
    assert.equal((await vectors.query('chunks', [1, 0, 0], { filter })).documents.length, 1);
    const derivation = createSourceDerivation([dependency]);
    assert.equal(canDeliverSourceDerivation(derivation, context, [dependency], now), true);
    assert.equal(canDeliverSourceDerivation(derivation, { ...context, surface: 'share' }, [dependency], now), false);
    assert.equal(await fence.commit(ticket, 'answer-a', derivation, 'fixture whole answer', context), true);
    assert.equal(await peer.deliver('answer-a', context, (text) => text === 'fixture whole answer'), true);
    await peer.blockOwner(owner, async () => {});
    assert.equal(await fence.deliver('answer-a', context, () => true), false);
    assert.deepEqual(await fence.apply(ticket, async () => 'forbidden'), { kind: 'stale' });
    assert.ok((await fence.readTombstones(0, 100)).some((row) => row.ownerDisabled));
    await vectors.close();
    assert.deepEqual(await db.get('SELECT 1 AS n'), { n: 1 });
  } finally {
    await vectors?.close(); await db.close(); await observer.close();
  }

  const bytes = new Map<string, string>();
  const values: SealedBytesStore = { get: async (key) => bytes.get(key) ?? null,
    set: async (key, sealed) => { bytes.set(key, sealed); }, delete: async (key) => { bytes.delete(key); } };
  const keys: SealingKeys = { current: { id: 'fixture', key: new Uint8Array(32).fill(7) } };
  const tokens = new SealedTokenStore(values, keys, { namespace: 'fixture-owner-a' });
  await tokens.save('grant', { accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    idToken: 'fixture-identity', expiresAt: now + 60_000, metadata: { scope: 'fixture.read' } });
  const raw = bytes.get('grant')!;
  for (const value of ['fixture-access', 'fixture-refresh', 'fixture-identity']) assert.equal(raw.includes(value), false);
  assert.equal((await tokens.load('grant'))?.accessToken, '');
  assert.equal((await tokens.load('grant'))?.refreshToken, 'fixture-refresh');
  await assert.rejects(new SealedTokenStore(values, keys, { namespace: 'fixture-owner-b' }).load('grant'));
  let network = 0;
  const flow = new FixtureOAuthFlow(tokens, async () => { network++; return new Response('{}'); });
  const start = flow.begin({ redirectUri: 'https://consumer.invalid/callback' });
  assert.equal(new URL(start.url).searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(flow.complete({ code: 'fixture-code', state: 'wrong', expectedState: start.state,
    codeVerifier: start.codeVerifier, redirectUri: 'https://consumer.invalid/callback' }));
  assert.equal(network, 0);
});

test('installed logging mode exposes only its fixed event contract', () => {
  const events: ContentSafeLogEvent[] = [];
  const logger = createLogger('fixture-sensitive-binding', { value: 'fixture-private-metadata' });
  const sink = (event: ContentSafeLogEvent) => { events.push(event); };
  enableContentSafeTelemetry(sink); enableContentSafeTelemetry(sink);
  assert.equal(isContentSafeTelemetryEnabled(), true);
  logger.error('fixture-private-message', { error: new Error('fixture-private-exception') });
  assert.deepEqual(events, [{ kind: 'library_event', state: 'error', n: 1 }]);
  assert.throws(() => enableContentSafeTelemetry(() => {}));
});
