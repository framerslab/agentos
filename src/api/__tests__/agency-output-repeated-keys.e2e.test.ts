/**
 * @file agency-output-repeated-keys.e2e.test.ts
 * An agency's `output` schema refuses a final text in which one object repeats
 * a key: `JSON.parse` would keep only the key's last value, and `parsed` would
 * carry a halved object with no sign. Plain JSON, a fenced block and an object
 * inside prose are refused alike; `generate()` repeats the run with the reply
 * quoted, as for any text that does not match, and `stream()` leaves `parsed`
 * undefined. Real agency(), agent(), generateText, streamText and
 * OpenAIProvider; only fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency } from '../agency.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
const KEY = 'sk-output-repeated-keys-0001';
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
const listing = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
const text = (content: string) =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const delta = (d: Json, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta: d, finish_reason: finish }] });
const textStream = (content: string) =>
  sse([delta({ role: 'assistant', content }), delta({}, 'stop'), { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [], usage: USAGE }, '[DONE]']);

/** Answers the model listing always, and the chat requests in turn with `replies`; the last reply answers every request after it. */
function serveAnswer(...replies: string[]): void {
  let next = 0;
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/\/v1\/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const content = replies[Math.min(next++, replies.length - 1)];
    const body = JSON.parse(String(init?.body)) as Json;
    return body.stream ? textStream(content) : text(content);
  });
}

/** The bodies of the chat requests the stub answered: one for each run of the strategy's one agent. */
const chatBodies = (): Json[] =>
  fetchMock.mock.calls
    .filter(([url]) => /\/v1\/chat\/completions/.test(String(url)))
    .map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);

const PROMPT = 'List the items on the order.';
const ITEMS = z.object({ items: z.array(z.object({ id: z.string() })) });
/** `items` written twice: `JSON.parse` keeps only `[{"id":"c"}]`, which matches the schema. */
const REPEATED = '{"items":[{"id":"a"},{"id":"b"}],"items":[{"id":"c"}]}';
const CLEAN = '{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}';

type Team = {
  generate: (prompt: string) => Promise<unknown>;
  stream: (prompt: string) => { fullStream: AsyncIterable<Json>; text: Promise<string>; parsed: Promise<unknown> };
};

/** One agent under the sequential strategy with the `ITEMS` output schema. */
function team(): Team {
  return agency({
    provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
    agents: { worker: { instructions: 'You list the items of an order as JSON.' } },
    strategy: 'sequential',
    output: ITEMS,
  } as never) as unknown as Team;
}

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe('an agency output schema and a reply that repeats a key', () => {
  it('generate() refuses the reply, whether plain, fenced or inside prose, and parses the next run', async () => {
    for (const reply of [REPEATED, '```json\n' + REPEATED + '\n```', `Here is the order: ${REPEATED} as asked.`]) {
      fetchMock.mockReset();
      serveAnswer(reply, CLEAN);
      const result = (await team().generate(PROMPT)) as Json;
      expect(result.text).toBe(CLEAN);
      expect(result.parsed).toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
      const bodies = chatBodies();
      expect(bodies).toHaveLength(2);
      // The repeat quotes the refused reply, as for any reply that does not match.
      expect(JSON.stringify(bodies[1].messages)).toContain(JSON.stringify(REPEATED).slice(1, -1));
    }
  });

  it('generate() returns parsed undefined when every run repeats a key, never the halved object', async () => {
    serveAnswer(REPEATED);
    const result = (await team().generate(PROMPT)) as Json;
    expect(result.text).toBe(REPEATED);
    expect(result.parsed).toBeUndefined();
    expect(chatBodies()).toHaveLength(2);
  });

  it('stream() leaves parsed undefined for a reply that repeats a key', async () => {
    serveAnswer(REPEATED);
    const s = team().stream(PROMPT);
    for await (const _part of s.fullStream) {
      // drain
    }
    await expect(s.text).resolves.toBe(REPEATED);
    await expect(s.parsed).resolves.toBeUndefined();
  });

  it('a reply that keeps its keys distinct is parsed on the first run', async () => {
    serveAnswer(CLEAN);
    const result = (await team().generate(PROMPT)) as Json;
    expect(result.parsed).toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    expect(chatBodies()).toHaveLength(1);
  });
});
