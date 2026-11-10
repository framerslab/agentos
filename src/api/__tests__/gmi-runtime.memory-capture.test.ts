/**
 * The recall capture of an agent({ runtime: 'gmi' }) turn, end to end: cognitive
 * memory on, its traces filed by the session's own earlier sends, and the record
 * read from the turn's result. The real provider manager, completion gateway,
 * GMI, prompt engine, memory bridge and cognitive memory manager run; only the
 * provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI stub
 * embeds with a deterministic word hash. The case reads the memory block from the
 * request the provider received and checks the record against it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent, type AgentOptions } from '../agent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { ChatMessage } from '../../core/llm/providers/IProvider';

let n = 0;
const key = () => `k-memory-capture-${++n}`;

/** An agent whose sessions share cognitive memory (no mechanisms) that embeds through OpenAI. */
const withMemory = (apiKey: string) =>
  agent({
    runtime: 'gmi',
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
  } as unknown as AgentOptions);

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
const requestTextOf = (s: ProviderScript, call: number): string => s.seen[call].messages.map(textOf).join('\n\n');

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  JSON.parse(JSON.stringify(value), (k, v) => {
    keys.add(k);
    return v;
  });
  return keys;
}

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) recall capture on the turn result", () => {
  const STATEMENTS = [
    'The parcel locker for the camping stove is number 14.',
    'The code of the camping stove parcel locker is 5832.',
    'We bought the blue tent at the outdoor shop on Main Street.',
  ];
  const QUESTION = 'Which parcel locker holds the camping stove, and what is its code?';

  it('send() returns memoryRecall by default: every recalled memory with its rank and outcome, the shown ones in the request, and no memory or query text', async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [...STATEMENTS.map(() => reply.text('Noted.')), reply.text('Locker 14, code 5832.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      for (const statement of STATEMENTS) await session.send(statement);
      session.clear();
      const result = await session.send(QUESTION);

      const recall = result.memoryRecall;
      expect(recall?.version).toBe('memory-recall-capture/1');
      expect(recall!.retrieval).toBe('dense');
      expect(recall!.budget.requested).toBe(1600);
      expect(recall!.reranker).toEqual({ provider: 'none', reason: 'none_configured' });
      expect(recall!.legs).toEqual([{ leg: 'dense', ran: true, candidates: expect.any(Number), ineligible: 0, ms: expect.any(Number) }]);
      expect(recall!.candidates.length).toBeGreaterThan(0);
      const included = recall!.candidates.filter((c) => c.outcome === 'included');
      expect(included.length).toBeGreaterThan(0);
      for (const c of recall!.candidates) {
        expect(typeof c.id).toBe('string');
        if (c.outcome === 'left_out') expect(['budget', 'section_full']).toContain(c.reason);
      }

      // The memories the record calls included reached the model: the locker statements are in the request.
      const request = requestTextOf(s, STATEMENTS.length);
      expect(request).toContain('number 14');
      expect(request).toContain('5832');

      // Ids, ranks, scores, counts and timings only.
      const keys = keysOf(recall);
      for (const forbidden of ['content', 'text', 'contextText', 'query']) expect(keys.has(forbidden)).toBe(false);
      const json = JSON.stringify(recall);
      for (const statement of STATEMENTS) expect(json).not.toContain(statement.slice(4, 30));
      expect(json).not.toContain('Which parcel locker');
    } finally {
      await a.close();
    }
  });
});
