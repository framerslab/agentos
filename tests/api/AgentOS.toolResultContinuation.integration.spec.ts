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
import type { StructuredReplyOutput } from '../../src/api/runtime/structuredReply';
import type { RagRetrievedChunk } from '../../src/cognition/rag/IRetrievalAugmentor';
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
import type { ICrossAgentGuardrailService } from '../../src/safety/guardrails/ICrossAgentGuardrailService';
import { wrapWithCrossAgentGuardrails } from '../../src/safety/guardrails/crossAgentGuardrailDispatcher';

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

/**
 * The chunks a host reads from `stream`, as `collect()` returns them. A stream that neither ends nor stops for the host
 * within `ms` fails the read, where a host reading it would wait for ever.
 */
async function collectWithin(stream: AsyncIterable<AgentOSResponse>, what: string, ms = 5000): Promise<AgentOSResponse[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} neither ended nor stopped for the host within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([collect(stream), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/** The ids of the calls an assistant message of `messages` names and no tool message after it answers. */
function unansweredToolCallIds(
  messages: ReadonlyArray<{ role: string; tool_calls?: ReadonlyArray<{ id: string }> | null; tool_call_id?: string | null }>,
): string[] {
  return messages.flatMap((message, index) =>
    message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter((call) => !messages.slice(index + 1).some((later) => later.role === 'tool' && later.tool_call_id === call.id))
          .map((call) => call.id)
      : [],
  );
}

/** The call the host's turn stops for: the host runs it and passes back its result. */
const READ_CALL: ToolCallRequest = { id: 'call-read-1', name: 'read_file', arguments: { path: 'notes.txt' } };

/** A call of a tool registered with the runtime: the GMI runs it itself. */
const LOOKUP_CALL: ToolCallRequest = { id: 'call-lookup-1', name: 'lookup_notes', arguments: { query: 'standup' } };

/** A call of a registered tool that the shell guard refuses. */
const SHELL_CALL: ToolCallRequest = { id: 'call-shell-1', name: 'shell_execute', arguments: { command: 'rm -rf /' } };

/** A second call the host runs. */
const WRITE_CALL: ToolCallRequest = { id: 'call-write-1', name: 'write_file', arguments: { path: 'notes.txt' } };

/** The sources a GMI's retrieval found for its reply. */
const SOURCES: RagRetrievedChunk[] = [
  { id: 'chunk-standup', content: 'Standup moved to 10:00.', originalDocumentId: 'doc-team-notes' },
];

/** The value a structured reply parsed to, with its check. */
const STRUCTURED: StructuredReplyOutput = {
  value: { standup: '10:00' },
  meta: { schemaName: 'standup', valid: true, attempts: 1, enforcement: 'prompt_only', stage: 'model' },
};

/** A structured reply that names the room, and the value it parsed to. */
const ROOM_REPLY = '{"standup":"10:00","room":"4B"}';
const ROOM_STRUCTURED: StructuredReplyOutput = {
  value: { standup: '10:00', room: '4B' },
  meta: { schemaName: 'standup', valid: true, attempts: 1, enforcement: 'prompt_only', stage: 'model' },
};

/** The structured reply without the room, as a guard rewrites it. */
const ROOMLESS_REPLY = '{"standup":"10:00"}';

/**
 * An output guard that rewrites every final response to `text`. It declares `canSanitize`: the dispatcher applies a
 * rewrite only from a sanitizer, and turns any other guard's SANITIZE into a FLAG.
 */
function finalRewriter(text: string): IGuardrailService {
  return {
    id: 'final-rewriter',
    config: { canSanitize: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      return chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? { action: GuardrailAction.SANITIZE, modifiedText: text } : null;
    },
  };
}

/** An output guard that blocks every final response and gives `text` as the reply in its place. */
function finalBlocker(text: string): IGuardrailService {
  return {
    id: 'final-blocker',
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      return chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE
        ? { action: GuardrailAction.BLOCK, reason: 'The reply named a room.', replacementText: text }
        : null;
    },
  };
}

/** A supervisor that rewrites every final response of the agents it observes to `text`. */
function finalSupervisor(text: string): ICrossAgentGuardrailService {
  return {
    id: 'final-supervisor',
    canInterruptOthers: true,
    async evaluateCrossAgentOutput({ chunk }) {
      return chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? { action: GuardrailAction.SANITIZE, modifiedText: text } : null;
    },
  };
}

/** An output guard that judges streamed text too, and keeps the chunk type and RAG sources of each evaluation. */
function sourcesRecorder() {
  const seen: Array<[AgentOSResponseChunkType, RagRetrievedChunk[] | undefined]> = [];
  const guard: IGuardrailService = {
    id: 'sources-recorder',
    config: { evaluateStreamingChunks: true },
    async evaluateOutput({ chunk, ragSources }: GuardrailOutputPayload) {
      seen.push([chunk.type, ragSources]);
      return null;
    },
  };
  return { guard, seen };
}

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

/**
 * A GMI that runs LOOKUP_CALL itself, streaming it as a call the runtime runs, and then stops the user's turn for
 * READ_CALL without streaming that call.
 */
function mixedToolsGmi() {
  return {
    getCurrentPrimaryPersonaId: () => 'test-persona',
    getGMIId: () => 'gmi-mixed-tools',
    getPersona: () => PERSONA,
    processTurnStream: async function* (): AsyncGenerator<any, GMIOutput, undefined> {
      yield {
        type: GMIOutputChunkType.TOOL_CALL_REQUEST,
        content: [LOOKUP_CALL],
        interactionId: 'interaction-mixed-tools',
        timestamp: new Date(),
        metadata: { executionMode: 'internal', requiresExternalToolResult: false },
      };
      return { isFinal: false, responseText: 'I need the notes file first.', toolCalls: [READ_CALL] };
    },
    hydrateConversationHistory: vi.fn(),
    handleToolResult: vi.fn(async (): Promise<GMIOutput> => ({ isFinal: true, responseText: 'Done.' })),
  };
}

/**
 * A GMI that streams a request for host calls that names no call, and then stops the user's turn for READ_CALL
 * without streaming that call.
 */
function emptyRequestGmi() {
  return {
    getCurrentPrimaryPersonaId: () => 'test-persona',
    getGMIId: () => 'gmi-empty-request',
    getPersona: () => PERSONA,
    processTurnStream: async function* (): AsyncGenerator<any, GMIOutput, undefined> {
      yield {
        type: GMIOutputChunkType.TOOL_CALL_REQUEST,
        content: [],
        interactionId: 'interaction-empty-request',
        timestamp: new Date(),
        metadata: { executionMode: 'external', requiresExternalToolResult: true },
      };
      return { isFinal: false, responseText: 'I need the notes file first.', toolCalls: [READ_CALL] };
    },
    hydrateConversationHistory: vi.fn(),
    handleToolResult: vi.fn(async (): Promise<GMIOutput> => ({ isFinal: true, responseText: 'Done.' })),
  };
}

/** The rationale each request of `streamingRequestsGmi()` gives. */
const STREAMED_RATIONALE = 'Reading the notes file.';

/**
 * A GMI that streams `streamed` in order, each part a request for calls the host runs (with `STREAMED_RATIONALE`) or a
 * piece of text, and then returns `output`.
 */
function streamingRequestsGmi(streamed: Array<ToolCallRequest[] | string>, output: GMIOutput) {
  return {
    getCurrentPrimaryPersonaId: () => 'test-persona',
    getGMIId: () => 'gmi-streamed-requests',
    getPersona: () => PERSONA,
    processTurnStream: async function* (): AsyncGenerator<any, GMIOutput, undefined> {
      for (const part of streamed) {
        yield typeof part === 'string'
          ? { type: GMIOutputChunkType.TEXT_DELTA, content: part, interactionId: 'interaction-streamed-requests', timestamp: new Date() }
          : {
              type: GMIOutputChunkType.TOOL_CALL_REQUEST,
              content: part,
              interactionId: 'interaction-streamed-requests',
              timestamp: new Date(),
              metadata: { executionMode: 'external', requiresExternalToolResult: true, rationale: STREAMED_RATIONALE },
            };
      }
      return output;
    },
    hydrateConversationHistory: vi.fn(),
    handleToolResult: vi.fn(async (): Promise<GMIOutput> => ({ isFinal: true, responseText: 'Done.' })),
  };
}

/** A GMI whose turn ends with `reply` and the value a structured turn parsed from it. */
function structuredReplyGmi(reply: string, structuredOutput: StructuredReplyOutput) {
  return {
    getCurrentPrimaryPersonaId: () => 'test-persona',
    getGMIId: () => 'gmi-structured-reply',
    getPersona: () => PERSONA,
    processTurnStream: async function* (): AsyncGenerator<any, GMIOutput, undefined> {
      yield {
        type: GMIOutputChunkType.TEXT_DELTA,
        content: reply,
        interactionId: 'interaction-structured-reply',
        timestamp: new Date(),
      };
      return { isFinal: true, responseText: reply, structuredOutput };
    },
    hydrateConversationHistory: vi.fn(),
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

    /**
     * The shipped GMI on a provider that gives `replies`, with the runtime's tool orchestrator and `gmiConfig` over
     * its base config.
     */
    async function shippedGmi(replies: ModelReply[], gmiConfig: Record<string, unknown> = {}) {
      const { provider, promptCalls } = scriptedProvider(replies);
      const gmi = new GMI(`gmi-shipped-${conversationId}`);
      openGmis.push(gmi);
      await gmi.initialize(PERSONA as any, {
        ...gmiConfig,
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

  it.each([
    ['an output with isFinal: false and no calls', 'conv-not-final-no-calls', { isFinal: false, responseText: 'I am still reading the notes.' } as GMIOutput],
    [
      'an output that leaves isFinal out',
      'conv-unmarked',
      { responseText: 'Now I write the file.', toolCalls: [WRITE_CALL] } as unknown as GMIOutput,
    ],
  ])('%s ends the continuation with FINAL_RESPONSE, as it ends a turn, so the host never waits on an open stream', async (_label, conversationId, output) => {
    const rt = await runtime(conversationId);
    const { request } = await rt.pauseOnRead(hostToolGmi(output));

    const continuation = await collectWithin(
      rt.agentos.handleToolResult(request.streamId, READ_CALL.id, READ_CALL.name, READ_RESULT.toolOutput, true),
      'the continuation',
    );

    const last = continuation.at(-1) as AgentOSFinalResponseChunk;
    expect(last.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(last.finalResponseText).toBe(output.responseText);
    expect(continuation.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
    expect(await rt.pending()).toBeNull();
  });

  it.each([
    ['a turn', 'conv-no-reply-turn', false],
    ['a resumed turn', 'conv-no-reply-resumed', true],
  ])('%s that ends with no reply after a tool round the GMI ran leaves the next turn no unanswered call', async (_label, conversationId, resumes) => {
    const rt = await runtime(conversationId);
    const saved = resumes ? (await rt.pauseOnRead(hostToolGmi())).saved : undefined;
    // the GMI stops its tool loop after one round, as it does when the model keeps calling tools; the next turn answers
    const { gmi, provider, promptCalls } = await rt.shippedGmi(
      [{ toolCalls: [LOOKUP_CALL] }, { text: 'Standup moved to 10:00.' }],
      { maxToolLoopIterations: 1 },
    );
    rt.useGmi(gmi);

    const ended = saved
      ? await collect(rt.agentos.resumeExternalToolRequest(saved, [READ_RESULT]))
      : await collect(rt.agentos.processRequest(rt.input));
    const final = ended.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBeNull();
    expect(final.finalToolCalls).toEqual([LOOKUP_CALL]);
    expect(rt.lookup).toHaveBeenCalledTimes(1);
    // the call's result lives in the GMI's history: the stored conversation names no call it does not answer
    expect(unansweredToolCallIds(rt.context.getAllMessages())).toEqual([]);

    const next = await collect(rt.agentos.processRequest({ ...rt.input, textInput: 'When is the standup now?' }));

    expect((next.at(-1) as AgentOSFinalResponseChunk).finalResponseText).toBe('Standup moved to 10:00.');
    expect(provider.generateCompletionStream).toHaveBeenCalledTimes(2);
    // a provider refuses a request that holds a call with no result
    expect(unansweredToolCallIds(promptCalls[1] ?? [])).toEqual([]);
  });

  it('a turn that streams a call the GMI runs itself and then stops for a host call hands the host that call', async () => {
    const rt = await runtime('conv-mixed-turn');
    rt.useGmi(mixedToolsGmi());

    const responses = await collectWithin(rt.agentos.processRequest(rt.input), 'the turn');

    const requests = responses.filter(
      (r): r is AgentOSToolCallRequestChunk => r.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST,
    );
    expect(requests.map((r) => [r.executionMode, r.toolCalls])).toEqual([
      ['internal', [LOOKUP_CALL]],
      ['external', [READ_CALL]],
    ]);
    expect(isActionableToolCallRequestChunk(responses.at(-1))).toBe(true);
    expect((await rt.pending())?.toolCalls).toEqual([READ_CALL]);
  });

  it('a turn that streams a request naming no call and then stops for a host call hands the host that call', async () => {
    const rt = await runtime('conv-empty-request');
    rt.useGmi(emptyRequestGmi());

    const responses = await collectWithin(rt.agentos.processRequest(rt.input), 'the turn');

    // a request that names no call gives the host nothing to run, and the host stops reading at a request
    const requests = responses.filter(
      (r): r is AgentOSToolCallRequestChunk => r.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST,
    );
    expect(requests.map((r) => r.toolCalls)).toEqual([[READ_CALL]]);
    expect(isActionableToolCallRequestChunk(responses.at(-1))).toBe(true);
    expect((await rt.pending())?.toolCalls).toEqual([READ_CALL]);
  });

  it.each([
    ['one request that names part of the calls it stops for', 'conv-streamed-part', [[READ_CALL]], [READ_CALL, WRITE_CALL]],
    ['a request for each call it stops for', 'conv-streamed-each', [[READ_CALL], [WRITE_CALL]], [READ_CALL, WRITE_CALL]],
    ['a request that names a call it does not stop for', 'conv-streamed-more', [[READ_CALL, WRITE_CALL]], [READ_CALL]],
  ])('a turn whose GMI streamed %s hands the host one request for exactly the calls it saved', async (_label, conversationId, streamed, pauseCalls) => {
    const rt = await runtime(conversationId);
    rt.useGmi(streamingRequestsGmi(streamed, { isFinal: false, responseText: 'I need the notes file first.', toolCalls: pauseCalls }));

    const responses = await collectWithin(rt.agentos.processRequest(rt.input), 'the turn');

    // the host stops reading at the first request it acts on, so that request names every call the turn waits on
    const requests = responses.filter(isActionableToolCallRequestChunk);
    expect(requests.map((r) => r.toolCalls)).toEqual([pauseCalls]);
    expect(responses.at(-1)).toBe(requests[0]);
    // the pause is saved before the host reads its request
    expect((await rt.pending())?.toolCalls).toEqual(pauseCalls);
  });

  it("a turn that streams its request for host calls before its text hands the host the text, then the GMI's request", async () => {
    const rt = await runtime('conv-streamed-text');
    rt.useGmi(
      streamingRequestsGmi([[READ_CALL], 'Reading your notes.'], {
        isFinal: false,
        responseText: 'I need the notes file first.',
        toolCalls: [READ_CALL],
      }),
    );

    const responses = await collectWithin(rt.agentos.processRequest(rt.input), 'the turn');

    // the request waits for the GMI's output, so the text the GMI streamed after it reaches the host before it
    expect(
      responses
        .filter((r) => r.type === AgentOSResponseChunkType.TEXT_DELTA || r.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST)
        .map((r) => r.type),
    ).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
    const request = responses.at(-1) as AgentOSToolCallRequestChunk;
    expect(isActionableToolCallRequestChunk(request)).toBe(true);
    // the GMI's own request, which names exactly the calls the turn stops for
    expect(request.toolCalls).toEqual([READ_CALL]);
    expect(request.rationale).toBe(STREAMED_RATIONALE);
    expect((await rt.pending())?.toolCalls).toEqual([READ_CALL]);
  });

  it('a turn whose GMI streamed a request for host calls and then ends without stopping hands the host its FINAL_RESPONSE', async () => {
    const rt = await runtime('conv-streamed-no-pause');
    rt.useGmi(streamingRequestsGmi([[READ_CALL]], { isFinal: true, responseText: 'Standup moved to 10:00.' }));

    const responses = await collectWithin(rt.agentos.processRequest(rt.input), 'the turn');

    // the turn waits on no call, and a request would stop the host's read before the reply
    expect(responses.some((r) => isActionableToolCallRequestChunk(r))).toBe(false);
    const final = responses.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe('Standup moved to 10:00.');
    expect(await rt.pending()).toBeNull();
  });

  it.each([
    ['an output that lists the calls the GMI ran', 'conv-final-calls', [LOOKUP_CALL]],
    ['an output with no calls', 'conv-final-plain', undefined],
  ])('%s: the continuation ends with a FINAL_RESPONSE that holds the reply, its sources and its structured value', async (_label, conversationId, toolCalls) => {
    const rt = await runtime(conversationId);
    const reply = '**Standup** moved to 10:00.';
    const { request } = await rt.pauseOnRead(
      hostToolGmi({ isFinal: true, responseText: reply, toolCalls, ragSources: SOURCES, structuredOutput: STRUCTURED }),
    );

    const continuation = await collect(
      rt.agentos.handleToolResult(request.streamId, READ_CALL.id, READ_CALL.name, READ_RESULT.toolOutput, true),
    );

    const final = continuation.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe(reply);
    expect(final.finalToolCalls).toEqual(toolCalls);
    expect(final.ragSources).toEqual(SOURCES);
    expect(final.structured).toEqual(STRUCTURED);
    // the plain text a voice host speaks, as a turn's final response carries it
    expect(final.finalResponseTextPlain).toBe('Standup moved to 10:00.');
    const stored = (final.updatedConversationContext as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(stored.at(-1)).toMatchObject({ role: 'assistant', content: reply });
  });

  it('a turn ends with a FINAL_RESPONSE that holds the reply as plain text', async () => {
    const rt = await runtime('conv-plain-text');
    const { gmi } = await rt.shippedGmi([{ text: '**Standup** moved to 10:00.' }]);
    rt.useGmi(gmi);

    const responses = await collect(rt.agentos.processRequest(rt.input));

    const final = responses.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe('**Standup** moved to 10:00.');
    expect(final.finalResponseTextPlain).toBe('Standup moved to 10:00.');
  });

  it("a supervisor's rewrite of a final response leaves the original reply in none of its fields", async () => {
    const rt = await runtime('conv-supervised');
    const { gmi } = await rt.shippedGmi([{ text: '**Standup** moved to 10:00, in room 4B.' }]);
    rt.useGmi(gmi);
    const supervisor: ICrossAgentGuardrailService = {
      id: 'room-redactor',
      canInterruptOthers: true,
      async evaluateCrossAgentOutput({ chunk }) {
        return chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE
          ? { action: GuardrailAction.SANITIZE, modifiedText: 'Standup moved to 10:00.' }
          : null;
      },
    };

    const supervised = await collect(
      wrapWithCrossAgentGuardrails(
        [supervisor],
        { sourceAgentId: 'notes-agent', observerAgentId: 'supervisor' },
        { userId: 'user-1', sessionId: rt.input.sessionId, personaId: 'test-persona', conversationId: 'conv-supervised' },
        rt.agentos.processRequest(rt.input),
        { streamId: 'supervised-notes-agent' },
      ),
    );

    const final = supervised.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe('Standup moved to 10:00.');
    // the plain text a voice host speaks, and the conversation the chunk carries, read the rewrite too
    expect(final.finalResponseTextPlain).toBe('Standup moved to 10:00.');
    const carried = (final.updatedConversationContext as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(carried.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Standup moved to 10:00.']);
  });

  it("a supervisor's rewrite of a structured reply withdraws the value parsed from the reply it replaced", async () => {
    const rt = await runtime('conv-supervised-structured');
    rt.useGmi(structuredReplyGmi(ROOM_REPLY, ROOM_STRUCTURED));

    const supervised = await collect(
      wrapWithCrossAgentGuardrails(
        [finalSupervisor(ROOMLESS_REPLY)],
        { sourceAgentId: 'notes-agent', observerAgentId: 'supervisor' },
        { userId: 'user-1', sessionId: rt.input.sessionId, personaId: 'test-persona', conversationId: 'conv-supervised-structured' },
        rt.agentos.processRequest(rt.input),
        { streamId: 'supervised-structured' },
      ),
    );

    const final = supervised.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe(ROOMLESS_REPLY);
    // the wrapper holds no schema to check the rewrite against, so the value parsed from the original does not reach the host
    expect(final.structured).toMatchObject({ value: null, meta: { schemaName: 'standup', valid: false, stage: 'post_guardrail' } });
  });

  it.each([
    ["an output guard's rewrite", 'conv-plain-rewrite', 'rewrite'],
    ["a supervisor's rewrite", 'conv-plain-supervised', 'supervisor'],
    ["an output guard's fixed reply for a block", 'conv-plain-block', 'block'],
  ] as const)('%s of a final response reaches the host as plain text, as a turn renders its own reply', async (_label, conversationId, mode) => {
    const reply = '**Standup** moved to [10:00](https://example.com/standup).';
    const guardrailService = mode === 'rewrite' ? finalRewriter(reply) : mode === 'block' ? finalBlocker(reply) : undefined;
    const rt = await runtime(conversationId, guardrailService ? { guardrailService } : {});
    const { gmi } = await rt.shippedGmi([{ text: 'Standup moved to 10:00, in room 4B.' }]);
    rt.useGmi(gmi);
    const turn = rt.agentos.processRequest(rt.input);

    const responses = await collect(
      mode === 'supervisor'
        ? wrapWithCrossAgentGuardrails(
            [finalSupervisor(reply)],
            { sourceAgentId: 'notes-agent', observerAgentId: 'supervisor' },
            { userId: 'user-1', sessionId: rt.input.sessionId, personaId: 'test-persona', conversationId },
            turn,
            { streamId: `supervised-${conversationId}` },
          )
        : turn,
    );

    const final = responses.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe(reply);
    // the plain text a voice host speaks
    expect(final.finalResponseTextPlain).toBe('Standup moved to 10:00.');
  });

  it('in hold mode, the text before a host request reaches the guards as a reply with its plain text, as a final reply does', async () => {
    const plain: Array<string | null | undefined> = [];
    const recorder: IGuardrailService = {
      id: 'plain-recorder',
      async evaluateOutput({ chunk }: GuardrailOutputPayload) {
        if (chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) {
          plain.push((chunk as AgentOSFinalResponseChunk).finalResponseTextPlain);
        }
        return null;
      },
    };
    const rt = await runtime('conv-hold-plain', { guardrailService: recorder, guardrailOutputMode: 'hold' });
    rt.useGmi(
      streamingRequestsGmi(['**Reading** your notes.', [READ_CALL]], {
        isFinal: false,
        responseText: 'I need the notes file first.',
        toolCalls: [READ_CALL],
      }),
    );

    const responses = await collectWithin(rt.agentos.processRequest(rt.input), 'the turn');

    expect(isActionableToolCallRequestChunk(responses.at(-1))).toBe(true);
    expect(plain).toEqual(['Reading your notes.']);
  });

  it("an output guard's rewrite of a continuation's structured reply withdraws the value parsed from the reply it replaced", async () => {
    const rt = await runtime('conv-guarded-structured', { guardrailService: finalRewriter(ROOMLESS_REPLY) });
    const { request } = await rt.pauseOnRead(
      hostToolGmi({ isFinal: true, responseText: ROOM_REPLY, structuredOutput: ROOM_STRUCTURED }),
    );

    const continuation = await collect(
      rt.agentos.handleToolResult(request.streamId, READ_CALL.id, READ_CALL.name, READ_RESULT.toolOutput, true),
    );

    const final = continuation.at(-1) as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe(ROOMLESS_REPLY);
    // a continuation holds no schema to check the rewrite against, so the value parsed from the original does not reach the host
    expect(final.structured).toMatchObject({ value: null, meta: { schemaName: 'standup', valid: false, stage: 'post_guardrail' } });
  });

  it("every output guard evaluation of a continuation's reply reads the sources the GMI used", async () => {
    const recorder = sourcesRecorder();
    const rt = await runtime('conv-guarded-sources', { guardrailService: recorder.guard });
    const { request } = await rt.pauseOnRead(
      hostToolGmi({ isFinal: true, responseText: 'Standup moved to 10:00.', ragSources: SOURCES }),
    );
    recorder.seen.length = 0;

    await collect(rt.agentos.handleToolResult(request.streamId, READ_CALL.id, READ_CALL.name, READ_RESULT.toolOutput, true));

    // as on a turn, where the sources reach the stream before the text
    expect(recorder.seen).toEqual([
      [AgentOSResponseChunkType.TEXT_DELTA, SOURCES],
      [AgentOSResponseChunkType.FINAL_RESPONSE, SOURCES],
    ]);
  });
});
