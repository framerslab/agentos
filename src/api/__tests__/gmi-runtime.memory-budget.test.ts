/**
 * The `memory.recall` option end to end: `budget.totalTokens` sizes the memory block a GMI turn sends the model, and
 * `capture` sets what the turn records of its recall, read from the request the provider received and from the turn's
 * result. The real provider manager, completion gateway, GMI, prompt engine, memory bridge and cognitive memory manager
 * run; only the provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI stub embeds with a
 * deterministic word hash, so texts that share words recall each other. Trace ids, the clock and the persona id (a
 * named agent's) are fixed, so two agents fed the same statements send the same block. The construction rules are read from what `agent()` throws and
 * from the `memory.recall.*` lines it writes, on the GMI path and on the default runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
// Trace ids from a counter that each agent starts again: the block lists the ids of the traces in focus.
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../cognition/memory/core/util/crossPlatformCrypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/util/crossPlatformCrypto')>();
  return { ...actual, uuid: () => `trace-${String(++ids.next).padStart(4, '0')}` };
});
import { agent, type AgentOptions } from '../agent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import type { MemoryRecallCapture } from '../../cognition/memory/retrieval/recall/capture';

let n = 0;
const key = () => `k-memory-budget-${++n}`;

/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';

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

/** The memory block of the provider request `call`: the text from the preamble heading to where the prompt engine resumes with the user's query. */
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
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
});
afterEach(() => {
  resetLoggerFactory();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const STATEMENTS = Array.from(
  { length: 12 },
  (_, i) =>
    `Harbor ferry note ${i}: the island ferry leaves pier ${i + 3} at ${6 + i}:15 and the ticket desk for that pier opens forty minutes before, beside the blue kiosk with the tide table.`,
);
const QUESTION = 'Which pier does the island harbor ferry leave from?';

type Recall = { budget?: { totalTokens?: number }; capture?: 'off' | 'metadata' | 'metadata+stream' };
/**
 * An agent whose sessions share cognitive memory (no mechanisms) that embeds through OpenAI, with the given recall
 * setting. Named, so its persona id, which each memory line's tags carry, is the same for every agent built here.
 */
const withRecall = (apiKey: string, recall?: Recall) =>
  agent({
    runtime: 'gmi',
    name: 'Harbor',
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    cognition: { memory: { embedding: { provider: 'openai' }, ...(recall ? { recall } : {}) }, mechanisms: false },
  } as unknown as AgentOptions);

/**
 * Files the statements through the session's own sends, clears the history, asks (through `send()`, or `stream()`),
 * and returns the last request's memory block ('' when it carries none), the turn's text and its recall record.
 * `answer` is what the model replies to the question: a reply, or an error the provider throws.
 */
async function ask(recall?: Recall, via: 'send' | 'stream' = 'send', answer: ProviderScript['replies'][number] = reply.text('Pier 3.')) {
  ids.next = 0;
  const k = key(); const emb = key();
  const s = script('openai', k, { replies: [...STATEMENTS.map(() => reply.text('Noted.')), answer] });
  script('openai', emb, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', emb);
  const a = withRecall(k, recall);
  try {
    const session = a.session('s');
    for (const statement of STATEMENTS) await session.send(statement);
    session.clear();
    let text: string;
    let memoryRecall: MemoryRecallCapture | undefined;
    if (via === 'send') {
      const result = await session.send(QUESTION);
      text = result.text;
      memoryRecall = result.memoryRecall;
    } else {
      const result = session.stream(QUESTION);
      text = await result.text;
      memoryRecall = await (result as { memoryRecall?: Promise<MemoryRecallCapture | undefined> }).memoryRecall;
    }
    const request = s.seen[STATEMENTS.length];
    expect(request, 'the question reached the model').toBeDefined();
    const hasBlock = request.messages.map(textOf).some((message) => message.includes(PREAMBLE_HEADING));
    return { block: hasBlock ? memoryBlockOf(s, STATEMENTS.length) : '', text, memoryRecall };
  } finally {
    await a.close();
  }
}

describe("agent({ runtime: 'gmi' }) memory.recall.budget and capture", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: false });
    vi.setSystemTime(Date.UTC(2026, 10, 10, 12, 0, 0));
  });

  it('with no recall setting the block is the one a budget of 1600 sends, byte for byte', async () => {
    const unset = await ask();
    const explicit = await ask({ budget: { totalTokens: 1600 } });
    expect(unset.block.length).toBeGreaterThan(0);
    expect(explicit.block).toBe(unset.block);
    expect(unset.memoryRecall?.budget).toMatchObject({ requested: 1600 });
    expect(explicit.memoryRecall?.budget).toMatchObject({ requested: 1600 });
  });

  it('budget.totalTokens sizes the whole block, preamble included', async () => {
    const small = await ask({ budget: { totalTokens: 500 } });
    expect(small.block).toContain(PREAMBLE_HEADING);
    expect(tokensOf(small.block)).toBeLessThanOrEqual(500);
    expect(small.memoryRecall?.budget.requested).toBe(500);
    expect(small.memoryRecall?.tokensUsed).toBeLessThanOrEqual(500);
    expect(small.memoryRecall?.candidates.some((c) => c.outcome === 'left_out')).toBe(true);
    const large = await ask({ budget: { totalTokens: 3000 } });
    expect(large.memoryRecall?.budget.requested).toBe(3000);
    expect(tokensOf(large.block)).toBeGreaterThan(tokensOf(small.block));
    expect(small.block).not.toContain('…[cut]');
  });

  it('a budget of 0 sends no block, records every candidate left out for the budget, and the turn answers', async () => {
    const none = await ask({ budget: { totalTokens: 0 } });
    expect(none.block).toBe('');
    expect(none.text).toBe('Pier 3.');
    expect(none.memoryRecall?.budget.requested).toBe(0);
    expect(none.memoryRecall?.candidates.length).toBeGreaterThan(0);
    for (const c of none.memoryRecall!.candidates) expect(c).toMatchObject({ outcome: 'left_out', reason: 'budget' });
  });

  it("capture 'off' computes no record and sends the same block", async () => {
    const off = await ask({ capture: 'off' });
    const on = await ask({ capture: 'metadata' });
    expect(off.memoryRecall).toBeUndefined();
    expect(on.memoryRecall?.version).toBe('memory-recall-capture/1');
    expect(off.block.length).toBeGreaterThan(0);
    expect(off.block).toBe(on.block);
  });

  it("stream(): memoryRecall settles with the record under 'metadata' and undefined under 'off'", async () => {
    const on = await ask({ capture: 'metadata' }, 'stream');
    expect(on.text).toBe('Pier 3.');
    expect(on.memoryRecall?.version).toBe('memory-recall-capture/1');
    expect(on.memoryRecall?.budget.requested).toBe(1600);
    const off = await ask({ capture: 'off' }, 'stream');
    expect(off.text).toBe('Pier 3.');
    expect(off.memoryRecall).toBeUndefined();
    expect(off.block).toBe(on.block);
  });

  it('stream(): a turn whose model call fails after its memory assembly still settles memoryRecall with the record', async () => {
    const failed = await ask({ capture: 'metadata' }, 'stream', Object.assign(new Error('bad request'), { httpStatus: 400 }));
    expect(failed.block).toContain(PREAMBLE_HEADING);
    expect(failed.text).toBe('');
    expect(failed.memoryRecall?.version).toBe('memory-recall-capture/1');
    expect(failed.memoryRecall?.budget.requested).toBe(1600);
    expect(failed.memoryRecall?.candidates.length).toBeGreaterThan(0);
    const off = await ask({ capture: 'off' }, 'stream', Object.assign(new Error('bad request'), { httpStatus: 400 }));
    expect(off.memoryRecall).toBeUndefined();
  });

  it('the record names the embedding model the memory was built with', async () => {
    const turn = await ask();
    expect(turn.memoryRecall?.embedder).toEqual({ provider: 'openai', model: expect.any(String) });
    expect(turn.memoryRecall!.embedder!.model.length).toBeGreaterThan(0);
  });

  it.each([
    [{ budget: { totalTokens: -1 } }, 'memory.recall.budget.totalTokens'],
    [{ budget: { totalTokens: Number.NaN } }, 'memory.recall.budget.totalTokens'],
    [{ budget: { totalTokens: 12.5 } }, 'memory.recall.budget.totalTokens'],
    [{ budget: { totalTokens: Number.POSITIVE_INFINITY } }, 'memory.recall.budget.totalTokens'],
    [{ capture: 'everything' }, 'memory.recall.capture'],
    // A JavaScript caller's setting of the wrong shape: the setting itself, or its budget, not an object.
    ['off', 'memory.recall must be an object'],
    [{ budget: 2400 }, 'memory.recall.budget must be an object'],
  ])('rejects %j at construction, naming the field', (recall, field) => {
    expect(() => withRecall(key(), recall as unknown as Recall)).toThrow(field);
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ reason: 'invalid_value' })]);
  });

  it('with cognitive memory off and no memoryProvider.getContext, memory.recall.budget.totalTokens is applied nowhere: one option_ignored line', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memory: { recall: { budget: { totalTokens: 700 } } }, cognition: { memory: false },
    } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([expect.objectContaining({ option: 'recall_budget' })]);
    await a.close();
  });

  it('memoryProviderOptions.tokenBudget is not applied when cognitive memory supplies the block: one option_ignored line', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProviderOptions: { tokenBudget: 9000 },
      cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
    } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([expect.objectContaining({ option: 'token_budget' })]);
    await a.close();
  });

  it("with cognitive memory off, memory.recall.budget.totalTokens is the memory provider's tokenBudget, and capture is refused", async () => {
    const seen: number[] = [];
    const provider = { getContext: async (_text: string, o: { tokenBudget: number }) => { seen.push(o.tokenBudget); return { contextText: 'A remembered line.' }; } };
    const k = key();
    script('openai', k, { replies: [reply.text('ok')] });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProvider: provider, memory: { recall: { budget: { totalTokens: 700 } } }, cognition: { memory: false },
    } as unknown as AgentOptions);
    try {
      await a.session('s').send('hi');
    } finally {
      await a.close();
    }
    expect(seen).toEqual([700]);
    expect(() => agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: key(), fallbackProviders: [],
      memory: { recall: { capture: 'metadata' } }, cognition: { memory: false },
    } as unknown as AgentOptions)).toThrow(/memory\.recall\.capture.*runtime: 'gmi'/s);
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option: 'capture', reason: 'unsupported_runtime' })]);
  });
});

