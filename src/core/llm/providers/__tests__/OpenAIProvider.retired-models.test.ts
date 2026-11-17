/**
 * @fileoverview A call to a model OpenAI has shut down ends at once with an error that names the model to use
 * instead, and nothing is sent.
 *
 * On 2026-11-17 a call to each of o1, o3-mini, o4-mini, gpt-4.1-nano, gpt-4-turbo and gpt-3.5-turbo (shut down
 * 2026-10-23) and chatgpt-4o-latest (2026-02-17) answered HTTP 404 `model_not_found`
 * (https://developers.openai.com/api/docs/deprecations). Before this guard the provider drew a key, sent the request
 * and surfaced that bare 404. The cases run through OpenAIProvider.initialize and generateCompletion with a mocked
 * fetch, so they exercise the real request path and record every URL the provider would have reached.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { OpenAIProvider, openAIModelShutdown, retiredOpenAIModel } from '../implementations/OpenAIProvider';
import { OpenAIProviderError } from '../errors/OpenAIProviderError';
import type { ChatMessage } from '../IProvider';

const USER: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response;
}

/** Answers the model list and any completion; every URL the provider asks for is kept in `fetchMock.mock.calls`. */
function answerEverything(): void {
  fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith('/models')) {
      return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', object: 'model', created: 0, owned_by: 'openai' }] });
    }
    const model = init?.body ? (JSON.parse(init.body) as { model?: string }).model : undefined;
    return jsonResponse({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
}

/** The paths of the requests the provider sent after initialize(). */
function sentPaths(): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname).filter((path) => !path.endsWith('/models'));
}

async function caught(promise: Promise<unknown>): Promise<OpenAIProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as OpenAIProviderError;
  }
  throw new Error('expected the call to fail');
}

describe('OpenAIProvider: shut-down models on OpenAI\'s endpoint', () => {
  let provider: OpenAIProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    answerEverything();
    provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test-key' });
  });

  it('refuses each shut-down model before sending anything, naming its replacement', async () => {
    const cases: Array<[string, string]> = [
      ['o4-mini', 'gpt-6-luna'],
      ['o3-mini', 'gpt-6-luna'],
      ['gpt-4.1-nano', 'gpt-6-luna'],
      ['gpt-3.5-turbo', 'gpt-6-luna'],
      ['o1', 'gpt-6.2-sol'],
      ['gpt-4-turbo', 'gpt-6.2-sol'],
      ['chatgpt-4o-latest', 'gpt-6.2-sol'],
      ['gpt-4o-2024-05-13', 'gpt-6.2-sol'],
      // A dated snapshot and another case are the same model.
      ['o4-mini-2025-04-16', 'gpt-6-luna'],
      ['O3-MINI', 'gpt-6-luna'],
    ];
    for (const [model, replacement] of cases) {
      const error = await caught(provider.generateCompletion(model, USER, {}));
      expect(error).toBeInstanceOf(OpenAIProviderError);
      expect([model, error.code, error.httpStatus, error.openaiErrorCode]).toEqual([model, 'MODEL_RETIRED', 404, 'model_not_found']);
      expect(error.message).toContain(`Use ${replacement} instead`);
      expect(error.message).toContain(model);
    }
    expect(sentPaths()).toEqual([]);
  });

  it('refuses a streamed call the same way, before sending anything', async () => {
    const stream = provider.generateCompletionStream('chatgpt-4o-latest', USER, {});
    const error = await caught(stream.next());
    expect([error.code, error.httpStatus]).toEqual(['MODEL_RETIRED', 404]);
    expect(error.message).toContain('OpenAI shut down chatgpt-4o-latest on 2026-02-17');
    expect(error.message).toContain('Use gpt-6.2-sol instead');
    expect(sentPaths()).toEqual([]);
  });

  it('sends a model that still serves, including one with a shutdown day still to come', async () => {
    for (const model of ['gpt-4o', 'o3', 'gpt-5-mini', 'gpt-6.2-sol']) {
      const result = await provider.generateCompletion(model, USER, {});
      expect(result.choices[0]?.message.content).toBe('ok');
    }
    expect(sentPaths()).toEqual(Array(4).fill('/v1/chat/completions'));
  });
});

describe('OpenAIProvider: shut-down models on another endpoint', () => {
  it('sends the call through a gateway, which keeps its own catalog', async () => {
    vi.clearAllMocks();
    answerEverything();
    const provider = new OpenAIProvider();
    await provider.initialize({ apiKey: 'sk-test-key', baseURL: 'https://gateway.example.com/v1' });

    const result = await provider.generateCompletion('o4-mini', USER, {});

    expect(result.choices[0]?.message.content).toBe('ok');
    expect(sentPaths()).toEqual(['/v1/chat/completions']);
  });
});

describe('openAIModelShutdown', () => {
  it('tells a shut-down model from a scheduled one and from one with no shutdown', () => {
    expect(retiredOpenAIModel('o4-mini')).toMatchObject({ state: 'shut-down', shutdownOn: '2026-10-23', replacement: 'gpt-6-luna' });
    // OpenAI ends these on 2026-12-11 and serves them until then.
    expect(openAIModelShutdown('gpt-5-mini')).toMatchObject({ state: 'scheduled', shutdownOn: '2026-12-11', replacement: 'gpt-6-luna' });
    expect(openAIModelShutdown('o3')).toMatchObject({ state: 'scheduled', shutdownOn: '2026-12-11', replacement: 'gpt-6.2-sol' });
    expect(openAIModelShutdown('gpt-5-pro')).toMatchObject({ state: 'scheduled', shutdownOn: '2026-12-11', replacement: 'gpt-6.2-astra' });
    expect(openAIModelShutdown('gpt-4o-2024-08-06')).toMatchObject({ state: 'scheduled', shutdownOn: '2027-01-14' });
    expect(retiredOpenAIModel('gpt-5-mini')).toBeUndefined();
    // The deprecations page names only the gpt-4o snapshots for 2027-01-14, not the alias.
    expect(openAIModelShutdown('gpt-4o')).toBeUndefined();
    expect(openAIModelShutdown('gpt-6.2-sol')).toBeUndefined();
    expect(openAIModelShutdown(undefined)).toBeUndefined();
  });

  it('never names a replacement that is itself shut down or scheduled to end', async () => {
    const { OPENAI_MODEL_SHUTDOWNS } = await import('../implementations/OpenAIProvider');
    for (const row of OPENAI_MODEL_SHUTDOWNS) {
      expect([row.modelId, openAIModelShutdown(row.replacement)]).toEqual([row.modelId, undefined]);
      expect(['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra']).toContain(row.replacement);
    }
  });
});
