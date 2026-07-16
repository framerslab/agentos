/**
 * @file generateObject.test.ts
 * Tests for the Zod-validated structured output generation API.
 *
 * Mocks the underlying model resolution and provider layer to exercise
 * JSON extraction, schema validation, retry logic, and error propagation
 * without hitting real LLM endpoints.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mock setup — hoist provider mocks so they're available before imports
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletion,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'test-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { generateObject, ObjectGenerationError } from '../generateObject.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock completion response whose assistant message contains `text`.
 */
function mockResponse(text: string, usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }) {
  return {
    modelId: 'gpt-4o',
    usage,
    choices: [
      {
        message: { role: 'assistant', content: text },
        finishReason: 'stop',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateObject', () => {
  const personSchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
  });

  it('parses valid JSON and validates against the Zod schema', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "Alice", "age": 28}'),
    );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.object).toEqual({ name: 'Alice', age: 28 });
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.totalTokens).toBe(15);
  });

  it('forwards effort through generateText to the provider options', async () => {
    hoisted.generateCompletion.mockResolvedValue(mockResponse('{"name": "Alice", "age": 28}'));

    await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
      effort: 'max',
    });

    // generateText calls provider.generateCompletion(modelId, messages, options);
    // without the generateObject -> generateText effort forward, options.effort is undefined.
    const callArgs = hoisted.generateCompletion.mock.calls[0];
    const providerOptions = callArgs[2] as { effort?: string };
    expect(providerOptions.effort).toBe('max');
  });

  it('forwards sessionId through generateText to the provider options', async () => {
    hoisted.generateCompletion.mockResolvedValue(mockResponse('{"name": "Alice", "age": 28}'));

    await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
      sessionId: 'bp-1234',
    });

    // Same forwarding contract as effort/cache: generateObject -> generateText
    // -> ModelCompletionOptions.sessionId (OpenRouter emits it as session_id
    // for provider sticky routing; other providers ignore it).
    const callArgs = hoisted.generateCompletion.mock.calls[0];
    const providerOptions = callArgs[2] as { sessionId?: string };
    expect(providerOptions.sessionId).toBe('bp-1234');
  });

  it('omits sessionId from provider options when the caller did not set it', async () => {
    hoisted.generateCompletion.mockResolvedValue(mockResponse('{"name": "Alice", "age": 28}'));

    await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    const callArgs = hoisted.generateCompletion.mock.calls[0];
    const providerOptions = callArgs[2] as { sessionId?: string };
    expect(providerOptions.sessionId).toBeUndefined();
  });

  it('surfaces fallback.fired when the underlying generateText fell back', async () => {
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValueOnce(mockResponse('{"name": "Alice", "age": 28}'));

    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      const result = await generateObject({ schema: personSchema, prompt: 'Extract person info' });
      expect(result.object).toEqual({ name: 'Alice', age: 28 });
      expect(result.fallback?.fired).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      globalLLMProviderHealth.reset();
    }
  });

  it('keeps fallback.fired = true across retries even when the final attempt recovers on the primary', async () => {
    globalLLMProviderHealth.reset();
    hoisted.generateCompletion
      .mockRejectedValueOnce(new Error('429 rate limit exceeded')) // attempt 0 primary fails -> falls back
      .mockResolvedValueOnce(mockResponse('{"name": "NoAge"}')) // attempt 0 fallback: Zod-invalid (missing age)
      .mockResolvedValueOnce(mockResponse('{"name": "Alice", "age": 28}')); // attempt 1 primary: valid

    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      const result = await generateObject({ schema: personSchema, prompt: 'x' });
      expect(result.object).toEqual({ name: 'Alice', age: 28 });
      // Attempt 0 fell back (degraded) before attempt 1 recovered on the
      // primary; the degradation must stay visible to the caller.
      expect(result.fallback?.fired).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      globalLLMProviderHealth.reset();
    }
  });

  it('propagates cacheReadTokens + cacheCreationTokens from the provider', async () => {
    // Anthropic provider surfaces cache_read_input_tokens +
    // cache_creation_input_tokens on every cached call; generateText
    // translates them to cacheReadTokens + cacheCreationTokens on its
    // TokenUsage result. generateObject's accumulator must forward
    // those fields — without this, every generateObject caller sees
    // usage.cacheReadTokens as undefined even on hits, which blinds
    // cost trackers to prompt-cache savings.
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "Cached", "age": 40}', {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 20,
      } as unknown as { promptTokens: number; completionTokens: number; totalTokens: number }),
    );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.usage.cacheReadTokens).toBe(80);
    expect(result.usage.cacheCreationTokens).toBe(20);
  });

  it('accumulates cache tokens across retry attempts', async () => {
    // First attempt: cache miss (writes to cache). Second attempt:
    // cache hit. The aggregated usage should sum both so downstream
    // cost savings math reflects the full call.
    hoisted.generateCompletion
      .mockResolvedValueOnce(
        mockResponse('{"name": "Bad",', {
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 90,
        } as unknown as { promptTokens: number; completionTokens: number; totalTokens: number }),
      )
      .mockResolvedValueOnce(
        mockResponse('{"name": "Fixed", "age": 30}', {
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          cacheReadInputTokens: 85,
          cacheCreationInputTokens: 0,
        } as unknown as { promptTokens: number; completionTokens: number; totalTokens: number }),
      );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.object).toEqual({ name: 'Fixed', age: 30 });
    expect(result.usage.cacheReadTokens).toBe(85);
    expect(result.usage.cacheCreationTokens).toBe(90);
  });

  it('leaves cache-token fields undefined when provider does not report them', async () => {
    // OpenAI auto-caches but does not surface per-call counters. The
    // provider's usage has no cacheReadInputTokens; generateObject must
    // NOT invent a zero for that case — callers rely on undefined to
    // decide whether to hide cache UI for the run.
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "NoCache", "age": 25}'),
    );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.usage.cacheReadTokens).toBeUndefined();
    expect(result.usage.cacheCreationTokens).toBeUndefined();
  });

  it('extracts JSON from code fences when the model wraps output', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('Here is the result:\n```json\n{"name": "Bob", "age": 42}\n```'),
    );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.object).toEqual({ name: 'Bob', age: 42 });
  });

  it('extracts JSON from bare code fences (no json annotation)', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('```\n{"name": "Carol", "age": 19}\n```'),
    );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.object).toEqual({ name: 'Carol', age: 19 });
  });

  it('extracts JSON embedded in prose by finding outer braces', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('Sure! The answer is {"name": "Dave", "age": 55} — hope that helps!'),
    );

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
    });

    expect(result.object).toEqual({ name: 'Dave', age: 55 });
  });

  it('retries on malformed JSON then succeeds on the second attempt', async () => {
    // First call returns broken JSON; second returns valid JSON
    hoisted.generateCompletion
      .mockResolvedValueOnce(mockResponse('{"name": "Eve", "age":'))
      .mockResolvedValueOnce(mockResponse('{"name": "Eve", "age": 31}'));

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
      maxRetries: 2,
    });

    expect(result.object).toEqual({ name: 'Eve', age: 31 });
    // Should have been called twice: initial attempt + 1 retry
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    // Usage should be aggregated across attempts
    expect(result.usage.totalTokens).toBe(30);
  });

  it('retries on Zod validation failure then succeeds', async () => {
    // First call returns JSON that doesn't match schema (age is a string)
    hoisted.generateCompletion
      .mockResolvedValueOnce(mockResponse('{"name": "Frank", "age": "thirty"}'))
      .mockResolvedValueOnce(mockResponse('{"name": "Frank", "age": 30}'));

    const result = await generateObject({
      schema: personSchema,
      prompt: 'Extract person info',
      maxRetries: 1,
    });

    expect(result.object).toEqual({ name: 'Frank', age: 30 });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
  });

  it('throws ObjectGenerationError after maxRetries exhausted with bad JSON', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('This is not JSON at all'),
    );

    await expect(
      generateObject({
        schema: personSchema,
        prompt: 'Extract person info',
        maxRetries: 1,
      }),
    ).rejects.toThrow(ObjectGenerationError);

    // 1 initial + 1 retry = 2 calls
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
  });

  it('throws ObjectGenerationError with rawText and validationErrors after schema failures', async () => {
    // Always returns wrong types — age as string
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": 123, "age": "young"}'),
    );

    try {
      await generateObject({
        schema: personSchema,
        prompt: 'Extract person info',
        maxRetries: 0,
      });
      // Should not reach here
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ObjectGenerationError);
      const ogErr = err as ObjectGenerationError;
      expect(ogErr.rawText).toBe('{"name": 123, "age": "young"}');
      expect(ogErr.validationErrors).toBeDefined();
    }
  });

  it('uses maxRetries: 2 by default', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('not json'),
    );

    await expect(
      generateObject({
        schema: personSchema,
        prompt: 'Extract person info',
        // maxRetries defaults to 2
      }),
    ).rejects.toThrow(ObjectGenerationError);

    // 1 initial + 2 retries = 3 calls
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(3);
  });

  it('passes schemaName and schemaDescription through to the system prompt', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "Grace", "age": 25}'),
    );

    await generateObject({
      schema: personSchema,
      schemaName: 'PersonRecord',
      schemaDescription: 'A person extracted from text.',
      prompt: 'Extract person info',
    });

    // Verify the system prompt was constructed with schema info by
    // inspecting the first call's messages argument
    const messages = hoisted.generateCompletion.mock.calls[0][1];
    const systemMsg = messages.find((m: Record<string, unknown>) => m.role === 'system');
    expect(systemMsg?.content).toContain('PersonRecord');
    expect(systemMsg?.content).toContain('A person extracted from text.');
    expect(systemMsg?.content).toContain('JSON Schema');
  });

  it('preserves user-supplied system prompt alongside schema instructions', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "Hana", "age": 22}'),
    );

    await generateObject({
      schema: personSchema,
      system: 'You are an expert data extractor.',
      prompt: 'Extract person info',
    });

    const messages = hoisted.generateCompletion.mock.calls[0][1];
    const systemMsg = messages.find((m: Record<string, unknown>) => m.role === 'system');
    expect(systemMsg?.content).toContain('You are an expert data extractor.');
    expect(systemMsg?.content).toContain('JSON Schema');
  });

  describe('top-level array schema (envelope wrap)', () => {
    // Regression for the 2026-05-10 user report: passing
    // `schema: z.array(...)` made gpt-4o consistently return
    // `{"<schemaName>":[...]}` (because OpenAI structured-output
    // requires a top-level object) and the bare-array Zod schema
    // rejected it as "expected array, received object". Repro from
    // wilds-ai's import/extract route — now generateObject wraps
    // arrays internally so callers never have to know about the
    // OpenAI quirk.
    const characterSchema = z.array(z.object({ name: z.string() }));

    it('accepts a top-level z.array() schema and unwraps the envelope', async () => {
      hoisted.generateCompletion.mockResolvedValue(
        mockResponse('{"items": [{"name": "Vegeta"}, {"name": "Goku"}]}'),
      );

      const result = await generateObject({
        schema: characterSchema,
        schemaName: 'Characters',
        prompt: 'Extract characters',
      });

      // Caller gets the bare array shape, not the wrapped envelope.
      expect(result.object).toEqual([{ name: 'Vegeta' }, { name: 'Goku' }]);
    });

    it('appends "Envelope" to the schemaName so the LLM returns the wrapped shape', async () => {
      hoisted.generateCompletion.mockResolvedValue(
        mockResponse('{"items": []}'),
      );

      await generateObject({
        schema: characterSchema,
        schemaName: 'Characters',
        prompt: 'Extract',
      });

      const messages = hoisted.generateCompletion.mock.calls[0][1];
      const systemMsg = messages.find((m: Record<string, unknown>) => m.role === 'system');
      // The wrapped envelope's name leaks into the schema instruction
      // so the model knows it's producing an object with `items` not
      // a bare array.
      expect(systemMsg?.content).toContain('CharactersEnvelope');
      expect(systemMsg?.content).toContain('items');
    });

    it('still validates array contents — rejects items that fail the inner schema', async () => {
      // age is a number in the schema; LLM returns a string.
      const peopleSchema = z.array(z.object({ name: z.string(), age: z.number() }));
      hoisted.generateCompletion.mockResolvedValue(
        mockResponse('{"items": [{"name": "X", "age": "not-a-number"}]}'),
      );

      await expect(
        generateObject({
          schema: peopleSchema,
          prompt: 'Extract',
          maxRetries: 0,
        }),
      ).rejects.toThrow(ObjectGenerationError);
    });

    it('does not wrap when the caller already passes z.object({ items: z.array(...) })', async () => {
      // User-supplied envelope shape — no double-wrapping; result
      // surfaces as-is.
      const wrappedSchema = z.object({ items: z.array(z.string()) });
      hoisted.generateCompletion.mockResolvedValue(
        mockResponse('{"items": ["a", "b"]}'),
      );

      const result = await generateObject({
        schema: wrappedSchema,
        prompt: 'Extract',
      });

      expect(result.object).toEqual({ items: ['a', 'b'] });
    });
  });

  it('accepts SystemContentBlock[] and preserves caller cache breakpoints', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "Iris", "age": 33}'),
    );

    await generateObject({
      schema: personSchema,
      system: [
        { text: 'You are an expert data extractor.', cacheBreakpoint: true },
        { text: 'Focus on the latest document.' },
      ],
      prompt: 'Extract person info',
    });

    // When SystemContentBlock[] is passed, generateText converts it to a
    // content parts array with cache_control on cached blocks. Verify the
    // caller's cache breakpoint survived and the schema block was appended.
    const messages = hoisted.generateCompletion.mock.calls[0][1];
    const systemMsg = messages.find((m: Record<string, unknown>) => m.role === 'system');
    const parts = systemMsg?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: 'You are an expert data extractor.',
      cache_control: { type: 'ephemeral' },
    });
    expect(parts[1]).toMatchObject({ type: 'text', text: 'Focus on the latest document.' });
    expect(parts[1]).not.toHaveProperty('cache_control');
    // Trailing schema block must be present AND cached so repeat calls with
    // the same schema hit the cache.
    const last = parts[parts.length - 1];
    expect(last.text).toContain('JSON Schema');
    expect(last).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('threads cacheTtl 1h through to the converted cache_control', async () => {
    hoisted.generateCompletion.mockResolvedValue(
      mockResponse('{"name": "Iris", "age": 33}'),
    );

    await generateObject({
      schema: personSchema,
      system: [
        { text: 'Stable session prefix.', cacheBreakpoint: true, cacheTtl: '1h' },
        { text: 'Dynamic per-turn state.' },
      ],
      prompt: 'Extract person info',
    });

    const messages = hoisted.generateCompletion.mock.calls[0][1];
    const systemMsg = messages.find((m: Record<string, unknown>) => m.role === 'system');
    const parts = systemMsg?.content as Array<Record<string, unknown>>;
    // The 1h TTL rides the cache_control marker so a slow-cadence prefix stays
    // cached across human-paced turns instead of expiring at 5 minutes.
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: 'Stable session prefix.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(parts[1]).not.toHaveProperty('cache_control');
  });

  describe('provider-specific structured-output routing (2026-05-28)', () => {
    // Before this slice, only openai got native structured-output via the
    // strict `json_schema` response_format. Anthropic / Gemini fell through
    // to prompt-only enforcement — strict Zod schemas with .refine()
    // invariants reliably failed structured output even with retries
    // because the model was not actually constrained. generateObject now
    // routes through buildResponseFormat() for anthropic + gemini so the
    // provider implementation receives the native structured-output payload
    // (anthropic forced tool_use, gemini responseSchema).

    it('forwards anthropic forced tool_use payload to provider for anthropic models', async () => {
      const { resolveModelOption } = await import('../../model.js');
      vi.mocked(resolveModelOption).mockReturnValueOnce({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      hoisted.generateCompletion.mockResolvedValueOnce(
        mockResponse('{"name": "Z", "age": 1}'),
      );

      await generateObject({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        schema: personSchema,
        schemaName: 'PersonInfo',
        prompt: 'Extract',
      });

      const args = hoisted.generateCompletion.mock.calls[0][2];
      expect(args.responseFormat).toMatchObject({
        _agentosUseToolForStructuredOutput: true,
        tool: {
          name: 'PersonInfo',
          input_schema: expect.objectContaining({ type: 'object' }),
        },
      });
    });

    it('routes Fable to the prompt-JSON path (no forced tool_use) since Fable rejects forced tool_choice', async () => {
      // Claude Fable rejects a forced tool_choice at the API level
      // ("tool_choice forces tool use is not compatible with this model").
      // generateObject must detect that and fall through to the prompt-only
      // JSON path (schema already lives in the system prompt; the result text
      // is extractJson + safeParse'd in the retry loop) instead of sending a
      // forced tool the model 400s on.
      const { resolveModelOption } = await import('../../model.js');
      vi.mocked(resolveModelOption).mockReturnValueOnce({
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
      });
      hoisted.generateCompletion.mockResolvedValueOnce(
        mockResponse('{"name": "F", "age": 5}'),
      );

      const { object } = await generateObject({
        provider: 'anthropic',
        model: 'claude-fable-5',
        schema: personSchema,
        schemaName: 'PersonInfo',
        prompt: 'Extract',
      });

      // No forced tool payload — falls through to prompt-only JSON.
      const args = hoisted.generateCompletion.mock.calls[0][2];
      expect(args.responseFormat).toBeUndefined();
      // The prompt-JSON path still produces a validated object.
      expect(object).toEqual({ name: 'F', age: 5 });
    });

    it('forwards Gemini responseSchema payload to provider for gemini models', async () => {
      const { resolveModelOption } = await import('../../model.js');
      vi.mocked(resolveModelOption).mockReturnValueOnce({
        providerId: 'gemini',
        modelId: 'gemini-2.5-pro',
      });
      hoisted.generateCompletion.mockResolvedValueOnce(
        mockResponse('{"name": "Y", "age": 2}'),
      );

      await generateObject({
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        schema: personSchema,
        prompt: 'Extract',
      });

      const args = hoisted.generateCompletion.mock.calls[0][2];
      expect(args.responseFormat).toMatchObject({
        type: 'json_object',
        _gemini: { responseSchema: expect.objectContaining({ type: 'object' }) },
      });
    });

    it('keeps OpenAI strict json_schema payload for openai models (regression check)', async () => {
      const { resolveModelOption } = await import('../../model.js');
      vi.mocked(resolveModelOption).mockReturnValueOnce({
        providerId: 'openai',
        modelId: 'gpt-4o',
      });
      hoisted.generateCompletion.mockResolvedValueOnce(
        mockResponse('{"name": "X", "age": 3}'),
      );

      await generateObject({
        schema: personSchema,
        schemaName: 'PersonInfo',
        prompt: 'Extract',
      });

      const args = hoisted.generateCompletion.mock.calls[0][2];
      expect(args.responseFormat).toMatchObject({
        type: 'json_schema',
        json_schema: { name: 'PersonInfo', strict: true },
      });
    });

    it('upgrades openrouter to strict json_schema when the schema is strict-compatible (regression check)', async () => {
      // Pre-0.9.113 this asserted json_object; the schema-enforced OpenRouter
      // structured-output change routes strict-compatible schemas through the
      // OpenAI-shaped json_schema payload (with require_parameters routing at
      // the provider layer). Strict-INcompatible schemas (e.g. z.record) still
      // degrade to json_object — covered by responseFormatForProvider.test.ts.
      const { resolveModelOption } = await import('../../model.js');
      vi.mocked(resolveModelOption).mockReturnValueOnce({
        providerId: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4-6',
      });
      hoisted.generateCompletion.mockResolvedValueOnce(
        mockResponse('{"name": "W", "age": 4}'),
      );

      await generateObject({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-6',
        schema: personSchema,
        prompt: 'Extract',
      });

      const args = hoisted.generateCompletion.mock.calls[0][2];
      expect(args.responseFormat).toMatchObject({ type: 'json_schema' });
      expect(args.responseFormat.json_schema.strict).toBe(true);
    });
  });

  describe('truncation-aware retry (finishReason: length)', () => {
    // A response cut off at the output-token limit produces unterminated JSON;
    // extractJson throws, and the legacy retry re-ran with the SAME budget →
    // it truncated again → exhausted → ObjectGenerationError. generateObject
    // now detects finishReason 'length' and ESCALATES maxTokens on the next
    // attempt (the provider layer clamps it to the model's real ceiling), so a
    // truncated structured-output call self-heals instead of hard-failing.
    function truncatedResponse(text: string) {
      return {
        modelId: 'gpt-4o',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        choices: [{ message: { role: 'assistant', content: text }, finishReason: 'length' }],
      };
    }

    it('escalates the token budget after a truncated attempt, then succeeds', async () => {
      hoisted.generateCompletion
        .mockResolvedValueOnce(truncatedResponse('{"name": "Eve", "age":')) // cut off mid-JSON
        .mockResolvedValueOnce(mockResponse('{"name": "Eve", "age": 31}')); // complete

      const result = await generateObject({
        schema: personSchema,
        prompt: 'Extract person info',
        maxRetries: 2,
      });

      expect(result.object).toEqual({ name: 'Eve', age: 31 });
      const firstBudget = hoisted.generateCompletion.mock.calls[0][2].maxTokens as number;
      const secondBudget = hoisted.generateCompletion.mock.calls[1][2].maxTokens as number;
      expect(secondBudget).toBeGreaterThan(firstBudget);
    });

    it('does NOT escalate on a non-truncated parse failure (finishReason stop)', async () => {
      // Malformed-but-complete JSON is a content error, not a budget problem —
      // more tokens won't help, so the budget must stay flat (only corrective
      // feedback is appended).
      hoisted.generateCompletion
        .mockResolvedValueOnce(mockResponse('{"name": "Eve", "age":')) // finishReason 'stop'
        .mockResolvedValueOnce(mockResponse('{"name": "Eve", "age": 31}'));

      await generateObject({ schema: personSchema, prompt: 'Extract person info', maxRetries: 2 });

      const firstBudget = hoisted.generateCompletion.mock.calls[0][2].maxTokens as number;
      const secondBudget = hoisted.generateCompletion.mock.calls[1][2].maxTokens as number;
      expect(secondBudget).toBe(firstBudget);
    });
  });
});

