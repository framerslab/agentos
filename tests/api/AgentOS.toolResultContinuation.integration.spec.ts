import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentOS, type AgentOSConfig } from '../../src/api/AgentOS';
import type { AgentOSInput } from '../../src/api/types/AgentOSInput';
import { AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY } from '../../src/api/types/AgentOSExternalToolRequest';
import {
  AgentOSResponseChunkType,
  isActionableToolCallRequestChunk,
  type AgentOSFinalResponseChunk,
  type AgentOSResponse,
  type AgentOSToolCallRequestChunk,
} from '../../src/api/types/AgentOSResponse';
import { WorkflowFacade } from '../../src/api/runtime/WorkflowFacade';
import { RagMemoryInitializer } from '../../src/api/runtime/RagMemoryInitializer';
import { GMI } from '../../src/cognition/substrate/GMI.js';
import { GMIManager } from '../../src/cognition/substrate/GMIManager.js';
import { GMIOutputChunkType, type GMIOutput, type ToolCallRequest } from '../../src/cognition/substrate/IGMI.js';
import { InMemoryWorkingMemory } from '../../src/cognition/substrate/memory/InMemoryWorkingMemory.js';
import { ConversationContext } from '../../src/core/conversation/ConversationContext';
import { PromptEngine } from '../../src/core/llm/PromptEngine';
import type { ChatMessage, ModelCompletionResponse } from '../../src/core/llm/providers/IProvider';
import {
  GuardrailAction,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from '../../src/safety/guardrails/IGuardrailService';

/**
 * Tool-result continuations on the real path: AgentOS.initialize(), the orchestrator, its tool-result handler, the
 * tool orchestrator and the shipped GMI, with the model stubbed at the provider. The host's turn stops for READ_CALL,
 * a call the host runs; the shipped GMI runs the turn the host resumes with its result.
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

/** The call the host's turn stops for: the host runs it and passes back its result. */
const READ_CALL: ToolCallRequest = { id: 'call-read-1', name: 'read_file', arguments: { path: 'notes.txt' } };

/** A call of a tool registered with the runtime: the GMI runs it itself. */
const LOOKUP_CALL: ToolCallRequest = { id: 'call-lookup-1', name: 'lookup_notes', arguments: { query: 'standup' } };

/** A call of a registered tool that the shell guard refuses. */
const SHELL_CALL: ToolCallRequest = { id: 'call-shell-1', name: 'shell_execute', arguments: { command: 'rm -rf /' } };

/**
 * An output guard that evaluates tool calls and blocks a TOOL_CALL_REQUEST chunk that calls shell_execute: any such
 * chunk, or, with `internalOnly`, only the chunk for a call the runtime runs itself (`executionMode: 'internal'`).
 */
function shellGuard(internalOnly: boolean): IGuardrailService {
  return {
    id: 'shell-guard',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      const request = chunk as AgentOSToolCallRequestChunk;
      if (internalOnly && request.executionMode !== 'internal') return null;
      return request.toolCalls.some((call) => call.name === SHELL_CALL.name)
        ? { action: GuardrailAction.BLOCK, reason: 'A destructive shell command', reasonCode: 'SHELL_DESTRUCTIVE' }
        : null;
    },
  };
}

const PERSONA = {
  id: 'test-persona',
  name: 'Test Persona',
  version: '1.0.0',
  baseSystemPrompt: 'You keep notes for the user.',
  defaultModelId: 'mock-model',
  defaultProviderId: 'mock-provider',
  defaultModelCompletionOptions: { temperature: 0.1 },
  allowedCapabilities: [],
  memoryConfig: { enabled: false, ragConfig: { enabled: false } },
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
};

/** One model reply: the tool calls of a step, or the text that answers. */
type ModelReply = { toolCalls: ToolCallRequest[] } | { text: string };

/** A provider whose n-th model call gives the n-th reply. It keeps the messages of each call. */
function scriptedProvider(replies: ModelReply[]) {
  const promptCalls: ChatMessage[][] = [];
  const provider = {
    providerId: 'mock-provider',
    isInitialized: true,
    generateCompletionStream: vi.fn(async function* (
      _modelId: string,
      messages: ChatMessage[],
    ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
      promptCalls.push(messages);
      const reply = replies[promptCalls.length - 1];
      if (!reply) {
        throw new Error(`The model was called ${promptCalls.length} times; the test scripted ${replies.length} replies.`);
      }
      const id = `cmp-${promptCalls.length}`;

      if ('toolCalls' in reply) {
        yield {
          id,
          object: 'chat.completion.chunk',
          created: Date.now(),
          modelId: 'mock-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: reply.toolCalls.map((call) => ({
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
        id,
        object: 'chat.completion.chunk',
        created: Date.now(),
        modelId: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finishReason: null }],
        responseTextDelta: reply.text,
        isFinal: false,
      };
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Date.now(),
        modelId: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finishReason: 'stop' }],
        usage: { promptTokens: 18, completionTokens: 6, totalTokens: 24 },
        isFinal: true,
      };
    }),
  } as any;
  return { provider, promptCalls };
}

