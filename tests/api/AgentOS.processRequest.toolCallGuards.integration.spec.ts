import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentOS, type AgentOSConfig } from '../../src/api/AgentOS';
import type { AgentOSInput } from '../../src/api/types/AgentOSInput';
import {
  AgentOSResponseChunkType,
  isActionableToolCallRequestChunk,
  type AgentOSErrorChunk,
  type AgentOSFinalResponseChunk,
  type AgentOSResponse,
  type AgentOSToolCallRequestChunk,
} from '../../src/api/types/AgentOSResponse';
import { WorkflowFacade } from '../../src/api/runtime/WorkflowFacade';
import { RagMemoryInitializer } from '../../src/api/runtime/RagMemoryInitializer';
import { GMI } from '../../src/cognition/substrate/GMI.js';
import { GMIManager } from '../../src/cognition/substrate/GMIManager.js';
import type { RagRetrievedChunk } from '../../src/cognition/rag/IRetrievalAugmentor';
import { GMIOutputChunkType, GMIPrimeState, type GMIOutput, type ToolCallRequest } from '../../src/cognition/substrate/IGMI.js';
import { InMemoryWorkingMemory } from '../../src/cognition/substrate/memory/InMemoryWorkingMemory.js';
import { ConversationContext } from '../../src/core/conversation/ConversationContext';
import { MessageRole } from '../../src/core/conversation/ConversationMessage';
import { PromptEngine } from '../../src/core/llm/PromptEngine';
import type { ChatMessage, ModelCompletionResponse } from '../../src/core/llm/providers/IProvider';
import {
  GuardrailAction,
  type GuardrailEvaluationResult,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from '../../src/safety/guardrails/IGuardrailService';

/**
 * Output guards that set `config.evaluateToolCalls`, on the real path: AgentOS.initialize(), the orchestrator, the
 * tool orchestrator and a GMI, with the model stubbed at the provider.
 */

function createConfig(overrides: Partial<AgentOSConfig> = {}): AgentOSConfig {
  return {
    gmiManagerConfig: {
      personaLoaderConfig: {
        personaSource: './personas',
        loaderType: 'file_system',
        options: {},
      },
    },
    orchestratorConfig: {},
    promptEngineConfig: {},
    toolOrchestratorConfig: {},
    toolPermissionManagerConfig: {},
    conversationManagerConfig: {
      persistenceEnabled: false,
    },
    streamingManagerConfig: {},
    modelProviderManagerConfig: {
      providers: [],
    },
    defaultPersonaId: 'test-persona',
    prisma: {} as any,
    utilityAIService: {
      summarizeConversationHistory: async () => ({
        summaryMessages: [],
        originalTokenCount: 0,
        finalTokenCount: 0,
        messagesSummarized: 0,
      }),
      summarizeRAGContext: async () => ({
        summary: '',
        originalTokenCount: 0,
        finalTokenCount: 0,
        preservedSources: [],
      }),
    } as any,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<AgentOSResponse>): Promise<AgentOSResponse[]> {
  const responses: AgentOSResponse[] = [];
  for await (const chunk of stream) {
    responses.push(chunk);
  }
  return responses;
}

const SHELL_CALL: ToolCallRequest = { id: 'call-shell-1', name: 'shell_execute', arguments: { command: 'rm -rf /' } };

/** A call of read_notes, a registered tool with no side effects. */
const NOTES_CALL: ToolCallRequest = { id: 'call-notes-1', name: 'read_notes', arguments: { topic: 'disk' } };

const BLOCK_SHELL: GuardrailEvaluationResult = {
  action: GuardrailAction.BLOCK,
  reason: 'A destructive shell command',
  reasonCode: 'SHELL_DESTRUCTIVE',
};

/** A source the turn's retrieval returns, marked confidential. */
const PAYROLL_SOURCE: RagRetrievedChunk = {
  id: 'chunk-payroll-1',
  content: 'October payroll: the salaries of the team.',
  originalDocumentId: 'doc-payroll',
  metadata: { classification: 'confidential' },
};

/** A guard that evaluates tool calls and blocks a step that reads notes and runs a shell command together. */
function notesToShellGuard(): IGuardrailService {
  return {
    id: 'notes-to-shell',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      const names = new Set((chunk as AgentOSToolCallRequestChunk).toolCalls.map((call) => call.name));
      return names.has(NOTES_CALL.name) && names.has(SHELL_CALL.name)
        ? { action: GuardrailAction.BLOCK, reason: 'Notes and a shell command in one step', reasonCode: 'NOTES_TO_SHELL' }
        : null;
    },
  };
}

/** A guard that evaluates tool calls and blocks a shell command in a turn whose retrieved sources hold a confidential one. */
function confidentialSourcesGuard(): IGuardrailService {
  return {
    id: 'confidential-sources',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk, ragSources }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      const confidential = (ragSources ?? []).some((source) => source.metadata?.classification === 'confidential');
      const shell = (chunk as AgentOSToolCallRequestChunk).toolCalls.some((call) => call.name === SHELL_CALL.name);
      return confidential && shell
        ? { action: GuardrailAction.BLOCK, reason: 'A shell command in a turn that read confidential sources', reasonCode: 'CONFIDENTIAL_SOURCES' }
        : null;
    },
  };
}

