/**
 * @file text-guardrails.e2e.test.ts
 * The `guards` option on generateText(), streamText() and an agent's calls: the user turn judged once before any
 * request, tool calls judged before any hook, the reply judged before the caller receives it, a dry run that changes
 * nothing, and a transcript that holds what was delivered. Real generateText, streamText, agent() and providers;
 * only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agent } from '../agent.js';
import { GuardrailStopError } from '../errors.js';
import { generateText, type TextGuardrailVerdict } from '../generateText.js';
import { ObjectGenerationError } from '../generateObject.js';
import { streamText, type StreamPart } from '../streamText.js';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';
import { GuardrailAction, type GuardrailContext, type IGuardrailService } from '../../safety/guardrails/IGuardrailService.js';

type Json = Record<string, any>;
const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
const OPENAI = { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-guards-test-0001', fallbackProviders: [] };
const CLAUDE = { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-guards-test-0001', fallbackProviders: [], memory: false as const, instructions: 'You are brief.' };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
const text = (content: string) => () =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
const toolCall = (name: string, args: Json, id = 'call_1') => () =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: USAGE });
const delta = (d: Json, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta: d, finish_reason: finish }] });
const textStream = (content: string) => () =>
  sse([delta({ role: 'assistant', content }), delta({}, 'stop'), { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [], usage: USAGE }, '[DONE]']);
/** One Anthropic turn: signed thinking when given, then the reply. */
const claudeTurn = (reply: string, thinking?: string) => () => {
  const at = thinking ? 1 : 0;
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } },
    ...(thinking ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
    ] : []),
    { type: 'content_block_start', index: at, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: at, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: at },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]);
};
/** Answers every GET with a model listing and each POST with the next entry of `script`. */
function serve(script: Array<() => Response>): void {
  const queue = [...script];
  fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
    const next = queue.shift();
    if (!next) throw new Error(`script exhausted at ${String(url)}`);
    return next();
  });
}
/** The parsed body of every POST, in order. */
const posted = (): Json[] => fetchMock.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST').map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const isFinal = (chunk: { type: string }): boolean => chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE;
const blocksInput: IGuardrailService = { id: 'in', evaluateInput: async () => ({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN', reason: 'because the prompt says a refused prompt' }) };
const replacesOutput: IGuardrailService = { id: 'out', evaluateOutput: async ({ chunk }) => (isFinal(chunk) ? { action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT', replacementText: 'A fixed reply.' } : null) };
const blocksOutput: IGuardrailService = { id: 'out', evaluateOutput: async ({ chunk }) => (isFinal(chunk) ? { action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT' } : null) };
const sanitizesOutput: IGuardrailService = { id: 'san', config: { canSanitize: true }, evaluateOutput: async ({ chunk }) => (isFinal(chunk) ? { action: GuardrailAction.SANITIZE, modifiedText: 'Hello [removed].' } : null) };
/** A guard over tool calls that answers `action` and records the arguments it was shown. */
function toolGuard(action: GuardrailAction, config: Record<string, unknown> = {}): IGuardrailService & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    id: 'tools', seen, config: { evaluateToolCalls: true, ...config },
    evaluateOutput: async ({ chunk }) => {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      seen.push((chunk as { toolCalls: Array<{ arguments: unknown }> }).toolCalls[0].arguments);
      return { action, reasonCode: 'RULE_TOOL', reason: 'the guard said why' };
    },
  };
}
const search = { description: 'Search.', parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] }, execute: vi.fn(async () => ({ hits: 1 })) };
const guards = (...services: IGuardrailService[]) => ({ services, context });

beforeEach(() => { fetchMock.mockReset(); search.execute.mockClear(); globalLLMProviderHealth.reset(); });

describe('guards under generateText', () => {
  it('(a) a blocked prompt stops the call before any request', async () => {
    serve([text('never asked')]);
    const error = await generateText({ ...OPENAI, prompt: 'a refused prompt', guards: guards(blocksInput) }).catch((e) => e);
    expect(error).toBeInstanceOf(GuardrailStopError);
    expect(error).toMatchObject({ code: 'GUARDRAIL_BLOCKED', stage: 'input', reasonCode: 'RULE_IN', guardrailId: 'in', report: { mode: 'enforce', result: 'stopped' } });
    expect(posted()).toHaveLength(0);
    expect(`${error.message} ${JSON.stringify(error.report)}`).not.toContain('refused prompt');
  });

  it('(b) a blocked reply with a replacement is delivered as the replacement', async () => {
    serve([text('the model reply')]);
    const result = await generateText({ ...OPENAI, prompt: 'hello', guards: guards(replacesOutput) });
    expect(result.text).toBe('A fixed reply.');
    expect(result.guardReport).toMatchObject({ mode: 'enforce', result: 'replaced', output: [expect.objectContaining({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT' })] });
    expect(result.transcriptDelta?.at(-1)).toEqual({ role: 'assistant', content: 'A fixed reply.' });

    serve([text('the model reply')]);
    const stopped = await generateText({ ...OPENAI, prompt: 'hello', guards: guards(blocksOutput) }).catch((e) => e);
    expect(stopped).toBeInstanceOf(GuardrailStopError);
    expect(stopped).toMatchObject({ code: 'GUARDRAIL_BLOCKED', stage: 'output', usage: expect.objectContaining({ totalTokens: 7 }) });
  });

  it('(c) a blocked tool call never runs, no hook is asked, and the model is told a fixed sentence', async () => {
    serve([toolCall('search', { q: 'x' }), text('done')]);
    const guard = toolGuard(GuardrailAction.BLOCK);
    const hook = vi.fn(async (info: { args: Json }) => ({ args: info.args }));
    const result = await generateText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(guard), onBeforeToolExecution: hook as never });
    expect(result.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    const told = posted()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(told.content)).toEqual({ refused: true, error: 'This tool call was refused by a guardrail.', reasonCode: 'RULE_TOOL' });
    expect(JSON.stringify(posted()[1])).not.toContain('the guard said why');
    expect(result.guardReport?.toolCalls).toEqual([{ toolCallId: 'tc_1_0', toolName: 'search', evaluations: [expect.objectContaining({ reasonCode: 'RULE_TOOL' })] }]);
    expect(JSON.stringify(result.guardReport)).not.toContain('call_1');
  });

  it('(c) a screen that runs first refuses a tool call on its own', async () => {
    serve([toolCall('search', { q: 'x' }), text('done')]);
    const result = await generateText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(toolGuard(GuardrailAction.BLOCK, { sequential: true })) });
    expect(search.execute).not.toHaveBeenCalled();
    expect(result.guardReport?.toolCalls).toEqual([{ toolCallId: 'tc_1_0', toolName: 'search', evaluations: [expect.objectContaining({ reasonCode: 'RULE_TOOL' })] }]);
  });

  it('(c) the guard is shown the model\'s arguments, never what a hook adds; the prompt-tool loop is held the same', async () => {
    serve([toolCall('search', { q: 'x' }), text('done')]);
    const guard = toolGuard(GuardrailAction.FLAG);
    const hook = async (info: { args: Json }) => ({ args: { ...info.args, secret: 'added-by-hook' } });
    await generateText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(guard), onBeforeToolExecution: hook as never });
    expect(guard.seen).toEqual([{ q: 'x' }]);
    expect(search.execute).toHaveBeenCalledWith(expect.objectContaining({ q: 'x', secret: 'added-by-hook' }));

    search.execute.mockClear();
    serve([text('<tool_call>{"name":"search","arguments":{"q":"y"}}</tool_call>'), text('done')]);
    const shim = await generateText({ ...OPENAI, prompt: 'find y', tools: { search }, toolMode: 'prompt', guards: guards(toolGuard(GuardrailAction.BLOCK)) });
    expect(shim.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    expect(shim.guardReport?.toolCalls[0]).toMatchObject({ toolCallId: 'tc_1_0', toolName: 'search' });
  });
});

describe('guards under streamText', () => {
  it('(d) a blocked reply in hold mode delivers no text, one error part, and an empty text', async () => {
    serve([textStream('the streamed reply')]);
    const result = streamText({ ...OPENAI, prompt: 'hello', guards: guards(blocksOutput) });
    const parts = await collect(result.fullStream);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('error');
    expect((parts[0] as { error: unknown }).error).toMatchObject({ name: 'GuardrailStopError', code: 'GUARDRAIL_BLOCKED', stage: 'output' });
    expect(await result.text).toBe('');
    expect(await result.finishReason).toBe('error');
    expect((await result.guardReport)?.result).toBe('stopped');

    serve([textStream('the streamed reply')]);
    const again = streamText({ ...OPENAI, prompt: 'hello', guards: guards(blocksOutput) });
    const seen: string[] = [];
    for await (const piece of again.textStream) seen.push(piece);
    expect(seen).toEqual([]);
    expect(await again.finishReason).toBe('error');
  });

  it('a passed reply arrives after the guards judged it, a replacement as one text part, and a tool call is refused in the streamed loop', async () => {
    serve([textStream('the streamed reply')]);
    const passed = streamText({ ...OPENAI, prompt: 'hello', guards: guards({ id: 'quiet', evaluateOutput: async () => null }) });
    expect((await collect(passed.fullStream)).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')).toBe('the streamed reply');
    expect(await passed.text).toBe('the streamed reply');
    expect((await passed.guardReport)?.result).toBe('passed');

    serve([textStream('the streamed reply')]);
    const replaced = streamText({ ...OPENAI, prompt: 'hello', guards: guards(replacesOutput) });
    expect(await collect(replaced.fullStream)).toEqual([{ type: 'text', text: 'A fixed reply.' }]);
    expect(await replaced.text).toBe('A fixed reply.');

    serve([
      () => sse([delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'search', arguments: '' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] }), delta({}, 'tool_calls'), '[DONE]']),
      textStream('done'),
    ]);
    const tooled = streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(toolGuard(GuardrailAction.BLOCK)) });
    const parts = await collect(tooled.fullStream);
    expect(search.execute).not.toHaveBeenCalled();
    expect(parts.find((p) => p.type === 'tool-result')).toMatchObject({ result: { refused: true, reasonCode: 'RULE_TOOL' } });
  });
});

describe('(c) every tool loop refuses alike: no hook, no run, and the model is told no reason', () => {
  const hook = vi.fn(async (info: { args: Json }) => ({ args: info.args }));
  beforeEach(() => { hook.mockClear(); });
  /** The request after the refused call: it holds the fixed sentence and the code, never the guard's reason. */
  function toldWithoutReason(): void {
    const next = JSON.stringify(posted()[1]);
    expect(next).toContain('This tool call was refused by a guardrail.');
    expect(next).toContain('RULE_TOOL');
    expect(next).not.toContain('the guard said why');
  }

  it('the prompt-tool loop of generateText()', async () => {
    serve([text('<tool_call>{"name":"search","arguments":{"q":"y"}}</tool_call>'), text('done')]);
    const result = await generateText({ ...OPENAI, prompt: 'find y', tools: { search }, toolMode: 'prompt', guards: guards(toolGuard(GuardrailAction.BLOCK)), onBeforeToolExecution: hook as never });
    expect(result.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    toldWithoutReason();
  });

  it('the native loop of streamText()', async () => {
    serve([
      () => sse([delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'search', arguments: '' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }] }), delta({}, 'tool_calls'), '[DONE]']),
      textStream('done'),
    ]);
    const result = streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(toolGuard(GuardrailAction.BLOCK)), onBeforeToolExecution: hook as never });
    await collect(result.fullStream);
    expect(await result.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    const told = posted()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(told.content)).toEqual({ refused: true, error: 'This tool call was refused by a guardrail.', reasonCode: 'RULE_TOOL' });
    toldWithoutReason();
    expect((await result.guardReport)?.toolCalls).toEqual([{ toolCallId: 'tc_1_0', toolName: 'search', evaluations: [expect.objectContaining({ reasonCode: 'RULE_TOOL' })] }]);
    expect(JSON.stringify(await result.guardReport)).not.toContain('call_s1');
  });

  it('the prompt-tool loop of streamText()', async () => {
    serve([text('<tool_call>{"name":"search","arguments":{"q":"y"}}</tool_call>'), text('done')]);
    const result = streamText({ ...OPENAI, prompt: 'find y', tools: { search }, toolMode: 'prompt', guards: guards(toolGuard(GuardrailAction.BLOCK)), onBeforeToolExecution: hook as never });
    await collect(result.fullStream);
    expect(await result.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    toldWithoutReason();
    expect((await result.guardReport)?.toolCalls[0]).toMatchObject({ toolCallId: 'tc_1_0', toolName: 'search' });
  });
});

