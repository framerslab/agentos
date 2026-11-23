import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostgresAdapter, resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import type { Agent } from '../../agent';
import { CognitiveMechanismsEngine } from '../../../cognition/memory/mechanisms/CognitiveMechanismsEngine';
import type { CognitiveMechanismsConfig } from '../../../cognition/memory/mechanisms/types';
import { MemoryStore } from '../../../cognition/memory/retrieval/store/MemoryStore';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry';
import { reply, script, type ProviderScript } from './stubProviders';

const postgresUrl = process.env.AGENTOS_TEST_POSTGRES_URL;
export const engines = postgresUrl ? ['SQLite', 'PostgreSQL'] as const : ['SQLite'] as const;
export const agentId = 'orchard-guide';
export const embedding = { provider: 'openai' } as const;
export const personA = 'person-a';
export const personB = 'person-b';

export const otherProviderText = 'Orchard cedar lantern providernote.';
const ownText = 'Orchard cedar lantern amberroute.';
const otherText = 'Orchard cedar lantern cobalttrail.';
const otherReply = 'Orchard cedar lantern silvercache.';
const question = 'What do you remember about the orchard cedar lantern?';

type Row = { id: string; content: string; scope: 'user' | 'conversation'; scope_id: string; tags: string; metadata: string; deleted: number };
export const rowsOf = (adapter: StorageAdapter) =>
  adapter.all<Row>('SELECT * FROM memory_traces ORDER BY id');

