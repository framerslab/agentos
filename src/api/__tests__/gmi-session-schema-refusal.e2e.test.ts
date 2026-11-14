/** A refused provider answer must never become a schema-valid session result. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const provider = vi.hoisted(() => ({
  calls: 0,
  chunks: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async *generateCompletionStream() {
      provider.calls += 1;
      yield* provider.chunks;
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { gmi } from '../gmi';
import { ObjectGenerationError } from '../generateObject';

const REFUSAL = "I'm sorry, I cannot assist with that request.";
const GOOD = '{"items":[{"date":"2026-10-13","title":"Chapter 2 drill","heavy":false}]}';
const week = z.object({ items: z.array(z.object({ date: z.string(), title: z.string(), heavy: z.boolean() })) });

describe('gmi() session responseSchema refusals', () => {
  afterEach(() => {
    provider.calls = 0;
    provider.chunks = [];
    vi.restoreAllMocks();
  });

  it.each(['text', 'lifted object', 'no text'] as const)(
    'rejects a refused %s answer with ObjectGenerationError and the refusal before checking the schema',
    async (kind) => {
      provider.chunks = [
        ...(kind === 'text' ? [{ responseTextDelta: GOOD }] : []),
        {
          isFinal: true,
          ...(kind === 'lifted object' ? { structuredOutput: JSON.parse(GOOD) } : {}),
          choices: [{ index: 0, message: { role: 'assistant', content: kind === 'text' ? GOOD : null }, finishReason: 'stop', refusal: REFUSAL }],
        },
      ];
      const validate = vi.fn(() => true);
      const runtime = gmi({ provider: 'openai', model: 'stub-model', apiKey: 'test', fallbackProviders: [] });
      try {
        const error = await runtime.session('planner').send('plan my week', {
          responseSchema: week.refine(validate),
        }).then(() => undefined, (reason: unknown) => reason);
        expect(error).toBeInstanceOf(ObjectGenerationError);
        expect(error).toMatchObject({ refusal: REFUSAL, message: expect.stringContaining('refused') });
        expect(validate).not.toHaveBeenCalled();
        expect(provider.calls).toBe(1);
      } finally {
        await runtime.close();
      }
    },
  );
});
