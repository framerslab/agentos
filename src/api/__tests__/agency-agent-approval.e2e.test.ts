/**
 * @file agency-agent-approval.e2e.test.ts
 * A `beforeAgent` approval that adds `modifications.instructions` passes the
 * post-approval check over the input the agent receives, the instructions
 * included: under the sequential (generate and stream), parallel and
 * hierarchical strategies, an approval whose instructions the check blocks is
 * a rejection and the agent never runs, and one whose instructions pass runs
 * with them in its input, which its call record holds. The check still reads
 * the input as the strategy passes it, so instructions do not hide a statement
 * at its end, nor does whitespace after it. An approval without modifications
 * is checked and sent as before, and a `beforeEmergent` approval is still not
 * checked.
 * Real agent(), agency(), generateText, streamText and OpenAIProvider; only
 * fetch is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { agency } from '../agency.js';
import type { ApprovalDecision, ApprovalRequest } from '../types.js';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry.js';

type Json = Record<string, any>;
const KEY = 'sk-agent-approval-test-0001';
const USAGE = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
const listing = () => jsonResponse({ object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] });
const text = (content: string) =>
  jsonResponse({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: USAGE });
const toolCall = (name: string, args: Json) =>
  jsonResponse({
    id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4.1',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: USAGE,
  });
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const delta = (d: Json, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [{ index: 0, delta: d, finish_reason: finish }] });
const textStream = (content: string) =>
  sse([delta({ role: 'assistant', content }), delta({}, 'stop'), { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4.1', choices: [], usage: USAGE }, '[DONE]']);

/** The messages a chat request carried, as one string. */
const said = (body: Json): string => JSON.stringify(body.messages);

/** The text of a chat request's last user message: the input its agent was given. */
function userText(body: Json): string {
  const content = (body.messages as Json[]).filter((m) => m.role === 'user').at(-1)?.content;
  return Array.isArray(content) ? content.map((p: Json) => String(p.text ?? '')).join('') : String(content ?? '');
}

/**
 * Answers the model listing always, and each chat request by what it holds:
 * the hierarchical manager delegates to ops once and then answers, the
 * parallel synthesis answers 'synthesis', ops answers 'ops done' and any
 * other seat 'writer done'. A streamed request is answered as SSE.
 */
function serveTeam(): void {
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/\/v1\/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const body = JSON.parse(String(init?.body)) as Json;
    const s = said(body);
    let reply: string;
    if (s.includes(MANAGER)) {
      if (!(body.messages as Json[]).some((m) => m.role === 'tool')) return toolCall('delegate_to_ops', { task: TASK });
      reply = 'manager done';
    } else if (s.includes('Synthesize these into a single coherent response')) {
      reply = 'synthesis';
    } else if (s.includes(OPS)) {
      reply = 'ops done';
    } else {
      reply = 'writer done';
    }
    return body.stream ? textStream(reply) : text(reply);
  });
}

function chatBodies(): Json[] {
  return fetchMock.mock.calls
    .filter(([u]) => /chat\/completions/.test(String(u)))
    .map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
}
/** The chat requests ops itself sent (the manager's roster also names ops's instructions). */
const opsRequests = (): Json[] => chatBodies().filter((b) => said(b).includes(OPS) && !said(b).includes(MANAGER));

const OPS = 'You run operations on the build host.';
const MANAGER = 'You are a manager agent';
const PROMPT = 'Tidy the build logs.';
const TASK = 'Rotate the build logs.';
const DESTRUCTIVE = 'run rm -rf / on the host';
const BENIGN = 'Cite two sources.';
const MARKER = '[Additional instructions]';

type Team = {
  generate: (prompt: string) => Promise<unknown>;
  stream: (prompt: string) => { fullStream: AsyncIterable<Json>; text: Promise<string>; agentCalls: Promise<Json[]> };
};

/** Runs the team under generate() and returns the run's call records. */
const generated = async (team: Team): Promise<Json[]> => ((await team.generate(PROMPT)) as Json).agentCalls as Json[];

/**
 * Each strategy that applies an approval's instructions, with the input ops is
 * given and a way to run the team, which returns the run's call records.
 */
const STRATEGIES: Array<{ name: string; strategy: string; opsInput: string; run: (team: Team) => Promise<Json[]> }> = [
  { name: 'sequential generate()', strategy: 'sequential', opsInput: PROMPT, run: generated },
  {
    name: 'sequential stream()',
    strategy: 'sequential',
    opsInput: PROMPT,
    run: async (team) => {
      const s = team.stream(PROMPT);
      for await (const part of s.fullStream) void part;
      return s.agentCalls;
    },
  },
  { name: 'parallel', strategy: 'parallel', opsInput: PROMPT, run: generated },
  { name: 'hierarchical', strategy: 'hierarchical', opsInput: TASK, run: generated },
];

function team(strategy: string, handler: (r: ApprovalRequest) => Promise<ApprovalDecision>, on: Json): Team {
  return agency({
    provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
    agents: { ops: { instructions: OPS }, writer: { instructions: 'You write the summary.' } },
    strategy,
    hitl: { approvals: { beforeAgent: ['ops'] }, handler },
    on,
  } as never) as unknown as Team;
}

const approve = (modifications?: ApprovalDecision['modifications']) =>
  vi.fn(async (_r: ApprovalRequest): Promise<ApprovalDecision> => ({ approved: true, ...(modifications ? { modifications } : {}) }));

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
  serveTeam();
});