export async function memoryFixture(engine: (typeof engines)[number]) {
  const dir = mkdtempSync(join(tmpdir(), 'gmi-two-people-'));
  const run = randomUUID().replace(/-/g, '');
  const schema = `two_people_${run}`;
  const apiKey = `completion-${run}`;
  const embeddingKey = `embedding-${run}`;
  const served = script('openai', apiKey, { whole: true });
  const embedded = script('openai', embeddingKey);
  const events: Array<{ event: string; mechanism?: string; reason?: string }> = [];
  globalLLMProviderHealth.reset();
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
  setLogger(pino({ level: 'debug', base: undefined }, { write: (line) => events.push(JSON.parse(line)) }));
  let adapter: StorageAdapter;
  if (engine === 'PostgreSQL') {
    adapter = createPostgresAdapter({ connectionString: postgresUrl!, segment: schema, typeParsers: { int8: 'number' } });
    await adapter.open();
  } else {
    adapter = await resolveStorageAdapter({ filePath: join(dir, 'memory.sqlite'), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  }
  return {
    dir,
    adapter,
    served,
    embedded,
    events,
    route: { provider: 'openai' as const, model: 'stub-model', apiKey, fallbackProviders: [] },
    async close() {
      try {
        await adapter.close();
        if (engine === 'PostgreSQL') {
          const admin = createPostgresAdapter({ connectionString: postgresUrl! });
          await admin.open();
          try {
            await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await admin.close();
          }
        }
      } finally {
        resetLoggerFactory();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export type MemoryFixture = Awaited<ReturnType<typeof memoryFixture>>;

type ModelCall = ProviderScript['seen'][number];
export function blocksOf(call: ModelCall) {
  const parts = call.messages.flatMap(({ content }) =>
    typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((part) => ('text' in part ? [part.text] : [])) : [],
  );
  return {
    mind: parts.find((part) => part?.includes('## How To Use Your Memories')) ?? '',
    provider: (parts.find((part) => part?.startsWith('<memory_recall>')) ?? '').replace(/\^/g, ' '),
  };
}

const mechanisms = {
  retrievalInducedForgetting: { enabled: true, similarityThreshold: 0, suppressionFactor: 0.5 },
  metacognitiveFOK: { enabled: true, partialActivationThreshold: 0 },
  reconsolidation: { enabled: true, driftRate: 1 },
  involuntaryRecall: { enabled: true, probability: 1, minAgeDays: 0, minStrength: 0 },
  temporalGist: { enabled: true, ageThresholdDays: 0 },
  sourceConfidenceDecay: { enabled: true, decayMultipliers: { user_statement: 0.5, agent_inference: 0.5 } },
  emotionRegulation: { enabled: true, suppressionThreshold: 0, reappraisalRate: 1 },
  schemaEncoding: { enabled: true, clusterSimilarityThreshold: 0 },
} satisfies CognitiveMechanismsConfig;

const cases = [
  ['retrieval-induced forgetting', 'retrievalInducedForgetting', false],
  ['feeling of knowing', 'metacognitiveFOK', false],
  ['reconsolidation', 'reconsolidation', false],
  ['involuntary recall', 'involuntaryRecall', true],
  ['temporal gist', 'temporalGist', true],
  ['source-confidence decay', 'sourceConfidenceDecay', true],
  ['emotion regulation', 'emotionRegulation', true],
  ['schema encoding', 'schemaEncoding', true],
] as const;

/**
 * Capture the actual cache as well as every durable column. Some mechanisms mutate a held trace
 * without writing its changed fields to the Brain.
 */
export function testMechanisms(
  fixture: () => MemoryFixture,
  open: (config: CognitiveMechanismsConfig) => Promise<Agent>,
  seedProvider?: (agent: Agent) => Promise<void>,
) {
  it.each(cases)('%s stays within one person', async (_label, mechanism, inactive) => {
    const { adapter, served, events } = fixture();
    const config = Object.fromEntries(Object.keys(mechanisms).map((key) => [key, { enabled: false }]));
    const storeWrites = vi.spyOn(MemoryStore.prototype, 'store');
    const retrieval = vi.spyOn(CognitiveMechanismsEngine.prototype, 'onRetrieval');
    const access = vi.spyOn(CognitiveMechanismsEngine.prototype, 'onAccess');
    const spontaneous = vi.spyOn(CognitiveMechanismsEngine.prototype, 'onPromptAssembly');
    const consolidation = vi.spyOn(CognitiveMechanismsEngine.prototype, 'onConsolidation');
    const agent = await open({ ...config, [mechanism]: mechanisms[mechanism] });
    await seedProvider?.(agent);
    const a = agent.session('session-a', { userId: personA });
    const b = agent.session('session-b', { userId: personB });

    const send = async (session: typeof a, input: string, output: string) => {
      served.replies.push(reply.text(output));
      const result = await session.send(input);
      await result.memoryWrite;
      return blocksOf(served.seen.at(-1)!);
    };

    await send(b, otherText, otherReply);
    const bWarmup = await send(b, question, 'Only B had the silvercache.');
    expect(bWarmup.mind).toContain(otherText);
    if (seedProvider) expect(bWarmup.provider).toContain(otherProviderText);

    const originalRows = await rowsOf(adapter);
    expect(originalRows.map(({ content }) => content)).toEqual(expect.arrayContaining([otherText, otherReply]));
    const bIds = new Set(originalRows.map(({ id }) => id));
    const bScopes = originalRows.map(({ scope, scope_id }) => `${scope}:${scope_id}`);
    const bRows = async () => (await rowsOf(adapter)).filter(({ scope, scope_id }) => bScopes.includes(`${scope}:${scope_id}`));
    const store = storeWrites.mock.contexts[0] as MemoryStore;
    const bTrace = originalRows.find(({ content }) => content === otherText)!;
    const bCache = async () => {
      const scopes = new Map(originalRows.map((row) => [`${row.scope}:${row.scope_id}`, row]));
      const traces = await Promise.all([...scopes.values()].map(({ scope, scope_id }) => store.getByScope(scope, scope_id)));
      return structuredClone(traces.flat().sort((left, right) => left.id.localeCompare(right.id)));
    };
    const before = await bCache();
    expect(before.map(({ id }) => id)).toContain(bTrace.id);

    await send(a, ownText, 'Orchard cedar lantern amberpath.');
    const aTrace = (await rowsOf(adapter)).find(({ content }) => content === ownText)!;
    expect(aTrace.scope_id).not.toBe(bTrace.scope_id);
    retrieval.mockClear();
    access.mockClear();
    const blocks = await send(a, question, 'The orchard lantern is amber.');

    expect(blocks.mind).toContain(ownText);
    for (const block of Object.values(blocks)) {
      expect(block).not.toMatch(/cobalttrail|silvercache|providernote/i);
    }
    expect(await bRows()).toEqual(originalRows);
    expect(await bCache()).toEqual(before);

    if (mechanism === 'retrievalInducedForgetting' || mechanism === 'metacognitiveFOK') {
      const candidates = retrieval.mock.calls.flatMap(([, candidates]) => candidates.map(({ trace }) => trace.id));
      expect(candidates).toContain(aTrace.id);
      expect(candidates.filter((id) => bIds.has(id))).toEqual([]);
    }
    if (mechanism === 'reconsolidation') {
      const accessed = access.mock.calls.map(([trace]) => trace.id);
      expect(accessed).toContain(aTrace.id);
      expect(accessed.filter((id) => bIds.has(id))).toEqual([]);
    }
    if (mechanism === 'involuntaryRecall') expect(spontaneous).not.toHaveBeenCalled();
    if (mechanism === 'temporalGist' || mechanism === 'sourceConfidenceDecay' || mechanism === 'emotionRegulation') {
      expect(consolidation).not.toHaveBeenCalled();
    }
    if (mechanism === 'schemaEncoding') {
      const filed = (await rowsOf(adapter)).find(({ content, id }) => content === question && !bIds.has(id));
      expect(JSON.parse(filed!.metadata).structuredData ?? {}).not.toHaveProperty('schemaCongruent');
      expect(JSON.parse(filed!.metadata).structuredData ?? {}).not.toHaveProperty('schemaViolating');
    }
    const logged = events.filter(({ event }) => event === 'memory.mechanism_inactive').map(({ mechanism }) => mechanism);
    expect(logged).toEqual(inactive ? [mechanism] : []);
  });
}
