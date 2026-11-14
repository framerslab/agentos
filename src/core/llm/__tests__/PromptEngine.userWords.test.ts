/**
 * Where PromptEngine puts retrieved text in the newest user message, and what it does to the person's words: nothing.
 * The retrieved text (the memory block first, then any other retrieved context) travels as a note opened by one fixed
 * frame line, and the person's message follows it exactly as written. A provider whose adapter sends each text part of
 * a user message on as a part of its own gets two text parts; any other provider gets one string, the note and the
 * words a blank line apart, with no label in front of the words.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import * as promptEngineModule from '../PromptEngine';
import { PromptEngine } from '../PromptEngine';
import type { ModelTargetInfo, PromptComponents, PromptExecutionContext } from '../IPromptEngine';
import type { ChatMessage } from '../providers/IProvider';
import { MessageRole, createConversationMessage } from '../../conversation/ConversationMessage';
import { promptEngineConfig } from '../../../cognition/substrate/__tests__/helpers/scriptedGmi';

/** The frame line the engine opens retrieved text with. */
const FRAME = (promptEngineModule as unknown as { APPLICATION_NOTE_FRAME?: string }).APPLICATION_NOTE_FRAME;

const WORDS = "Hey Tess! Slow afternoon at work so I'm bothering you.";
const MEMORY =
  '## How To Use Your Memories\nUse them.\n\n## Recent Experiences\n- Sam works the front desk at the Harbor Hotel.';
const OTHER = 'Source A: the hotel bar opens at five.';
/** What the engine makes of a memory block and other retrieved text given side by side. */
const RETRIEVED = `${MEMORY}\n\n---\n\n${OTHER}`;

/** Providers whose adapter keeps each text part of a user message as a part of its own. */
const TAKES_PARTS = ['anthropic', 'openai', 'openrouter', 'gemini'];
/** Providers whose adapter joins or rewrites the text parts, or hands them to an endpoint that may refuse them. */
const TAKES_ONE_STRING = [
  'ollama', 'claude-code-cli', 'gemini-cli', 'groq', 'mistral', 'together', 'xai', 'litellm', 'minimax', 'requesty',
  'a-host-provider',
];

const model = (providerId: string, extra: Partial<ModelTargetInfo> = {}): ModelTargetInfo => ({
  modelId: 'stub-model',
  providerId,
  maxContextTokens: 128000,
  optimalContextTokens: 64000,
  capabilities: ['chat'],
  promptFormatType: 'openai_chat',
  toolSupport: { supported: false, format: 'openai_functions' },
  ...extra,
});

const executionContext = {
  activePersona: { id: 'tess', name: 'Tess', description: 'A friend.', baseSystemPrompt: 'You are Tess.', contextualPromptElements: [] },
  workingMemory: {},
} as unknown as PromptExecutionContext;

const base: PromptComponents = { systemPrompts: [{ content: 'You are Tess.', priority: 1 }], userInput: WORDS };