describe('guards on a call with a fallback chain', () => {
  const anthropicSpendLimit = () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified workspace API usage limits.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  // Without this the resolver could send the Anthropic call through OpenRouter.
  beforeEach(() => { delete process.env.OPENROUTER_API_KEY; });
  afterEach(() => { if (savedOpenRouterKey !== undefined) process.env.OPENROUTER_API_KEY = savedOpenRouterKey; });
  const toOpenAI = (): Json[] => fetchMock.mock.calls.filter(([url, init]) => /api\.openai\.com/.test(String(url)) && (init as { method?: string } | undefined)?.method === 'POST').map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);

  it('the input is judged once, and the fallback leg\'s tool loop refuses the call', async () => {
    const queue = [toolCall('search', { q: 'x' }), text('done')];
    fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
      if (/api\.anthropic\.com/.test(String(url))) return anthropicSpendLimit();
      const next = queue.shift();
      if (!next) throw new Error(`script exhausted at ${String(url)}`);
      return next();
    });
    const evaluateInput = vi.fn(async () => null);
    const onFallback = vi.fn();
    const result = await generateText({
      provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-guards-test-0002', prompt: 'find x', tools: { search }, maxSteps: 3,
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-guards-test-0002' }], onFallback,
      guards: guards({ id: 'in', evaluateInput }, toolGuard(GuardrailAction.BLOCK)),
    });
    expect(onFallback).toHaveBeenCalled();
    expect(result.text).toBe('done');
    expect(evaluateInput).toHaveBeenCalledTimes(1);
    expect(search.execute).not.toHaveBeenCalled();
    expect(toOpenAI()).toHaveLength(2);
    expect(JSON.parse(toOpenAI()[1].messages.find((m: Json) => m.role === 'tool').content)).toMatchObject({ refused: true, reasonCode: 'RULE_TOOL' });
    expect(result.guardReport?.toolCalls).toHaveLength(1);
  });

  it('a continuation that moves to the prompt-tool loop numbers its calls after the rounds before it', async () => {
    // Claude runs one native tool round, then hits its spend limit; the OpenAI leg refuses native tools and continues in the prompt-tool loop.
    const claudeToolUse = () =>
      sse([
        { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ]);
    const noNativeTools = () =>
      new Response(JSON.stringify({ error: { message: 'This model does not support tools.', type: 'invalid_request_error', code: null } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const toClaude = [claudeToolUse, anthropicSpendLimit];
    const toOpenAIQueue = [noNativeTools, text('<tool_call>{"name":"search","arguments":{"q":"y"}}</tool_call>'), text('done')];
    fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
      const next = (/api\.anthropic\.com/.test(String(url)) ? toClaude : toOpenAIQueue).shift();
      if (!next) throw new Error(`script exhausted at ${String(url)}`);
      return next();
    });
    const result = await generateText({
      provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-guards-test-0004', prompt: 'find x', tools: { search }, maxSteps: 4,
      fallbackProviders: [{ provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-guards-test-0004' }],
      guards: guards(toolGuard(GuardrailAction.FLAG)),
    });
    expect(result.text).toBe('done');
    expect(search.execute).toHaveBeenCalledTimes(2);
    expect(result.guardReport?.toolCalls.map((c) => c.toolCallId)).toEqual(['tc_1_0', 'tc_2_0']);
  });

  it('a stop is not tried on a fallback provider and never counts against the provider\'s health', async () => {
    serve([text('the model reply')]);
    const onFallback = vi.fn();
    const chain = { fallbackProviders: [{ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-guards-test-0003' }], onFallback };
    const stopped = await generateText({ ...OPENAI, ...chain, prompt: 'hello', guards: guards(blocksOutput) }).catch((e) => e);
    expect(stopped).toBeInstanceOf(GuardrailStopError);

    serve([textStream('the streamed reply')]);
    const streamed = streamText({ ...OPENAI, ...chain, prompt: 'hello', guards: guards(blocksOutput) });
    expect((await collect(streamed.fullStream)).map((p) => p.type)).toEqual(['error']);

    expect(onFallback).not.toHaveBeenCalled();
    // one request each, both to the primary
    expect(posted()).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([url]) => /api\.anthropic\.com/.test(String(url)))).toBe(false);
    expect(globalLLMProviderHealth.isOpen('openai')).toBe(false);
    expect(globalLLMProviderHealth.getStats('openai')?.failureCount ?? 0).toBe(0);
  });
});

describe('(e) a dry run changes nothing and reports everything', () => {
  it('the prompt, the tool call and the reply pass as the model wrote them', async () => {
    const verdicts: TextGuardrailVerdict[] = [];
    const dry = (...services: IGuardrailService[]) => ({ services, context, mode: 'dryRun' as const, onVerdict: (v: TextGuardrailVerdict) => { verdicts.push(v); } });

    serve([text('the model reply')]);
    const input = await generateText({ ...OPENAI, prompt: 'a refused prompt', guards: dry(blocksInput) });
    expect(input.text).toBe('the model reply');
    expect(posted()[0].messages.at(-1)).toMatchObject({ role: 'user', content: 'a refused prompt' });

    serve([text('the model reply')]);
    expect((await generateText({ ...OPENAI, prompt: 'hello', guards: dry(replacesOutput) })).text).toBe('the model reply');

    serve([toolCall('search', { q: 'x' }), text('done')]);
    await generateText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: dry(toolGuard(GuardrailAction.BLOCK)) });
    expect(search.execute).toHaveBeenCalledTimes(1);

    serve([textStream('the streamed reply')]);
    const streamed = streamText({ ...OPENAI, prompt: 'hello', guards: dry(blocksOutput) });
    expect((await collect(streamed.fullStream)).map((p) => p.type)).toEqual(['text']);
    expect(await streamed.text).toBe('the streamed reply');
    expect(await streamed.guardReport).toMatchObject({ mode: 'dryRun', result: 'passed' });

    expect(verdicts.map((v) => [v.stage, v.action, v.enforced])).toEqual([
      ['input', GuardrailAction.BLOCK, false], ['output', GuardrailAction.BLOCK, false], ['toolCall', GuardrailAction.BLOCK, false], ['output', GuardrailAction.BLOCK, false],
    ]);
    expect(verdicts[1]).toMatchObject({ originalText: 'the model reply', finalText: 'A fixed reply.' });
  });
});

describe('(f) the transcript holds what was delivered', () => {
  it('a replaced reply is recorded without the original or its thinking, and the next turn never sends them', async () => {
    serve([claudeTurn('Hello there.', 'Plan the reply.'), claudeTurn('Sure.')]);
    const session = agent(CLAUDE).session('replaced');
    const first = await session.send('Hi', { guards: guards(replacesOutput) });
    expect(first.text).toBe('A fixed reply.');
    expect(first.transcriptDelta?.at(-1)).toEqual({ role: 'assistant', content: 'A fixed reply.' });
    await session.send('And again?');
    const second = JSON.stringify(posted()[1]);
    expect(second).toContain('A fixed reply.');
    expect(second).not.toContain('Hello there.');
    expect(second).not.toContain('Plan the reply.');
  });

  it('a sanitized reply the same', async () => {
    serve([claudeTurn('Hello there.', 'Plan the reply.'), claudeTurn('Sure.')]);
    const session = agent(CLAUDE).session('sanitized');
    const first = await session.send('Hi', { guards: guards(sanitizesOutput) });
    expect(first.text).toBe('Hello [removed].');
    expect(first.guardReport?.result).toBe('sanitized');
    await session.send('And again?');
    const second = JSON.stringify(posted()[1]);
    expect(second).toContain('Hello [removed].');
    expect(second).not.toContain('Hello there.');
    expect(second).not.toContain('Plan the reply.');
  });

  it('a schema retry is sent the delivered text, never the original', async () => {
    serve([text('{"ok":true,"note":"the original reply"}'), text('{"ok":true}')]);
    const session = agent({ ...OPENAI, memory: false, instructions: 'Answer in JSON.' }).session('schema');
    await session.send('Hi', { responseSchema: z.object({ ok: z.boolean() }), maxValidationRetries: 1, guards: guards(replacesOutput) }).catch(() => undefined);
    expect(posted()).toHaveLength(2);
    const retry = JSON.stringify(posted()[1]);
    expect(retry).toContain('A fixed reply.');
    expect(retry).not.toContain('the original reply');
  });

  it('a replaced prompt makes no request, leaves the delta empty, and is not sent on the next turn', async () => {
    serve([text('Sure.')]);
    const replacesInput: IGuardrailService = { id: 'in', evaluateInput: async () => ({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN', replacementText: 'Here is who can help.' }) };
    const session = agent({ ...OPENAI, memory: false, instructions: 'You are brief.' }).session('input-replaced');
    const first = await session.send('a refused prompt', { guards: guards(replacesInput) });
    expect(first.text).toBe('Here is who can help.');
    expect(first.transcriptDelta).toEqual([]);
    expect(first.usage.totalTokens).toBe(0);
    expect(first.guardReport?.result).toBe('replaced');
    expect(posted()).toHaveLength(0);
    await session.send('And again?');
    expect(JSON.stringify(posted()[0])).not.toContain('refused prompt');
  });

  it('a stream turn whose input a guard rewrote is left out of the history', async () => {
    serve([textStream('Noted.'), text('Sure.')]);
    const sanitizesInput: IGuardrailService = { id: 'in', config: { canSanitize: true }, evaluateInput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: 'my number is [removed]' }) };
    const session = agent({ ...OPENAI, memory: false, instructions: 'You are brief.' }).session('stream-sanitized');
    const result = session.stream('my number is 555 0100', { guards: guards(sanitizesInput) });
    await collect(result.fullStream);
    await result.text;
    expect(JSON.stringify(posted()[0])).toContain('my number is [removed]');
    expect(JSON.stringify(posted()[0])).not.toContain('555 0100');
    expect(session.messages()).toEqual([]);
  });

  it('a memory provider never observes a turn whose input a guard rewrote', async () => {
    serve([text('Noted.'), textStream('Noted again.'), text('Sure.')]);
    const observe = vi.fn(async (_role: 'user' | 'assistant', _text: string, _context?: unknown) => undefined);
    const sanitizesInput: IGuardrailService = { id: 'in', config: { canSanitize: true }, evaluateInput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: 'my number is [removed]' }) };
    const session = agent({ ...OPENAI, memory: false, instructions: 'You are brief.', memoryProvider: { observe } }).session('observed');
    await session.send('my number is 555 0100', { guards: guards(sanitizesInput) });
    const streamed = session.stream('my number is 555 0100', { guards: guards(sanitizesInput) });
    await collect(streamed.fullStream);
    await streamed.text;
    await session.send('Thanks.');
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith('user', 'Thanks.', expect.anything()));
    expect(JSON.stringify(observe.mock.calls)).not.toContain('555 0100');
  });

  it('a memory provider recalls for a rewritten turn with the text as it was sent, never the original', async () => {
    serve([text('Noted.'), textStream('Noted again.'), text('Once more.')]);
    const getContext = vi.fn(async (_text: string) => null);
    const sanitizesInput: IGuardrailService = { id: 'in', config: { canSanitize: true }, evaluateInput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: 'my number is [removed]' }) };
    const helper = agent({ ...OPENAI, memory: false, instructions: 'You are brief.', memoryProvider: { getContext } });
    const session = helper.session('recalled');
    await session.send('my number is 555 0100', { guards: guards(sanitizesInput) });
    const streamed = session.stream('my number is 555 0100', { guards: guards(sanitizesInput) });
    await collect(streamed.fullStream);
    await helper.generate('my number is 555 0100', { guards: guards(sanitizesInput) });
    expect(getContext.mock.calls.map(([recallText]) => recallText)).toEqual(['my number is [removed]', 'my number is [removed]', 'my number is [removed]']);
    expect(JSON.stringify(posted())).not.toContain('555 0100');
  });

  it('(a) and (d) through an agent\'s own generate() and stream()', async () => {
    serve([textStream('the streamed reply')]);
    const helper = agent({ ...OPENAI, memory: false, instructions: 'You are brief.' });
    await expect(helper.generate('a refused prompt', { guards: guards(blocksInput) })).rejects.toMatchObject({ name: 'GuardrailStopError', stage: 'input' });
    expect(posted()).toHaveLength(0);
    const parts = await collect(helper.stream('hello', { guards: guards(blocksOutput) }).fullStream);
    expect(parts.map((p) => p.type)).toEqual(['error']);
  });
});