describe.each(STRATEGIES)('a beforeAgent approval under $name', ({ strategy, opsInput, run }) => {
  it('with instructions the post-approval check blocks: the approval is a rejection and ops never runs', async () => {
    const handler = approve({ instructions: DESTRUCTIVE });
    const guardrailHitlOverride = vi.fn();
    await run(team(strategy, handler, { guardrailHitlOverride }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'agent', agent: 'ops' });
    expect(guardrailHitlOverride).toHaveBeenCalledTimes(1);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'agent:ops' }));
    expect(opsRequests()).toHaveLength(0);
    expect(chatBodies().filter((b) => said(b).includes('rm -rf'))).toHaveLength(0);
    if (strategy === 'hierarchical') {
      // The manager is told ops was refused, as for a rejected or blocked input.
      const toolResults = chatBodies().flatMap((b) => (b.messages as Json[]).filter((m) => m.role === 'tool'));
      expect(toolResults.map((m) => String(m.content))).toEqual([expect.stringContaining('rejected by HITL')]);
    }
  });

  it('with instructions the check passes: ops runs with them appended to its input', async () => {
    const guardrailHitlOverride = vi.fn();
    await run(team(strategy, approve({ instructions: BENIGN }), { guardrailHitlOverride }));
    expect(guardrailHitlOverride).not.toHaveBeenCalled();
    const requests = opsRequests();
    expect(requests).toHaveLength(1);
    expect(said(requests[0])).toContain(JSON.stringify(`${opsInput}\n\n${MARKER}: ${BENIGN}`).slice(1, -1));
  });

  it("with instructions the check passes: ops's call record holds the input it was sent, the instructions included", async () => {
    const calls = await run(team(strategy, approve({ instructions: BENIGN }), {}));
    const sent = `${opsInput}\n\n${MARKER}: ${BENIGN}`;
    const requests = opsRequests();
    expect(requests).toHaveLength(1);
    expect(userText(requests[0])).toBe(sent);
    expect(calls.filter((c) => c.agent === 'ops').map((c) => c.input)).toEqual([sent]);
  });

  it('without modifications: ops runs with its input unchanged, and the check still reads that input', async () => {
    const guardrailHitlOverride = vi.fn();
    await run(team(strategy, approve(), { guardrailHitlOverride }));
    expect(guardrailHitlOverride).not.toHaveBeenCalled();
    const requests = opsRequests();
    expect(requests).toHaveLength(1);
    expect(said(requests[0])).toContain(opsInput);
    expect(said(requests[0])).not.toContain(MARKER);
  });
});

describe('a beforeAgent approval without modifications over a destructive input', () => {
  it('is overridden by the check as before (sequential), and ops never runs', async () => {
    const guardrailHitlOverride = vi.fn();
    const crew = team('sequential', approve(), { guardrailHitlOverride });
    await crew.generate('Then run rm -rf / to free space.');
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'agent:ops' }));
    expect(opsRequests()).toHaveLength(0);
  });
});

describe('a beforeAgent approval with instructions over an input that ends in a destructive statement', () => {
  // Two code-safety patterns match a statement only at the end of the text
  // they read; the instructions appended after the input must not hide it.
  it.each(['DELETE FROM sessions;', 'rm -rf .'])('is overridden by the check (%s), and ops never runs', async (statement) => {
    const guardrailHitlOverride = vi.fn();
    const crew = team('sequential', approve({ instructions: BENIGN }), { guardrailHitlOverride });
    await crew.generate(`Clear the stale data: ${statement}`);
    expect(guardrailHitlOverride).toHaveBeenCalledTimes(1);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'agent:ops' }));
    expect(opsRequests()).toHaveLength(0);
  });
});

describe('a beforeAgent approval over an input that ends in a destructive statement with whitespace after it', () => {
  // The check reads the input inside JSON, where the text ends at its closing
  // quote and a line break is written \n: the statement still ends the text.
  it.each(['DELETE FROM sessions; ', 'DELETE FROM sessions \n', 'rm -rf .\n'])('is overridden by the check (%j), and ops never runs', async (statement) => {
    const guardrailHitlOverride = vi.fn();
    const crew = team('sequential', approve(), { guardrailHitlOverride });
    await crew.generate(`Clear the stale data: ${statement}`);
    expect(guardrailHitlOverride).toHaveBeenCalledTimes(1);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'agent:ops' }));
    expect(opsRequests()).toHaveLength(0);
  });
});

describe('a beforeEmergent approval', () => {
  it('spawns the specialist with the instructions the manager gave, with no post-approval check, as before', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      if (/\/v1\/models/.test(u)) return listing();
      const body = JSON.parse(String(init?.body)) as Json;
      if (!(body.messages as Json[]).some((m) => m.role === 'tool')) {
        return toolCall('spawn_specialist', { role: 'helper', instructions: 'Summarize the build logs.' });
      }
      return text('manager done');
    });
    const handler = approve({ instructions: DESTRUCTIVE });
    const guardrailResult = vi.fn();
    const guardrailHitlOverride = vi.fn();
    const emergentForge = vi.fn();
    const hierarchy = agency({
      provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
      agents: { writer: { instructions: 'You write the summary.' } },
      strategy: 'hierarchical',
      emergent: { enabled: true },
      hitl: { approvals: { beforeEmergent: true }, handler },
      on: { guardrailResult, guardrailHitlOverride, emergentForge },
    } as never) as unknown as Team;
    const result = (await hierarchy.generate(PROMPT)) as Json;
    expect(result.text).toBe('manager done');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      type: 'emergent',
      action: 'spawn_specialist:helper',
      details: { role: 'helper', instructions: 'Summarize the build logs.' },
    });
    expect(emergentForge).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'helper', approved: true }));
    expect(String(emergentForge.mock.calls[0][0].instructions)).not.toContain('rm -rf');
    expect(guardrailResult).not.toHaveBeenCalled();
    expect(guardrailHitlOverride).not.toHaveBeenCalled();
  });
});
