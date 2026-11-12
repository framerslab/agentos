/**
 * @fileoverview What a hybrid turn runs when a leg cannot: no Brain (all three legs in process), a Brain with no
 * full-text index (meaning and recency), an embedder that gives no vector or throws (exact words and recency), a
 * vector store that throws (the dense leg absent for the turn), and every leg absent (the turn still assembles). Each
 * absent leg is in the record with its reason and writes one `memory.recall.leg_absent` line per process.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { PADState } from '../../src/cognition/memory/core/config';
import type { Brain } from '../../src/cognition/memory/retrieval/store/Brain';
import { resetRecallLogOnce } from '../../src/cognition/memory/retrieval/recall/log';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory';
import { ENGINES, U1, WordHashEmbedder } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const QUESTION = 'What is the bike shed code?';

const logged: Array<Record<string, unknown>> = [];
const events = (name: string) => logged.filter((line) => line.event === name);
const opened: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  resetRecallLogOnce();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetLoggerFactory();
  resetRecallLogOnce();
  for (const db of opened.splice(0)) await db.close();
});

/** `brain` with its full-text statements failing as a build without the module does, and, with `all`, every read. */
function failing(brain: Brain, message: string, every = { down: false }): Brain {
  return new Proxy(brain, {
    get: (target, property) =>
      property === 'all'
        ? async (sql: string, params?: unknown[]) => {
            if (sql.includes('memory_traces_fts') || sql.includes('_tsv')) throw new Error(message);
            if (every.down && sql.includes('FROM memory_traces')) throw new Error('connection reset');
            return target.all(sql, params as never);
          }
        : Reflect.get(target, property, target),
  });
}

async function withBrain(wrap: (brain: Brain) => Brain, embedder = new WordHashEmbedder()) {
  const db = await ENGINES[0][1]();
  opened.push(db);
  return { mem: await memoryWith({ retrieval: 'hybrid' }, embedder, wrap(db.brain)), embedder };
}

type Capture = { legs: Array<{ leg: string; ran: boolean; reason?: string }>; lexicalBackend: string; candidates: unknown[] };
const legsOf = (c: Capture) => Object.fromEntries(c.legs.map((l) => [l.leg, l.ran ? 'ran' : l.reason]));

it.each([
  ['no Brain: the three legs in process', async () => ({ mem: await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder()) }), { dense: 'ran', exact_words: 'ran', recency: 'ran' }, 'in_process'],
  ['a Brain with no full-text module: meaning plus recency', async () => withBrain((brain) => failing(brain, 'no such module: fts5')), { dense: 'ran', exact_words: 'no_index', recency: 'ran' }, 'none'],
  [
    'an embedder that returns no vector: exact words plus recency',
    async () => {
      const e = new WordHashEmbedder();
      return { mem: await memoryWith({ retrieval: 'hybrid' }, e), after: () => { e.empty = true; } };
    },
    { dense: 'no_embedder', exact_words: 'ran', recency: 'ran' },
    'in_process',
  ],
  [
    'an embedder that throws: exact words plus recency',
    async () => {
      const e = new WordHashEmbedder();
      return { mem: await memoryWith({ retrieval: 'hybrid' }, e), after: () => { e.fail = true; } };
    },
    { dense: 'no_embedder', exact_words: 'ran', recency: 'ran' },
    'in_process',
  ],
  [
    'a vector store that throws: the dense leg is absent for the turn',
    async () => {
      const mem = await memoryWith({ retrieval: 'hybrid' }, new WordHashEmbedder());
      return { mem, after: () => { vi.spyOn(mem.manager.getStore(), 'query').mockRejectedValue(new Error('vector store down')); } };
    },
    { dense: 'query_error', exact_words: 'ran', recency: 'ran' },
    'in_process',
  ],
] as const)('%s', async (_name, build, legs, backend) => {
  const { mem, after } = (await build()) as { mem: Awaited<ReturnType<typeof memoryWith>>; after?: () => void };
  await plant(mem, 'gold', 'The bike shed code is XQ7Z.');
  after?.();
  const first = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
  await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
  const capture = first.capture as unknown as Capture;
  expect(legsOf(capture)).toEqual(legs);
  expect(capture.lexicalBackend).toBe(backend);
  expect(first.contextText).toContain('XQ7Z');
  const absent = Object.entries(legs).filter(([, v]) => v !== 'ran');
  // Two turns, one line per (leg, reason).
  expect(events('memory.recall.leg_absent').map((e) => [e.leg, e.reason])).toEqual(absent);
  await mem.close();
});

it('with every leg absent the turn still assembles: the other sections, no recall section', async () => {
  const every = { down: false };
  const { mem, embedder } = await withBrain((brain) => failing(brain, 'no such module: fts5', every));
  await plant(mem, 'gold', 'The bike shed code is XQ7Z.');
  embedder.fail = true;
  every.down = true;
  const out = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
  expect(out.contextText).not.toContain('## Relevant Memories');
  expect(out.contextText).not.toContain('XQ7Z');
  const capture = out.capture as unknown as Capture;
  expect(legsOf(capture)).toEqual({ dense: 'no_embedder', exact_words: 'no_index', recency: 'query_error' });
  expect(capture.candidates).toEqual([]);
  await mem.close();
});
