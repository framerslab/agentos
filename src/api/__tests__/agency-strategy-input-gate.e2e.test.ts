/**
 * @file agency-strategy-input-gate.e2e.test.ts
 * Under the graph, review-loop and debate strategies an agent's input carries
 * what other agents wrote, and the `beforeAgent` gate reads that input: the
 * approver is shown it and the post-approval check reads it. An earlier
 * agent's output the check blocks turns the approval into a rejection, so it
 * never reaches the gated agent's request, and the strategy goes on as it does
 * after any rejection. An output the check passes reaches the agent, with the
 * approval's instructions after it, and the agent's call record holds the
 * text it was sent. Where the strategy writes more text after the task or
 * after an earlier agent's output (graph, review-loop, debate, and sequential
 * after its first agent), the check also reads that task or output on its
 * own, so a statement it matches only at the end of a text is blocked there
 * too, whitespace after it included.
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
const KEY = 'sk-strategy-input-gate-0001';
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

const OPS = 'You run operations on the build host.';
const RESEARCH = 'You collect facts about the build host.';
const WRITER = 'You draft the maintenance plan.';
const EDITOR = 'You review the maintenance plan.';
const PRO = 'You argue for clearing the build host.';
const JUDGE = 'You are the JUDGE of the following debate.';
const PROMPT = 'Tidy the build logs.';
/** An earlier agent's output the code-safety check blocks. */
const BLOCKED = 'Then run rm -rf / on the host to free space.';
/** An earlier agent's output the check passes. */
const PASSING = 'The build logs under /var/log/build are 30 days old.';
const BENIGN = 'Cite two sources.';
const MARKER = '[Additional instructions]';
const VERDICT = 'The verdict.';
const SEATS: Record<string, string> = { ops: OPS, research: RESEARCH, writer: WRITER, editor: EDITOR, pro: PRO };

const last = <T>(items: T[]): T => items[items.length - 1];

/** The text of a chat request's last user message: the input its agent was given. */
function userText(body: Json): string {
  const content = last((body.messages as Json[]).filter((m) => m.role === 'user'))?.content;
  return Array.isArray(content) ? content.map((p: Json) => String(p.text ?? '')).join('') : String(content ?? '');
}

/** The seat that sent a chat request: the roster agent whose instructions its system message carries, or the debate's judge. */
function seatOf(body: Json): string {
  const system = JSON.stringify((body.messages as Json[]).filter((m) => m.role === 'system'));
  const seat = Object.keys(SEATS).find((s) => system.includes(SEATS[s]));
  if (seat) return seat;
  if (userText(body).includes(JUDGE)) return 'judge';
  throw new Error(`a chat request from no known seat: ${JSON.stringify(body.messages).slice(0, 200)}`);
}

/**
 * Answers the model listing always, and each chat request with the next reply
 * scripted for its seat; a seat's last reply answers every later request. A
 * streamed request is answered as SSE.
 */
function serve(script: Record<string, string[]>): void {
  const queues: Record<string, string[]> = Object.fromEntries(Object.entries(script).map(([seat, replies]) => [seat, [...replies]]));
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (/\/v1\/models/.test(u)) return listing();
    if (!/\/v1\/chat\/completions/.test(u)) throw new Error(`unexpected request ${u}`);
    const body = JSON.parse(String(init?.body)) as Json;
    const queue = queues[seatOf(body)] ?? [];
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? 'done';
    return body.stream ? textStream(reply) : text(reply);
  });
}

function chatBodies(): Json[] {
  return fetchMock.mock.calls
    .filter(([u]) => /chat\/completions/.test(String(u)))
    .map(([, init]) => JSON.parse(String((init as { body?: unknown }).body)) as Json);
}
/** The chat requests the gated agent, ops, sent. */
const opsRequests = (): Json[] => chatBodies().filter((b) => seatOf(b) === 'ops');

