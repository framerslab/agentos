/**
 * @file visionCloudTier.e2e.test.ts
 * The cloud tier's provider and key, through the real createVisionPipeline,
 * generateText and providers, with only fetch stubbed: the image goes to the
 * configured provider alone, though other vendors' keys are in the
 * environment, unless cloudFallbackProviders lists them; the tier reports the
 * provider and model that answered; and performOCR sends its own apiKey and
 * asks for a transcription.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { createVisionPipeline } from '../index.js';
import { performOCR } from '../../../api/performOCR.js';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry.js';

/** The first bytes of a JPEG, which the cloud tier sends typed as image/jpeg. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08]);

/** The variables provider detection and the fallback chain read, cleared for each test. */
const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'];
let saved: Record<string, string | undefined> = {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** OpenAI's answer to a key it does not take, at its model listing. */
const revokedKey = () =>
  jsonResponse({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401);

/** OpenAI's model listing, which OpenAIProvider reads when it initializes. */
const modelList = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });

/** A chat completion from OpenAI. */
const openAIChat = (text: string) =>
  jsonResponse({
    id: 'chatcmpl-vision',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4.1',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  });

/** A streamed message from Anthropic. */
function anthropicText(text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_vision',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Routes each request to the first handler whose pattern matches its URL. */
function route(handlers: Array<[RegExp, () => Response]>): void {
  fetchMock.mockImplementation(async (url: unknown) => {
    const match = handlers.find(([pattern]) => pattern.test(String(url)));
    if (!match) throw new Error(`unexpected request ${String(url)}`);
    return match[1]();
  });
}

const requestsTo = (pattern: RegExp) => fetchMock.mock.calls.filter(([url]) => pattern.test(String(url)));

/** A cloud-only pipeline on OpenAI with no local tiers. */
const openAIPipeline = (extra: Record<string, unknown> = {}) =>
  createVisionPipeline({
    strategy: 'cloud-only',
    ocr: 'none',
    handwriting: false,
    documentAI: false,
    embedding: false,
    cloudProvider: 'openai',
    cloudModel: 'gpt-4.1',
    ...extra,
  });

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));
  for (const name of KEYS) delete process.env[name];
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

afterEach(() => {
  for (const name of KEYS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  globalLLMProviderHealth.reset();
});

describe('the cloud tier keeps the image on its configured provider', () => {
  it('sends nothing to another vendor whose key is in the environment when the configured one fails', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    route([
      [/api\.openai\.com/, revokedKey],
      [/api\.anthropic\.com/, () => anthropicText('Seen by Anthropic.')],
    ]);
    const pipeline = await openAIPipeline();

    await expect(pipeline.process(JPEG)).rejects.toThrow();

    expect(requestsTo(/api\.openai\.com/).length).toBeGreaterThan(0);
    expect(requestsTo(/api\.anthropic\.com/)).toHaveLength(0);
  });

  it('tries a provider cloudFallbackProviders lists, and reports the one that answered', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    route([
      [/api\.openai\.com/, revokedKey],
      [/api\.anthropic\.com/, () => anthropicText('A receipt for $42.99.')],
    ]);
    const pipeline = await openAIPipeline({ cloudFallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5' }] });

    const result = await pipeline.process(JPEG);

    expect(result.text).toBe('A receipt for $42.99.');
    expect(result.tierResults[0]).toMatchObject({ tier: 'cloud-vision', provider: 'anthropic', model: 'claude-opus-5-5' });
    // The leg used Anthropic's own key from the environment.
    const [, init] = requestsTo(/api\.anthropic\.com/)[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get('x-api-key')).toBe('sk-ant-env');
  });
});

describe('performOCR on a key of its own', () => {
  it('sends its apiKey to the provider it names and asks for a transcription', async () => {
    route([
      [/api\.openai\.com\/v1\/models/, modelList],
      [/api\.openai\.com\/v1\/chat\/completions/, () => openAIChat('TOTAL $42.99')],
    ]);

    const result = await performOCR({ image: JPEG, strategy: 'cloud-only', provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-ocr-tenant' });

    expect(result).toMatchObject({ text: 'TOTAL $42.99', tier: 'cloud-vision', provider: 'openai' });
    const [, init] = requestsTo(/\/v1\/chat\/completions/)[0] as [unknown, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-ocr-tenant');
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(body.messages[0].content[0].text).toMatch(/^Transcribe all the text in this image exactly as written/);
  });

  it('refuses an apiKey with no provider before any request', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-env';

    await expect(performOCR({ image: JPEG, strategy: 'cloud-only', apiKey: 'sk-for-somewhere' })).rejects.toThrow(
      'cloudApiKey and cloudBaseUrl need cloudProvider',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