/** A guard that judges each streamed delta and blocks one that reads `phrase`. */
function streamedTextGuard(phrase: string): IGuardrailService {
  return {
    id: 'streamed-text',
    config: { evaluateStreamingChunks: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TEXT_DELTA) return null;
      return String((chunk as { textDelta?: unknown }).textDelta ?? '').includes(phrase)
        ? { action: GuardrailAction.BLOCK, reason: 'The reply names a secret', reasonCode: 'SECRET_TEXT' }
        : null;
    },
  };
}

/**
 * A guard that judges tool calls when `evaluateToolCalls` is set: it records each chunk it is given and answers a
 * chunk that calls shell_execute with `verdict`.
 */
function shellGuard(
  verdict: GuardrailEvaluationResult | null,
  options: { evaluateToolCalls?: boolean; canSanitize?: boolean } = {},
): IGuardrailService & { seen: AgentOSResponse[] } {
  const seen: AgentOSResponse[] = [];
  return {
    id: 'shell-guard',
    config: {
      evaluateToolCalls: options.evaluateToolCalls ?? true,
      ...(options.canSanitize ? { canSanitize: true } : {}),
    },
    seen,
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      seen.push(chunk);
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      return (chunk as AgentOSToolCallRequestChunk).toolCalls.some((call) => call.name === 'shell_execute') ? verdict : null;
    },
  };
}

