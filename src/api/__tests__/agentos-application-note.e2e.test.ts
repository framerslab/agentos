/**
 * @file agentos-application-note.e2e.test.ts
 * A host's note for one reply (`AgentOSInput.applicationNote`) on the runtime path: `AgentOS.create()` with a memory
 * manager from `gmiManagerConfig.cognitiveMemoryFactory` (a real CognitiveMemoryManager over an InMemoryVectorStore
 * with a word-hash embedding), and `processRequest()` turns. Only the provider classes are stubbed
 * (helpers/stubProviders.ts), so the real runtime, turn pipeline, GMI, memory bridge and PromptEngine run, and what
 * reached the model is read from the request the stub received. A spy on the real memory assembler keeps the block
 * each turn assembled.
 *
 * The note rides the newest user message in the application note, before the memory block, in each request the turn's
 * own model calls send. It never enters the system text or the stored history, it is counted in the prompt's budget,
 * and it is never cut to fit. The budget cases run on PromptEngine directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/AnthropicProvider')>()),
  AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic'),
}));
vi.mock('../../core/llm/providers/implementations/OllamaProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OllamaProvider')>()),
  OllamaProvider: (await import('./helpers/stubProviders')).stubProviderClass('ollama'),
}));
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
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
import { AgentOS } from '../AgentOS';
import type { AgentOSInput } from '../types/AgentOSInput';
import { AgentOSResponseChunkType, type AgentOSResponse } from '../types/AgentOSResponse';
import * as root from '../../index';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import type { CognitiveMemoryConfig } from '../../cognition/memory/core/config';
import type { MemoryRecallCapture } from '../../cognition/memory/retrieval/recall/capture';
import { InMemoryVectorStore } from '../../cognition/rag/vector_stores/InMemoryVectorStore';
import { InMemoryWorkingMemory } from '../../cognition/substrate/memory/InMemoryWorkingMemory';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { promptEngineConfig } from '../../cognition/substrate/__tests__/helpers/scriptedGmi';
import { MessageRole, createConversationMessage } from '../../core/conversation/ConversationMessage';
import type { ILongTermMemoryRetriever } from '../../core/conversation/ILongTermMemoryRetriever';
import { APPLICATION_NOTE_FRAME, PromptEngine } from '../../core/llm/PromptEngine';
import type { ModelTargetInfo, PromptComponents, PromptExecutionContext, PromptEngineResult } from '../../core/llm/IPromptEngine';
import type { ChatMessage } from '../../core/llm/providers/IProvider';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { reply, script, systemTextOf, type ProviderScript } from './helpers/stubProviders';

/** The frame line the prompt engine opens the note with. */
const FRAME = APPLICATION_NOTE_FRAME;
/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';
/** The statement the later turns recall: it shares most of its words with them, so the word-hash embedding finds it. */
const EARLIER = 'Work at the hotel front desk is slow in the afternoon, so I end up chatting with Tess when I am bored at the desk.';
/** Words of the earlier statement that only its trace holds. */
const EARLIER_MARK = 'bored at the desk';
const WORDS_ONE = 'Hey Tess! Another slow afternoon at the hotel front desk.';
const WORDS_TWO = "Still slow at the hotel front desk this afternoon, so I'm chatting with you again.";

const PERSONA_ID = 'desk-friend';
const persona = (providerId: string): IPersonaDefinition => ({
  id: PERSONA_ID,
  name: 'Desk Friend',
  description: 'Keeps the person company at work.',
  version: '1.0.0',
  baseSystemPrompt: 'You are Tess, a dry-witted friend. Talk like a person, in short lines.',
  defaultProviderId: providerId,
  defaultModelId: 'stub-model',
});
const NEUTRAL = { valence: 0, arousal: 0, dominance: 0 };

let n = 0;
const key = () => `k-application-note-${++n}`;

/** A 64-dimension embedding: each word adds 1 at the slot its hash names, then the vector is normalized. */
function wordHash(text: string): number[] {
  const vector = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) >>> 0;
    vector[h % 64] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

