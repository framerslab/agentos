/**
 * The recall capture of an agent({ runtime: 'gmi' }) turn, end to end: cognitive
 * memory on, its traces filed by the session's own earlier sends, and the record
 * read from the turn's result. The real provider manager, completion gateway,
 * GMI, prompt engine, memory bridge and cognitive memory manager run; only the
 * provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI stub
 * embeds with a deterministic word hash. The cases read the memory block from the
 * request the provider received and check the record against it. The memory
 * assembler runs unchanged; a wrapper keeps what each assembly was given and
 * what it returned, so a case can tie each candidate of the record to the line
 * the block shows or leaves out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssembledLineOutcome } from '../../cognition/memory/core/types';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
const assemblies = vi.hoisted(
  () =>
    [] as {
      block: string;
      tokensUsed: number;
      lineOutcomes: AssembledLineOutcome[];
      /** The content of each trace the assembler was given a line for (retrieved, or led to by an association), by id. */
      contents: Map<string, string>;
      /** The ids of the retrieved traces, in the order recall ranked them. */
      rank: string[];
      /** Each retrieved trace's retrieval score, by id. */
      scores: Map<string, number>;
    }[],
);
vi.mock('../../cognition/memory/core/prompt/MemoryPromptAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/prompt/MemoryPromptAssembler')>();
  return {
    ...actual,
    assembleMemoryContext: (input: Parameters<typeof actual.assembleMemoryContext>[0]) => {
      const result = actual.assembleMemoryContext(input);
      const contents = new Map<string, string>();
      for (const trace of input.retrievedTraces ?? []) contents.set(trace.id, trace.content);
      for (const item of input.graphContext ?? []) {
        if (typeof item !== 'string' && item.traceId && !contents.has(item.traceId)) {
          contents.set(item.traceId, item.text.replace(/^\[[^\]\n]*\]\s/, ''));
        }
      }
      assemblies.push({
        block: result.contextText,
        tokensUsed: result.tokensUsed,
        lineOutcomes: result.lineOutcomes ?? [],
        contents,
        rank: (input.retrievedTraces ?? []).map((trace) => trace.id),
        scores: new Map((input.retrievedTraces ?? []).map((trace) => [trace.id, trace.retrievalScore])),
      });
      return result;
    },
  };
});
import pino from 'pino';
import { agent, type AgentOptions } from '../agent';
import { resetRecallLogOnce } from '../../cognition/memory/retrieval/recall/log';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
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

/** The texts of a message: its one string, or the text of each of its text parts. */
function textPartsOf(message: ChatMessage): string[] {
  const content = message.content as unknown;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []));
}
const requestTextOf = (s: ProviderScript, call: number): string => s.seen[call].messages.map(textOf).join('\n\n');

/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';
/** The sections whose lines show a memory. */
const MEMORY_LINE_HEADERS = ['## Relevant Memories', '## Recent Experiences', '## Related Context', '## Something This Reminds Me Of'];

