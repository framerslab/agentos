/**
 * What a GMI turn with cognitive memory puts in the newest user message, read from the request the provider
 * receives: agent({ runtime: 'gmi' }) with a persona and cognitive memory, its trace filed by the session's own
 * earlier send. The real provider manager, completion gateway, GMI, prompt engine, memory bridge and cognitive
 * memory manager run; only the provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI stub embeds
 * with a deterministic word hash. A spy on the real memory assembler keeps the block each turn assembled.
 *
 * The person's words reach the model exactly as written. The memory block travels before them in the same message,
 * as a note opened by one fixed frame line: a text part of its own on a provider whose adapter sends text parts on
 * as parts (OpenAI here), and the first paragraphs of one string on a provider that takes one string (Groq here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/GroqProvider', async () => ({ GroqProvider: (await import('./helpers/stubProviders')).stubProviderClass('groq') }));
const assemblies = vi.hoisted(() => [] as string[]);
vi.mock('../../cognition/memory/core/prompt/MemoryPromptAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/prompt/MemoryPromptAssembler')>();
  return {
    ...actual,
    assembleMemoryContext: (...args: Parameters<typeof actual.assembleMemoryContext>) => {
      const result = actual.assembleMemoryContext(...args);
      assemblies.push(result.contextText);
      return result;
    },
  };
});
import { agent, type AgentOptions } from '../agent';
import { reply, script, systemTextOf, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import * as promptEngineModule from '../../core/llm/PromptEngine';
import { PromptEngine } from '../../core/llm/PromptEngine';
import { promptEngineConfig } from '../../cognition/substrate/__tests__/helpers/scriptedGmi';
import type { ChatMessage } from '../../core/llm/providers/IProvider';

/** The frame line the prompt engine opens retrieved text with. */
const FRAME = (promptEngineModule as unknown as { APPLICATION_NOTE_FRAME?: string }).APPLICATION_NOTE_FRAME;

/** Shares most of its words with the greeting, so the word-hash embedding recalls it. */
const EARLIER = "Work at the hotel front desk is slow in the afternoon, so I end up bothering Tess when I'm bored.";
const WORDS = "Hey Tess! Slow afternoon at work so I'm bothering you.";
/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';

let n = 0;
const key = () => `k-user-words-${++n}`;

/** Tess: a persona with cognitive memory (no mechanisms) that embeds through OpenAI, answering on `provider`. */
const tess = (provider: string, apiKey: string) =>
  agent({
    runtime: 'gmi',
    provider,
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    name: 'Tess',
    instructions: 'You are Tess, a dry-witted friend. Talk like a person, in short lines.',
    personality: { openness: 0.8, emotionality: 0.6, conscientiousness: 0.3 },
    cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
  } as unknown as AgentOptions);

interface Turn {
  /** The provider's script: `seen[0]` is the earlier turn's request, `seen[1]` the greeting's. */
  s: ProviderScript;
  /** The block the memory assembler returned on the greeting's turn. */
  block: string;
  /** The newest user message of the greeting's request. */
  newest: ChatMessage;
  /** The greeting turn's `memoryRecall.delivery`. */
  delivery: unknown;
}

/** Files one statement, clears the history, sends the greeting, and returns what the provider received for it. */
async function greet(provider: string): Promise<Turn> {
  const k = key(); const emb = key();
  const s = script(provider, k, { replies: [reply.text('Noted.'), reply.text('Bother away.')] });
  script('openai', emb, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', emb);
  const a = tess(provider, k);
  try {
    const session = a.session('s');
    await session.send(EARLIER);
    session.clear();
    assemblies.length = 0;
    const result = await session.send(WORDS);
    expect(s.seen, 'model calls').toHaveLength(2);
    expect(assemblies.length, 'assemblies on the greeting turn').toBeGreaterThan(0);
    const block = assemblies[assemblies.length - 1];
    // The fixture: the turn has a memory block, and the block holds the earlier statement.
    expect(block.startsWith(PREAMBLE_HEADING), `the block:\n${block}`).toBe(true);
    expect(block, 'the block holds the recalled statement').toContain('bothering Tess');
    const users = s.seen[1].messages.filter((message) => message.role === 'user');
    expect(users.length, 'user messages in the greeting request').toBeGreaterThan(0);
    const delivery: unknown = result.memoryRecall?.delivery;
    return { s, block, newest: users[users.length - 1], delivery };
  } finally {
    await a.close();
  }
}

/** The text parts of a message's content; none when the content is one string. */
const textPartsOf = (message: ChatMessage): Array<{ type: string; text?: unknown }> =>
  Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text') : [];

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) newest user message with a memory block: a provider that takes text parts", () => {
  it("ends with a text part that is the person's words, byte for byte", async () => {
    const { newest } = await greet('openai');
    const parts = textPartsOf(newest);
    expect(parts[parts.length - 1], `the newest user message: ${JSON.stringify(newest.content)}`).toEqual({ type: 'text', text: WORDS });
  });

  it('carries the memory block whole, as the assembler returned it, in a text part before the words', async () => {
    const { newest, block } = await greet('openai');
    expect(Array.isArray(newest.content), `the newest user message: ${JSON.stringify(newest.content)}`).toBe(true);
    expect(newest.content).toEqual([
      { type: 'text', text: `${FRAME}\n${block}` },
      { type: 'text', text: WORDS },
    ]);
  });

  it('holds neither label of the old wrapper anywhere in the request', async () => {
    const { s } = await greet('openai');
    const request = JSON.stringify(s.seen[1].messages);
    expect(request).not.toContain('User Query:');
    expect(request).not.toContain('Context:\\n');
  });

  it('sends the same system text on both turns, with no memory in it', async () => {
    const { s, block } = await greet('openai');
    const first = systemTextOf(s.seen[0].messages);
    const second = systemTextOf(s.seen[1].messages);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
    expect(second).not.toContain(PREAMBLE_HEADING);
    expect(second).not.toContain('bothering Tess');
    expect(block.length).toBeGreaterThan(0);
  });

  it("reports the block's delivery as the prompt engine counted it, and nothing else", async () => {
    const { block, delivery } = await greet('openai');
    const counter = new PromptEngine();
    await counter.initialize(promptEngineConfig());
    expect(delivery).toEqual({ memoryBlockTokens: await counter.estimateTokenCount(block, 'stub-model') });
  });
});

describe("agent({ runtime: 'gmi' }) newest user message with a memory block: a provider that takes one string", () => {
  it('is one string: the frame line, the block whole, a blank line, then the words with no label', async () => {
    const { newest, block } = await greet('groq');
    expect(newest.content).toBe(`${FRAME}\n${block}\n\n${WORDS}`);
  });

  it('holds neither label of the old wrapper anywhere in the request', async () => {
    const { s } = await greet('groq');
    const request = JSON.stringify(s.seen[1].messages);
    expect(request).not.toContain('User Query:');
    expect(request).not.toContain('Context:\\n');
  });

  it("reports the block's delivery as the prompt engine counted it, and nothing else", async () => {
    const { block, delivery } = await greet('groq');
    const counter = new PromptEngine();
    await counter.initialize(promptEngineConfig());
    expect(delivery).toEqual({ memoryBlockTokens: await counter.estimateTokenCount(block, 'stub-model') });
  });
});
