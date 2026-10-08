/**
 * @fileoverview GMI builds every prompt with the openai_chat template and
 * hands the resulting ChatMessage[] to the provider, which converts it to its
 * own wire format. A template picked from the provider id left Gemini with an
 * empty request and gave AnthropicProvider an object it could not iterate.
 *
 * Runs a real GMI over a real PromptEngine. The Gemini and Anthropic cases use
 * the real provider classes with only fetch stubbed and assert the request
 * bodies; the others use a scripted provider that records the ChatMessage[]
 * GMI passes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GMI } from '../GMI';
import {
  GMIInteractionType,
  GMIOutputChunkType,
  GMIPrimeState,
  type GMIOutput,
  type GMIOutputChunk,
  type GMITurnInput,
  type ToolCallResult,
} from '../IGMI';
import type { IPersonaDefinition } from '../personas/IPersonaDefinition';
import { InMemoryWorkingMemory } from '../memory/InMemoryWorkingMemory';
import type { IUtilityAI } from '../../nlp/ai_utilities/IUtilityAI';
import { PromptEngine } from '../../../core/llm/PromptEngine';
import type { IPromptEngineUtilityAI, PromptEngineConfig, PromptTemplateFunction } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage, IProvider, ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import { AnthropicProvider } from '../../../core/llm/providers/implementations/AnthropicProvider';
import { GeminiProvider } from '../../../core/llm/providers/implementations/GeminiProvider';
import type { IToolOrchestrator, ToolDefinitionForLLM } from '../../../core/tools/IToolOrchestrator';
import type { ToolExecutionRequestDetails } from '../../../core/tools/ToolExecutor';
import { MessageRole, createConversationMessage } from '../../../core/conversation/ConversationMessage';

type Json = Record<string, any>;

const SYSTEM_PROMPT = 'You are the prompt format test persona.';

const WEATHER_TOOL: ToolDefinitionForLLM = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

/** The PromptEngine.test.ts engine config, with caching off so no eviction timer starts. */
function promptEngineConfig(overrides: Partial<PromptEngineConfig> = {}): PromptEngineConfig {
  return {
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
    ...overrides,
  };
}

/**
 * Initializes a real GMI over a real PromptEngine. The provider manager
 * returns `provider` for every model, and the tool orchestrator lists `tools`
 * and answers each call with the output configured for the tool's name.
 */
async function createGmi(setup: {
  provider: IProvider;
  modelId: string;
  tools?: ToolDefinitionForLLM[];
  toolOutputs?: Record<string, unknown>;
  promptEngine?: PromptEngine;
  contextWindowSize?: number;
}) {
  const promptEngine = setup.promptEngine ?? new PromptEngine();
  if (!setup.promptEngine) await promptEngine.initialize(promptEngineConfig());
  const processToolCall = vi.fn(
    async ({ toolCallRequest }: ToolExecutionRequestDetails): Promise<ToolCallResult> => ({
      toolCallId: toolCallRequest.id,
      toolName: toolCallRequest.name,
      output: setup.toolOutputs?.[toolCallRequest.name] ?? null,
    }),
  );
  const gmi = new GMI(`gmi-${setup.provider.providerId}`);
  await gmi.initialize(
    {
      id: 'prompt-format-persona',
      name: 'Prompt Format Persona',
      version: '1.0.0',
      baseSystemPrompt: SYSTEM_PROMPT,
      defaultProviderId: setup.provider.providerId,
      defaultModelId: setup.modelId,
      metaPrompts: [],
    } as unknown as IPersonaDefinition,
    {
      workingMemory: new InMemoryWorkingMemory(),
      promptEngine,
      llmProviderManager: {
        getModelInfo: vi.fn(async (modelId: string) => ({
          modelId,
          providerId: setup.provider.providerId,
          contextWindowSize: setup.contextWindowSize ?? 1_000_000,
          capabilities: ['chat', 'tool_use'],
        })),
        getProvider: vi.fn(() => setup.provider),
        getProviderForModel: vi.fn(() => setup.provider),
      } as unknown as AIModelProviderManager,
      utilityAI: {} as unknown as IUtilityAI,
      toolOrchestrator: {
        orchestratorId: 'prompt-format-tools',
        listAvailableTools: vi.fn(async () => setup.tools ?? []),
        processToolCall,
      } as unknown as IToolOrchestrator,
    },
  );
  return { gmi, promptEngine, processToolCall };
}