describe('PromptEngine: retrieved text beside the person\'s words', () => {
  let engine: PromptEngine;
  const build = async (components: PromptComponents, target: ModelTargetInfo): Promise<ChatMessage[]> => {
    const result = await engine.constructPrompt(components, target, executionContext);
    expect(result.issues?.filter((issue) => issue.type === 'error') ?? [], 'prompt construction errors').toEqual([]);
    return result.prompt as ChatMessage[];
  };

  beforeEach(async () => {
    engine = new PromptEngine();
    await engine.initialize(promptEngineConfig());
  });

  it('exports one short frame line that names the application, this reply, and the ban on quoting or mentioning', () => {
    expect(typeof FRAME, 'APPLICATION_NOTE_FRAME is an exported string').toBe('string');
    const frame = String(FRAME);
    expect(frame).not.toContain('\n');
    expect(frame.length).toBeLessThanOrEqual(160);
    expect(frame).toMatch(/application/i);
    expect(frame).toMatch(/not from the person/i);
    expect(frame).toMatch(/this reply/i);
    expect(frame).toMatch(/never/i);
    expect(frame).toMatch(/quote/i);
    expect(frame).toMatch(/mention/i);
    expect(frame).not.toMatch(/query|rag\b|retriev|context/i);
  });

  it.each(TAKES_PARTS)('%s: the note is a text part of its own and the words are the last text part, untouched', async (providerId) => {
    const prompt = await build({ ...base, memoryContextText: MEMORY, retrievedContext: OTHER }, model(providerId));
    const newest = prompt[prompt.length - 1];
    expect(newest.role).toBe('user');
    expect(newest.content).toEqual([
      { type: 'text', text: `${FRAME}\n${RETRIEVED}` },
      { type: 'text', text: WORDS },
    ]);
  });

  it.each(TAKES_ONE_STRING)('%s: one string, the note, a blank line, then the words with no label', async (providerId) => {
    const prompt = await build({ ...base, memoryContextText: MEMORY, retrievedContext: OTHER }, model(providerId));
    const newest = prompt[prompt.length - 1];
    expect(newest.role).toBe('user');
    expect(newest.content).toBe(`${FRAME}\n${RETRIEVED}\n\n${WORDS}`);
  });

  it.each([...TAKES_PARTS, ...TAKES_ONE_STRING])('%s: the old wrapper labels are nowhere in the prompt', async (providerId) => {
    const prompt = await build({ ...base, memoryContextText: MEMORY, retrievedContext: OTHER }, model(providerId));
    const text = JSON.stringify(prompt);
    expect(text).not.toContain('User Query:');
    expect(text).not.toContain('Context:\\n');
    expect(text).toContain(JSON.stringify(WORDS).slice(1, -1));
  });

  it('leaves a turn with no retrieved text as it was: the words as one string', async () => {
    for (const providerId of ['openai', 'ollama']) {
      const prompt = await build(base, model(providerId));
      expect(prompt[prompt.length - 1], providerId).toEqual({ role: 'user', content: WORDS });
    }
  });

  it('changes nothing before the newest user message', async () => {
    const history = [
      createConversationMessage(MessageRole.USER, 'Morning.'),
      createConversationMessage(MessageRole.ASSISTANT, 'Morning, Sam.'),
    ];
    for (const providerId of ['openai', 'ollama']) {
      const plain = await build({ ...base, conversationHistory: history }, model(providerId));
      const withNote = await build({ ...base, conversationHistory: history, memoryContextText: MEMORY }, model(providerId));
      expect(withNote, providerId).toHaveLength(plain.length);
      expect(withNote.slice(0, -1), providerId).toEqual(plain.slice(0, -1));
    }
  });

  it('keeps images after the words on a provider that takes parts', async () => {
    const vision = { visionSupport: { supported: true } } as Partial<ModelTargetInfo>;
    const prompt = await build(
      { ...base, memoryContextText: MEMORY, visionInputs: [{ type: 'image_url', data: 'https://example.com/desk.png' }] },
      model('openai', vision),
    );
    expect(prompt[prompt.length - 1].content).toEqual([
      { type: 'text', text: `${FRAME}\n${MEMORY}` },
      { type: 'text', text: WORDS },
      { type: 'image_url', image_url: { url: 'https://example.com/desk.png' } },
    ]);
  });

  it('joins the note to the words in one text part before the images on a provider that takes one string', async () => {
    const vision = { visionSupport: { supported: true } } as Partial<ModelTargetInfo>;
    const prompt = await build(
      { ...base, memoryContextText: MEMORY, visionInputs: [{ type: 'image_url', data: 'https://example.com/desk.png' }] },
      model('ollama', vision),
    );
    expect(prompt[prompt.length - 1].content).toEqual([
      { type: 'text', text: `${FRAME}\n${MEMORY}\n\n${WORDS}` },
      { type: 'image_url', image_url: { url: 'https://example.com/desk.png' } },
    ]);
  });

  it('puts the note in front of a structured user message and keeps its parts as they are', async () => {
    // A GMI sends a multimodal turn as the last history message, not as userInput.
    const turn = [
      { type: 'text', text: WORDS },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ];
    const components: PromptComponents = {
      systemPrompts: base.systemPrompts,
      conversationHistory: [createConversationMessage(MessageRole.USER, turn)],
      memoryContextText: MEMORY,
    };
    const parts = await build(components, model('openai'));
    expect(parts[parts.length - 1].content).toEqual([{ type: 'text', text: `${FRAME}\n${MEMORY}` }, ...turn]);
    const joined = await build(components, model('ollama'));
    expect(joined[joined.length - 1].content).toEqual([{ type: 'text', text: `${FRAME}\n${MEMORY}\n\n${WORDS}` }, turn[1]]);
  });

  it('sends the note alone, with no instruction about a query, when no user message is the newest', async () => {
    const history = [
      createConversationMessage(MessageRole.USER, WORDS),
      createConversationMessage(MessageRole.ASSISTANT, null, { tool_calls: [{ id: 'call_a', name: 'lookup', arguments: { q: 'bar' } }] }),
      createConversationMessage(MessageRole.TOOL, 'Opens at five.', { tool_call_id: 'call_a', name: 'lookup' }),
    ];
    for (const providerId of ['openai', 'ollama']) {
      const prompt = await build(
        { systemPrompts: base.systemPrompts, conversationHistory: history, retrievedContext: OTHER },
        model(providerId),
      );
      expect(prompt[prompt.length - 1], providerId).toEqual({ role: 'user', content: `${FRAME}\n${OTHER}` });
      expect(JSON.stringify(prompt), providerId).not.toMatch(/user query|Based on the following context/i);
    }
  });

  it('the anthropic_messages template sends the note and the words as two text parts', async () => {
    const result = await engine.constructPrompt(
      { ...base, memoryContextText: MEMORY, retrievedContext: OTHER },
      model('anthropic', { promptFormatType: 'anthropic_messages' }),
      executionContext,
    );
    const { messages } = result.prompt as unknown as { messages: ChatMessage[] };
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: `${FRAME}\n${RETRIEVED}` },
        { type: 'text', text: WORDS },
      ],
    });
    expect(JSON.stringify(result.prompt)).not.toContain('User Query:');
  });

  it('the generic_completion template opens the retrieved text with the frame line', async () => {
    const result = await engine.constructPrompt(
      { ...base, memoryContextText: MEMORY },
      model('a-host-provider', { promptFormatType: 'generic_completion' }),
      executionContext,
    );
    expect(typeof result.prompt).toBe('string');
    expect(result.prompt).toContain(`\n\n${FRAME}\n${MEMORY}\n\nuser: ${WORDS}\nassistant:`);
    expect(result.prompt).not.toContain('Context:\n');
  });

  it('counts the memory block and the other retrieved text as before', async () => {
    for (const providerId of ['openai', 'ollama']) {
      const result = await engine.constructPrompt(
        { ...base, memoryContextText: MEMORY, retrievedContext: OTHER },
        model(providerId),
        executionContext,
      );
      const other = await engine.estimateTokenCount(OTHER, 'stub-model');
      expect(result.metadata.contextTokens, providerId).toEqual({
        memory: await engine.estimateTokenCount(MEMORY, 'stub-model'),
        otherBefore: other,
        otherAfter: other,
      });
      expect(result.wasTruncatedOrSummarized, providerId).toBe(false);
    }
  });
});
