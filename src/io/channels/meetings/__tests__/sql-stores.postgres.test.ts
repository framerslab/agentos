import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlEventStore, SqlJobStore, SqlOutbox, SqlRunStore, SqlTranscriptStore, meetingStoresDdl } from '../stores/sql.js';
import { SecretBox } from '../signing.js';
import { DuplicateIdempotencyKeyError, FencedError } from '../stores/types.js';
import { meetingStoreContract } from './store-contract.js';
import { DEFAULT_RUN_LIMITS, type MeetingRunRecord } from '../types.js';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;
let PREFIX: string;
let prefixSeq = 0;

describeIfPostgres('the Postgres meeting stores', () => {
  let db: StorageAdapter;
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 10 });
    await db.open();
  });
  beforeEach(async () => {
    PREFIX = `mt_${Date.now().toString(36)}_${++prefixSeq}`;
    await db.exec(meetingStoresDdl(PREFIX));
  });
  afterEach(async () => {
    for (const t of ['runs', 'jobs', 'turns', 'events', 'outbox', 'run_locks']) await db.exec(`DROP TABLE IF EXISTS ${PREFIX}_${t}`);
  });
  afterAll(async () => { await db.close(); });
  const run = (id: string): MeetingRunRecord => ({ runId: id, ownerRef: 'a', providerName: 'mock', platform: 'google_meet', state: 'requested', keep: 'account', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: DEFAULT_RUN_LIMITS, requestedAt: 1, joinAt: 1, billedSeconds: 0, idempotencyKey: `k-${id}` });

  meetingStoreContract('shared Postgres contracts', async () => {
    const prefix = `mc_${Date.now().toString(36)}_${++prefixSeq}`;
    await db.exec(meetingStoresDdl(prefix));
    const options = { db, tablePrefix: prefix };
    return {
      runs: new SqlRunStore({ ...options, box: new SecretBox(Buffer.alloc(32, 1)) }),
      jobs: new SqlJobStore(options), transcript: new SqlTranscriptStore(options),
      events: new SqlEventStore(options), outbox: new SqlOutbox(options),
      close: async () => {
        for (const table of ['runs', 'jobs', 'turns', 'events', 'outbox', 'run_locks']) await db.exec(`DROP TABLE IF EXISTS ${prefix}_${table}`);
      },
    };
  });

  it('seals the meeting url at rest and opens it on read; updates only from the expected state', async () => {
    const runs = new SqlRunStore({ db, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 1)) });
    await runs.insert({ ...run('r1'), leaveCommandedAt: 5, captureSuspendedAt: 6, aloneSince: 7 });
    const raw = await db.get<{ meeting_url: string }>(`SELECT meeting_url FROM ${PREFIX}_runs WHERE run_id = ?`, ['r1']);
    expect(raw?.meeting_url.startsWith('v1.')).toBe(true);
    expect(await runs.get('r1')).toMatchObject({ meetingUrl: 'https://meet.google.com/abc-defg-hij', leaveCommandedAt: 5, captureSuspendedAt: 6, aloneSince: 7 });
    expect(await runs.update('r1', { state: 'joining' }, 'scheduled')).toBeUndefined();
    expect((await runs.update('r1', { state: 'dispatching', dispatchedAt: 5 }, ['requested', 'scheduled']))?.state).toBe('dispatching');
    expect((await runs.findByIdempotencyKey('a', 'k-r1'))?.runId).toBe('r1');
  });
  it('reads an old sealed row with previousKeys and reseals it with the current key on update', async () => {
    const previousKey = Buffer.alloc(32, 1);
    const currentKey = Buffer.alloc(32, 2);
    const oldRuns = new SqlRunStore({ db, tablePrefix: PREFIX, box: new SecretBox(previousKey) });
    await oldRuns.insert(run('rotated'));
    const currentOnly = new SqlRunStore({ db, tablePrefix: PREFIX, box: new SecretBox(currentKey) });
    await expect(currentOnly.get('rotated')).rejects.toThrow();
    const rotated = new SqlRunStore({ db, tablePrefix: PREFIX, box: new SecretBox(currentKey, { previousKeys: [previousKey] }) });
    expect((await rotated.get('rotated'))?.meetingUrl).toBe(run('rotated').meetingUrl);
    await rotated.update('rotated', { state: 'dispatching' }, 'requested');
    expect((await currentOnly.get('rotated'))?.meetingUrl).toBe(run('rotated').meetingUrl);
    await expect(oldRuns.get('rotated')).rejects.toThrow();
    const raw = await db.get<{ meeting_url: string }>(`SELECT meeting_url FROM ${PREFIX}_runs WHERE run_id = ?`, ['rotated']);
    expect(raw?.meeting_url.startsWith('v1.box.')).toBe(true);
    expect(new SecretBox(currentKey).open(raw!.meeting_url, 'rotated')).toBe(run('rotated').meetingUrl);
    expect(() => new SecretBox(currentKey).open(raw!.meeting_url, 'another-run')).toThrow();
  });
  it('maps an owner-key conflict to the public error and binds sealed text to the run id', async () => {
    const runs = new SqlRunStore({ db, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 1)) });
    await runs.insert(run('r1'));
    await expect(runs.insert({ ...run('r2'), idempotencyKey: 'k-r1' })).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    await runs.insert(run('r2'));
    await db.run(`UPDATE ${PREFIX}_runs SET meeting_url = (SELECT meeting_url FROM ${PREFIX}_runs WHERE run_id = ?) WHERE run_id = ?`, ['r1', 'r2']);
    await expect(runs.get('r2')).rejects.toThrow();
  });
  it('a run update re-reads under the anchor and cannot overwrite a committed purge', async () => {
    const runs = new SqlRunStore({ db, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 1)) });
    await runs.insert({ ...run('r1'), state: 'in_call' });
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const unlock = new Promise<void>((resolve) => { release = resolve; });
    const purging = db.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${PREFIX}_run_locks (run_id) VALUES (?) ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id`, ['r1']);
      entered();
      await unlock;
      await trx.run(`UPDATE ${PREFIX}_run_locks SET fenced_at = ? WHERE run_id = ?`, [1, 'r1']);
      await trx.run(`UPDATE ${PREFIX}_runs SET state = 'purging' WHERE run_id = ?`, ['r1']);
    });
    await locked;
    const stale = runs.update('r1', { state: 'left' }, 'in_call');
    release();
    await purging;
    expect(await stale).toBeUndefined();
    expect((await runs.get('r1'))?.state).toBe('purging');
  });
  it('leases one job to one of two concurrent takers', async () => {
    const jobs = new SqlJobStore({ db, tablePrefix: PREFIX });
    await jobs.schedule({ runId: 'j1', dispatchAt: 0 });
    const [a, b] = await Promise.all([jobs.lease('m1', 10, 1000), jobs.lease('m2', 10, 1000)]);
    expect([a?.runId, b?.runId].filter(Boolean)).toEqual(['j1']);
    const holder = a ? 'm1' : 'm2';
    expect(await jobs.renew('j1', holder === 'm1' ? 'm2' : 'm1', 20, 1000)).toBe(false);
    expect(await jobs.renew('j1', holder, 20, 1000)).toBe(true);
    expect(await jobs.markDispatched('j1', holder, 'w1')).toEqual({ recorded: true, cancelled: false });
    expect(await jobs.cancel('j1')).toBe('already_dispatched');
    expect((await jobs.listDispatched()).map((j) => j.runId)).toContain('j1');
    await jobs.schedule({ runId: 'j2', dispatchAt: 0 });
    await jobs.lease('m1', 10, 1000);
    expect(await jobs.cancel('j2')).toBe('cancelled');
    expect(await jobs.markDispatched('j2', 'm1', 'w1')).toEqual({ recorded: true, cancelled: true });
    expect(await jobs.release('j1', holder, 50_000)).toBe(true);
    expect((await jobs.get('j1'))?.dispatchAt).toBe(50_000);
  });
  it.each(['insert', 'replace'] as const)('%s waits for the run anchor before writing content', async (operation) => {
    // A separate single-connection adapter makes the session lock timeout apply to every write below.
    const writer = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 1 });
    await writer.open();
    try {
      await writer.run("SET lock_timeout = '100ms'");
      const runs = new SqlRunStore({ db: writer, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 1)) });
      const record = run('locked');
      if (operation === 'replace') await runs.insert(record);
      await db.transaction(async (trx) => {
        await trx.run(`INSERT INTO ${PREFIX}_run_locks (run_id) VALUES (?) ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id`, [record.runId]);
        await expect(runs[operation]({ ...record, botName: 'Changed' })).rejects.toMatchObject({ code: '55P03' });
        const row = await trx.get<{ bot_name: string }>(`SELECT bot_name FROM ${PREFIX}_runs WHERE run_id = ?`, [record.runId]);
        expect(row?.bot_name).toBe(operation === 'replace' ? 'Notes' : undefined);
      });
      await runs[operation]({ ...record, botName: 'Changed' });
      expect((await runs.get(record.runId))?.botName).toBe('Changed');
    } finally {
      await writer.close();
    }
  });
  it('fences the transcript under the run lock, numbers events one at a time, deduplicates, stores no payload behind the fence, backs the outbox off and scrubs only content deliveries', async () => {
    const turns = new SqlTranscriptStore({ db, tablePrefix: PREFIX });
    await turns.append({ runId: 'r1', seq: 1, turnId: 'r1:1', at: 1, text: 'one' });
    await turns.fence('r1');
    await expect(turns.append({ runId: 'r1', seq: 2, turnId: 'r1:2', at: 2, text: 'late' })).rejects.toBeInstanceOf(FencedError);
    await turns.purge('r1');
    expect(await turns.read('r1', 0)).toEqual([]);
    expect(await turns.isFenced('r1')).toBe(true);
    const events = new SqlEventStore({ db, tablePrefix: PREFIX });
    expect(await events.append({ eventId: 'e1', runId: 'r2', type: 'bot:in_call', at: 1 })).toEqual({ inserted: true, seq: 1 });
    expect(await events.append({ eventId: 'e2', runId: 'r2', type: 'bot:chat_message', at: 2, data: { text: 'hi' } })).toEqual({ inserted: true, seq: 2 });
    expect(await events.append({ eventId: 'e1', runId: 'r2', type: 'bot:in_call', at: 1 })).toEqual({ inserted: false, seq: 1 });
    const concurrent = await Promise.all([3, 4, 5, 6].map((n) => events.append({ eventId: `c${n}`, runId: 'r2', type: 'bot:usage', at: n })));
    expect(concurrent.map((c) => c.seq).sort((a, b) => a - b)).toEqual([3, 4, 5, 6]); // one at a time under the run lock: no two take one number
    const same = await Promise.all([1, 2].map(() => events.append({ eventId: 'twice', runId: 'r2', type: 'bot:usage', at: 7 })));
    expect(same.filter((s) => s.inserted).length).toBe(1);
    await events.fence('r2');
    await events.purgePayloads('r2');
    expect(await events.append({ eventId: 'e9', runId: 'r2', type: 'bot:chat_message', at: 9, data: { text: 'late' } })).toMatchObject({ inserted: true });
    const [purgedEvent] = await events.read('r2', 1);
    expect(purgedEvent).toMatchObject({ type: 'bot:chat_message', purged: true });
    expect(purgedEvent.data).toBeUndefined();
    const lateEvent = (await events.read('r2', 0)).at(-1);
    expect(lateEvent).toMatchObject({ eventId: 'e9', purged: true });
    expect(lateEvent?.data).toBeUndefined();
    const outbox = new SqlOutbox({ db, tablePrefix: PREFIX });
    await outbox.enqueue({ id: 'd1', runId: 'r3', destinationRef: 'h', eventId: 'e2', type: 'bot:chat_message', payload: '{}' }, 0);
    await outbox.enqueue({ id: 'd2', runId: 'r3', destinationRef: 'h', eventId: 'e2', type: 'bot:chat_message', payload: '{"text":"y"}' }, 0);
    await outbox.markDelivered('d2');
    await outbox.markFailed('d1', 0);
    expect(await outbox.due(4_999)).toEqual([]);
    expect((await outbox.due(5_000)).length).toBe(1);
    await outbox.enqueue({ id: 'd3', runId: 'r3', destinationRef: 'h', eventId: 'done', type: 'bot:done', payload: '{"billedSeconds":90}' }, 0);
    await outbox.purgeContent('r3');
    const deliveries = await outbox.listByRun('r3');
    for (const d of deliveries.filter((d) => d.id !== 'd3')) expect(d).toMatchObject({ payload: '', type: 'bot:purged', purged: true });
    expect(deliveries.find((d) => d.id === 'd3')).toMatchObject({ type: 'bot:done', payload: '{"billedSeconds":90}', purged: false });
  });
  it('refuses an adapter that is not Postgres', () => {
    const notPostgres = { kind: 'sqlite', capabilities: new Set(['transactions', 'persistence']) } as unknown as StorageAdapter;
    expect(() => new SqlEventStore({ db: notPostgres, tablePrefix: PREFIX })).toThrow(/Postgres/);
  });
});