/** Runs one turn to its end; returns the chunks and the generator's return value. */
async function runTurn(gmi: GMI, input: GMITurnInput): Promise<{ chunks: GMIOutputChunk[]; output: GMIOutput }> {
  const chunks: GMIOutputChunk[] = [];
  const stream = gmi.processTurnStream(input);
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, output: next.value };
    chunks.push(next.value);
  }
}

function textTurn(interactionId: string, text: string, metadata?: GMITurnInput['metadata']): GMITurnInput {
  return {
    interactionId,
    userId: 'user-1',
    sessionId: 'session-1',
    type: GMIInteractionType.TEXT,
    content: text,
    ...(metadata ? { metadata } : {}),
  };
}

function textDeltas(chunks: GMIOutputChunk[]): unknown[] {
  return chunks.filter((chunk) => chunk.type === GMIOutputChunkType.TEXT_DELTA).map((chunk) => chunk.content);
}

/** An SSE response carrying one `data:` event per payload. */
function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Answers requests with `responses` in order; an unexpected request fails the call. */
function serve(...responses: Response[]): void {
  const queue = [...responses];
  fetchMock.mockImplementation(async (url: unknown) => {
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${String(url)}`);
    return next;
  });
}

/** URL and parsed JSON body of every request, in order. */
function requests(): Array<{ url: string; body: Json }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as { body?: unknown } | undefined)?.body)) as Json,
  }));
}

function geminiChunk(parts: Json[]): Json {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
  };
}

/** Anthropic SSE events for one assistant message made of `blocks`. */
function anthropicStream(model: string, blocks: Json[], stopReason: string): Json[] {
  const events: Json[] = [{
    type: 'message_start',
    message: {
      id: `msg_${stopReason}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 1 },
    },
  }];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } });
  events.push({ type: 'message_stop' });
  return events;
}

/** Text of an Anthropic `system` field or message content, string or blocks. */
function anthropicText(content: unknown): string {
  if (typeof content === 'string') return content;
  return (content as Json[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

const scriptedChunk = { id: 'scripted', object: 'chat.completion.chunk', created: 0, modelId: 'scripted-model' };

function textReply(text: string): ModelCompletionResponse[] {
  return [
    {
      ...scriptedChunk,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: null }],
      responseTextDelta: text,
    },
    {
      ...scriptedChunk,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
      isFinal: true,
    },
  ];
}

function toolCallReply(calls: Array<{ id: string; name: string; args: Json }>): ModelCompletionResponse[] {
  return [{
    ...scriptedChunk,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
      finishReason: 'tool_calls',
    }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    isFinal: true,
  }];
}

/**
 * A provider whose model is scripted: each call records the ChatMessage[]
 * GMI passed and streams the next scripted reply.
 */
function scriptedProvider(providerId: string, replies: ModelCompletionResponse[][]) {
  const received: ChatMessage[][] = [];
  const queue = [...replies];
  const provider = {
    providerId,
    isInitialized: true,
    generateCompletionStream: vi.fn(async function* (_modelId: string, messages: ChatMessage[]) {
      received.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[]);
      const reply = queue.shift();
      if (!reply) throw new Error('unexpected model call');
      yield* reply;
    }),
  } as unknown as IProvider;
  return { provider, received };
}

