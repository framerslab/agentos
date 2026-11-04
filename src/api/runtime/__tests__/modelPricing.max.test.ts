/**
 * The most a call can cost before it is sent (`estimateMaxCallCostUSD`), pinned against the providers' own token counts
 * on text the four-characters-a-token estimate undercounts, and against the prices the providers' pricing pages list
 * for the tiers a request can reach; and the price registry every provider is read through.
 */
import { afterEach, describe, expect, it } from 'vitest';

import counted from './fixtures/max-cost-token-counts.json';
import {
  MAX_COST_TOKENS_PER_MESSAGE,
  MAX_COST_TOOL_USE_TOKENS,
  estimateMaxCallCostUSD,
  maxInputTokens,
  modelPricing,
  registerModelPricing,
  utf8ByteLength,
  type MaxCostRequest,
} from '../modelPricing.js';
import {
  estimateMaxCallCostUSD as fromRuntime,
  modelPricing as pricingFromRuntime,
  registerModelPricing as registerFromRuntime,
} from '../../../safety/runtime';
import type { MaxCostRequest as RuntimeMaxCostRequest, ModelPrice as RuntimeModelPrice } from '../../../safety/runtime';

/** The output cap every fixture request is priced with. */
const CAP = 1024;

interface FixtureCase {
  name: string;
  system?: string;
  messages: { role: string; content: string }[];
  tools?: { anthropic: unknown[]; openai: unknown[] };
  counts: Record<string, number>;
}

/** The request a case was counted as, in the shape its provider was sent. */
function requestOf(c: FixtureCase, provider: 'anthropic' | 'openai'): MaxCostRequest {
  return { messages: c.messages, system: c.system, tools: c.tools?.[provider], maxOutputTokens: CAP };
}

/** What a request of `tokens` prompt tokens and a full output cap is billed: the card those tokens reach, and a write OpenAI makes by default. */
function billedAt(provider: string, model: string, tokens: number, cap: number): number {
  const price = modelPricing(provider, model)!;
  const card = price.longContext && tokens > price.longContext.thresholdTokens ? price.longContext : price;
  const input = Math.max(card.inputPerMTokUSD, card.automaticCacheWritePerMTokUSD ?? 0);
  return (tokens * input + cap * card.outputPerMTokUSD) / 1_000_000;
}

describe('estimateMaxCallCostUSD against the providers\' own token counts', () => {
  const cases = counted.cases as unknown as FixtureCase[];

  it('has a case of CJK text, source code, emoji and base64, each counted by both providers', () => {
    expect(cases.map((c) => c.name)).toEqual(expect.arrayContaining(['cjk', 'code', 'emoji', 'base64']));
    for (const c of cases) {
      expect(Object.keys(c.counts).some((key) => key.startsWith('anthropic:')), c.name).toBe(true);
      expect(Object.keys(c.counts).some((key) => key.startsWith('openai:')), c.name).toBe(true);
    }
  });

  for (const c of counted.cases as unknown as FixtureCase[]) {
    for (const [key, tokens] of Object.entries(c.counts)) {
      const [provider, model] = key.split(':') as ['anthropic' | 'openai', string];
      it(`bounds ${c.name} at or above ${key}'s count of ${tokens} tokens`, () => {
        const req = requestOf(c, provider);
        expect(maxInputTokens(req)).toBeGreaterThanOrEqual(tokens);
        const max = estimateMaxCallCostUSD(provider, model, req);
        expect(max).toBeDefined();
        expect(max!).toBeGreaterThanOrEqual(billedAt(provider, model, tokens, CAP));
      });
    }
  }

  it('prices claude-sonnet-4-6 at its bound where four characters a token undercounts the text', () => {
    // The base64 case: 4,000 characters, which four characters a token prices as 1,000 tokens; Anthropic counted more.
    const base64 = (counted.cases as unknown as FixtureCase[]).find((c) => c.name === 'base64')!;
    const tokens = base64.counts['anthropic:claude-sonnet-4-6'];
    expect(tokens).toBeGreaterThan(base64.messages[0].content.length / 4);
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', requestOf(base64, 'anthropic'))!).toBeGreaterThanOrEqual(
      billedAt('anthropic', 'claude-sonnet-4-6', tokens, CAP),
    );
  });
});

