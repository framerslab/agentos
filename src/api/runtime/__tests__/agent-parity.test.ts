import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const hoisted = vi.hoisted(() => {
  const generateCompletion = vi.fn();
  const generateCompletionStream = vi.fn();
  const getProvider = vi.fn(() => ({ generateCompletion, generateCompletionStream }));
  const createProviderManager = vi.fn(async () => ({ getProvider }));
  return { generateCompletion, generateCompletionStream, createProviderManager };
});

vi.mock('../../model.js', () => ({
  resolveModelOption: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  resolveProvider: vi.fn(() => ({ providerId: 'openai', modelId: 'gpt-4.1-mini' })),
  createProviderManager: hoisted.createProviderManager,
}));

import { agent } from '../../agent.js';
import { ObjectGenerationError } from '../../generateObject.js';
import { resetLoggerFactory, setLoggerFactory } from '../../../core/logging/loggerFactory.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';
import { getCapabilitySupport } from '../capabilityContract.js';
import { getDeferredLightweightAgentCapabilities } from '../lightweightAgentDiagnostics.js';

const base = { provider: 'openai', model: 'gpt-4.1-mini', fallbackProviders: [] };
const schema = z.object({ count: z.number() });
const answer = 'The reference implementation stores records.';
const embedFn = async (texts: string[]) => texts.map(() => [1, 0]);
const completion = (text: string) => ({
  modelId: base.model,
  usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
  choices: [{ message: { role: 'assistant', content: text }, finishReason: 'stop' }],
});
const messagesAt = (index: number) => hoisted.generateCompletion.mock.calls[index][1] as Array<{
  role: string;
  content: string;
}>;
const systemAt = (index: number) => messagesAt(index)
  .filter((message) => message.role === 'system')
  .map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
  .join('\n');

beforeEach(() => {
  hoisted.generateCompletion.mockReset().mockResolvedValue(completion(answer));
  hoisted.generateCompletionStream.mockReset();
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLoggerFactory();
});

describe('session citation verification', () => {
  it('grades send claims using sources retrieved for the original user text', async () => {
    const retrieve = vi.fn(async () => [{ content: answer, url: 'https://example.com/reference' }]);
    const session = agent({ ...base, verifyCitations: { embedFn, retrieve } }).session();
    const result = await session.send('What does the reference implementation do?');
    expect(retrieve).toHaveBeenCalledWith('What does the reference implementation do?');
    expect(result.grounding?.claims).toEqual([
      expect.objectContaining({ text: answer, verdict: 'supported', sourceRef: 'https://example.com/reference' }),
    ]);
  });

  it('keeps the reply without grounding when retrieval is not configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await agent({ ...base, verifyCitations: { embedFn } }).session().send('Read this.');
    expect(result.text).toBe(answer);
    expect(result.grounding).toBeUndefined();
  });

  it('settles stream grounding only after the last chunk, with and without history', async () => {
    for (const history of [undefined, false] as const) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const retrieve = vi.fn(async () => [{ content: answer }]);
      hoisted.generateCompletionStream.mockImplementation(async function* () {
        yield {
          id: 'first', object: 'chat.completion.chunk', created: 1, modelId: base.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'The reference ' } }],
          responseTextDelta: 'The reference ', isFinal: false,
        };
        await gate;
        yield {
          id: 'last', object: 'chat.completion.chunk', created: 1, modelId: base.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'implementation stores records.' }, finishReason: 'stop' }],
          responseTextDelta: 'implementation stores records.', isFinal: true,
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        };
      });
      const result = agent({ ...base, history, verifyCitations: { embedFn, retrieve } }).session().stream('Read this.');
      expect(result.grounding).toBeInstanceOf(Promise);
      let settled = false;
      void result.grounding?.then(() => { settled = true; });
      const iterator = result.textStream[Symbol.asyncIterator]();
      await iterator.next();
      expect(settled).toBe(false);
      expect(retrieve).not.toHaveBeenCalled();
      release();
      while (!(await iterator.next()).done) { /* drain */ }
      expect(await result.text).toBe(answer);
      expect((await result.grounding)?.supportedCount).toBe(1);
      expect(retrieve).toHaveBeenCalledWith('Read this.');
    }
  });
});

