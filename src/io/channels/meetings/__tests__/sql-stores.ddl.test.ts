import { inspect } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { SecretBox } from '../signing.js';
import { meetingStoresDdl, MEETING_STORES_DDL, SqlRunStore, SqlJobStore, SqlTranscriptStore, SqlEventStore, SqlOutbox } from '../stores/sql.js';

describe('meetingStoresDdl', () => {
  it('names six tables under the prefix and refuses a prefix that does not fit', () => {
    const ddl = meetingStoresDdl('acme_bots');
    for (const t of ['acme_bots_runs', 'acme_bots_jobs', 'acme_bots_turns', 'acme_bots_events', 'acme_bots_outbox', 'acme_bots_run_locks']) expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    expect(ddl).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_acme_bots_events_id ON acme_bots_events (event_id)');
    expect(meetingStoresDdl()).toBe(MEETING_STORES_DDL);
    expect(() => meetingStoresDdl('9bad')).toThrow();
    expect(() => meetingStoresDdl('a'.repeat(40))).toThrow();
  });
  it('keeps identifiers within 63 bytes and includes nullable timer columns in record order', () => {
    const ddl = meetingStoresDdl('a'.repeat(38));
    const names = [...ddl.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((match) => match[1]);
    expect(names).toHaveLength(13);
    for (const name of names) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(ddl).toContain('  participant_count INTEGER,\n  leave_commanded_at BIGINT,\n  capture_suspended_at BIGINT,\n  alone_since BIGINT,');
    expect(() => meetingStoresDdl('a'.repeat(39))).toThrow();
  });
  it.each(['transactions', 'persistence', 'concurrent'] as const)('refuses every store when the adapter lacks %s', (missing) => {
    const db = {
      kind: 'postgres',
      capabilities: new Set(['transactions', 'persistence', 'concurrent'].filter((capability) => capability !== missing)),
    } as unknown as StorageAdapter;
    const options = { db, box: new SecretBox(Buffer.alloc(32, 1)) };
    for (const Store of [SqlRunStore, SqlJobStore, SqlTranscriptStore, SqlEventStore, SqlOutbox]) {
      expect(() => new Store(options)).toThrow(/transactions, persistence and concurrent access/);
    }
  });
  it('serialises a run store without visiting its box or database', () => {
    const box = new SecretBox(Buffer.alloc(32, 1));
    const serialiseBox = vi.spyOn(box, 'toJSON').mockImplementation(() => { throw new Error('box must not be serialised'); });
    const serialiseDb = vi.fn(() => { throw new Error('database must not be serialised'); });
    const db = { kind: 'postgres', capabilities: new Set(['transactions', 'persistence', 'concurrent']), toJSON: serialiseDb } as unknown as StorageAdapter;
    const runs = new SqlRunStore({ db, box });
    expect(JSON.stringify(runs)).toBe('"[SqlRunStore redacted]"');
    expect(JSON.stringify({ runs })).toBe('{"runs":"[SqlRunStore redacted]"}');
    expect(inspect(runs)).toBe('[SqlRunStore redacted]');
    expect(inspect({ runs }, { depth: 5 })).toBe('{ runs: [SqlRunStore redacted] }');
    expect(serialiseBox).not.toHaveBeenCalled();
    expect(serialiseDb).not.toHaveBeenCalled();
  });
});