/** The memory block of the provider request `call`: the text from the preamble heading to the end of the text part that carries it. */
function memoryBlockOf(s: ProviderScript, call: number): string {
  const request = s.seen[call];
  expect(request, `model call ${call}`).toBeDefined();
  const holders = request.messages.map(textOf).filter((text) => text.includes(PREAMBLE_HEADING));
  expect(holders, 'messages that carry the memory block').toHaveLength(1);
  // The block travels in a text part of its own, before the person's words: it runs to the end of that part.
  const text = request.messages.flatMap(textPartsOf).find((part) => part.includes(PREAMBLE_HEADING)) ?? holders[0];
  return text.slice(text.indexOf(PREAMBLE_HEADING));
}

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

  it("the record matches the request's block: a statement recall ranked first but too long for the block is left out with its rank, the statements the model receives are the included candidates, and the tokens are the assembly's", async () => {
    // The question repeats the long statement's sentence, so recall ranks it above the two short statements; forty
    // such sentences are more than the 1600-token block holds, so the block passes it over and shows the short ones.
    const LONG_START = 'Inventory line 1 of the camping trip:';
    const SENTENCE =
      'of the camping trip: the stove parcel waits in a locker at the downtown parcel station, ' +
      'with the receipt, the trip checklist and a spare fuel canister.';
    const LONG_STATEMENT = Array.from({ length: 40 }, (_, i) => `Inventory line ${i + 1} ${SENTENCE}`).join(' ');
    const SHORT_STATEMENTS = STATEMENTS.slice(0, 2);
    expect(LONG_STATEMENT.length).toBeGreaterThan(1600 * 4);
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Okay.'), reply.text('Sure.'), reply.text('Locker 14.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      await session.send(LONG_STATEMENT);
      for (const statement of SHORT_STATEMENTS) await session.send(statement);
      session.clear();
      assemblies.length = 0;
      const result = await session.send(`Inventory line ${SENTENCE} Which locker, and what is its code?`);

      const recall = result.memoryRecall!;
      expect(recall?.version).toBe('memory-recall-capture/1');
      expect(assemblies.length, 'assemblies on the last turn').toBeGreaterThan(0);
      const assembly = assemblies[assemblies.length - 1];
      const block = memoryBlockOf(s, 3);
      expect(block.startsWith(assembly.block.trimEnd()), "the request's block is the assembled one").toBe(true);
      const idOf = (text: string) => {
        const ids = [...assembly.contents.entries()].filter(([, content]) => content.includes(text)).map(([id]) => id);
        expect(ids, `traces holding ${JSON.stringify(text.slice(0, 40))}`).toHaveLength(1);
        return ids[0];
      };
      const longId = idOf(LONG_START);
      const shortIds = SHORT_STATEMENTS.map(idOf);
      const where = `record ${JSON.stringify(recall.candidates)}\noutcomes ${JSON.stringify(assembly.lineOutcomes)}\nrank ${JSON.stringify(assembly.rank)}\nrequest block:\n${block}`;

      // The record's totals are the assembly's.
      expect(recall.tokensUsed).toBe(assembly.tokensUsed);
      expect(recall.legs[0].candidates, where).toBe(assembly.rank.length);

      // Every retrieved trace is a candidate, in recall's order, with its dense rank and retrieval score; the memories the
      // block reached only through an association follow, with no rank. No memory is a candidate twice.
      const ids = recall.candidates.map((c) => c.id);
      expect(new Set(ids).size, where).toBe(ids.length);
      expect(ids.slice(0, assembly.rank.length), where).toEqual(assembly.rank);
      recall.candidates.slice(0, assembly.rank.length).forEach((c, i) => {
        expect(c.ranks, where).toEqual({ dense: i + 1 });
        expect(c.fusedScore, where).toBe(assembly.scores.get(c.id));
        expect(c, where).not.toHaveProperty('rerankScore');
      });
      for (const c of recall.candidates.slice(assembly.rank.length)) {
        expect(c.ranks, where).toEqual({});
        expect(c.fusedScore, where).toBe(0);
      }

      // Each candidate carries the outcome, reason, section and tokens of its line; a retrieved trace the assembler gave
      // no line is left out for the budget with 0 tokens.
      const lineOf = new Map(assembly.lineOutcomes.map((line) => [line.id, line]));
      for (const c of recall.candidates) {
        const line = lineOf.get(c.id);
        if (line) {
          expect({ outcome: c.outcome, reason: c.reason, section: c.section, tokens: c.tokens }, where).toEqual({
            outcome: line.outcome, reason: line.reason, section: line.section, tokens: line.tokens,
          });
        } else {
          expect(c, where).toMatchObject({ outcome: 'left_out', reason: 'budget', tokens: 0 });
        }
      }

      // The included candidates are the memories the model receives: each one's text is on a memory line of the request's
      // block, and no left-out candidate's text is on any.
      const memoryLines = block
        .split(/\n\n(?=## )/)
        .filter((part) => MEMORY_LINE_HEADERS.some((header) => part.startsWith(header)))
        .join('\n');
      const includedContents = recall.candidates
        .filter((c) => c.outcome === 'included')
        .map((c) => assembly.contents.get(c.id))
        .filter((content): content is string => content !== undefined);
      for (const c of recall.candidates) {
        const content = assembly.contents.get(c.id);
        if (content === undefined) continue;
        if (c.outcome === 'included') expect(memoryLines, `${c.id} included\n${where}`).toContain(content);
        // A left-out text that a shown memory quotes may be on its line; any other is on none.
        else if (!includedContents.some((shownContent) => shownContent.includes(content))) {
          expect(memoryLines, `${c.id} left out\n${where}`).not.toContain(content);
        }
      }
      const shown = recall.candidates.filter((c) => c.outcome === 'included').map((c) => c.id).sort();
      expect(shown, where).toEqual(assembly.lineOutcomes.filter((line) => line.outcome === 'included').map((line) => line.id).sort());

      // The miss is classed: the long statement was ranked above both short ones and left out for want of room in its
      // section, whole (more tokens than the block); the short ones below it are included and in the request.
      const long = recall.candidates.find((c) => c.id === longId)!;
      expect(long, where).toMatchObject({ outcome: 'left_out', reason: 'section_full', section: 'recentEpisodic' });
      expect(long.tokens, where).toBeGreaterThan(recall.budget.requested);
      expect(requestTextOf(s, 3), where).not.toContain(LONG_START);
      for (const [index, id] of shortIds.entries()) {
        const short = recall.candidates.find((c) => c.id === id)!;
        expect(short.ranks.dense!, where).toBeGreaterThan(long.ranks.dense!);
        expect(short, where).toMatchObject({ outcome: 'included' });
        expect(requestTextOf(s, 3), where).toContain(SHORT_STATEMENTS[index]);
      }

      // Ids, ranks, scores, counts and timings only.
      const json = JSON.stringify(recall);
      expect(json).not.toContain('Inventory line');
      expect(json).not.toContain('camping');
    } finally {
      await a.close();
    }
  });
});