describe('nothing a guard took out reaches the history, memory or a retriever on the paths around the call', () => {
  /** Rewrites a turn that holds the number, and passes every other turn (a schema retry's correction turn included). */
  const redactsNumber: IGuardrailService = {
    id: 'in',
    config: { canSanitize: true },
    evaluateInput: async ({ input }) => (input.textInput?.includes('555 0100') ? { action: GuardrailAction.SANITIZE, modifiedText: 'my number is [removed]' } : null),
  };
  /** Replaces a refused turn with a fixed reply, and passes every other turn. */
  const replacesRefused: IGuardrailService = {
    id: 'in',
    evaluateInput: async ({ input }) => (input.textInput?.includes('refused') ? { action: GuardrailAction.BLOCK, reasonCode: 'RULE_IN', replacementText: 'Here is who can help.' } : null),
  };
  const observer = () => vi.fn(async (_role: 'user' | 'assistant', _text: string, _context?: unknown) => undefined);
  const schema = z.object({ ok: z.boolean() });

  it('a schema retry after a rewritten turn never hands the original to the memory provider', async () => {
    serve([text('not json'), text('{"ok":true}'), text('Sure.')]);
    const observe = observer();
    const session = agent({ ...OPENAI, memory: false, instructions: 'Answer in JSON.', memoryProvider: { observe } }).session('schema-rewritten');
    const reply = await session.send('my number is 555 0100', { responseSchema: schema, maxValidationRetries: 1, guards: guards(redactsNumber) });
    expect((reply as { object?: unknown }).object).toEqual({ ok: true });
    expect(posted()).toHaveLength(2);
    await session.send('Thanks.');
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith('user', 'Thanks.', expect.anything()));
    expect(JSON.stringify(observe.mock.calls)).not.toContain('555 0100');
    expect(JSON.stringify(posted())).not.toContain('555 0100');
  });

  it('a schema send whose turn a guard replaced is not retried: no request, nothing kept, nothing observed', async () => {
    serve([text('{"ok":true}')]);
    const observe = observer();
    const session = agent({ ...OPENAI, memory: false, instructions: 'Answer in JSON.', memoryProvider: { observe } }).session('schema-replaced');
    const error = await session.send('a refused prompt', { responseSchema: schema, maxValidationRetries: 1, guards: guards(replacesRefused) }).catch((e) => e);
    expect(error).toBeInstanceOf(ObjectGenerationError);
    expect(error.rawText).toBe('Here is who can help.');
    expect(posted()).toHaveLength(0);
    expect(session.messages()).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  });

  it('citation verification retrieves with the turn as it was sent, and not at all for a turn a guard replaced', async () => {
    serve([text('Noted.'), text('Noted again.'), textStream('Noted once more.')]);
    const retrieve = vi.fn(async (_query: string) => []);
    const embedFn = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const helper = agent({ ...OPENAI, memory: false, instructions: 'You are brief.', verifyCitations: { retrieve, embedFn } });
    await helper.generate('my number is 555 0100', { guards: guards(redactsNumber) });
    const session = helper.session('cited');
    await session.send('my number is 555 0100', { guards: guards(redactsNumber) });
    const streamed = session.stream('my number is 555 0100', { guards: guards(redactsNumber) });
    await collect(streamed.fullStream);
    await streamed.grounding;
    const replaced = await session.send('a refused prompt', { guards: guards(replacesRefused) });
    expect(replaced.text).toBe('Here is who can help.');
    expect(retrieve.mock.calls.map(([query]) => query)).toEqual(['my number is [removed]', 'my number is [removed]', 'my number is [removed]']);
  });

  it('a reply the step limit ended on a tool step is kept as delivered, never as the model wrote it', async () => {
    const textWithCall = () =>
      jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }], usage: USAGE });
    serve([textWithCall, text('Sure.')]);
    const session = agent({ ...OPENAI, memory: false, instructions: 'You are brief.', tools: { search }, maxSteps: 1 }).session('capped');
    const first = await session.send('Hi', { guards: guards(replacesOutput) });
    expect(first.finishReason).toBe('tool-calls');
    expect(first.text).toBe('A fixed reply.');
    expect(JSON.stringify(first.transcriptDelta)).not.toContain('Hello there.');
    await session.send('And again?');
    const second = JSON.stringify(posted()[1]);
    expect(second).toContain('A fixed reply.');
    expect(second).not.toContain('Hello there.');
  });
});

