/**
 * @fileoverview Request-shape tests for `options.effort` on OpenRouter.
 *
 * OpenRouter takes reasoning depth in a unified `reasoning` object on Chat
 * Completions (`reasoning: { effort }`, values `max`, `xhigh`, `high`,
 * `medium`, `low`, `minimal`, `none`), and maps a level the model does not
 * support to the nearest one it does:
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 *
 * The provider sends it for OpenAI reasoning slugs (`openai/o*`,
 * `openai/gpt-5*`, `openai/gpt-6*`), on the non-streaming and the streaming
 * builder alike; a caller's own `customModelParams.reasoning` wins; other
 * slugs keep their request unchanged.
 *
 * Requests are stubbed at the makeApiRequest seam, so nothing reaches the
 * network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { OpenRouterProvider } from '../OpenRouterProvider';
import type { ChatMessage } from '../../IProvider';

type ApiCall = [
  endpoint: string,
  method: string,
  timeout: number | undefined,
  payload: Record<string, unknown> | undefined,
  isStream: boolean | undefined,
];

function chatBody(model: string) {
  return {
    id: 'gen-1',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  };
}

async function makeProvider(model: string): Promise<{
  provider: OpenRouterProvider;
  calls: () => ApiCall[];
}> {
  const provider = new OpenRouterProvider();
  const seam = provider as unknown as {
    makeApiRequest: (
      endpoint: string,
      method: string,
      timeout?: number,
      payload?: Record<string, unknown>,
      isStream?: boolean,
    ) => Promise<unknown>;
  };
  const spy = vi
    .spyOn(seam, 'makeApiRequest')
    .mockImplementation(async (endpoint, _method, _timeout, _payload, isStream) => {
      if (endpoint === '/models') return { data: [] };
      if (isStream) return Readable.from(['data: [DONE]\n\n']);
      return chatBody(model);
    });
  await provider.initialize({ apiKey: 'sk-or-test' });
  return { provider, calls: () => spy.mock.calls as unknown as ApiCall[] };
}

function lastChatPayload(calls: ApiCall[]): Record<string, unknown> {
  const chat = calls.filter((c) => c[0] === '/chat/completions').at(-1);
  expect(chat).toBeDefined();
  return chat![3] as Record<string, unknown>;
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'You write code.' },
  { role: 'user', content: 'Plan the change.' },
];

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

async function sendCompletion(model: string, options: Record<string, unknown>) {
  const { provider, calls } = await makeProvider(model);
  await provider.generateCompletion(model, messages, options);
  return lastChatPayload(calls());
}

async function sendStream(model: string, options: Record<string, unknown>) {
  const { provider, calls } = await makeProvider(model);
  for await (const _chunk of provider.generateCompletionStream(model, messages, options)) {
    // drain
  }
  return lastChatPayload(calls());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenRouter options.effort', () => {
  it('sends reasoning.effort on a tool-bearing call to an OpenAI reasoning slug', async () => {
    const payload = await sendCompletion('openai/gpt-6.2-astra', { effort: 'xhigh', tools });
    expect(payload.reasoning).toEqual({ effort: 'xhigh' });
    expect(payload.tools).toEqual(tools);
  });

  it('sends reasoning.effort on the streaming builder too', async () => {
    const payload = await sendStream('openai/gpt-6.2-sol', { effort: 'low', tools });
    expect(payload.reasoning).toEqual({ effort: 'low' });
  });

  it('passes every agentos level through unchanged (OpenRouter maps to the nearest supported level)', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const payload = await sendCompletion('openai/gpt-6.2-astra', { effort });
      expect(payload.reasoning).toEqual({ effort });
    }
  });

  it('covers the o-series and GPT-5 slugs', async () => {
    expect((await sendCompletion('openai/o3', { effort: 'high' })).reasoning).toEqual({ effort: 'high' });
    expect((await sendCompletion('openai/gpt-5.6-sol', { effort: 'medium' })).reasoning).toEqual({
      effort: 'medium',
    });
  });

  it("leaves a caller's customModelParams.reasoning in charge", async () => {
    const payload = await sendCompletion('openai/gpt-6.2-astra', {
      effort: 'low',
      customModelParams: { reasoning: { effort: 'high', exclude: true } },
    });
    expect(payload.reasoning).toEqual({ effort: 'high', exclude: true });
  });

  it('omits reasoning when effort is unset or not an agentos level', async () => {
    expect('reasoning' in (await sendCompletion('openai/gpt-6.2-astra', {}))).toBe(false);
    expect('reasoning' in (await sendCompletion('openai/gpt-6.2-astra', { effort: 'ultra' }))).toBe(false);
  });

  it('keeps the request unchanged for slugs outside the OpenAI reasoning families', async () => {
    for (const model of ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct']) {
      expect('reasoning' in (await sendCompletion(model, { effort: 'high' }))).toBe(false);
    }
  });
});
