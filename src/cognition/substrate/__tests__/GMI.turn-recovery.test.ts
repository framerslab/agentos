/**
 * @fileoverview A failed GMI turn records ERRORED, and the next turn on the
 * same session still runs: ERRORED reports that the last turn failed, not
 * that the instance is unusable. A tool round that fails part way still
 * answers every call its assistant message declared, so the next request is
 * valid. A failed turn's generator that is drained after the next turn began
 * leaves that newer turn's state and trace alone.
 *
 * Runs a real GMI over a real PromptEngine with a scripted provider that
 * records the messages GMI sends it.
 */
import { describe, expect, it, vi } from 'vitest';

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
import type { PromptEngineConfig } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { ChatMessage, IProvider, ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import type { IToolOrchestrator, ToolDefinitionForLLM } from '../../../core/tools/IToolOrchestrator';
import type { ToolExecutionRequestDetails } from '../../../core/tools/ToolExecutor';

type Json = Record<string, any>;

const LOOKUP_TOOL: ToolDefinitionForLLM = {
  name: 'lookup',
  description: 'Look something up.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
};

function promptEngineConfig(): PromptEngineConfig {
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
  ] as ModelCompletionResponse[];
}

function errorReply(message: string): ModelCompletionResponse[] {
  return [{ ...scriptedChunk, choices: [], error: { message, type: 'rate_limit' }, isFinal: true }] as unknown as ModelCompletionResponse[];
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
  }] as ModelCompletionResponse[];
}

/** A provider whose replies are scripted; `throws` marks a call that throws instead. */
function scriptedProvider(replies: Array<ModelCompletionResponse[] | { throws: Error }>) {
  const received: ChatMessage[][] = [];
  const queue = [...replies];
  const provider = {
    providerId: 'scripted',
    isInitialized: true,
    generateCompletionStream: vi.fn(async function* (_modelId: string, messages: ChatMessage[]) {
      received.push(JSON.parse(JSON.stringify(messages)) as ChatMessage[]);
      const reply = queue.shift();
      if (!reply) throw new Error('unexpected model call');
      if ('throws' in reply) throw reply.throws;
      yield* reply;
    }),
  } as unknown as IProvider;
  return { provider, received };
}

async function createGmi(provider: IProvider, toolResults: Record<string, ToolCallResult | Error> = {}) {
  const promptEngine = new PromptEngine();
  await promptEngine.initialize(promptEngineConfig());
  const processToolCall = vi.fn(async ({ toolCallRequest }: ToolExecutionRequestDetails): Promise<ToolCallResult> => {
    const scripted = toolResults[toolCallRequest.id];
    if (scripted instanceof Error) throw scripted;
    return scripted ?? { toolCallId: toolCallRequest.id, toolName: toolCallRequest.name, output: { ok: true } };
  });
  const gmi = new GMI('gmi-turn-recovery');
  await gmi.initialize(
    {
      id: 'turn-recovery-persona',
      name: 'Turn Recovery Persona',
      version: '1.0.0',
      baseSystemPrompt: 'You are the turn recovery test persona.',
      defaultProviderId: provider.providerId,
      defaultModelId: 'scripted-model',
      metaPrompts: [],
    } as unknown as IPersonaDefinition,
    {
      workingMemory: new InMemoryWorkingMemory(),
      promptEngine,
      llmProviderManager: {
        getModelInfo: vi.fn(async (modelId: string) => ({
          modelId,
          providerId: provider.providerId,
          contextWindowSize: 1_000_000,
          capabilities: ['chat', 'tool_use'],
        })),
        getProvider: vi.fn(() => provider),
        getProviderForModel: vi.fn(() => provider),
      } as unknown as AIModelProviderManager,
      utilityAI: {} as unknown as IUtilityAI,
      toolOrchestrator: {
        orchestratorId: 'turn-recovery-tools',
        listAvailableTools: vi.fn(async () => [LOOKUP_TOOL]),
        processToolCall,
      } as unknown as IToolOrchestrator,
    },
  );
  return { gmi, processToolCall };
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

async function runTurn(gmi: GMI, input: GMITurnInput): Promise<{ chunks: GMIOutputChunk[]; output: GMIOutput }> {
  const chunks: GMIOutputChunk[] = [];
  const stream = gmi.processTurnStream(input);
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, output: next.value };
    chunks.push(next.value);
  }
}

