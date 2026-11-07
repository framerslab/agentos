import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AttemptBudgetExhaustedError, CountingAttemptBudget } from '../../../../safety/runtime/ModelAttemptBudget';
import type { AttemptOutcome, ModelCompletionResponse } from '../IProvider';
import { estimateOpenAICostUSD } from '../implementations/openaiPricing';
import { OpenAIProvider } from '../implementations/OpenAIProvider';

type RawRequest = (
  endpoint: string,
  method: string,
  apiKey: string,
  body: unknown,
  expectStream?: boolean,
  requestTimeoutOverride?: number,
  abortSignal?: AbortSignal,
  attempts?: { max?: number; onAttempt?: (outcome: AttemptOutcome) => void },
) => Promise<unknown>;

function serverError(): Response {
  return { ok: false, status: 500, statusText: 'Server Error', headers: new Headers(), json: () => Promise.resolve({ error: { message: 'boom', type: 'server_error' } }), body: null } as unknown as Response;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

describe('OpenAIProvider, a per-call attempt count', () => {
  let request: RawRequest;
  /** The provider's mapping of a `/v1/responses` result, as `generateCompletion` applies it to what the request returns. */
  let map: (response: unknown, modelId: string) => ModelCompletionResponse;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const provider = new OpenAIProvider();
    (provider as unknown as { config: Record<string, unknown> }).config = { baseURL: 'https://api.openai.com/v1', requestTimeout: 60000, maxRetries: 3 };
    request = (provider as unknown as { makeApiRequest: RawRequest }).makeApiRequest.bind(provider);
    map = (provider as unknown as { mapResponsesToCompletionResponse: typeof map }).mapResponsesToCompletionResponse.bind(provider);
  });
  afterEach(() => vi.useRealTimers());

  /** Runs a request to its end with the timers run, and answers what it threw. */
  async function thrown(call: Promise<unknown>): Promise<unknown> {
    const settled = call.then(() => null, (error: unknown) => error);
    await vi.runAllTimersAsync();
    return settled;
  }

  it('with maxAttempts 1, a 500 makes one request and throws, reporting one attempt', async () => {
    fetchMock.mockResolvedValue(serverError());
    const outcomes: AttemptOutcome[] = [];
    const error = await thrown(request('/chat/completions', 'POST', 'key', { model: 'gpt-6-luna' }, false, undefined, undefined, { max: 1, onAttempt: (o) => outcomes.push(o) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: 'API_SERVER_ERROR' });
    expect(outcomes).toEqual([{ attempt: 1, status: 500, ok: false }]);
  });

  it('reports the tokens an error status body reported with its attempt, and no usage when it reported none', async () => {
    const billed = { ok: false, status: 500, statusText: 'Server Error', headers: new Headers(), json: () => Promise.resolve({ error: { message: 'boom', type: 'server_error' }, usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } }), body: null } as unknown as Response;
    fetchMock.mockResolvedValueOnce(billed).mockResolvedValueOnce(serverError());
    const outcomes: AttemptOutcome[] = [];
    await thrown(request('/chat/completions', 'POST', 'key', {}, false, undefined, undefined, { max: 2, onAttempt: (o) => outcomes.push(o) }));
    expect(outcomes).toEqual([
      { attempt: 1, status: 500, ok: false, usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } },
      { attempt: 2, status: 500, ok: false },
    ]);
  });

  it('with maxAttempts 1, a timeout makes one request and throws, reporting one attempt with no status', async () => {
    fetchMock.mockRejectedValue(abortError());
    const outcomes: AttemptOutcome[] = [];
    const error = await thrown(request('/chat/completions', 'POST', 'key', {}, false, undefined, undefined, { max: 1, onAttempt: (o) => outcomes.push(o) }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(outcomes).toEqual([{ attempt: 1, status: null, ok: false }]);
  });

  it('with maxAttempts 2 and two 500s, sends twice, reports twice, and the budget refuses a third before anything is sent', async () => {
    fetchMock.mockResolvedValue(serverError());
    const authorize = vi.spyOn(CountingAttemptBudget.prototype, 'authorize');
    const outcomes: AttemptOutcome[] = [];
    const error = await thrown(request('/chat/completions', 'POST', 'key', {}, false, undefined, undefined, { max: 2, onAttempt: (o) => outcomes.push(o) }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.attempt)).toEqual([1, 2]);
    expect(authorize).toHaveBeenCalledTimes(3);
    await expect(authorize.mock.results[2]!.value).rejects.toBeInstanceOf(AttemptBudgetExhaustedError);
    expect(error).toMatchObject({ code: 'API_SERVER_ERROR' });
  });

  it('left out, the configured count holds', async () => {
    fetchMock.mockResolvedValue(serverError());
    await thrown(request('/chat/completions', 'POST', 'key', {}));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('adds the usage of a Responses result marked failed and sent again, priced alone, to the answer after it or to the error the call ends with', async () => {
    const answered = (body: unknown, status = 200): Response =>
      ({ ok: status === 200, status, statusText: String(status), headers: new Headers(), json: () => Promise.resolve(body), body: null }) as unknown as Response;
    // Each request falls below OpenAI's 272,000-token long-context threshold; the two together do not.
    const usage = { input_tokens: 150_000, output_tokens: 10, total_tokens: 150_010 };
    const failed = (): Response =>
      answered({ id: 'resp_1', object: 'response', model: 'gpt-5.4', status: 'failed', error: { code: 'server_error', message: 'The model failed.' }, output: [], usage });
    const single = estimateOpenAICostUSD('gpt-5.4', { promptTokens: 150_000, completionTokens: 10 })!;
    expect(estimateOpenAICostUSD('gpt-5.4', { promptTokens: 300_000, completionTokens: 20 })!).toBeGreaterThan(2 * single);

    // A failed result, then the answer: the call was billed for both, each at its own rate.
    fetchMock.mockResolvedValueOnce(failed()).mockResolvedValueOnce(
      answered({ id: 'resp_2', object: 'response', model: 'gpt-5.4', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage }),
    );
    const call = request('/responses', 'POST', 'key', { model: 'gpt-5.4' }, false, undefined, undefined, { max: 2 });
    await vi.runAllTimersAsync();
    const mapped = map(await call, 'gpt-5.4');
    expect(mapped.usage).toMatchObject({ promptTokens: 300_000, completionTokens: 20, totalTokens: 300_020 });
    expect(mapped.usage?.costUSD).toBeCloseTo(2 * single, 10);

    // A failed result, then a 500 whose body reports the same tokens: the error carries both, each priced alone.
    fetchMock.mockResolvedValueOnce(failed()).mockResolvedValueOnce(answered({ error: { message: 'boom', type: 'server_error' }, usage }, 500));
    const error = (await thrown(request('/responses', 'POST', 'key', { model: 'gpt-5.4' }, false, undefined, undefined, { max: 2 }))) as {
      details?: { usage?: { costUSD?: number } };
    };
    expect(error).toMatchObject({ code: 'API_SERVER_ERROR', httpStatus: 500, details: { error: { message: 'boom' }, usage: { promptTokens: 300_000, completionTokens: 20, totalTokens: 300_020 } } });
    expect(error.details?.usage?.costUSD).toBeCloseTo(2 * single, 10);

    // A failed result, then a 500 that reports none: the error carries the failed result's usage alone.
    fetchMock.mockResolvedValueOnce(failed()).mockResolvedValueOnce(serverError());
    const alone = await thrown(request('/responses', 'POST', 'key', { model: 'gpt-5.4' }, false, undefined, undefined, { max: 2 }));
    expect(alone).toMatchObject({ code: 'API_SERVER_ERROR', details: { error: { message: 'boom' }, usage: { promptTokens: 150_000, completionTokens: 10, totalTokens: 150_010 } } });
  });

  it('adds the usage of a Responses result marked failed and sent again to the error an answer with no output items ends with', async () => {
    const answered = (body: unknown): Response =>
      ({ ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: () => Promise.resolve(body), body: null }) as unknown as Response;
    const usage = { input_tokens: 150_000, output_tokens: 10, total_tokens: 150_010 };
    const single = estimateOpenAICostUSD('gpt-5.4', { promptTokens: 150_000, completionTokens: 10 })!;
    fetchMock
      .mockResolvedValueOnce(answered({ id: 'resp_1', object: 'response', model: 'gpt-5.4', status: 'failed', error: { code: 'server_error', message: 'The model failed.' }, output: [], usage }))
      .mockResolvedValueOnce(answered({ id: 'resp_2', object: 'response', model: 'gpt-5.4', status: 'completed', output: [], usage }));
    const call = request('/responses', 'POST', 'key', { model: 'gpt-5.4' }, false, undefined, undefined, { max: 2 });
    await vi.runAllTimersAsync();
    const answer = await call;
    let error: unknown;
    try {
      map(answer, 'gpt-5.4');
    } catch (thrownByMap) {
      error = thrownByMap;
    }
    // Both requests were billed, each at its own rate, in the provider's form a caller meters.
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE', details: { id: 'resp_2', usage: { promptTokens: 300_000, completionTokens: 20, totalTokens: 300_020 } } });
    expect((error as { details?: { usage?: { costUSD?: number } } }).details?.usage?.costUSD).toBeCloseTo(2 * single, 10);
  });

  it('a success is reported once, as ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: () => Promise.resolve({ choices: [] }), body: null } as unknown as Response);
    const outcomes: AttemptOutcome[] = [];
    await request('/chat/completions', 'POST', 'key', {}, false, undefined, undefined, { max: 1, onAttempt: (o) => outcomes.push(o) });
    expect(outcomes).toEqual([{ attempt: 1, status: 200, ok: true }]);
  });
});
