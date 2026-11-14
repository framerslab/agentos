/**
 * The assistant's own earlier reply in the memory block of a later turn, read from the request the provider received:
 * agent({ runtime: 'gmi' }) with cognitive memory on, the reply filed by the session's own earlier send. The real
 * provider manager, completion gateway, GMI, prompt engine, memory bridge and cognitive memory manager run; only the
 * provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI stub embeds with a deterministic word hash,
 * so texts that share words recall each other.
 *
 * A GMI files each reply as a semantic trace with sourceType 'agent_inference' and the bridge's tags, its role
 * 'assistant' first, as earlier versions did. The block shows such a trace as the assistant's own words, a line that
 * starts "You said: " among the past exchanges, and never under the facts heading. A trace a host files itself with
 * that sourceType, and without the tag, is shown as it was. Each case clears the session's history before the turn it
 * reads, so the reply reaches the request through recall alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
// The manager agent() builds for its sessions, so a case can file into it what a host or an earlier version filed.
const built = vi.hoisted(() => ({ manager: undefined as CognitiveMemoryManager | undefined }));
vi.mock('../runtime/agentCognitiveMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/agentCognitiveMemory')>();
  return {
    ...actual,
    createAgentCognitiveMemory: async (...args: Parameters<typeof actual.createAgentCognitiveMemory>) => {
      const memory = await actual.createAgentCognitiveMemory(...args);
      built.manager = memory.manager;
      return memory;
    },
  };
});
import { agent, type AgentOptions } from '../agent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { ChatMessage } from '../../core/llm/providers/IProvider';

let n = 0;
const key = () => `k-memory-own-words-${++n}`;

/** The reply of the first turn: the model's reasoning, written as if it were the answer. */
const REPLY = "I'm reasoning about this: 1. **What I know**: the user likes green tea.";
/** Starts the line of a recalled reply. */
const OWN_WORDS = `You said: ${REPLY}`;

/** The facts heading of a dense block. */
const FACTS_HEADER = "## Relevant Memories (facts — use as background truth, don't announce)";
/** The section for past exchanges of a dense block. */
const EPISODIC_HEADER = '## Recent Experiences';
/** The one recall section of a hybrid block, in the facts heading's place. */
const RECALL_HEADER = '## Relevant Memories (facts and past events';
/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';

