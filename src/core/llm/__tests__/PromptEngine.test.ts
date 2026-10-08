import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptEngine } from '../PromptEngine';
import { ContextualElementType, type ModelTargetInfo, type PromptExecutionContext } from '../IPromptEngine';
import type { ChatMessage } from '../providers/IProvider';
import { MessageRole, createConversationMessage } from '../../conversation/ConversationMessage';

const baseModelInfo: ModelTargetInfo = {
  modelId: 'gpt-4o-mini',
  providerId: 'openai',
  maxContextTokens: 128000,
  optimalContextTokens: 64000,
  capabilities: ['chat'],
  promptFormatType: 'openai_chat',
  toolSupport: { supported: false, format: 'openai_functions' },
};

const baseExecutionContext: PromptExecutionContext = {
  activePersona: {
    id: 'persona-test',
    name: 'Test Persona',
    description: 'Test persona',
    baseSystemPrompt: 'You are helpful.',
    contextualPromptElements: [],
  } as any,
  workingMemory: {
    id: 'wm-test',
    initialize: async () => undefined,
    set: async () => undefined,
    get: async () => undefined,
    delete: async () => undefined,
    getAll: async () => ({}),
    clear: async () => undefined,
    size: async () => 0,
    has: async () => false,
    close: async () => undefined,
  } as any,
};

function createPromptEngine(): PromptEngine {
  const engine = new PromptEngine();
  return engine;
}

function extractSystemContent(messages: unknown): string {
  const promptMessages = messages as ChatMessage[];
  const systemMessage = promptMessages.find((message) => message.role === 'system');
  return typeof systemMessage?.content === 'string' ? systemMessage.content : '';
}

describe('PromptEngine user preferences', () => {
  let engine: PromptEngine;

  beforeEach(async () => {
    engine = createPromptEngine();
    await engine.initialize({
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated' },
      historyManagement: {
        defaultMaxMessages: 10,
        maxTokensForHistory: 2048,
        summarizationTriggerRatio: 0.8,
        preserveImportantMessages: true,
      },
      contextManagement: {
        maxRAGContextTokens: 2048,
        summarizationQualityTier: 'balanced',
        preserveSourceAttributionInSummary: true,
      },
      contextualElementSelection: {
        maxElementsPerType: {},
        defaultMaxElementsPerType: 3,
        priorityResolutionStrategy: 'highest_first',
        conflictResolutionStrategy: 'skip_conflicting',
      },
      performance: {
        enableCaching: true,
        cacheTimeoutSeconds: 60,
      },
    });
  });

  it('injects concise verbosity guidance into system prompts', async () => {
    const result = await engine.constructPrompt(
      {
        systemPrompts: [{ content: 'Base instructions' }],
        userInput: 'Summarize this.',
      },
      baseModelInfo,
      {
        ...baseExecutionContext,
        userPreferences: { verbosity: 'low' },
      },
    );

    const systemContent = extractSystemContent(result.prompt);
    expect(systemContent).toContain('Base instructions');
    expect(systemContent).toContain('keep the answer concise and efficient');
  });

  it('injects preferred format guidance into system prompts', async () => {
    const result = await engine.constructPrompt(
      {
        userInput: 'List deployment options.',
      },
      baseModelInfo,
      {
        ...baseExecutionContext,
        userPreferences: { preferredFormat: 'bullet points' },
      },
    );

    const systemContent = extractSystemContent(result.prompt);
    expect(systemContent).toContain('format the response as bullet points');
  });

  it('keeps cached prompts isolated across user preference changes', async () => {
    const baseComponents = {
      systemPrompts: [{ content: 'Base instructions' }],
      userInput: 'Explain the tradeoffs.',
    };

    const concise = await engine.constructPrompt(
      baseComponents,
      baseModelInfo,
      {
        ...baseExecutionContext,
        userPreferences: { verbosity: 'brief' },
      },
    );

    const detailed = await engine.constructPrompt(
      baseComponents,
      baseModelInfo,
      {
        ...baseExecutionContext,
        userPreferences: { verbosity: 'detailed' },
      },
    );

    expect(concise.cacheKey).not.toBe(detailed.cacheKey);
    expect(extractSystemContent(concise.prompt)).toContain('keep the answer concise and efficient');
    expect(extractSystemContent(detailed.prompt)).toContain('provide a detailed, thorough answer');
  });

  it('does not serve one multimodal turn the cached prompt of another', async () => {
    // GMI sends multimodal input as the last history message, not as userInput.
    const multimodalTurn = (question: string) => ({
      systemPrompts: [{ content: 'Base instructions' }],
      conversationHistory: [
        createConversationMessage(MessageRole.USER, [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ]),
      ],
    });

    await engine.constructPrompt(multimodalTurn('What is in this picture?'), baseModelInfo, baseExecutionContext);
    const second = await engine.constructPrompt(multimodalTurn('Which camera is this?'), baseModelInfo, baseExecutionContext);

    const userMessage = (second.prompt as ChatMessage[]).find((message) => message.role === 'user');
    expect(JSON.stringify(userMessage?.content)).toContain('Which camera is this?');
  });
});

