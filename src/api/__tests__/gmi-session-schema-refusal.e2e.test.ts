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

  it.each([
    { kind: 'text', refusal: REFUSAL },
    { kind: 'lifted object', refusal: REFUSAL },
    { kind: 'no text', refusal: REFUSAL },
    // A Responses refusal part with an empty message beside output text is still a refusal.
    { kind: 'text', refusal: '' },
  ] as const)(
    'rejects a refused $kind answer (refusal $refusal) with ObjectGenerationError and the refusal before checking the schema, keeping nothing',
    async ({ kind, refusal }) => {
      provider.chunks = [
        ...(kind === 'text' ? [{ responseTextDelta: GOOD }] : []),
        {
          isFinal: true,
          ...(kind === 'lifted object' ? { structuredOutput: JSON.parse(GOOD) } : {}),
          choices: [{ index: 0, message: { role: 'assistant', content: kind === 'text' ? GOOD : null }, finishReason: 'stop', refusal }],
        },
      ];
      const validate = vi.fn(() => true);
      const runtime = gmi({ provider: 'openai', model: 'stub-model', apiKey: 'test', fallbackProviders: [] });
      try {
        const session = runtime.session('planner');
        const error = await session.send('plan my week', {
          responseSchema: week.refine(validate),
        }).then(() => undefined, (reason: unknown) => reason);
        expect(error).toBeInstanceOf(ObjectGenerationError);
        expect(error).toMatchObject({ refusal, message: 'session.send: the model refused the request instead of writing the object' });
        expect(validate).not.toHaveBeenCalled();
        expect(provider.calls).toBe(1);
        expect(session.messages()).toEqual([]);
      } finally {
        await runtime.close();
      }
    },
  );

  it('reports a refused answer beside a lifted object with the text the model wrote, not the object, on send and stream', async () => {
    // No schema on the turn: the provider's chunk carries a value beside its refusal. A refused step's value is no
    // answer, so the result's text is only what the model wrote beside the refusal (here nothing), as generateText's.
    provider.chunks = [
      {
        isFinal: true,
        structuredOutput: JSON.parse(GOOD),
        choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: 'stop', refusal: REFUSAL }],
      },
    ];
    const runtime = gmi({ provider: 'openai', model: 'stub-model', apiKey: 'test', fallbackProviders: [] });
    try {
      const session = runtime.session('planner');
      const sent = await session.send('plan my week');
      expect(sent).toMatchObject({ text: '', refusal: REFUSAL });
      const streamed = session.stream('plan my week');
      expect(await streamed.text).toBe('');
      expect(await streamed.refusal).toBe(REFUSAL);
    } finally {
      await runtime.close();
    }
  });
});