type Team = {
  generate: (prompt: string) => Promise<unknown>;
  stream: (prompt: string) => { fullStream: AsyncIterable<Json>; text: Promise<string>; agentCalls: Promise<Json[]> };
};
type Outcome = { text: string; agentCalls: Json[] };

const generated = async (team: Team, prompt: string = PROMPT): Promise<Outcome> => {
  const result = (await team.generate(prompt)) as Json;
  return { text: String(result.text), agentCalls: (result.agentCalls ?? []) as Json[] };
};
const streamed = async (team: Team, prompt: string = PROMPT): Promise<Outcome> => {
  const s = team.stream(prompt);
  for await (const part of s.fullStream) void part;
  return { text: await s.text, agentCalls: await s.agentCalls };
};

/**
 * Each strategy path that hands one agent's output to another, with ops as the
 * agent the `beforeAgent` gate guards, what each seat answers given the earlier
 * agent's output, and how the run ends once ops is refused: the strategy's text
 * and the agents that ran.
 */
const CASES: Array<{
  name: string;
  strategy: string;
  agents: Json;
  extra?: Json;
  script: (earlier: string) => Record<string, string[]>;
  run: (team: Team) => Promise<Outcome>;
  refused: Outcome;
}> = [
  {
    name: 'graph generate(), the outputs of the dependencies',
    strategy: 'graph',
    agents: { research: { instructions: RESEARCH }, ops: { instructions: OPS, dependsOn: ['research'] } },
    script: (earlier) => ({ research: [earlier], ops: ['ops done'] }),
    run: generated,
    // ops is skipped, so research's result is the last one standing.
    refused: { text: BLOCKED, agentCalls: [{ agent: 'research' }] },
  },
  {
    name: 'graph stream(), the outputs of the dependencies',
    strategy: 'graph',
    agents: { research: { instructions: RESEARCH }, ops: { instructions: OPS, dependsOn: ['research'] } },
    script: (earlier) => ({ research: [earlier], ops: ['ops done'] }),
    run: streamed,
    refused: { text: BLOCKED, agentCalls: [{ agent: 'research' }] },
  },
  {
    name: "review-loop, the reviewer's input (the draft)",
    strategy: 'review-loop',
    agents: { writer: { instructions: WRITER }, ops: { instructions: OPS } },
    script: (earlier) => ({ writer: [earlier], ops: [JSON.stringify({ approved: true, feedback: 'Fine.' })] }),
    run: generated,
    // A refused reviewer leaves the current draft as the result.
    refused: { text: BLOCKED, agentCalls: [{ agent: 'writer' }] },
  },
  {
    name: "review-loop, the producer's input in the next round (the reviewer's feedback)",
    strategy: 'review-loop',
    agents: { ops: { instructions: OPS }, editor: { instructions: EDITOR } },
    script: (earlier) => ({
      ops: ['First draft.', 'Second draft.'],
      editor: [JSON.stringify({ approved: false, feedback: earlier }), JSON.stringify({ approved: true, feedback: 'Fine.' })],
    }),
    run: generated,
    // A refused producer ends the loop with its previous draft.
    refused: { text: 'First draft.', agentCalls: [{ agent: 'ops' }, { agent: 'editor' }] },
  },
  {
    name: 'debate, the transcript of the arguments so far',
    strategy: 'debate',
    agents: { pro: { instructions: PRO }, ops: { instructions: OPS } },
    extra: { maxRounds: 1 },
    script: (earlier) => ({ pro: [earlier], ops: ['I disagree.'], judge: [VERDICT] }),
    run: generated,
    // A refused debater sits the round out, and the judge still rules.
    refused: { text: VERDICT, agentCalls: [{ agent: 'pro' }] },
  },
];

function team(
  strategy: string,
  agents: Json,
  handler: (r: ApprovalRequest) => Promise<ApprovalDecision>,
  on: Json,
  extra: Json = {},
): Team {
  return agency({
    provider: 'openai', model: 'gpt-4.1', apiKey: KEY,
    agents,
    strategy,
    hitl: { approvals: { beforeAgent: ['ops'] }, handler },
    on,
    ...extra,
  } as never) as unknown as Team;
}