const managers: CognitiveMemoryManager[] = [];
/** A memory manager whose capture rides the runtime stream, so the final response carries `memoryRecall`. */
async function memoryManager(): Promise<CognitiveMemoryManager> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.initialize({ id: `application-note-${Math.random()}`, type: 'in_memory' } as never);
  const noop = async () => undefined;
  const manager = new CognitiveMemoryManager();
  await manager.initialize({
    agentId: PERSONA_ID,
    traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, emotionality: 0.5, honesty: 0.5 },
    moodProvider: () => NEUTRAL,
    featureDetectionStrategy: 'keyword',
    workingMemory: new InMemoryWorkingMemory(),
    knowledgeGraph: { initialize: noop, recordMemory: async () => ({ id: 'm' }), deleteMemories: async () => 0, upsertEntity: async () => ({ id: 'e' }), upsertRelation: async () => ({ id: 'r' }), getRelations: async () => [], queryEntities: async () => [] },
    vectorStore,
    embeddingManager: {
      generateEmbeddings: async ({ texts }: { texts: string | string[] }) => ({ embeddings: (Array.isArray(texts) ? texts : [texts]).map(wordHash) }),
    },
    graph: { disabled: true },
    recall: { capture: 'metadata+stream' },
  } as unknown as CognitiveMemoryConfig);
  managers.push(manager);
  return manager;
}

interface BootOptions {
  /** The context window the stub model reports. Default 128,000. */
  window?: number;
  /** False for a runtime with no cognitive memory. */
  memory?: boolean;
  /** A host long-term-memory retriever, read on every turn. */
  retriever?: ILongTermMemoryRetriever;
  /** Tools registered with the runtime, which the GMI runs itself. */
  tools?: Record<string, unknown>;
}

let booted: AgentOS | undefined;
beforeEach(() => {
  assemblies.length = 0;
  globalLLMProviderHealth.reset();
});
afterEach(async () => {
  await booted?.shutdown().catch(() => undefined);
  booted = undefined;
  while (managers.length) await managers.pop()!.shutdown().catch(() => undefined);
  globalLLMProviderHealth.reset();
  vi.restoreAllMocks();
});

/** Boots the runtime on `providerId`'s stub, under a key of its own, with cognitive memory unless told otherwise. */
async function boot(providerId: 'anthropic' | 'ollama', options: BootOptions = {}): Promise<{ agentos: AgentOS; model: ProviderScript }> {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const k = key();
  const model = script(providerId, k, { ...(options.window ? { window: options.window } : {}), replies: [] });
  const manager = options.memory === false ? undefined : await memoryManager();
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId, enabled: true, isDefault: true, config: { apiKey: k } }] },
    turnPlanning: { enabled: false },
    personas: [persona(providerId)],
    ...(manager ? { gmiManagerConfig: { cognitiveMemoryFactory: () => manager.forSession() } } : {}),
    ...(options.retriever
      ? { longTermMemoryRetriever: options.retriever, orchestratorConfig: { longTermMemoryRecall: { cadenceTurns: 1 } } }
      : {}),
    ...(options.tools ? { tools: options.tools } : {}),
  } as never);
  return { agentos: booted, model };
}

/** Every chunk of one turn, sent on session `s-note` and conversation `c-note` unless `input` names others. */
async function send(agentos: AgentOS, input: Partial<AgentOSInput> & { textInput: string }): Promise<AgentOSResponse[]> {
  const request: AgentOSInput = { userId: 'user-1', sessionId: 's-note', conversationId: 'c-note', selectedPersonaId: PERSONA_ID, ...input };
  const chunks: AgentOSResponse[] = [];
  for await (const chunk of agentos.processRequest(request)) chunks.push(chunk);
  return chunks;
}

/** The turn's final response, after checking the turn carried no error and answered `answer`. */
function served(chunks: AgentOSResponse[], answer: string): Record<string, unknown> {
  const errors = chunks
    .filter((c) => c.type === AgentOSResponseChunkType.ERROR)
    .map((c) => c as unknown as { code?: string; message?: string })
    .map(({ code, message }) => ({ code, message }));
  expect(errors).toEqual([]);
  const final = chunks.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE) as Record<string, unknown> | undefined;
  expect(final?.finalResponseText).toBe(answer);
  return final!;
}

