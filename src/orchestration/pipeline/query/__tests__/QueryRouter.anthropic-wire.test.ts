/**
 * @fileoverview QueryRouter on its Anthropic defaults, on the wire. With only
 * `ANTHROPIC_API_KEY` set, a routed question goes through the real
 * classifier, the real generator, the real `generateText` and the real
 * AnthropicProvider, with only `fetch` stubbed, and the test reads each
 * request body the provider put on the wire: the classifier and a plain-tier
 * answer on Claude Haiku 5.5, a deep-tier answer on Claude Sonnet 5.5, and no
 * sampling field on any of them (the classifier asks for temperature 0.1 and
 * the generator for 0.7 or 0.3; these models answer a non-default
 * `temperature` with a 400).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue([
      { name: 'pricing.md', isDirectory: () => false, isFile: () => true },
    ]),
    readFileSync: vi.fn().mockReturnValue('# Pricing\n\nStarts at $19/month for the Starter plan.'),
  };
});

type Json = Record<string, any>;

const PROVIDER_VARIABLES = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_BASE_URL',
  'OLLAMA_BASE_URL',
];

/** A streamed text reply from `model`, as the Messages API sends it. */
function textReply(model: string, text: string): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_${model}`, type: 'message', role: 'assistant', content: [], model,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 80, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** The classifier's answer with its retrieval plan, at `tier` with `strategy`. */
function classification(tier: number, strategy: string): string {
  return JSON.stringify({
    thinking: 'Pricing is in the corpus.',
    tier,
    strategy,
    confidence: 0.95,
    internal_knowledge_sufficient: tier === 0,
    suggested_sources: [],
    tools_needed: [],
    sources: { vector: tier > 0, bm25: tier > 0, graph: false, raptor: false, memory: false, multimodal: false },
    hyde: { enabled: false, hypothesisCount: 0 },
    memoryTypes: [],
    modalities: ['text'],
    temporal: { preferRecent: false, recencyBoost: 1.0, maxAgeMs: null },
    graphConfig: { maxDepth: 2, minEdgeWeight: 0.3 },
    raptorLayers: [0],
    deepResearch: false,
    skills: [],
    tools: [],
    extensions: [],
    requires_external_calls: false,
  });
}

/**
 * Answers each request to Anthropic's Messages API with the next of `texts`,
 * from the model the request names; any other request fails, so a call that
 * leaves Anthropic is seen.
 */
function answerInOrder(texts: string[]): void {
  const queue = [...texts];
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    if (!String(url).includes('api.anthropic.com/v1/messages')) {
      throw new Error(`unexpected request to ${String(url)}`);
    }
    const body = JSON.parse(String(init?.body)) as Json;
    const text = queue.shift();
    if (text === undefined) throw new Error(`unexpected request for model ${String(body.model)}`);
    return textReply(String(body.model), text);
  });
}

/** The URL and parsed body of every request, in call order. */
function requests(): Array<{ url: string; body: Json }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as { body?: unknown }).body)) as Json,
  }));
}

/**
 * Loads the router afresh after the case has set its environment (its
 * defaults are read when its module loads) and routes one question.
 */
async function routeOnce(query: string) {
  vi.resetModules();
  const { QueryRouter } = await import('../QueryRouter.js');
  const router = new QueryRouter({
    knowledgeCorpus: ['/fake/docs'],
    graphEnabled: false,
    deepResearchEnabled: false,
    cacheResults: false,
    // Gemini embeddings with no Gemini key: no embedding step runs, and
    // retrieval stays on keywords, so every request here is the classifier's
    // or the generator's.
    embeddingProvider: 'gemini',
    embeddingModel: 'gemini-embedding-2',
  });
  await router.init();
  return router.route(query);
}

describe("QueryRouter on Anthropic's key alone, on the wire", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    for (const name of PROVIDER_VARIABLES) vi.stubEnv(name, '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('classifies and answers a plain question on Claude Haiku 5.5, with no sampling field', async () => {
    answerInOrder([classification(0, 'none'), 'The Starter plan costs $19/month.']);

    const result = await routeOnce('How much does it cost?');

    expect(result.answer).toBe('The Starter plan costs $19/month.');
    const sent = requests();
    expect(sent).toHaveLength(2);
    for (const { url, body } of sent) {
      expect(url).toContain('api.anthropic.com/v1/messages');
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
      expect(JSON.stringify(body.messages)).toContain('How much does it cost?');
    }
  });

  it('answers a deep-tier question on Claude Sonnet 5.5, with no sampling field', async () => {
    answerInOrder([classification(2, 'moderate'), 'Plans start at $19/month; the Starter plan covers one seat.']);

    const result = await routeOnce('How much does it cost?');

    expect(result.answer).toBe('Plans start at $19/month; the Starter plan covers one seat.');
    const sent = requests();
    expect(sent).toHaveLength(2);
    // The classifier stays on the small model; the deep tier's answer is Sonnet's.
    expect(sent.map(({ body }) => body.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    for (const { url, body } of sent) {
      expect(url).toContain('api.anthropic.com/v1/messages');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
    }
  });
});