describe('the bound on the prompt', () => {
  it('counts one token per UTF-8 byte of the text, a fixed allowance per message, and one for a request with tools', () => {
    const messages = [{ role: 'user', content: '漢字 😀' }];
    const tools = [{ name: 'a', description: 'b', input_schema: { type: 'object' } }];
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(maxInputTokens({ messages })).toBe(bytes(messages) + MAX_COST_TOKENS_PER_MESSAGE);
    expect(maxInputTokens({ messages, system: 'Be brief.' })).toBe(bytes(messages) + Buffer.byteLength('Be brief.') + 2 * MAX_COST_TOKENS_PER_MESSAGE);
    expect(maxInputTokens({ messages, tools })).toBe(bytes(messages) + bytes(tools) + MAX_COST_TOKENS_PER_MESSAGE + MAX_COST_TOOL_USE_TOKENS);
  });

  it('measures UTF-8 bytes as Node encodes them, a lone surrogate as the replacement character', () => {
    for (const text of ['', 'ascii', 'é', '漢字', '😀', '👨\u200d👩\u200d👧\u200d👦', '🇯🇵', 'a\ud800b', '\udc00', ...(counted.cases as unknown as FixtureCase[]).map((c) => c.messages[0].content)]) {
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(Buffer.byteLength(text, 'utf8'));
    }
  });
});

describe('the rate the bound is priced at', () => {
  const long = (bytes: number) => [{ role: 'user', content: 'a'.repeat(bytes) }];

  it('takes the long-context rates once the bound passes the threshold: Claude Haiku 5.5 over 100,000 tokens', () => {
    // https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-04: $0.10 / $0.50 per MTok up to 100,000
    // prompt tokens, $0.50 / $2.50 over.
    const under = { messages: long(1_000), maxOutputTokens: CAP };
    const over = { messages: long(100_000), maxOutputTokens: CAP };
    const underTokens = maxInputTokens(under)!;
    const overTokens = maxInputTokens(over)!;
    expect(overTokens).toBeGreaterThan(100_000);
    expect(estimateMaxCallCostUSD('anthropic', 'claude-haiku-5-5', under)).toBeCloseTo((underTokens * 0.1 + CAP * 0.5) / 1e6, 12);
    expect(estimateMaxCallCostUSD('anthropic', 'claude-haiku-5-5', over)).toBeCloseTo((overTokens * 0.5 + CAP * 2.5) / 1e6, 12);
  });

  it("takes OpenAI's long-context rates over 272,000 tokens, with the cache write OpenAI makes by default", () => {
    // https://developers.openai.com/api/docs/pricing, read 2026-11-04: gpt-6-sol $2 input, $2.50 30-minute cache write,
    // $10 output; over 272K input tokens $4, $5 and $15.
    const under = { messages: long(1_000), maxOutputTokens: CAP };
    const over = { messages: long(272_000), maxOutputTokens: CAP };
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', under)).toBeCloseTo((maxInputTokens(under)! * 2.5 + CAP * 10) / 1e6, 12);
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', over)).toBeCloseTo((maxInputTokens(over)! * 5 + CAP * 15) / 1e6, 12);
    // gpt-5.5 bills no cache write: its input rate is its input rate.
    expect(estimateMaxCallCostUSD('openai', 'gpt-5.5', under)).toBeCloseTo((maxInputTokens(under)! * 5 + CAP * 30) / 1e6, 12);
  });

  it('takes the highest cache-write rate when the request carries cache_control', () => {
    // Anthropic, read 2026-11-04: claude-sonnet-4-6 $3 input, $3.75 5-minute write, $6 1-hour write, $15 output.
    const plain: MaxCostRequest = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: CAP };
    const marked: MaxCostRequest = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
      maxOutputTokens: CAP,
    };
    const atRate = (req: MaxCostRequest, input: number) => (maxInputTokens(req)! * input + CAP * 15) / 1e6;
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', plain)).toBeCloseTo(atRate(plain, 3), 12);
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', marked)).toBeCloseTo(atRate(marked, 6), 12);
    // A request-level cache_control, which the text of its messages does not show, is named by the flag.
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...plain, cacheMarkers: true })).toBeCloseTo(atRate(plain, 6), 12);
    // OpenAI's 12-hour write, 2.5x input, for a request that sets its cache lifetime: gpt-6-sol's $5.
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...plain, cacheMarkers: true })).toBeCloseTo((maxInputTokens(plain)! * 5 + CAP * 10) / 1e6, 12);
  });

  it('prices the output cap the request sends, never a lower ceiling a table knows for the model', () => {
    // gpt-4o: $2.50 input, $10 output. The provider refuses a cap above its own ceiling unbilled, so the cap as sent is
    // the most the call can write.
    const req = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 32_000 };
    expect(estimateMaxCallCostUSD('openai', 'gpt-4o', req)).toBeCloseTo((maxInputTokens(req)! * 2.5 + 32_000 * 10) / 1e6, 12);
    // An OpenRouter variant whose id a gpt-4o ceiling of 16,384 matches writes up to 64,000: a bound held to the
    // ceiling would reserve a quarter of its output.
    registerModelPricing('openrouter', (id) => (id === 'openai/gpt-4o:extended' ? { inputPerMTokUSD: 6, outputPerMTokUSD: 18 } : undefined));
    try {
      const extended = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 64_000 };
      expect(estimateMaxCallCostUSD('openrouter', 'openai/gpt-4o:extended', extended)).toBeCloseTo(
        (maxInputTokens(extended)! * 6 + 64_000 * 18) / 1e6,
        12,
      );
    } finally {
      registerModelPricing('openrouter', () => undefined);
    }
  });
});

