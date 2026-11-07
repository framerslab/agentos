import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { AttemptBudgetExhaustedError, CountingAttemptBudget } from '../../../../safety/runtime/ModelAttemptBudget';
import type { AttemptOutcome } from '../IProvider';
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const provider = new OpenAIProvider();
    (provider as unknown as { config: Record<string, unknown> }).config = { baseURL: 'https://api.openai.com/v1', requestTimeout: 60000, maxRetries: 3 };
    request = (provider as unknown as { makeApiRequest: RawRequest }).makeApiRequest.bind(provider);
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

  it('adds the tokens of a Responses result marked failed and sent again to the answer after it, or to the error the call ends with', async () => {
    const answered = (body: unknown): Response =>
      ({ ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: () => Promise.resolve(body), body: null }) as unknown as Response;
    const failed = (): Response =>
      answered({ id: 'resp_1', object: 'response', model: 'gpt-5.3-codex', status: 'failed', error: { code: 'server_error', message: 'The model failed.' }, output: [], usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 } });

    // A failed result, then the answer: the call was billed for both.
    fetchMock.mockResolvedValueOnce(failed()).mockResolvedValueOnce(
      answered({ id: 'resp_2', object: 'response', model: 'gpt-5.3-codex', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }),
    );
    const call = request('/responses', 'POST', 'key', { model: 'gpt-5.3-codex' }, false, undefined, undefined, { max: 2 });
    await vi.runAllTimersAsync();
    expect(await call).toMatchObject({ status: 'completed', usage: { input_tokens: 50, output_tokens: 8, total_tokens: 58 } });

    // A failed result, then a 500 that reports none: the error the call ends with carries the failed result's tokens.
    fetchMock.mockResolvedValueOnce(failed()).mockResolvedValueOnce(serverError());
    const error = await thrown(request('/responses', 'POST', 'key', { model: 'gpt-5.3-codex' }, false, undefined, undefined, { max: 2 }));
    expect(error).toMatchObject({ code: 'API_SERVER_ERROR', httpStatus: 500, details: { error: { message: 'boom' }, usage: { promptTokens: 40, completionTokens: 5, totalTokens: 45 } } });
  });

  it('a success is reported once, as ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: () => Promise.resolve({ choices: [] }), body: null } as unknown as Response);
    const outcomes: AttemptOutcome[] = [];
    await request('/chat/completions', 'POST', 'key', {}, false, undefined, undefined, { max: 1, onAttempt: (o) => outcomes.push(o) });
    expect(outcomes).toEqual([{ attempt: 1, status: 200, ok: true }]);
  });
});
