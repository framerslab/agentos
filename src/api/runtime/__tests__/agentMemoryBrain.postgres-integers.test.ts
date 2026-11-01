/**
 * @file agentMemoryBrain.postgres-integers.test.ts
 * gmi()'s `memory.store: { adapter }` on PostgreSQL. The Brain's integer columns are BIGINT there, which pg reads as
 * text unless the adapter is opened with `typeParsers: { int8: 'number' }`: read as text, a trace's retrieval count and
 * times load as strings and an access appends to the count. The store's open refuses such an adapter, naming the
 * option, before the Brain opens. A Postgres-kind adapter that answers BIGINT as text stands in everywhere; where
 * AGENTOS_TEST_POSTGRES_URL is set, real adapters opened with the parser and without it.
 */
import { describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { openAgentMemoryBrain } from '../agentCognitiveMemory';

describe("memory.store's adapter on PostgreSQL", () => {
  it('refuses an adapter that reads BIGINT as text, naming typeParsers, before the Brain opens', async () => {
    const statements: string[] = [];
    const textIntegers = {
      kind: 'postgres',
      get: async (sql: string) => {
        statements.push(sql);
        return { n: '1' };
      },
      all: async (sql: string) => {
        statements.push(sql);
        return [];
      },
      run: async (sql: string) => {
        statements.push(sql);
        return { changes: 0 };
      },
      exec: async (sql: string) => {
        statements.push(sql);
      },
    } as unknown as StorageAdapter;

    await expect(openAgentMemoryBrain({ adapter: textIntegers }, 'tutor')).rejects.toThrow(
      /memory\.store did not open[\s\S]*typeParsers: \{ int8: 'number' \}/,
    );
    // The probe is the one statement the refused adapter ran: no table was made or read.
    expect(statements).toHaveLength(1);
  });
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('memory.store on a PostgreSQL adapter', () => {
  it('refuses an adapter opened without the int8 parser and opens a Brain on one opened with it', async () => {
    const brainId = `pg-integers-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const plain = createPostgresAdapter({ connectionString: POSTGRES_URL! });
    await plain.open();
    try {
      await expect(openAgentMemoryBrain({ adapter: plain, brainId }, 'tutor')).rejects.toThrow(/typeParsers/);
    } finally {
      await plain.close();
    }

    const parsed = createPostgresAdapter({ connectionString: POSTGRES_URL!, typeParsers: { int8: 'number' } });
    await parsed.open();
    try {
      const opened = await openAgentMemoryBrain({ adapter: parsed, brainId }, 'tutor');
      expect(opened.brain.brainId).toBe(brainId);
      const row = await parsed.get<{ n: unknown }>('SELECT COUNT(*) AS n FROM memory_traces WHERE brain_id = ?', [brainId]);
      expect(row?.n).toBe(0);
      await opened.close();
      await parsed.run('DELETE FROM brain_meta WHERE brain_id = ?', [brainId]);
    } finally {
      await parsed.close();
    }
  });
});