describe('the turn, the reply and the report hold what the guards decided, on the edges of a call', () => {
  const removesTurn: IGuardrailService = { id: 'in', config: { canSanitize: true }, evaluateInput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: null as unknown as string }) };
  const keepsTurn: IGuardrailService = { id: 'in', config: { canSanitize: true }, evaluateInput: async ({ input }) => ({ action: GuardrailAction.SANITIZE, modifiedText: input.textInput ?? '' }) };
  /** Rewrites the number in every streamed piece of the reply, and answers nothing on the whole reply. */
  const redactsPieces: IGuardrailService = {
    id: 'pieces',
    config: { canSanitize: true, evaluateStreamingChunks: true },
    evaluateOutput: async ({ chunk }) => (chunk.type === AgentOSResponseChunkType.TEXT_DELTA ? { action: GuardrailAction.SANITIZE, modifiedText: String((chunk as { textDelta?: string }).textDelta).replace('555 0100', '[number]') } : null),
  };

  it('a prompt a sanitizer emptied is sent as an empty user turn, never dropped', async () => {
    serve([text('Noted.')]);
    await generateText({ ...OPENAI, messages: [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Yes.' }], prompt: 'my number is 555 0100', guards: guards(removesTurn) });
    // without the empty turn the request would end on the earlier assistant entry
    expect(posted()[0].messages.at(-1)).toMatchObject({ role: 'user' });
    expect(JSON.stringify(posted()[0].messages.at(-1))).not.toContain('Yes.');
    expect(JSON.stringify(posted())).not.toContain('555 0100');

    serve([textStream('Noted.')]);
    await collect(streamText({ ...OPENAI, prompt: 'my number is 555 0100', guards: guards(removesTurn) }).fullStream);
    expect(posted()[1].messages.at(-1)).toMatchObject({ role: 'user' });
    expect(JSON.stringify(posted()[1])).not.toContain('555 0100');
  });

  it('a reply whose streamed pieces a sanitizer rewrote is delivered rewritten', async () => {
    serve([text('call 555 0100')]);
    const result = await generateText({ ...OPENAI, prompt: 'hi', guards: guards(redactsPieces) });
    expect(result.text).toBe('call [number]');
    expect(result.guardReport?.result).toBe('sanitized');
    expect(JSON.stringify(result.transcriptDelta)).not.toContain('555 0100');

    serve([textStream('call 555 0100')]);
    const streamed = streamText({ ...OPENAI, prompt: 'hi', guards: guards(redactsPieces) });
    await collect(streamed.fullStream);
    expect(await streamed.text).toBe('call [number]');
    expect((await streamed.guardReport)?.result).toBe('sanitized');
  });

  it('a reader that stops after the replacement still finds the report and the verdict', async () => {
    serve([textStream('the streamed reply')]);
    const verdicts: TextGuardrailVerdict[] = [];
    const result = streamText({ ...OPENAI, prompt: 'hello', guards: { services: [replacesOutput], context, onVerdict: (v: TextGuardrailVerdict) => { verdicts.push(v); } } });
    for await (const part of result.fullStream) if (part.type === 'text') break;
    expect(await result.guardReport).toMatchObject({ result: 'replaced', output: [expect.objectContaining({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT' })] });
    expect(verdicts.map((v) => [v.stage, v.action])).toEqual([['output', GuardrailAction.BLOCK]]);
  });

  it('a blocked reply\'s report keeps what the guards before the block answered', async () => {
    serve([text('the model reply')]);
    const stopped = await generateText({ ...OPENAI, prompt: 'hello', guards: guards(sanitizesOutput, blocksOutput) }).catch((e) => e);
    expect(stopped).toBeInstanceOf(GuardrailStopError);
    expect(stopped.report.output).toEqual([
      expect.objectContaining({ action: GuardrailAction.SANITIZE }),
      expect.objectContaining({ action: GuardrailAction.BLOCK, reasonCode: 'RULE_OUT' }),
    ]);
  });

  it('a reader can await the provider and the model while the reply is still open', async () => {
    serve([textStream('the streamed reply')]);
    const result = streamText({ ...OPENAI, prompt: 'hello', guards: guards({ id: 'quiet', evaluateOutput: async () => null }) });
    const stuck = (): Promise<string> => new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1000));
    const seen: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === 'text' && seen.length === 0) seen.push(await Promise.race([result.provider, stuck()]), await Promise.race([result.model, stuck()]));
    }
    expect(seen[0]).toBe('openai');
    expect(seen[1]).not.toBe('still waiting');
  });

  it('a call aborted while the guards judge a tool call runs no tool, in every tool loop', async () => {
    const abortingGuard = (controller: AbortController): IGuardrailService => ({
      id: 'tools',
      config: { evaluateToolCalls: true },
      evaluateOutput: async ({ chunk }) => {
        if (chunk.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST) controller.abort();
        return null;
      },
    });
    let controller = new AbortController();
    serve([toolCall('search', { q: 'x' }), text('done')]);
    await expect(generateText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, abortSignal: controller.signal, guards: guards(abortingGuard(controller)) })).rejects.toBeDefined();
    expect(search.execute).not.toHaveBeenCalled();

    controller = new AbortController();
    serve([text('<tool_call>{"name":"search","arguments":{"q":"y"}}</tool_call>'), text('done')]);
    await expect(generateText({ ...OPENAI, prompt: 'find y', tools: { search }, toolMode: 'prompt', abortSignal: controller.signal, guards: guards(abortingGuard(controller)) })).rejects.toBeDefined();
    expect(search.execute).not.toHaveBeenCalled();

    controller = new AbortController();
    serve([
      () => sse([delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }), delta({}, 'tool_calls'), '[DONE]']),
      textStream('done'),
    ]);
    const streamed = streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, abortSignal: controller.signal, guards: guards(abortingGuard(controller)) });
    await collect(streamed.fullStream).catch(() => []);
    expect(search.execute).not.toHaveBeenCalled();
  });

  it('a call aborted while the guards judge the reply rejects with the signal\'s reason', async () => {
    const controller = new AbortController();
    const aborting: IGuardrailService = { id: 'out', evaluateOutput: async ({ chunk }) => { if (isFinal(chunk)) controller.abort(new Error('stopped by the caller')); return null; } };
    serve([text('the reply')]);
    await expect(generateText({ ...OPENAI, prompt: 'hello', abortSignal: controller.signal, guards: guards(aborting) })).rejects.toThrow('stopped by the caller');
  });

  it('a dry-run stream with a tool step resolves text as the same call without guards does', async () => {
    const stepThenAnswer = () => [
      () => sse([delta({ role: 'assistant', content: 'Searching.' }), delta({ tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }), delta({}, 'tool_calls'), '[DONE]']),
      textStream('Answer.'),
    ];
    serve(stepThenAnswer());
    const plain = streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3 });
    await collect(plain.fullStream);
    const expected = await plain.text;
    expect(expected).toBe('Answer.');
    serve(stepThenAnswer());
    const dry = streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: { services: [blocksOutput], context, mode: 'dryRun' as const } });
    await collect(dry.fullStream);
    expect(await dry.text).toBe(expected);
  });

  it('a refused call is not shown to a stream reader as a call; a passed one is, before its result', async () => {
    const oneCall = () =>
      sse([delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }), delta({}, 'tool_calls'), '[DONE]']);
    serve([oneCall, textStream('done')]);
    const refused = await collect(streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(toolGuard(GuardrailAction.BLOCK)) }).fullStream);
    expect(refused.some((p) => p.type === 'tool-call')).toBe(false);
    expect(refused.find((p) => p.type === 'tool-result')).toMatchObject({ result: { refused: true } });

    serve([oneCall, textStream('done')]);
    const passed = await collect(streamText({ ...OPENAI, prompt: 'find x', tools: { search }, maxSteps: 3, guards: guards(toolGuard(GuardrailAction.FLAG)) }).fullStream);
    const kinds = passed.map((p) => p.type).filter((t) => t === 'tool-call' || t === 'tool-result');
    expect(kinds).toEqual(['tool-call', 'tool-result']);
  });

  it('a turn a sanitizer returned unchanged is kept in the history and observed', async () => {
    serve([textStream('Noted.'), text('Sure.')]);
    const observe = vi.fn(async (_role: 'user' | 'assistant', _text: string, _context?: unknown) => undefined);
    const session = agent({ ...OPENAI, memory: false, instructions: 'You are brief.', memoryProvider: { observe } }).session('unchanged');
    const streamed = session.stream('hello there', { guards: guards(keepsTurn) });
    await collect(streamed.fullStream);
    await streamed.text;
    await vi.waitFor(() => expect(JSON.stringify(session.messages())).toContain('hello there'));
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith('user', 'hello there', expect.anything()));
  });
});