describe('AgentOS output guards that evaluate tool calls', () => {
  const openAgents: AgentOS[] = [];
  const openGmis: GMI[] = [];

  beforeEach(() => {
    vi.spyOn(WorkflowFacade.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(RagMemoryInitializer.prototype, 'initializeRag').mockResolvedValue(undefined);
    vi.spyOn(PromptEngine.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(PromptEngine.prototype, 'clearCache').mockResolvedValue(undefined);
    vi.spyOn(GMIManager.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(GMIManager.prototype, 'shutdown').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    for (const gmi of openGmis.splice(0)) {
      try {
        await gmi.shutdown();
      } catch {
        // best effort cleanup
      }
    }
    for (const agent of openAgents.splice(0)) {
      try {
        await agent.shutdown();
      } catch {
        // best effort cleanup
      }
    }
    vi.restoreAllMocks();
  });

  describe('on a call the runtime runs itself', () => {
    /**
     * A runtime with shell_execute and read_notes registered and `guard` as its output guard, and a GMI on a stub
     * provider: the first model call asks for the calls of `firstStep` (SHELL_CALL unless given), the second answers in
     * text. With `sources`, the persona retrieves on the user's query and the turn's retrieval returns them. Each model
     * call's messages are kept.
     */
    async function runtimeWithShellTool(
      guard: IGuardrailService,
      options: { firstStep?: ToolCallRequest[]; sources?: RagRetrievedChunk[] } = {},
    ) {
      const firstStep = options.firstStep ?? [SHELL_CALL];
      const conversationContext = new ConversationContext('conv-shell');
      const promptCalls: ChatMessage[][] = [];
      let providerCallCount = 0;

      const provider = {
        providerId: 'mock-provider',
        isInitialized: true,
        generateCompletionStream: vi.fn(async function* (
          _modelId: string,
          messages: ChatMessage[],
        ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
          promptCalls.push(messages);
          providerCallCount += 1;

          if (providerCallCount === 1) {
            yield {
              id: 'cmp-shell-request',
              object: 'chat.completion.chunk',
              created: Date.now(),
              modelId: 'mock-model',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: firstStep.map((call) => ({
                      id: call.id,
                      type: 'function' as const,
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    })),
                  },
                  finishReason: 'tool_calls',
                },
              ],
              usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
              isFinal: true,
            };
            return;
          }

          yield {
            id: 'cmp-shell-final',
            object: 'chat.completion.chunk',
            created: Date.now(),
            modelId: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'The command did not run.' }, finishReason: null }],
            responseTextDelta: 'The command did not run.',
            isFinal: false,
          };
          yield {
            id: 'cmp-shell-final',
            object: 'chat.completion.chunk',
            created: Date.now(),
            modelId: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'The command did not run.' }, finishReason: 'stop' }],
            usage: { promptTokens: 18, completionTokens: 6, totalTokens: 24 },
            isFinal: true,
          };
        }),
      } as any;

      const promptEngine = {
        constructPrompt: vi.fn(async (components: any) => {
          const prompt: ChatMessage[] = (components.conversationHistory ?? []).map((message: any) => ({
            role:
              message.role === 'assistant'
                ? 'assistant'
                : message.role === 'tool'
                  ? 'tool'
                  : message.role === 'system'
                    ? 'system'
                    : 'user',
            content:
              typeof message.content === 'string' || message.content === null
                ? message.content
                : JSON.stringify(message.content),
            name: message.name,
            tool_call_id: message.tool_call_id,
            tool_calls: Array.isArray(message.tool_calls)
              ? message.tool_calls.map((toolCall: any) => ({
                  id: toolCall.id,
                  type: 'function' as const,
                  function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments ?? {}) },
                }))
              : undefined,
          }));
          if (components.userInput) {
            prompt.push({ role: 'user', content: components.userInput });
          }
          return { prompt, formattedToolSchemas: [], estimatedTokenCount: 12, tokenCount: 12, issues: [] };
        }),
      } as any;

      const execute = vi.fn(async () => ({ success: true, output: { exitCode: 0 } }));
      const readNotes = vi.fn(async () => ({ success: true, output: { notes: ['The disk is full.'] } }));

      const agentos = new AgentOS();
      openAgents.push(agentos);
      await agentos.initialize(
        createConfig({
          guardrailService: guard,
          tools: new Map([
            [
              'shell_execute',
              {
                description: 'Run a shell command on the host.',
                inputSchema: {
                  type: 'object',
                  properties: { command: { type: 'string' } },
                  required: ['command'],
                },
                execute,
              },
            ],
            [
              'read_notes',
              {
                description: 'Read the notes of the user on a topic.',
                inputSchema: {
                  type: 'object',
                  properties: { topic: { type: 'string' } },
                  required: ['topic'],
                },
                execute: readNotes,
              },
            ],
          ]),
        }),
      );
      const sources = options.sources;
      const retrievalAugmentor = sources
        ? {
            augmenterId: 'stub-retrieval',
            retrieveContext: vi.fn(async (queryText: string) => ({
              queryText,
              retrievedChunks: sources,
              augmentedContext: sources.map((source) => source.content).join('\n'),
            })),
          }
        : undefined;

      const gmi = new GMI('gmi-shell-tool');
      openGmis.push(gmi);
      await gmi.initialize(
        {
          id: 'test-persona',
          name: 'Test Persona',
          version: '1.0.0',
          baseSystemPrompt: 'You run commands for the user.',
          defaultModelId: 'mock-model',
          defaultProviderId: 'mock-provider',
          defaultModelCompletionOptions: { temperature: 0.1 },
          allowedCapabilities: [],
          memoryConfig: sources
            ? { enabled: false, ragConfig: { enabled: true, retrievalTriggers: { onUserQuery: true } } }
            : { enabled: false, ragConfig: { enabled: false } },
          moodAdaptation: { enabled: false, defaultMood: 'neutral' },
          toolIds: [],
          allowedInputModalities: ['text'],
          allowedOutputModalities: ['text'],
          conversationContextConfig: { maxMessages: 10 },
          minSubscriptionTier: 'FREE',
          isPublic: true,
          activationKeywords: [],
          strengths: [],
          uiInteractionStyle: 'collaborative',
          initialMemoryImprints: [],
        } as any,
        {
          workingMemory: new InMemoryWorkingMemory(),
          ...(retrievalAugmentor ? { retrievalAugmentor: retrievalAugmentor as any } : {}),
          promptEngine,
          llmProviderManager: {
            getModelInfo: vi.fn().mockResolvedValue({
              modelId: 'mock-model',
              providerId: 'mock-provider',
              contextWindowSize: 8192,
              capabilities: ['chat', 'tool_use'],
              supportsStreaming: true,
            }),
            getProvider: vi.fn().mockReturnValue(provider),
            getProviderForModel: vi.fn().mockReturnValue({ providerId: 'mock-provider' }),
          } as any,
          utilityAI: { summarize: vi.fn(), parseJsonSafe: vi.fn() } as any,
          toolOrchestrator: agentos.getToolOrchestrator(),
          defaultLlmModelId: 'mock-model',
          defaultLlmProviderId: 'mock-provider',
        },
      );

      vi.spyOn(GMIManager.prototype, 'getOrCreateGMIForSession').mockResolvedValue({
        gmi,
        conversationContext,
      } as any);

      const input: AgentOSInput = {
        userId: 'user-1',
        sessionId: 'session-shell',
        conversationId: 'conv-shell',
        textInput: 'Clear the disk.',
        selectedPersonaId: 'test-persona',
      };

      return { agentos, gmi, provider, promptCalls, execute, readNotes, input };
    }

    it.each([
      ['a block', BLOCK_SHELL, false],
      [
        'a sanitize, applied as a block,',
        { action: GuardrailAction.SANITIZE, modifiedText: '{}', reason: 'A destructive shell command', reasonCode: 'SHELL_DESTRUCTIVE' },
        true,
      ],
    ] as Array<[string, GuardrailEvaluationResult, boolean]>)(
      '%s refuses the call before it runs: the tool is never called and the model reads the refusal',
      async (_label, verdict, canSanitize) => {
        const { agentos, gmi, provider, promptCalls, execute, input } = await runtimeWithShellTool(shellGuard(verdict, { canSanitize }));

        const responses = await collect(agentos.processRequest(input));

        // the stream still ends with the guard's verdict on the call's chunk
        const last = responses.at(-1) as AgentOSErrorChunk;
        expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
        expect(last.code).toBe('SHELL_DESTRUCTIVE');

        // the turn goes on inside the runtime: the model is called again with the call's result
        await vi.waitFor(() => expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY));

        expect(execute).not.toHaveBeenCalled();
        const results = promptCalls[1]?.filter((message) => message.role === 'tool') ?? [];
        expect(results).toHaveLength(1);
        expect(results[0]?.tool_call_id).toBe(SHELL_CALL.id);
        expect(String(results[0]?.content)).toContain('AUTH_PERMISSION_DENIED');
        expect(String(results[0]?.content)).toContain('A destructive shell command');
      },
    );

    it('a call the guard allows runs, and the turn answers', async () => {
      const guard = shellGuard({ action: GuardrailAction.FLAG, reason: 'a shell command', reasonCode: 'SHELL' });
      const { agentos, provider, execute, input } = await runtimeWithShellTool(guard);

      const responses = await collect(agentos.processRequest(input));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toEqual(SHELL_CALL.arguments);
      expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2);
      const final = responses.find((r): r is AgentOSFinalResponseChunk => r.type === AgentOSResponseChunkType.FINAL_RESPONSE);
      expect(final?.finalResponseText).toContain('The command did not run.');
      const request = responses.find((r): r is AgentOSToolCallRequestChunk => r.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST);
      expect(request?.metadata?.guardrail?.output?.[0]).toMatchObject({ action: GuardrailAction.FLAG, reasonCode: 'SHELL' });
    });

    it('a guard without the flag is never asked about the call, and the call runs as before', async () => {
      const guard = shellGuard(BLOCK_SHELL, { evaluateToolCalls: false });
      const { agentos, execute, input } = await runtimeWithShellTool(guard);

      const responses = await collect(agentos.processRequest(input));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(guard.seen.some((chunk) => chunk.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST)).toBe(false);
      const final = responses.find((r): r is AgentOSFinalResponseChunk => r.type === AgentOSResponseChunkType.FINAL_RESPONSE);
      expect(final?.finalResponseText).toContain('The command did not run.');
    });

    it('a guard that blocks the calls of one step together refuses every call of the step before any runs', async () => {
      const { agentos, gmi, provider, promptCalls, execute, readNotes, input } = await runtimeWithShellTool(notesToShellGuard(), {
        firstStep: [NOTES_CALL, SHELL_CALL],
      });

      const responses = await collect(agentos.processRequest(input));

      // the stream carries both calls in one chunk, and the guard blocks that chunk too
      const last = responses.at(-1) as AgentOSErrorChunk;
      expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(last.code).toBe('NOTES_TO_SHELL');

      await vi.waitFor(() => expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY));

      expect(readNotes).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const results = promptCalls[1]?.filter((message) => message.role === 'tool') ?? [];
      expect(results.map((message) => message.tool_call_id)).toEqual([NOTES_CALL.id, SHELL_CALL.id]);
      for (const result of results) {
        expect(String(result.content)).toContain('AUTH_PERMISSION_DENIED');
        expect(String(result.content)).toContain('Notes and a shell command in one step');
      }
    });

    it('a guard reads the sources the turn retrieved when it judges a call before it runs', async () => {
      const { agentos, gmi, provider, promptCalls, execute, input } = await runtimeWithShellTool(confidentialSourcesGuard(), {
        sources: [PAYROLL_SOURCE],
      });

      const responses = await collect(agentos.processRequest(input));

      // the stream's chunk for the call follows the sources, and the guard blocks it there too
      const last = responses.at(-1) as AgentOSErrorChunk;
      expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(last.code).toBe('CONFIDENTIAL_SOURCES');

      await vi.waitFor(() => expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY));

      expect(execute).not.toHaveBeenCalled();
      const results = promptCalls[1]?.filter((message) => message.role === 'tool') ?? [];
      expect(results).toHaveLength(1);
      expect(results[0]?.tool_call_id).toBe(SHELL_CALL.id);
      expect(String(results[0]?.content)).toContain('A shell command in a turn that read confidential sources');
    });
  });

  describe('on a call the host executes', () => {
    const READ_CALL = { id: 'call-read-1', name: 'read_file', arguments: { path: 'notes.txt' } };

    /**
     * A GMI that stops its turn for `firstCall`, streaming the call before it returns as a host-tool GMI does; a tool
     * result continues it to `continuation`. The chunks of `before` stream ahead of the call.
     */
    function pausingGmi(
      firstCall: { id: string; name: string; arguments: Record<string, unknown> },
      continuation: GMIOutput = { isFinal: true, responseText: 'Done.' },
      before: Array<{ type: GMIOutputChunkType; content: unknown; metadata?: Record<string, unknown> }> = [],
    ) {
      return {
        getCurrentPrimaryPersonaId: () => 'test-persona',
        getGMIId: () => 'gmi-host-tools',
        getPersona: () => ({ id: 'test-persona', name: 'Test Persona', version: '1.0.0', baseSystemPrompt: 'You run commands for the user.' }),
        processTurnStream: async function* (): AsyncGenerator<any, GMIOutput, undefined> {
          for (const chunk of before) {
            yield { ...chunk, interactionId: 'interaction-host-tools', timestamp: new Date() };
          }
          yield {
            type: GMIOutputChunkType.TOOL_CALL_REQUEST,
            content: [firstCall],
            interactionId: 'interaction-host-tools',
            timestamp: new Date(),
            metadata: { executionMode: 'external', requiresExternalToolResult: true },
          };
          return { isFinal: false, responseText: 'I need a tool first.', toolCalls: [firstCall] };
        },
        hydrateConversationHistory: vi.fn(),
        handleToolResult: vi.fn(async (): Promise<GMIOutput> => continuation),
      };
    }

    /** A runtime whose turns run on `gmi` over the conversation `conversationId`, with `guard` as its output guard. */
    async function runtimeWithHostTools(gmi: ReturnType<typeof pausingGmi>, conversationId: string, guard: IGuardrailService) {
      const context = new ConversationContext(conversationId);
      context.setMetadata('userId', 'user-1');
      vi.spyOn(GMIManager.prototype, 'getOrCreateGMIForSession').mockResolvedValue({ gmi, conversationContext: context } as any);

      const agentos = new AgentOS();
      openAgents.push(agentos);
      await agentos.initialize(createConfig({ guardrailService: guard }));
      vi.spyOn(agentos.getConversationManager(), 'getConversation').mockImplementation(async (id: string) =>
        id === conversationId ? (context as any) : null,
      );

      const input: AgentOSInput = {
        userId: 'user-1',
        sessionId: `session-${conversationId}`,
        conversationId,
        textInput: 'Tidy my files.',
        selectedPersonaId: 'test-persona',
      };
      return { agentos, context, input };
    }

    /** The assistant message a saved pause adds for `callId`. A turn saves its pause after it streams the call. */
    const pauseMessageFor = (context: ConversationContext, callId: string) =>
      context
        .getAllMessages()
        .find((m) => m.role === MessageRole.ASSISTANT && Array.isArray(m.tool_calls) && m.tool_calls.some((c: any) => c.id === callId));

    /** The tool message that answers `callId` in the conversation. */
    const resultFor = (context: ConversationContext, callId: string) =>
      context.getAllMessages().find((m) => m.role === MessageRole.TOOL && m.tool_call_id === callId);

    it('a block on the call a turn stops for drops the saved pause, and the history answers the call with a refusal', async () => {
      const gmi = pausingGmi(SHELL_CALL);
      const { agentos, context, input } = await runtimeWithHostTools(gmi, 'conv-turn-block', shellGuard(BLOCK_SHELL));

      const responses = await collect(agentos.processRequest(input));

      expect(responses.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
      const last = responses.at(-1) as AgentOSErrorChunk;
      expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(last.code).toBe('SHELL_DESTRUCTIVE');
      await vi.waitFor(() => expect(pauseMessageFor(context, SHELL_CALL.id)).toBeDefined());

      expect(await agentos.getPendingExternalToolRequest('conv-turn-block', 'user-1')).toBeNull();
      const refusal = resultFor(context, SHELL_CALL.id);
      expect(String(refusal?.content)).toContain('AUTH_PERMISSION_DENIED');
      expect(String(refusal?.content)).toContain('SHELL_DESTRUCTIVE');

      // the stream the call was blocked on is closed: the blocked call cannot be resumed on it
      const resumed = await collect(agentos.handleToolResult(last.streamId, SHELL_CALL.id, SHELL_CALL.name, { exitCode: 0 }, true));
      expect(resumed.map((r) => r.type)).toEqual([AgentOSResponseChunkType.ERROR]);
      expect(gmi.handleToolResult).not.toHaveBeenCalled();
    });

    it('a block whose refusal the store fails to save still closes the stream, so the call cannot be continued on it', async () => {
      const gmi = pausingGmi(SHELL_CALL);
      const { agentos, context, input } = await runtimeWithHostTools(gmi, 'conv-refusal-unsaved', shellGuard(BLOCK_SHELL));
      // the store takes the turn's saves and refuses the save that records the refusal, as it does during an outage
      let refusedSaves = 0;
      vi.spyOn(agentos.getConversationManager(), 'saveConversation').mockImplementation(async (saved: ConversationContext) => {
        if (saved.getAllMessages().some((m) => m.metadata?.source === 'agentos_tool_call_refused')) {
          refusedSaves += 1;
          throw new Error('The conversation store is unavailable.');
        }
      });

      const responses = await collect(agentos.processRequest(input));

      const last = responses.at(-1) as AgentOSErrorChunk;
      expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(last.code).toBe('SHELL_DESTRUCTIVE');
      // the verdict reaches the host after the pause is dropped, so the store has refused that save by now
      expect(refusedSaves).toBe(1);
      expect(await agentos.getPendingExternalToolRequest('conv-refusal-unsaved', 'user-1')).toBeNull();
      expect(String(resultFor(context, SHELL_CALL.id)?.content)).toContain('AUTH_PERMISSION_DENIED');

      // the stream is closed all the same: the blocked call cannot be continued on it
      const resumed = await collect(agentos.handleToolResult(last.streamId, SHELL_CALL.id, SHELL_CALL.name, { exitCode: 0 }, true));
      expect(resumed.map((r) => r.type)).toEqual([AgentOSResponseChunkType.ERROR]);
      expect(gmi.handleToolResult).not.toHaveBeenCalled();
    });

    it('a block on the call a continuation stops for drops that pause too', async () => {
      const gmi = pausingGmi(READ_CALL, { isFinal: false, responseText: 'Now a command.', toolCalls: [SHELL_CALL] });
      const { agentos, context, input } = await runtimeWithHostTools(gmi, 'conv-continuation-block', shellGuard(BLOCK_SHELL));

      const first = await collect(agentos.processRequest(input));
      const request = first.find((r) => isActionableToolCallRequestChunk(r)) as AgentOSToolCallRequestChunk | undefined;
      expect(request?.toolCalls.map((call) => call.id)).toEqual([READ_CALL.id]);
      await vi.waitFor(() => expect(pauseMessageFor(context, READ_CALL.id)).toBeDefined());

      const continuation = await collect(agentos.handleToolResult(request!.streamId, READ_CALL.id, READ_CALL.name, 'notes', true));

      expect(continuation.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
      expect((continuation.at(-1) as AgentOSErrorChunk).code).toBe('SHELL_DESTRUCTIVE');
      expect(await agentos.getPendingExternalToolRequest('conv-continuation-block', 'user-1')).toBeNull();
      expect(String(resultFor(context, SHELL_CALL.id)?.content)).toContain('AUTH_PERMISSION_DENIED');
    });

    it('a block on the call a resumed pause stops for drops that pause too', async () => {
      const gmi = pausingGmi(READ_CALL, { isFinal: false, responseText: 'Now a command.', toolCalls: [SHELL_CALL] });
      const { agentos, context, input } = await runtimeWithHostTools(gmi, 'conv-resume-block', shellGuard(BLOCK_SHELL));

      await collect(agentos.processRequest(input));
      await vi.waitFor(() => expect(pauseMessageFor(context, READ_CALL.id)).toBeDefined());
      const pending = await agentos.getPendingExternalToolRequest('conv-resume-block', 'user-1');
      expect(pending?.toolCalls.map((call) => call.id)).toEqual([READ_CALL.id]);

      const resumed = await collect(
        agentos.resumeExternalToolRequest(pending!, [
          { toolCallId: READ_CALL.id, toolName: READ_CALL.name, toolOutput: 'notes', isSuccess: true },
        ]),
      );

      expect(resumed.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
      expect((resumed.at(-1) as AgentOSErrorChunk).code).toBe('SHELL_DESTRUCTIVE');
      expect(await agentos.getPendingExternalToolRequest('conv-resume-block', 'user-1')).toBeNull();
      expect(String(resultFor(context, SHELL_CALL.id)?.content)).toContain('AUTH_PERMISSION_DENIED');
    });

    it.each([
      [
        'a streamed delta',
        streamedTextGuard('the vault code'),
        [{ type: GMIOutputChunkType.TEXT_DELTA, content: 'Here is the vault code. ' }],
        'SECRET_TEXT',
      ],
      [
        'the chunk of a call the runtime runs itself',
        shellGuard(BLOCK_SHELL),
        [
          {
            type: GMIOutputChunkType.TOOL_CALL_REQUEST,
            content: [SHELL_CALL],
            metadata: { executionMode: 'internal', requiresExternalToolResult: false },
          },
        ],
        'SHELL_DESTRUCTIVE',
      ],
    ] as Array<[string, IGuardrailService, Array<{ type: GMIOutputChunkType; content: unknown; metadata?: Record<string, unknown> }>, string]>)(
      'a block on %s, which withholds no call, drops the pause the turn saves after it',
      async (_label, guard, before, reasonCode) => {
        const conversationId = `conv-later-pause-${reasonCode.toLowerCase()}`;
        const gmi = pausingGmi(READ_CALL, undefined, before);
        const { agentos, context, input } = await runtimeWithHostTools(gmi, conversationId, guard);

        const responses = await collect(agentos.processRequest(input));

        expect(responses.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
        const last = responses.at(-1) as AgentOSErrorChunk;
        expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
        expect(last.code).toBe(reasonCode);

        // the turn goes on inside the runtime and stops for the call; the pause it saves is dropped when the turn ends
        await vi.waitFor(() => expect(resultFor(context, READ_CALL.id)).toBeDefined());
        expect(pauseMessageFor(context, READ_CALL.id)).toBeDefined();
        expect(await agentos.getPendingExternalToolRequest(conversationId, 'user-1')).toBeNull();
        expect(String(resultFor(context, READ_CALL.id)?.content)).toContain('AUTH_PERMISSION_DENIED');
        expect(String(resultFor(context, READ_CALL.id)?.content)).toContain(reasonCode);

        // the stream is closed: the call cannot be continued on it
        const continued = await collect(agentos.handleToolResult(last.streamId, READ_CALL.id, READ_CALL.name, 'notes', true));
        expect(continued.map((r) => r.type)).toEqual([AgentOSResponseChunkType.ERROR]);
        expect(gmi.handleToolResult).not.toHaveBeenCalled();
      },
    );

    it('a resume of a pause the conversation no longer holds is refused, and the GMI does not take its results', async () => {
      const gmi = pausingGmi(READ_CALL);
      const { agentos, context, input } = await runtimeWithHostTools(gmi, 'conv-stale-pause', shellGuard(BLOCK_SHELL));

      const first = await collect(agentos.processRequest(input));
      const request = first.find((r) => isActionableToolCallRequestChunk(r)) as AgentOSToolCallRequestChunk | undefined;
      expect(request?.toolCalls).toEqual([READ_CALL]);
      await vi.waitFor(() => expect(pauseMessageFor(context, READ_CALL.id)).toBeDefined());
      const pending = await agentos.getPendingExternalToolRequest('conv-stale-pause', 'user-1');
      expect(pending?.toolCalls).toEqual([READ_CALL]);

      // the host answers the call on the stream: the turn ends and the conversation holds no pause
      const answered = await collect(agentos.handleToolResult(request!.streamId, READ_CALL.id, READ_CALL.name, 'notes', true));
      expect(answered.at(-1)?.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
      expect(gmi.handleToolResult).toHaveBeenCalledTimes(1);
      expect(await agentos.getPendingExternalToolRequest('conv-stale-pause', 'user-1')).toBeNull();
      const messagesAfterAnswer = context.getAllMessages().length;

      // the snapshot the host read before is stale: resuming it is refused
      const resumed = await collect(
        agentos.resumeExternalToolRequest(pending!, [
          { toolCallId: READ_CALL.id, toolName: READ_CALL.name, toolOutput: 'notes', isSuccess: true },
        ]),
      );

      expect(resumed.some((r) => r.type === AgentOSResponseChunkType.ERROR)).toBe(true);
      expect(resumed.some((r) => r.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(false);
      expect(gmi.handleToolResult).toHaveBeenCalledTimes(1);
      expect(context.getAllMessages()).toHaveLength(messagesAfterAnswer);
    });

    it('a call the guard allows still pauses as before: the host receives it and the pause is saved', async () => {
      const gmi = pausingGmi(READ_CALL);
      const { agentos, context, input } = await runtimeWithHostTools(gmi, 'conv-allowed', shellGuard(BLOCK_SHELL));

      const responses = await collect(agentos.processRequest(input));

      const request = responses.find((r) => isActionableToolCallRequestChunk(r)) as AgentOSToolCallRequestChunk | undefined;
      expect(request?.toolCalls).toEqual([READ_CALL]);
      await vi.waitFor(() => expect(pauseMessageFor(context, READ_CALL.id)).toBeDefined());
      const pending = await agentos.getPendingExternalToolRequest('conv-allowed', 'user-1');
      expect(pending?.streamId).toBe(request?.streamId);
      expect(pending?.toolCalls).toEqual([READ_CALL]);
      expect(resultFor(context, READ_CALL.id)).toBeUndefined();
    });
  });
});
