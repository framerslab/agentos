/**
 * @file agency-tool-approval.e2e.test.ts
 * `hitl.approvals.beforeTool` holds on every tool loop: native, prompt-shim
 * and streamed; on roster seats, pre-built seats, the hierarchical manager,
 * spawned specialists and nested agencies. Real agent(), agency(),
 * generateText, streamText and OpenAIProvider; only fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agent } from '../agent.js';
import { agency } from '../agency.js';
import { generateText } from '../generateText.js';
import { hitl } from '../hitl.js';
import { buildHierarchicalTools } from '../runtime/strategies/hierarchical.js';
import { AgencyConfigError, type AgencyOptions, type ApprovalRequest, type ApprovalDecision } from '../types.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
type ToolLike = { execute: (args: Record<string, unknown>) => Promise<unknown> };
const KEY = 'sk-approval-test-0001';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
const listing = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
const text = (content: string) =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
const toolCalls = (calls: Array<{ name: string; args: Json; id: string }>) =>
  jsonResponse({
    id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: 'tool_calls' }],
    usage: USAGE,
  });
const toolCall = (name: string, args: Json, id = 'call_1') => toolCalls([{ name, args, id }]);
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta: Json, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta, finish_reason: finish }] });
const toolCallStream = (name: string, args: Json, id = 'call_s1') =>
  sse([
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
    chunk({}, 'tool_calls'),
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [], usage: USAGE },
    '[DONE]',
  ]);
const textStream = (content: string) =>
  sse([chunk({ role: 'assistant', content }), chunk({}, 'stop'), { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [], usage: USAGE }, '[DONE]']);

/**
 * Answers the model listing always and each chat request with the next entry
 * of `script`, in order. A streamed request reads its body as SSE, so the
 * entries it takes are the `*Stream` helpers.
 */