/** A message reduced to what pairing and ordering depend on. */
function shape(message: ChatMessage): Json {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { calls: message.tool_calls.map((call) => call.id) } : {}),
    ...(message.tool_call_id ? { answers: message.tool_call_id } : {}),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('GMI prompts on the real providers', () => {
  it('streams a GMI turn through the real PromptEngine to GeminiProvider', async () => {
    serve(sseResponse([geminiChunk([{ text: 'Hi from Gemini' }])]));
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'gemini-prompt-format-key' });
    const { gmi } = await createGmi({ provider, modelId: 'gemini-2.5-flash' });

    const { chunks, output } = await runTurn(gmi, textTurn('turn-1', 'Hello Gemini'));

    const [request] = requests();
    expect(request.url).toContain('/models/gemini-2.5-flash:streamGenerateContent');
    expect(request.body.systemInstruction.parts[0].text).toContain(SYSTEM_PROMPT);
    // One user content: the message goes out once, not from history and again as input.
    expect(request.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello Gemini' }] }]);
    expect(textDeltas(chunks)).toEqual(['Hi from Gemini']);
    expect(output.responseText).toBe('Hi from Gemini');
    expect(gmi.getReasoningTrace().entries.filter((entry) => entry.message.startsWith('Prompt Engine Issue'))).toEqual([]);
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('replays a tool round to Gemini as functionCall and functionResponse', async () => {
    serve(
      sseResponse([geminiChunk([
        { functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-weather' },
      ])]),
      sseResponse([geminiChunk([{ text: 'Sunny and 18C in Paris.' }])]),
    );
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'gemini-tool-round-key' });
    const { gmi } = await createGmi({
      provider,
      modelId: 'gemini-2.5-flash',
      tools: [WEATHER_TOOL],
      toolOutputs: { get_weather: { temp_c: 18 } },
    });

    const { output } = await runTurn(gmi, textTurn('turn-1', 'Weather in Paris?'));

    expect(output.responseText).toBe('Sunny and 18C in Paris.');
    const [first, second] = requests();
    expect(first.body.contents).toEqual([{ role: 'user', parts: [{ text: 'Weather in Paris?' }] }]);
    expect(second.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather in Paris?' }] },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-weather' }],
      },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp_c: 18 } } }] },
    ]);
  });

  it('drives AnthropicProvider with a chat-message prompt', async () => {
    const model = 'claude-sonnet-4-20250514';
    serve(sseResponse(anthropicStream(model, [{ type: 'text', text: 'Hi from Claude' }], 'end_turn')));
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'anthropic-prompt-format-key' });
    const { gmi } = await createGmi({ provider, modelId: model });

    const { chunks } = await runTurn(gmi, textTurn('turn-1', 'Hello Claude'));

    expect(chunks.filter((chunk) => chunk.type === GMIOutputChunkType.ERROR)).toEqual([]);
    expect(textDeltas(chunks)).toEqual(['Hi from Claude']);
    const [request] = requests();
    expect(anthropicText(request.body.system)).toContain(SYSTEM_PROMPT);
    expect(request.body.messages).toHaveLength(1);
    expect(request.body.messages[0].role).toBe('user');
    expect(anthropicText(request.body.messages[0].content)).toBe('Hello Claude');
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('replays signed thinking ahead of the tool call on the next Anthropic request', async () => {
    const model = 'claude-opus-5-5';
    const thinking = {
      type: 'thinking',
      thinking: 'The user wants the weather, so call the tool.',
      signature: 'sig-think-1',
    };
    serve(
      sseResponse(anthropicStream(
        model,
        [thinking, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }],
        'tool_use',
      )),
      sseResponse(anthropicStream(model, [{ type: 'text', text: 'It is 18C in Paris.' }], 'end_turn')),
    );
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'anthropic-thinking-key' });
    const { gmi } = await createGmi({
      provider,
      modelId: model,
      tools: [WEATHER_TOOL],
      toolOutputs: { get_weather: { temp_c: 18 } },
    });

    const { output } = await runTurn(gmi, textTurn('turn-1', 'Weather in Paris?'));

    expect(output.responseText).toBe('It is 18C in Paris.');
    const messages = requests()[1].body.messages as Json[];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content).toMatchObject([
      thinking,
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(messages[2].content).toMatchObject([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp_c":18}' },
    ]);
  });
});

