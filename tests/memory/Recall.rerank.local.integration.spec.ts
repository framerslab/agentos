/**
 * @fileoverview Local memory rerank on the real model, at its pinned revision: `cross-encoder/ms-marco-MiniLM-L6-v2`
 * loaded from files alone, with no download. Nothing is stubbed. The memory reranker loads the revision, scores twenty
 * memories and ranks the one that answers above the one that does not; a revision the files do not hold cannot load,
 * so local is unavailable and the order stands; and a memory manager built with `recall.rerank: { kind: 'local' }`
 * reranks a turn once `recallReady()` resolves.
 *
 * It runs where `AGENTOS_TEST_RERANK_CACHE` names a Transformers.js cache folder holding the revision's files at
 * `cross-encoder/ms-marco-MiniLM-L6-v2/<revision>/{config.json, tokenizer.json, tokenizer_config.json,
 * onnx/model_quint8_avx2.onnx}` (the layout Transformers.js reads a pinned revision from). CI's Test & Lint job lays
 * them out from the files it fetches and checks against pinned sha256 sums, and sets `AGENTOS_TEST_RERANK_MODEL` to
 * `required`, under which a missing file fails here, so a dropped fetch never passes as a skip. Elsewhere the suite is
 * skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory';
import type { PADState } from '../../src/cognition/memory/core/config';
import { resetRecallLogOnce } from '../../src/cognition/memory/retrieval/recall/log';
import { RecallReranker } from '../../src/cognition/memory/retrieval/recall/rerank';
import { U1, WordHashEmbedder } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const DIR = process.env.AGENTOS_TEST_RERANK_CACHE ?? '';
const MODEL = 'cross-encoder/ms-marco-MiniLM-L6-v2';
const REVISION = '233902d25c440f23af6f7d6e94d2946bac0bee0a';
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quint8_avx2.onnx'];
const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };

/** The first of the revision's files the folder lacks or holds empty; `undefined` when it holds them all. */
const missing = FILES.find((file) => {
  if (!DIR) return true;
  const stat = fs.statSync(path.join(DIR, MODEL, REVISION, file), { throwIfNoEntry: false });
  return stat === undefined || !stat.isFile() || stat.size === 0;
});
const present = missing === undefined;

const logged: Array<Record<string, unknown>> = [];
const events = (name: string) => logged.filter((line) => line.event === name);

beforeEach(() => {
  logged.length = 0;
  resetRecallLogOnce();
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  resetRecallLogOnce();
});

it('the pinned files are where the job says they must be', () => {
  if (process.env.AGENTOS_TEST_RERANK_MODEL !== 'required') return;
  expect(missing, `AGENTOS_TEST_RERANK_CACHE=${DIR} lacks ${MODEL}/${REVISION}/${missing}`).toBeUndefined();
});

const QUESTION = 'What is the bike shed code?';
const MEMORIES = [
  { id: 'no', content: 'The tomatoes on row four were watered on Tuesday.', score: 0.9 },
  { id: 'yes', content: 'The bike shed code is XQ7Z.', score: 0.1 },
  ...Array.from({ length: 18 }, (_, i) => ({ id: `f${i}`, content: `Garden note ${i} about the hose and the east fence.`, score: 0.5 })),
];

describe.skipIf(!present)('local memory rerank on the pinned model', () => {
  it('loads the pinned revision from the fetched files alone and ranks the memory that answers above the one that does not', async () => {
    const r = new RecallReranker({ kind: 'local', model: MODEL, revision: REVISION, timeoutMs: 60_000 }, { cacheDir: DIR, localFilesOnly: true });
    r.start();
    await r.ready();
    const started = performance.now();
    const out = await r.rerank(QUESTION, MEMORIES);
    // A measurement for tuning the timeout; nothing is asserted about it.
    console.info(`local rerank of 20 pairs: ${Math.round(performance.now() - started)} ms`);
    expect(out.record).toMatchObject({ provider: 'local', model: MODEL, revision: REVISION, candidates: 20 });
    expect(out.scores.size).toBe(20);
    expect(out.scores.get('yes')!).toBeGreaterThan(out.scores.get('no')!);
    expect(Math.max(...out.scores.values())).toBe(out.scores.get('yes'));
    expect(events('memory.recall.rerank_unavailable')).toEqual([]);
    await r.dispose();
  });

  it('a revision the files do not hold cannot load: local is unavailable with load_failed, and the order stands', async () => {
    const r = new RecallReranker({ kind: 'local', model: MODEL, revision: '0000000000000000000000000000000000000000' }, { cacheDir: DIR, localFilesOnly: true });
    r.start();
    await r.ready();
    expect(await r.rerank('q', [{ id: 'a', content: 'x', score: 1 }])).toEqual({ record: { provider: 'none', reason: 'unavailable' }, scores: new Map() });
    expect(events('memory.recall.rerank_unavailable')).toEqual([expect.objectContaining({ provider: 'local', reason: 'load_failed' })]);
    await r.dispose();
  });

  describe('through a memory manager', () => {
    // The manager's reranker reads Transformers.js's own cache folder, so the folder is set there for these cases,
    // with downloads off: the files it scores with are the pinned ones.
    let env: { cacheDir: string; allowRemoteModels: boolean } | undefined;
    let before: { cacheDir: string; allowRemoteModels: boolean } | undefined;
    beforeAll(async () => {
      env = ((await import('@huggingface/transformers')) as unknown as { env: { cacheDir: string; allowRemoteModels: boolean } }).env;
      before = { cacheDir: env.cacheDir, allowRemoteModels: env.allowRemoteModels };
      env.cacheDir = DIR;
      env.allowRemoteModels = false;
    });
    afterAll(() => {
      if (env && before) Object.assign(env, before);
    });

    it("recall.rerank { kind: 'local' } reranks a turn once recallReady() resolves, and the capture names the model and its revision", async () => {
      const mem = await memoryWith({ rerank: { kind: 'local', model: MODEL, revision: REVISION, timeoutMs: 60_000 } }, new WordHashEmbedder());
      for (const memory of MEMORIES.slice(0, 8)) await plant(mem, memory.id, memory.content);
      await mem.manager.recallReady();
      const context = await mem.manager.assembleForPrompt(QUESTION, 1600, NEUTRAL, { scopes: U1 });
      const capture = context.capture!;
      expect(capture.reranker).toMatchObject({ provider: 'local', model: MODEL, revision: REVISION });
      expect(capture.reranker.candidates).toBeGreaterThan(1);
      const scored = capture.candidates.filter((c) => typeof c.rerankScore === 'number');
      expect(scored.length).toBe(capture.reranker.candidates);
      // The model's own scores: they differ, and the memory that answers has the highest.
      expect(new Set(scored.map((c) => c.rerankScore)).size).toBeGreaterThan(1);
      expect([...scored].sort((x, y) => y.rerankScore! - x.rerankScore!)[0].id).toBe('yes');
      expect(context.contextText).toContain('XQ7Z');
      await mem.close();
    });
  });
});