const types = (chunks: GMIOutputChunk[]) => chunks.map((chunk) => chunk.type);

describe('GMI recovery after a failed turn', () => {
  it('runs the next turn after a provider error chunk failed the previous one', async () => {
    const { provider } = scriptedProvider([errorReply('rate limited'), textReply('Back again.')]);
    const { gmi } = await createGmi(provider);

    const failed = await runTurn(gmi, textTurn('turn-1', 'Hello?'));
    expect(types(failed.chunks)).toContain(GMIOutputChunkType.ERROR);
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.ERRORED);

    const next = await runTurn(gmi, textTurn('turn-2', 'Hello again?'));
    expect(next.chunks.filter((c) => c.type === GMIOutputChunkType.TEXT_DELTA).map((c) => c.content)).toEqual(['Back again.']);
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('runs the next turn after the provider threw during the previous one', async () => {
    const { provider } = scriptedProvider([{ throws: new Error('socket hang up') }, textReply('Back again.')]);
    const { gmi } = await createGmi(provider);

    await runTurn(gmi, textTurn('turn-1', 'Hello?'));
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.ERRORED);

    const next = await runTurn(gmi, textTurn('turn-2', 'Hello again?'));
    expect(types(next.chunks)).toContain(GMIOutputChunkType.TEXT_DELTA);
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });

  it('answers every call of a tool round that failed part way, so the next request pairs', async () => {
    const { provider, received } = scriptedProvider([
      toolCallReply([
        { id: 'call_a', name: 'lookup', args: { q: 'a' } },
        { id: 'call_b', name: 'lookup', args: { q: 'b' } },
        { id: 'call_c', name: 'lookup', args: { q: 'c' } },
      ]),
      textReply('Recovered.'),
    ]);
    const { gmi, processToolCall } = await createGmi(provider, {
      call_a: { toolCallId: 'call_a', toolName: 'lookup', output: null, isError: true, errorDetails: { message: 'boom' } },
    });

    const failed = await runTurn(
      gmi,
      textTurn('turn-1', 'Look these up.', { executionPolicy: { toolFailureMode: 'fail_closed' } } as GMITurnInput['metadata']),
    );
    expect(types(failed.chunks)).toContain(GMIOutputChunkType.ERROR);
    expect(processToolCall).toHaveBeenCalledTimes(1);

    await runTurn(gmi, textTurn('turn-2', 'Try again.'));

    const nextRequest = received[1]!;
    const callTurn = nextRequest.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(callTurn?.tool_calls?.map((c) => c.id)).toEqual(['call_a', 'call_b', 'call_c']);
    const answered = nextRequest.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(answered).toEqual(['call_a', 'call_b', 'call_c']);
  });

  it('leaves a newer turn\'s state and trace alone when a failed turn is drained late', async () => {
    const { provider } = scriptedProvider([errorReply('rate limited'), textReply('Second turn.')]);
    const { gmi } = await createGmi(provider);

    // Read the failed turn only up to its ERROR chunk.
    const first = gmi.processTurnStream(textTurn('turn-1', 'Hello?'));
    for (;;) {
      const next = await first.next();
      if (next.done || next.value.type === GMIOutputChunkType.ERROR) break;
    }

    // The next turn starts while the failed one is still suspended.
    const second = gmi.processTurnStream(textTurn('turn-2', 'Hello again?'));
    const firstChunk = await second.next();
    expect(firstChunk.done).toBe(false);
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.PROCESSING);

    // Draining the failed turn must not reset the running turn.
    for (;;) {
      const next = await first.next();
      if (next.done) break;
    }
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.PROCESSING);
    expect(gmi.getReasoningTrace().turnId).toBe('turn-2');

    for (;;) {
      const next = await second.next();
      if (next.done) break;
    }
    expect(gmi.getCurrentState()).toBe(GMIPrimeState.READY);
  });
});