/** A prompt engine that sends the GMI's history as it stands. */
function historyPromptEngine() {
  return {
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
              function: {
                name: toolCall.function?.name ?? toolCall.name,
                arguments:
                  typeof toolCall.function?.arguments === 'string'
                    ? toolCall.function.arguments
                    : JSON.stringify(toolCall.arguments ?? {}),
              },
            }))
          : undefined,
      }));
      if (components.userInput) {
        prompt.push({ role: 'user', content: components.userInput });
      }
      return { prompt, formattedToolSchemas: [], estimatedTokenCount: 12, tokenCount: 12, issues: [] };
    }),
  } as any;
}

/**
 * A GMI that stops the user's turn for READ_CALL, streaming the call before it returns, as a GMI that leaves tools to
 * the host does; the tool result continues it to `continuation`.
 */
function hostToolGmi(continuation: GMIOutput = { isFinal: true, responseText: 'Done.' }) {
  return {
    getCurrentPrimaryPersonaId: () => 'test-persona',
    getGMIId: () => 'gmi-host-tools',
    getPersona: () => PERSONA,
    processTurnStream: async function* (): AsyncGenerator<any, GMIOutput, undefined> {
      yield {
        type: GMIOutputChunkType.TOOL_CALL_REQUEST,
        content: [READ_CALL],
        interactionId: 'interaction-host-tools',
        timestamp: new Date(),
        metadata: { executionMode: 'external', requiresExternalToolResult: true },
      };
      return { isFinal: false, responseText: 'I need the notes file first.', toolCalls: [READ_CALL] };
    },
    hydrateConversationHistory: vi.fn(),
    handleToolResult: vi.fn(async (): Promise<GMIOutput> => continuation),
  };
}

