/**
 * `memory.recall.retrieval` on agent({ runtime: 'gmi' }), end to end: the real provider manager, completion gateway,
 * GMI, prompt engine, memory bridge and cognitive memory manager run; only the provider classes are stubbed
 * (helpers/stubProviders.ts), and the OpenAI stub embeds with a deterministic word hash. The session files three
 * statements through its own sends, clears its history and asks; the case reads the memory block from the request the
 * provider received and the recall record from the turn's result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
// Trace ids from a counter that `turn()` starts again for each agent: the block's Active Context lists the ids of the
// traces in focus, so two agents fed the same statements send the same block only when their ids match.
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../cognition/memory/core/util/crossPlatformCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/util/crossPlatformCrypto')>();
  return { ...actual, uuid: () => `trace-${String(++ids.next).padStart(4, '0')}` };
});
import { agent, type AgentOptions } from '../agent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { resetRecallLogOnce } from '../../cognition/memory/retrieval/recall/log';
import type { ChatMessage } from '../../core/llm/providers/IProvider';

let n = 0;
const key = () => `k-memory-hybrid-${++n}`;

type Candidate = { id: string; ranks: { dense?: number; exact_words?: number; recency?: number }; outcome: string; reason?: string; duplicateOf?: string; reserve?: boolean; section?: string };
type Capture = {
  retrieval: string;
  lexicalBackend: string;
  legs: Array<{ leg: string; ran: boolean; reason?: string }>;
  allocation: Record<string, number | undefined>;
  candidates: Candidate[];
};

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

/** The memory block of request `call`, or '' when that request carried none (a turn that recalled nothing). */
function blockOrNone(s: ProviderScript, call: number): string {
  const request = s.seen[call];
  expect(request, `model call ${call}`).toBeDefined();
  const holders = request.messages.map(textOf).filter((text) => text.includes(PREAMBLE_HEADING));
  return holders.length === 0 ? '' : memoryBlockOf(s, call);
}

const logged: Record<string, unknown>[] = [];
const events = (name: string) => logged.filter((line) => line.event === name);

