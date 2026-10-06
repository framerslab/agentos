/**
 * @file streamObject.test.ts
 * Tests for the streaming structured output API.
 *
 * Mocks the underlying model resolution and provider layer to exercise
 * incremental JSON parsing, partial object emission, final Zod validation,
 * and stream error handling without hitting real LLM endpoints.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mock setup — hoist provider mocks so they're available before imports
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return {
    generateCompletionStream,
    getProvider,
    createProviderManager,
  };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4o', apiKey: 'test-key' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { streamObject } from '../streamObject.js';
import { ObjectGenerationError } from '../generateObject.js';
import type { DeepPartial } from '../streamObject.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock streaming chunk that yields a text delta.
 * Simulates the shape produced by AIModelProviderManager.generateCompletionStream().
 */
function textChunk(text: string, opts: { isFinal?: boolean; usage?: Record<string, number> } = {}) {
  return {
    id: `chunk-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finishReason: opts.isFinal ? 'stop' : null,
      },
    ],
    responseTextDelta: text,
    isFinal: opts.isFinal ?? false,
    usage: opts.usage,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamObject', () => {
  const profileSchema = z.object({
    name: z.string(),
    age: z.number(),
    hobbies: z.array(z.string()),
  });

  beforeEach(() => {
    hoisted.generateCompletionStream.mockReset();
  });

  it('emits partial objects as JSON builds up and resolves the final validated object', async () => {
    // Simulate tokens arriving incrementally to build:
    // {"name": "Alice", "age": 28, "hobbies": ["reading", "hiking"]}
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('{"name": "Ali');
      yield textChunk('ce", "age": 28');
      yield textChunk(', "hobbies": ["reading"');
      yield textChunk(', "hiking"]}', {
        isFinal: true,
        usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
      });
    });

    const result = streamObject({
      schema: profileSchema,
      prompt: 'Create a profile',
    });

    // Collect all partial objects
    const partials: DeepPartial<z.infer<typeof profileSchema>>[] = [];
    for await (const partial of result.partialObjectStream) {
      partials.push(partial);
    }

    // Should have emitted at least one partial object
    expect(partials.length).toBeGreaterThanOrEqual(1);

    // The final partial should be the complete object
    const lastPartial = partials[partials.length - 1];
    expect(lastPartial).toMatchObject({
      name: 'Alice',
      age: 28,
      hobbies: ['reading', 'hiking'],
    });

    // The final validated object should match exactly
    const finalObject = await result.object;
    expect(finalObject).toEqual({
      name: 'Alice',
      age: 28,
      hobbies: ['reading', 'hiking'],
    });

    // Text should be the full raw JSON
    const text = await result.text;
    expect(text).toContain('"Alice"');
    expect(text).toContain('"hiking"');

    // Usage should be reported
    const usage = await result.usage;
    expect(usage.totalTokens).toBe(35);
  });

  it('yields progressively richer partial objects as more tokens arrive', async () => {
    // Deliberately slow token-by-token to show progressive parsing
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('{"name"');
      yield textChunk(': "Bob"');
      yield textChunk(', "age": ');
      yield textChunk('35');
      yield textChunk(', "hobbies": []');
      yield textChunk('}', {
        isFinal: true,
        usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
      });
    });

    const result = streamObject({
      schema: profileSchema,
      prompt: 'Create a profile',
    });

    const partials: DeepPartial<z.infer<typeof profileSchema>>[] = [];
    for await (const partial of result.partialObjectStream) {
      partials.push(structuredClone(partial));
    }

    // Earlier partials should have fewer fields than later ones
    expect(partials.length).toBeGreaterThanOrEqual(2);

    // Final object should validate
    const obj = await result.object;
    expect(obj).toEqual({ name: 'Bob', age: 35, hobbies: [] });
  });

  it('rejects the object promise when the final JSON does not match the Zod schema', async () => {
    // Stream a JSON that won't pass validation (age is a string)
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('{"name": "Charlie", "age": "old", "hobbies": ["chess"]}', {
        isFinal: true,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      });
    });

    const result = streamObject({
      schema: profileSchema,
      prompt: 'Create a profile',
    });

    // Drain the partial stream
    const partials: unknown[] = [];
    for await (const partial of result.partialObjectStream) {
      partials.push(partial);
    }

    // The object promise should reject with an ObjectGenerationError
    await expect(result.object).rejects.toThrow(ObjectGenerationError);
  });

  it('handles empty stream gracefully by rejecting the object promise', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('', {
        isFinal: true,
        usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
      });
    });

    const result = streamObject({
      schema: profileSchema,
      prompt: 'Create a profile',
    });

    // Drain partials (there may be none)
    for await (const _partial of result.partialObjectStream) {
      // drain
    }

    await expect(result.object).rejects.toThrow(ObjectGenerationError);
  });

  it('handles stream errors by rejecting promises instead of throwing', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('{"name": "Dan"');
      throw new Error('Connection lost');
    });

    const result = streamObject({
      schema: profileSchema,
      prompt: 'Create a profile',
    });

    // Drain partial stream — should not throw (error is caught internally)
    const partials: unknown[] = [];
    for await (const partial of result.partialObjectStream) {
      partials.push(partial);
    }

    // Object promise should reject
    await expect(result.object).rejects.toThrow(ObjectGenerationError);

    // Text and usage should still resolve (with partial/default values)
    const text = await result.text;
    expect(text).toContain('"Dan"');
  });
});

describe('streamObject — the schema text carries the Zod size checks (2026-10-03)', () => {
  beforeEach(() => {
    hoisted.generateCompletionStream.mockReset();
  });

  it('puts the size limits in the system prompt (streaming has no provider payload to carry them)', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('{"name": "A", "hobbies": ["x"]}', {
        isFinal: true,
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      });
    });
    const bounded = z.object({
      name: z.string().max(40),
      hobbies: z.array(z.string()).min(1).max(3),
    });

    const result = streamObject({ schema: bounded, prompt: 'Create a profile' });
    for await (const _partial of result.partialObjectStream) {
      // drain the stream so the provider call is made and the object resolves
    }
    await expect(result.object).resolves.toEqual({ name: 'A', hobbies: ['x'] });

    const messages = hoisted.generateCompletionStream.mock.calls[0][1];
    const systemMsg = messages.find((m: Record<string, unknown>) => m.role === 'system');
    const text =
      typeof systemMsg?.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg?.content);
    expect(text).toContain('"maxLength": 40');
    expect(text).toContain('"minItems": 1');
    expect(text).toContain('"maxItems": 3');
  });
});

describe('streamObject — reasoning options reach the provider', () => {
  beforeEach(() => {
    hoisted.generateCompletionStream.mockReset();
  });

  it('forwards effort and thinking through streamText', async () => {
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      yield textChunk('{"name": "A", "age": 3, "hobbies": []}', {
        isFinal: true,
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      });
    });
    const schema = z.object({ name: z.string(), age: z.number(), hobbies: z.array(z.string()) });

    const result = streamObject({ schema, prompt: 'Create a profile', effort: 'low', thinking: false });
    for await (const _partial of result.partialObjectStream) {
      // drain the stream so the provider call is made
    }
    await expect(result.object).resolves.toEqual({ name: 'A', age: 3, hobbies: [] });

    const providerOptions = hoisted.generateCompletionStream.mock.calls[0][2] as {
      effort?: string;
      thinking?: unknown;
    };
    expect(providerOptions.effort).toBe('low');
    expect(providerOptions.thinking).toBe(false);
  });
});
