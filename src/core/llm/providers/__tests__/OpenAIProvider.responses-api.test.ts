import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fetch so initialize()/any request never hits the network.
vi.stubGlobal('fetch', vi.fn());

import {
  OpenAIProvider,
  shouldRouteToOpenAiResponsesApi,
  isResponsesMappableContent,
  flattenResponsesTextContent,
} from '../implementations/OpenAIProvider';
import type { ChatMessage, ModelCompletionOptions } from '../IProvider';

const userMsgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const toolsOpt = [
  { type: 'function' as const, function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } } },
];

// Anthropic-style cache-marked system blocks, as `systemBlocks` /
// SystemContentBlock[] reach the provider after generateText maps them.
const cacheMarkedSystem: ChatMessage[] = [
  {
    role: 'system',
    content: [
      { type: 'text', text: 'You are a build agent.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Follow the plan.' },
    ],
  },
  { role: 'user', content: 'Call ping with x="ok".' },
];

const multimodal: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ],
  },
];

describe('isResponsesMappableContent / flattenResponsesTextContent', () => {
  it('accepts strings, null, and all-text block arrays; rejects multimodal parts', () => {
    expect(isResponsesMappableContent('hi')).toBe(true);
    expect(isResponsesMappableContent(null)).toBe(true);
    expect(isResponsesMappableContent([{ type: 'text', text: 'a' }])).toBe(true);
    // cache_control is an Anthropic marker with no OpenAI equivalent — its
    // presence must not make the block unmappable.
    expect(isResponsesMappableContent([
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
    ])).toBe(true);
    expect(isResponsesMappableContent([
      { type: 'text', text: 'a' },
      { type: 'image_url', image_url: { url: 'u' } },
    ])).toBe(false);
    expect(isResponsesMappableContent([
      { type: 'tool_result', tool_use_id: 't1', content: 'r' },
    ])).toBe(false);
  });

  it('flattens all-text blocks to newline-joined text, losing nothing but the markers', () => {
    expect(flattenResponsesTextContent('hi')).toBe('hi');
    expect(flattenResponsesTextContent(null)).toBe('');
    expect(flattenResponsesTextContent([
      { type: 'text', text: 'You are a build agent.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Follow the plan.' },
    ])).toBe('You are a build agent.\nFollow the plan.');
  });
});