/** One served turn that the model answers with `answers`, in order (a tool step, then text). */
async function turn(
  agentos: AgentOS,
  model: ProviderScript,
  input: Partial<AgentOSInput> & { textInput: string },
  ...answers: Array<ReturnType<typeof reply.text> | ReturnType<typeof reply.tools>>
): Promise<{ final: Record<string, unknown>; request: ChatMessage[] }> {
  const before = model.seen.length;
  model.replies.push(...answers);
  const final = served(await send(agentos, input), String(textOfReply(answers[answers.length - 1])));
  expect(model.seen.length, 'model calls of the turn').toBe(before + answers.length);
  return { final, request: model.seen.at(-1)!.messages };
}

/** The text a scripted text reply answers. */
function textOfReply(answer: ReturnType<typeof reply.text> | ReturnType<typeof reply.tools>): unknown {
  return (answer[0] as { responseTextDelta?: unknown }).responseTextDelta;
}

/**
 * One served turn with a memory block: its request, its final response and the block the memory assembler returned on
 * it, after checking the block holds the earlier statement.
 */
async function turnWithBlock(
  agentos: AgentOS,
  model: ProviderScript,
  input: Partial<AgentOSInput> & { textInput: string },
  answer: string,
): Promise<{ final: Record<string, unknown>; request: ChatMessage[]; block: string }> {
  assemblies.length = 0;
  const { final, request } = await turn(agentos, model, input, reply.text(answer));
  expect(assemblies.length, 'memory assemblies on the turn').toBeGreaterThan(0);
  const block = assemblies[assemblies.length - 1];
  expect(block.startsWith(PREAMBLE_HEADING), `the block:\n${block}`).toBe(true);
  expect(block, 'the block holds the recalled statement').toContain(EARLIER_MARK);
  return { final, request, block };
}

/** The newest user message of a request. */
function newestUser(messages: ChatMessage[]): ChatMessage {
  const users = messages.filter((message) => message.role === 'user');
  expect(users.length, 'user messages in the request').toBeGreaterThan(0);
  return users[users.length - 1];
}

/** The first text of a message: its one string, or its first text part. */
function firstTextOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  const part = (message.content ?? []).find((p) => p.type === 'text');
  return part && 'text' in part && typeof part.text === 'string' ? part.text : '';
}

/** Tokens of a text by the assembler's and the prompt engine's estimate (about four characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

/** Three noted turns: the earlier statement with no note, then WORDS_ONE with 'Note one.' and WORDS_TWO with 'Note two.'. */
async function notedTurns(providerId: 'anthropic' | 'ollama') {
  const { agentos, model } = await boot(providerId);
  await turn(agentos, model, { textInput: EARLIER }, reply.text('Noted.'));
  const one = await turnWithBlock(agentos, model, { textInput: WORDS_ONE, applicationNote: 'Note one.' }, 'Bother away.');
  const two = await turnWithBlock(agentos, model, { textInput: WORDS_TWO, applicationNote: 'Note two.' }, 'Still here.');
  return { agentos, model, one, two };
}

