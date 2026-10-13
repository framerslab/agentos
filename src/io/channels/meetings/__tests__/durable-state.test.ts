import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { removeDurableJson, writeDurableJson } from '../durableJson.js';
import { MemoryDurableInbox, SqlDurableInbox, durableInboxDdl, type IDurableInbox } from '../DurableInbox.js';
import { SqlRunStore, meetingStoresDdl } from '../stores/sql.js';
import { connectionRuns, meetingProvenanceDdl } from '../stores/provenance.js';
import { SecretBox } from '../signing.js';
import { DEFAULT_RUN_LIMITS, contentFreeRun, type MeetingRunRecord } from '../types.js';

type Delivery = { token: string; at: number };

/** What both inboxes keep to: a payload stays pending until it is acknowledged, and an id is accepted once, acknowledged or not. */
async function keepsDeliveriesUntilAcknowledged(inbox: IDurableInbox<Delivery>, reopen?: () => IDurableInbox<Delivery>): Promise<void> {
  expect(await inbox.accept({ id: 'e1', acceptedAt: 10, value: { token: 'not-a-real-token-1', at: 1 } })).toBe(true);
  expect(await inbox.accept({ id: 'e2', acceptedAt: 11, value: { token: 'not-a-real-token-2', at: 2 } })).toBe(true);
  expect(await inbox.accept({ id: 'e1', acceptedAt: 12, value: { token: 'not-a-real-token-3', at: 3 } })).toBe(false);
  expect(await inbox.pending()).toEqual([
    { id: 'e1', acceptedAt: 10, value: { token: 'not-a-real-token-1', at: 1 } },
    { id: 'e2', acceptedAt: 11, value: { token: 'not-a-real-token-2', at: 2 } },
  ]);
  await inbox.acknowledge('e1');
  expect((await inbox.pending()).map((entry) => entry.id)).toEqual(['e2']);
  // an acknowledged id still refuses its replay
  expect(await inbox.accept({ id: 'e1', acceptedAt: 13, value: { token: 'not-a-real-token-4', at: 4 } })).toBe(false);
  // what was still pending is found again by an inbox opened afresh on the same storage, as after a restart
  if (reopen) expect((await reopen().pending()).map((entry) => entry.id)).toEqual(['e2']);
}

