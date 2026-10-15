import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlDeliveryFence, SqlEventStore, SqlJobStore, SqlOutbox, SqlRunStore, SqlTranscriptStore, meetingStoresDdl, meetingStoresUpgradeDdl } from '../stores/sql.js';
import { SecretBox } from '../signing.js';
import { SealedSecretError } from '../../../../core/llm/auth/sealing.js';
import { DuplicateIdempotencyKeyError, FencedError } from '../stores/types.js';
import { meetingStoreContract } from './store-contract.js';
import { legacyMeetingStoresDdl } from './fixtures/legacy-meeting-ddl.js';
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
  /** Each column of the six tables under a prefix, as `<table>.<column> <type> <nullable> <default>`, sorted. */
  const columnsOf = async (prefix: string): Promise<string[]> => {
    const tables = ['runs', 'jobs', 'turns', 'events', 'outbox', 'run_locks'].map((name) => `${prefix}_${name}`);
    const rows = await db.all<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN (${tables.map(() => '?').join(', ')})`,
      tables
    );
    return rows.map((r) => `${r.table_name.slice(prefix.length + 1)}.${r.column_name} ${r.data_type} ${r.is_nullable} ${r.column_default ?? ''}`).sort();
  };
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
    await runs.update('r1', { lastReportAt: 42 });
    expect((await runs.get('r1'))?.lastReportAt).toBe(42);
    await runs.update('r1', { lastUsageSourceAt: 41 });
    expect((await runs.get('r1'))?.lastUsageSourceAt).toBe(41);
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
  it('stores a turn whose bounds are fractional milliseconds, rounded to whole ones, through append and appendNext', async () => {
    const turns = new SqlTranscriptStore({ db, tablePrefix: PREFIX });
    await turns.append({ runId: 'r1', seq: 1, turnId: 'r1:1', at: 1, text: 'one', startMs: 12.5, endMs: 20.25 });
    expect((await turns.appendNext({ runId: 'r1', at: 2, text: 'two', startMs: 40.4, endMs: 1_000.6 })).seq).toBe(2);
    expect((await turns.read('r1', 0)).map((t) => [t.seq, t.startMs, t.endMs])).toEqual([[1, 13, 20], [2, 40, 1_001]]);
  });
  it('an append of an id that another run\'s append writes meanwhile answers that event\'s sequence, not a unique-index error', async () => {
    const events = new SqlEventStore({ db, tablePrefix: PREFIX });
    let entered!: () => void;
    let release!: () => void;
    const written = new Promise<void>((resolve) => { entered = resolve; });
    const unlock = new Promise<void>((resolve) => { release = resolve; });
    // another run's append of the same id: its row is written and not yet committed
    const other = db.transaction(async (trx) => {
      await trx.run(`INSERT INTO ${PREFIX}_events (run_id, seq, event_id, type, at, data_json, purged) VALUES (?, ?, ?, ?, ?, ?, ?)`, ['r1', 1, 'shared', 'bot:in_call', 1, null, false]);
      entered();
      await unlock;
    });
    await written;
    const second = events.append({ eventId: 'shared', runId: 'r2', type: 'bot:in_call', at: 2 });
    // until the second append waits on the unique index for the first one's transaction
    for (let i = 0; i < 200; i++) {
      const waiting = await db.get<{ n: unknown }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE ?`, [`INSERT INTO ${PREFIX}_events%`]);
      if (Number(waiting?.n) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await other;
    expect(await second).toEqual({ inserted: false, seq: 1 });
    expect(await events.read('r2', 0)).toEqual([]);
    expect(await events.append({ eventId: 'r2-own', runId: 'r2', type: 'bot:in_call', at: 3 })).toEqual({ inserted: true, seq: 1 }); // r2's counter did not move
  });
  it('refuses an adapter that is not Postgres', () => {
    const notPostgres = { kind: 'sqlite', capabilities: new Set(['transactions', 'persistence']) } as unknown as StorageAdapter;
    expect(() => new SqlEventStore({ db: notPostgres, tablePrefix: PREFIX })).toThrow(/Postgres/);
  });
  it('upgrades an existing schema twice, preserving old data and round-tripping the new fields', async () => {
    const prefix = `${PREFIX}_old`;
    const box = new SecretBox(Buffer.alloc(32, 1));
    try {
      await db.exec(legacyMeetingStoresDdl(prefix));
      // a row as an earlier version wrote it, its url sealed with the run id as context
      await db.run(`INSERT INTO ${prefix}_runs
        (run_id, owner_ref, provider_name, platform, state, keep, meeting_url, bot_name, notice_text, notice_version, notice_late_text, stop_phrase, limits_json, requested_at, join_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['old', 'owner', 'mock', 'google_meet', 'requested', 'account', box.seal('https://meet.google.com/abc-defg-hij', 'old'), 'Notes', 'notice', '1', 'notice', 'stop', JSON.stringify(DEFAULT_RUN_LIMITS), 1, 1]);
      await db.transaction((tx) => tx.exec(meetingStoresUpgradeDdl(prefix)));
      await db.transaction((tx) => tx.exec(meetingStoresUpgradeDdl(prefix)));
      // every column a fresh schema has, with its type, nullability and default
      expect(await columnsOf(prefix)).toEqual(await columnsOf(PREFIX));
      const runs = new SqlRunStore({ db, tablePrefix: prefix, box });
      expect((await runs.get('old'))?.botName).toBe('Notes');
      // every run field the upgrade adds a column for, written to and read back from the row the earlier version wrote
      const added = { providerConnectionRef: 'connection-1', leaveCommandedAt: 70, captureSuspendedAt: 71, aloneSince: 72, lastReportAt: 100, lastUsageSourceAt: 80, creationPending: true, creationContext: 'opaque-host-data' };
      await runs.update('old', { ...added, lastUsageAt: 90, reportedSeconds: 60 });
      expect(await runs.get('old')).toMatchObject({ ...added, lastUsageAt: 90, reportedSeconds: 60 });
      const raw = await db.get<{ creation_context: string }>(`SELECT creation_context FROM ${prefix}_runs WHERE run_id = ?`, ['old']);
      expect(raw?.creation_context).not.toContain('opaque-host-data');
      // the turn counter the upgrade adds to the run anchors numbers the run's turns
      const transcript = new SqlTranscriptStore({ db, tablePrefix: prefix });
      expect((await transcript.appendNext({ runId: 'old', at: 5, text: 'first' })).seq).toBe(1);
      expect((await transcript.appendNext({ runId: 'old', at: 6, text: 'second' })).seq).toBe(2);
      const fences = new SqlDeliveryFence({ db, tablePrefix: prefix });
      // no fence until one is written: not on the run, whose anchor row exists, nor on a run that has no row
      expect(await fences.isFenced('old')).toBe(false);
      expect(await fences.isFenced('never-sent')).toBe(false);
      await fences.fence('old');
      expect(await new SqlDeliveryFence({ db, tablePrefix: prefix }).isFenced('old')).toBe(true);
      // the deliveries' fence is not the content fence on the same row
      expect(await transcript.isFenced('old')).toBe(false);
      // the sealed context is bound to its run: copied into another run's row, it does not open there
      await runs.insert({ ...run('other'), creationPending: true, creationContext: 'other-host-data' });
      await db.run(`UPDATE ${prefix}_runs SET creation_context = (SELECT creation_context FROM ${prefix}_runs WHERE run_id = ?) WHERE run_id = ?`, ['old', 'other']);
      await expect(runs.get('other')).rejects.toThrow(SealedSecretError);
      // and to its column: moved into the url's place, it does not open
      await db.run(`UPDATE ${prefix}_runs SET meeting_url = creation_context WHERE run_id = ?`, ['old']);
      await expect(runs.get('old')).rejects.toThrow(SealedSecretError);
      expect(() => meetingStoresUpgradeDdl('Bad prefix')).toThrow();
    } finally {
      for (const name of ['runs', 'jobs', 'turns', 'events', 'outbox', 'run_locks']) await db.exec(`DROP TABLE IF EXISTS ${prefix}_${name}`);
    }
  });
});