describe('shouldRouteToOpenAiResponsesApi', () => {
  it('routes ONLY gpt-5 + tools + effort (no responseFormat, text-only)', () => {
    expect(shouldRouteToOpenAiResponsesApi('gpt-5.5', userMsgs, { tools: toolsOpt, effort: 'xhigh' })).toBe(true);
    expect(shouldRouteToOpenAiResponsesApi('gpt-5.5', userMsgs, { tools: toolsOpt, effort: 'max' })).toBe(true);
  });

  it('routes gpt-6 + tools + effort (chat/completions 400s on the combo, probed 2026-09-10)', () => {
    expect(shouldRouteToOpenAiResponsesApi('gpt-6-astra', userMsgs, { tools: toolsOpt, effort: 'max' })).toBe(true);
    expect(shouldRouteToOpenAiResponsesApi('gpt-6-astra', userMsgs, { tools: toolsOpt, effort: 'xhigh' })).toBe(true);
    expect(shouldRouteToOpenAiResponsesApi('gpt-6-astra', userMsgs, { effort: 'max' })).toBe(false); // no tools
  });

  it('routes cache-marked systemBlocks (all-text arrays), which previously fell back and 400ed', () => {
    expect(shouldRouteToOpenAiResponsesApi('gpt-6-astra', cacheMarkedSystem, { tools: toolsOpt, effort: 'xhigh' })).toBe(true);
    expect(shouldRouteToOpenAiResponsesApi('gpt-5.5', cacheMarkedSystem, { tools: toolsOpt, effort: 'max' })).toBe(true);
  });

  it('still does NOT route genuinely multimodal content (the mapper cannot carry it)', () => {
    expect(shouldRouteToOpenAiResponsesApi('gpt-6-astra', multimodal, { tools: toolsOpt, effort: 'xhigh' })).toBe(false);
  });

  it('still does NOT route cache-marked blocks when responseFormat is present', () => {
    expect(
      shouldRouteToOpenAiResponsesApi('gpt-6-astra', cacheMarkedSystem, {
        tools: toolsOpt,
        effort: 'xhigh',
        responseFormat: { type: 'json_object' } as ModelCompletionOptions['responseFormat'],
      }),
    ).toBe(false);
  });

  it('does NOT route without tools, without effort, or on non-gpt-5 reasoning/chat models', () => {
    expect(shouldRouteToOpenAiResponsesApi('gpt-5.5', userMsgs, { effort: 'xhigh' })).toBe(false); // no tools
    expect(shouldRouteToOpenAiResponsesApi('gpt-5.5', userMsgs, { tools: toolsOpt })).toBe(false); // no effort
    expect(shouldRouteToOpenAiResponsesApi('o3', userMsgs, { tools: toolsOpt, effort: 'high' })).toBe(false); // o-series ok on chat
    expect(shouldRouteToOpenAiResponsesApi('gpt-4o', userMsgs, { tools: toolsOpt, effort: 'high' })).toBe(false); // legacy
  });

  it('does NOT route when responseFormat is present (Codex-High-2)', () => {
    expect(
      shouldRouteToOpenAiResponsesApi('gpt-5.5', userMsgs, {
        tools: toolsOpt,
        effort: 'xhigh',
        responseFormat: { type: 'json_object' } as ModelCompletionOptions['responseFormat'],
      }),
    ).toBe(false);
  });

  it('does NOT route when any message carries multimodal (non-string) content (Codex-Medium-1)', () => {
    const multimodal: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] as unknown as ChatMessage['content'] },
    ];
    expect(shouldRouteToOpenAiResponsesApi('gpt-5.5', multimodal, { tools: toolsOpt, effort: 'xhigh' })).toBe(false);
  });
});

describe('OpenAIProvider.buildResponsesPayload', () => {
  let provider: OpenAIProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider();
  });
  const build = (model: string, msgs: ChatMessage[], options: unknown): Record<string, unknown> =>
    (provider as unknown as {
      buildResponsesPayload: (m: string, msgs: ChatMessage[], o: unknown) => Record<string, unknown>;
    }).buildResponsesPayload(model, msgs, options);

  it('maps a multi-turn tool conversation into ordered input items', () => {
    const convo: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'working', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"n":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'pong' },
      { role: 'user', content: 'again' },
    ];
    const p = build('gpt-5.5', convo, { tools: toolsOpt, effort: 'xhigh', maxTokens: 5000 });
    const input = p.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: 'working' },
      { type: 'function_call', call_id: 'call_1', name: 'ping', arguments: '{"n":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'pong' },
      { role: 'user', content: 'again' },
    ]);
    // reasoning.effort preserved (allow-listed model keeps xhigh), tools flattened,
    // max renamed, NO chat-only keys.
    expect(p.reasoning).toEqual({ effort: 'xhigh' });
    expect(p.max_output_tokens).toBe(5000);
    expect(p.store).toBe(false);
    expect((p.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', name: 'ping' });
    expect((p.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty('function');
    expect(p).not.toHaveProperty('messages');
    expect(p).not.toHaveProperty('response_format');
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('reasoning_effort');
  });

  it('carries cache-marked system blocks into input as non-empty joined text', () => {
    const p = build('gpt-6-astra', cacheMarkedSystem, { tools: toolsOpt, effort: 'xhigh' });
    const input = p.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { role: 'system', content: 'You are a build agent.\nFollow the plan.' },
      { role: 'user', content: 'Call ping with x="ok".' },
    ]);
    // The regression guard: the system prompt must never arrive empty. Before
    // the fix the mapper collapsed any array content to '' — invisible in the
    // response, but the model lost its entire system prompt.
    expect(input[0].content).not.toBe('');
    expect(String(input[0].content)).toContain('You are a build agent.');
    // cache_control has no OpenAI request equivalent and must not be emitted.
    expect(JSON.stringify(p)).not.toContain('cache_control');
  });

  it('carries block content on user and tool turns too', () => {
    const convo: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'pong' }] },
    ];
    const input = build('gpt-6-astra', convo, { tools: toolsOpt, effort: 'xhigh' })
      .input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { role: 'user', content: 'do it' },
      { type: 'function_call_output', call_id: 'call_1', output: 'pong' },
    ]);
  });

  it('drops an empty assistant turn but keeps assistant text when tool_calls also present', () => {
    const convo: ChatMessage[] = [
      { role: 'assistant', content: null }, // empty → dropped
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'ping', arguments: '{}' } }] }, // no text → only the call
    ];
    const input = build('gpt-5.5', convo, { tools: toolsOpt, effort: 'high' }).input as Array<Record<string, unknown>>;
    expect(input).toEqual([{ type: 'function_call', call_id: 'c2', name: 'ping', arguments: '{}' }]);
  });

  it('maps tool_choice required + a named-function choice', () => {
    expect(build('gpt-5.5', userMsgs, { tools: toolsOpt, effort: 'high', toolChoice: 'required' }).tool_choice).toBe('required');
    expect(
      build('gpt-5.5', userMsgs, { tools: toolsOpt, effort: 'high', toolChoice: { type: 'function', function: { name: 'ping' } } }).tool_choice,
    ).toEqual({ type: 'function', name: 'ping' });
  });

  it('caps xhigh -> high for a non-allow-listed gpt-5 model', () => {
    expect(build('gpt-5.4', userMsgs, { tools: toolsOpt, effort: 'max' }).reasoning).toEqual({ effort: 'high' });
  });
});