describe('PromptEngine history budgeting', () => {
  /** An engine without a utility AI, so over-budget history is truncated. */
  async function truncatingEngine(): Promise<PromptEngine> {
    const engine = createPromptEngine();
    await engine.initialize({
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated' },
      historyManagement: {
        defaultMaxMessages: 10,
        maxTokensForHistory: 2048,
        summarizationTriggerRatio: 0.8,
        preserveImportantMessages: true,
      },
      contextManagement: {
        maxRAGContextTokens: 2048,
        summarizationQualityTier: 'balanced',
        preserveSourceAttributionInSummary: true,
      },
      contextualElementSelection: {
        maxElementsPerType: {},
        defaultMaxElementsPerType: 3,
        priorityResolutionStrategy: 'highest_first',
        conflictResolutionStrategy: 'skip_conflicting',
      },
      performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
    });
    return engine;
  }

  /** A model target with a `window`-token context and the 4-chars-a-token estimate. */
  function modelWith(window: number): ModelTargetInfo {
    return { ...baseModelInfo, modelId: 'test-model', maxContextTokens: window, optimalContextTokens: undefined };
  }

  it('does not start a truncated history with a tool result whose call was dropped', async () => {
    const engine = await truncatingEngine();
    // A 1000-token window leaves history 350 tokens. Dropping the oldest
    // message alone fits the budget and would leave the tool result first.
    const history = [
      createConversationMessage(MessageRole.ASSISTANT, 'c'.repeat(100), {
        tool_calls: [{ id: 'call_0', name: 'lookup', arguments: {} }],
      }),
      createConversationMessage(MessageRole.TOOL, 'x'.repeat(200), { tool_call_id: 'call_0', name: 'lookup' }),
      createConversationMessage(MessageRole.USER, 'a'.repeat(1120)),
      createConversationMessage(MessageRole.ASSISTANT, 'b'.repeat(40)),
    ];

    const result = await engine.constructPrompt(
      { systemPrompts: [{ content: 'Base instructions' }], conversationHistory: history, userInput: 'Next?' },
      modelWith(1000),
      baseExecutionContext,
    );

    const prompt = result.prompt as ChatMessage[];
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(prompt.some((message) => message.role === 'tool')).toBe(false);
  });

  it('keeps as much earlier history as its budget allows when the prompt runs over', async () => {
    const engine = await truncatingEngine();
    // 2000-token window: history gets 700. Ten 250-token messages come
    // before a 100-token current turn, so the earlier history may keep 595.
    const earlier = Array.from({ length: 10 }, (_, i) =>
      createConversationMessage(i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT, `m${i}:${'e'.repeat(997)}`),
    );
    const turn = createConversationMessage(MessageRole.USER, 'q'.repeat(400));

    const result = await engine.constructPrompt(
      {
        systemPrompts: [{ content: 'Base instructions' }],
        conversationHistory: [...earlier, turn],
        currentTurnMessageCount: 1,
      },
      modelWith(2000),
      baseExecutionContext,
    );

    const texts = (result.prompt as ChatMessage[]).map((message) => String(message.content));
    expect(texts.filter((text) => text.startsWith('m'))).toEqual([earlier[8].content, earlier[9].content]);
    expect(texts[texts.length - 1]).toBe(turn.content);
  });

  /** A history whose assistant turns carry about 500 tokens of thinking each. */
  function thinkingHistory() {
    const thinkingTurn = (i: number) =>
      createConversationMessage(MessageRole.ASSISTANT, `ok ${i}`, {
        thinkingBlocks: [{ type: 'thinking', thinking: 't'.repeat(2000), signature: `sig-${i}` }],
      });
    return [
      createConversationMessage(MessageRole.USER, 'first'),
      thinkingTurn(1),
      createConversationMessage(MessageRole.USER, 'second'),
      thinkingTurn(2),
      createConversationMessage(MessageRole.USER, 'third'),
      thinkingTurn(3),
    ];
  }

  async function assistantTurnsSentTo(model: ModelTargetInfo): Promise<ChatMessage[]> {
    const engine = await truncatingEngine();
    const result = await engine.constructPrompt(
      { systemPrompts: [{ content: 'Base instructions' }], conversationHistory: thinkingHistory(), userInput: 'Next?' },
      model,
      baseExecutionContext,
    );
    return (result.prompt as ChatMessage[]).filter((message) => message.role === 'assistant');
  }

  it('counts the thinking a Claude model keeps in context toward the history budget', async () => {
    // Opus 5.5 receives every turn's thinking: about 1500 tokens against 700.
    const assistants = await assistantTurnsSentTo({ ...modelWith(2000), providerId: 'anthropic', modelId: 'claude-opus-5-5' });

    expect(assistants.length).toBeLessThan(3);
    expect(assistants[assistants.length - 1]?.content).toBe('ok 3');
  });

  it('follows the strip override for a Claude model that keeps thinking in context', async () => {
    vi.stubEnv('AGENTOS_ANTHROPIC_STRIP_PRIOR_THINKING', '1');
    try {
      // With prior thinking stripped, only the latest turn's thinking is sent.
      const assistants = await assistantTurnsSentTo({ ...modelWith(2000), providerId: 'anthropic', modelId: 'claude-opus-5-5' });
      expect(assistants).toHaveLength(3);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not count thinking the target never receives', async () => {
    // OpenAI drops thinking blocks, and Sonnet 4.5 receives only the latest
    // turn's, so the history fits either way.
    expect(await assistantTurnsSentTo(modelWith(2000))).toHaveLength(3);
    expect(
      await assistantTurnsSentTo({ ...modelWith(2000), providerId: 'anthropic', modelId: 'claude-sonnet-4-5' }),
    ).toHaveLength(3);
  });

  it('drops the earlier history instead of summarizing it when the turn fills the budget', async () => {
    const summarizeConversationHistory = vi.fn(async () => ({
      summaryMessages: [createConversationMessage(MessageRole.SUMMARY, 'Summary.')],
      originalTokenCount: 100,
      finalTokenCount: 64,
      messagesSummarized: 2,
    }));
    const engine = createPromptEngine();
    await engine.initialize(
      {
        defaultTemplateName: 'openai_chat',
        availableTemplates: {},
        tokenCounting: { strategy: 'estimated' },
        historyManagement: {
          defaultMaxMessages: 10,
          maxTokensForHistory: 2048,
          summarizationTriggerRatio: 0.8,
          preserveImportantMessages: true,
        },
        contextManagement: {
          maxRAGContextTokens: 2048,
          summarizationQualityTier: 'balanced',
          preserveSourceAttributionInSummary: true,
        },
        contextualElementSelection: {
          maxElementsPerType: {},
          defaultMaxElementsPerType: 3,
          priorityResolutionStrategy: 'highest_first',
          conflictResolutionStrategy: 'skip_conflicting',
        },
        performance: { enableCaching: false, cacheTimeoutSeconds: 60 },
      },
      { summarizeConversationHistory } as never,
    );
    // The current turn alone takes the whole 700-token history budget.
    const turn = createConversationMessage(MessageRole.USER, 'q'.repeat(2800));

    const result = await engine.constructPrompt(
      {
        systemPrompts: [{ content: 'Base instructions' }],
        conversationHistory: [
          createConversationMessage(MessageRole.USER, 'e'.repeat(400)),
          createConversationMessage(MessageRole.ASSISTANT, 'f'.repeat(400)),
          turn,
        ],
        currentTurnMessageCount: 1,
      },
      modelWith(2000),
      baseExecutionContext,
    );

    expect(summarizeConversationHistory).not.toHaveBeenCalled();
    const prompt = result.prompt as ChatMessage[];
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user']);
    expect(prompt[1].content).toBe(turn.content);
  });

  it('drops an oversized earlier reply when the request travels as userInput', async () => {
    const engine = await truncatingEngine();

    const result = await engine.constructPrompt(
      {
        systemPrompts: [{ content: 'Base instructions' }],
        conversationHistory: [createConversationMessage(MessageRole.ASSISTANT, 'r'.repeat(4000))],
        userInput: 'Summarize that in one line.',
      },
      modelWith(2000),
      baseExecutionContext,
    );

    const prompt = result.prompt as ChatMessage[];
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user']);
  });
});

describe('PromptEngine prompt cache', () => {
  let engine: PromptEngine;

  beforeEach(async () => {
    engine = createPromptEngine();
    await engine.initialize({
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated' },
      historyManagement: {
        defaultMaxMessages: 10,
        maxTokensForHistory: 2048,
        summarizationTriggerRatio: 0.8,
        preserveImportantMessages: true,
      },
      contextManagement: {
        maxRAGContextTokens: 2048,
        summarizationQualityTier: 'balanced',
        preserveSourceAttributionInSummary: true,
      },
      contextualElementSelection: {
        maxElementsPerType: {},
        defaultMaxElementsPerType: 3,
        priorityResolutionStrategy: 'highest_first',
        conflictResolutionStrategy: 'skip_conflicting',
      },
      performance: { enableCaching: true, cacheTimeoutSeconds: 60 },
    });
  });

  /** A conversation whose last two messages every caller shares. */
  function conversation(accountNote: string) {
    return {
      systemPrompts: [{ content: 'Base instructions' }],
      conversationHistory: [
        createConversationMessage(MessageRole.USER, accountNote),
        createConversationMessage(MessageRole.ASSISTANT, 'Anything else?'),
      ],
      userInput: 'Yes.',
    };
  }

  it('does not serve one conversation the cached prompt of another', async () => {
    const first = await engine.constructPrompt(conversation('My account ends in 1111.'), baseModelInfo, baseExecutionContext);
    const second = await engine.constructPrompt(conversation('My account ends in 2222.'), baseModelInfo, baseExecutionContext);

    expect(second.cacheKey).not.toBe(first.cacheKey);
    const text = JSON.stringify(second.prompt);
    expect(text).toContain('2222');
    expect(text).not.toContain('1111');
  });

  it.each([
    ['without contextual elements', baseExecutionContext],
    [
      'with a contextual element to evaluate',
      {
        ...baseExecutionContext,
        activePersona: {
          ...baseExecutionContext.activePersona,
          contextualPromptElements: [
            {
              id: 'brevity',
              type: ContextualElementType.SYSTEM_INSTRUCTION_ADDON,
              content: 'Answer briefly.',
              criteria: {},
            },
          ],
        },
      } as PromptExecutionContext,
    ],
  ])('builds and caches the input as it was when the call started (%s)', async (_label, context) => {
    const input = conversation('My account ends in 1111.');
    const original = JSON.parse(JSON.stringify(input));
    const pending = engine.constructPrompt(input, baseModelInfo, context);
    input.userInput = 'Changed while the call was running.';
    const built = await pending;

    const reused = await engine.constructPrompt(original, baseModelInfo, context);

    expect(reused.cacheKey).toBe(built.cacheKey);
    for (const result of [built, reused]) {
      const text = JSON.stringify(result.prompt);
      expect(text).toContain('Yes.');
      expect(text).not.toContain('Changed while');
    }
  });

  it('does not serve a cached prompt built with other retrieved context', async () => {
    await engine.constructPrompt(
      { ...conversation('Hello.'), retrievedContext: 'The user prefers tea.' },
      baseModelInfo,
      baseExecutionContext,
    );
    const second = await engine.constructPrompt(
      { ...conversation('Hello.'), retrievedContext: 'The user prefers coffee.' },
      baseModelInfo,
      baseExecutionContext,
    );

    const text = JSON.stringify(second.prompt);
    expect(text).toContain('coffee');
    expect(text).not.toContain('tea');
  });

  it('does not serve a prompt cached for another image URL', async () => {
    const imageTurn = (url: URL) => ({
      systemPrompts: [{ content: 'Base instructions' }],
      conversationHistory: [
        createConversationMessage(MessageRole.USER, [
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image_url', image_url: { url: url as unknown as string } },
        ]),
      ],
    });

    await engine.constructPrompt(imageTurn(new URL('https://img.test/cat.png')), baseModelInfo, baseExecutionContext);
    const second = await engine.constructPrompt(imageTurn(new URL('https://img.test/dog.png')), baseModelInfo, baseExecutionContext);

    const text = JSON.stringify(second.prompt);
    expect(text).toContain('dog.png');
    expect(text).not.toContain('cat.png');
  });

  it('builds a key for a component whose toJSON returns itself', async () => {
    const selfSerializing = { note: 'plain data', toJSON() { return this; } };

    const result = await engine.constructPrompt(
      { ...conversation('Hello.'), customComponents: { selfSerializing } },
      baseModelInfo,
      baseExecutionContext,
    );

    expect(result.cacheKey).toMatch(/^promptcache:/);
  });

  it('does not share a key between binary views of different types', async () => {
    const bytes = new Uint8Array([1, 0, 2, 0]);
    const base = conversation('Hello.');
    const keyFor = async (view: ArrayBufferView) =>
      (
        await engine.constructPrompt(
          { ...base, customComponents: { view } },
          baseModelInfo,
          baseExecutionContext,
        )
      ).cacheKey;

    expect(await keyFor(bytes)).not.toBe(await keyFor(new Uint16Array(bytes.buffer)));
  });

  it('does not share a key between preferences held on a prototype', async () => {
    const base = conversation('Hello.');
    const keyFor = async (verbosity: string) =>
      (
        await engine.constructPrompt(base, baseModelInfo, {
          ...baseExecutionContext,
          userPreferences: Object.create({ verbosity }) as Record<string, unknown>,
        })
      ).cacheKey;

    expect(await keyFor('brief')).not.toBe(await keyFor('detailed'));
  });

  it('does not share a key between personas defined on a prototype', async () => {
    const base = conversation('Hello.');
    const keyFor = async (id: string) =>
      (
        await engine.constructPrompt(base, baseModelInfo, {
          ...baseExecutionContext,
          activePersona: Object.create({ id, name: id, contextualPromptElements: [] }),
        })
      ).cacheKey;

    expect(await keyFor('persona-one')).not.toBe(await keyFor('persona-two'));
  });

  it('serializes a value the way the prompt does, passing toJSON its property key', async () => {
    const base = conversation('Hello.');
    const imageAt = (href: string) => ({
      toJSON(key: string) {
        return key === 'url' ? href : 'image';
      },
    });
    const keyFor = async (href: string) =>
      (
        await engine.constructPrompt(
          { ...base, customComponents: { image: { url: imageAt(href) } } },
          baseModelInfo,
          baseExecutionContext,
        )
      ).cacheKey;

    expect(await keyFor('https://img.test/cat.png')).not.toBe(await keyFor('https://img.test/dog.png'));
  });

  it('does not read a literal $ref object as a repeated reference', async () => {
    const base = conversation('Hello.');
    const part = { type: 'text', text: 'x' };
    const keyFor = async (list: unknown[]) =>
      (
        await engine.constructPrompt({ ...base, customComponents: { list } }, baseModelInfo, baseExecutionContext)
      ).cacheKey;

    const repeated = await keyFor([part, part]);
    for (let order = 0; order < 12; order++) {
      expect(await keyFor([part, { $ref: order }])).not.toBe(repeated);
    }
  });

  it('serializes the components at the root, as the prompt copy does', async () => {
    const keyFor = async (userInput: string) => {
      const components = {
        systemPrompts: [{ content: 'Base instructions' }],
        userInput,
        toJSON(key: string) {
          return key === '' ? { systemPrompts: this.systemPrompts, userInput: this.userInput } : {};
        },
      };
      return (await engine.constructPrompt(components as never, baseModelInfo, baseExecutionContext)).cacheKey;
    };

    expect(await keyFor('first question')).not.toBe(await keyFor('second question'));
  });

  it('serializes class-based components through their own toJSON', async () => {
    class Components {
      constructor(private readonly question: string) {}
      get systemPrompts() {
        return [{ content: 'Base instructions' }];
      }
      get userInput() {
        return this.question;
      }
      toJSON() {
        return { systemPrompts: this.systemPrompts, userInput: this.userInput };
      }
    }
    const keyFor = async (question: string) =>
      (await engine.constructPrompt(new Components(question) as never, baseModelInfo, baseExecutionContext)).cacheKey;

    expect(await keyFor('first question')).not.toBe(await keyFor('second question'));
  });

  it('still serves an identical construction from the cache', async () => {
    const components = conversation('Hello.');
    const first = await engine.constructPrompt(components, baseModelInfo, baseExecutionContext);
    const second = await engine.constructPrompt(components, baseModelInfo, baseExecutionContext);

    expect(second.cacheKey).toBe(first.cacheKey);
    expect((await engine.getEngineStatistics()).cacheStats.hits).toBe(1);
  });
});
