/**
 * @fileoverview Coverage for the Gemini 3 catalog, the Gemini embedding models,
 * the retired Gemini 2.0 / 1.5 rows, and the shared `thinking` option.
 *
 * Also covers thought-summary parts and thought signatures on tool calls,
 * which Gemini 3 requires back on the next turn.
 *
 * The failures pinned here are silent ones. A missing catalog row throws
 * nothing: `getModelInfo` returns undefined and the call meters at zero. A
 * dropped thought signature also throws nothing locally; Gemini rejects the
 * next turn server-side. So these tests assert on catalog contents and on the
 * exact request body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { GeminiProvider } from '../implementations/GeminiProvider';
import { GeminiProviderError } from '../errors/GeminiProviderError';
import type { ChatMessage } from '../IProvider';

function mockJsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.resolve(data),
    body: null,
  } as unknown as Response;
}

function sseResponse(events: unknown[]): Response {
  const payload = events.map(e => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body } as unknown as Response;
}

const reply = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
};

describe('Gemini model catalog', () => {
  let provider: GeminiProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
  });

  it('lists the current Pro, Flash and Flash-Lite tiers', async () => {
    const ids = (await provider.listAvailableModels()).map(m => m.modelId);
    expect(ids).toEqual(expect.arrayContaining(['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']));
  });

  it('returns limits and prices for Gemini 3 ids', async () => {
    expect(await provider.getModelInfo('gemini-3.1-pro-preview')).toMatchObject({
      contextWindowSize: 1048576,
      pricePer1MTokensInput: 2,
      pricePer1MTokensOutput: 12,
    });
    // 3.8 Flash lists at $0.75 / $3.75 until 2027-01-01 and meters at the
    // $1.50 / $7.50 sticker rate so rollups stay conservative.
    expect(await provider.getModelInfo('gemini-3.8-flash')).toMatchObject({
      pricePer1MTokensInput: 1.5,
      pricePer1MTokensOutput: 7.5,
    });
  });

  it('prices a gemini-2.5-pro prompt over 200K tokens at its long-context tier', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      ...reply,
      usageMetadata: { promptTokenCount: 250_000, candidatesTokenCount: 10_000, totalTokenCount: 260_000 },
    }));
    const res = await provider.generateCompletion('gemini-2.5-pro', [{ role: 'user', content: 'hi' }], {});
    // The whole request bills $2.50 / $15.00 per 1M instead of $1.25 / $10.00.
    expect(res.usage!.costUSD).toBeCloseTo(0.25 * 2.5 + 0.01 * 15, 6);
  });

  it('prices gemini-2.5-flash at the published $0.30 / $2.50', async () => {
    expect(await provider.getModelInfo('gemini-2.5-flash')).toMatchObject({
      pricePer1MTokensInput: 0.3,
      pricePer1MTokensOutput: 2.5,
    });
  });

  it('lists both embedding models under the embeddings capability', async () => {
    const embedders = await provider.listAvailableModels({ capability: 'embeddings' });
    expect(embedders.map(m => m.modelId).sort()).toEqual(['gemini-embedding-001', 'gemini-embedding-2']);
    expect(embedders.every(m => m.embeddingDimension === 3072)).toBe(true);
  });

  it('prices gemini-embedding-2 and leaves the unpublished gemini-embedding-001 price unset', async () => {
    expect((await provider.getModelInfo('gemini-embedding-2'))!.pricePer1MTokensInput).toBe(0.2);
    // Google publishes no price for embedding-001. Unset reads as unknown;
    // a 0 here would read as free.
    expect((await provider.getModelInfo('gemini-embedding-001'))!.pricePer1MTokensInput).toBeUndefined();
  });

  it('keeps retired models listed but deprecated', async () => {
    // Both return HTTP 404 on generateContent (probed 2026-09-29). A deleted
    // row and a row that never existed both read as undefined.
    for (const id of ['gemini-2.0-flash', 'gemini-1.5-pro']) {
      expect((await provider.getModelInfo(id))?.status).toBe('deprecated');
    }
  });

  it('marks every other row active', async () => {
    const retired = new Set(['gemini-2.0-flash', 'gemini-1.5-pro']);
    for (const m of await provider.listAvailableModels()) {
      expect(m.status).toBe(retired.has(m.modelId) ? 'deprecated' : 'active');
    }
  });
});

describe('Gemini generateEmbeddings batching', () => {
  it('sends more than 100 texts in chunks of at most 100 and keeps input order', async () => {
    vi.clearAllMocks();
    // batchEmbedContents rejects more than 100 requests per call with HTTP 400
    // (probed 2026-09-29). Each fake vector encodes its text's position.
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { requests } = JSON.parse(init.body);
      return mockJsonResponse({
        embeddings: requests.map((r: { content: { parts: Array<{ text: string }> } }) => ({
          values: [Number(r.content.parts[0].text.slice(1))],
        })),
        // gemini-embedding-2 reports the call's prompt tokens here.
        usageMetadata: { promptTokenCount: requests.length * 2 },
      });
    });
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
    const texts = Array.from({ length: 250 }, (_, i) => `t${i}`);

    const res = await provider.generateEmbeddings('gemini-embedding-2', texts);

    const batchSizes = fetchMock.mock.calls.map(c => JSON.parse(c[1].body).requests.length);
    expect(batchSizes).toEqual([100, 100, 50]);
    expect(res.data.map(d => d.embedding[0])).toEqual(texts.map((_, i) => i));
    expect(res.data.map(d => d.index)).toEqual(texts.map((_, i) => i));
    // Usage sums the three calls; gemini-embedding-2 costs $0.20 per 1M tokens.
    expect(res.usage.prompt_tokens).toBe(500);
    expect(res.usage.total_tokens).toBe(500);
    expect(res.usage.costUSD).toBeCloseTo((500 / 1_000_000) * 0.2, 12);
  });

  it('counts zero tokens when the model reports no usage', async () => {
    vi.clearAllMocks();
    // gemini-embedding-001 returns no usageMetadata (probed 2026-09-30).
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ embeddings: [{ values: [0.1, 0.2] }] }));
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });

    const res = await provider.generateEmbeddings('gemini-embedding-001', ['hello']);

    expect(res.usage).toEqual({ prompt_tokens: 0, total_tokens: 0 });
  });

  it("keeps the earlier batches' usage on the error when a later batch fails", async () => {
    vi.clearAllMocks();
    fetchMock
      .mockImplementationOnce(async (_url: string, init: { body: string }) => {
        const { requests } = JSON.parse(init.body);
        return mockJsonResponse({
          embeddings: requests.map(() => ({ values: [0] })),
          usageMetadata: { promptTokenCount: requests.length * 2 },
        });
      })
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers(),
        body: null,
        json: async () => ({ error: { code: 400, message: 'bad batch', status: 'INVALID_ARGUMENT' } }),
      }) as unknown as Response);
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });

    const error = (await provider
      .generateEmbeddings('gemini-embedding-2', Array.from({ length: 150 }, (_, i) => `t${i}`))
      .catch((e: unknown) => e)) as GeminiProviderError;

    // The first call's 100 texts were billed; the failed second call was not.
    expect(error).toBeInstanceOf(GeminiProviderError);
    expect(error.partialUsage).toMatchObject({ prompt_tokens: 200, total_tokens: 200 });
    expect(error.partialUsage?.costUSD).toBeCloseTo((200 / 1_000_000) * 0.2, 12);
  });
});

describe('Gemini shared thinking option', () => {
  let provider: GeminiProvider;
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => mockJsonResponse(reply));
    provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
  });

  it('does not turn the shared thinking option into a Gemini budget', async () => {
    // options.thinking is Anthropic's on-switch. Sent to Gemini as a budget it
    // would cap thinking at whatever number switched it on.
    await provider.generateCompletion('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {
      thinking: { budgetTokens: 8000 },
    });
    const body = sentBody();
    expect(body.generationConfig?.thinkingConfig).toBeUndefined();
    expect(body).not.toHaveProperty('thinkingConfig');
  });
});

describe('Gemini thinking output', () => {
  let provider: GeminiProvider;

  beforeEach(async () => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
  });

  it('keeps thought-summary parts out of the answer text', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      candidates: [{
        content: { role: 'model', parts: [{ text: '**Planning the reply**', thought: true }, { text: 'Final answer' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }));
    const res = await provider.generateCompletion('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {});
    expect(res.choices[0].message.content).toBe('Final answer');
  });

  it('keeps thought-summary parts out of streamed text', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([{
      candidates: [{
        content: { role: 'model', parts: [{ text: '**Planning**', thought: true }, { text: 'Final answer' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    }]));
    const deltas: string[] = [];
    let finalContent: unknown;
    for await (const chunk of provider.generateCompletionStream('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {})) {
      if (chunk.isFinal) finalContent = chunk.choices[0]?.message?.content;
      else if (chunk.responseTextDelta) deltas.push(chunk.responseTextDelta);
    }
    expect(deltas.join('')).toBe('Final answer');
    expect(finalContent).toBe('Final answer');
  });

  it('returns thought summaries on the message, apart from the answer', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      candidates: [{
        content: { role: 'model', parts: [{ text: '**Planning the reply**', thought: true }, { text: 'Final answer' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }));

    const res = await provider.generateCompletion('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {
      customModelParams: { thinkingConfig: { includeThoughts: true } },
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig.thinkingConfig).toMatchObject({ includeThoughts: true });
    expect(res.choices[0].message.content).toBe('Final answer');
    expect(res.choices[0].message.reasoningText).toBe('**Planning the reply**');
  });

  it('streams thought summaries as reasoning deltas and keeps them on the final message', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { candidates: [{ content: { role: 'model', parts: [{ text: '**Planning**', thought: true }] } }] },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Final answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      },
    ]));
    const reasoning: string[] = [];
    const text: string[] = [];
    let finalMessage: ChatMessage | undefined;
    for await (const chunk of provider.generateCompletionStream('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {})) {
      expect(chunk.reasoningTextDelta && chunk.responseTextDelta).toBeFalsy();
      if (chunk.reasoningTextDelta) reasoning.push(chunk.reasoningTextDelta);
      if (chunk.responseTextDelta) text.push(chunk.responseTextDelta);
      if (chunk.isFinal) finalMessage = chunk.choices[0]?.message;
    }

    expect(reasoning.join('')).toBe('**Planning**');
    expect(text.join('')).toBe('Final answer');
    expect(finalMessage).toMatchObject({ content: 'Final answer', reasoningText: '**Planning**' });
  });

  it('omits reasoningText when no thought parts arrive', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Plain answer' }] }, finishReason: 'STOP' }],
    }));

    const res = await provider.generateCompletion('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {});

    expect(res.choices[0].message).not.toHaveProperty('reasoningText');
  });

  it('never sends reasoningText back', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Sure.' }] }, finishReason: 'STOP' }],
    }));

    await provider.generateCompletion('gemini-3.8-flash', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello.', reasoningText: 'SECRET-REASONING-SUMMARY' },
      { role: 'user', content: 'again' },
    ], {});

    expect(fetchMock.mock.calls[0][1].body).not.toContain('SECRET-REASONING-SUMMARY');
  });
});

describe('Gemini thought signatures', () => {
  let provider: GeminiProvider;
  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);
  const modelTurn = () => sentBody().contents.find((c: { role: string }) => c.role === 'model');
  const withToolTurn = (toolCalls: NonNullable<ChatMessage['tool_calls']>): ChatMessage[] => [
    { role: 'user', content: 'Weather in Paris?' },
    { role: 'assistant', content: null, tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"temp_c":18}' },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async () => mockJsonResponse(reply));
    provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'test-gemini-key' });
  });

  it('captures the signature from a function-call response', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-abc' }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }));
    const res = await provider.generateCompletion('gemini-3.8-flash', [{ role: 'user', content: 'Weather in Paris?' }], {});
    expect(res.choices[0].message.tool_calls![0].thoughtSignature).toBe('sig-abc');
  });

  it('replays a captured signature verbatim', async () => {
    await provider.generateCompletion('gemini-3.8-flash', withToolTurn([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        thoughtSignature: 'sig-abc',
      },
    ]), {});
    expect(modelTurn().parts[0]).toEqual({
      functionCall: { name: 'get_weather', args: { city: 'Paris' } },
      thoughtSignature: 'sig-abc',
    });
  });

  it('puts the placeholder on the first call of an unsigned turn only', async () => {
    // Gemini 3 returns HTTP 400 for a replayed call with no signature (probed
    // 2026-09-29). Calls made by another provider in a fallback chain have none.
    await provider.generateCompletion('gemini-3.8-flash', withToolTurn([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } },
    ]), {});
    const parts = modelTurn().parts;
    expect(parts[0].thoughtSignature).toBe('skip_thought_signature_validator');
    expect(parts[1]).not.toHaveProperty('thoughtSignature');
  });

  it('captures the signature on streamed tool calls', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([{
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-stream' }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    }]));
    let finalCalls: Array<{ thoughtSignature?: string }> | undefined;
    let deltaSignature: string | undefined;
    for await (const chunk of provider.generateCompletionStream(
      'gemini-3.8-flash',
      [{ role: 'user', content: 'Weather in Paris?' }],
      {},
    )) {
      if (chunk.isFinal) finalCalls = chunk.choices[0]?.message?.tool_calls;
      else deltaSignature ??= chunk.toolCallsDeltas?.[0]?.thoughtSignature;
    }
    // The delta carries it for stream consumers, and the final chunk too.
    expect(deltaSignature).toBe('sig-stream');
    expect(finalCalls?.[0].thoughtSignature).toBe('sig-stream');
  });
});

describe('Gemini request errors', () => {
  // undici quotes a header value it rejects, so a key with a stray control
  // character would appear in the error.
  const headerError = () =>
    new TypeError('Headers.append: "secret-key-123\u0000" is an invalid header value.');

  it('keeps the API key out of the request URL and a failed request error', async () => {
    vi.clearAllMocks();
    fetchMock.mockRejectedValueOnce(headerError());
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'secret-key-123', baseURL: '/api/gemini', maxRetries: 1 });

    const error = (await provider.generateEmbeddings('gemini-embedding-2', ['hi']).catch((e: unknown) => e)) as Error;

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret-key-123');
    expect(error.message).not.toContain('secret-key-123');
  });

  it('keeps base URL credentials out of a failed request error', async () => {
    vi.clearAllMocks();
    // undici rejects a URL with credentials and names it in the message.
    fetchMock.mockRejectedValueOnce(new TypeError(
      'Request cannot be constructed from a URL that includes credentials: ' +
        'https://svc:gw-token@gateway.example.com/v1beta/models/x:batchEmbedContents',
    ));
    const provider = new GeminiProvider();
    await provider.initialize({
      apiKey: 'secret-key-123',
      baseURL: 'https://svc:gw-token@gateway.example.com/v1beta',
      maxRetries: 1,
    });

    const error = (await provider.generateEmbeddings('gemini-embedding-2', ['hi']).catch((e: unknown) => e)) as Error;

    expect(error.message).not.toContain('gw-token');
    expect(error.message).not.toContain('secret-key-123');
    expect(error.message).toContain('https://[redacted]@gateway.example.com');
  });

  it.each([
    // An email-style username carries its own @.
    ['https://ops@example.com:gw-token@gateway.example.com/v1beta', 'https://[redacted]@gateway.example.com/v1beta'],
    // A raw / in the password makes the URL unparseable, so fetch quotes it as given.
    ['https://svc:gw/token@gateway.example.com/v1beta', 'https://[redacted]@gateway.example.com/v1beta'],
    ["https://svc:gw)to'ken@gateway.example.com/v1beta", 'https://[redacted]@gateway.example.com/v1beta'],
    // Scheme-relative and scheme-less base URLs.
    ['//svc:gw-token@gateway.example.com/v1beta', '//[redacted]@gateway.example.com/v1beta'],
    ['svc:gw-token@gateway.example.com/v1beta', '[redacted]@gateway.example.com/v1beta'],
    // A // later in the path does not move the start of the credentials.
    ['svc:gw-token@gateway.example.com//v1beta', '[redacted]@gateway.example.com//v1beta'],
    // The API key also appears inside the credentials.
    ['https://secret-key-123:gw-token@gateway.example.com/v1beta', 'https://[redacted]@gateway.example.com/v1beta'],
  ])('keeps credentials out of the error for base URL %s', async (baseURL, masked) => {
    vi.clearAllMocks();
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to parse URL from ${baseURL}/models/x:batchEmbedContents`));
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'secret-key-123', baseURL, maxRetries: 1 });

    const error = (await provider.generateEmbeddings('gemini-embedding-2', ['hi']).catch((e: unknown) => e)) as Error;

    expect(error.message).not.toMatch(/gw-token|gw\/token|gw\)to'ken|secret-key-123/);
    expect(error.message).toContain(masked);
  });

  it('keeps the API key out of the stream URL and a failed stream error', async () => {
    vi.clearAllMocks();
    fetchMock.mockRejectedValueOnce(headerError());
    const provider = new GeminiProvider();
    await provider.initialize({ apiKey: 'secret-key-123', baseURL: '/api/gemini' });

    const stream = provider.generateCompletionStream('gemini-3.8-flash', [{ role: 'user', content: 'hi' }], {});
    const error = (await stream.next().catch((e: unknown) => e)) as Error;

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret-key-123');
    expect(error.message).not.toContain('secret-key-123');
  });
});
