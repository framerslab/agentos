/**
 * @file anthropic-base-url.http.test.ts
 * A call on the anthropic provider, and an LLM judge on it, sent to a base URL: a local server answers as Anthropic's
 * Messages API does (https://platform.claude.com/docs/en/api/messages), and every request outside it is refused, so a
 * call that ignored the base URL and went to api.anthropic.com fails the case.
 *
 * - `ANTHROPIC_BASE_URL` routes a call on the anthropic provider, as `OPENAI_BASE_URL` routes one on openai. A value
 *   with surrounding whitespace is read trimmed, and an empty or whitespace-only one is unset.
 * - `hitl.llmJudge({ baseUrl })` sends its judge call to that base URL.
 * - The 1-hour share of a cache write (`usage.cache_creation.ephemeral_1h_input_tokens`,
 *   https://platform.claude.com/docs/en/build-with-claude/prompt-caching) reaches the usage a call returns and the
 *   cost a spend budget is charged: the 5-minute writes at 1.25x input and the 1-hour writes at 2x
 *   (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-04).
 *
 * Drives generateText and hitl.llmJudge through the real resolver, provider manager and AnthropicProvider.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateText } from '../generateText.js';
import { agency } from '../agency.js';
import { hitl } from '../hitl.js';
import { baseUrlIfSet, providerEnvVars, resolveProvider, shutdownProviderManagers } from '../model.js';
import { SpendBudget } from '../runtime/spendBudget.js';
import { registerModelPricing } from '../runtime/modelPricing.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { AnthropicProvider } from '../../core/llm/providers/implementations/AnthropicProvider.js';
import type { AgencyResult, ApprovalRequest } from '../types.js';

interface Received {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** Every request the server received in the current case, in order. */
const received: Received[] = [];
/** The requests no route answered. */
const unexpected: string[] = [];
/** The URLs a call tried outside the server. */
const outside: string[] = [];
/** The text the next Messages answer carries, and its usage. */
let answerText = 'Served at the base URL.';
let answerUsage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 };

let server: http.Server;
let origin: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', origin);
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
        unexpected.push(`${req.method} ${url.pathname}`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"no such route in this case"}}');
        return;
      }
      const body = received.at(-1)?.body ?? {};
      const model = (body.model as string | undefined) ?? 'claude-sonnet-4-6';
      if (body.stream === true) {
        // The provider asks for a stream and reads it whole: the events of
        // https://platform.claude.com/docs/en/build-with-claude/streaming, the usage on message_start but the output
        // tokens, which message_delta reports.
        const { output_tokens: outputTokens, ...startUsage } = answerUsage as { output_tokens?: number };
        const events: Array<[string, unknown]> = [
          ['message_start', { type: 'message_start', message: { id: 'msg_base_url', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...startUsage, output_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answerText } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens ?? 0 } }],
          ['message_stop', { type: 'message_stop' }],
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_base_url',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: answerText }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: answerUsage,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  unexpected.length = 0;
  outside.length = 0;
  answerText = 'Served at the base URL.';
  answerUsage = { input_tokens: 10, output_tokens: 5 };
  globalLLMProviderHealth.reset();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-base-url-0001');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  // Without these the resolver could send the call to another provider.
  for (const name of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'REQUESTY_API_KEY']) vi.stubEnv(name, '');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${origin}/`)) {
      outside.push(url);
      return Promise.reject(new Error(`outside the test server: ${url}`));
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  await shutdownProviderManagers();
  globalLLMProviderHealth.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(unexpected).toEqual([]);
  expect(outside).toEqual([]);
});

const ask = () => generateText({ provider: 'anthropic', model: 'claude-sonnet-4-6', prompt: 'Hello?', fallbackProviders: [] });

describe('ANTHROPIC_BASE_URL', () => {
  it('sends a call on the anthropic provider to the base URL it names, with the key', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', origin);

    const result = await ask();

    expect(result.text).toBe('Served at the base URL.');
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/messages']);
    expect(received[0]!.headers['x-api-key']).toBe('sk-ant-base-url-0001');
    expect(received[0]!.body.model).toBe('claude-sonnet-4-6');
  });

  it('reads a base URL with surrounding whitespace trimmed', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', `  ${origin}\n`);

    const result = await ask();

    expect(result.text).toBe('Served at the base URL.');
    expect(received).toHaveLength(1);
  });

  it('sends to /v1/messages, never //v1/messages, when the base URL ends with slashes', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', `${origin}//`);

    const result = await ask();

    expect(result.text).toBe('Served at the base URL.');
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/messages']);
  });

  it("reads an empty or whitespace-only value as unset, so the call is resolved to Anthropic's own endpoint", () => {
    for (const value of ['', '   ', '\t\n']) {
      vi.stubEnv('ANTHROPIC_BASE_URL', value);
      expect(resolveProvider('anthropic', 'claude-sonnet-4-6').baseUrl, JSON.stringify(value)).toBeUndefined();
    }
    vi.stubEnv('ANTHROPIC_BASE_URL', ` ${origin} `);
    expect(resolveProvider('anthropic', 'claude-sonnet-4-6').baseUrl).toBe(origin);
    // The anthropic provider's base-URL variable is listed beside its key's.
    expect(providerEnvVars('anthropic')).toEqual({ key: 'ANTHROPIC_API_KEY', url: 'ANTHROPIC_BASE_URL' });
  });
});

