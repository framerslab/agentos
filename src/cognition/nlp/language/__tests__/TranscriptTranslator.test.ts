/**
 * @fileoverview The transcript translator on its real path, with only the network stubbed: each line goes through
 * generateText and the OpenAI provider layer to a stubbed `fetch`, so the request body, the Responses route's
 * `store: false`, the structured failures with the usage of a billed answer, the timeout and the caller's abort are
 * read as the provider sends and receives them. The provider lists its models when it starts, so every GET is answered
 * with a listing and the assertions read the POSTs alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

vi.mock('axios', () => {
  const refuse = vi.fn(async () => {
    throw new Error('axios is not stubbed for this test');
  });
  return { default: { post: refuse, get: refuse }, post: refuse, get: refuse };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// The real price table, with the bound's estimate open to one test that sets it.
vi.mock('../../../../api/runtime/modelPricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../api/runtime/modelPricing')>();
  return { ...actual, estimateMaxCallCostUSD: vi.fn(actual.estimateMaxCallCostUSD) };
});

import { setLogger, resetLoggerFactory } from '../../../../core/logging/loggerFactory.js';
import { globalLLMProviderHealth } from '../../../../core/safety/LLMProviderHealthRegistry';
import { TranslationProviderError } from '../interfaces';
import { TRANSLATOR_VERSION, TranscriptTranslator, type TranscriptLineInput } from '../TranscriptTranslator';
import { openAiRequiresResponsesApi } from '../../../../core/llm/providers/implementations/OpenAIProvider';
import { estimateMaxCallCostUSD, modelPricing } from '../../../../api/runtime/modelPricing';
import { estimateCallCostUSD } from '../../../../api/runtime/spendBudget';
import { toMicro } from '../../../../safety/runtime/SpendReservations';

/** A model OpenAI serves on /v1/responses alone, so a call to it takes the Responses route. */
const RESPONSES_MODEL = 'gpt-5.3-codex';
/** An OpenAI reasoning model served on Chat Completions, whose reasoning shares the output cap. */
const REASONING_MODEL = 'gpt-6-luna';

const OPTIONS = { provider: 'openai' as const, model: 'gpt-4o-mini', apiKey: 'test-key', baseUrl: 'https://openai.test/v1', timeoutMs: 1_000 };
const line = (text: string, source: TranscriptLineInput['source'] = { code: 'es', provenance: 'detected' }): TranscriptLineInput =>
  ({ itemId: 'item_1', text, source, context: [{ text: 'Hola a todos.', speaker: 'A' }] });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Chat Completions body whose message is `content` and whose usage reports the given counts. */
function chatCompletion(content: string | null, promptTokens = 1_000, completionTokens = 500): Record<string, unknown> {
  return {
    id: 'chatcmpl-translate',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

type PostAnswer = Response | ((init: { signal: AbortSignal }) => Promise<Response>);

/**
 * Answers every GET with a model listing and each POST with the next of `answers`, in order; a POST past the last
 * gets a 404, which the OpenAI provider does not retry.
 */
function answer(...answers: PostAnswer[]): void {
  fetchMock.mockImplementation(async (_url: unknown, init?: { method?: string; signal: AbortSignal }) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ object: 'list', data: ['gpt-4o-mini', RESPONSES_MODEL, REASONING_MODEL].map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })) });
    }
    const next = answers.shift();
    if (next === undefined) return jsonResponse({ error: { message: 'unexpected POST', type: 'invalid_request_error' } }, 404);
    return typeof next === 'function' ? next(init as { signal: AbortSignal }) : next;
  });
}

/** A POST that never answers: it rejects with its signal's reason once the request is aborted. */
const hang = (init: { signal: AbortSignal }): Promise<Response> =>
  new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

/** Every POST sent: its URL and its parsed body. */
function posts(): Array<{ url: string; body: any }> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as { body?: unknown }).body)) }));
}

const logged: Record<string, unknown>[] = [];
const failures = () => logged.filter((entry) => entry.event === 'language.translation_failed');

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  logged.length = 0;
  setLogger(pino({ level: 'debug', base: undefined }, { write(entry: string) { logged.push(JSON.parse(entry)); } }));
  vi.stubEnv('OPENAI_API_KEY', '');
});

afterEach(() => {
  resetLoggerFactory();
  vi.unstubAllEnvs();
});

