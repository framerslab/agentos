/**
 * `memory.recall` on every call an agent makes, not only a session's send: `generate()` and `stream()` on the default
 * runtime and on the GMI path, and a GMI session under `capture: 'metadata+stream'`. The real provider manager,
 * completion gateway, GMI, prompt engine and memory run; only the provider classes are stubbed
 * (helpers/stubProviders.ts), and the memory provider is a plain object that records the `tokenBudget` each
 * `getContext` call is handed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent, type AgentOptions } from '../agent';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import type { MemoryRecallCapture } from '../../cognition/memory/retrieval/recall/capture';

let n = 0;
const key = () => `k-memory-budget-calls-${++n}`;

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A memory provider that records the `tokenBudget` of each `getContext` call. */
const recordingProvider = (seen: number[]) => ({
  getContext: async (_text: string, o: { tokenBudget: number }) => {
    seen.push(o.tokenBudget);
    return { contextText: 'A remembered line.' };
  },
});

/**
 * Reads a stream to its end, then its text. The default runtime's stream starts only when a consumer reads it
 * (streamText), so its `text` alone never settles.
 */
async function drained(stream: { textStream: AsyncIterable<string>; text: Promise<string> }): Promise<string> {
  for await (const chunk of stream.textStream) void chunk;
  return stream.text;
}

/** Enough replies for a few calls, answered streamed or whole. */
const replies = () => Array.from({ length: 8 }, () => reply.text('ok'));

describe('agent() on the default runtime: generate() and stream()', () => {
  it("hand memory.recall.budget.totalTokens to memoryProvider.getContext when memoryProviderOptions.tokenBudget is unset", async () => {
    const k = key(); const seen: number[] = [];
    script('openai', k, { whole: true, replies: replies() });
    const a = agent({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProvider: recordingProvider(seen), memory: { recall: { budget: { totalTokens: 900 } } },
    } as unknown as AgentOptions);
    await a.generate('hi');
    await drained(a.stream('hi again'));
    expect(seen).toEqual([900, 900]);
    expect(events('memory.recall.option_ignored')).toEqual([]);
  });

  it('a session stream() hands the same budget', async () => {
    const k = key(); const seen: number[] = [];
    script('openai', k, { whole: true, replies: replies() });
    const a = agent({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProvider: recordingProvider(seen), memory: { recall: { budget: { totalTokens: 900 } } },
    } as unknown as AgentOptions);
    await drained(a.session('s').stream('hi'));
    expect(seen).toEqual([900]);
  });
});

describe("agent({ runtime: 'gmi' }) with cognitive memory off: generate() and stream()", () => {
  it("hand memory.recall.budget.totalTokens to memoryProvider.getContext, as a session's send does", async () => {
    const k = key(); const seen: number[] = [];
    script('openai', k, { whole: true, replies: replies() });
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProvider: recordingProvider(seen), memory: { recall: { budget: { totalTokens: 700 } } }, cognition: { memory: false },
    } as unknown as AgentOptions);
    try {
      await a.generate('hi');
      await a.stream('hi again').text;
    } finally {
      await a.close();
    }
    expect(seen).toEqual([700, 700]);
    expect(events('memory.recall.option_ignored')).toEqual([]);
  });
});

describe("agent({ runtime: 'gmi' }) with cognitive memory on", () => {
  it('memoryProviderOptions.tokenBudget beside a memoryProvider.getContext is not reported as ignored: generate() and stream() hand it to the provider', async () => {
    const k = key(); const emb = key(); const seen: number[] = [];
    script('openai', k, { whole: true, replies: replies() });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = agent({
      runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      memoryProvider: recordingProvider(seen), memoryProviderOptions: { tokenBudget: 9000 },
      cognition: { memory: { embedding: { provider: 'openai' }, recall: { budget: { totalTokens: 500 } } }, mechanisms: false },
    } as unknown as AgentOptions);
    expect(events('memory.recall.option_ignored')).toEqual([]);
    try {
      await a.generate('hi');
      await a.stream('hi again').text;
    } finally {
      await a.close();
    }
    // The recall budget sizes the cognitive block of a session's turns; the provider keeps its own budget.
    expect(seen).toEqual([9000, 9000]);
  });

  it("capture 'metadata+stream': a session's send() and stream() return the record, and the block reaches the model", async () => {
    const STATEMENTS = [
      'The camping stove waits in parcel locker 14 and its code is 5832.',
      'The spare tent pegs are in the blue crate beside the parcel lockers.',
      'The lantern batteries were moved to parcel locker 9 last week.',
    ];
    const QUESTION = 'Which parcel locker holds the camping stove?';
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [...STATEMENTS.map(() => reply.text('Noted.')), reply.text('Locker 14.'), reply.text('Locker 14.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = agent({
      runtime: 'gmi', name: 'Lockers', provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [],
      cognition: { memory: { embedding: { provider: 'openai' }, recall: { capture: 'metadata+stream' } }, mechanisms: false },
    } as unknown as AgentOptions);
    try {
      const session = a.session('s');
      for (const statement of STATEMENTS) await session.send(statement);
      session.clear();
      const sent = await session.send(QUESTION);
      expect(sent.text).toBe('Locker 14.');
      const record = sent.memoryRecall as MemoryRecallCapture | undefined;
      expect(record?.version).toBe('memory-recall-capture/1');
      expect(record?.budget.requested).toBe(1600);
      expect(record?.candidates.some((c) => c.outcome === 'included')).toBe(true);
      // No memory text in the record.
      expect(JSON.stringify(record)).not.toContain('5832');
      const asked = s.seen[STATEMENTS.length].messages.map((m: ChatMessage) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
      expect(asked.some((text) => text.includes('## How To Use Your Memories'))).toBe(true);

      session.clear();
      const streamed = session.stream(QUESTION);
      expect(await streamed.text).toBe('Locker 14.');
      const streamedRecord = await (streamed as { memoryRecall?: Promise<MemoryRecallCapture | undefined> }).memoryRecall;
      expect(streamedRecord?.version).toBe('memory-recall-capture/1');
      expect(streamedRecord?.candidates.length).toBeGreaterThan(0);
    } finally {
      await a.close();
    }
  });
});