describe('GMI hands every provider a ChatMessage[] prompt', () => {
  it.each(['anthropic', 'gemini', 'gemini-cli'])('builds the openai_chat prompt for a %s persona', async (providerId) => {
    const { provider, received } = scriptedProvider(providerId, [textReply('Hello.')]);
    const { gmi, promptEngine } = await createGmi({ provider, modelId: `${providerId}-model` });
    const constructPrompt = vi.spyOn(promptEngine, 'constructPrompt');

    await runTurn(gmi, textTurn('turn-1', 'Hello'));

    expect(constructPrompt.mock.calls[0][1].promptFormatType).toBe('openai_chat');
    expect(received).toEqual([[
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Hello' },
    ]]);
  });

  it('fails the turn instead of calling the provider with an empty prompt', async () => {
    const { provider, received } = scriptedProvider('openai', [textReply('Never sent.')]);
    // A consumer template that throws leaves PromptEngine's prompt empty.
    const brokenTemplate: PromptTemplateFunction = async () => {
      throw new Error('template exploded');
    };
    const promptEngine = new PromptEngine();
    await promptEngine.initialize(promptEngineConfig({ availableTemplates: { openai_chat: brokenTemplate } }));
    const { gmi } = await createGmi({ provider, modelId: 'gpt-4o', promptEngine });

    const { chunks, output } = await runTurn(gmi, textTurn('turn-1', 'Hello'));

    expect(received).toEqual([]);
    const errors = chunks.filter((chunk) => chunk.type === GMIOutputChunkType.ERROR);
    expect(errors).toHaveLength(1);
    expect(String(errors[0].content)).toContain('Prompt construction produced no chat messages');
    expect(output.error?.message).toContain('Prompt construction produced no chat messages');
  });
});

describe('GMI prompt history', () => {
  it('adds the current exchange to the durable history on every call of a tool loop', async () => {
    const { provider, received } = scriptedProvider('openai', [
      toolCallReply([{ id: 'call_1', name: 'get_weather', args: { city: 'Paris' } }]),
      textReply('Sunny and 18C.'),
    ]);
    const { gmi } = await createGmi({
      provider,
      modelId: 'gpt-4o',
      tools: [WEATHER_TOOL],
      toolOutputs: { get_weather: { temp_c: 18 } },
    });
    const durableHistory = [
      createConversationMessage(MessageRole.USER, 'What is the capital of France?'),
      createConversationMessage(MessageRole.ASSISTANT, 'Paris.'),
    ];

    await runTurn(gmi, textTurn('turn-2', 'And its weather?', { conversationHistoryForPrompt: durableHistory }));

    const history = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'Paris.' },
      { role: 'user', content: 'And its weather?' },
    ];
    expect(received.map((prompt) => prompt.map(shape))).toEqual([
      history,
      [
        ...history,
        { role: 'assistant', content: null, calls: ['call_1'] },
        { role: 'tool', content: '{"temp_c":18}', answers: 'call_1' },
      ],
    ]);
  });

  it('sends multimodal input once, parts intact, with retrieved context in front', async () => {
    const { provider, received } = scriptedProvider('openai', [textReply('A camera.')]);
    const { gmi } = await createGmi({ provider, modelId: 'gpt-4o' });
    const question = { type: 'text', text: 'What is in this picture?' };
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };

    await runTurn(gmi, {
      interactionId: 'turn-1',
      userId: 'user-1',
      type: GMIInteractionType.MULTIMODAL_CONTENT,
      content: [question, image],
      metadata: { longTermMemoryContext: 'The user collects vintage cameras.' },
    });

    const userMessages = received[0].filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toEqual([
      { type: 'text', text: expect.stringContaining('The user collects vintage cameras.') },
      question,
      image,
    ]);
  });
});