describe('TranscriptTranslator.translateLine', () => {
  it('skips a line whose detected or configured source equals the target, with no call', async () => {
    answer();
    const translator = new TranscriptTranslator();
    const detected = await translator.translateLine(line('Buenos días.'), 'es', OPTIONS);
    const configured = await translator.translateLine(line('Buenos días.', { code: 'es', provenance: 'configured' }), 'es', OPTIONS);
    expect(detected).toMatchObject({ status: 'skipped', reason: 'same_language', source: 'es', version: TRANSLATOR_VERSION });
    expect(configured.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a line whose source is the target in another case or with a region, and translates one in another script', async () => {
    answer(jsonResponse(chatCompletion('你好。')));
    const translator = new TranscriptTranslator();
    const upper = await translator.translateLine(line('Hello.', { code: 'EN', provenance: 'detected' }), 'en', OPTIONS);
    const regional = await translator.translateLine(line('Hello.', { code: 'en-US', provenance: 'configured' }), 'en', OPTIONS);
    const underscored = await translator.translateLine(line('Olá.', { code: 'pt_BR', provenance: 'detected' }), 'pt', OPTIONS);
    expect([upper.status, regional.status, underscored.status]).toEqual(['skipped', 'skipped', 'skipped']);
    expect(posts()).toHaveLength(0);
    const script = await translator.translateLine(line('你好。', { code: 'zh-Hans', provenance: 'detected' }), 'zh-Hant', OPTIONS);
    expect(script.status).toBe('translated');
    expect(posts()).toHaveLength(1);
  });

  it("reads a Chinese code's script from its region when it names none: zh-CN is translated into zh-TW, and zh-TW is zh-Hant", async () => {
    answer(jsonResponse(chatCompletion('早安。')));
    const translator = new TranscriptTranslator();
    const traditional = await translator.translateLine(line('早上好。', { code: 'zh-CN', provenance: 'configured' }), 'zh-TW', OPTIONS);
    expect(traditional).toMatchObject({ status: 'translated', text: '早安。', source: 'zh-CN', target: 'zh-TW' });
    expect(posts()).toHaveLength(1);
    const same = await Promise.all([
      translator.translateLine(line('早安。', { code: 'zh-TW', provenance: 'detected' }), 'zh-Hant', OPTIONS),
      translator.translateLine(line('早安。', { code: 'zh_HK', provenance: 'detected' }), 'zh-TW', OPTIONS),
      translator.translateLine(line('早上好。', { code: 'zh-CN', provenance: 'configured' }), 'zh-Hans', OPTIONS),
    ]);
    expect(same.map((each) => each.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(posts()).toHaveLength(1);
  });

  it("sends nothing for a model that names another provider, so the OpenAI key never goes to it", async () => {
    answer(jsonResponse(chatCompletion('Good morning.')));
    for (const model of ['anthropic:claude-opus-4-1', 'openrouter:openai/gpt-4o-mini']) {
      const refused = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', { ...OPTIONS, model }).then(() => undefined, (error: unknown) => error);
      expect(refused).toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_REQUEST_FAILED' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the model the call sends on its result, a provider prefix removed', async () => {
    answer(jsonResponse(chatCompletion('Good morning.')));
    const translator = new TranscriptTranslator();
    const options = { ...OPTIONS, model: 'openai:gpt-4o-mini' };
    const translated = await translator.translateLine(line('Buenos días.'), 'en', options);
    const skipped = await translator.translateLine(line('Buenos días.'), 'es', options);
    expect([translated.model, skipped.model]).toEqual(['gpt-4o-mini', 'gpt-4o-mini']);
    expect(posts().map((post) => post.body.model)).toEqual(['gpt-4o-mini']);
  });

  it('translates a line of unknown provenance whatever its words, with source null', async () => {
    answer(jsonResponse(chatCompletion('Good morning.')), jsonResponse(chatCompletion('Buenos días.')));
    const got = await new TranscriptTranslator().translateLine(line('Buenos días.', { code: null, provenance: 'unknown' }), 'en', OPTIONS);
    expect(got).toMatchObject({ status: 'translated', text: 'Good morning.', source: null, target: 'en', model: 'gpt-4o-mini', providerId: 'openai', version: 'v1' });
    expect(got.status === 'translated' && got.usage?.promptTokens).toBe(1_000);
    // A code the hearing guessed without confidence names nothing: the line is sent even when that code is the target.
    const guessed = await new TranscriptTranslator().translateLine(line('Buenos días.', { code: 'es', provenance: 'unknown' }), 'es', OPTIONS);
    expect(guessed).toMatchObject({ status: 'translated', source: null, target: 'es' });
    const sent = posts();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0].body.messages[0])).toContain('from its own language into en.');
  });

  it('sends one request to the given base URL with fallbackProviders empty, the context labelled, maxTokens and the attempts capped', async () => {
    answer(jsonResponse(chatCompletion('Good morning.')));
    await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', { ...OPTIONS, maxOutputTokens: 200, maxAttempts: 1 });
    const sent = posts();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://openai.test/v1/chat/completions');
    const body = sent[0].body;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(200);
    expect(JSON.stringify(body.messages[0])).toContain('Translate the newest line of a live transcript from es into en.');
    const user = JSON.stringify(body.messages[body.messages.length - 1]);
    expect(user).toContain('Earlier lines:');
    expect(user).toContain('A: Hola a todos.');
    expect(user).toContain('Line to translate:');
    expect(user).toContain('Buenos días.');
  });

  it('sends no more context lines than maxContextLines, the newest kept', async () => {
    answer(jsonResponse(chatCompletion('Three.')));
    const input: TranscriptLineInput = { itemId: 'item_9', text: 'Tres.', source: { code: 'es', provenance: 'configured' }, context: [{ text: 'Uno.' }, { text: 'Dos.', speaker: null }] };
    await new TranscriptTranslator().translateLine(input, 'en', { ...OPTIONS, maxContextLines: 1 });
    const messages = posts()[0].body.messages;
    const user = JSON.stringify(messages[messages.length - 1]);
    expect(user).not.toContain('Uno.');
    expect(user).toContain('Dos.');
  });

  it('pins store false on the Responses route', async () => {
    expect(openAiRequiresResponsesApi(RESPONSES_MODEL, {})).toBe(true);
    answer(jsonResponse({ id: 'resp_1', object: 'response', model: RESPONSES_MODEL, output_text: 'Good morning.', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Good morning.' }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }));
    const got = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', { ...OPTIONS, model: RESPONSES_MODEL });
    expect(got).toMatchObject({ status: 'translated', text: 'Good morning.' });
    const sent = posts();
    expect(sent.map((post) => post.url)).toEqual(['https://openai.test/v1/responses']);
    expect(sent[0].body.store).toBe(false);
  });

  it('throws TRANSLATION_REQUEST_FAILED with the status, never returning the input', async () => {
    answer(jsonResponse({ error: { message: 'no' } }, 503));
    await expect(new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', { ...OPTIONS, maxAttempts: 1 })).rejects.toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 503, usage: null });
    expect(posts()).toHaveLength(1);
    expect(failures()).toEqual([expect.objectContaining({ provider: 'openai', reason: 'request_failed', status: 503 })]);
  });

  it('throws TRANSLATION_EMPTY_OUTPUT on an empty answer and TRANSLATION_TRUNCATED on a length finish, each carrying the billed usage', async () => {
    answer(
      jsonResponse(chatCompletion('')),
      jsonResponse({ ...chatCompletion('Good'), choices: [{ index: 0, message: { role: 'assistant', content: 'Good' }, finish_reason: 'length' }] }),
    );
    await expect(new TranscriptTranslator().translateLine(line('Hola.'), 'en', OPTIONS)).rejects.toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_EMPTY_OUTPUT', usage: { promptTokens: 1_000 } });
    await expect(new TranscriptTranslator().translateLine(line('Hola.'), 'en', OPTIONS)).rejects.toMatchObject({ code: 'TRANSLATION_TRUNCATED', usage: { promptTokens: 1_000, completionTokens: 500 } });
    expect(failures().map((entry) => entry.reason)).toEqual(['empty_output', 'truncated']);
  });

  it('records a failed call at its billed usage, at its bound when the bill is unknown, and at nothing for a refusal with a status', () => {
    const price = (usage: { promptTokens?: number; completionTokens?: number }) => (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    const billed = new TranslationProviderError('cut', 'openai', 'TRANSLATION_TRUNCATED', 200, undefined, { promptTokens: 40, completionTokens: 200, totalTokens: 240 });
    expect(billed.usage).toEqual({ promptTokens: 40, completionTokens: 200, totalTokens: 240 });
    expect(new TranslationProviderError('no', 'openai', 'TRANSLATION_REQUEST_FAILED').usage).toBeNull();
    expect(TranscriptTranslator.failedCallMicro(billed, 9_999, price)).toBe(240);
    expect(TranscriptTranslator.failedCallMicro(new TranslationProviderError('slow', 'openai', 'TRANSLATION_TIMEOUT'), 9_999, price)).toBe(9_999);
    expect(TranscriptTranslator.failedCallMicro(new TranslationProviderError('no', 'openai', 'TRANSLATION_REQUEST_FAILED'), 9_999, price)).toBe(9_999);
    expect(TranscriptTranslator.failedCallMicro(new TranslationProviderError('no', 'openai', 'TRANSLATION_REQUEST_FAILED', 503), 9_999, price)).toBe(0);
    expect(TranscriptTranslator.failedCallMicro(new Error('page left'), 9_999, price)).toBe(9_999);
  });

  it('throws TRANSLATION_TIMEOUT when the provider does not answer within timeoutMs, and rethrows a caller abort', async () => {
    answer(hang, hang);
    await expect(new TranscriptTranslator().translateLine(line('Hola.'), 'en', { ...OPTIONS, timeoutMs: 20, maxAttempts: 1 })).rejects.toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_TIMEOUT', usage: null });
    expect(failures()).toEqual([expect.objectContaining({ provider: 'openai', reason: 'timeout', status: 0 })]);
    const controller = new AbortController();
    const pending = new TranscriptTranslator().translateLine(line('Hola.'), 'en', { ...OPTIONS, abortSignal: controller.signal });
    controller.abort(new Error('page left'));
    await expect(pending).rejects.toThrow('page left');
    expect(failures()).toHaveLength(1);
  });

  it('ends the call at timeoutMs and at the caller\'s abort while the provider is still starting, and sends nothing once it has started', async () => {
    let listed!: () => void;
    const listing = new Promise<void>((resolve) => {
      listed = resolve;
    });
    // The provider lists its models before its first call; this listing hangs until the test lets it answer.
    fetchMock.mockImplementation(async (_url: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') {
        await listing;
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', created: 1, owned_by: 'openai' }] });
      }
      return jsonResponse(chatCompletion('Hello.'));
    });
    const within = <T>(pending: Promise<T>): Promise<T> =>
      Promise.race([pending, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('still pending after 1,000 ms')), 1_000))]);
    // A key the provider cache has not seen, so each call starts its own provider.
    await expect(within(new TranscriptTranslator().translateLine(line('Hola.'), 'en', { ...OPTIONS, apiKey: 'starting-key-1', timeoutMs: 50, maxAttempts: 1 }))).rejects.toMatchObject({ code: 'TRANSLATION_TIMEOUT' });
    const controller = new AbortController();
    const pending = new TranscriptTranslator().translateLine(line('Hola.'), 'en', { ...OPTIONS, apiKey: 'starting-key-2', abortSignal: controller.signal });
    setTimeout(() => controller.abort(new Error('page left')), 20);
    await expect(within(pending)).rejects.toThrow('page left');
    expect(failures().map((entry) => entry.reason)).toEqual(['timeout']);
    listed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts()).toHaveLength(0);
  });

  it('counts an attempt that got no answer: a refusal after it is recorded at the bound, and a translation after it says so', async () => {
    // The shortest backoff before the retry.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const lost = async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      };
      answer(lost, jsonResponse({ error: { message: 'busy' } }, 503), lost, jsonResponse(chatCompletion('Hello.', 40, 3)));
      const translator = new TranscriptTranslator();
      const options = { ...OPTIONS, maxAttempts: 2, timeoutMs: 10_000 };
      const bound = translator.boundMicro(line('Hola.'), 'en', options);
      const price = (usage: { promptTokens: number; completionTokens: number }) => usage.promptTokens + usage.completionTokens;
      const refused = await translator.translateLine(line('Hola.'), 'en', options).then(() => undefined, (error: unknown) => error);
      // The first attempt may have been billed for a whole answer; the 503 after it does not show that it was not.
      expect(refused).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 503, usage: null, unansweredAttempts: 1 });
      expect(TranscriptTranslator.failedCallMicro(refused, bound, price)).toBe(bound);
      globalLLMProviderHealth.reset();
      const translated = await translator.translateLine(line('Hola.'), 'en', options);
      expect(translated).toMatchObject({ status: 'translated', text: 'Hello.', usage: { promptTokens: 40, completionTokens: 3 }, unansweredAttempts: 1 });
      expect(posts()).toHaveLength(4);
    } finally {
      random.mockRestore();
    }
  });

  it('counts an attempt that got no answer before a later attempt ran past timeoutMs', async () => {
    // The shortest backoff before the retry (500 ms), so the second attempt is sent and hangs until the timeout.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const lost = async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      };
      answer(lost, hang);
      const options = { ...OPTIONS, maxAttempts: 2, timeoutMs: 1_500 };
      const timedOut = await new TranscriptTranslator().translateLine(line('Hola.'), 'en', options).then(() => undefined, (error: unknown) => error);
      // The first attempt may have been billed for a whole answer; the timed-out one is the attempt the error reports.
      expect(timedOut).toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_TIMEOUT', usage: null, unansweredAttempts: 1 });
      expect(posts()).toHaveLength(2);
    } finally {
      random.mockRestore();
    }
  });

  it('refuses a maxAttempts that is not a whole number of 1 or more, in boundMicro and before any request, never as a bound', async () => {
    answer(jsonResponse(chatCompletion('unused')));
    const translator = new TranscriptTranslator();
    for (const maxAttempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => translator.boundMicro(line('Hola.'), 'en', { ...OPTIONS, maxAttempts })).toThrow(RangeError);
      const refused = await translator.translateLine(line('Hola.'), 'en', { ...OPTIONS, maxAttempts }).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(RangeError);
      expect(refused).toMatchObject({ message: 'maxAttempts is a whole number, 1 or more' });
    }
    expect(posts()).toHaveLength(0);
  });

  it('refuses a maxContextLines that is not a whole number of 0 or more, in boundMicro and before any request; 0 sends no earlier line', async () => {
    answer(jsonResponse(chatCompletion('Hello.')));
    const translator = new TranscriptTranslator();
    // 0.5 read as slice(-0.5) is slice(0): every earlier line would be sent, and priced.
    for (const maxContextLines of [-1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => translator.boundMicro(line('Hola.'), 'en', { ...OPTIONS, maxContextLines })).toThrow(RangeError);
      const refused = await translator.translateLine(line('Hola.'), 'en', { ...OPTIONS, maxContextLines }).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(RangeError);
      expect(refused).toMatchObject({ message: 'maxContextLines is a whole number, 0 or more' });
    }
    expect(posts()).toHaveLength(0);

    expect(translator.boundMicro(line('Hola.'), 'en', { ...OPTIONS, maxContextLines: 0 })).toBeGreaterThan(0);
    await translator.translateLine(line('Hola.'), 'en', { ...OPTIONS, maxContextLines: 0 });
    const messages = posts()[0].body.messages;
    const user = JSON.stringify(messages[messages.length - 1]);
    expect(user).not.toContain('Hola a todos.');
    expect(user).not.toContain('Earlier lines:');
  });

  it('refuses a timeoutMs setTimeout cannot keep, in boundMicro and before any request, never as a timeout', async () => {
    answer(jsonResponse(chatCompletion('Hello.')));
    const translator = new TranscriptTranslator();
    // Node runs a delay of each of these after about 1 ms, so every line would end as a timeout recorded at its bound.
    for (const timeoutMs of [0, -1, 0.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => translator.boundMicro(line('Hola.'), 'en', { ...OPTIONS, timeoutMs })).toThrow(RangeError);
      const refused = await translator.translateLine(line('Hola.'), 'en', { ...OPTIONS, timeoutMs }).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(RangeError);
      expect(refused).toMatchObject({ message: 'timeoutMs is a number of milliseconds from 1 to 2147483647' });
    }
    expect(posts()).toHaveLength(0);
    expect(failures()).toHaveLength(0);

    // The longest delay setTimeout keeps is a timeout like any other.
    expect(translator.boundMicro(line('Hola.'), 'en', { ...OPTIONS, timeoutMs: 2_147_483_647 })).toBeGreaterThan(0);
    await expect(translator.translateLine(line('Hola.'), 'en', { ...OPTIONS, timeoutMs: 2_147_483_647 })).resolves.toMatchObject({ status: 'translated', text: 'Hello.' });
  });

  it("carries the tokens an earlier attempt's error status reported on a timeout's error, and records the timeout at its bound", async () => {
    // The shortest backoff before the retry (500 ms), so the second attempt is sent and hangs until the timeout.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      answer(
        jsonResponse({ error: { message: 'server error', type: 'server_error' }, usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } }, 500),
        hang,
      );
      const options = { ...OPTIONS, maxAttempts: 2, timeoutMs: 1_500 };
      const timedOut = await new TranscriptTranslator().translateLine(line('Hola.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(timedOut).toMatchObject({ code: 'TRANSLATION_TIMEOUT', unansweredAttempts: 0, usage: { promptTokens: 40, completionTokens: 7, totalTokens: 47 } });
      expect(posts()).toHaveLength(2);
      // The attempt the timeout ended may have been billed for a whole answer, so the tokens are not the call's cost.
      const price = (usage: { promptTokens?: number; completionTokens?: number }) => (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      expect(TranscriptTranslator.failedCallMicro(timedOut, 9_999, price)).toBe(9_999);
    } finally {
      random.mockRestore();
    }
  });

  it('counts an attempt whose success status came and whose body was lost: a refusal after it is recorded at the bound, and a translation after it says so', async () => {
    // The shortest backoff before the retry.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // A 200 whose connection drops while its body is read: the provider may have billed the answer nobody got.
      const cut = async (): Promise<Response> =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      answer(cut, jsonResponse({ error: { message: 'busy' } }, 503), cut, jsonResponse(chatCompletion('Hello.', 40, 3)));
      const translator = new TranscriptTranslator();
      const options = { ...OPTIONS, maxAttempts: 2, timeoutMs: 10_000 };
      const bound = translator.boundMicro(line('Hola.'), 'en', options);
      const price = (usage: { promptTokens: number; completionTokens: number }) => usage.promptTokens + usage.completionTokens;
      const refused = await translator.translateLine(line('Hola.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(refused).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 503, usage: null, unansweredAttempts: 1 });
      expect(TranscriptTranslator.failedCallMicro(refused, bound, price)).toBe(bound);
      globalLLMProviderHealth.reset();
      const translated = await translator.translateLine(line('Hola.'), 'en', options);
      expect(translated).toMatchObject({ status: 'translated', text: 'Hello.', usage: { promptTokens: 40, completionTokens: 3 }, unansweredAttempts: 1 });
      expect(posts()).toHaveLength(4);
    } finally {
      random.mockRestore();
    }
  });

  it('keeps the success status of a last attempt whose body was lost, on the error and in the failure line', async () => {
    const cut = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.error(new TypeError('terminated'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    answer(cut);
    const failed = await new TranscriptTranslator().translateLine(line('Hola.'), 'en', { ...OPTIONS, maxAttempts: 1 }).then(() => undefined, (error: unknown) => error);
    expect(failed).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 200, unansweredAttempts: 1 });
    expect(TranscriptTranslator.failedCallMicro(failed, 9_999, () => 0)).toBe(9_999);
    expect(failures()).toEqual([expect.objectContaining({ provider: 'openai', reason: 'request_failed', status: 200 })]);
  });

  it('counts a lost success body though the HTTP error after it reports usage of its own', async () => {
    // The shortest backoff before the retry.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const cut = async (): Promise<Response> =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.error(new TypeError('terminated'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      // The 500's usage is its own: it says nothing of the answer the first attempt may have been billed for.
      answer(cut, jsonResponse({ error: { message: 'server error', type: 'server_error' }, usage: { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 } }, 500));
      const translator = new TranscriptTranslator();
      const options = { ...OPTIONS, maxAttempts: 2, timeoutMs: 10_000 };
      const bound = translator.boundMicro(line('Hola.'), 'en', options);
      const failed = await translator.translateLine(line('Hola.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(failed).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 500, unansweredAttempts: 1 });
      expect(TranscriptTranslator.failedCallMicro(failed, bound, (usage) => usage.promptTokens + usage.completionTokens)).toBe(bound);
    } finally {
      random.mockRestore();
    }
  });

  it('adds the tokens an earlier attempt answered with an error status reported to the translation after it and to the refusal after it', async () => {
    // The shortest backoff before each retry.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const billed500 = (): Response =>
        jsonResponse({ error: { message: 'server error', type: 'server_error' }, usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 } }, 500);
      const price = (usage: { promptTokens?: number; completionTokens?: number }) => (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      const translator = new TranscriptTranslator();
      const options = { ...OPTIONS, maxAttempts: 2, timeoutMs: 10_000 };

      // A 500 whose body reports tokens, then the translation: the call cost both.
      answer(billed500(), jsonResponse(chatCompletion('Good morning.', 30, 5)));
      const got = await translator.translateLine(line('Buenos días.'), 'en', options);
      expect(got).toMatchObject({ status: 'translated', text: 'Good morning.', unansweredAttempts: 0, usage: { promptTokens: 70, completionTokens: 12, totalTokens: 82 } });

      // The same 500, then a 503 that reports none: the refusal carries the first attempt's tokens and is recorded at them.
      answer(billed500(), jsonResponse({ error: { message: 'unavailable', type: 'server_error' } }, 503));
      const refused = await translator.translateLine(line('Buenos días.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(refused).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 503, unansweredAttempts: 0, usage: { promptTokens: 40, completionTokens: 7, totalTokens: 47 } });
      expect(TranscriptTranslator.failedCallMicro(refused, 9_999, price)).toBe(47);

      // Two such 500s: each attempt's tokens are counted once, the last one's with the error that reports it.
      answer(billed500(), billed500());
      const twice = await translator.translateLine(line('Buenos días.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(twice).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', status: 500, usage: { promptTokens: 80, completionTokens: 14, totalTokens: 94 } });
      expect(TranscriptTranslator.failedCallMicro(twice, 9_999, price)).toBe(94);
    } finally {
      random.mockRestore();
    }
  });

  it('runs an OpenAI reasoning model at effort low with room for its reasoning over the answer, and a non-reasoning model as asked', async () => {
    answer(jsonResponse(chatCompletion('Good morning.')), jsonResponse(chatCompletion('Good morning.')));
    const translator = new TranscriptTranslator();
    await translator.translateLine(line('Buenos días.'), 'en', { ...OPTIONS, model: REASONING_MODEL, maxAttempts: 1 });
    await translator.translateLine(line('Buenos días.'), 'en', { ...OPTIONS, maxAttempts: 1 });
    const [reasoning, plain] = posts();
    expect(reasoning.url).toBe('https://openai.test/v1/chat/completions');
    expect(reasoning.body.model).toBe(REASONING_MODEL);
    expect(reasoning.body.reasoning_effort).toBe('low');
    // The reasoning shares the output cap, so the default cap holds the answer's and 1,024 tokens for the reasoning.
    expect(reasoning.body.max_completion_tokens).toBe(TranscriptTranslator.defaultMaxOutputTokens('Buenos días.') + 1_024);
    expect(plain.body.reasoning_effort).toBeUndefined();
    expect(plain.body.max_tokens ?? plain.body.max_completion_tokens).toBe(TranscriptTranslator.defaultMaxOutputTokens('Buenos días.'));
  });

  it('carries the usage a failed call reported and records the call at it', async () => {
    // A Responses body with no output items: the provider refuses it, and its error holds the body's usage.
    answer(jsonResponse({ id: 'resp_2', object: 'response', status: 'completed', model: RESPONSES_MODEL, output: [], usage: { input_tokens: 40, output_tokens: 0, total_tokens: 40 } }));
    const failed = await new TranscriptTranslator()
      .translateLine(line('Hola.'), 'en', { ...OPTIONS, model: RESPONSES_MODEL, maxAttempts: 1 })
      .then(() => undefined, (error: unknown) => error);
    expect(failed).toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_REQUEST_FAILED', usage: { promptTokens: 40, completionTokens: 0, totalTokens: 40 } });
    expect(TranscriptTranslator.failedCallMicro(failed, 9_999, (usage) => usage.promptTokens + usage.completionTokens)).toBe(40);
    expect(posts()).toHaveLength(1);
  });

  it('throws TRANSLATION_INCOMPLETE for an answer a filter stopped, partial text and all, with its billed usage', async () => {
    answer(jsonResponse({ ...chatCompletion('Good', 30, 1), choices: [{ index: 0, message: { role: 'assistant', content: 'Good' }, finish_reason: 'content_filter' }] }));
    await expect(new TranscriptTranslator().translateLine(line('Hola.'), 'en', OPTIONS)).rejects.toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_INCOMPLETE', status: 200, usage: { promptTokens: 30, completionTokens: 1 } });
    expect(failures()).toEqual([expect.objectContaining({ provider: 'openai', reason: 'incomplete', status: 200 })]);
  });

  it('throws TRANSLATION_EMPTY_OUTPUT for a line the model refused, as for any answer with no text, with its billed usage', async () => {
    // OpenAI's refusal: a refusal message beside an ordinary stop, and no content. The finish reason stays `stop`, so
    // the line ends with the code it has always ended with.
    answer(jsonResponse({ ...chatCompletion(null, 30, 11), choices: [{ index: 0, message: { role: 'assistant', refusal: "I'm sorry, I cannot assist with that request." }, finish_reason: 'stop' }] }));
    await expect(new TranscriptTranslator().translateLine(line('Hola.'), 'en', OPTIONS)).rejects.toMatchObject({ name: 'TranslationProviderError', code: 'TRANSLATION_EMPTY_OUTPUT', status: 200, usage: { promptTokens: 30, completionTokens: 11 } });
    expect(failures()).toEqual([expect.objectContaining({ provider: 'openai', reason: 'empty_output', status: 200 })]);
  });

  it('reads an answer that reported no usage as no report, so the call is recorded at its bound and never at nothing', async () => {
    const reportsNoUsage = (body: Record<string, unknown>): Record<string, unknown> => {
      delete body.usage;
      return body;
    };
    answer(jsonResponse(reportsNoUsage(chatCompletion('Good morning.'))));
    const got = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', OPTIONS);
    expect(got).toMatchObject({ status: 'translated', text: 'Good morning.', usage: null });

    const cut = { ...chatCompletion('Good'), choices: [{ index: 0, message: { role: 'assistant', content: 'Good' }, finish_reason: 'length' }] };
    answer(jsonResponse(reportsNoUsage(cut)));
    const failure = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', OPTIONS).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'TRANSLATION_TRUNCATED', usage: null });
    const price = (usage: { promptTokens?: number; completionTokens?: number }) => (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    expect(TranscriptTranslator.failedCallMicro(failure, 9_999, price)).toBe(9_999);
  });

  it('refuses a Responses answer marked failed, though it holds text, and records the call at the usage it reported', async () => {
    answer(
      jsonResponse({
        id: 'resp_1',
        object: 'response',
        model: RESPONSES_MODEL,
        status: 'failed',
        error: { code: 'server_error', message: 'The model failed.' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Good mor' }] }],
        usage: { input_tokens: 40, output_tokens: 3, total_tokens: 43 },
      }),
    );
    // One attempt: a retryable failure on the last attempt is the call's answer.
    const failure = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', { ...OPTIONS, model: RESPONSES_MODEL, maxAttempts: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranslationProviderError);
    expect(failure).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', unansweredAttempts: 0, usage: { promptTokens: 40, completionTokens: 3 } });
    const price = (usage: { promptTokens?: number; completionTokens?: number }) => (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    expect(TranscriptTranslator.failedCallMicro(failure, 9_999, price)).toBe(43);
  });

  it('sends a Responses answer marked failed with a retryable code again while attempts remain, and one with another code never', async () => {
    // The shortest backoff before the retry.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const failed = (code: string): Response =>
        jsonResponse({ id: 'resp_1', object: 'response', model: RESPONSES_MODEL, status: 'failed', error: { code, message: 'The model failed.' }, output: [], usage: { input_tokens: 40, output_tokens: 0, total_tokens: 40 } });
      const options = { ...OPTIONS, model: RESPONSES_MODEL, maxAttempts: 2, timeoutMs: 10_000 };
      answer(
        failed('server_error'),
        jsonResponse({ id: 'resp_2', object: 'response', model: RESPONSES_MODEL, status: 'completed', output_text: 'Good morning.', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Good morning.' }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }),
      );
      const got = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', options);
      // The failed answer's 200 brought a body that never became the answer, so it counts as unanswered and the call
      // is recorded at its bound; the tokens it reported are on the translation with the answer's.
      expect(got).toMatchObject({ status: 'translated', text: 'Good morning.', unansweredAttempts: 1, usage: { promptTokens: 50, completionTokens: 3, totalTokens: 53 } });
      expect(posts()).toHaveLength(2);

      answer(failed('invalid_prompt'), jsonResponse(chatCompletion('unused')));
      const refused = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(refused).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED' });
      expect(posts()).toHaveLength(3);

      // Sent again, an answer with no output items is refused: the refusal carries both requests' tokens.
      globalLLMProviderHealth.reset();
      answer(
        failed('server_error'),
        jsonResponse({ id: 'resp_2', object: 'response', model: RESPONSES_MODEL, status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } }),
      );
      const empty = await new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', options).then(() => undefined, (error: unknown) => error);
      expect(empty).toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED', unansweredAttempts: 1, usage: { promptTokens: 50, completionTokens: 0, totalTokens: 50 } });
      expect(posts()).toHaveLength(5);
    } finally {
      random.mockRestore();
    }
  });

  it('refuses a Responses answer cut off with no reason, though it holds text', async () => {
    answer(
      jsonResponse({
        id: 'resp_1',
        object: 'response',
        model: RESPONSES_MODEL,
        status: 'incomplete',
        incomplete_details: null,
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Good mor' }] }],
        usage: { input_tokens: 40, output_tokens: 3, total_tokens: 43 },
      }),
    );
    await expect(new TranscriptTranslator().translateLine(line('Buenos días.'), 'en', { ...OPTIONS, model: RESPONSES_MODEL })).rejects.toMatchObject({
      code: 'TRANSLATION_TRUNCATED',
      usage: { promptTokens: 40, completionTokens: 3 },
    });
  });

  it('is exported from the package root', async () => {
    const root = await import('../../../../index');
    expect(typeof root.TranscriptTranslator).toBe('function');
    expect(root.TRANSLATOR_VERSION).toBe('v1');
  });
});

describe('TranscriptTranslator.boundMicro', () => {
  it('answers at least what the recorded request can cost, times the attempts, and throws for a model with no price row', () => {
    const translator = new TranscriptTranslator();
    const one = translator.boundMicro(line('Buenos días.'), 'en', { ...OPTIONS, maxAttempts: 1, maxOutputTokens: 200 });
    const two = translator.boundMicro(line('Buenos días.'), 'en', { ...OPTIONS, maxAttempts: 2, maxOutputTokens: 200 });
    expect(one).toBeGreaterThan(0);
    expect(two).toBe(one * 2);
    expect(() => translator.boundMicro(line('x'), 'en', { ...OPTIONS, model: 'no-such-model' })).toThrow();
  });

  it("rounds each attempt's bound up to the micro-dollar, never to the nearest", () => {
    // An attempt whose most is 1.4 micro-dollars is bounded at 2, so two attempts at 4.
    vi.mocked(estimateMaxCallCostUSD).mockReturnValueOnce(0.000_001_4);
    expect(new TranscriptTranslator().boundMicro(line('Hola.'), 'en', { ...OPTIONS, maxAttempts: 2 })).toBe(4);
  });

  it('bounds a CJK-heavy prompt at no less than one token a byte, above the four-characters-a-token estimate', () => {
    const cjk = '今日の会議の議題は三つあります。'.repeat(12);
    const input: TranscriptLineInput = { itemId: 'item_1', text: cjk, source: { code: 'ja', provenance: 'configured' }, context: Array.from({ length: 6 }, () => ({ text: cjk, speaker: 'A' })) };
    const options = { ...OPTIONS, maxAttempts: 1, maxOutputTokens: 200 };
    const price = modelPricing(OPTIONS.provider, OPTIONS.model)!;
    // a floor that leaves out the private system text: the seven lines' bytes as tokens, the cap at the output rate
    const floorMicro = new TextEncoder().encode(cjk).length * 7 * price.inputPerMTokUSD + 200 * price.outputPerMTokUSD;
    const bound = new TranscriptTranslator().boundMicro(input, 'en', options);
    expect(bound).toBeGreaterThanOrEqual(Math.ceil(floorMicro));
    expect(bound).toBeGreaterThan(Math.ceil(toMicro(estimateCallCostUSD(OPTIONS.provider, OPTIONS.model, cjk.length * 7, 200)!)));
  });

  it("prices a prefixed model as the call sends it, and refuses another provider's model as the call does", () => {
    const translator = new TranscriptTranslator();
    const bare = translator.boundMicro(line('Buenos días.'), 'en', OPTIONS);
    for (const model of ['openai:gpt-4o-mini', 'openai/gpt-4o-mini']) {
      expect(translator.boundMicro(line('Buenos días.'), 'en', { ...OPTIONS, model })).toBe(bare);
    }
    expect(() => translator.boundMicro(line('Buenos días.'), 'en', { ...OPTIONS, model: 'anthropic:claude-opus-4-1' })).toThrow("names provider 'anthropic'");
  });

  it("defaults maxOutputTokens to the smaller of 2,048 and 64 plus three times the line's tokens", () => {
    expect(TranscriptTranslator.defaultMaxOutputTokens('Buenos días.')).toBe(64 + 3 * Math.ceil('Buenos días.'.length / 4));
    expect(TranscriptTranslator.defaultMaxOutputTokens('x'.repeat(40_000))).toBe(2_048);
  });

  it('bounds an OpenAI reasoning model at the cap its call sends: the default cap and 1,024 tokens of room for its reasoning', () => {
    const translator = new TranscriptTranslator();
    const text = 'Buenos días.';
    const cap = TranscriptTranslator.defaultMaxOutputTokens(text) + 1_024;
    for (const model of [REASONING_MODEL, `openai:${REASONING_MODEL}`]) {
      expect(translator.boundMicro(line(text), 'en', { ...OPTIONS, model })).toBe(translator.boundMicro(line(text), 'en', { ...OPTIONS, model: REASONING_MODEL, maxOutputTokens: cap }));
    }
    // A cap the host sets is the whole cap, the reasoning included.
    expect(translator.boundMicro(line(text), 'en', { ...OPTIONS, model: REASONING_MODEL, maxOutputTokens: 200 })).toBeLessThan(translator.boundMicro(line(text), 'en', { ...OPTIONS, model: REASONING_MODEL }));
  });
});
