import { afterAll, describe, expect, it } from 'vitest';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { InMemoryVoiceStore } from '../stores/memory.js';
import { SqlVoiceStore, voicePlatformDdl, VOICE_PLATFORM_TABLES } from '../stores/sql.js';
import { voiceStoreContract } from './voiceStore.contract.js';

voiceStoreContract('memory voice store', async () => new InMemoryVoiceStore());
const databases: StorageAdapter[] = [];
voiceStoreContract('SQLite voice store', async () => {
  const db = await resolveStorageAdapter({ filePath: ':memory:', priority: ['better-sqlite3', 'sqljs'], quiet: true });
  databases.push(db);
  return new SqlVoiceStore({ db, requireShared: false });
});
afterAll(async () => { for (const db of databases) await db.close(); });
describe('voice store DDL and redaction', () => {
  it('exports every table under a bounded identifier', () => {
    for (const table of VOICE_PLATFORM_TABLES) expect(voicePlatformDdl('voice_a')).toContain(`CREATE TABLE IF NOT EXISTS voice_a_${table}`);
    for (const bad of ['9bad', 'a;DROP', 'a'.repeat(33)]) expect(() => voicePlatformDdl(bad)).toThrow();
  });
  it('does not serialize database options', () => {
    const db = { capabilities: new Set(['transactions', 'persistence', 'concurrent']), toJSON: () => { throw new Error('private'); } } as unknown as StorageAdapter;
    expect(JSON.stringify(new SqlVoiceStore({ db }))).toBe('"[SqlVoiceStore]"');
  });
});