describe("agent({ runtime: 'gmi' }) recall when the question cannot be embedded", () => {
  const STATEMENTS = [
    'The parcel locker for the camping stove is number 14.',
    'The code of the camping stove parcel locker is 5832.',
  ];
  /** A word only the questions carry: the embedding provider fails every request that holds it. */
  const MARK = 'tarpaulin';

  it("a turn whose question the embedding provider fails on still answers; its memoryRecall reports the dense leg absent with no_embedder and no ranked memory, and two such turns write one leg_absent line", async () => {
    const k = key(); const emb = key();
    script('openai', k, { replies: [...STATEMENTS.map(() => reply.text('Noted.')), reply.text('I cannot recall that.'), reply.text('Still nothing.')] });
    const embeddings = script('openai', emb, { replies: [], failEmbedding: (text) => text.includes(MARK) });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const logged: Array<Record<string, unknown>> = [];
    resetRecallLogOnce();
    setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { logged.push(JSON.parse(line)); } }));
    const a = withMemory(k);
    try {
      const session = a.session('s');
      for (const statement of STATEMENTS) await session.send(statement);
      session.clear();
      const first = await session.send(`Which parcel locker holds the ${MARK} and the camping stove?`);
      const second = await session.send(`What is the code of the ${MARK} locker?`);

      // The provider was asked to embed the questions, and the turns answered anyway.
      expect(embeddings.embedded.some((text) => text.includes(MARK))).toBe(true);
      expect(first.text).toBe('I cannot recall that.');
      expect(second.text).toBe('Still nothing.');

      for (const [turn, result] of [['first', first], ['second', second]] as const) {
        const recall = result.memoryRecall;
        expect(recall?.version, `${turn} turn`).toBe('memory-recall-capture/1');
        expect(recall!.retrieval, `${turn} turn`).toBe('dense');
        expect(recall!.legs, `${turn} turn`).toEqual([{ leg: 'dense', ran: false, reason: 'no_embedder', candidates: 0, ineligible: 0, ms: expect.any(Number) }]);
        // Nothing was ranked: no candidate carries a dense rank.
        expect(recall!.candidates.filter((c) => c.ranks.dense !== undefined), `${turn} turn`).toEqual([]);
      }

      // One line for the process, not one a turn; it names the leg and the reason and no words of the turn.
      const absent = logged.filter((line) => line.event === 'memory.recall.leg_absent');
      expect(absent).toEqual([expect.objectContaining({ leg: 'dense', reason: 'no_embedder' })]);
      expect(JSON.stringify(absent)).not.toContain(MARK);
    } finally {
      await a.close();
      resetLoggerFactory();
      resetRecallLogOnce();
    }
  });
});
