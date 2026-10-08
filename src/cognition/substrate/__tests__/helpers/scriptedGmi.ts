/**
 * Shared fixtures for GMI tests: a real PromptEngine, a scripted provider that
 * records the messages and options it receives, and a GMI built over them,
 * optionally with a completion gateway. Not a test file (the vitest include
 * pattern needs `.test.ts`).
 */
import { vi } from 'vitest';
import { GMI } from '../../GMI';
import { GMIInteractionType, type GMIBaseConfig, type GMIOutput, type GMIOutputChunk, type GMITurnInput, type ToolCallResult } from '../../IGMI';
import type { IPersonaDefinition } from '../../personas/IPersonaDefinition';
import { InMemoryWorkingMemory } from '../../memory/InMemoryWorkingMemory';
import type { IUtilityAI } from '../../../nlp/ai_utilities/IUtilityAI';
import { PromptEngine } from '../../../../core/llm/PromptEngine';
import type { PromptEngineConfig } from '../../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage, IProvider, ModelCompletionResponse, ModelUsage } from '../../../../core/llm/providers/IProvider';
import type { IToolOrchestrator, ToolDefinitionForLLM } from '../../../../core/tools/IToolOrchestrator';
import type { ToolExecutionRequestDetails } from '../../../../core/tools/ToolExecutor';
import type { CompletionGateway } from '../../../../api/runtime/completionGateway';
import { GatewayProviderManager } from '../../../../api/runtime/gatewayProviderManager';

export const LOOKUP_TOOL: ToolDefinitionForLLM = { name: 'lookup', description: 'Look something up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };

export function promptEngineConfig(): PromptEngineConfig {
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
  };
}

const scriptedChunk = { id: 'scripted', object: 'chat.completion.chunk', created: 0, modelId: 'scripted-model' };

/** A streamed text answer: one delta, then the final chunk with the finish reason and usage. */
export function textReply(text: string, usage: ModelUsage = { promptTokens: 10, completionTokens: 3, totalTokens: 13 }): ModelCompletionResponse[] {
  return [
    { ...scriptedChunk, choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: null }], responseTextDelta: text },
    { ...scriptedChunk, choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }], usage, isFinal: true },
  ];
}

/** A tool-call step, optionally preceded by streamed preamble text. */
export function toolCallReply(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, preamble?: string): ModelCompletionResponse[] {
  const final: ModelCompletionResponse = {
    ...scriptedChunk,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: preamble ?? null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      },
      finishReason: 'tool_calls',
    }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    isFinal: true,
  };
  return preamble ? [{ ...scriptedChunk, choices: [], responseTextDelta: preamble }, final] : [final];
}

/** An in-band provider error chunk. */
export function errorReply(message: string): ModelCompletionResponse[] {
  return [{ ...scriptedChunk, choices: [], error: { message, type: 'rate_limit' }, isFinal: true }];
}

/** A provider whose replies are scripted; `throws` marks a call that throws instead. */
export function scriptedProvider(replies: Array<ModelCompletionResponse[] | { throws: Error }>, providerId = 'scripted') {
  const received: ChatMessage[][] = [];
  const options: Array<Record<string, unknown>> = [];
  const queue = [...replies];
  const provider = {
    providerId,
    isInitialized: true,
    generateCompletionStream: vi.fn(async function* (_modelId: string, messages: ChatMessage[], opts: Record<string, unknown>) {
      received.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[]);
      options.push(opts);
      const reply = queue.shift();
      if (!reply) throw new Error('unexpected model call');
      if ('throws' in reply) throw reply.throws;
      yield* reply;
    }),
  } as unknown as IProvider;
  return { provider, received, options };
}

export interface ScriptedGmiOptions {
  provider?: IProvider;
  gateway?: CompletionGateway;
  toolResults?: Record<string, ToolCallResult | Error>;
  persona?: Partial<IPersonaDefinition>;
  maxToolLoopIterations?: number;
}

/**
 * A GMI over the real PromptEngine. Without a gateway its provider manager
 * serves `provider`; with one it is a GatewayProviderManager, which the GMI
 * points at each hop it resolves.
 */
export async function createScriptedGmi(opts: ScriptedGmiOptions) {
  const promptEngine = new PromptEngine();
  await promptEngine.initialize(promptEngineConfig());
  const toolResults = opts.toolResults ?? {};
  const processToolCall = vi.fn(async ({ toolCallRequest }: ToolExecutionRequestDetails): Promise<ToolCallResult> => {
    const scripted = toolResults[toolCallRequest.id];
    if (scripted instanceof Error) throw scripted;
    return scripted ?? { toolCallId: toolCallRequest.id, toolName: toolCallRequest.name, output: { ok: true } };
  });
  const provider = opts.provider;
  const llmProviderManager = opts.gateway
    ? new GatewayProviderManager().asProviderManager()
    : ({
        getModelInfo: vi.fn(async (modelId: string) => ({ modelId, providerId: provider!.providerId, contextWindowSize: 1_000_000, capabilities: ['chat', 'tool_use'] })),
        getProvider: vi.fn(() => provider),
        getProviderForModel: vi.fn(() => provider),
      } as unknown as AIModelProviderManager);
  const gmi = new GMI('gmi-scripted');
  const config: GMIBaseConfig = {
    workingMemory: new InMemoryWorkingMemory(),
    promptEngine,
    llmProviderManager,
    utilityAI: {} as unknown as IUtilityAI,
    toolOrchestrator: { orchestratorId: 'scripted-tools', listAvailableTools: vi.fn(async () => [LOOKUP_TOOL]), processToolCall } as unknown as IToolOrchestrator,
    ...(opts.gateway ? { completionGateway: opts.gateway } : {}),
    ...(opts.maxToolLoopIterations ? { maxToolLoopIterations: opts.maxToolLoopIterations } : {}),
  };
  await gmi.initialize({
    id: 'scripted-persona', name: 'Scripted Persona', version: '1.0.0', baseSystemPrompt: 'You are the scripted test persona.',
    defaultProviderId: provider?.providerId ?? 'openai', defaultModelId: 'scripted-model', metaPrompts: [],
    ...opts.persona,
  } as unknown as IPersonaDefinition, config);
  return { gmi, processToolCall, promptEngine };
}

export function textTurn(interactionId: string, text: string, metadata?: GMITurnInput['metadata']): GMITurnInput {
  return { interactionId, userId: 'user-1', sessionId: 'session-1', type: GMIInteractionType.TEXT, content: text, ...(metadata ? { metadata } : {}) };
}

/** Drains a turn: every chunk it yields and the output it returns. */
export async function runTurn(gmi: GMI, input: GMITurnInput): Promise<{ chunks: GMIOutputChunk[]; output: GMIOutput }> {
  const chunks: GMIOutputChunk[] = [];
  const stream = gmi.processTurnStream(input);
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, output: next.value };
    chunks.push(next.value);
  }
}