describe('agent() on the default runtime', () => {
  const provider = (seen: number[]) => ({
    getContext: async (_text: string, o: { tokenBudget: number }) => {
      seen.push(o.tokenBudget);
      return { contextText: 'A remembered line.' };
    },
  });

  it("memory.recall.budget.totalTokens becomes the provider's tokenBudget when memoryProviderOptions.tokenBudget is unset, with no warning that memory settings are not applied", async () => {
    const k = key(); const seen: number[] = [];
    script('openai', k, { whole: true, replies: [reply.text('ok')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = agent({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProvider: provider(seen), memory: { recall: { budget: { totalTokens: 900 } } },
    } as unknown as AgentOptions);
    await a.session('s').send('hi');
    expect(seen).toEqual([900]);
    const warned = warn.mock.calls.map((args) => args.map(String).join(' '));
    expect(warned.filter((line) => line.includes('memory settings'))).toEqual([]);
    expect(events('memory.recall.option_ignored')).toEqual([]);
  });

  it('memory.recall.budget.totalTokens with no memoryProvider.getContext to read it is applied nowhere: one option_ignored line', () => {
    agent({ provider: 'openai', model: 'stub-model', apiKey: key(), memory: { recall: { budget: { totalTokens: 900 } } } } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([expect.objectContaining({ option: 'recall_budget' })]);
  });

  it('two different budgets are rejected at construction, naming both', () => {
    expect(() => agent({
      provider: 'openai', model: 'stub-model', apiKey: key(),
      memoryProvider: provider([]), memoryProviderOptions: { tokenBudget: 2000 }, memory: { recall: { budget: { totalTokens: 900 } } },
    } as unknown as AgentOptions)).toThrow(/memory\.recall\.budget\.totalTokens.*memoryProviderOptions\.tokenBudget/s);
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option: 'budget.totalTokens', reason: 'conflict' })]);
  });

  it('capture is rejected on the default runtime: the provider is not the cognitive assembler', () => {
    expect(() => agent({ provider: 'openai', model: 'stub-model', apiKey: key(), memory: { recall: { capture: 'metadata' } } } as unknown as AgentOptions))
      .toThrow(/memory\.recall\.capture.*runtime: 'gmi'/s);
    expect(events('memory.recall.option_rejected')).toEqual([expect.objectContaining({ option: 'capture', reason: 'unsupported_runtime' })]);
  });
});