describe('OpenAIProvider.mapResponsesToCompletionResponse', () => {
  let provider: OpenAIProvider;
  beforeEach(() => { provider = new OpenAIProvider(); });
  const map = (r: unknown): unknown =>
    (provider as unknown as {
      mapResponsesToCompletionResponse: (r: unknown, m: string) => unknown;
    }).mapResponsesToCompletionResponse(r, 'gpt-5.5');

  it('maps message text + function_call items (reasoning ignored) into a chat-shaped choice', () => {
    const res = map({
      id: 'resp_1', model: 'gpt-5.5', status: 'completed', created_at: 1700000000,
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        { type: 'function_call', call_id: 'call_a', name: 'ping', arguments: '{"n":1}' },
        { type: 'function_call', call_id: 'call_b', name: 'pong', arguments: '{}' },
      ],
      usage: { input_tokens: 50, output_tokens: 18, total_tokens: 68 },
    }) as any;
    expect(res.id).toBe('resp_1');
    expect(res.created).toBe(1700000000);
    expect(res.choices[0].message.content).toBe('done');
    expect(res.choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'ping', arguments: '{"n":1}' } },
      { id: 'call_b', type: 'function', function: { name: 'pong', arguments: '{}' } },
    ]);
    expect(res.choices[0].finishReason).toBe('tool_calls');
    expect(res.usage.promptTokens).toBe(50);
    expect(res.usage.completionTokens).toBe(18);
  });

  it('pure-text output → content set, finishReason stop, no tool_calls', () => {
    const res = map({
      id: 'r', model: 'gpt-5.5', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }) as any;
    expect(res.choices[0].message.content).toBe('hello');
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.choices[0].finishReason).toBe('stop');
  });

  it('maps incomplete_details.reason: max_output_tokens -> length, content_filter -> content_filter', () => {
    const lengthRes = map({
      id: 'r', model: 'gpt-5.5', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
    }) as any;
    expect(lengthRes.choices[0].finishReason).toBe('length');
    const cfRes = map({
      id: 'r', model: 'gpt-5.5', status: 'incomplete', incomplete_details: { reason: 'content_filter' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }],
    }) as any;
    expect(cfRes.choices[0].finishReason).toBe('content_filter');
  });

  it('THROWS only on a GENUINELY empty output array (Codex-Medium-2 — must fall back, not empty-succeed)', () => {
    expect(() => map({ id: 'r', model: 'gpt-5.5', status: 'completed', output: [] })).toThrow();
    expect(() => map({ id: 'r', model: 'gpt-5.5', status: 'completed' })).toThrow(); // output absent
  });

  it('reasoning-only + incomplete/max_output_tokens → finishReason length, no throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = map({
      id: 'r', model: 'gpt-6-astra', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', summary: [] }],
      usage: { input_tokens: 20, output_tokens: 300, total_tokens: 320 },
    }) as any;
    // The regression: this used to throw before finishReason was computed,
    // hard-erroring an entire build over one budget-capped turn.
    expect(res.choices[0].finishReason).toBe('length');
    expect(res.choices[0].message.content).toBeNull();
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.usage.completionTokens).toBe(300);
    // Diagnostic must name the budget as the cause.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/reasoning-only/i);
    warn.mockRestore();
  });

  it('reasoning-only + completed → finishReason stop, no throw (empty turn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = map({
      id: 'r', model: 'gpt-6-astra', status: 'completed',
      output: [{ type: 'reasoning', summary: [] }],
      usage: { input_tokens: 10, output_tokens: 40, total_tokens: 50 },
    }) as any;
    expect(res.choices[0].finishReason).toBe('stop');
    expect(res.choices[0].message.content).toBeNull();
    warn.mockRestore();
  });

  it('reasoning-only + incomplete/content_filter → finishReason content_filter, no throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = map({
      id: 'r', model: 'gpt-6-astra', status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [{ type: 'reasoning', summary: [] }],
    }) as any;
    expect(res.choices[0].finishReason).toBe('content_filter');
    expect(res.choices[0].message.content).toBeNull();
    warn.mockRestore();
  });

  it('reasoning + function_call (no message) still maps tool_calls normally', () => {
    const res = map({
      id: 'r', model: 'gpt-6-astra', status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'c1', name: 'PickTemplate', arguments: '{"id":"a"}' },
      ],
    }) as any;
    expect(res.choices[0].finishReason).toBe('tool_calls');
    expect(res.choices[0].message.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'PickTemplate', arguments: '{"id":"a"}' } },
    ]);
  });
});

