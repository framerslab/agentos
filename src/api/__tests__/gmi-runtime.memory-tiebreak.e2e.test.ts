/**
 * Memories filed in one millisecond, through agent({ runtime: 'gmi' }) over a durable store, as a host sees them: one
 * agent files them and closes, and a second agent built on the same store answers a question they all match equally.
 * The memory block the model is sent, and the turn's `memoryRecall` record, list the equally scored memories by id,
 * compared character code by character code, on SQLite and on PostgreSQL alike, and two stores holding the same
 * memories, with different rows updated since they were filed, send the same block.
 *
 * The real provider manager, completion gateway, GMI, prompt engine, memory bridge, cognitive memory manager and Brain
 * run; only the provider class is stubbed (helpers/stubProviders.ts), and its embeddings hash words, so the six memories
 * that share one word with the question, and no other, score the same against it. The clock stands still, so every
 * memory the first agent files has one filing time.
 *
 * Each case runs on a SQLite file and, where `AGENTOS_TEST_POSTGRES_URL` is set (CI's `Test & Lint` job), on
 * PostgreSQL, whose default collation sorts by language (`a` before `B`), and which stores an updated row as a new
 * version at the end of its table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
// Trace ids from a counter each ask starts again, so two stores fed the same turns hold the same ids. Their first
// letters alternate in case and skip about the alphabet, so the order the memories were filed in is neither the ids'
// order by character code nor their order by a language's collation.
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../cognition/memory/core/util/crossPlatformCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/util/crossPlatformCrypto')>();
  const letters = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ';
  return {
    ...actual,
    uuid: () => {
      const n = ++ids.next;
      return `${letters[(n * 11) % letters.length]}${String(n).padStart(4, '0')}`;
    },
  };
});
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { agent, type AgentOptions } from '../agent';
import type { MemoryConfig } from '../types';
import type { MemoryRecallCapture } from '../../cognition/memory';
import { LEARNING_TABLES } from '../../cognition/learning/store/schema';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { CONVERSATION_SCOPE_TABLES, PORTABLE_TABLES } from '../../cognition/memory/retrieval/store/portable-tables';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
/** `learning.agentKey`: the brain id of a store opened on a SQLite file. */
const AGENT_KEY = 'tiebreak-e2e';

let n = 0;
const key = () => `k-memory-tiebreak-e2e-${++n}`;

type DurableStore = NonNullable<MemoryConfig['store']>;
/** One durable store of a case: `store()` is the `memory.store` of one agent built on it. */
interface OpenStore {
  store: () => Promise<DurableStore>;
  /** The learning namespace of the agents built on the store, where the engine is shared between stores. */
  namespace?: string;
  /** Writes again, unchanged, the rows of the memories holding each text. */
  touch: (contents: readonly string[]) => Promise<void>;
  close: () => Promise<void>;
}
type Engine = { name: 'sqlite' | 'postgres'; open: () => Promise<OpenStore> };

const TOUCH_SQL = 'UPDATE memory_traces SET tags = tags WHERE brain_id = ? AND content = ?';

const sqlite: Engine = {
  name: 'sqlite',
  open: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiebreak-e2e-'));
    const file = path.join(dir, 'brain.sqlite');
    return {
      store: async () => ({ path: file }),
      touch: async (contents) => {
        const brain = await Brain.openSqlite(file, { brainId: AGENT_KEY });
        try {
          for (const content of contents) await brain.run(TOUCH_SQL, [brain.brainId, content]);
        } finally {
          await brain.close();
        }
      },
      close: async () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  },
};