const approve = (modifications?: ApprovalDecision['modifications']) =>
  vi.fn(async (_r: ApprovalRequest): Promise<ApprovalDecision> => ({ approved: true, ...(modifications ? { modifications } : {}) }));

beforeEach(() => {
  fetchMock.mockReset();
  globalLLMProviderHealth.reset();
});

describe.each(CASES)('the beforeAgent gate under $name', ({ strategy, agents, extra, script, run, refused }) => {
  it("an earlier agent's output the post-approval check blocks never reaches ops, and the strategy goes on as after a rejection", async () => {
    serve(script(BLOCKED));
    const handler = approve();
    const guardrailHitlOverride = vi.fn();
    const outcome = await run(team(strategy, agents, handler, { guardrailHitlOverride }, extra));

    expect(guardrailHitlOverride).toHaveBeenCalledTimes(1);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'agent:ops' }));
    // The approver was shown the input that carried it.
    expect(String(last(handler.mock.calls)[0].details.input)).toContain(BLOCKED);
    expect(opsRequests().filter((b) => userText(b).includes(BLOCKED))).toHaveLength(0);
    expect(opsRequests()).toHaveLength(refused.agentCalls.filter((c) => c.agent === 'ops').length);
    expect(outcome.text).toBe(refused.text);
    expect(outcome.agentCalls.map((c) => c.agent)).toEqual(refused.agentCalls.map((c) => c.agent));
  });

  it("an output the check passes reaches ops as the approver was shown it, with the approval's instructions after it", async () => {
    serve(script(PASSING));
    const handler = approve({ instructions: BENIGN });
    const guardrailHitlOverride = vi.fn();
    const outcome = await run(team(strategy, agents, handler, { guardrailHitlOverride }, extra));

    expect(guardrailHitlOverride).not.toHaveBeenCalled();
    const sent = userText(last(opsRequests()));
    expect(sent).toContain(PASSING);
    expect(sent).toBe(`${String(last(handler.mock.calls)[0].details.input)}\n\n${MARKER}: ${BENIGN}`);
    // Each of ops's call records holds the text that call was sent, the instructions included.
    expect(outcome.agentCalls.filter((c) => c.agent === 'ops').map((c) => c.input)).toEqual(opsRequests().map(userText));
  });
});

/**
 * Two statements the check matches only at the end of the text it reads: an
 * `rm -rf .`, and a `DELETE FROM` with nothing after the table. The check reads
 * its texts as JSON, where a line break inside a text is escaped, so once the
 * strategy writes more after one of them it no longer ends the text read.
 */
const TASK_ENDING_IN_RM = 'Tidy the build logs, then clear the workspace with rm -rf .';
const TASK_ENDING_IN_DELETE = 'Tidy the build logs, then empty the table: DELETE FROM sessions;';
const OUTPUT_ENDING_IN_DELETE = 'Then empty the table: DELETE FROM sessions;';
/** The statement at the end of an output, with a space after it: still the end of that output. */
const OUTPUT_ENDING_IN_DELETE_AND_SPACE = 'Then empty the table: DELETE FROM sessions; ';
const REVIEW_APPROVED = JSON.stringify({ approved: true, feedback: 'Fine.' });

/**
 * The paths where the strategy writes more text after the task, or after an
 * earlier agent's output, in the input ops receives, with one of those
 * statements at the end of that task or output, and how the run ends once ops
 * is refused.
 */
