/**
 * @fileoverview PersonalityMutationStore's reads on PostgreSQL, run when
 * `AGENTOS_TEST_POSTGRES_URL` names a database (CI's Test & Lint job sets it).
 * The store is the one the runtime builds over its storage adapter
 * (SelfImprovementSessionManager.buildToolDeps), here a PostgreSQL adapter of
 * @framers/sql-storage-adapter: once with pg's default int8 parser, which reads
 * a BIGINT as a string, and once with the library's `typeParsers.int8`
 * 'bigint', which reads it as a BigInt. Each test's tables go in a schema of
 * their own (the storage library's `segment`), dropped when the suite ends.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SelfImprovementSessionManager } from '../../../api/runtime/SelfImprovementSessionManager.js';
import type { ILogger } from '../../../core/logging/ILogger.js';
import type { PersonalityMutationStore } from '../PersonalityMutationStore.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const silentLogger: ILogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe.skipIf(!url)('PersonalityMutationStore reads on PostgreSQL', () => {
  const segments: string[] = [];
  const databases: StorageAdapter[] = [];

  /** The store the runtime builds over a PostgreSQL adapter whose tables go in a new schema of their own. */
  async function storeInNewSegment(typeParsers?: { int8: 'bigint' }): Promise<PersonalityMutationStore> {
    const segment = `agentos_mutations_${run}_${segments.length}`;
    segments.push(segment);
    const db = createPostgresAdapter({ connectionString: url!, segment, typeParsers });
    await db.open();
    databases.push(db);
    const deps = new SelfImprovementSessionManager(silentLogger).buildToolDeps(db, {
      getGMIForContext: () => undefined,
      getToolOrchestrator: () => {
        throw new Error('recording and loading a mutation never reach the tool orchestrator');
      },
    });
    if (!deps.mutationStore) throw new Error('the runtime built no mutation store over the adapter');
    return deps.mutationStore;
  }

  afterEach(async () => {
    for (const db of databases.splice(0)) await db.close();
  });

  afterAll(async () => {
    const admin = createPostgresAdapter({ connectionString: url! });
    await admin.open();
    try {
      for (const segment of segments) await admin.exec(`DROP SCHEMA IF EXISTS "${segment}" CASCADE`);
    } finally {
      await admin.close();
    }
  });

  it.each([
    { parser: "pg's default int8 parser, which reads a BIGINT as a string", typeParsers: undefined },
    { parser: "typeParsers.int8 'bigint', which reads a BIGINT as a BigInt", typeParsers: { int8: 'bigint' as const } },
  ])('a recorded mutation reads back with created_at, a BIGINT, as a number: $parser', async ({ typeParsers }) => {
    const store = await storeInNewSegment(typeParsers);
    const before = Date.now();
    await store.record({
      agentId: 'a1',
      trait: 'openness',
      delta: 0.1,
      reasoning: 'seed',
      baselineValue: 0.5,
      mutatedValue: 0.6,
    });
    const after = Date.now();

    const [mutation] = await store.loadForAgent('a1');

    expect(typeof mutation?.createdAt).toBe('number');
    expect(mutation?.createdAt).toBeGreaterThanOrEqual(before);
    expect(mutation?.createdAt).toBeLessThanOrEqual(after);
    // The REAL columns read as numbers; on PostgreSQL a REAL keeps about six significant digits.
    expect(mutation?.delta).toBeCloseTo(0.1, 6);
    expect(mutation?.baselineValue).toBeCloseTo(0.5, 6);
    expect(mutation?.mutatedValue).toBeCloseTo(0.6, 6);
    expect(mutation?.strength).toBe(1);
  });
});
