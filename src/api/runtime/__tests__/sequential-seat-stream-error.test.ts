/**
 * @file sequential-seat-stream-error.test.ts
 * A streamed sequential agency whose seat's call fails. `streamText` reports
 * the failure as an error part of `fullStream`, which `textStream` leaves
 * out, so the strategy reads that seat's parts: the error reaches the
 * agency's stream as an error part that names the seat, as the seat masked
 * it when the seat carries a mask, and the next seat still runs.
 *
 * Runs the real `agency()`, strategy, `agent()` and `streamText`; only the
 * provider manager is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const generateCompletionStream = vi.fn();
  const createProviderManager = vi.fn(async () => ({
    getProvider: () => ({ generateCompletionStream }),
  }));
  return { generateCompletionStream, createProviderManager };
});

vi.mock('../../model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../model.js')>()),
  createProviderManager: hoisted.createProviderManager,
}));

import { agency } from '../../agency.js';
import { compileSequential } from '../strategies/sequential.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import type { AgencyOptions } from '../../types.js';
import type { SeatedConfig } from '../pool/seating.js';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const failure = (message: string) => Object.assign(new Error(`[500] ${message}`), { httpStatus: 500 });

/** A step's only chunk: the whole reply, final, with usage. */
function textChunk(text: string) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 1,
    modelId: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
    responseTextDelta: text,
    isFinal: true,
    usage,
  };
}

type Part = { type: string; agent?: string; text?: string; error?: Error };
async function drain(stream: AsyncIterable<unknown> | undefined): Promise<Part[]> {
  const parts: Part[] = [];
  if (stream) for await (const part of stream) parts.push(part as Part);
  return parts;
}

beforeEach(() => {
  hoisted.generateCompletionStream.mockReset();
  globalLLMProviderHealth.reset();
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a streamed sequential agency whose seat fails', () => {
  it('yields the seat error as an error part, records the failed call and goes on to the next seat', async () => {
    hoisted.generateCompletionStream
      .mockImplementationOnce(async function* () { throw failure('upstream down'); })
      .mockImplementationOnce(async function* () { yield textChunk('second answers'); });
    const team = agency({
      provider: 'openai',
      model: 'gpt-5.5',
      strategy: 'sequential',
      // An empty chain: the failed seat has no other provider to move to.
      agents: {
        one: { instructions: 'First.', fallbackProviders: [] },
        two: { instructions: 'Second.', fallbackProviders: [] },
      },
    });
    const stream = team.stream('go') as unknown as {
      fullStream: AsyncIterable<unknown>;
      agentCalls: Promise<Array<Record<string, unknown>>>;
    };
    const parts = await drain(stream.fullStream);

    const errors = parts.filter((p) => p.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].agent).toBe('one');
    expect(errors[0].error?.message).toContain('upstream down');
    // The second seat ran after the first one failed.
    expect(hoisted.generateCompletionStream).toHaveBeenCalledTimes(2);
    expect(parts.filter((p) => p.type === 'text').map((p) => p.text).join('')).toBe('second answers');
    // Both calls are recorded, each with the provider and model it ran on.
    expect(await stream.agentCalls).toMatchObject([
      { agent: 'one', output: '', provider: 'openai', model: 'gpt-5.5', finishReason: 'error' },
      { agent: 'two', output: 'second answers', provider: 'openai', model: 'gpt-5.5', finishReason: 'stop' },
    ]);
  });

  it('yields a seated seat error part as the seat masked it', async () => {
    const SECRET = 'sk-seat-secret-00000001';
    const redact = (text: string): string => text.split(SECRET).join('[redacted]');
    /** A seat's mask: a string comes back redacted, an error with its message and stack redacted. */
    const mask = (value: unknown): unknown => {
      if (typeof value === 'string') return redact(value);
      if (value instanceof Error) {
        value.message = redact(value.message);
        if (typeof value.stack === 'string') value.stack = redact(value.stack);
      }
      return value;
    };
    hoisted.generateCompletionStream.mockImplementationOnce(async function* () {
      throw failure(`rejected key ${SECRET} by upstream`);
    });
    // A config as an agency's seating writes it: resolved, strict, with the call's mask.
    const seated: SeatedConfig = {
      instructions: 'Only seat.',
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackProviders: [],
      __strictCredentials: true,
      __maskError: mask,
    };
    const options = { agents: { one: seated }, strategy: 'sequential' } as AgencyOptions;
    const parts = await drain(compileSequential({ one: seated }, options).stream('go', {}).fullStream);

    const error = parts.find((p) => p.type === 'error')?.error;
    expect(error?.message).toBe('[500] rejected key [redacted] by upstream');
    expect(error?.stack ?? '').not.toContain(SECRET);
  });
});