describe('schema validation retries', () => {
  it('retries send with validation feedback and keeps only the final exchange in history', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(completion('{"count":"invalid"}'))
      .mockResolvedValueOnce(completion('{"count":2}'));
    const retrieve = vi.fn(async () => [{ content: 'Two records.' }]);
    const session = agent({ ...base, verifyCitations: { embedFn, retrieve } }).session();
    const result = await session.send('Count records.', { responseSchema: schema, maxValidationRetries: 1 });
    expect((result as { object?: unknown }).object).toEqual({ count: 2 });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    expect(messagesAt(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '{"count":"invalid"}' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Your reply did not match the schema:') }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('count') }),
    ]));
    expect(session.messages().map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Count records.' }, { role: 'assistant', content: '{"count":2}' },
    ]);
    expect((await session.usage()).totalTokens).toBe(16);
    expect(retrieve).toHaveBeenCalledExactlyOnceWith('Count records.');
  });

  it('stops send after its retry limit and leaves history unchanged', async () => {
    hoisted.generateCompletion.mockResolvedValue(completion('{"count":"invalid"}'));
    const session = agent(base).session();
    await expect(session.send('Count.', { responseSchema: schema, maxValidationRetries: 1 }))
      .rejects.toBeInstanceOf(ObjectGenerationError);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    expect(session.messages()).toEqual([]);
  });

  it('honors an explicit zero retry count on send', async () => {
    hoisted.generateCompletion.mockResolvedValue(completion('invalid JSON'));
    await expect(agent(base).session().send('Count.', { responseSchema: schema, maxValidationRetries: 0 }))
      .rejects.toBeInstanceOf(ObjectGenerationError);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('extracts and validates generate output, retrying once by default', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(completion('{"count":"invalid"}'))
      .mockResolvedValueOnce(completion('```json\n{"count":2}\n```'));
    const subject = agent({ ...base, responseSchema: schema });
    const result = await subject.generate('Count.');
    expect(result.parsed).toEqual({ count: 2 });
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(2);
    expect(messagesAt(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Count.' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('count') }),
    ]));
    expect((await subject.usage()).totalTokens).toBe(16);
  });

  it('honors controls.maxValidationRetries on generate', async () => {
    hoisted.generateCompletion.mockResolvedValue(completion('{"count":"invalid"}'));
    await expect(agent({ ...base, responseSchema: schema, controls: { maxValidationRetries: 0 } }).generate('Count.'))
      .rejects.toBeInstanceOf(ObjectGenerationError);
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('preserves multimodal input through send retries and stores it once', async () => {
    hoisted.generateCompletion
      .mockResolvedValueOnce(completion('{"count":"invalid"}'))
      .mockResolvedValueOnce(completion('{"count":2}'));
    const input = [{ type: 'text' as const, text: 'Count these records.' }];
    const session = agent(base).session();
    await session.send(input, { responseSchema: schema, maxValidationRetries: 1 });
    expect(messagesAt(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: input }),
    ]));
    expect(session.messages().map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: input }, { role: 'assistant', content: '{"count":2}' },
    ]);
  });

  it.each([-1, 0.5, Infinity, NaN])('rejects an invalid retry count %s before calling the provider', async (maxValidationRetries) => {
    await expect(agent(base).session().send('Count.', { responseSchema: schema, maxValidationRetries }))
      .rejects.toBeInstanceOf(RangeError);
    expect(hoisted.generateCompletion).not.toHaveBeenCalled();
  });

  it('does not retry a provider error as a schema error', async () => {
    hoisted.generateCompletion.mockRejectedValue(new Error('invalid request'));
    await expect(agent({ ...base, responseSchema: schema }).generate('Count.')).rejects.toThrow('invalid request');
    expect(hoisted.generateCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('working memory block', () => {
  it('marks memory partially enforced while still reporting deferred store settings', () => {
    expect(getCapabilitySupport('agent', 'memory')).toBe('partially_enforced');
    expect(getDeferredLightweightAgentCapabilities({ memory: { working: () => 'STATE' } })).toEqual([]);
    expect(getDeferredLightweightAgentCapabilities({ memory: { working: () => 'STATE', types: ['episodic'] } }))
      .toContain('memory');
    expect(getDeferredLightweightAgentCapabilities({ memory: { working: { enabled: true } } }))
      .toContain('memory');
  });

  it('prepends fresh state once per send, including a schema retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const working = vi.fn().mockReturnValueOnce('STATE: first').mockResolvedValueOnce('STATE: second');
    hoisted.generateCompletion
      .mockResolvedValueOnce(completion('invalid JSON'))
      .mockResolvedValueOnce(completion('{"count":1}'))
      .mockResolvedValueOnce(completion('{"count":2}'));
    const session = agent({ ...base, instructions: 'Count records.', memory: { working } }).session();
    await session.send('First.', { responseSchema: schema, maxValidationRetries: 1 });
    await session.send('Second.');
    expect(working).toHaveBeenCalledTimes(2);
    expect(systemAt(0).startsWith('STATE: first\n\nCount records.')).toBe(true);
    expect(systemAt(1).startsWith('STATE: first\n\nCount records.')).toBe(true);
    expect(systemAt(2).startsWith('STATE: second\n\nCount records.')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves structured system blocks when prepending working state', async () => {
    const systemBlocks = [{ text: 'Count records.', cacheBreakpoint: true }];
    await agent({ ...base, systemBlocks, memory: { working: () => 'STATE: current' } })
      .session().send('Count.');
    const system = messagesAt(0).find((message) => message.role === 'system');
    expect(system?.content).toEqual([
      { type: 'text', text: 'STATE: current' },
      { type: 'text', text: 'Count records.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(systemBlocks).toEqual([{ text: 'Count records.', cacheBreakpoint: true }]);
  });

  it.each(['throw', 'reject'])('skips a callback that fails by %s and warns through the host logger', async (failure) => {
    const warn = vi.fn();
    setLoggerFactory(() => ({ info: vi.fn(), warn, error: vi.fn() }));
    const working = vi.fn(() => {
      if (failure === 'throw') throw new Error('private callback detail');
      return Promise.reject(new Error('private callback detail'));
    });
    const result = await agent({ ...base, instructions: 'Count records.', memory: { working } }).session().send('Count.');
    expect(result.text).toBe(answer);
    expect(systemAt(0)).toBe('Count records.');
    expect(warn).toHaveBeenCalledExactlyOnceWith('memory.working failed; continuing without the working-memory block.');
  });
});