describe('what the bound cannot price', () => {
  const base: MaxCostRequest = { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: CAP };

  it('is undefined for more than one completion, which bills an output each', () => {
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, n: 2 })).toBeUndefined();
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...base, n: 2 })).toBeUndefined();
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...base, n: 1 })).toBeDefined();
  });

  it('is undefined for an image part, named by the flag or found in the messages', () => {
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, nonTextParts: true })).toBeUndefined();
    const image = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } };
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, messages: [{ role: 'user', content: [image] }] })).toBeUndefined();
    // Inside a tool result too.
    const result = { type: 'tool_result', tool_use_id: 't1', content: [image] };
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, messages: [{ role: 'user', content: [result] }] })).toBeUndefined();
    const openaiImage = { type: 'input_image', image_url: 'https://example.com/a.png' };
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...base, messages: [{ role: 'user', content: [openaiImage] }] })).toBeUndefined();
  });

  it('is undefined for an assistant message that replays an earlier audio answer by its id', () => {
    // Chat Completions sends the answer's audio again as audio input; the reference is a few bytes of text.
    const messages = [
      { role: 'user', content: 'say hello' },
      { role: 'assistant', content: null, audio: { id: 'audio_abc123' } },
      { role: 'user', content: 'again' },
    ];
    expect(estimateMaxCallCostUSD('openai', 'gpt-4o', { ...base, messages })).toBeUndefined();
    expect(estimateMaxCallCostUSD('openai', 'gpt-4o', { ...base, messages: [{ role: 'assistant', content: 'hi', audio: null }] })).toBeDefined();
  });

  it("is undefined for a Gemini part that carries a file or inline data, and for a tool that is not a function's definition", () => {
    // A host that prices Gemini sends its messages in Gemini's shape: `parts`, with a file by reference or inline.
    registerModelPricing('gemini', (id) => (id === 'gemini-x' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 2 } : undefined));
    try {
      const text = [{ role: 'user', parts: [{ text: 'describe it' }] }];
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: text, maxOutputTokens: 10 })).toBeDefined();
      const file = [{ role: 'user', parts: [{ text: 'describe it' }, { file_data: { mime_type: 'video/mp4', file_uri: 'https://example.com/files/abc' } }] }];
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: file, maxOutputTokens: 10 })).toBeUndefined();
      const inline = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo' } }] }];
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: inline, maxOutputTokens: 10 })).toBeUndefined();
      // Gemini's search and code-execution tools carry no `type`; a function's definition is described in full.
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: text, tools: [{ google_search: {} }], maxOutputTokens: 10 })).toBeUndefined();
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: text, tools: [{ codeExecution: {} }], maxOutputTokens: 10 })).toBeUndefined();
      const declared = [{ function_declarations: [{ name: 'look', description: 'Look.', parameters: { type: 'object' } }] }];
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: text, tools: declared, maxOutputTokens: 10 })).toBeDefined();
    } finally {
      registerModelPricing('gemini', () => undefined);
    }
  });

  it("is undefined for a Gemini function response that carries media in its parts, and for a built-in tool's replayed response", () => {
    // A FunctionResponse has `parts` of its own, each inline media or a file by reference, and a Part's union holds
    // `toolCall` and `toolResponse`, a built-in tool's turn (https://ai.google.dev/api/caching, read 2026-11-04).
    registerModelPricing('gemini', (id) => (id === 'gemini-x' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 2 } : undefined));
    try {
      const respond = (response: Record<string, unknown>) => [
        { role: 'user', parts: [{ text: 'look' }] },
        { role: 'model', parts: [{ functionCall: { name: 'look', args: { inlineData: 'a.png' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'look', ...response } }] },
      ];
      // A function call's arguments are data, whatever their keys; a response's JSON output is text.
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: respond({ response: { seen: 'a cat' } }), maxOutputTokens: 10 })).toBeDefined();
      const media = { response: {}, parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo' } }] };
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: respond(media), maxOutputTokens: 10 })).toBeUndefined();
      const builtIn = [{ role: 'model', parts: [{ toolResponse: { id: 'r1', response: {} } }] }];
      expect(estimateMaxCallCostUSD('gemini', 'gemini-x', { messages: builtIn, maxOutputTokens: 10 })).toBeUndefined();
    } finally {
      registerModelPricing('gemini', () => undefined);
    }
  });

  it("prices a replayed tool turn: its thinking block, and a tool call whose arguments are data, not content parts", () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkA' };
    const call = { type: 'tool_use', id: 't1', name: 'look', input: { type: 'image', path: 'a.png' } };
    const messages = [{ role: 'user', content: 'look at a.png' }, { role: 'assistant', content: [thinking, call] }];
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, messages })).toBeDefined();
  });

  it('is undefined for a server tool, named by the flag or found in the tool list', () => {
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, providerSideTools: true })).toBeUndefined();
    const tools = [{ type: 'web_search_20260209', name: 'web_search' }];
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, tools })).toBeUndefined();
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...base, tools: [{ type: 'web_search' }] })).toBeUndefined();
    // A function tool is described in full by its definition.
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...base, tools: [{ type: 'function', name: 'f', parameters: {} }] })).toBeDefined();
  });

  it('is undefined for a priority tier and for regional processing, which bill above the table', () => {
    expect(estimateMaxCallCostUSD('openai', 'gpt-6-sol', { ...base, priorityTier: true })).toBeUndefined();
    expect(estimateMaxCallCostUSD('anthropic', 'claude-opus-5-5', { ...base, priorityTier: true })).toBeUndefined();
    expect(estimateMaxCallCostUSD('anthropic', 'claude-opus-5-5', { ...base, regionalProcessing: true })).toBeUndefined();
  });

  it('is undefined with no output cap, an unpriced model or an unknown provider', () => {
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { messages: base.messages })).toBeUndefined();
    expect(estimateMaxCallCostUSD('anthropic', 'claude-sonnet-4-6', { ...base, maxOutputTokens: Number.NaN })).toBeUndefined();
    expect(estimateMaxCallCostUSD('anthropic', 'claude-x', base)).toBeUndefined();
    expect(estimateMaxCallCostUSD('ollama', 'llama3', base)).toBeUndefined();
  });
});

