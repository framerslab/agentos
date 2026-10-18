/**
 * @fileoverview LLMUtilityAI through the real AIModelProviderManager, OpenAIProvider, LiteLLMProvider and
 * fetch, against a local server that answers as an OpenAI-compatible API under two base paths, one per
 * provider. Each case reads the requests a call sent: the provider's path it reached, the model and the
 * response format in its body, and its system prompt. A request outside the server fails the case.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AIModelProviderManager } from '../../../../core/llm/providers/AIModelProviderManager';
import { GMIErrorCode } from '../../../../core/utils/errors.js';
import { HybridUtilityAI } from '../HybridUtilityAI';
import { LLMUtilityAI } from '../LLMUtilityAI';
import { StatisticalUtilityAI } from '../StatisticalUtilityAI';

interface ChatRequest {
  path: string;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: unknown;
    max_tokens?: number;
  };
}

/** The chat completions the server received in the current case, in order. */
const received: ChatRequest[] = [];
/** The text of each reply the server gives, in order; a case queues exactly the replies it needs. */
let replies: string[] = [];
/** The URLs a call tried outside the server. */
const outside: string[] = [];

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

const MODELS = { object: 'list', data: ['gpt-4o', 'gpt-4o-mini'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'test' })) };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        send(200, MODELS);
        return;
      }
      if (req.method === 'POST' && path.endsWith('/v1/chat/completions')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatRequest['body'];
        received.push({ path, body });
        const content = replies.shift() ?? '';
        send(200, {
          id: `reply-${received.length}`,
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }
      send(404, { error: { message: `no route for ${req.method} ${path}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let manager: AIModelProviderManager;
let utility: LLMUtilityAI;

beforeEach(async () => {
  received.length = 0;
  outside.length = 0;
  replies = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${origin}/`)) {
      outside.push(url);
      return Promise.reject(new Error(`outside the test server: ${url}`));
    }
    return realFetch(input, init);
  });
  manager = new AIModelProviderManager();
  await manager.initialize({
    providers: [
      { providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test-key', baseURL: `${origin}/openai/v1`, maxRetries: 1 } },
      { providerId: 'litellm', enabled: true, config: { apiKey: 'test-key', baseURL: `${origin}/litellm/v1` } },
    ],
  });
  utility = new LLMUtilityAI('llm-utility-http');
  await utility.initialize({
    llmProviderManager: manager,
    defaultProviderId: 'openai',
    defaultModelId: 'gpt-4o',
    jsonFixerModelId: 'gpt-4o',
  });
});

afterEach(async () => {
  await manager.shutdown();
  vi.restoreAllMocks();
  expect(outside).toEqual([]);
});

/** Each chat request as the provider path it reached and the model it named. */
const routes = () => received.map((request) => [request.path, request.body.model]);
const systemPrompt = (request: ChatRequest) => request.body.messages.find((message) => message.role === 'system')?.content ?? '';

