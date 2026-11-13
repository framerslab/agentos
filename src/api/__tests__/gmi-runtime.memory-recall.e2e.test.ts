/**
 * `memory.recall` on agent({ runtime: 'gmi' }), its four settings together, over a durable store and across a restart:
 * one agent files what a user said and closes, and a second agent built on the same store answers a question. The
 * real provider manager, completion gateway, GMI, prompt engine, memory bridge, cognitive memory manager and Brain
 * run; only the provider class is stubbed (helpers/stubProviders.ts), and the OpenAI stub embeds with a deterministic
 * word hash, so texts that share words recall each other. The second agent has no history of the first, so what its
 * block holds reached the prompt through recall from the store.
 *
 * Each case runs on a SQLite file and, where `AGENTOS_TEST_POSTGRES_URL` is set (CI's `Test & Lint` job), on
 * Postgres, each agent over an adapter of its own, as each process of a restart opens one.
 *
 * The option under test is typed, with no cast: `MemoryConfig` and `MemoryRecallConfig` as a host writes them. The
 * last case fails to compile the day `MemoryRecallConfig` gains or loses a field without this file being updated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
// Trace ids from a counter each ask starts again: the block prints the ids of the memories in focus, so two stores fed
// the same statements send the same block only when their ids match. Under a faked clock, each id minted also moves
// the clock on one millisecond, so every memory has a filing time of its own, as the memories of real turns have. A
// store loads its memories newest first, and memories filed in one millisecond load in an order the engine picks
// (PostgreSQL's changes as rows are updated), which decides the place of equally scored memories in the block.
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../cognition/memory/core/util/crossPlatformCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/util/crossPlatformCrypto')>();
  return {
    ...actual,
    uuid: () => {
      if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 1);
      return `trace-${String(++ids.next).padStart(4, '0')}`;
    },
  };
});
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { agent, type AgentOptions } from '../agent';
import type { MemoryConfig } from '../types';
import type { MemoryRecallCapture, MemoryRecallConfig } from '../../cognition/memory';
import { LEARNING_TABLES } from '../../cognition/learning/store/schema';
import { MEMORY_CUT_MARKER } from '../../cognition/memory/core/prompt/MemoryFormatters';
import { resetRecallLogOnce } from '../../cognition/memory/retrieval/recall/log';
import { CONVERSATION_SCOPE_TABLES, PORTABLE_TABLES } from '../../cognition/memory/retrieval/store/portable-tables';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;

let n = 0;
const key = () => `k-memory-recall-e2e-${++n}`;

type DurableStore = NonNullable<MemoryConfig['store']>;
/** One durable store of a case: `store()` is the `memory.store` of one agent built on it. */
interface OpenStore {
  store: () => Promise<DurableStore>;
  /** The learning namespace of the agents built on the store, where the engine is shared between stores. */
  namespace?: string;
  close: () => Promise<void>;
}
type Engine = { name: 'sqlite' | 'postgres'; open: () => Promise<OpenStore> };

const sqlite: Engine = {
  name: 'sqlite',
  open: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-e2e-'));
    return { store: async () => ({ path: path.join(dir, 'brain.sqlite') }), close: async () => fs.rmSync(dir, { recursive: true, force: true }) };
  },
};

/** Postgres at `url`: each store is a brain id and a learning namespace of its own, wiped when the case ends. */
const postgres = (url: string): Engine => ({
  name: 'postgres',
  open: async () => {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const brainId = `recall-e2e-${run}`;
    const adapters: StorageAdapter[] = [];
    return {
      store: async () => {
        // BIGINT as numbers, as the store asks of a PostgreSQL adapter.
        const adapter = createPostgresAdapter({ connectionString: url, typeParsers: { int8: 'number' } });
        await adapter.open();
        adapters.push(adapter);
        return { adapter, brainId };
      },
      namespace: run,
      close: async () => {
        const cleaner = adapters[0];
        if (cleaner) {
          // Children before parents; a table the run never made is passed over.
          for (const table of [...CONVERSATION_SCOPE_TABLES, ...[...PORTABLE_TABLES].reverse()]) {
            await cleaner.run(`DELETE FROM ${table} WHERE brain_id = ?`, [brainId]).catch(() => undefined);
          }
          for (const table of LEARNING_TABLES) await cleaner.run(`DELETE FROM ${table} WHERE namespace = ?`, [run]).catch(() => undefined);
        }
        for (const adapter of adapters) await adapter.close().catch(() => undefined);
      },
    };
  },
});