describe("agent({ runtime: 'gmi' }) memory.recall beside the other memory options", () => {
  it("'metadata+stream' on a session records what 'metadata' records; the session's stream carries no memory part", async () => {
    const k = key(); const emb = key();
    script('openai', k, { replies: [reply.text('Noted.'), reply.text('Pier 3.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withRecall(k, { capture: 'metadata+stream' });
    try {
      const session = a.session('s');
      await session.send(STATEMENTS[0]);
      const result = session.stream(QUESTION);
      const types: string[] = [];
      for await (const part of result.fullStream) types.push(part.type);
      expect(new Set(types)).toEqual(new Set(['text']));
      const record = await (result as { memoryRecall?: Promise<MemoryRecallCapture | undefined> }).memoryRecall;
      expect(record?.version).toBe('memory-recall-capture/1');
      expect(record?.candidates.length).toBeGreaterThan(0);
    } finally {
      await a.close();
    }
  });

  it('memory.recall beside a cognition.memory of its own is not applied: one option_ignored line names it', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memory: { recall: { budget: { totalTokens: 500 } } },
      cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
    } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([expect.objectContaining({ option: 'memory_recall' })]);
    await a.close();
  });

  it("memory.recall inside the cognition's own memory is applied, and writes no option_ignored line", async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      cognition: { memory: { embedding: { provider: 'openai' }, recall: { budget: { totalTokens: 500 } } }, mechanisms: false },
    } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([]);
    await a.close();
  });

  it('memory: null is memory off, as everywhere else in the agent: memoryProviderOptions.tokenBudget is not reported beside cognitive memory', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memory: null, memoryProviderOptions: { tokenBudget: 900 },
    } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([]);
    await a.close();
  });
});