describe('GMI prompt history under a token budget', () => {
  /** Host history long enough to overflow a 2000-token context window. */
  function longHistory(count: number) {
    return Array.from({ length: count }, (_, i) =>
      createConversationMessage(
        i % 2 === 0 ? MessageRole.USER : MessageRole.ASSISTANT,
        `Earlier message ${i}: ${'lorem ipsum '.repeat(40)}`,
      ),
    );
  }

  /** A PromptEngine whose utility AI summarizes history into `summary`. */
  async function summarizingEngine(summary: string) {
    const summarizeConversationHistory = vi.fn(async (messages: readonly unknown[]) => ({
      summaryMessages: [createConversationMessage(MessageRole.SUMMARY, summary)],
      originalTokenCount: 1000,
      finalTokenCount: 10,
      messagesSummarized: messages.length,
    }));
    const promptEngine = new PromptEngine();
    await promptEngine.initialize(
      promptEngineConfig(),
      { summarizeConversationHistory } as unknown as IPromptEngineUtilityAI,
    );
    return { promptEngine, summarizeConversationHistory };
  }

  it('summarizes the earlier history but sends the current multimodal message whole', async () => {
    const { promptEngine, summarizeConversationHistory } = await summarizingEngine('Earlier: the user asked about cameras.');
    const { provider, received } = scriptedProvider('openai', [textReply('A rangefinder.')]);
    const { gmi } = await createGmi({ provider, modelId: 'gpt-4o', promptEngine, contextWindowSize: 2000 });
    const question = { type: 'text', text: 'Which camera is this?' };
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };

    await runTurn(gmi, {
      interactionId: 'turn-9',
      userId: 'user-1',
      sessionId: 'session-1',
      type: GMIInteractionType.MULTIMODAL_CONTENT,
      content: [question, image],
      metadata: { conversationHistoryForPrompt: longHistory(8) },
    });

    expect(summarizeConversationHistory).toHaveBeenCalledTimes(1);
    const summarized = summarizeConversationHistory.mock.calls[0][0];
    expect(summarized).toHaveLength(8);
    expect(JSON.stringify(summarized)).not.toContain('image_url');
    const prompt = received[0];
    expect(JSON.stringify(prompt)).toContain('Earlier: the user asked about cameras.');
    expect(prompt[prompt.length - 1]).toMatchObject({ role: 'user', content: [question, image] });
  });

  it('summarizes the earlier history but keeps the turn\'s own tool round', async () => {
    const { promptEngine, summarizeConversationHistory } = await summarizingEngine('Earlier: the user asked about Paris.');
    const { provider, received } = scriptedProvider('openai', [
      toolCallReply([{ id: 'call_1', name: 'get_weather', args: { city: 'Paris' } }]),
      textReply('Sunny and 18C.'),
    ]);
    const { gmi } = await createGmi({
      provider,
      modelId: 'gpt-4o',
      tools: [WEATHER_TOOL],
      toolOutputs: { get_weather: { temp_c: 18 } },
      promptEngine,
      contextWindowSize: 2000,
    });

    await runTurn(gmi, textTurn('turn-9', 'And its weather?', { conversationHistoryForPrompt: longHistory(8) }));

    // Each call summarizes the host history and nothing from this turn.
    expect(summarizeConversationHistory).toHaveBeenCalledTimes(2);
    expect(summarizeConversationHistory.mock.calls[1][0]).toHaveLength(8);
    expect(received[1].map(shape).slice(-3)).toEqual([
      { role: 'user', content: 'And its weather?' },
      { role: 'assistant', content: null, calls: ['call_1'] },
      { role: 'tool', content: '{"temp_c":18}', answers: 'call_1' },
    ]);
  });
});