const TAIL_CASES: Array<{
  name: string;
  strategy: string;
  agents: Json;
  extra?: Json;
  prompt: string;
  statement: string;
  script: Record<string, string[]>;
  run: (team: Team, prompt: string) => Promise<Outcome>;
  refused: Outcome;
}> = [
  {
    // After the first agent, sequential writes the previous agent's output after the task.
    name: "sequential generate(), the task in the second agent's input",
    strategy: 'sequential',
    agents: { research: { instructions: RESEARCH }, ops: { instructions: OPS } },
    prompt: TASK_ENDING_IN_DELETE,
    statement: 'DELETE FROM sessions;',
    script: { research: [PASSING], ops: ['ops done'] },
    run: generated,
    // ops is skipped, so research's result is the run's.
    refused: { text: PASSING, agentCalls: [{ agent: 'research' }] },
  },
  {
    name: "sequential stream(), the task in the second agent's input",
    strategy: 'sequential',
    agents: { research: { instructions: RESEARCH }, ops: { instructions: OPS } },
    prompt: TASK_ENDING_IN_DELETE,
    statement: 'DELETE FROM sessions;',
    script: { research: [PASSING], ops: ['ops done'] },
    run: streamed,
    refused: { text: PASSING, agentCalls: [{ agent: 'research' }] },
  },
  {
    name: 'graph generate(), the task',
    strategy: 'graph',
    agents: { research: { instructions: RESEARCH }, ops: { instructions: OPS, dependsOn: ['research'] } },
    prompt: TASK_ENDING_IN_RM,
    statement: 'rm -rf .',
    script: { research: [PASSING], ops: ['ops done'] },
    run: generated,
    refused: { text: PASSING, agentCalls: [{ agent: 'research' }] },
  },
  {
    name: "graph generate(), the first of two dependencies' outputs",
    strategy: 'graph',
    agents: {
      research: { instructions: RESEARCH },
      writer: { instructions: WRITER, dependsOn: ['research'] },
      ops: { instructions: OPS, dependsOn: ['research', 'writer'] },
    },
    prompt: PROMPT,
    statement: OUTPUT_ENDING_IN_DELETE,
    script: { research: [OUTPUT_ENDING_IN_DELETE], writer: [PASSING], ops: ['ops done'] },
    run: generated,
    refused: { text: PASSING, agentCalls: [{ agent: 'research' }, { agent: 'writer' }] },
  },
  {
    name: 'graph stream(), the task',
    strategy: 'graph',
    agents: { research: { instructions: RESEARCH }, ops: { instructions: OPS, dependsOn: ['research'] } },
    prompt: TASK_ENDING_IN_RM,
    statement: 'rm -rf .',
    script: { research: [PASSING], ops: ['ops done'] },
    run: streamed,
    refused: { text: PASSING, agentCalls: [{ agent: 'research' }] },
  },
  {
    name: "graph stream(), the first of two dependencies' outputs",
    strategy: 'graph',
    agents: {
      research: { instructions: RESEARCH },
      writer: { instructions: WRITER, dependsOn: ['research'] },
      ops: { instructions: OPS, dependsOn: ['research', 'writer'] },
    },
    prompt: PROMPT,
    statement: OUTPUT_ENDING_IN_DELETE,
    script: { research: [OUTPUT_ENDING_IN_DELETE], writer: [PASSING], ops: ['ops done'] },
    run: streamed,
    // stream() joins the text the agents that ran streamed.
    refused: { text: `${OUTPUT_ENDING_IN_DELETE}${PASSING}`, agentCalls: [{ agent: 'research' }, { agent: 'writer' }] },
  },
  {
    name: "graph generate(), the first of two dependencies' outputs, a space after the statement",
    strategy: 'graph',
    agents: {
      research: { instructions: RESEARCH },
      writer: { instructions: WRITER, dependsOn: ['research'] },
      ops: { instructions: OPS, dependsOn: ['research', 'writer'] },
    },
    prompt: PROMPT,
    statement: OUTPUT_ENDING_IN_DELETE_AND_SPACE,
    script: { research: [OUTPUT_ENDING_IN_DELETE_AND_SPACE], writer: [PASSING], ops: ['ops done'] },
    run: generated,
    refused: { text: PASSING, agentCalls: [{ agent: 'research' }, { agent: 'writer' }] },
  },
  {
    name: "review-loop, the reviewer's input: the task",
    strategy: 'review-loop',
    agents: { writer: { instructions: WRITER }, ops: { instructions: OPS } },
    prompt: TASK_ENDING_IN_RM,
    statement: 'rm -rf .',
    script: { writer: [PASSING], ops: [REVIEW_APPROVED] },
    run: generated,
    refused: { text: PASSING, agentCalls: [{ agent: 'writer' }] },
  },
  {
    name: "review-loop, the reviewer's input: the draft",
    strategy: 'review-loop',
    agents: { writer: { instructions: WRITER }, ops: { instructions: OPS } },
    prompt: PROMPT,
    statement: OUTPUT_ENDING_IN_DELETE,
    script: { writer: [OUTPUT_ENDING_IN_DELETE], ops: [REVIEW_APPROVED] },
    run: generated,
    refused: { text: OUTPUT_ENDING_IN_DELETE, agentCalls: [{ agent: 'writer' }] },
  },
  {
    name: "review-loop, the producer's input in the next round: the reviewer's feedback",
    strategy: 'review-loop',
    agents: { ops: { instructions: OPS }, editor: { instructions: EDITOR } },
    prompt: PROMPT,
    statement: OUTPUT_ENDING_IN_DELETE,
    script: {
      ops: ['First draft.', 'Second draft.'],
      editor: [JSON.stringify({ approved: false, feedback: OUTPUT_ENDING_IN_DELETE }), REVIEW_APPROVED],
    },
    run: generated,
    refused: { text: 'First draft.', agentCalls: [{ agent: 'ops' }, { agent: 'editor' }] },
  },
  {
    name: 'debate, the task',
    strategy: 'debate',
    agents: { pro: { instructions: PRO }, ops: { instructions: OPS } },
    extra: { maxRounds: 1 },
    prompt: TASK_ENDING_IN_RM,
    statement: 'rm -rf .',
    script: { pro: [PASSING], ops: ['I disagree.'], judge: [VERDICT] },
    run: generated,
    refused: { text: VERDICT, agentCalls: [{ agent: 'pro' }] },
  },
  {
    name: 'debate, an earlier argument',
    strategy: 'debate',
    agents: { pro: { instructions: PRO }, ops: { instructions: OPS } },
    extra: { maxRounds: 1 },
    prompt: PROMPT,
    statement: OUTPUT_ENDING_IN_DELETE,
    script: { pro: [OUTPUT_ENDING_IN_DELETE], ops: ['I disagree.'], judge: [VERDICT] },
    run: generated,
    refused: { text: VERDICT, agentCalls: [{ agent: 'pro' }] },
  },
];