describe("agent({ runtime: 'gmi' }) memory budget across a fallback hop", () => {
  const overloaded = () => Object.assign(new Error('overloaded'), { httpStatus: 529 });

  /** The block in a provider request: from the preamble heading to where the prompt engine resumes with the query; '' when none. */
  function blockIn(request: ProviderScript['seen'][number] | undefined): string {
    expect(request, 'the model call').toBeDefined();
    const holder = request!.messages.map(textOf).find((text) => text.includes(PREAMBLE_HEADING));
    if (!holder) return '';
    const start = holder.indexOf(PREAMBLE_HEADING);
    const end = holder.indexOf('\n\nUser Query:', start);
    return holder.slice(start, end === -1 ? undefined : end);
  }

  /**
   * Files the statements through the primary, clears the history, and asks. With `fail`, the primary fails before
   * any output on the question and the Anthropic fallback serves it. Returns the question's result, the embedding
   * calls the question made, and both scripts.
   */
  async function turn(o: { primaryWindow: number; fallbackWindow: number; fail: boolean }) {
    ids.next = 0;
    const k = key(); const fb = key(); const emb = key();
    const primary = script('openai', k, { window: o.primaryWindow, replies: [...STATEMENTS.map(() => reply.text('Noted.')), o.fail ? overloaded() : reply.text('Pier 3.')] });
    const fallback = script('anthropic', fb, { window: o.fallbackWindow, replies: [reply.text('Pier 3.')] });
    const embedder = script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    vi.stubEnv('ANTHROPIC_API_KEY', fb);
    const a = agent({
      runtime: 'gmi', name: 'Harbor', provider: 'openai', model: 'stub-model', apiKey: k,
      fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }],
      cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
    } as unknown as AgentOptions);
    try {
      const session = a.session('s');
      for (const statement of STATEMENTS) await session.send(statement);
      session.clear();
      logged.length = 0;
      const before = embedder.embedCalls;
      const result = await session.send(QUESTION);
      return { result, embedCalls: embedder.embedCalls - before, primary, fallback };
    } finally {
      await a.close();
    }
  }

  it("the fallback hop's block is re-rendered at that hop's share from the turn's one recall", async () => {
    const control = await turn({ primaryWindow: 128_000, fallbackWindow: 3_000, fail: false });
    expect(control.result.provider).toBe('openai');
    expect(control.result.memoryRecall!.budget).toMatchObject({ requested: 1600, effective: 1600, hop: 0 });
    expect(control.result.memoryRecall!.budget.reassembled).toBeUndefined();
    // What reached the serving model: PromptEngine's count of the block, and no other context on this agent.
    expect(control.result.memoryRecall!.delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
    expect(control.result.memoryRecall!.delivery!.memoryBlockTokens).toBeGreaterThan(600);
    expect(events('memory.recall.budget_clamped')).toEqual([]);

    const fell = await turn({ primaryWindow: 128_000, fallbackWindow: 3_000, fail: true });
    expect(fell.result.provider).toBe('anthropic');
    // The re-render embeds nothing: the turn made the embedding calls a turn on one model makes.
    expect(fell.embedCalls).toBe(control.embedCalls);
    expect(fell.result.memoryRecall!.budget).toMatchObject({ requested: 1600, effective: 600, clampReason: 'prompt_share', promptShareTokens: 600, otherContextTokens: 0, hop: 1, reassembled: true });
    expect(fell.result.memoryRecall!.tokensUsed).toBeLessThanOrEqual(600);
    // The record's delivery is the fallback hop's: the re-rendered block as PromptEngine counted it for that model.
    expect(fell.result.memoryRecall!.delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
    expect(fell.result.memoryRecall!.delivery!.memoryBlockTokens).toBeGreaterThan(0);
    expect(fell.result.memoryRecall!.delivery!.memoryBlockTokens).toBeLessThanOrEqual(600);
    // The failed primary hop was sent the first rendering; the fallback, the re-render.
    expect(tokensOf(blockIn(fell.primary.seen.at(-1)))).toBeGreaterThan(600);
    const block = blockIn(fell.fallback.seen[0]);
    expect(block).toContain(PREAMBLE_HEADING);
    expect(tokensOf(block)).toBeLessThanOrEqual(600);
    expect(block).not.toContain('…[cut]');
    expect(events('memory.recall.budget_clamped')).toEqual([expect.objectContaining({ requested: 1600, effective: 600, hop: 1, reason: 'prompt_share' })]);
  });

  it("a fallback whose share holds the block serves the turn's first rendering, and the record names it, not the failed hop's re-render", async () => {
    const fell = await turn({ primaryWindow: 3_000, fallbackWindow: 128_000, fail: true });
    expect(fell.result.provider).toBe('anthropic');
    const record = fell.result.memoryRecall!;
    expect(record.budget).toMatchObject({ requested: 1600, effective: 1600, promptShareTokens: 25_600, hop: 1 });
    expect(record.budget.reassembled).toBeUndefined();
    expect(record.budget.clampReason).toBeUndefined();
    // The primary hop, which failed, was sent the re-render at 600; the fallback that served, the first rendering.
    expect(tokensOf(blockIn(fell.primary.seen.at(-1)))).toBeLessThanOrEqual(600);
    const served = blockIn(fell.fallback.seen[0]);
    expect(tokensOf(served)).toBeGreaterThan(600);
    expect(record.tokensUsed).toBeGreaterThan(600);
    expect(record.delivery).toEqual({ memoryBlockTokens: expect.any(Number) });
    expect(record.delivery!.memoryBlockTokens).toBeGreaterThan(0);
    expect(events('memory.recall.budget_clamped')).toEqual([expect.objectContaining({ requested: 1600, effective: 600, hop: 0, reason: 'prompt_share' })]);
  });
});