describe('LLMUtilityAI over a provider manager', () => {
  it('sends a call to the provider its providerId names', async () => {
    replies = ['{"score": -0.8, "polarity": "negative", "intensity": 0.8}'];
    const result = await utility.analyzeSentiment('The update broke everything.', { providerId: 'litellm', modelId: 'gpt-4o-mini' });
    expect(result).toMatchObject({ score: -0.8, polarity: 'negative' });
    expect(routes()).toEqual([['/litellm/v1/chat/completions', 'gpt-4o-mini']]);
  });

  it('summarizes on the provider its providerId names', async () => {
    replies = ['A short summary.'];
    expect(await utility.summarize('A long text to summarize.', { providerId: 'litellm' })).toBe('A short summary.');
    expect(routes()).toEqual([['/litellm/v1/chat/completions', 'gpt-4o']]);
  });

  it('gives a summary room for the length it asks for, and a longer one never less room', async () => {
    replies = ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'];
    // 44 characters, 100 times: 4,400.
    const text = 'The refund goes back to the card that paid. '.repeat(100);
    await utility.summarize(text, { desiredLength: 'short' });
    await utility.summarize(text, { desiredLength: 20 });
    await utility.summarize(text, { desiredLength: 100 });
    await utility.summarize(text, { desiredLength: 150 });
    await utility.summarize(text, { desiredLength: 0.25 });
    await utility.summarize(text, { desiredLength: 150, methodOptions: { maxTokens: 300 } });
    // 500 tokens at least and 4,000 at most: 60 a sentence for a count, a token a character of the text for a share,
    // and methodOptions.maxTokens over both.
    expect(received.map((request) => request.body.max_tokens)).toEqual([500, 1200, 4000, 4000, 1100, 300]);
    expect(systemPrompt(received[3])).toContain('about 150 sentences');
  });

  it('asks for a summary in plain words, at the length and in the form the call names', async () => {
    replies = ['One.', 'Two.', 'Three.'];
    const text = 'The refund goes back to the card that paid.';
    await utility.summarize(text);
    await utility.summarize(text, { desiredLength: 'short' });
    await utility.summarize(text, { desiredLength: 0.25, method: 'key_points_llm' });
    expect(received.map((request) => systemPrompt(request))).toEqual([
      'Summarize the following text as a summary of medium length, written as prose. Focus on the main ideas and key information.',
      'Summarize the following text as a very short, concise summary (1-2 sentences), written as prose. Focus on the main ideas and key information.',
      'Summarize the following text as a summary about 25% of the original length, written as a list of key bullet points. Focus on the main ideas and key information.',
    ]);
  });

  it('sends a hybrid call whose method only one of its classes has to that class', async () => {
    const stats = new StatisticalUtilityAI('stat-for-hybrid');
    await stats.initialize({ utilityId: 'stat-for-hybrid', defaultLanguage: 'en' });
    await stats.trainModel(
      [
        { text: 'invoices overdue, payments failed', label: 'billing' },
        { text: 'payments bouncing, invoices unpaid', label: 'billing' },
        { text: 'parcels arrived damaged, boxes crushed', label: 'shipping' },
        { text: 'parcels delayed, boxes missing', label: 'shipping' },
      ],
      'text_classifier_naive_bayes',
      { modelId: 'tickets' },
    );
    const hybrid = new HybridUtilityAI({ llm: utility, statistical: stats });

    // Methods the statistical class has and the LLM-backed one refuses or would send to a model: no request leaves.
    const summary = await hybrid.summarize('The parcel is late. It was due on Monday. Where is it now?', {
      method: 'first_n_sentences',
      desiredLength: 'short',
    });
    expect(summary).toBe('The parcel is late. It was due on Monday.');
    const ticket = await hybrid.classifyText('boxes crushed, parcels delayed', {
      candidateClasses: ['billing', 'shipping'],
      method: 'naive_bayes',
      modelId: 'tickets',
    });
    expect(ticket.bestClass).toBe('shipping');
    expect(received).toHaveLength(0);

    // Methods only the LLM-backed class has, where the statistical class refuses the method or scores without it.
    replies = ['{"similarityScore": 0.9}', '{"score": -0.8, "polarity": "negative"}'];
    expect(await hybrid.calculateSimilarity('a refund', 'money back', { method: 'llm_semantic' })).toBe(0.9);
    expect((await hybrid.analyzeSentiment('The update broke everything.', { method: 'llm' })).score).toBe(-0.8);
    expect(received).toHaveLength(2);

    // A call that names no method goes where it always went.
    replies = ['A short summary.'];
    expect(await hybrid.summarize('The parcel is late.')).toBe('A short summary.');
    expect((await hybrid.analyzeSentiment('I love it.')).polarity).toBe('positive');
    expect(received).toHaveLength(3);
  });

  it('sends a hybrid keyword call or classification that names a counting method to the statistical class', async () => {
    const stats = new StatisticalUtilityAI('stat-for-hybrid-counts');
    await stats.initialize({ utilityId: 'stat-for-hybrid-counts', defaultLanguage: 'en' });
    const hybrid = new HybridUtilityAI({ llm: utility, statistical: stats });
    // parcels and lost twice each, in that order of first appearance.
    const keywords = await hybrid.extractKeywords('parcels delayed, parcels lost, boxes lost', { method: 'frequency_based', maxKeywords: 2 });
    expect(keywords).toEqual(['parcels', 'lost']);
    const matched = await hybrid.classifyText('the parcel is late', { candidateClasses: ['billing', 'parcel'], method: 'keyword_matching' });
    expect(matched.bestClass).toBe('parcel');
    expect(received).toHaveLength(0);
  });

  it('still takes a provider from methodOptions.providerId', async () => {
    replies = ['{"bestClass": "billing", "confidence": 0.9}'];
    const result = await utility.classifyText('Where is my refund?', {
      candidateClasses: ['billing', 'shipping'],
      methodOptions: { providerId: 'litellm' },
    });
    expect(result.bestClass).toBe('billing');
    expect(routes()).toEqual([['/litellm/v1/chat/completions', 'gpt-4o']]);
  });

  it('asks for keywords as a JSON object, under the json_object response format, and reads its list', async () => {
    replies = ['{"keywords": ["refund", "card", "order"]}'];
    const keywords = await utility.extractKeywords('My card was charged twice for one order and I want a refund.', { maxKeywords: 3 });
    expect(keywords).toEqual(['refund', 'card', 'order']);
    expect(received).toHaveLength(1);
    expect(received[0].body.response_format).toEqual({ type: 'json_object' });
    expect(systemPrompt(received[0])).toContain('JSON object');
    expect(systemPrompt(received[0])).toContain('"keywords"');
  });

  it('asks for the languages as a JSON object and reads its list', async () => {
    replies = ['{"languages": [{"language": "fr", "confidence": 0.97}, {"language": "it", "confidence": 0.02}]}'];
    const ranked = await utility.detectLanguage('Tous les êtres humains naissent libres et égaux.', { maxCandidates: 2 });
    expect(ranked).toEqual([
      { language: 'fr', confidence: 0.97 },
      { language: 'it', confidence: 0.02 },
    ]);
    expect(received[0].body.response_format).toEqual({ type: 'json_object' });
    expect(systemPrompt(received[0])).toContain('"languages"');
  });

  it('keeps the strings of a keyword list, and the language entries with a code and a confidence', async () => {
    replies = [
      '{"keywords": ["refund", 7, "card"]}',
      '{"languages": [{"confidence": 0.5}, {"language": "fr", "confidence": "0.9"}, {"language": "it", "confidence": "high"}]}',
    ];
    expect(await utility.extractKeywords('My card was charged twice and I want a refund.')).toEqual(['refund', 'card']);
    // A confidence written as a number in a string is read as that number.
    expect(await utility.detectLanguage('Bonjour à tous', { maxCandidates: 3 })).toEqual([{ language: 'fr', confidence: 0.9 }]);
  });

  it('passes over a language entry whose confidence is null, a boolean, an empty string or a list', async () => {
    replies = [
      JSON.stringify({
        languages: [
          { language: 'en', confidence: null },
          { language: 'fr', confidence: true },
          { language: 'de', confidence: '' },
          { language: 'es', confidence: [] },
          { language: 'it', confidence: '0.4' },
          { language: 'pt', confidence: 0.3 },
        ],
      }),
    ];
    expect(await utility.detectLanguage('Bom dia a todos, ciao a tutti', { maxCandidates: 6 })).toEqual([
      { language: 'it', confidence: 0.4 },
      { language: 'pt', confidence: 0.3 },
    ]);
  });

  it('reads the numbers of a sentiment reply written as strings, holds them to their ranges and makes its word lists entries', async () => {
    replies = [
      '{"score": "-0.8", "polarity": "Negative", "intensity": "0.7", "negativeTokens": ["broke", 7, {"token": "everything", "score": -0.5}], "positiveTokens": "none"}',
      '{"score": 4, "polarity": "mixed", "intensity": 9}',
      '{"score": 0, "polarity": "neutral", "negativeTokens": "n/a"}',
    ];
    expect(await utility.analyzeSentiment('The update broke everything.')).toEqual({
      score: -0.8,
      polarity: 'negative',
      comparative: -0.8,
      intensity: 0.7,
      positiveTokens: [],
      negativeTokens: [{ token: 'broke' }, { token: 'everything', score: -0.5 }],
      neutralTokens: [],
    });
    // A score past 1 is 1, an intensity past 1 is 1, and a polarity other than the three follows the score.
    expect(await utility.analyzeSentiment('Best update ever.')).toMatchObject({ score: 1, polarity: 'positive', intensity: 1 });
    // A word list that is not a list holds no words, so a neutral reply does not read as three negative words.
    expect((await utility.analyzeSentiment('The table is next to the door.')).negativeTokens).toEqual([]);
  });

  it('reads a classification confidence written as a string, and holds confidences to 0 to 1', async () => {
    replies = [
      '{"bestClass": "billing", "confidence": "0.92"}',
      '{"bestClass": ["billing", "shipping"], "confidence": [1.4, "0.3"], "allScores": [{"classLabel": "billing", "score": 3}, {"classLabel": 5, "score": 0.2}]}',
      '{"languages": [{"language": "fr", "confidence": 97}]}',
    ];
    const candidateClasses = ['billing', 'shipping', 'returns'];
    expect(await utility.classifyText('Where is my refund?', { candidateClasses })).toEqual({
      bestClass: 'billing',
      confidence: 0.92,
      allScores: [
        { classLabel: 'billing', score: 0.92 },
        { classLabel: 'shipping', score: 0.1 },
        { classLabel: 'returns', score: 0.1 },
      ],
    });
    expect(await utility.classifyText('Charged twice and the parcel is late.', { candidateClasses, multiLabel: true })).toEqual({
      bestClass: ['billing', 'shipping'],
      confidence: [1, 0.3],
      allScores: [{ classLabel: 'billing', score: 1 }],
    });
    expect(await utility.detectLanguage('Bonjour à tous')).toEqual([{ language: 'fr', confidence: 1 }]);
  });

  it('answers an empty list of classes for a multi-label reply that names none', async () => {
    replies = ['{"bestClass": [], "confidence": []}'];
    const candidateClasses = ['billing', 'shipping'];
    expect(await utility.classifyText('The weather is fine today.', { candidateClasses, multiLabel: true })).toEqual({
      bestClass: [],
      confidence: [],
      allScores: [
        { classLabel: 'billing', score: 0.1 },
        { classLabel: 'shipping', score: 0.1 },
      ],
    });
  });

  it('refuses a sentiment, classification or readability reply whose number or class is not one', async () => {
    replies = [
      '{"score": null, "polarity": "neutral"}',
      '{"bestClass": "billing", "confidence": "high"}',
      '{"bestClass": 5, "confidence": 0.9}',
      '{"score": true, "interpretation": "Easy to read."}',
    ];
    const parsingError = { code: GMIErrorCode.PARSING_ERROR };
    await expect(utility.analyzeSentiment('The table is next to the door.')).rejects.toMatchObject(parsingError);
    const candidateClasses = ['billing', 'shipping'];
    await expect(utility.classifyText('Where is my refund?', { candidateClasses })).rejects.toMatchObject(parsingError);
    await expect(utility.classifyText('Where is my refund?', { candidateClasses })).rejects.toMatchObject(parsingError);
    await expect(utility.calculateReadability('The cat sat on the mat.', { formula: 'flesch_kincaid_reading_ease' })).rejects.toMatchObject(parsingError);
    expect(received).toHaveLength(4);
  });

  it('repairs a reply that does not parse on the model and provider of the call', async () => {
    replies = ['score -0.8, polarity negative', '{"score": -0.8, "polarity": "negative"}'];
    const result = await utility.analyzeSentiment('The update broke everything.', { providerId: 'litellm', modelId: 'gpt-4o-mini' });
    expect(result.score).toBe(-0.8);
    expect(routes()).toEqual([
      ['/litellm/v1/chat/completions', 'gpt-4o-mini'],
      ['/litellm/v1/chat/completions', 'gpt-4o-mini'],
    ]);
  });

  it('repairs a similarity reply on the similarity call\'s own model and provider', async () => {
    replies = ['similarity 0.9', '{"similarityScore": 0.9}'];
    const score = await utility.calculateSimilarity('a refund', 'money back', { llmProviderId: 'litellm', llmModelId: 'gpt-4o-mini' });
    expect(score).toBe(0.9);
    expect(routes()).toEqual([
      ['/litellm/v1/chat/completions', 'gpt-4o-mini'],
      ['/litellm/v1/chat/completions', 'gpt-4o-mini'],
    ]);
  });

  it('normalizes text on textNormalizationModelId, in any language and with none named', async () => {
    const normalizer = new LLMUtilityAI('llm-normalizer');
    await normalizer.initialize({
      llmProviderManager: manager,
      defaultProviderId: 'openai',
      defaultModelId: 'gpt-4o',
      textNormalizationModelId: 'gpt-4o-mini',
    });
    replies = ['bonjour', 'some text', 'some text'];
    expect(await normalizer.normalizeText('Bonjour !', { language: 'fr' })).toBe('bonjour');
    await normalizer.normalizeText('Some TEXT');
    await normalizer.normalizeText('Some TEXT', { language: 'en-GB' });
    expect(routes()).toEqual([
      ['/openai/v1/chat/completions', 'gpt-4o-mini'],
      ['/openai/v1/chat/completions', 'gpt-4o-mini'],
      ['/openai/v1/chat/completions', 'gpt-4o-mini'],
    ]);
  });

  it('repairs text given to parseJsonSafe with llmModelIdForFix, else jsonFixerModelId, on llmProviderIdForFix', async () => {
    replies = ['{"ok": true}', '{"ok": true}'];
    expect(await utility.parseJsonSafe('{"ok": true', { attemptFixWithLLM: true, llmProviderIdForFix: 'litellm' })).toEqual({ ok: true });
    expect(await utility.parseJsonSafe('{"ok": true', { attemptFixWithLLM: true, llmModelIdForFix: 'gpt-4o-mini' })).toEqual({ ok: true });
    expect(routes()).toEqual([
      ['/litellm/v1/chat/completions', 'gpt-4o'],
      ['/openai/v1/chat/completions', 'gpt-4o-mini'],
    ]);
  });

  it('repairs up to maxRepairAttempts times, each repair on the text the one before answered', async () => {
    const userText = (request: ChatRequest) => request.body.messages.find((message) => message.role === 'user')?.content ?? '';
    replies = ['{"ok": tru', '{"ok": true}'];
    expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true, maxRepairAttempts: 2 })).toEqual({ ok: true });
    expect(received).toHaveLength(2);
    expect(userText(received[1])).toContain('{"ok": tru');

    // A repair that parses and fails the schema counts as an attempt too.
    const schema = { type: 'object', required: ['ok'] };
    replies = ['{"other": 1}', '{"ok": true}'];
    expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true, maxRepairAttempts: 2, targetSchema: schema })).toEqual({ ok: true });
    replies = ['{"other": 1}'];
    expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true, targetSchema: schema })).toBeNull();
    expect(received).toHaveLength(5);
  });

  it('reads a maxRepairAttempts that is not a whole number of 1 or more, Infinity and 2.9 included, as 1', async () => {
    for (const maxRepairAttempts of [Number.POSITIVE_INFINITY, Number.NaN, 0, -2, 2.9]) {
      replies = ['still not json', 'still not json'];
      expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true, maxRepairAttempts })).toBeNull();
    }
    // One repair call each.
    expect(received).toHaveLength(5);
  });

  it('names the schema, and the errors of a value that failed it, in the repair it asks for', async () => {
    const userText = (request: ChatRequest) => request.body.messages.find((message) => message.role === 'user')?.content ?? '';
    const schema = { type: 'object', required: ['ok'] };
    replies = ['{"ok": true}'];
    expect(await utility.parseJsonSafe('{"other": 1}', { attemptFixWithLLM: true, targetSchema: schema })).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(userText(received[0])).toContain('"required":["ok"]');
    expect(userText(received[0])).toContain("must have required property 'ok'");

    // A text that does not parse is sent with the schema too; with no schema, the prompt names none.
    replies = ['{"ok": true}', '{"ok": true}'];
    expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true, targetSchema: schema })).toEqual({ ok: true });
    expect(userText(received[1])).toContain('"required":["ok"]');
    expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true })).toEqual({ ok: true });
    expect(userText(received[2])).not.toContain('Schema');
  });

  it('answers null for a targetSchema that does not compile, and asks for no repair', async () => {
    // 'nonsense' is no JSON Schema type, so Ajv cannot compile the schema and no text can pass it.
    const schema = { type: 'object', properties: { ok: { type: 'nonsense' } } };
    replies = ['{"ok": true}', '{"ok": true}'];
    expect(await utility.parseJsonSafe('{"ok": tr', { attemptFixWithLLM: true, targetSchema: schema })).toBeNull();
    expect(await utility.parseJsonSafe('{"ok": true}', { attemptFixWithLLM: true, targetSchema: schema })).toBeNull();
    expect(received).toHaveLength(0);
  });

  it('checks targetSchema in the statistical class too, so a hybrid repairs a value that fails it', async () => {
    const stats = new StatisticalUtilityAI('stat-for-schema');
    await stats.initialize({ utilityId: 'stat-for-schema' });
    const schema = { type: 'object', required: ['ok'] };
    expect(await stats.parseJsonSafe('{"other": 1}', { targetSchema: schema })).toBeNull();
    expect(await stats.parseJsonSafe('{"ok": true}', { targetSchema: schema })).toEqual({ ok: true });
    expect(await stats.parseJsonSafe('{"ok": true}', { targetSchema: { type: 'nonsense' } })).toBeNull();
    expect(received).toHaveLength(0);

    // The statistical class answers null for the value that fails the schema, and the LLM-backed class repairs it.
    const hybrid = new HybridUtilityAI({ llm: utility, statistical: stats });
    replies = ['{"ok": true}'];
    expect(await hybrid.parseJsonSafe('{"other": 1}', { targetSchema: schema, attemptFixWithLLM: true })).toEqual({ ok: true });
    expect(received).toHaveLength(1);
  });

  it('checks the standard formats a targetSchema names, and passes over a keyword or a format Ajv does not know', async () => {
    const stats = new StatisticalUtilityAI('stat-for-formats');
    await stats.initialize({ utilityId: 'stat-for-formats' });
    // date-time is a standard format. `example` is no JSON Schema keyword, which JSON Schema says to pass over, and
    // `ticket-code` is no format Ajv knows: neither keeps the schema from compiling.
    const schema = {
      type: 'object',
      required: ['at'],
      properties: { at: { type: 'string', format: 'date-time' }, code: { type: 'string', format: 'ticket-code' } },
      example: { at: '2026-10-18T02:00:00Z' },
    };
    for (const parser of [utility, stats]) {
      expect(await parser.parseJsonSafe('{"at": "2026-10-18T02:00:00Z", "code": "A-1"}', { targetSchema: schema })).toEqual({
        at: '2026-10-18T02:00:00Z',
        code: 'A-1',
      });
      expect(await parser.parseJsonSafe('{"at": "yesterday"}', { targetSchema: schema })).toBeNull();
    }
    expect(received).toHaveLength(0);
  });

  it('answers a value as its targetSchema coerces it, the value itself too', async () => {
    const stats = new StatisticalUtilityAI('stat-for-coercion');
    await stats.initialize({ utilityId: 'stat-for-coercion' });
    for (const parser of [utility, stats]) {
      // Under type number Ajv reads "5" as 5: inside an object it changes the object, and the value itself the answer.
      expect(await parser.parseJsonSafe('"5"', { targetSchema: { type: 'number' } })).toBe(5);
      expect(await parser.parseJsonSafe('{"n": "5"}', { targetSchema: { type: 'object', properties: { n: { type: 'number' } } } })).toEqual({ n: 5 });
    }
    expect(received).toHaveLength(0);
  });

  it('keeps checking after a targetSchema that takes the $id of the draft-07 meta-schema', async () => {
    const stats = new StatisticalUtilityAI('stat-for-meta-id');
    await stats.initialize({ utilityId: 'stat-for-meta-id' });
    // Ajv holds its meta-schema under this $id and refuses a second schema under it. A schema that names the draft by
    // $schema is checked against that meta-schema, so it compiles only while Ajv still holds it.
    const takesMetaId = () => ({ $id: 'http://json-schema.org/draft-07/schema#', type: 'object' });
    const namesTheDraft = () => ({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['ok'] });
    for (const parser of [utility, stats]) {
      expect(await parser.parseJsonSafe('{}', { targetSchema: takesMetaId() })).toBeNull();
      expect(await parser.parseJsonSafe('{"ok": true}', { targetSchema: namesTheDraft() })).toEqual({ ok: true });
    }
    expect(received).toHaveLength(0);
  });

  it('checks a targetSchema with an $id that each call builds anew', async () => {
    const stats = new StatisticalUtilityAI('stat-for-ids');
    await stats.initialize({ utilityId: 'stat-for-ids' });
    // A caller that writes its schema in the call hands over a new object every time, under the same $id.
    const schemaFor = () => ({ $id: 'urn:example:reply', type: 'object', required: ['ok'] });
    for (const parser of [utility, stats]) {
      expect(await parser.parseJsonSafe('{"ok": true}', { targetSchema: schemaFor() })).toEqual({ ok: true });
      expect(await parser.parseJsonSafe('{"ok": false}', { targetSchema: schemaFor() })).toEqual({ ok: false });
      expect(await parser.parseJsonSafe('{"other": 1}', { targetSchema: schemaFor() })).toBeNull();
    }
    expect(received).toHaveLength(0);
  });

  it('checks a targetSchema under an $id that an earlier schema gave a part of itself', async () => {
    const stats = new StatisticalUtilityAI('stat-for-inner-id');
    await stats.initialize({ utilityId: 'stat-for-inner-id' });
    // An $id inside a schema names that part of it. Once that schema is checked, the $id names nothing Ajv holds, so a
    // schema of its own may take it.
    const withItem = () => ({ type: 'object', properties: { item: { $id: 'urn:example:item', type: 'string' } } });
    const item = () => ({ $id: 'urn:example:item', type: 'string' });
    for (const parser of [utility, stats]) {
      expect(await parser.parseJsonSafe('{"item": "a"}', { targetSchema: withItem() })).toEqual({ item: 'a' });
      expect(await parser.parseJsonSafe('"b"', { targetSchema: item() })).toBe('b');
    }
    expect(received).toHaveLength(0);
  });

  it('answers null for a targetSchema marked $async, and asks for no repair', async () => {
    const stats = new StatisticalUtilityAI('stat-for-async');
    await stats.initialize({ utilityId: 'stat-for-async' });
    // Ajv compiles a schema marked $async to a check that answers a promise, which settles after the call has read it.
    const schema = { $async: true, type: 'number' };
    for (const parser of [utility, stats]) {
      expect(await parser.parseJsonSafe('"five"', { targetSchema: schema })).toBeNull();
    }
    expect(await utility.parseJsonSafe('"five"', { targetSchema: schema, attemptFixWithLLM: true })).toBeNull();
    expect(received).toHaveLength(0);
  });
});

describe('LLMUtilityAI before initialize()', () => {
  it('refuses a summary with NOT_INITIALIZED', async () => {
    await expect(new LLMUtilityAI().summarize('A text to summarize.')).rejects.toMatchObject({ code: GMIErrorCode.NOT_INITIALIZED });
  });
});