function serve(script: Array<(body: Json) => Response>): void {
  const queue = [...script];
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/\/v1\/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const next = queue.shift();
    if (!next) throw new Error(`script exhausted at ${u}`);
    return next(JSON.parse(String(init?.body)) as Json);
  });
}
function chatBodies(): Json[] {
  return fetchMock.mock.calls.filter(([u]) => /chat\/completions/.test(String(u))).map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
}
/** Reads a stream to its end. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const part of stream) void part;
}
const search = { description: 'Search.', parameters: { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q' as const] }, execute: vi.fn(async () => ({ hits: 1 })) };
const waitForever = (): Promise<ApprovalDecision> => new Promise(() => {});

beforeEach(() => { fetchMock.mockReset(); search.execute.mockClear(); globalLLMProviderHealth.reset(); });
afterEach(() => { vi.unstubAllEnvs(); });

const base = (hitlConfig: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  agency({
    provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search },
    agents: { worker: { instructions: 'Use search when asked.' } },
    strategy: 'sequential',
    hitl: hitlConfig as never,
    ...extra,
  } as never);

describe('a listed tool waits for the handler', () => {
  it('native loop: a rejection skips the tool, the model is told, the call resolves', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done')]);
    const team = base({ approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') });
    const result = (await team.generate('find x')) as Json;
    expect(result.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    const toolMsg = chatBodies()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ skipped: true });
  });

  it('prompt-tool path: the same', async () => {
    serve([() => text('<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>'), () => text('done')]);
    const team = base({ approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') });
    const result = (await team.generate('find x', { toolMode: 'prompt' })) as Json;
    expect(result.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    const messages = chatBodies()[1].messages as Json[];
    const last = messages[messages.length - 1];
    expect(last.content).toContain('<tool_response>');
    expect(last.content).toContain('skipped');
  });

  it('a handler that throws: the tool never runs; the call rejects with that error after the run is billed', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done')]);
    const boom = new Error('handler exploded');
    const team = base({ approvals: { beforeTool: ['search'] }, handler: async () => { throw boom; } });
    await expect(team.generate('find x')).rejects.toBe(boom);
    expect(search.execute).not.toHaveBeenCalled();
    expect(((await team.usage()) as Json).totalTokens).toBe(14);
  });

  it("a handler error's message never reaches the model: the tool result carries a fixed reason, the error goes to on.error and the rejection", async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done')]);
    // The message fetch gives hitl.webhook for a URL that carries credentials names them.
    const leak = new TypeError('Request cannot be constructed from a URL that includes credentials: https://approver:s3cret@hooks.example.com/decide');
    const error = vi.fn();
    const team = base({ approvals: { beforeTool: ['search'] }, handler: async () => { throw leak; } }, { on: { error } });
    await expect(team.generate('find x')).rejects.toBe(leak);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: leak }));
    const toolMsg = chatBodies()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toEqual({ skipped: true, reason: 'the approval handler failed' });
    expect(JSON.stringify(chatBodies())).not.toContain('s3cret');
  });

  it('a decision whose approved is not a boolean, and a guardrail check that throws after an approval, are handler errors: the tool never runs, on.error fires, the call rejects', async () => {
    serve([
      () => toolCall('search', { q: 'x' }), () => text('done'),
      () => toolCall('search', { q: 'y' }), () => text('done'),
      () => toolCall('search', { q: 'z' }), () => text('done'),
    ]);
    // hitl.webhook resolves whatever JSON the endpoint answers: a 200 with a null body is null.
    const answers: unknown[] = [null, { approved: 'yes' }, { approved: true }];
    const handler = vi.fn(async () => answers.shift() as ApprovalDecision);
    const error = vi.fn();
    const team = base({ approvals: { beforeTool: ['search'] }, handler }, { on: { error } });
    await expect(team.generate('find x')).rejects.toThrow(/malformed decision/);
    await expect(team.generate('find y')).rejects.toThrow(/malformed decision/);
    // The hook leaves an argument JSON cannot hold, so the post-approval guardrails cannot serialize the call.
    const addBigInt = async (info: { args: Record<string, unknown> }) => ({ ...info, args: { ...info.args, n: 10n } });
    await expect(team.generate('find z', { onBeforeToolExecution: addBigInt })).rejects.toThrow(TypeError);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(3);
    expect(search.execute).not.toHaveBeenCalled();
  });

  it("a timeout under onTimeout 'error' rejects generate() and stream() with the timeout error; usage is in the totals", async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done'), () => toolCallStream('search', { q: 'y' }), () => textStream('done again')]);
    const team = base({ approvals: { beforeTool: ['search'] }, handler: waitForever, timeoutMs: 10, onTimeout: 'error' });
    await expect(team.generate('find x')).rejects.toThrow(/HITL approval timed out/);
    await expect(team.stream('find y').text).rejects.toThrow(/HITL approval timed out/);
    expect(search.execute).not.toHaveBeenCalled();
    expect(((await team.usage()) as Json).totalTokens).toBe(28);
  });

  it("under onTimeout 'error', textStream and fullStream each end by throwing the timeout error", async () => {
    serve([() => toolCallStream('search', { q: 'x' }), () => textStream('done'), () => toolCallStream('search', { q: 'y' }), () => textStream('done again')]);
    const team = base({ approvals: { beforeTool: ['search'] }, handler: waitForever, timeoutMs: 10, onTimeout: 'error' });
    await expect(drain(team.stream('find x').textStream)).rejects.toThrow(/HITL approval timed out/);
    await expect(drain(team.stream('find y').fullStream)).rejects.toThrow(/HITL approval timed out/);
    expect(search.execute).not.toHaveBeenCalled();
    expect(((await team.usage()) as Json).totalTokens).toBe(28);
  });

  it('a caller that reads only textStream, inside try/catch, gets the timeout error and leaves no rejection unhandled', async () => {
    serve([() => toolCallStream('search', { q: 'x' }), () => textStream('done')]);
    const team = base({ approvals: { beforeTool: ['search'] }, handler: waitForever, timeoutMs: 10, onTimeout: 'error' });
    const s = team.stream('find x');
    let caught: unknown;
    try {
      for await (const chunk of s.textStream) void chunk;
    } catch (err) {
      caught = err;
    }
    // Nothing else on the result is read: its text, usage, agentCalls and
    // parsed reject unobserved, and vitest fails the run on an unhandled rejection.
    expect((caught as Error | undefined)?.message).toMatch(/HITL approval timed out/);
    expect(((await team.usage()) as Json).totalTokens).toBe(14);
  });

  it('after a handler error, a later tool call in the same step is refused without asking the handler', async () => {
    serve([
      () => toolCalls([{ name: 'search', args: { q: 'x' }, id: 'call_a' }, { name: 'search', args: { q: 'y' }, id: 'call_b' }]),
      () => text('done'),
    ]);
    const handler = vi.fn(async () => { throw new Error('approval service down'); });
    const approvalRequested = vi.fn();
    const team = base({ approvals: { beforeTool: ['search'] }, handler }, { on: { approvalRequested } });
    await expect(team.generate('find x and y')).rejects.toThrow('approval service down');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(approvalRequested).toHaveBeenCalledTimes(1);
    expect(search.execute).not.toHaveBeenCalled();
    const toolMsgs = (chatBodies()[1].messages as Json[]).filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => JSON.parse(m.content).skipped)).toEqual([true, true]);
  });

  it('a call that ends while the guardrail module loads fires no guardrailResult event and no override warning', async () => {
    // One prompt-tool turn gates both calls together. The first is approved
    // and its guardrail check would block it; the second's handler throws
    // while the first's gate is loading the guardrail module.
    serve([
      () => text('<tool_call>{"name":"search","arguments":{"q":"rm -rf /tmp/x"}}</tool_call>\n<tool_call>{"name":"search","arguments":{"q":"y"}}</tool_call>'),
      () => text('done'),
    ]);
    const handler = vi.fn(async (r: ApprovalRequest): Promise<ApprovalDecision> => {
      if ((r.details.args as Json).q === 'y') throw new Error('approval service down');
      return { approved: true };
    });
    const approvalDecided = vi.fn();
    const guardrailResult = vi.fn();
    const guardrailHitlOverride = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const team = base({ approvals: { beforeTool: ['search'] }, handler }, { on: { approvalDecided, guardrailResult, guardrailHitlOverride } });
      await expect(team.generate('clean up', { toolMode: 'prompt' })).rejects.toThrow('approval service down');
      // The first call's approval was reported while the call was still running.
      expect(approvalDecided).toHaveBeenCalledTimes(1);
      expect(guardrailResult).not.toHaveBeenCalled();
      expect(guardrailHitlOverride).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((call) => String(call[0]).includes('Overrode HITL approval'))).toBe(false);
      expect(search.execute).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a seat's own hook that throws does not bypass the gate", async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done')]);
    const seat = agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search }, fallbackProviders: [], onBeforeToolExecution: async () => { throw new Error('hook broke'); } });
    const team = agency({ agents: { seat }, strategy: 'sequential', hitl: { approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') } });
    await team.generate('find x');
    expect(search.execute).not.toHaveBeenCalled();
  });

  it('a tool the hierarchical manager calls', async () => {
    serve([() => toolCall('search', { q: 'x' }, 'call_m1'), () => text('manager done')]);
    const handler = vi.fn(hitl.autoReject('no'));
    const team = agency({
      provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search },
      agents: { worker: { instructions: 'Static seat.' } },
      strategy: 'hierarchical',
      hitl: { approvals: { beforeTool: ['search'] }, handler },
    } as never);
    const result = (await team.generate('find x')) as Json;
    expect(result.text).toBe('manager done');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(search.execute).not.toHaveBeenCalled();
  });

  it('a tool of a specialist the manager spawned', async () => {
    // The manager's tool table is fixed when its call starts, so a delegate it
    // spawns cannot be called in the same turn. This seat drives the
    // hierarchical spawn and delegate tools with the per-call options agency()
    // hands it, and the spawned specialist runs the real tool loop.
    serve([() => toolCall('search', { q: 'x' }, 'call_h1'), () => text('helper done')]);
    const handler = vi.fn(hitl.autoReject('no'));
    const hierarchy = { provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search }, agents: {}, emergent: { enabled: true } } as unknown as AgencyOptions;
    const outcomes: unknown[] = [];
    const manager = {
      async generate(task: string, callOpts?: Record<string, unknown>) {
        const { tools } = buildHierarchicalTools({}, hierarchy, callOpts);
        outcomes.push(await (tools.spawn_specialist as unknown as ToolLike).execute({ role: 'helper', instructions: 'Search for things when asked.' }));
        outcomes.push(await (tools.delegate_to_helper as unknown as ToolLike).execute({ task }));
        return { text: 'manager done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const team = agency({ agents: { manager: manager as never }, hitl: { approvals: { beforeTool: ['search'] }, handler } });
    const result = (await team.generate('find x')) as Json;
    expect(result.text).toBe('manager done');
    expect(outcomes[0]).toMatchObject({ success: true });
    expect(chatBodies()).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'tool', action: 'search' });
    expect(search.execute).not.toHaveBeenCalled();
    const toolMsg = chatBodies()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ skipped: true });
  });

  it('a tool called under stream()', async () => {
    serve([() => toolCallStream('search', { q: 'x' }), () => textStream('streamed done')]);
    const team = base({ approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') });
    const s = team.stream('find x');
    let out = ''; for await (const t of s.textStream) out += t;
    expect(out).toBe('streamed done');
    expect(search.execute).not.toHaveBeenCalled();
  });

  it("a pre-built seat's tool, and its own hook still runs with and without beforeTool", async () => {
    const hook = vi.fn(async (info: { args: Record<string, unknown> }) => info as never);
    const mk = () => agent({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search }, fallbackProviders: [], onBeforeToolExecution: hook as never });
    serve([() => toolCall('search', { q: 'x' }), () => text('a'), () => toolCall('search', { q: 'y' }), () => text('b')]);
    await agency({ agents: { seat: mk() }, hitl: { approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') } }).generate('find x');
    expect(search.execute).not.toHaveBeenCalled();
    await agency({ agents: { seat: mk() } }).generate('find y');
    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("a caller's per-call hook rewrites the arguments; the handler sees them and the tool runs with them", async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done')]);
    const seen: ApprovalRequest[] = [];
    const team = base({ approvals: { beforeTool: ['search'] }, handler: async (r: ApprovalRequest) => { seen.push(r); return { approved: true }; } });
    await team.generate('find x', { onBeforeToolExecution: async (info: { args: Record<string, unknown> }) => ({ ...info, args: { q: 'rewritten' } }) });
    expect(seen[0].details.args).toEqual({ q: 'rewritten' });
    // A plain tool definition's execute receives the arguments alone.
    expect(search.execute).toHaveBeenCalledWith({ q: 'rewritten' });
  });

  it('an approval that carries modifications.toolArgs is refused: the call never runs with the arguments the approver meant to replace', async () => {
    serve([() => toolCall('search', { q: 'key: sk-live-abc123' }), () => text('done'), () => toolCall('search', { q: 'y' }), () => text('done again')]);
    const approvalDecided = vi.fn();
    const handler = vi.fn(async (): Promise<ApprovalDecision> => ({ approved: true, modifications: { toolArgs: { q: 'key: [REDACTED]' } } }));
    const team = base({ approvals: { beforeTool: ['search'] }, handler }, { on: { approvalDecided } });
    const r = (await team.generate('send the key')) as Json;
    expect(r.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    expect(approvalDecided).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
    const toolMsg = chatBodies()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ skipped: true, reason: expect.stringContaining('onBeforeToolExecution') });
    // A null toolArgs names no arguments: that approval runs the call as asked.
    handler.mockImplementationOnce(async () => ({ approved: true, modifications: { toolArgs: null } }));
    await team.generate('find y');
    expect(search.execute).toHaveBeenCalledWith({ q: 'y' });
  });

  it('a hook that returns null skips the tool and the handler is never asked', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('done')]);
    const handler = vi.fn(async () => ({ approved: true }));
    await base({ approvals: { beforeTool: ['search'] }, handler }).generate('find x', { onBeforeToolExecution: async () => null });
    expect(handler).not.toHaveBeenCalled();
    expect(search.execute).not.toHaveBeenCalled();
  });

  it('a guardrailResult callback that throws does not undo a guardrail block: an approved rm -rf never runs, through beforeTool and through beforeAgent', async () => {
    // code-safety is last in the default list; a throwing notification used to land in the evaluator's catch and the block was lost.
    const throwing = { guardrailResult: () => { throw new Error('ui down'); } };
    serve([() => toolCall('search', { q: 'rm -rf /tmp/foo' }), () => text('done')]);
    const gated = base({ approvals: { beforeTool: ['search'] }, handler: async () => ({ approved: true }) }, { on: throwing });
    const r = (await gated.generate('clean up')) as Json;
    expect(r.text).toBe('done');
    expect(search.execute).not.toHaveBeenCalled();
    const toolMsg = chatBodies()[1].messages.find((m: Json) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ skipped: true });
    // Through beforeAgent the seat itself never runs: no chat request is made.
    fetchMock.mockClear();
    serve([() => text('never')]);
    const seatGated = base({ approvals: { beforeAgent: ['worker'] }, handler: async () => ({ approved: true }) }, { on: throwing });
    await seatGated.generate('please run rm -rf /tmp/foo');
    expect(chatBodies()).toHaveLength(0);
  });

  it('beforeTool with no handler fails construction', () => {
    expect(() => base({ approvals: { beforeTool: ['search'] } })).toThrow(AgencyConfigError);
  });

  it("a plain generateText call with toolMode 'prompt' calls its hook once per tool call", async () => {
    serve([() => text('<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>'), () => text('done')]);
    const hook = vi.fn(async (info: { args: Record<string, unknown> }) => info as never);
    await generateText({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, prompt: 'find x', tools: { search }, toolMode: 'prompt', fallbackProviders: [], onBeforeToolExecution: hook as never });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(search.execute).toHaveBeenCalledTimes(1);
  });

  it('a filled slot rejects before beforeReturn is asked and before agentEnd fires, and starts no validation retry', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('not json'), () => text('{"ok":true}')]);
    const handler = vi.fn(async (r: ApprovalRequest) => { if (r.type === 'tool') throw new Error('tool approval failed'); return { approved: true }; });
    const agentEnd = vi.fn();
    const team = base(
      { approvals: { beforeTool: ['search'], beforeReturn: true }, handler },
      { output: z.object({ ok: z.boolean() }), controls: { maxValidationRetries: 2 }, on: { agentEnd } },
    );
    await expect(team.generate('find x')).rejects.toThrow('tool approval failed');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(agentEnd).not.toHaveBeenCalled();
    expect(chatBodies().length).toBe(2);
  });
});

describe('nested agencies', () => {
  const child = (hitlConfig?: Record<string, unknown>) =>
    agency({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search }, agents: { inner: { instructions: 'Use search.' } }, strategy: 'sequential', ...(hitlConfig ? { hitl: hitlConfig } : {}) } as never);

  it('a plain nested agency under a parent with beforeTool, and under one without, never rejects the call', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('a'), () => toolCall('search', { q: 'y' }), () => text('b')]);
    const r1 = (await agency({ agents: { c: child() }, hitl: { approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') } }).generate('x')) as Json;
    expect(r1.text).toBe('a');
    expect(search.execute).not.toHaveBeenCalled();
    const r2 = (await agency({ agents: { c: child() } }).generate('y')) as Json;
    expect(r2.text).toBe('b');
    expect(search.execute).toHaveBeenCalledTimes(1);
  });

  it('both handlers are asked, the parent first; after a parent rejection the child is never asked', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('a'), () => toolCall('search', { q: 'y' }), () => text('b')]);
    const order: string[] = [];
    const parentOk = async () => { order.push('parent'); return { approved: true }; };
    const childOk = async () => { order.push('child'); return { approved: true }; };
    await agency({ agents: { c: child({ approvals: { beforeTool: ['search'] }, handler: childOk }) }, hitl: { approvals: { beforeTool: ['search'] }, handler: parentOk } }).generate('x');
    expect(order).toEqual(['parent', 'child']);
    expect(search.execute).toHaveBeenCalledTimes(1);
    const childSpy = vi.fn(childOk);
    await agency({ agents: { c: child({ approvals: { beforeTool: ['search'] }, handler: childSpy }) }, hitl: { approvals: { beforeTool: ['search'] }, handler: hitl.autoReject('no') } }).generate('y');
    expect(childSpy).not.toHaveBeenCalled();
    expect(search.execute).toHaveBeenCalledTimes(1);
  });

  it("a parent timeout under 'error' inside a nested agency: the nested call completes, the parent rejects billed, through generate() and stream()", async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('inner done'), () => toolCallStream('search', { q: 'y' }), () => textStream('inner done 2')]);
    const inner = child();
    const parent = agency({ agents: { c: inner }, hitl: { approvals: { beforeTool: ['search'] }, handler: waitForever, timeoutMs: 10, onTimeout: 'error' } });
    await expect(parent.generate('x')).rejects.toThrow(/timed out/);
    expect(((await inner.usage()) as Json).totalTokens).toBe(14);
    expect(((await parent.usage()) as Json).totalTokens).toBe(14);
    await expect(parent.stream('y').text).rejects.toThrow(/timed out/);
    expect(((await parent.usage()) as Json).totalTokens).toBe(28);
  });

  it("a parent's approval that arrives after the nested call's own approval failed runs nothing", async () => {
    // One prompt-tool turn gates both calls together. The nested agency's
    // handler fails on search; the parent holds its approval of ping until then.
    serve([() => text('<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>\n<tool_call>{"name":"ping","arguments":{}}</tool_call>'), () => text('inner done')]);
    const ping = { description: 'Ping.', parameters: { type: 'object' as const, properties: {} }, execute: vi.fn(async () => ({ ok: true })) };
    let releasePing = (): void => undefined;
    const pingApproved = new Promise<ApprovalDecision>((resolve) => { releasePing = () => resolve({ approved: true }); });
    const parentHandler = vi.fn(async (r: ApprovalRequest): Promise<ApprovalDecision> => (r.action === 'ping' ? pingApproved : { approved: true }));
    const childError = new Error('child approval down');
    const inner = agency({
      provider: 'openai', model: 'gpt-4.1', apiKey: KEY, tools: { search, ping },
      agents: { inner: { instructions: 'Use the tools.' } },
      strategy: 'sequential',
      hitl: { approvals: { beforeTool: ['search'] }, handler: async () => { throw childError; } },
      on: { error: () => releasePing() },
    } as never);
    const parent = agency({ agents: { c: inner }, hitl: { approvals: { beforeTool: ['*'] }, handler: parentHandler } });
    await expect(parent.generate('x', { toolMode: 'prompt' })).rejects.toBe(childError);
    expect(parentHandler).toHaveBeenCalledTimes(2);
    expect(search.execute).not.toHaveBeenCalled();
    // The nested agency does not list ping, so the parent's late approval was all it needed to run.
    expect(ping.execute).not.toHaveBeenCalled();
  });

  it('a string or a throwing __approvalGate passed per call skips the tool, asks no handler and does not reject', async () => {
    serve([() => toolCall('search', { q: 'x' }), () => text('a'), () => toolCall('search', { q: 'y' }), () => text('b')]);
    const handler = vi.fn(async () => ({ approved: true }));
    const team = base({ approvals: { beforeTool: ['search'] }, handler });
    const r1 = (await team.generate('x', { __approvalGate: 'nope' })) as Json;
    expect(r1.text).toBe('a');
    const r2 = (await team.generate('y', { __approvalGate: async () => { throw new Error('bad gate'); } })) as Json;
    expect(r2.text).toBe('b');
    expect(search.execute).not.toHaveBeenCalled();
    // A received gate that is present and not a function fails closed (D12): every tool is skipped and the agency's own handler is never asked; a throwing gate refuses the same way.
    expect(handler).not.toHaveBeenCalled();
    // The refusal covers every tool, listed in beforeTool or not (D12): an unlisted tool, which runs unasked with no received gate, is skipped under a malformed one.
    const ping = { description: 'Ping.', parameters: { type: 'object' as const, properties: {} }, execute: vi.fn(async () => ({ ok: true })) };
    const twoTools = base({ approvals: { beforeTool: ['search'] }, handler }, { tools: { search, ping } });
    serve([() => toolCall('ping', {}), () => text('c'), () => toolCall('ping', {}), () => text('d')]);
    const r3 = (await twoTools.generate('z', { __approvalGate: 'nope' })) as Json;
    expect(r3.text).toBe('c');
    expect(ping.execute).not.toHaveBeenCalled();
    const r4 = (await twoTools.generate('w')) as Json;
    expect(r4.text).toBe('d');
    expect(ping.execute).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });
});