/** An agent whose sessions share cognitive memory (no mechanisms), structured style, that embeds through OpenAI. */
const withMemory = (apiKey: string, recall?: Record<string, unknown>) =>
  agent({
    runtime: 'gmi',
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    personality: { conscientiousness: 0.9, openness: 0.2, emotionality: 0.2 },
    cognition: { memory: { embedding: { provider: 'openai' }, ...(recall ? { recall } : {}) }, mechanisms: false },
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

/** The lines of one section of a block, from its header to the next section. */
function sectionLines(block: string, header: string): string[] {
  const start = block.indexOf(header);
  if (start === -1) return [];
  const rest = block.slice(start + header.length);
  const next = rest.search(/\n\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).split('\n').filter(Boolean);
}

/** The lines of `block` that show `text`. */
const linesWith = (lines: readonly string[], text: string) => lines.filter((line) => line.includes(text));

beforeEach(() => {
  globalLLMProviderHealth.reset();
  built.manager = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }): the assistant's own earlier reply in the memory block", () => {
  it('a reply the model wrote last turn comes back as its own words among the past exchanges, never under the facts heading', async () => {
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text(REPLY), reply.text('Green tea.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      await session.send('I like green tea.');
      session.clear();
      await session.send('What tea do I like?');

      const block = memoryBlockOf(s, 1);
      // The fixture: recall brought the first turn's reply into the second turn's block.
      expect(block, `the block:\n${block}`).toContain(REPLY);
      // It is not sent as a fact.
      expect(linesWith(sectionLines(block, FACTS_HEADER), REPLY), `the block:\n${block}`).toEqual([]);
      // It is the assistant's own words, once, in the section for past exchanges, and no line shows it another way.
      expect(linesWith(sectionLines(block, EPISODIC_HEADER), OWN_WORDS), `the block:\n${block}`).toHaveLength(1);
      expect(linesWith(block.split('\n'), REPLY).filter((line) => !line.includes(OWN_WORDS)), `the block:\n${block}`).toEqual([]);
      // The user's own statement is shown as it was: no line of theirs reads as the assistant's.
      expect(linesWith(sectionLines(block, EPISODIC_HEADER), 'I like green tea.').filter((line) => line.includes('You said:'))).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it('asked what it said, the turn still recalls its earlier reply, as its own words, under dense and hybrid recall', async () => {
    for (const retrieval of ['dense', 'hybrid'] as const) {
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [reply.text(REPLY), reply.text('That you like green tea.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k, { retrieval });
      try {
        const session = a.session('s');
        await session.send('I like green tea.');
        session.clear();
        await session.send('What did you tell me about tea?');

        const block = memoryBlockOf(s, 1);
        const where = `${retrieval}, the block:\n${block}`;
        const pastExchanges = retrieval === 'dense' ? EPISODIC_HEADER : RECALL_HEADER;
        expect(linesWith(sectionLines(block, pastExchanges), OWN_WORDS), where).toHaveLength(1);
        expect(linesWith(block.split('\n'), REPLY).filter((line) => !line.includes(OWN_WORDS)), where).toEqual([]);
        if (retrieval === 'dense') expect(linesWith(sectionLines(block, FACTS_HEADER), REPLY), where).toEqual([]);
      } finally {
        await a.close();
      }
    }
  });

  it("a reply an earlier version filed is shown as the assistant's own words, and a host's semantic fact is shown as a fact, as before", async () => {
    const FACT = 'The tea shop on Elm Street sells green tea in tins.';
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Hi.'), reply.text('Green tea.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      await session.send('Hello.');
      const manager = built.manager;
      expect(manager, 'the manager agent() built').toBeDefined();
      // The reply the turn filed: a semantic trace with sourceType 'agent_inference', under the bridge's tags (its role
      // first), as every earlier version filed it.
      const filed = manager!.getStore().listTraces({ activeOnly: true }).filter((trace) => trace.content === 'Hi.');
      expect(filed, 'the filed reply').toHaveLength(1);
      expect(filed[0]).toMatchObject({ type: 'semantic', provenance: { sourceType: 'agent_inference' } });
      expect(filed[0].tags, 'the filed reply').toContain('assistant');
      const { scope, scopeId, tags } = filed[0];
      const pad = { valence: 0, arousal: 0, dominance: 0 };
      // A reply filed by an earlier version, in the same scope: what its syncForTurn passed.
      await manager!.encode(REPLY, pad, 'neutral', { type: 'semantic', scope, scopeId, sourceType: 'agent_inference', tags: [...tags] });
      // A host's own fact: a semantic trace with no sourceType of its own, so 'user_statement'.
      await manager!.encode(FACT, pad, 'neutral', { type: 'semantic', scope, scopeId });
      session.clear();
      await session.send('What tea do I like?');

      const block = memoryBlockOf(s, 1);
      const where = `the block:\n${block}`;
      // The earlier version's reply: the assistant's own words among the past exchanges, never a fact.
      expect(linesWith(sectionLines(block, EPISODIC_HEADER), OWN_WORDS), where).toHaveLength(1);
      expect(linesWith(sectionLines(block, FACTS_HEADER), REPLY), where).toEqual([]);
      // The host's fact: under the facts heading, the line it had before, with no prefix.
      const facts = linesWith(sectionLines(block, FACTS_HEADER), FACT);
      expect(facts, where).toHaveLength(1);
      expect(facts[0].startsWith(`- [semantic] ${FACT} (`), where).toBe(true);
      expect(linesWith(sectionLines(block, EPISODIC_HEADER), FACT), where).toEqual([]);
    } finally {
      await a.close();
    }
  });

  it("an inference a host filed itself with sourceType 'agent_inference' is shown as it was, never as words the assistant said", async () => {
    const INFERENCE = 'By my reading, the user seems to like green tea.';
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Hi.'), reply.text('Green tea.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      await session.send('Hello.');
      const manager = built.manager;
      expect(manager, 'the manager agent() built').toBeDefined();
      const filed = manager!.getStore().listTraces({ activeOnly: true }).filter((trace) => trace.content === 'Hi.');
      expect(filed, 'the filed reply').toHaveLength(1);
      const { scope, scopeId } = filed[0];
      const pad = { valence: 0, arousal: 0, dominance: 0 };
      // Filed through the manager's public encode, as a host files a conclusion it drew: no reply of the assistant's.
      await manager!.encode(INFERENCE, pad, 'neutral', { type: 'semantic', scope, scopeId, sourceType: 'agent_inference' });
      session.clear();
      await session.send('What tea do I like?');

      const block = memoryBlockOf(s, 1);
      const where = `the block:\n${block}`;
      // Under the facts heading, the line it had before, with no prefix; nowhere as the assistant's own words.
      const facts = linesWith(sectionLines(block, FACTS_HEADER), INFERENCE);
      expect(facts, where).toHaveLength(1);
      expect(facts[0].startsWith(`- [semantic] ${INFERENCE} (`), where).toBe(true);
      expect(linesWith(block.split('\n'), INFERENCE).filter((line) => line.includes('You said:')), where).toEqual([]);
    } finally {
      await a.close();
    }
  });
});