describe('AnthropicProvider given a base URL directly', () => {
  it('trims it before dropping its trailing slashes, so the request goes to /v1/messages', async () => {
    const provider = new AnthropicProvider();
    await provider.initialize({ apiKey: 'sk-ant-direct-0002', baseURL: `${origin}/ \n` });

    const res = await provider.generateCompletion('claude-sonnet-4-6', [{ role: 'user', content: 'Hello?' }], {});

    expect(JSON.stringify(res.choices[0]?.message?.content)).toContain('Served at the base URL.');
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/messages']);
  });
});

describe('baseUrlIfSet', () => {
  it('trims a set base URL and reads an empty or whitespace-only one as unset', () => {
    expect(baseUrlIfSet('  https://gateway.example/v1 \n')).toBe('https://gateway.example/v1');
    expect(baseUrlIfSet('https://gateway.example/v1')).toBe('https://gateway.example/v1');
    expect(baseUrlIfSet('')).toBeUndefined();
    expect(baseUrlIfSet(' \t\n')).toBeUndefined();
    expect(baseUrlIfSet(undefined)).toBeUndefined();
  });
});

describe('hitl.llmJudge on the anthropic provider', () => {
  const request: ApprovalRequest = {
    id: 'req-base-url',
    type: 'tool',
    agent: 'worker',
    action: 'read-file',
    description: 'Read /tmp/notes.txt',
    details: { path: '/tmp/notes.txt' },
    context: { agentCalls: [], totalTokens: 0, totalCostUSD: 0, elapsedMs: 1 },
  };

  beforeEach(() => {
    answerText = '{"approved": true, "confidence": 0.95, "reasoning": "Reading a file is safe."}';
  });

  it('sends its judge call to the baseUrl it is given', async () => {
    const judge = hitl.llmJudge({ provider: 'anthropic', model: 'claude-sonnet-4-6', baseUrl: origin, fallback: hitl.autoReject('fallback') });

    const decision = await judge(request);

    expect(decision).toEqual({ approved: true, reason: 'Reading a file is safe.' });
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/messages']);
    expect(received[0]!.headers['x-api-key']).toBe('sk-ant-base-url-0001');
  });

  it('sends its judge call to ANTHROPIC_BASE_URL when it is given no baseUrl', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', origin);
    const judge = hitl.llmJudge({ provider: 'anthropic', model: 'claude-sonnet-4-6', fallback: hitl.autoReject('fallback') });

    const decision = await judge(request);

    expect(decision.approved).toBe(true);
    expect(received).toHaveLength(1);
  });
});

describe("the lifetime of a call's cache writes", () => {
  // 100 input tokens, 600 written for 5 minutes and 400 for an hour, 100 output: on a $3 input and $15 output model,
  // 100 x $3 + 600 x $3.75 + 400 x $6 + 100 x $15 per 1M.
  const usd = (100 * 3 + 600 * 3.75 + 400 * 6 + 100 * 15) / 1e6;

  beforeEach(() => {
    answerUsage = {
      input_tokens: 100,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
    };
    // A model the catalog lacks, so the provider reports no cost and the budget prices the tokens at the host's row.
    registerModelPricing('anthropic', (id) =>
      id === 'claude-host-1'
        ? { inputPerMTokUSD: 3, outputPerMTokUSD: 15, cacheReadPerMTokUSD: 0.3, defaultCacheWritePerMTokUSD: 3.75, cacheWritePerMTokUSD: 6 }
        : undefined,
    );
  });

  afterEach(() => {
    registerModelPricing('anthropic', () => undefined);
  });

  it('takes the write total from the split when the usage gives the split alone', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', origin);
    // A gateway that reports the 5-minute and 1-hour counts without cache_creation_input_tokens.
    answerUsage = {
      input_tokens: 100,
      output_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
    };
    const budget = new SpendBudget({ maxCostUSD: 1 });

    const result = await generateText({ provider: 'anthropic', model: 'claude-host-1', prompt: 'Hello?', fallbackProviders: [], budget });

    expect(result.usage.cacheCreationTokens).toBe(1_000);
    expect(result.usage.cacheCreationExtendedTokens).toBe(400);
    expect(result.usage.inclusiveInputTokens).toBe(1_100);
    expect(budget.spentUSD()).toBeCloseTo(usd, 12);
  });

  it("reaches an agency's usage and each agent call's record", async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', origin);
    const team = agency({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      strategy: 'sequential',
      agents: { writer: { instructions: 'Write one line.' } },
    });

    const result = (await team.generate('Hello?')) as AgencyResult;

    const calls = received.filter((r) => r.path === '/v1/messages').length;
    expect(calls).toBeGreaterThan(0);
    expect(result.usage.cacheCreationTokens).toBe(1_000 * calls);
    expect(result.usage.cacheCreationExtendedTokens).toBe(400 * calls);
    expect(result.agentCalls[0]?.usage).toMatchObject({ cacheCreationTokens: 1_000, cacheCreationExtendedTokens: 400 });
  });

  it.each(['claude-sonnet-4-6', 'claude-host-1'])('on %s, reaches the usage the call returns and the cost its budget is charged', async (model) => {
    vi.stubEnv('ANTHROPIC_BASE_URL', origin);
    const budget = new SpendBudget({ maxCostUSD: 1 });

    const result = await generateText({ provider: 'anthropic', model, prompt: 'Hello?', fallbackProviders: [], budget });

    expect(result.usage.cacheCreationTokens).toBe(1_000);
    expect(result.usage.cacheCreationExtendedTokens).toBe(400);
    expect(budget.spentUSD()).toBeCloseTo(usd, 12);
  });
});