describe('a host note through processRequest(): a provider that takes text parts (anthropic)', () => {
  it("each turn's newest user message opens with the frame, that turn's note and the memory block, then holds the words byte for byte; a later turn holds no earlier note", async () => {
    const { one, two } = await notedTurns('anthropic');
    expect(newestUser(one.request).content).toEqual([
      { type: 'text', text: `${FRAME}\nNote one.\n\n---\n\n${one.block}` },
      { type: 'text', text: WORDS_ONE },
    ]);
    expect(newestUser(two.request).content).toEqual([
      { type: 'text', text: `${FRAME}\nNote two.\n\n---\n\n${two.block}` },
      { type: 'text', text: WORDS_TWO },
    ]);
    expect(JSON.stringify(two.request)).not.toContain('Note one.');
  });

  it('sends the same system text on both noted turns, with neither note in any system message', async () => {
    const { one, two } = await notedTurns('anthropic');
    const first = systemTextOf(one.request);
    const second = systemTextOf(two.request);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
    for (const text of [first, second]) {
      expect(text).not.toContain('Note one.');
      expect(text).not.toContain('Note two.');
    }
  });

  it("keeps no note in the history: the second turn's request and the stored conversation hold the first turn's words alone", async () => {
    const { agentos, two } = await notedTurns('anthropic');
    const earlierUsers = two.request.slice(0, -1).filter((message) => message.role === 'user');
    expect(earlierUsers.map((message) => message.content)).toContain(WORDS_ONE);
    expect(JSON.stringify(earlierUsers)).not.toContain('Note one.');
    const stored = (await agentos.getConversationManager().getConversation('c-note'))?.getAllMessages() ?? [];
    const storedWords = stored.filter((message) => message.role === MessageRole.USER).map((message) => message.content);
    expect(storedWords).toContain(WORDS_ONE);
    expect(storedWords).toContain(WORDS_TWO);
    expect(JSON.stringify(stored)).not.toContain('Note one.');
    expect(JSON.stringify(stored)).not.toContain('Note two.');
  });

  it("charges nothing to the memory block's share: the recall's otherContextTokens is the long-term-memory text's alone, with a note and without", async () => {
    const longTerm = Array.from({ length: 12 }, (_, i) => `Profile line ${i}: the person works the afternoon shift at the hotel front desk.`).join('\n');
    const retriever: ILongTermMemoryRetriever = { retrieveLongTermMemory: async () => ({ contextText: longTerm }) };
    const { agentos, model } = await boot('anthropic', { retriever });
    const memoryControl = { longTermMemory: { enabled: true, scopes: { user: true } } };
    await turn(agentos, model, { textInput: EARLIER, memoryControl }, reply.text('Noted.'));
    const noted = await turnWithBlock(
      agentos,
      model,
      { textInput: WORDS_ONE, memoryControl, applicationNote: 'Note one, long enough to count: '.repeat(40).trim() },
      'Bother away.',
    );
    const plain = await turnWithBlock(agentos, model, { textInput: WORDS_TWO, memoryControl }, 'Still here.');
    const notedBudget = (noted.final.memoryRecall as MemoryRecallCapture).budget;
    const plainBudget = (plain.final.memoryRecall as MemoryRecallCapture).budget;
    expect(plainBudget.otherContextTokens).toBe(tokensOf(longTerm));
    expect(notedBudget.otherContextTokens).toBe(plainBudget.otherContextTokens);
    expect(JSON.stringify(noted.request)).toContain('Profile line 0:');
  });

  it("a tool round the runtime runs itself: the request after the tool's result carries the note as a user message of its own", async () => {
    const lookup = vi.fn(async () => ({ success: true, output: { desk: 'quiet' } }));
    const { agentos, model } = await boot('anthropic', {
      tools: {
        lookup_desk: {
          description: 'Reads how busy the hotel front desk is.',
          inputSchema: { type: 'object', properties: {} },
          execute: lookup,
        },
      },
    });
    await turn(agentos, model, { textInput: EARLIER }, reply.text('Noted.'));
    const { request } = await turn(
      agentos,
      model,
      { textInput: WORDS_ONE, applicationNote: 'Note one.' },
      reply.tools([{ id: 'call-desk-1', name: 'lookup_desk', args: {} }]),
      reply.text('Quiet day.'),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    // the request after the result: the tool's answer, then the note, a user message of its own
    expect(request.some((message) => message.role === 'tool')).toBe(true);
    expect(request[request.length - 1]).toEqual({ role: 'user', content: `${FRAME}\nNote one.` });
  });

  it('a note larger than the model\'s context goes out whole in every request, and a provider that refuses it fails the turn', async () => {
    const { agentos, model } = await boot('anthropic', { window: 2_000 });
    await turn(agentos, model, { textInput: EARLIER }, reply.text('Noted.'));
    const note = Array.from({ length: 200 }, (_, i) => `Shift log ${i}: the night porter left the lobby lights on and the desk bell rang twice.`).join('\n');
    expect(tokensOf(note)).toBeGreaterThan(2_000);
    const refusal = () => new Error('prompt is too long: the request is over the model limit');
    model.replies.push(refusal(), refusal(), refusal());
    const before = model.seen.length;
    const chunks = await send(agentos, { textInput: WORDS_ONE, applicationNote: note });
    const errors = chunks.filter((c) => c.type === AgentOSResponseChunkType.ERROR) as unknown as Array<{ message?: string }>;
    expect(errors.length, `the chunks: ${JSON.stringify(chunks.map((c) => c.type))}`).toBeGreaterThan(0);
    expect(errors.some((error) => String(error.message).includes('prompt is too long'))).toBe(true);
    const requests = model.seen.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    for (const { messages } of requests) {
      expect(firstTextOf(newestUser(messages)).startsWith(`${FRAME}\n${note}\n\n---\n\n`)).toBe(true);
    }
  });
});

describe('a host note through processRequest(): a provider that takes one string (ollama)', () => {
  it('the newest user message is one string: the frame, the note, the memory block, a blank line, then the words', async () => {
    const { one } = await notedTurns('ollama');
    expect(newestUser(one.request).content).toBe(`${FRAME}\nNote one.\n\n---\n\n${one.block}\n\n${WORDS_ONE}`);
  });
});

describe('a blank host note', () => {
  it('an empty or blank applicationNote sends the request that no field sends', async () => {
    const { agentos, model } = await boot('anthropic', { memory: false });
    const notes: Array<string | undefined> = [undefined, '', '  \n\t '];
    for (const [i, applicationNote] of notes.entries()) {
      await turn(
        agentos,
        model,
        { sessionId: `s-blank-${i}`, conversationId: `c-blank-${i}`, textInput: WORDS_ONE, ...(applicationNote === undefined ? {} : { applicationNote }) },
        reply.text('Bother away.'),
      );
    }
    const [none, empty, blank] = model.seen.map((seen) => seen.messages);
    expect(JSON.stringify(none)).not.toContain(FRAME);
    expect(empty).toEqual(none);
    expect(blank).toEqual(none);
  });
});

describe('the root export', () => {
  it('APPLICATION_NOTE_INPUT_FIELD names the field', () => {
    expect((root as unknown as Record<string, unknown>).APPLICATION_NOTE_INPUT_FIELD).toBe('applicationNote');
  });
});

describe('PromptEngine: a host note and the token budget', () => {
  const WORDS = "Hey Tess! Slow afternoon at work so I'm bothering you.";
  const MEMORY = '## How To Use Your Memories\nUse them.\n\n## Recent Experiences\n- Sam works the front desk at the Harbor Hotel.';
  /** Four earlier messages of about 106 tokens each: about 424 tokens, within the history's share of 700. */
  const EARLIER_HISTORY = Array.from({ length: 4 }, (_, i) =>
    createConversationMessage(
      i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
      `Earlier message ${i}: ${'the desk was quiet and the lobby was empty. '.repeat(9).trim()}`,
    ),
  );
  /** A model of 2,000 tokens: the budget is 2,000. */
  const SMALL: ModelTargetInfo = {
    modelId: 'stub-model',
    providerId: 'anthropic',
    maxContextTokens: 2_000,
    capabilities: ['chat'],
    promptFormatType: 'openai_chat',
    toolSupport: { supported: false, format: 'openai_functions' },
  };
  const executionContext = {
    activePersona: { id: 'tess', name: 'Tess', description: 'A friend.', baseSystemPrompt: 'You are Tess.', contextualPromptElements: [] },
    workingMemory: {},
  } as unknown as PromptExecutionContext;
  const base: PromptComponents = {
    systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
    conversationHistory: EARLIER_HISTORY,
    currentTurnMessageCount: 0,
    userInput: WORDS,
    memoryContextText: MEMORY,
  };
  /** A note of `lines` lines of 78 characters, a newline between them: about 20 tokens a line. */
  const noteOf = (lines: number) =>
    Array.from(
      { length: lines },
      (_, i) => `Desk log ${String(i).padStart(3, '0')}: the night porter rang the front desk bell twice before midnight.`,
    ).join('\n');

  let engine: PromptEngine;
  beforeEach(async () => {
    engine = new PromptEngine();
    await engine.initialize(promptEngineConfig());
  });

  const build = async (components: PromptComponents): Promise<{ result: PromptEngineResult; prompt: ChatMessage[] }> => {
    const result = await engine.constructPrompt(components, SMALL, executionContext);
    expect(result.issues?.filter((issue) => issue.type === 'error') ?? [], 'prompt construction errors').toEqual([]);
    return { result, prompt: result.prompt as ChatMessage[] };
  };
  const withNote = (note: string) => ({ ...base, applicationNote: note }) as PromptComponents;

  it('counts the note into the first estimate, so a note that takes the prompt over its budget reduces the earlier history; the memory block goes out the same', async () => {
    // about 1,580 tokens: with the note the prompt is over its budget of 2,000; without it, about 460 tokens, well within
    const note = noteOf(80);
    const noteTokens = await engine.estimateTokenCount(note, 'stub-model');
    expect(noteTokens).toBeGreaterThan(1_550);
    expect(noteTokens).toBeLessThan(1_650);
    const plain = await build(base);
    const noted = await build(withNote(note));

    expect(noted.result.modificationDetails!.originalEstimatedTokenCount!).toBeGreaterThanOrEqual(
      plain.result.modificationDetails!.originalEstimatedTokenCount! + noteTokens,
    );
    // without the note the earlier history is untouched; with it, the history is reduced
    expect(plain.result.modificationDetails!.truncatedComponents ?? []).not.toContain('conversationHistory');
    expect(JSON.stringify(plain.prompt)).toContain(String(EARLIER_HISTORY[0].content));
    expect(noted.result.modificationDetails!.truncatedComponents ?? []).toContain('conversationHistory');
    expect(JSON.stringify(noted.prompt)).not.toContain(String(EARLIER_HISTORY[0].content));
    // the memory block goes out whole on both, after the note when there is one, and counts the same
    expect(firstTextOf(newestUser(plain.prompt))).toBe(`${FRAME}\n${MEMORY}`);
    expect(firstTextOf(newestUser(noted.prompt))).toBe(`${FRAME}\n${note}\n\n---\n\n${MEMORY}`);
    expect(plain.result.metadata.contextTokens!.memory).toBeGreaterThan(0);
    expect(noted.result.metadata.contextTokens!.memory).toBe(plain.result.metadata.contextTokens!.memory);
  });

  it('counts what the note adds to the prompt as sent: the frame line it opens when it is alone, so a prompt the frame takes over the budget writes the warning', async () => {
    // 7,900 characters, 1,975 tokens: with the 13-character system text and the words, 1,993 tokens counted raw, under
    // the budget of 2,000; the frame line in front of the note takes the prompt as sent over it
    const note = 'Ring the desk bell. '.repeat(395);
    expect(note.length).toBe(7_900);
    const components = { systemPrompts: base.systemPrompts, userInput: WORDS, applicationNote: note } as PromptComponents;
    const { result, prompt } = await build(components);
    const estimate = (text: string) => engine.estimateTokenCount(text, 'stub-model');
    const sent = firstTextOf(newestUser(prompt));
    expect(sent).toBe(`${FRAME}\n${note}`);
    expect(result.modificationDetails!.originalEstimatedTokenCount!).toBeGreaterThanOrEqual(
      (await estimate(sent)) + (await estimate(WORDS)) + (await estimate('You are Tess.')),
    );
    expect((result.issues ?? []).map((issue) => issue.code)).toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });

  it('counts the note as it is sent beside the memory block: the frame line, the note and the separator, then the block', async () => {
    const note = 'Ring the desk bell. '.repeat(20);
    const components = { systemPrompts: base.systemPrompts, userInput: WORDS, memoryContextText: MEMORY, applicationNote: note } as PromptComponents;
    const { result, prompt } = await build(components);
    const estimate = (text: string) => engine.estimateTokenCount(text, 'stub-model');
    const sent = firstTextOf(newestUser(prompt));
    expect(sent).toBe(`${FRAME}\n${note}\n\n---\n\n${MEMORY}`);
    expect(result.modificationDetails!.originalEstimatedTokenCount!).toBeGreaterThanOrEqual(
      (await estimate(sent)) + (await estimate(WORDS)) + (await estimate('You are Tess.')),
    );
  });

  it('a note larger than the whole budget is sent whole, byte for byte, after the earlier history is reduced and the budget warning written', async () => {
    const note = noteOf(120);
    expect(await engine.estimateTokenCount(note, 'stub-model')).toBeGreaterThan(SMALL.maxContextTokens);
    const { result, prompt } = await build(withNote(note));
    expect(result.modificationDetails!.truncatedComponents ?? []).toContain('conversationHistory');
    expect((result.issues ?? []).map((issue) => issue.code)).toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
    expect(newestUser(prompt).content).toEqual([
      { type: 'text', text: `${FRAME}\n${note}\n\n---\n\n${MEMORY}` },
      { type: 'text', text: WORDS },
    ]);
  });

  it('counts the note without its separator once the retrieved text is removed, so a prompt that fits as sent writes no budget warning', async () => {
    const estimate = (text: string) => engine.estimateTokenCount(text, 'stub-model');
    const system = 'You are Tess.';
    // 2,016 characters, 504 tokens: over the retrieved text's share of 400, and the prompt is over its budget, so the
    // budget step removes it (a target of 0)
    const retrieved = 'Front desk notes. '.repeat(112);
    // the frame line and the note together are 7,928 characters, 1,982 tokens: with the system text (4) and the words
    // (14) the prompt as sent counts 2,000, the budget; a separator still counted after the retrieved text is removed
    // adds 2 and takes the count to 2,002
    const fits = 'Ring the desk bell. '.repeat(400).slice(0, 4 * 1_982 - FRAME.length - 1);
    // four characters more: 2,001 as sent, over the budget
    const over = 'Ring the desk bell. '.repeat(400).slice(0, 4 * 1_983 - FRAME.length - 1);
    const run = async (note: string) =>
      build({ systemPrompts: [{ content: system, priority: 1 }], userInput: WORDS, retrievedContext: retrieved, applicationNote: note } as PromptComponents);

    const fitting = await run(fits);
    const sent = firstTextOf(newestUser(fitting.prompt));
    expect(sent).toBe(`${FRAME}\n${fits}`);
    expect((await estimate(sent)) + (await estimate(WORDS)) + (await estimate(system))).toBe(SMALL.maxContextTokens);
    expect(fitting.result.modificationDetails!.originalEstimatedTokenCount).toBe(
      (await estimate(`${sent}\n\n---\n\n`)) + (await estimate(WORDS)) + (await estimate(system)) + (await estimate(retrieved)),
    );
    expect(fitting.result.modificationDetails!.removedComponents ?? []).toContain('retrievedContext');
    expect((fitting.result.issues ?? []).map((issue) => issue.code)).not.toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');

    const overrun = await run(over);
    expect(firstTextOf(newestUser(overrun.prompt))).toBe(`${FRAME}\n${over}`);
    expect(overrun.result.modificationDetails!.removedComponents ?? []).toContain('retrievedContext');
    expect((overrun.result.issues ?? []).map((issue) => issue.code)).toContain('TOKEN_BUDGET_EXCEEDED_POST_OPT');
  });
});

describe('PromptEngine: a host note in the generic_completion template', () => {
  const NOTE = 'The person is on a ten-minute break. Keep the reply short.';
  const GENERIC: ModelTargetInfo = {
    modelId: 'stub-model',
    providerId: 'stub',
    maxContextTokens: 8_000,
    capabilities: ['completion'],
    promptFormatType: 'generic_completion',
    toolSupport: { supported: false, format: 'openai_functions' },
  };
  const executionContext = {
    activePersona: { id: 'tess', name: 'Tess', description: 'A friend.', baseSystemPrompt: 'You are Tess.', contextualPromptElements: [] },
    workingMemory: {},
  } as unknown as PromptExecutionContext;

  let engine: PromptEngine;
  beforeEach(async () => {
    engine = new PromptEngine();
    await engine.initialize(promptEngineConfig());
  });

  const build = async (components: PromptComponents): Promise<string> => {
    const result = await engine.constructPrompt(components, GENERIC, executionContext);
    expect(result.issues?.filter((issue) => issue.type === 'error') ?? [], 'prompt construction errors').toEqual([]);
    expect(typeof result.prompt).toBe('string');
    return result.prompt as string;
  };

  it("puts the note in front of the person's words when they arrive as the history's newest user message, and leaves the stored message as it was", async () => {
    const history = [
      createConversationMessage(MessageRole.USER, 'Earlier words.'),
      createConversationMessage(MessageRole.ASSISTANT, 'Hi there.'),
      createConversationMessage(MessageRole.USER, 'Hello'),
    ];
    const prompt = await build({
      systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
      conversationHistory: history,
      currentTurnMessageCount: 1,
      applicationNote: NOTE,
    } as PromptComponents);
    expect(prompt.endsWith(`user: Earlier words.\nassistant: Hi there.\n\n${FRAME}\n${NOTE}\n\nuser: Hello\n\n`)).toBe(true);
    expect(prompt.split('user: Hello').length - 1).toBe(1);
    expect(history[2].content).toBe('Hello');

    const alone = await build({
      systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
      conversationHistory: [createConversationMessage(MessageRole.USER, 'Hello')],
      currentTurnMessageCount: 1,
      applicationNote: NOTE,
    } as PromptComponents);
    expect(alone.endsWith(`You are Tess.\n\n${FRAME}\n${NOTE}\n\nuser: Hello\n\n`)).toBe(true);
  });

  it('keeps the note in front of userInput, and after a history that ends with no user message', async () => {
    const withInput = await build({
      systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
      conversationHistory: [
        createConversationMessage(MessageRole.USER, 'Earlier words.'),
        createConversationMessage(MessageRole.ASSISTANT, 'Hi there.'),
      ],
      userInput: 'Hello',
      applicationNote: NOTE,
    } as PromptComponents);
    expect(withInput.endsWith(`user: Earlier words.\nassistant: Hi there.\n\n${FRAME}\n${NOTE}\n\nuser: Hello\nassistant:`)).toBe(true);

    const afterReply = await build({
      systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
      conversationHistory: [
        createConversationMessage(MessageRole.USER, 'Hello'),
        createConversationMessage(MessageRole.ASSISTANT, 'Hi there.'),
      ],
      currentTurnMessageCount: 2,
      applicationNote: NOTE,
    } as PromptComponents);
    expect(afterReply.endsWith(`user: Hello\nassistant: Hi there.\n\n${FRAME}\n${NOTE}\n\n`)).toBe(true);
  });

  const HISTORY_ENDING_WITH_WORDS = [
    createConversationMessage(MessageRole.USER, 'Earlier words.'),
    createConversationMessage(MessageRole.ASSISTANT, 'Hi there.'),
    createConversationMessage(MessageRole.USER, 'Hello'),
  ];

  it.each([
    ['no host note', {}],
    ['a blank host note', { applicationNote: ' \n\t ' }],
  ])("with %s, retrieved text stays after the history's newest user line: the prompt a host got before the field", async (_label, field) => {
    const prompt = await build({
      systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
      conversationHistory: HISTORY_ENDING_WITH_WORDS,
      currentTurnMessageCount: 1,
      retrievedContext: 'Front desk notes.',
      ...field,
    } as PromptComponents);
    expect(prompt.endsWith(`You are Tess.\n\nuser: Earlier words.\nassistant: Hi there.\nuser: Hello\n\n${FRAME}\nFront desk notes.\n\n`)).toBe(true);
  });

  it("with a host note, the retrieved text goes with it in front of the history's newest user line", async () => {
    const prompt = await build({
      systemPrompts: [{ content: 'You are Tess.', priority: 1 }],
      conversationHistory: HISTORY_ENDING_WITH_WORDS,
      currentTurnMessageCount: 1,
      retrievedContext: 'Front desk notes.',
      applicationNote: NOTE,
    } as PromptComponents);
    expect(prompt.endsWith(`user: Earlier words.\nassistant: Hi there.\n\n${FRAME}\n${NOTE}\n\n---\n\nFront desk notes.\n\nuser: Hello\n\n`)).toBe(true);
  });
});