describe('durable state files', () => {
  it('replaces a private state file whole, leaves no temporary file behind, and removes it once and then harmlessly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-state-'));
    try {
      const path = join(dir, 'state.json');
      writeDurableJson(path, { runs: ['r1'] });
      writeDurableJson(path, { runs: ['r1', 'r2'] });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ runs: ['r1', 'r2'] });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(['state.json']);
      removeDurableJson(path);
      expect(readdirSync(dir)).toEqual([]);
      expect(() => removeDurableJson(path)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes its temporary file when the write or the rename fails, and throws the error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meeting-state-'));
    try {
      const path = join(dir, 'state.json');
      // a value JSON cannot hold fails the write after the temporary file is made
      const circular: { self?: unknown } = {};
      circular.self = circular;
      expect(() => writeDurableJson(path, circular)).toThrow(TypeError);
      expect(readdirSync(dir)).toEqual([]);
      // a directory where the file belongs refuses the rename
      mkdirSync(path);
      expect(() => writeDurableJson(path, { runs: ['r1'] })).toThrow();
      expect(readdirSync(dir)).toEqual(['state.json']);
      expect(statSync(path).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the in-memory durable inbox', () => {
  it('keeps a delivery pending until it is acknowledged and accepts an id once', async () => {
    await keepsDeliveriesUntilAcknowledged(new MemoryDurableInbox<Delivery>());
  });
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;
let prefixSeq = 0;

describeIfPostgres('run provenance and the durable inbox on Postgres', () => {
  let db: StorageAdapter;
  const tables: string[] = [];
  const box = new SecretBox(Buffer.alloc(32, 1));
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 4 });
    await db.open();
  });
  afterAll(async () => {
    for (const table of tables) await db.exec(`DROP TABLE IF EXISTS ${table}`);
    await db.close();
  });
  /** A prefix of its own for each test; its tables are dropped after the suite. */
  const freshPrefix = (): string => {
    const prefix = `pv_${Date.now().toString(36)}_${++prefixSeq}`;
    for (const t of ['runs', 'jobs', 'turns', 'events', 'outbox', 'run_locks', 'inbox']) tables.push(`${prefix}_${t}`);
    return prefix;
  };
  const run = (runId: string, ownerRef: string, patch: Partial<MeetingRunRecord> = {}): MeetingRunRecord => ({
    runId, ownerRef, providerName: 'mock', platform: 'google_meet', state: 'requested', keep: 'account',
    meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' },
    stopPhrase: 'stop', limits: DEFAULT_RUN_LIMITS, requestedAt: 1, joinAt: 1, billedSeconds: 0, ...patch,
  });

  it("stores a run's connection reference, keeps it on the content-free row, and finds every run of one connection", async () => {
    const prefix = freshPrefix();
    await db.exec(meetingStoresDdl(prefix));
    const runs = new SqlRunStore({ db, tablePrefix: prefix, box });
    await runs.insert(run('r2', 'acct_1', { providerConnectionRef: 'generation-1' }));
    await runs.insert(run('r1', 'acct_1', { providerConnectionRef: 'generation-1' }));
    await runs.insert(run('r3', 'acct_1', { providerConnectionRef: 'generation-2' }));
    await runs.insert(run('r4', 'acct_2', { providerConnectionRef: 'generation-1' }));
    await runs.insert(run('r5', 'acct_1'));
    expect((await runs.get('r1'))?.providerConnectionRef).toBe('generation-1');
    expect((await runs.get('r5'))?.providerConnectionRef).toBeUndefined();
    // the end of a purge: the content-free row replaces the run, and the connection reference stays on it
    await runs.replace({ ...contentFreeRun((await runs.get('r1'))!), state: 'done', doneAt: 9, purgedAt: 9 });
    expect(await runs.get('r1')).toMatchObject({ state: 'done', meetingUrl: '', botName: '', providerConnectionRef: 'generation-1' });
    const found = await connectionRuns(db, runs, prefix, 'acct_1', 'mock', 'generation-1');
    expect(found.map((r) => [r.runId, r.state])).toEqual([['r1', 'done'], ['r2', 'requested']]);
    expect(await connectionRuns(db, runs, prefix, 'acct_1', 'another-provider', 'generation-1')).toEqual([]);
    await expect(connectionRuns(db, runs, 'Bad prefix', 'acct_1', 'mock', 'generation-1')).rejects.toThrow('invalid table prefix');
  });

  it('upgrades a runs table made before the column, and the upgrade applied twice changes nothing', async () => {
    const prefix = freshPrefix();
    await db.exec(meetingStoresDdl(prefix));
    await db.exec(`ALTER TABLE ${prefix}_runs DROP COLUMN provider_connection_ref`);
    const runs = new SqlRunStore({ db, tablePrefix: prefix, box });
    // the store writes the column, so a table without it refuses the write until the upgrade runs
    await expect(runs.insert(run('r1', 'acct_1'))).rejects.toThrow();
    await db.exec(meetingProvenanceDdl(prefix));
    await db.exec(meetingProvenanceDdl(prefix));
    await runs.insert(run('r1', 'acct_1', { providerConnectionRef: 'generation-1' }));
    expect((await runs.get('r1'))?.providerConnectionRef).toBe('generation-1');
    expect(() => meetingProvenanceDdl('Bad prefix')).toThrow('invalid table prefix');
  });

  it('seals what it keeps, keeps it pending until it is acknowledged, and refuses a replay after a restart', async () => {
    const prefix = freshPrefix();
    await db.exec(durableInboxDdl(prefix));
    await keepsDeliveriesUntilAcknowledged(new SqlDurableInbox<Delivery>(db, prefix, box), () => new SqlDurableInbox<Delivery>(db, prefix, box));
    const stored = await db.all<{ id: string; payload: string | null }>(`SELECT id, payload FROM ${prefix}_inbox ORDER BY sequence`);
    expect(stored.map((row) => row.id)).toEqual(['e1', 'e2']);
    expect(stored[0].payload).toBeNull();
    expect(stored[1].payload).toMatch(/^v1\.box\./);
    expect(stored[1].payload).not.toContain('not-a-real-token');
  });
});
