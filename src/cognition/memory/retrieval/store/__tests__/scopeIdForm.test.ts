/**
 * @file scopeIdForm.test.ts
 * The written form of a plain id in a `user` or `persona` scope id where a learning layer exists: an id that holds a
 * `/`, a `%` or a `:` is percent-encoded (a lone surrogate as `%u` and four hexadecimal digits), every other id keeps
 * its form; and the one-time re-file of a Brain's plain ids, with its `brain_meta` record. Real SQLite Brains, and the
 * real manager over one, as a layer opens them; and, where AGENTOS_TEST_POSTGRES_URL is set, two Postgres handles
 * that re-file one brain at once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../Brain.js';
import {
  encodePlainScopeId,
  encodeScopeIdPart,
  holdsReservedCharacter,
  refileBrainScopeIds,
  SCOPE_ID_FORM_KEY,
} from '../scopeIdForm.js';
import { CognitiveMemoryManager } from '../../../CognitiveMemoryManager.js';
import { KnowledgeGraph } from '../../graph/knowledge/KnowledgeGraph.js';
import { InMemoryVectorStore } from '../../../../rag/vector_stores/InMemoryVectorStore.js';
import { InMemoryWorkingMemory } from '../../../../substrate/memory/InMemoryWorkingMemory.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-id-form-'));
  dirs.push(dir);
  return path.join(dir, 'brain.sqlite');
}

async function brainAt(filePath: string, brainId = 'b'): Promise<Brain> {
  const brain = await Brain.openSqlite(filePath, { brainId });
  closers.push(() => brain.close());
  return brain;
}

/** Files a row as a release before the layer did: the scope id in the column and in the metadata JSON. */
async function plainRow(brain: Brain, id: string, scope: string, scopeId: string): Promise<void> {
  await brain.run(
    `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at, metadata, scope_id)
     VALUES (?, ?, 'episodic', ?, ?, 1, ?, ?)`,
    [brain.brainId, id, scope, `content of ${id}`, JSON.stringify({ scopeId }), scopeId],
  );
}

const filed = async (brain: Brain) =>
  (await brain.all<{ id: string; scope_id: string; metadata: string }>('SELECT id, scope_id, metadata FROM memory_traces ORDER BY id'))
    .map((row) => [row.id, row.scope_id, JSON.parse(row.metadata).scopeId]);

describe('the written form of a plain id', () => {
  it('percent-encodes an id that holds a slash, a percent sign or a colon, and keeps every other id', () => {
    expect(encodePlainScopeId('user', 'team/ana')).toBe('team%2Fana');
    expect(encodePlainScopeId('user', 'a%2Fb')).toBe('a%252Fb');
    expect(encodePlainScopeId('user', 'a:b')).toBe('a%3Ab');
    expect(encodePlainScopeId('user', 'ana')).toBe('ana');
    expect(encodePlainScopeId('user', 'ana maria')).toBe('ana maria');
    expect(encodePlainScopeId('thread', 'team/ana')).toBe('team/ana');
    expect(holdsReservedCharacter('ana')).toBe(false);
  });

  it('splits a persona composite at its last :: and encodes each part', () => {
    expect(encodePlainScopeId('persona', 'team/ana::tutor')).toBe('team%2Fana::tutor');
    expect(encodePlainScopeId('persona', 'a:::x')).toBe('a%3A::x');
    expect(encodePlainScopeId('persona', 'ana::tu/tor')).toBe('ana::tu%2Ftor');
  });

  it('writes a lone surrogate as %u and four hexadecimal digits, and never throws', () => {
    expect(encodeScopeIdPart('a\uD800b')).toBe('a%uD800b');
    expect(encodeScopeIdPart('\uDC0F')).toBe('%uDC0F');
    expect(encodeScopeIdPart('😀/')).toBe('%F0%9F%98%80%2F');
    expect(encodeScopeIdPart('%uD800')).toBe('%25uD800');
  });
});