describe('modelPricing and a host\'s tables', () => {
  afterEach(() => {
    for (const provider of ['openrouter', 'openai']) registerModelPricing(provider, () => undefined);
  });

  it("reads OpenAI's and Anthropic's tables in one shape, US dollars per million tokens", () => {
    expect(modelPricing('openai', 'gpt-6-luna')).toMatchObject({ inputPerMTokUSD: 0.1, outputPerMTokUSD: 0.5 });
    expect(modelPricing('anthropic', 'claude-sonnet-4-6')).toMatchObject({
      inputPerMTokUSD: 3,
      outputPerMTokUSD: 15,
      cacheWritePerMTokUSD: 6,
      cacheReadPerMTokUSD: 0.3,
    });
    expect(modelPricing('anthropic', 'claude-haiku-5-5')?.longContext).toMatchObject({ thresholdTokens: 100_000, inputPerMTokUSD: 0.5, outputPerMTokUSD: 2.5 });
    expect(modelPricing('openai', 'gpt-6-astra')?.longContext).toMatchObject({ thresholdTokens: 272_000, inputPerMTokUSD: 20, outputPerMTokUSD: 75 });
  });

  it('prices a provider through the table its host registered, and refuses a row it cannot count', () => {
    expect(modelPricing('openrouter', 'vendor/model')).toBeUndefined();
    registerModelPricing('openrouter', (id) => (id === 'vendor/model' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 2 } : undefined));
    expect(modelPricing('openrouter', 'vendor/model')).toEqual({ inputPerMTokUSD: 1, outputPerMTokUSD: 2 });
    expect(estimateMaxCallCostUSD('openrouter', 'vendor/model', { messages: 'hi', maxOutputTokens: 10 })).toBeCloseTo(
      ((Buffer.byteLength('hi') + MAX_COST_TOKENS_PER_MESSAGE) * 1 + 10 * 2) / 1e6,
      12,
    );
    // A rate of NaN would price every call at NaN, which every budget check lets through.
    registerModelPricing('openrouter', () => ({ inputPerMTokUSD: Number.NaN, outputPerMTokUSD: 2 }));
    expect(modelPricing('openrouter', 'vendor/model')).toBeUndefined();
    registerModelPricing('openrouter', () => ({ inputPerMTokUSD: 1, outputPerMTokUSD: 2, longContext: { thresholdTokens: 10, inputPerMTokUSD: -1, outputPerMTokUSD: 2 } }));
    expect(modelPricing('openrouter', 'vendor/model')).toBeUndefined();
  });

  it("bounds a cached request at a host row's default-lifetime write rate when the row names no other write rate", () => {
    // $1 input, $100 for a default-lifetime write, no output: a request marked for caching can write every prompt
    // token at $100, so the bound counts them all at it.
    registerModelPricing('openrouter', (id) =>
      id === 'vendor/model' ? { inputPerMTokUSD: 1, outputPerMTokUSD: 0, defaultCacheWritePerMTokUSD: 100 } : undefined,
    );
    const prompt = 'x'.repeat(10_000);
    const tokens = Buffer.byteLength(prompt) + MAX_COST_TOKENS_PER_MESSAGE;
    expect(estimateMaxCallCostUSD('openrouter', 'vendor/model', { messages: prompt, maxOutputTokens: 0, cacheMarkers: true })).toBeCloseTo(
      (tokens * 100) / 1e6,
      12,
    );
    // Without caching asked for, nothing is written and the input rate bounds the prompt.
    expect(estimateMaxCallCostUSD('openrouter', 'vendor/model', { messages: prompt, maxOutputTokens: 0 })).toBeCloseTo(tokens / 1e6, 12);
  });

  it("keeps the built-in row before a host's table for the same provider, which fills only the models it lacks", () => {
    registerModelPricing('openai', () => ({ inputPerMTokUSD: 999, outputPerMTokUSD: 999 }));
    expect(modelPricing('openai', 'gpt-4o')).toMatchObject({ inputPerMTokUSD: 2.5, outputPerMTokUSD: 10 });
    expect(modelPricing('openai', 'no-such-model')).toEqual({ inputPerMTokUSD: 999, outputPerMTokUSD: 999 });
  });

  it('is the one registry behind the safety runtime index', () => {
    expect(fromRuntime).toBe(estimateMaxCallCostUSD);
    expect(pricingFromRuntime).toBe(modelPricing);
    expect(registerFromRuntime).toBe(registerModelPricing);
    // The annotations are the assertion: the type check fails if either type export goes missing.
    const req: RuntimeMaxCostRequest = { messages: [] };
    const price: RuntimeModelPrice | undefined = pricingFromRuntime('anthropic', 'claude-opus-5-5');
    expect([req.messages, price?.inputPerMTokUSD]).toEqual([[], 4]);
  });
});
