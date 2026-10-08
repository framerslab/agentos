/**
 * @file agentos-runtime-chunks.test.ts
 * Boots the real runtime with an OpenAI provider stub and checks the GMI step
 * contract where the runtime meets it: the persona's completion options reach
 * the provider, a usage-only trailing chunk (OpenAI's stream shape) reaches the
 * turn's usage without breaking the turn, the runtime prints no console line
 * per usage update, and an in-band provider error reaches the stream with
 * LLM_PROVIDER_ERROR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  seenOptions: [] as Array<Record<string, unknown>>,
  replies: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
    async *generateCompletionStream(_modelId: string, _messages: unknown, options: Record<string, unknown>) {
      provider.seenOptions.push(options);
      yield* provider.replies.shift() ?? [];
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { GMIErrorCode } from '../../core/utils/errors.js';

const persona = {
  id: 'runtime-options', name: 'Runtime Options', description: 'Persona whose completion options must reach the provider.',
  version: '1.0.0', baseSystemPrompt: 'You are terse.',
  defaultModelCompletionOptions: { topP: 0.5, frequencyPenalty: 0.1, stopSequences: ['END'] },
} as unknown as IPersonaDefinition;

async function boot(): Promise<AgentOS> {
  return AgentOS.create({ modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] }, turnPlanning: { enabled: false }, personas: [persona] } as any);
}

async function collect(agentos: AgentOS, sessionId: string): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of agentos.processRequest({ userId: 'user-1', sessionId, selectedPersonaId: 'runtime-options', textInput: 'Say hello.' } as any)) chunks.push(chunk);
  return chunks;
}

describe('a runtime turn under the GMI step contract', () => {
  let booted: AgentOS | undefined;
  afterEach(async () => {
    if (booted) await booted.shutdown();
    booted = undefined;
    provider.replies.length = 0;
    vi.restoreAllMocks();
  });

  it('sends the persona completion options, counts a usage-only trailing chunk and prints no usage line', async () => {
    const log = vi.spyOn(console, 'log');
    provider.replies.push([
      { responseTextDelta: 'Hello.' },
      { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Hello.' }, finishReason: 'stop' }] },
      { isFinal: true, choices: [], usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 } },
    ]);
    booted = await boot();
    const chunks = await collect(booted, 's-runtime');
    expect(provider.seenOptions.at(-1)).toMatchObject({ topP: 0.5, frequencyPenalty: 0.1, stopSequences: ['END'], stream: true });
    expect(chunks.filter((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA).map((c) => c.textDelta).join('')).toBe('Hello.');
    expect(chunks.some((c) => c.type === AgentOSResponseChunkType.ERROR)).toBe(false);
    expect(chunks.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE)?.usage).toMatchObject({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
    expect(log.mock.calls.some((call) => String(call[0]).includes('UsageUpdate from GMI'))).toBe(false);
  });

  it('reports an in-band provider error with LLM_PROVIDER_ERROR', async () => {
    provider.replies.push([{ isFinal: true, choices: [], error: { message: 'rate limited', type: 'rate_limit' } }]);
    booted = await boot();
    const error = (await collect(booted, 's-runtime-error')).find((c) => c.type === AgentOSResponseChunkType.ERROR);
    expect(error?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(String(error?.message)).toContain('rate limited');
  });
});
