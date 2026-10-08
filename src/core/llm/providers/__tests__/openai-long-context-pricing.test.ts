/**
 * @fileoverview OpenAI long-context billing.
 *
 * OpenAI bills a prompt of more than 272,000 input tokens on its 1.05M-context
 * models at 2x the input rate and 1.5x the output rate for the whole request
 * (developers.openai.com/api/docs/pricing and the model pages, 2026-09-30).
 * The cost cases run the real OpenAIProvider, and generateText / streamText on
 * top of it, with only fetch stubbed, and read costUSD from the usage each
 * path reports: Chat Completions, the /v1/responses route a tool call with an
 * effort takes, and the trailing usage chunk of a stream.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { generateText } from '../../../../api/generateText';
import { streamText } from '../../../../api/streamText';
import { globalLLMProviderHealth } from '../../../safety/LLMProviderHealthRegistry';
import { OpenAIProvider, openAiHasLongContextPricing } from '../implementations/OpenAIProvider';

/** Ids the mocked GET /v1/models lists. */
const LISTED_MODELS = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-4.1'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: unknown[]): Response {
  const text = events
    .map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Answers every GET with the model listing and each POST from the handler
 * whose endpoint the URL ends with. Any other POST gets a 404, which the
 * provider does not retry, so a call sent to the wrong endpoint fails at once
 * with the URL in the error.
 */
function serve(posts: Record<string, () => Response>): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({
        object: 'list',
        data: LISTED_MODELS.map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })),
      });
    }
    const handler = Object.entries(posts).find(([endpoint]) => target.endsWith(endpoint))?.[1];
    return handler
      ? handler()
      : jsonResponse({ error: { message: `unexpected POST ${target}`, type: 'invalid_request_error' } }, 404);
  });
}

/** URLs of every POST, in call order. */
function postedUrls(): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    .map(([url]) => String(url));
}