describe('AgentOS tool-result continuations', () => {
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

  /**
   * A runtime with lookup_notes and shell_execute registered, over the conversation `conversationId`. The session's
   * GMI is the one the test sets with `useGmi()`, as the GMI manager hands a session the GMI it holds or builds for it.
   */
  async function runtime(conversationId: string, overrides: Partial<AgentOSConfig> = {}) {
    const context = new ConversationContext(conversationId);
    context.setMetadata('userId', 'user-1');
    let sessionGmi: unknown;
    vi.spyOn(GMIManager.prototype, 'getOrCreateGMIForSession').mockImplementation(
      async () => ({ gmi: sessionGmi, conversationContext: context }) as any,
    );

    const lookup = vi.fn(async () => ({ success: true, output: { notes: ['Standup moved to 10:00.'] } }));
    const shell = vi.fn(async () => ({ success: true, output: { exitCode: 0 } }));
    const agentos = new AgentOS();
    openAgents.push(agentos);
    await agentos.initialize(
      createConfig({
        tools: new Map([
          [
            'lookup_notes',
            {
              description: 'Search the notes of the user.',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
              execute: lookup,
            },
          ],
          [
            'shell_execute',
            {
              description: 'Run a shell command on the host.',
              inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
              execute: shell,
            },
          ],
        ]),
        ...overrides,
      }),
    );
    vi.spyOn(agentos.getConversationManager(), 'getConversation').mockImplementation(async (id: string) =>
      id === conversationId ? (context as any) : null,
    );

    /** The shipped GMI on a provider that gives `replies`, with the runtime's tool orchestrator. */
    async function shippedGmi(replies: ModelReply[]) {
      const { provider, promptCalls } = scriptedProvider(replies);
      const gmi = new GMI(`gmi-shipped-${conversationId}`);
      openGmis.push(gmi);
      await gmi.initialize(PERSONA as any, {
        workingMemory: new InMemoryWorkingMemory(),
        promptEngine: historyPromptEngine(),
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
      });
      return { gmi, provider, promptCalls };
    }

    const input: AgentOSInput = {
      userId: 'user-1',
      sessionId: `session-${conversationId}`,
      conversationId,
      textInput: 'What do my notes say about the standup?',
      selectedPersonaId: 'test-persona',
    };

    /** The pause the conversation holds, as a host reads it. */
    const pending = () => agentos.getPendingExternalToolRequest(conversationId, 'user-1');

    /**
     * Runs the user's turn on the host's GMI and waits for the pause it saves for READ_CALL: a turn saves its pause
     * after it streams the call.
     */
    async function pauseOnRead(host: ReturnType<typeof hostToolGmi>) {
      sessionGmi = host;
      const responses = await collect(agentos.processRequest(input));
      const request = responses.find((r) => isActionableToolCallRequestChunk(r));
      expect(request?.toolCalls).toEqual([READ_CALL]);
      await vi.waitFor(() => expect(context.getMetadata(AGENTOS_PENDING_EXTERNAL_TOOL_REQUEST_METADATA_KEY)).toBeDefined());
      const saved = await pending();
      expect(saved?.toolCalls).toEqual([READ_CALL]);
      return { request: request!, saved: saved! };
    }

    return {
      agentos,
      context,
      input,
      lookup,
      shell,
      pending,
      pauseOnRead,
      shippedGmi,
      useGmi: (gmi: unknown) => {
        sessionGmi = gmi;
      },
    };
  }

  /** The tool result the host passes back for READ_CALL. */
  const READ_RESULT = {
    toolCallId: READ_CALL.id,
    toolName: READ_CALL.name,
    toolOutput: 'Standup: see the team notes.',
    isSuccess: true,
  };

  it('a resumed turn whose model uses a tool the GMI runs itself ends with FINAL_RESPONSE and leaves no pause', async () => {
    const rt = await runtime('conv-internal-tool');
    const { saved } = await rt.pauseOnRead(hostToolGmi());

    // the host resumes the saved pause on a runtime whose session GMI is the shipped one
    const { gmi, provider } = await rt.shippedGmi([{ toolCalls: [LOOKUP_CALL] }, { text: 'Standup moved to 10:00.' }]);
    rt.useGmi(gmi);
    const resumed = await collect(rt.agentos.resumeExternalToolRequest(saved, [READ_RESULT]));

    // the GMI ran lookup_notes itself, once, and answered
    expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2);
    expect(rt.lookup).toHaveBeenCalledTimes(1);

    const last = resumed.at(-1) as AgentOSFinalResponseChunk;
    expect(last.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(last.finalResponseText).toBe('Standup moved to 10:00.');
    expect(last.finalToolCalls).toEqual([LOOKUP_CALL]);
    expect(resumed.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
    expect(await rt.pending()).toBeNull();
  });

  it('a continuation that asks the host for a new call stops for exactly that call', async () => {
    const writeCall: ToolCallRequest = { id: 'call-write-1', name: 'write_file', arguments: { path: 'notes.txt' } };
    const host = hostToolGmi({ isFinal: false, responseText: 'Now I write the file.', toolCalls: [writeCall] });
    const rt = await runtime('conv-next-external');
    const { request } = await rt.pauseOnRead(host);

    const continuation = await collect(
      rt.agentos.handleToolResult(request.streamId, READ_CALL.id, READ_CALL.name, READ_RESULT.toolOutput, true),
    );

    expect(host.handleToolResult).toHaveBeenCalledTimes(1);
    const requests = continuation.filter((r) => isActionableToolCallRequestChunk(r));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ streamId: request.streamId, toolCalls: [writeCall] });
    expect(continuation.at(-1)).toBe(requests[0]);
    expect(continuation.some((r) => r.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(false);
    const saved = await rt.pending();
    expect(saved?.streamId).toBe(request.streamId);
    expect(saved?.toolCalls).toEqual([writeCall]);
  });

  it.each([
    ['a guard that blocks the call on any chunk', false],
    ['a guard that blocks only the calls the runtime runs itself', true],
  ])('%s: a call the gate refused in a resumed turn is never paused on', async (_label, internalOnly) => {
    const rt = await runtime(`conv-refused-${internalOnly ? 'internal' : 'any'}`, {
      guardrailService: shellGuard(internalOnly),
    });
    const { saved } = await rt.pauseOnRead(hostToolGmi());

    const { gmi, provider, promptCalls } = await rt.shippedGmi([
      { toolCalls: [LOOKUP_CALL, SHELL_CALL] },
      { text: 'Standup moved to 10:00. The command was refused.' },
    ]);
    rt.useGmi(gmi);
    const resumed = await collect(rt.agentos.resumeExternalToolRequest(saved, [READ_RESULT]));

    // the gate refused shell_execute before it ran, lookup_notes ran, and the model read both results
    expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2);
    expect(rt.shell).not.toHaveBeenCalled();
    expect(rt.lookup).toHaveBeenCalledTimes(1);
    const refusal = promptCalls[1]?.find((m) => m.role === 'tool' && m.tool_call_id === SHELL_CALL.id);
    expect(String(refusal?.content)).toContain('AUTH_PERMISSION_DENIED');

    const last = resumed.at(-1) as AgentOSFinalResponseChunk;
    expect(last.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(last.finalResponseText).toBe('Standup moved to 10:00. The command was refused.');
    expect(resumed.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
    expect(await rt.pending()).toBeNull();
  });

  it('a turn with no continuation is unchanged: a call the GMI runs itself ends in FINAL_RESPONSE with no pause', async () => {
    const rt = await runtime('conv-turn-only');
    const { gmi, provider } = await rt.shippedGmi([{ toolCalls: [LOOKUP_CALL] }, { text: 'Standup moved to 10:00.' }]);
    rt.useGmi(gmi);

    const responses = await collect(rt.agentos.processRequest(rt.input));

    expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2);
    expect(rt.lookup).toHaveBeenCalledTimes(1);
    // the stream carries the call as one the runtime runs itself
    const informational = responses.filter(
      (r): r is AgentOSToolCallRequestChunk => r.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST,
    );
    expect(informational.map((r) => [r.executionMode, r.toolCalls])).toEqual([['internal', [LOOKUP_CALL]]]);
    expect(responses.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);

    const last = responses.at(-1) as AgentOSFinalResponseChunk;
    expect(last.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(last.finalResponseText).toBe('Standup moved to 10:00.');
    expect(last.finalToolCalls).toEqual([LOOKUP_CALL]);
    expect(await rt.pending()).toBeNull();
  });
});