describe('generateObject fallback-leg responseFormat rebuild (2026-07-07)', () => {
  beforeEach(() => {
    hoisted.generateCompletion.mockReset();
    globalLLMProviderHealth.reset();
  });

  it('record schema, anthropic primary down -> openai leg gets json_object and output parses', async () => {
    const { resolveModelOption, resolveProvider } = await import('../../model.js');
    // Echo the requested provider/model through resolution so the anthropic
    // primary and the openai leg each resolve as themselves.
    vi.mocked(resolveModelOption).mockImplementation(
      (opts: { provider?: string; model?: string }) => ({
        providerId: opts?.provider ?? 'openai',
        modelId: opts?.model ?? 'gpt-4o',
      }),
    );
    vi.mocked(resolveProvider).mockImplementation(
      (providerId: string, modelId: string) => ({
        providerId,
        modelId: modelId || 'default-model',
        apiKey: 'test-key',
      }),
    );
    try {
      hoisted.generateCompletion.mockImplementation(async (modelId: string) => {
        if (modelId === 'gpt-4o-mini') {
          return mockResponse('{"palette": {"primary": "#aabbcc"}}');
        }
        throw new Error('503 overloaded');
      });
      // z.record lowers to a schema-valued additionalProperties -> fails the
      // strict gate on the openai leg -> json_object degrade (the exact
      // MechanicsComposition shape from the 2026-07-07 incident).
      const schema = z.object({ palette: z.record(z.string(), z.string()) });

      const result = await generateObject({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        prompt: 'Compose',
        schema,
        fallbackProviders: [{ provider: 'openai', model: 'gpt-4o-mini' }],
        maxRetries: 0,
      });

      expect(result.object).toEqual({ palette: { primary: '#aabbcc' } });
      const calls = hoisted.generateCompletion.mock.calls as unknown[][];
      // Primary call carried the anthropic forced-tool marker…
      const primaryOptions = (calls.find((c) => c[0] === 'claude-opus-4-8')?.[2] ?? {}) as {
        responseFormat?: Record<string, unknown>;
      };
      expect(primaryOptions.responseFormat?._agentosUseToolForStructuredOutput).toBe(true);
      // …and the openai LEG was rebuilt to json_object (record schema fails
      // the strict gate), NOT the verbatim anthropic marker.
      const legOptions = (calls.find((c) => c[0] === 'gpt-4o-mini')?.[2] ?? {}) as {
        responseFormat?: Record<string, unknown>;
      };
      expect(legOptions.responseFormat).toEqual({ type: 'json_object' });
    } finally {
      vi.mocked((await import('../../model.js')).resolveModelOption).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4o',
      }));
      vi.mocked((await import('../../model.js')).resolveProvider).mockImplementation(() => ({
        providerId: 'openai',
        modelId: 'gpt-4o',
        apiKey: 'test-key',
      }));
      globalLLMProviderHealth.reset();
    }
  });
});
