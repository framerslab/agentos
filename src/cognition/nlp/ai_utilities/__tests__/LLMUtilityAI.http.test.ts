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
import { LLMUtilityAI } from '../LLMUtilityAI';

interface ChatRequest {
  path: string;
  body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: unknown;
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

  it('repairs text given to parseJsonSafe with llmModelIdForFix, else jsonFixerModelId, on llmProviderIdForFix', async () => {
    replies = ['{"ok": true}', '{"ok": true}'];
    expect(await utility.parseJsonSafe('{"ok": true', { attemptFixWithLLM: true, llmProviderIdForFix: 'litellm' })).toEqual({ ok: true });
    expect(await utility.parseJsonSafe('{"ok": true', { attemptFixWithLLM: true, llmModelIdForFix: 'gpt-4o-mini' })).toEqual({ ok: true });
    expect(routes()).toEqual([
      ['/litellm/v1/chat/completions', 'gpt-4o'],
      ['/openai/v1/chat/completions', 'gpt-4o-mini'],
    ]);
  });
});

describe('LLMUtilityAI before initialize()', () => {
  it('refuses a summary with NOT_INITIALIZED', async () => {
    await expect(new LLMUtilityAI().summarize('A text to summarize.')).rejects.toMatchObject({ code: GMIErrorCode.NOT_INITIALIZED });
  });
});