describe('OpenAIProvider.generateCompletion routing (endpoint selection)', () => {
  let provider: OpenAIProvider;
  let makeApiRequest: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider();
    (provider as unknown as { isInitialized: boolean }).isInitialized = true;
    (provider as unknown as { getApiKey: () => Promise<string> }).getApiKey = vi.fn().mockResolvedValue('k');
    makeApiRequest = vi.fn();
    (provider as unknown as { makeApiRequest: unknown }).makeApiRequest = makeApiRequest;
  });

  it('gpt-5.5 + tools + effort → POSTs /responses with a Responses body', async () => {
    makeApiRequest.mockResolvedValue({
      id: 'r', model: 'gpt-5.5', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    await provider.generateCompletion('gpt-5.5', userMsgs, { tools: toolsOpt, effort: 'xhigh' } as ModelCompletionOptions);
    const [endpoint, method, , body] = makeApiRequest.mock.calls[0];
    expect(endpoint).toBe('/responses');
    expect(method).toBe('POST');
    expect((body as Record<string, unknown>).reasoning).toEqual({ effort: 'xhigh' });
    expect((body as Record<string, unknown>).input).toBeDefined();
  });

  it('gpt-5.5 + tools + NO effort → stays on /chat/completions', async () => {
    makeApiRequest.mockResolvedValue({ id: 'r', object: 'chat.completion', created: 1, model: 'gpt-5.5', choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] });
    await provider.generateCompletion('gpt-5.5', userMsgs, { tools: toolsOpt } as ModelCompletionOptions);
    expect(makeApiRequest.mock.calls[0][0]).toBe('/chat/completions');
  });

  it('gpt-4o + tools + effort → stays on /chat/completions', async () => {
    makeApiRequest.mockResolvedValue({ id: 'r', object: 'chat.completion', created: 1, model: 'gpt-4o', choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }] });
    await provider.generateCompletion('gpt-4o', userMsgs, { tools: toolsOpt, effort: 'high' } as ModelCompletionOptions);
    expect(makeApiRequest.mock.calls[0][0]).toBe('/chat/completions');
  });
});
