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

import { setLogger, resetLoggerFactory } from '../../../../core/logging/loggerFactory.js';
import { globalLLMProviderHealth } from '../../../../core/safety/LLMProviderHealthRegistry';
import { TranslationProviderError } from '../interfaces';
import { TRANSLATOR_VERSION, TranscriptTranslator, type TranscriptLineInput } from '../TranscriptTranslator';
import { openAiRequiresResponsesApi } from '../../../../core/llm/providers/implementations/OpenAIProvider';
import { modelPricing } from '../../../../api/runtime/modelPricing';
import { estimateCallCostUSD } from '../../../../api/runtime/spendBudget';
import { toMicro } from '../../../../safety/runtime/SpendReservations';

/** A model OpenAI serves on /v1/responses alone, so a call to it takes the Responses route. */
const RESPONSES_MODEL = 'gpt-5.3-codex';

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
      return jsonResponse({ object: 'list', data: ['gpt-4o-mini', RESPONSES_MODEL].map((id) => ({ id, object: 'model', created: 1, owned_by: 'openai' })) });
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

  it("defaults maxOutputTokens to the smaller of 2,048 and 64 plus three times the line's tokens", () => {
    expect(TranscriptTranslator.defaultMaxOutputTokens('Buenos días.')).toBe(64 + 3 * Math.ceil('Buenos días.'.length / 4));
    expect(TranscriptTranslator.defaultMaxOutputTokens('x'.repeat(40_000))).toBe(2_048);
  });
});
