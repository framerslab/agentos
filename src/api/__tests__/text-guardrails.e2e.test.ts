/**
 * @file text-guardrails.e2e.test.ts
 * The `guards` option on generateText(), streamText() and an agent's calls: the user turn judged once before any
 * request, tool calls judged before any hook, the reply judged before the caller receives it, a dry run that changes
 * nothing, and a transcript that holds what was delivered. Real generateText, streamText, agent() and providers;
 * only fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agent } from '../agent.js';
import { GuardrailStopError } from '../errors.js';
import { generateText, type TextGuardrailVerdict } from '../generateText.js';
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