describe('refileBrainScopeIds', () => {
  it('re-files the user and persona ids that hold a reserved character, once, and writes the record', async () => {
    const brain = await brainAt(tempFile());
    await plainRow(brain, 't-1', 'user', 'team/ana');
    await plainRow(brain, 't-2', 'persona', 'team/ana::tutor');
    await plainRow(brain, 't-3', 'user', 'ana');
    await plainRow(brain, 't-4', 'thread', 'conv/7');
    await plainRow(brain, 't-5', 'persona', 'a:b::x');

    const first = await refileBrainScopeIds(brain);

    expect(first.alreadyEncoded).toBe(false);
    expect(first.moved).toEqual([
      { scope: 'persona', from: 'a:b::x', to: 'a%3Ab::x', traces: 1 },
      { scope: 'persona', from: 'team/ana::tutor', to: 'team%2Fana::tutor', traces: 1 },
      { scope: 'user', from: 'team/ana', to: 'team%2Fana', traces: 1 },
    ]);
    expect(await filed(brain)).toEqual([
      ['t-1', 'team%2Fana', 'team%2Fana'],
      ['t-2', 'team%2Fana::tutor', 'team%2Fana::tutor'],
      ['t-3', 'ana', 'ana'],
      ['t-4', 'conv/7', 'conv/7'],
      ['t-5', 'a%3Ab::x', 'a%3Ab::x'],
    ]);
    expect(await brain.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
    expect(await refileBrainScopeIds(brain)).toEqual({ alreadyEncoded: true, moved: [] });
  });

  it('writes the record on a Brain that holds nothing, and keeps another brain of the file as it is', async () => {
    const filePath = tempFile();
    const other = await brainAt(filePath, 'other');
    await plainRow(other, 't-o', 'user', 'team/bo');
    const empty = await brainAt(filePath, 'empty');
    expect(await refileBrainScopeIds(empty)).toEqual({ alreadyEncoded: false, moved: [] });
    expect(await empty.getMeta(SCOPE_ID_FORM_KEY)).toBe('encoded');
    expect(await other.getMeta(SCOPE_ID_FORM_KEY)).toBeUndefined();
    expect(await filed(other)).toEqual([['t-o', 'team/bo', 'team/bo']]);
  });
});

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;

describeIfPostgres('refileBrainScopeIds on Postgres', () => {
  it('re-files a brain once when two processes first open it together', async () => {
    const brainId = `test-refile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const one = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    const two = await Brain.openPostgres(POSTGRES_URL!, { brainId });
    closers.push(async () => {
      await one.run('DELETE FROM memory_traces WHERE brain_id = ?', [brainId]);
      await one.run('DELETE FROM brain_meta WHERE brain_id = ?', [brainId]);
      await two.close();
      await one.close();
    });
    // Three pages of plain ids that hold a slash.
    for (let i = 0; i < 1_200; i += 1) await plainRow(one, `t-${String(i).padStart(4, '0')}`, 'user', `team/u${i}`);

    const results = await Promise.all([refileBrainScopeIds(one), refileBrainScopeIds(two)]);

    expect(results.map((result) => result.alreadyEncoded).sort()).toEqual([false, true]);
    const ids = (await one.all<{ scope_id: string }>('SELECT scope_id FROM memory_traces WHERE brain_id = ?', [brainId])).map((row) => row.scope_id);
    expect(ids).toHaveLength(1_200);
    expect(ids.filter((id) => !/^team%2Fu\d+$/.test(id))).toEqual([]);
  });
});

describe("a manager's re-file", () => {
  it('moves a cached trace too, so the encoded id recalls it in this process and after a restart', async () => {
    const MOOD = { valence: 0, arousal: 0, dominance: 0 };
    const filePath = tempFile();
    const open = async () => {
      const brain = await Brain.openSqlite(filePath, { brainId: 'agent' });
      const vectorStore = new InMemoryVectorStore();
      await vectorStore.initialize({ id: `refile-${Math.random()}`, type: 'in_memory' });
      const manager = new CognitiveMemoryManager();
      await manager.initialize({
        agentId: 'agent',
        traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
        moodProvider: () => MOOD,
        featureDetectionStrategy: 'keyword',
        workingMemory: new InMemoryWorkingMemory(),
        knowledgeGraph: new KnowledgeGraph(),
        vectorStore,
        embeddingManager: {
          generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({
            embeddings: (Array.isArray(texts) ? texts : [texts]).map(() => [1, 0, 0, 0]),
          }),
        },
        encoding: { baseStrength: 0.5, flashbulbThreshold: 0.8, flashbulbStrengthMultiplier: 2, flashbulbStabilityMultiplier: 5, baseStabilityMs: 3_600_000 },
        brain,
      } as never);
      closers.push(async () => {
        await manager.shutdown();
        await brain.close();
      });
      return manager;
    };
    const manager = await open();
    await manager.encode('Ana keeps bees on the roof.', MOOD, 'neutral', { scope: 'user', scopeId: 'team/ana' });

    expect(await manager.ensureEncodedScopeIds()).toBe(1);

    const recall = async (m: CognitiveMemoryManager, scopeId: string) =>
      (await m.retrieve('bees on the roof', MOOD, { scopes: [{ scope: 'user', scopeId }] } as never)).retrieved.map((t) => t.content);
    expect(await recall(manager, 'team%2Fana')).toEqual(['Ana keeps bees on the roof.']);
    expect(await recall(manager, 'team/ana')).toEqual([]);
    await closers.pop()!();
    const restarted = await open();
    expect(await restarted.ensureEncodedScopeIds()).toBe(0);
    expect(await recall(restarted, 'team%2Fana')).toEqual(['Ana keeps bees on the roof.']);
  });
});
