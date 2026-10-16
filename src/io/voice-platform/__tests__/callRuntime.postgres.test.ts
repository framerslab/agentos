import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlVoiceStore, voicePlatformDdl, VOICE_PLATFORM_TABLES } from '../stores/sql.js';
import { VoiceCallManager } from '../VoiceCallManager.js';
import { CallCredentials, exchangeRequestHash } from '../CallCredentials.js';
import { CreateWebCallSchema } from '../contracts/index.js';
import { storedCall } from './callFixtures.js';
import { managerHooks } from './managerFixtures.js';
import { browserIdentity } from './credentialFixtures.js';
import { slotLimiterContract } from './slotLimiter.contract.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const pools: StorageAdapter[] = []; const prefixes: string[] = [];
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function pair() {
  const prefix = `vpr_${run}_${prefixes.length}`; prefixes.push(prefix);
  const a = createPostgresAdapter({ connectionString: url!, max: 12 }); const b = createPostgresAdapter({ connectionString: url!, max: 12 });
  pools.push(a, b); await a.open(); await b.open(); await a.exec(voicePlatformDdl(prefix));
  return [new SqlVoiceStore({ db: a, tablePrefix: prefix, ensureSchema: false }), new SqlVoiceStore({ db: b, tablePrefix: prefix, ensureSchema: false })] as const;
}
it('the CI job supplies its PostgreSQL service URL', () => { if (process.env.CI) expect(url).toBeTruthy(); });
describe.skipIf(!url)('call runtime on PostgreSQL', () => {
  slotLimiterContract('PostgreSQL slots across pools', pair);
  it('races creation and exchange, recovers after restart and commits one terminal event and usage row', async () => {
    const [a, b] = await pair(); const external = managerHooks(); const identity = browserIdentity(); let now = 1000;
    const makeManager = (store: SqlVoiceStore) => new VoiceCallManager({ store, hooks: external.hooks, now: () => now, workerLeaseMs: 15000 });
    const one = makeManager(a); const two = makeManager(b); const seed = storedCall(); seed.proofKeyThumbprint = identity.thumbprint;
    const request = CreateWebCallSchema.parse({ agentId: 'agent-a', maxDurationSeconds: 600, clientOrigin: seed.clientOrigin, proofKeyThumbprint: seed.proofKeyThumbprint, idempotencyKey: 'create-a' });
    const calls = await Promise.all([one.create({ scopeId: 'scope-a', request, seed }), two.create({ scopeId: 'scope-a', request, seed })]);
    expect(calls[0]!.callId).toBe(calls[1]!.callId); const callId = calls[0]!.callId;
    for (let i = 0; i < 3; i++) await Promise.all([one.advance('scope-a', callId), two.advance('scope-a', callId)]);
    expect(external.effects.filter((x) => ['reserve', 'prepare', 'dispatch'].includes(x))).toEqual(['reserve', 'prepare', 'dispatch']);
    const makeCredentials = (store: SqlVoiceStore) => new CallCredentials({ store, now: () => now, ttlMs: 120000, proofWindowMs: 30000, key: { id: 'test', key: new Uint8Array(32).fill(1) }, authorize: async () => {}, issueMedia: (_binding, token) => ({ url: 'wss://media.example.test/call', token }) });
    const c1 = makeCredentials(a); const c2 = makeCredentials(b); const grant = await c1.issueGrant('scope-a', callId, 'grant-a');
    const requestHash = exchangeRequestHash(callId, grant.grantId, 'exchange-a', seed.clientOrigin);
    const input = { exchangeKey: 'exchange-a', requestHash, proof: identity.proof({ operation: 'connect', callId, credentialId: grant.grantId, origin: seed.clientOrigin, operationKey: 'exchange-a', requestHash, issuedAt: now, nonce: 'proof-a' }) };
    const results = await Promise.all([c1.exchange('scope-a', callId, grant.token, seed.clientOrigin, input), c2.exchange('scope-a', callId, grant.token, seed.clientOrigin, input)]);
    expect(results[0]).toEqual(results[1]);
    const restarted = makeCredentials(b);
    expect(await restarted.exchange('scope-a', callId, grant.token, seed.clientOrigin, input)).toEqual(results[0]);
    const first = results[0]!;
    await restarted.consumeMedia('scope-a', callId, first.token, seed.clientOrigin, first.transportEpoch);
    await expect(c1.consumeMedia('scope-a', callId, first.token, seed.clientOrigin, first.transportEpoch)).rejects.toThrow();
    now = 2000; await one.connected('scope-a', callId, 1, 1);
    now = 2600; await Promise.all([one.requestEnd('scope-a', callId, 'client_stop'), two.requestEnd('scope-a', callId, 'client_stop')]);
    for (let i = 0; i < 12; i++) await Promise.all([one.advance('scope-a', callId), two.advance('scope-a', callId)]);
    expect((await two.get('scope-a', callId))!).toMatchObject({ state: 'ended', usage: { connectedMs: 600, billableSeconds: 1 } });
    expect((await two.events('scope-a', callId)).map((e) => e.type)).toEqual(['call.started', 'call.ended']);
    expect(await a.withTransaction('scope-a', (tx) => tx.list('usage'))).toHaveLength(1);
    expect(external.effects.filter((x) => x === 'settle')).toHaveLength(1);
    expect(await b.withTransaction('scope-b', (tx) => tx.list('credentials'))).toEqual([]);
  });
  afterAll(async () => {
    if (pools[0]) for (const prefix of prefixes) for (const table of VOICE_PLATFORM_TABLES) await pools[0].exec(`DROP TABLE IF EXISTS ${prefix}_${table}`);
    for (const pool of pools) await pool.close();
  });
});