/** PostgreSQL at `url`: each store is a brain id and a learning namespace of its own, wiped when the case ends. */
const postgres = (url: string): Engine => ({
  name: 'postgres',
  open: async () => {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const brainId = `tiebreak-e2e-${run}`;
    const adapters: StorageAdapter[] = [];
    const connect = async (): Promise<StorageAdapter> => {
      // BIGINT as numbers, as the store asks of a PostgreSQL adapter.
      const adapter = createPostgresAdapter({ connectionString: url, typeParsers: { int8: 'number' } });
      await adapter.open();
      adapters.push(adapter);
      return adapter;
    };
    return {
      store: async () => ({ adapter: await connect(), brainId }),
      namespace: run,
      touch: async (contents) => {
        const adapter = adapters[0] ?? (await connect());
        for (const content of contents) await adapter.run(TOUCH_SQL, [brainId, content]);
      },
      close: async () => {
        const cleaner = adapters[0];
        if (cleaner) {
          // A table the run never made is passed over; any other failure is written out, so rows left behind in a
          // shared database are never silent.
          const wipe = async (table: string, column: 'brain_id' | 'namespace', value: string): Promise<void> => {
            try {
              await cleaner.run(`DELETE FROM ${table} WHERE ${column} = ?`, [value]);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/does not exist|no such table/i.test(message)) process.stderr.write(`[memory-tiebreak e2e cleanup] ${table}: ${message}\n`);
            }
          };
          // Children before parents.
          for (const table of [...CONVERSATION_SCOPE_TABLES, ...[...PORTABLE_TABLES].reverse()]) await wipe(table, 'brain_id', brainId);
          for (const table of LEARNING_TABLES) await wipe(table, 'namespace', run);
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

beforeEach(() => {
  globalLLMProviderHealth.reset();
  // The learning layer prints its manifest at an agent's first session.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // The clock stands still: every memory of an ask is filed in one millisecond.
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The millisecond every memory of an ask is filed in. */
const FILED_AT = Date.UTC(2026, 10, 14, 9, 0, 0);
const QUESTION = 'Which lantern glows tonight?';
/**
 * The agent's replies the question matches, in the order they are filed: each shares the one word `lantern` with the
 * question and with nothing else filed, so each scores the same against it.
 */
const LANTERNS = [
  'Lantern amber quarry violet.',
  'Lantern birch lagoon walnut.',
  'Lantern cobalt meadow pepper.',
  'Lantern dahlia orchard saffron.',
  'Lantern ember tundra juniper.',
  'Lantern fennel canyon indigo.',
];
/**
 * The user's statements: each turn's recall reads the statement, and records an access of the five memories it scores
 * highest. Six turns come before the first lantern, so those five are always earlier statements, which share words with
 * each other and none with a lantern, and no lantern is accessed before the question: the six differ in nothing a
 * score reads.
 */
const STATEMENTS = Array.from({ length: 6 + LANTERNS.length }, (_, i) => `Garden row ${i + 1} weeded, hose coiled near fence.`);
const REPLIES = [...Array.from({ length: 6 }, () => 'Noted.'), ...LANTERNS];

/**
 * Files the turns through one agent's session, closes it, writes again the rows of the lanterns in `touched`, and asks
 * the question in the same session of a second agent built on the store. Returns the question's memory block as the
 * provider received it and the turn's recall record.
 */
async function askAfterRestart(db: OpenStore, touched: readonly string[]) {
  ids.next = 0;
  vi.setSystemTime(FILED_AT);
  const k = key();
  const emb = key();
  const s = script('openai', k, { replies: [...REPLIES.map((text) => reply.text(text)), reply.text('Lit.')] });
  script('openai', emb, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', emb);
  const build = async () => {
    const memory: MemoryConfig = { embedding: { provider: 'openai' }, store: await db.store() };
    return agent({
      runtime: 'gmi',
      name: 'Lamplighter',
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      cognition: { memory, mechanisms: false },
      learning: { agentKey: AGENT_KEY, mode: 'off', ...(db.namespace ? { namespace: db.namespace } : {}) },
    } as unknown as AgentOptions);
  };

  const writer = await build();
  try {
    const filing = writer.session('user-1');
    for (const statement of STATEMENTS) await filing.send(statement);
  } finally {
    await writer.close();
  }
  await db.touch(touched);

  const reader = await build();
  try {
    const result = await reader.session('user-1').send(QUESTION);
    expect(result.text).toBe('Lit.');
    const capture = result.memoryRecall as MemoryRecallCapture | undefined;
    expect(capture, 'the turn records its recall').toBeDefined();
    return { block: memoryBlockOf(s, STATEMENTS.length), capture: capture! };
  } finally {
    await reader.close();
  }
}

/**
 * The lanterns are the candidates the question scores highest, all equal, and the record and the block list them by
 * id in character-code order. Returns their ids in that order.
 */
function expectLanternsById(out: Awaited<ReturnType<typeof askAfterRestart>>): string[] {
  const { block, capture } = out;
  const top = Math.max(...capture.candidates.map((c) => c.fusedScore));
  const tied = capture.candidates.filter((c) => c.fusedScore === top);
  expect(tied, 'the lanterns score the same, and highest').toHaveLength(LANTERNS.length);
  expect(capture.candidates.slice(0, LANTERNS.length)).toEqual(tied);
  for (const c of tied) expect(c.outcome).toBe('included');
  const tiedIds = tied.map((c) => c.id);
  expect(tiedIds, 'equally scored memories of one millisecond, by id in character-code order').toEqual([...tiedIds].sort());
  // The ids tell the two orders an engine could give apart: a language's collation puts them in another order.
  expect([...tiedIds].sort((a, b) => a.localeCompare(b, 'en'))).not.toEqual([...tiedIds].sort());

  // The block shows each lantern, in the record's order, which is not the order they were filed in.
  for (const lantern of LANTERNS) expect(block).toContain(lantern);
  const shown = [...LANTERNS].sort((a, b) => block.indexOf(a) - block.indexOf(b));
  expect(shown, 'the block does not list them in the order they were filed').not.toEqual(LANTERNS);
  return tiedIds;
}

describe.each(ENGINES)("agent({ runtime: 'gmi' }) memories of one millisecond over a durable store on $name", ({ open }) => {
  it('come back by id, and two stores of the same memories, with different rows updated, send the same block', async () => {
    const a = await open();
    const b = await open();
    try {
      const first = await askAfterRestart(a, [LANTERNS[1], LANTERNS[3]]);
      const second = await askAfterRestart(b, [LANTERNS[0], LANTERNS[2], LANTERNS[4]]);
      expect(expectLanternsById(second)).toEqual(expectLanternsById(first));
      expect(second.block).toBe(first.block);
      expect(second.capture.candidates.map((c) => c.id)).toEqual(first.capture.candidates.map((c) => c.id));
    } finally {
      await a.close();
      await b.close();
    }
  });
});

it.runIf(Boolean(POSTGRES_URL))('SQLite and PostgreSQL send the same block for memories of one millisecond', async () => {
  const onSqlite = await sqlite.open();
  const onPostgres = await postgres(POSTGRES_URL!).open();
  try {
    const fromSqlite = await askAfterRestart(onSqlite, []);
    const fromPostgres = await askAfterRestart(onPostgres, [LANTERNS[0], LANTERNS[5]]);
    expect(expectLanternsById(fromPostgres)).toEqual(expectLanternsById(fromSqlite));
    expect(fromPostgres.block).toBe(fromSqlite.block);
    expect(fromPostgres.capture.candidates.map((c) => c.id)).toEqual(fromSqlite.capture.candidates.map((c) => c.id));
  } finally {
    await onSqlite.close();
    await onPostgres.close();
  }
});