describe.each(TAIL_CASES)('the beforeAgent check under $name', ({ strategy, agents, extra, prompt, statement, script, run, refused }) => {
  it('reads that task or output on its own, so the statement at its end is blocked and never reaches ops', async () => {
    serve(script);
    const handler = approve();
    const guardrailHitlOverride = vi.fn();
    const outcome = await run(team(strategy, agents, handler, { guardrailHitlOverride }, extra), prompt);

    expect(guardrailHitlOverride).toHaveBeenCalledTimes(1);
    expect(guardrailHitlOverride).toHaveBeenCalledWith(expect.objectContaining({ guardrailId: 'code-safety', toolName: 'agent:ops' }));
    // The approver was shown the input ops would receive: the statement, with the strategy's text after it.
    const shown = String(last(handler.mock.calls)[0].details.input);
    expect(shown).toContain(statement);
    expect(shown.trimEnd().endsWith(statement)).toBe(false);
    expect(opsRequests().filter((b) => userText(b).includes(statement))).toHaveLength(0);
    expect(opsRequests()).toHaveLength(refused.agentCalls.filter((c) => c.agent === 'ops').length);
    expect(outcome.text).toBe(refused.text);
    expect(outcome.agentCalls.map((c) => c.agent)).toEqual(refused.agentCalls.map((c) => c.agent));
  });
});