const ENGINES: Engine[] = [sqlite, ...(POSTGRES_URL ? [postgres(POSTGRES_URL)] : [])];

function textOf(message: ChatMessage): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';

/** The memory block of the provider request `call`: the text from the preamble heading to the user's query. */
function memoryBlockOf(s: ProviderScript, call: number): string {
  const request = s.seen[call];
  expect(request, `model call ${call}`).toBeDefined();
  const holders = request.messages.map(textOf).filter((text) => text.includes(PREAMBLE_HEADING));
  expect(holders, 'messages that carry the memory block').toHaveLength(1);
  const text = holders[0];
  const start = text.indexOf(PREAMBLE_HEADING);
  const end = text.indexOf('\n\nUser Query:', start);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Tokens of a text by the assembler's estimate (about four characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

const logged: Record<string, unknown>[] = [];
/** The lines written with the event `name`. */
const events = (name: string) => logged.filter((line) => line.event === name);

beforeEach(() => {
  globalLLMProviderHealth.reset();
  resetRecallLogOnce();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
  // The learning layer prints its manifest at an agent's first session.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  resetLoggerFactory();
  resetRecallLogOnce();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const GOLD = 'The bike shed code is XQ7Z, set in March.';
const FACTS = [GOLD, 'My sister Ana lives in Porto and visits in June.', 'I water the tomatoes every second day.', 'The ferry to the island leaves from pier 3 at 9:15.'];
const FILLER = Array.from({ length: 24 }, (_, i) => `Garden note ${i}: row ${i} was weeded and the hose was coiled by the east fence.`);
const STATEMENTS = [...FACTS, ...FILLER];
/** Where a case fakes the clock, the instant each ask starts at. */
const FILING_STARTS_AT = Date.UTC(2026, 10, 10, 12, 0, 0);

/**
 * Files the statements through the sends of one agent's session, closes the agent, and asks `question` in the same
 * session id of a second agent built on the same store. Returns the question's memory block as the provider received
 * it, the embedding requests of the question's turn, and the turn's recall record.
 */
async function askAfterRestart(db: OpenStore, recall: MemoryRecallConfig | undefined, question: string) {
  ids.next = 0;
  // Under a faked clock every ask starts at the same instant, so two asks file and read at the same times.
  if (vi.isFakeTimers()) vi.setSystemTime(FILING_STARTS_AT);
  const k = key();
  const emb = key();
  // One script for both agents: the provider's requests are counted on from the first agent's.
  const s = script('openai', k, { replies: [...STATEMENTS.map(() => reply.text('Noted.')), reply.text('XQ7Z.')] });
  const embedder = script('openai', emb, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', emb);
  const build = async () => {
    // Typed as a host writes it: no cast on the memory option or its recall setting.
    const memory: MemoryConfig = { embedding: { provider: 'openai' }, store: await db.store(), ...(recall ? { recall } : {}) };
    // The memory config whole under cognition.memory, and durable memory's key under learning. Named, so the persona
    // id each memory line's tags carry is the same for every agent built here.
    return agent({
      runtime: 'gmi',
      name: 'Shed',
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      cognition: { memory, mechanisms: false },
      learning: { agentKey: 'recall-e2e', mode: 'off', ...(db.namespace ? { namespace: db.namespace } : {}) },
    } as unknown as AgentOptions);
  };

  const writer = await build();
  try {
    const filing = writer.session('user-1');
    for (const statement of STATEMENTS) await filing.send(statement);
  } finally {
    await writer.close();
  }

  const reader = await build();
  try {
    const before = embedder.embedCalls;
    const result = await reader.session('user-1').send(question);
    return {
      text: result.text,
      block: memoryBlockOf(s, STATEMENTS.length),
      embedCalls: embedder.embedCalls - before,
      memoryRecall: result.memoryRecall as MemoryRecallCapture | undefined,
    };
  } finally {
    await reader.close();
  }
}

describe.each(ENGINES)("agent({ runtime: 'gmi' }) memory.recall over a durable store on $name", ({ name, open }) => {
  it('every setting at once: a budget, hybrid retrieval, an llm rerank and the capture, in an agent built again on the store', async () => {
    const QUESTION = 'Do you remember the bike shed code?';
    const db = await open();
    try {
      const judgedForQuestion: string[] = [];
      // The judge as a host's model call: a score for each numbered memory, the one holding the code the highest; then
      // the ranking of the ids it is given, the one holding the code first. It answers on the filing turns too.
      const invoke = async (system: string, user: string): Promise<string> => {
        if (user.includes(`Query: "${QUESTION}"`)) judgedForQuestion.push(user);
        if (system.includes('relevance scorer')) return JSON.stringify((user.match(/^\[\d+\] .*$/gm) ?? []).map((line) => (line.includes('XQ7Z') ? 10 : 1)));
        const lines = [...user.matchAll(/^\[([^\]]+)\] (.*)$/gm)].map((m) => ({ id: m[1], holdsCode: m[2].includes('XQ7Z') }));
        return JSON.stringify([...lines.filter((line) => line.holdsCode), ...lines.filter((line) => !line.holdsCode)].map((line) => line.id));
      };
      const recall: MemoryRecallConfig = {
        budget: { totalTokens: 1200 },
        retrieval: 'hybrid',
        rerank: { kind: 'llm', model: 'judge-model', invoke },
        capture: 'metadata',
      };
      const out = await askAfterRestart(db, recall, QUESTION);
      expect(out.text).toBe('XQ7Z.');
      const c = out.memoryRecall!;
      expect(c).toBeDefined();

      // Hybrid retrieval: the three legs ran, the exact-words leg on the store's own full-text index.
      expect(c).toMatchObject({
        version: 'memory-recall-capture/1',
        retrieval: 'hybrid',
        lexicalBackend: name === 'postgres' ? 'postgres_tsvector' : 'fts5',
        memoryQuestionReserve: { fired: true },
      });
      expect(c.legs.map((l) => [l.leg, l.ran])).toEqual([['dense', true], ['exact_words', true], ['recency', true]]);
      expect(events('memory.recall.leg_absent')).toEqual([]);

      // The budget: the block the model received fits it.
      expect(c.budget).toMatchObject({ requested: 1200, effective: 1200, hop: 0 });
      expect(c.tokensUsed).toBeLessThanOrEqual(1200);
      expect(tokensOf(out.block)).toBeLessThanOrEqual(1200);

      // The rerank: the judge was asked about the turn's own text and saw the memory, and its scores are recorded.
      expect(c.reranker).toMatchObject({ provider: 'llm', model: 'judge-model' });
      expect(judgedForQuestion.length).toBeGreaterThan(0);
      expect(judgedForQuestion.join('\n')).toContain('XQ7Z');
      expect(events('memory.recall.rerank_skipped')).toEqual([]);
      expect(events('memory.recall.rerank_failed_scoring')).toEqual([]);

      // The block: the memory whole, in the one recall section.
      expect(out.block).toContain(GOLD);
      expect(out.block).not.toContain(MEMORY_CUT_MARKER);
      expect(out.block.match(/^## Relevant Memories/gm)).toHaveLength(1);
      expect(out.block).not.toContain('## Recent Experiences');

      // The capture: the memory the judge ranked first is the one exact words found first, and the block shows it.
      const scored = c.candidates.filter((x) => typeof x.rerankScore === 'number');
      expect(scored.length).toBeGreaterThan(1);
      const best = Math.max(...scored.map((x) => x.rerankScore!));
      const gold = scored.filter((x) => x.rerankScore === best);
      expect(gold).toHaveLength(1);
      expect(gold[0]).toMatchObject({ outcome: 'included', section: 'recall', ranks: { exact_words: 1 } });
      expect(c.candidates.some((x) => x.outcome === 'left_out')).toBe(true);
      for (const x of c.candidates) {
        expect(['included', 'left_out']).toContain(x.outcome);
        if (x.outcome === 'left_out') expect(['budget', 'dedupe', 'section_full']).toContain(x.reason);
      }
      expect(c.delivery).toMatchObject({ memoryBlockTokens: expect.any(Number) });
      expect(c.delivery!.memoryBlockTokens).toBeGreaterThan(0);

      // The record holds ids, ranks, scores, counts and timings: no memory text, no query text, no function.
      const keys = new Set<string>();
      JSON.parse(JSON.stringify(c), (k2: string, v: unknown) => {
        keys.add(k2);
        return v;
      });
      for (const forbidden of ['content', 'text', 'contextText', 'query', 'invoke']) expect(keys.has(forbidden), forbidden).toBe(false);
      expect(JSON.stringify(c)).not.toContain('XQ7Z');
      expect(JSON.stringify(c)).not.toContain('bike shed');
    } finally {
      await db.close();
    }
  });

  it('the defaults as a set: no memory.recall sends, byte for byte, the block of dense, no rerank, 1,600 tokens and a metadata capture', async () => {
    // A faked clock, so both blocks print the same ages: it stands still but for the millisecond each new memory
    // moves it on (the uuid mock above).
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(FILING_STARTS_AT);
    const a = await open();
    const b = await open();
    try {
      const unset = await askAfterRestart(a, undefined, 'What is the bike shed code?');
      const explicit = await askAfterRestart(b, { budget: { totalTokens: 1600 }, retrieval: 'dense', rerank: 'none', capture: 'metadata' }, 'What is the bike shed code?');
      expect(unset.block).toContain(GOLD);
      expect(explicit.block).toBe(unset.block);
      expect(explicit.embedCalls).toBe(unset.embedCalls);
      for (const record of [unset.memoryRecall, explicit.memoryRecall]) {
        expect(record).toMatchObject({
          retrieval: 'dense',
          lexicalBackend: 'none',
          reranker: { provider: 'none', reason: 'none_configured' },
          memoryQuestionReserve: { fired: false, added: 0 },
          budget: { requested: 1600 },
        });
        expect(record!.legs.map((l) => l.leg)).toEqual(['dense']);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('hybrid makes no more embedding requests in a turn than dense', async () => {
    const a = await open();
    const b = await open();
    try {
      const dense = await askAfterRestart(a, { retrieval: 'dense' }, 'What is the bike shed code?');
      const hybrid = await askAfterRestart(b, { retrieval: 'hybrid' }, 'What is the bike shed code?');
      expect(dense.memoryRecall).toMatchObject({ retrieval: 'dense' });
      expect(hybrid.memoryRecall).toMatchObject({ retrieval: 'hybrid' });
      expect(hybrid.block).toContain(GOLD);
      expect(dense.embedCalls).toBeGreaterThan(0);
      expect(hybrid.embedCalls).toBe(dense.embedCalls);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

it('the public option holds the four fields and nothing else', () => {
  // Required<> makes a missing field a compile error, and the object literal an unknown one.
  const recall: Required<MemoryRecallConfig> = { budget: { totalTokens: 1600 }, retrieval: 'dense', rerank: 'none', capture: 'metadata' };
  expect(Object.keys(recall).sort()).toEqual(['budget', 'capture', 'rerank', 'retrieval']);
});