beforeEach(() => {
  globalLLMProviderHealth.reset();
  resetRecallLogOnce();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  resetRecallLogOnce();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const STATEMENTS = ['The bike shed code is XQ7Z.', 'I water the tomatoes every second day.', 'My sister Ana lives in Porto.'];

/** Files the statements, clears the history, asks the code, and returns the last request's block, the turn's embedding calls and its record. */
async function turn(recall: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}, memory: Record<string, unknown> = {}) {
  ids.next = 0;
  const k = key();
  const emb = key();
  const s = script('openai', k, { replies: [...STATEMENTS.map(() => reply.text('Noted.')), reply.text('XQ7Z.')] });
  const embedder = script('openai', emb, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', emb);
  // One memory config, under cognition.memory: with a cognition config, `cognition.memory` is the memory config whole.
  const a = agent({
    runtime: 'gmi',
    name: 'Shed',
    provider: 'openai',
    model: 'stub-model',
    apiKey: k,
    fallbackProviders: [],
    cognition: { memory: { embedding: { provider: 'openai' }, ...memory, ...(recall ? { recall } : {}) }, mechanisms: false },
    ...extra,
  } as unknown as AgentOptions);
  try {
    const session = a.session('s');
    for (const statement of STATEMENTS) await session.send(statement);
    session.clear();
    const before = embedder.embedCalls;
    const result = await session.send('What is the bike shed code?');
    return {
      text: (result as unknown as { text: string }).text,
      block: memoryBlockOf(s, STATEMENTS.length),
      embedCalls: embedder.embedCalls - before,
      memoryRecall: (result as unknown as { memoryRecall?: Capture }).memoryRecall!,
    };
  } finally {
    await a.close();
  }
}

/** The error a build fails with, whether `agent()` throws it or the first send rejects with it. */
async function failureOf(build: () => { session(id: string): { send(text: string): Promise<unknown> }; close(): Promise<void> }): Promise<string> {
  let built: ReturnType<typeof build> | undefined;
  try {
    built = build();
    await built.session('s').send('hi');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await built?.close().catch(() => undefined);
  }
  return '';
}

/**
 * Files `statements` through the session's own sends, clears its history and asks `question`; `embedding` sets the
 * embedding provider's script (its `failEmbedding` among them). Returns the question's block, record and the scripts.
 */
async function ask(recall: Record<string, unknown> | undefined, statements: readonly string[], question: string, embedding: Partial<ProviderScript> = {}) {
  const k = key();
  const emb = key();
  const s = script('openai', k, { replies: [...statements.map(() => reply.text('Noted.')), reply.text('XQ7Z.')] });
  const embedder = script('openai', emb, { replies: [], ...embedding });
  vi.stubEnv('OPENAI_API_KEY', emb);
  const a = agent({
    runtime: 'gmi',
    name: 'Shed',
    provider: 'openai',
    model: 'stub-model',
    apiKey: k,
    fallbackProviders: [],
    cognition: { memory: { embedding: { provider: 'openai' }, ...(recall ? { recall } : {}) }, mechanisms: false },
  } as unknown as AgentOptions);
  try {
    const session = a.session('s');
    for (const statement of statements) await session.send(statement);
    session.clear();
    const result = await session.send(question);
    return {
      text: (result as unknown as { text: string }).text,
      block: blockOrNone(s, statements.length),
      embedder,
      memoryRecall: (result as unknown as { memoryRecall?: Capture }).memoryRecall!,
    };
  } finally {
    await a.close();
  }
}

describe("agent({ runtime: 'gmi' }) memory.recall.retrieval", () => {
  it("'hybrid' reaches the manager: three legs, one recall section, the same embedding calls as dense", async () => {
    const dense = await turn(undefined);
    const hybrid = await turn({ retrieval: 'hybrid' });
    expect(dense.memoryRecall.retrieval).toBe('dense');
    expect(hybrid.memoryRecall).toMatchObject({ retrieval: 'hybrid', lexicalBackend: 'in_process' });
    expect(hybrid.memoryRecall.legs.map((l) => l.leg)).toEqual(['dense', 'exact_words', 'recency']);
    expect(hybrid.memoryRecall.legs.every((l) => l.ran)).toBe(true);
    expect(hybrid.embedCalls).toBe(dense.embedCalls);
    expect(hybrid.block).toContain('XQ7Z');
    expect(hybrid.block.match(/^## Relevant Memories/gm)).toHaveLength(1);
    expect(hybrid.block).not.toContain('## Recent Experiences');
  });

  it("retrieval 'dense' set outright on a GMI turn sends the block of no setting, byte for byte, from the dense leg alone", async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12, 0, 0));
    try {
      const unset = await turn(undefined);
      const dense = await turn({ retrieval: 'dense' });
      expect(unset.block).toContain('XQ7Z');
      expect(dense.block).toBe(unset.block);
      expect(dense.embedCalls).toBe(unset.embedCalls);
      expect(dense.memoryRecall.retrieval).toBe('dense');
      expect(dense.memoryRecall.legs.map((l) => l.leg)).toEqual(['dense']);
      expect(dense.memoryRecall.candidates.every((c) => c.ranks.exact_words === undefined && c.ranks.recency === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'hybrid' with capture 'off' on a GMI turn records nothing and still sends the one recall section, byte for byte as with a record", async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12, 0, 0));
    try {
      const recorded = await turn({ retrieval: 'hybrid', capture: 'metadata' });
      const off = await turn({ retrieval: 'hybrid', capture: 'off' });
      // With no record the manager reads the setting itself: the pool is still shown as one section.
      expect(off.memoryRecall).toBeUndefined();
      expect(off.block).toContain('XQ7Z');
      expect(off.block.match(/^## Relevant Memories/gm)).toHaveLength(1);
      expect(off.block).not.toContain('## Recent Experiences');
      expect(off.block).toBe(recorded.block);
      expect(off.embedCalls).toBe(recorded.embedCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with memory.store the exact-words leg reads the durable index', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmi-hybrid-'));
    try {
      const durable = await turn({ retrieval: 'hybrid' }, { learning: { agentKey: 'hybrid-e2e', mode: 'off' } }, { store: { path: path.join(dir, 'brain.sqlite') } });
      // FTS5, or FTS4 where the file opened through sql.js (no better-sqlite3).
      expect(['fts5', 'fts4']).toContain(durable.memoryRecall.lexicalBackend);
      expect(durable.memoryRecall.legs.every((l) => l.ran)).toBe(true);
      expect(durable.block).toContain('XQ7Z');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown retrieval at construction, and any retrieval on the default runtime', () => {
    expect(() =>
      agent({
        runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: key(),
        cognition: { memory: { embedding: { provider: 'openai' }, recall: { retrieval: 'sparse' } }, mechanisms: false },
      } as unknown as AgentOptions),
    ).toThrow('memory.recall.retrieval');
    expect(() => agent({ provider: 'openai', model: 'stub-model', apiKey: key(), memory: { recall: { retrieval: 'hybrid' } } } as unknown as AgentOptions)).toThrow(
      /memory\.recall\.retrieval.*runtime: 'gmi'/s,
    );
    expect(events('memory.recall.option_rejected').map((e) => [e.option, e.reason])).toEqual([
      ['retrieval', 'invalid_value'],
      ['retrieval', 'unsupported_runtime'],
    ]);
  });

  it("an Anthropic-only build with memory.store and no embedding model fails as it fails today, with 'hybrid' as without it", async () => {
    for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_BASE_URL']) vi.stubEnv(name, '');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmi-hybrid-anthropic-'));
    try {
      const build = (recall?: Record<string, unknown>) => () =>
        agent({
          runtime: 'gmi', provider: 'anthropic', model: 'claude-x', apiKey: key(), fallbackProviders: [],
          cognition: { memory: { store: { path: path.join(dir, 'never-opened.sqlite') }, ...(recall ? { recall } : {}) }, mechanisms: false },
          learning: { agentKey: 'x', mode: 'off' },
        } as unknown as AgentOptions) as unknown as { session(id: string): { send(text: string): Promise<unknown> }; close(): Promise<void> };
      const without = await failureOf(build());
      const hybrid = await failureOf(build({ retrieval: 'hybrid' }));
      expect(without).toContain('cognitive memory needs an embedding model');
      expect(hybrid).toBe(without);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("'hybrid' on a GMI turn: one recall section in the record's allocation and its lines, and two near-duplicate memories shown once with the dropped one recorded against the one shown", async () => {
    const statements = ['The bike shed code is XQ7Z.', 'I water the tomatoes every second day.', 'The bike shed code is XQ7Z!'];
    const dense = await ask(undefined, statements, 'What is the bike shed code?');
    const hybrid = await ask({ retrieval: 'hybrid' }, statements, 'What is the bike shed code?');

    // Precondition: dense recall shows both copies, so the hybrid block showing one is the dedupe's doing.
    expect((dense.block.match(/XQ7Z/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(dense.memoryRecall.candidates.filter((c) => c.reason === 'dedupe')).toEqual([]);

    expect(hybrid.block.match(/XQ7Z/g)).toHaveLength(1);
    expect(hybrid.block.match(/^## Relevant Memories/gm)).toHaveLength(1);
    expect(hybrid.block).not.toContain('## Semantic Recall');
    expect(hybrid.block).not.toContain('## Recent Experiences');

    const recall = hybrid.memoryRecall;
    expect(recall.allocation.recall).toBeGreaterThan(0);
    expect(recall.allocation).toMatchObject({ semanticRecall: 0, recentEpisodic: 0 });

    const byId = new Map(recall.candidates.map((c) => [c.id, c]));
    const dropped = recall.candidates.filter((c) => c.reason === 'dedupe');
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    for (const d of dropped) {
      expect(d.outcome).toBe('left_out');
      // Each dropped copy names the candidate that holds its place, and that one is in the block.
      expect(byId.get(d.duplicateOf!), `holder of ${d.id}`).toMatchObject({ outcome: 'included' });
    }
    // The code's copies: one included, one dropped against it (both rank first or second by exact words).
    const codeCopies = recall.candidates.filter((c) => c.ranks.exact_words !== undefined && c.ranks.exact_words <= 2);
    expect(codeCopies.map((c) => c.outcome).sort()).toEqual(['included', 'left_out']);
    const droppedCopy = codeCopies.find((c) => c.outcome === 'left_out')!;
    expect(droppedCopy.duplicateOf).toBe(codeCopies.find((c) => c.outcome === 'included')!.id);

    // Every recalled line the block shows is in the one recall section.
    const included = recall.candidates.filter((c) => c.outcome === 'included' && c.section !== 'involuntary');
    expect(included.length).toBeGreaterThan(0);
    for (const c of included) expect(c.section, c.id).toBe('recall');
  });

  it("'hybrid' on a GMI turn: a correction that changes one word in a longer memory is sent in place of the text it corrects", async () => {
    const sister = 'My sister Ana moved out of the old riverside flat last spring and now lives in';
    const statements = [`${sister} Porto.`, 'I water the tomatoes every second day.', `${sister} Lisbon.`];
    const question = 'Does my sister Ana still live in Porto?';
    const dense = await ask(undefined, statements, question);
    // Precondition: dense recall shows both texts, so the hybrid block showing one is the dedupe's doing.
    expect(dense.block).toContain('lives in Porto');
    expect(dense.block).toContain('lives in Lisbon');

    const hybrid = await ask({ retrieval: 'hybrid' }, statements, question);
    expect(hybrid.block).toContain('lives in Lisbon');
    expect(hybrid.block).not.toContain('lives in Porto');
    // The old text ranks first by exact words (the question names its city) and is the one dropped. (The session's
    // three "Noted." replies are one memory too, so they are not the only candidates the dedupe drops.)
    const old = hybrid.memoryRecall.candidates.find((c) => c.ranks.exact_words === 1)!;
    expect(old).toMatchObject({ outcome: 'left_out', reason: 'dedupe' });
    expect(hybrid.memoryRecall.candidates.find((c) => c.id === old.duplicateOf)).toMatchObject({ outcome: 'included', section: 'recall' });
  });

  it("'hybrid' on a GMI turn: a memory question sends the exact-words hit the cut left out; the same words without the question leave it out for the budget", async () => {
    type Reserved = Omit<Capture, 'candidates'> & { memoryQuestionReserve: { fired: boolean; added: number }; candidates: Array<Candidate & { reserve?: boolean }> };
    const GOLD = 'The bike shed code is XQ7Z.';
    // Filed first, then 64 notes whose words are the questions' stop words and a number: by meaning the notes are
    // nearer, so the dense leg's sixty are notes, and no note shares a word the exact-words leg reads. Only the code's
    // exact word finds the oldest memory, and its fused score sorts it after every note the dense leg returned.
    const statements = [GOLD, ...Array.from({ length: 64 }, (_, i) => `Note ${i + 10}: what it is you and I are on, and where it is.`)];
    const k = key();
    const emb = key();
    const s = script('openai', k, { replies: [...statements.map(() => reply.text('Noted.')), reply.text('Noted.'), reply.text('Noted.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = agent({
      runtime: 'gmi',
      name: 'Shed',
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      fallbackProviders: [],
      cognition: { memory: { embedding: { provider: 'openai' }, recall: { retrieval: 'hybrid' } }, mechanisms: false },
    } as unknown as AgentOptions);
    try {
      const session = a.session('s');
      for (const statement of statements) await session.send(statement);
      session.clear();
      const plain = (await session.send('What is it you and I are on, and where is XQ7Z?')) as unknown as { memoryRecall: Reserved };
      session.clear();
      const asked = (await session.send('Do you remember what it is you and I are on, and where is XQ7Z?')) as unknown as { memoryRecall: Reserved };
      const plainBlock = memoryBlockOf(s, statements.length);
      const askedBlock = memoryBlockOf(s, statements.length + 1);

      // Without a memory question: ranked first by exact words, never by meaning, and cut for the budget.
      expect(plain.memoryRecall.memoryQuestionReserve).toEqual({ fired: false, added: 0 });
      const left = plain.memoryRecall.candidates.find((c) => c.ranks.exact_words === 1)!;
      expect(left).toMatchObject({ outcome: 'left_out', reason: 'budget' });
      expect(left.ranks.dense).toBeUndefined();
      expect(left.reserve).toBeUndefined();
      expect(plainBlock).not.toContain(GOLD.slice(0, -1));

      // With one: the same memory is reserved, shown in the recall section, and the model receives it.
      expect(asked.memoryRecall.memoryQuestionReserve).toEqual({ fired: true, added: 1 });
      expect(asked.memoryRecall.candidates.find((c) => c.id === left.id)).toMatchObject({ reserve: true, outcome: 'included', section: 'recall' });
      expect(asked.memoryRecall.candidates.filter((c) => c.reserve)).toHaveLength(1);
      expect(askedBlock).toContain(GOLD.slice(0, -1));
      expect(askedBlock.match(/^## Relevant Memories/gm)).toHaveLength(1);
      expect(events('memory.recall.reserve_fired')).toEqual([expect.objectContaining({ added: 1 })]);
    } finally {
      await a.close();
    }
  });

  it("'hybrid' with capture 'off' on a GMI turn: a memory question still sends the reserved memory, as with a record", async () => {
    const GOLD = 'The bike shed code is XQ7Z.';
    // The fixture of the case above: only the code's exact word finds the oldest memory, and the cut leaves it out.
    const statements = [GOLD, ...Array.from({ length: 64 }, (_, i) => `Note ${i + 10}: what it is you and I are on, and where it is.`)];
    const run = async (capture: 'metadata' | 'off') => {
      logged.length = 0;
      const k = key();
      const emb = key();
      const s = script('openai', k, { replies: [...statements.map(() => reply.text('Noted.')), reply.text('Noted.'), reply.text('Noted.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = agent({
        runtime: 'gmi',
        name: 'Shed',
        provider: 'openai',
        model: 'stub-model',
        apiKey: k,
        fallbackProviders: [],
        cognition: { memory: { embedding: { provider: 'openai' }, recall: { retrieval: 'hybrid', capture } }, mechanisms: false },
      } as unknown as AgentOptions);
      try {
        const session = a.session('s');
        for (const statement of statements) await session.send(statement);
        session.clear();
        await session.send('What is it you and I are on, and where is XQ7Z?');
        session.clear();
        const asked = (await session.send('Do you remember what it is you and I are on, and where is XQ7Z?')) as unknown as { memoryRecall?: unknown };
        return {
          plainBlock: memoryBlockOf(s, statements.length),
          askedBlock: memoryBlockOf(s, statements.length + 1),
          memoryRecall: asked.memoryRecall,
          reserveFired: events('memory.recall.reserve_fired'),
        };
      } finally {
        await a.close();
      }
    };
    const recorded = await run('metadata');
    const off = await run('off');
    // Precondition: with a record the memory question reserved the memory and the plain question left it out.
    expect(recorded.askedBlock).toContain(GOLD.slice(0, -1));
    expect(recorded.plainBlock).not.toContain(GOLD.slice(0, -1));
    // With no record the block still reserves the same room: the model receives the memory, and the line counts it.
    expect(off.memoryRecall).toBeUndefined();
    expect(off.plainBlock).not.toContain(GOLD.slice(0, -1));
    expect(off.askedBlock).toContain(GOLD.slice(0, -1));
    expect(off.askedBlock.match(/^## Relevant Memories/gm)).toHaveLength(1);
    expect(off.reserveFired).toEqual([expect.objectContaining({ added: 1 })]);
    expect(recorded.reserveFired).toEqual([expect.objectContaining({ added: 1 })]);
  });

  it("'hybrid' on a GMI turn whose question the embedding provider fails on: the dense leg is absent, exact words still put the memory in the block", async () => {
    const MARK = 'tarpaulin';
    const statements = ['The bike shed code is XQ7Z.', 'I water the tomatoes every second day.', 'My sister Ana lives in Porto.'];
    const question = `What is the bike shed code under the ${MARK}?`;
    const dense = await ask(undefined, statements, question, { failEmbedding: (text) => text.includes(MARK) });
    // The leg_absent line is once a process: start the hybrid turn's count from none.
    resetRecallLogOnce();
    logged.length = 0;
    const hybrid = await ask({ retrieval: 'hybrid' }, statements, question, { failEmbedding: (text) => text.includes(MARK) });

    // The provider was asked to embed the question and failed; both turns answered.
    expect(hybrid.embedder.embedded.some((text) => text.includes(MARK))).toBe(true);
    expect(dense.text).toBe('XQ7Z.');
    expect(hybrid.text).toBe('XQ7Z.');

    // Dense recall has nothing to rank; hybrid's other two legs run.
    expect(dense.memoryRecall.candidates.filter((c) => c.ranks.dense !== undefined)).toEqual([]);
    expect(dense.block).not.toContain('XQ7Z');
    expect(hybrid.memoryRecall.legs.map((l) => [l.leg, l.ran, l.reason])).toEqual([
      ['dense', false, 'no_embedder'],
      ['exact_words', true, undefined],
      ['recency', true, undefined],
    ]);
    expect(hybrid.memoryRecall.lexicalBackend).toBe('in_process');

    const first = hybrid.memoryRecall.candidates.find((c) => c.ranks.exact_words === 1);
    expect(first).toMatchObject({ outcome: 'included', section: 'recall' });
    expect(first!.ranks.dense).toBeUndefined();
    expect(hybrid.block).toContain('XQ7Z');
    expect(hybrid.block.match(/^## Relevant Memories/gm)).toHaveLength(1);

    // One leg_absent line for the dense leg, naming no words of the turn.
    const absent = events('memory.recall.leg_absent');
    expect(absent).toEqual([expect.objectContaining({ leg: 'dense', reason: 'no_embedder' })]);
    expect(JSON.stringify(absent)).not.toContain(MARK);
  });
});

describe("agent({ runtime: 'gmi' }) memory.recall.rerank", () => {
  const emptyRanking = async (): Promise<string> => '[]';

  const refused: Array<[Record<string, unknown>, string, string]> = [
    [{ rerank: { kind: 'cohere', apiKey: 'k' } }, 'rerank', 'unsupported_provider'],
    [{ rerank: { kind: 'local', model: 'cross-encoder/ms-marco-MiniLM-L6-v2' } }, 'rerank.revision', 'invalid_value'],
    [{ rerank: { kind: 'local', model: ' ', revision: 'abc' } }, 'rerank.model', 'invalid_value'],
    [{ rerank: { kind: 'llm', model: 'm' } }, 'rerank.invoke', 'invalid_value'],
    [{ rerank: { kind: 'llm', invoke: emptyRanking, model: 'm', timeoutMs: 0 } }, 'rerank.timeoutMs', 'invalid_value'],
    [{ rerank: { kind: 'llm', invoke: emptyRanking, model: 'm', timeoutMs: 2_147_483_648 } }, 'rerank.timeoutMs', 'invalid_value'],
    [{ rerank: { kind: 'local', model: 'cross-encoder/ms-marco-MiniLM-L6-v2', revision: '233902D25C440F23AF6F7D6E94D2946BAC0BEE0A' } }, 'rerank.revision', 'invalid_value'],
    [{ rerank: { kind: 'llm', invoke: emptyRanking, model: 'm', maxCandidates: 2.5 } }, 'rerank.maxCandidates', 'invalid_value'],
    [{ rerank: 'cohere' }, 'rerank', 'invalid_value'],
  ];
  it.each(refused)('rejects %j at construction, naming memory.recall.%s', (recall, field, reason) => {
    expect(() =>
      agent({
        runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: key(),
        cognition: { memory: { embedding: { provider: 'openai' }, recall }, mechanisms: false },
      } as unknown as AgentOptions),
    ).toThrow(`memory.recall.${field}`);
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option: field, reason })]);
  });

  const anyValue: Array<[unknown]> = [[{ kind: 'llm', invoke: emptyRanking, model: 'm' }], ['none']];
  it.each(anyValue)('rerank %j on the default runtime is refused: any value, the default included', (rerank) => {
    expect(() => agent({ provider: 'openai', model: 'stub-model', apiKey: key(), memory: { recall: { rerank } } } as unknown as AgentOptions)).toThrow(
      /memory\.recall\.rerank.*runtime: 'gmi'/s,
    );
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option: 'rerank', reason: 'unsupported_runtime' })]);
  });

  it('an llm rerank set on agent() reaches the turn: the record names the provider and the model, and the judge saw the candidates', async () => {
    const seen: string[] = [];
    const invoke = async (system: string, user: string): Promise<string> => {
      seen.push(user);
      // A score for each memory sent, the first the highest; then a ranking of them in the order it was given.
      return system.includes('relevance scorer')
        ? JSON.stringify((user.match(/^\[\d+\]/gm) ?? []).map((_, i) => (i === 0 ? 9 : 1)))
        : JSON.stringify([...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]));
    };
    const out = await turn({ rerank: { kind: 'llm', model: 'judge-model', invoke } });
    const record = out.memoryRecall as unknown as { reranker: Record<string, unknown>; candidates: Array<{ rerankScore?: number }> };
    expect(record.reranker).toMatchObject({ provider: 'llm', model: 'judge-model' });
    expect(record.candidates.some((c) => typeof c.rerankScore === 'number')).toBe(true);
    expect(seen.join('\n')).toContain('XQ7Z');
    expect(out.block).toContain('XQ7Z');
  });

  // The largest timeoutMs the setting takes is a delay a timer keeps: a judge that answers 30 ms into each call of the
  // question's rerank is waited for, by the rerank's own deadline and by the judge's. One past it, which construction
  // refuses above, a Node timer runs after 1 ms and every rerank would end in 'timeout'.
  it('an llm rerank at the largest timeoutMs (2,147,483,647) on a GMI turn waits for a judge that answers after 30 ms', async () => {
    const QUESTION = 'Query: "What is the bike shed code?"';
    let late = 0;
    const invoke = async (system: string, user: string): Promise<string> => {
      if (user.includes(QUESTION)) {
        late += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
      }
      return system.includes('relevance scorer')
        ? JSON.stringify((user.match(/^\[\d+\]/gm) ?? []).map((_, i) => (i === 0 ? 9 : 1)))
        : JSON.stringify([...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]));
    };
    const out = await turn({ rerank: { kind: 'llm', model: 'judge-model', invoke, timeoutMs: 2_147_483_647 } });
    // Precondition: the judge was asked about the question and answered late.
    expect(late).toBeGreaterThan(0);
    const record = out.memoryRecall as unknown as { reranker: Record<string, unknown>; candidates: Array<{ rerankScore?: number }> };
    expect(record.reranker).toMatchObject({ provider: 'llm', model: 'judge-model' });
    expect(record.candidates.some((c) => typeof c.rerankScore === 'number')).toBe(true);
    expect(out.text).toBe('XQ7Z.');
    expect(out.block).toContain('XQ7Z');
    expect(events('memory.recall.rerank_skipped')).toEqual([]);
    expect(events('memory.recall.option_rejected')).toEqual([]);
  });

  it("rerank 'none' set outright on a GMI turn sends the block of no setting, byte for byte", async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12, 0, 0));
    try {
      const unset = await turn(undefined);
      const none = await turn({ rerank: 'none' });
      expect(unset.block).toContain('XQ7Z');
      expect(none.block).toBe(unset.block);
      expect((none.memoryRecall as unknown as { reranker: unknown }).reranker).toEqual({ provider: 'none', reason: 'none_configured' });
    } finally {
      vi.useRealTimers();
    }
  });

  // Fail-open on the real path: a judge that rejects, or one that never answers inside its timeout, leaves the block
  // the model receives as it is with no rerank, and the turn still answers.
  const failing: Array<['dense' | 'hybrid', 'error' | 'timeout']> = [
    ['dense', 'error'],
    ['hybrid', 'error'],
    ['dense', 'timeout'],
    ['hybrid', 'timeout'],
  ];
  it.each(failing)("under %s a judge that ends in %s on a GMI turn sends the block of no rerank, byte for byte, and the turn answers", async (retrieval, mode) => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12, 0, 0));
    try {
      const plain = await turn({ retrieval });
      const QUESTION = 'Query: "What is the bike shed code?"';
      const asked: string[] = [];
      // The turns that file the statements recall too: there the judge answers, every memory scored alike and ranked
      // as sent, so their order stands and no failure counts toward a back-off. Only the question's rerank fails.
      const invoke = (system: string, user: string): Promise<string> => {
        if (!user.includes(QUESTION)) {
          return Promise.resolve(
            system.includes('relevance scorer')
              ? JSON.stringify((user.match(/^\[\d+\]/gm) ?? []).map(() => 5))
              : JSON.stringify([...user.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1])),
          );
        }
        asked.push(user);
        return mode === 'error' ? Promise.reject(new Error('provider down')) : new Promise<string>(() => undefined);
      };
      const judged = await turn({ retrieval, rerank: { kind: 'llm', model: 'judge-model', invoke, ...(mode === 'timeout' ? { timeoutMs: 50 } : {}) } });
      // Precondition: the judge was asked about the question, with the turn's own text as its query.
      expect(asked.length).toBeGreaterThan(0);
      expect(plain.block).toContain('XQ7Z');
      expect(judged.block).toBe(plain.block);
      expect(judged.text).toBe('XQ7Z.');
      const record = judged.memoryRecall as unknown as { reranker: unknown; candidates: Array<{ rerankScore?: number }> };
      expect(record.reranker).toEqual({ provider: 'none', reason: mode });
      expect(record.candidates.every((c) => c.rerankScore === undefined)).toBe(true);
      expect(events('memory.recall.rerank_skipped')).toEqual([expect.objectContaining({ provider: 'llm', reason: mode })]);
    } finally {
      vi.useRealTimers();
    }
  });
});