/** A Chat Completions body from `model` whose usage reports the given counts. */
function chatCompletion(model: string, promptTokens: number, completionTokens: number): Record<string, unknown> {
  return {
    id: 'chatcmpl-long-context',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** Consumes a text stream; streamText runs only while it is read. */
async function drain(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('openAiHasLongContextPricing', () => {
  // The 1.05M-context models, bare and dated.
  it.each([
    'gpt-6-astra',
    'gpt-6-sol-2026-09-03',
    'gpt-6.1-sol',
    'gpt-5.6',
    'gpt-5.6-terra',
    'gpt-5.5-pro',
    'gpt-5.4-pro-2026-03-05',
  ])('bills %s at the long-context rates above 272K input tokens', (model) => {
    expect(openAiHasLongContextPricing(model)).toBe(true);
  });

  // gpt-5.6-cyber has a 400K window and no long-context rate on the pricing
  // page, gpt-5.4-mini is the 400K sibling of a 1.05M model, and gpt-4.1 has
  // a 1M window but one flat rate.
  it.each(['gpt-5.6-cyber', 'gpt-5.4-mini', 'gpt-5.2', 'o3', 'gpt-4.1', 'gpt-4o'])(
    'bills %s flat at every prompt size',
    (model) => {
      expect(openAiHasLongContextPricing(model)).toBe(false);
    },
  );
});

describe('OpenAIProvider cost around the 272K threshold', () => {
  it.each([
    // 272,000 x $5 + 1,000 x $30 per 1M: the threshold itself bills standard.
    ['gpt-5.5', 'gpt-5.5', 272_000, 1_000, 1.39],
    // 272,001 x $10 + 1,000 x $45 per 1M: one token over doubles the input
    // rate and raises the output rate by half for the whole call.
    ['gpt-5.5', 'gpt-5.5', 272_001, 1_000, 2.76501],
    // Usage is costed from the dated snapshot id the response names.
    ['gpt-5.5', 'gpt-5.5-2026-04-23', 300_000, 0, 3.0],
    // 300,000 x $0.75 + 1,000 x $4.50 per 1M: a 400K model stays flat.
    ['gpt-5.4-mini', 'gpt-5.4-mini', 300_000, 1_000, 0.2295],
    // 500,000 x $2 per 1M: gpt-4.1 stays flat despite its 1M window.
    ['gpt-4.1', 'gpt-4.1', 500_000, 0, 1.0],
    // 1,000 x $2 + 1,000 x $10 per 1M: gpt-6.1-sol is metered, not undefined.
    ['gpt-6.1-sol', 'gpt-6.1-sol', 1_000, 1_000, 0.012],
    // 500,000 x $4 + 10,000 x $15 per 1M: gpt-6.1-sol carries the long-context tier.
    ['gpt-6.1-sol', 'gpt-6.1-sol', 500_000, 10_000, 2.15],
  ] as Array<[string, string, number, number, number]>)(
    '%s served as %s with %i prompt and %i completion tokens costs %f USD',
    async (model, served, promptTokens, completionTokens, usd) => {
      serve({ '/chat/completions': () => jsonResponse(chatCompletion(served, promptTokens, completionTokens)) });
      const provider = new OpenAIProvider();
      await provider.initialize({ apiKey: 'sk-long-context', maxRetries: 1 });

      const res = await provider.generateCompletion(model, [{ role: 'user', content: 'hi' }], {});

      expect(res.usage?.costUSD).toBeCloseTo(usd, 9);
    },
  );
});

describe('long-context cost on the generateText and streamText results', () => {
  const lookupTool = {
    lookup: {
      description: 'Looks up a passage in the corpus.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async ({ query }: { query: string }) => ({ query, passage: 'none' }),
    },
  };

  it('bills a gpt-6-sol tool call sent to /v1/responses at the long-context rates', async () => {
    serve({
      '/responses': () =>
        jsonResponse({
          id: 'resp_long_context',
          object: 'response',
          created_at: 1,
          model: 'gpt-6-sol',
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Summarized.' }] },
          ],
          usage: { input_tokens: 400_000, output_tokens: 2_000, total_tokens: 402_000 },
        }),
    });

    const result = await generateText({
      provider: 'openai',
      model: 'gpt-6-sol',
      apiKey: 'sk-long-context-responses',
      prompt: 'Summarize the corpus.',
      tools: lookupTool,
      effort: 'high',
      fallbackProviders: [],
    });

    expect(result.text).toBe('Summarized.');
    expect(postedUrls()).toEqual([expect.stringMatching(/\/responses$/)]);
    // 400,000 x $4 + 2,000 x $15 per 1M (2x $2 in, 1.5x $10 out).
    expect(result.usage.costUSD).toBeCloseTo(1.63, 9);
  });

  it('bills a streamed gpt-5.6-sol call at the long-context rates', async () => {
    const chunk = (fields: Record<string, unknown>): Record<string, unknown> => ({
      id: 'chatcmpl-long-context-stream',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.6-sol',
      ...fields,
    });
    serve({
      '/chat/completions': () =>
        sseResponse([
          chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Summarized.' }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          // stream_options.include_usage delivers the counts in a trailing
          // chunk with no choices.
          chunk({ choices: [], usage: { prompt_tokens: 300_000, completion_tokens: 1_000, total_tokens: 301_000 } }),
          '[DONE]',
        ]),
    });

    const result = streamText({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      apiKey: 'sk-long-context-stream',
      prompt: 'Summarize the corpus.',
      fallbackProviders: [],
    });

    expect(await drain(result.textStream)).toBe('Summarized.');
    expect(postedUrls()).toEqual([expect.stringMatching(/\/chat\/completions$/)]);
    // 300,000 x $8 + 1,000 x $30 per 1M (2x $4 in, 1.5x $20 out).
    expect((await result.usage).costUSD).toBeCloseTo(2.43, 9);
  });
});
