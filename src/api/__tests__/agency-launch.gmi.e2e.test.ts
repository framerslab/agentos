/**
 * launch_agency on gmi(), end to end: a gmi() agent with agencies.launch launches a temporary agency() team from
 * inside a turn and gets one tool result, under the launch's bounds, budget, deadline, tool set and approval gate. The
 * real gmi(), agency(), its strategies, the launch engine, the provider manager, completion gateway, GMI and tool
 * orchestrator run; only the provider classes are stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent } from '../agent';
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { getCapabilitySupport } from '../runtime/capabilityContract';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-launch-${++n}`;
type SeenCall = { messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> };
/** The system prompt a model call sent: the text of its system messages. */
const systemText = (call: SeenCall): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
/** The text of a model call's last user message. */
const lastUserText = (call: SeenCall): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};
/** The tool names a model call offered. */
const offered = (call: SeenCall): string[] =>
  ((call.options.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((tool) => tool.function.name);
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id = 'l1') => reply.tools([{ id, name: 'launch_agency', args }]);
/** The output of a send's `i`-th tool call: a launch that started. */
const launchOf = (result: GenerateTextResult, i = 0): LaunchAgencyResult => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe('launch_agency');
  expect(call?.error).toBeUndefined();
  return call.result as LaunchAgencyResult;
};
/** The refusal code of a send's `i`-th tool call (its error reads `<code>: <reason>`). */
const refusalOf = (result: GenerateTextResult, i: number): string => String(result.toolCalls[i]?.error ?? '').split(':')[0];
/** The parent's route, under a key of its own; no fallback, so a failed hop ends the turn. */
const route = (k: string) => ({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] });

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('launch_agency on gmi()', () => {
  it("a gmi() agent with agencies.launch launches a sequential two-seat team and gets one tool result with both seats' text", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Write a haiku about rain.', seats: [{ role: 'drafter', instructions: 'Draft a haiku.' }, { role: 'editor', instructions: 'Edit the draft.' }] }),
        reply.text('Rain taps the window.'),
        reply.text('Soft rain on the glass.'),
        reply.text('Here is the haiku.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate writers.', agencies: { launch: true } });

    const result = await parent.session('p1').send('Get me a haiku.');
    expect(result.text).toBe('Here is the haiku.');
    expect(offered(s.seen[0])).toContain('launch_agency');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'Soft rain on the glass.', truncated: false });
    expect(out.reason).toBeUndefined();
    expect(out.seats.map((r) => [r.role, r.form, r.status, r.calls, r.summary])).toEqual([
      ['drafter', 'temporary', 'completed', 1, 'Rain taps the window.'],
      ['editor', 'temporary', 'completed', 1, 'Soft rain on the glass.'],
    ]);
    expect(out.seats.map((r) => r.usage.totalTokens)).toEqual([15, 15]);
    expect(out.usage.totalTokens).toBe(30);
    expect(out.provenance).toMatchObject({ strategy: 'sequential', depth: 1, parentSessionId: 'p1' });
    // Each seat is a GMI of its own instructions, and the editor's input holds the drafter's output.
    expect(systemText(s.seen[1])).toContain('Draft a haiku.');
    expect(systemText(s.seen[2])).toContain('Edit the draft.');
    expect(lastUserText(s.seen[2])).toContain('Rain taps the window.');
    // The parent's next step sees the result.
    expect(JSON.stringify(s.seen[3].messages)).toContain('Soft rain on the glass.');
    expect(s.seen).toHaveLength(4);
  });

  it('invalid arguments are a tool error, never a throw, and the parent turn finishes', async () => {
    const k = key();
    const seat = (role: string) => ({ role, instructions: `Be the ${role}.` });
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'a', name: 'launch_agency', args: { goal: 'x', seats: [seat('writer'), seat('writer')] } },
          { id: 'b', name: 'launch_agency', args: { goal: 'x', strategy: 'review-loop', seats: [seat('a'), seat('b'), seat('c')] } },
          { id: 'c', name: 'launch_agency', args: { goal: 'x', seats: [seat('r'.repeat(53))] } },
          { id: 'd', name: 'launch_agency', args: { goal: 'x', seats: [seat('writer')], colour: 'blue' } },
          { id: 'e', name: 'launch_agency', args: { goal: 'x', seats: ['a', 'b', 'c', 'd', 'e', 'f'].map((role) => seat(role)) } },
        ]),
        reply.text('No team ran.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, maxSeats: 5 } });

    const result = await parent.session('p1').send('Try.');
    // The schema sets no maxItems and no additionalProperties: counts and unknown keys are the engine's, with its codes.
    expect([0, 1, 2, 3, 4].map((i) => refusalOf(result, i))).toEqual(['invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'too_many_seats']);
    expect(result.toolCalls[2].error).toContain('52 characters');
    expect(result.toolCalls[3].error).toContain("unknown argument 'colour'");
    // No seat ran: the parent's two steps are the only model calls, and the turn finished.
    expect(s.seen).toHaveLength(2);
    expect(result.text).toBe('No team ran.');
  });

  it('with agencies.launch off the tool is not on the table; a legacy agent() refuses launch and warns about agencies; the contract row', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Off.'), reply.text('On.')] });
    const search = { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: async () => 'hit' };
    const off = gmi({ ...route(k), instructions: 'Answer.', tools: { search }, agencies: { maxDepth: 3 } });
    await off.session('a').send('Hi.');
    // The table is offered (the precondition), without launch_agency.
    expect(offered(s.seen[0])).toEqual(['search']);
    const on = gmi({ ...route(k), instructions: 'Answer.', tools: { search }, agencies: { launch: true } });
    await on.session('b').send('Hi.');
    expect([...offered(s.seen[1])].sort()).toEqual(['launch_agency', 'search']);
    // A bound outside its range fails at construction, launch on or off.
    expect(() => gmi({ ...route(k), agencies: { maxDepth: 9 } })).toThrow('agencies.maxDepth');

    // A legacy agent() has no GMI tool loop to run launch_agency in, so it refuses launch at construction;
    // the other fields it accepts and applies nowhere, and its one warning says where they apply.
    expect(() => agent({ provider: 'openai', model: 'stub-model', apiKey: k, agencies: { launch: true } })).toThrow('agencies.launch runs on the GMI path');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    agent({ provider: 'openai', model: 'stub-model', apiKey: k, agencies: { maxDepth: 3 } });
    expect(warn).toHaveBeenCalledTimes(1);
    const legacyWarning = String(warn.mock.calls[0]?.[0]);
    expect(legacyWarning).toContain("agent() launches teams only with runtime: 'gmi'");
    // Not among the fields the warning sends to the full runtime or agency(): only a GMI launches teams.
    expect(legacyWarning).not.toMatch(/requires the full AgentOS runtime[^.]*agencies/);
    // gmi() enforces it: the warning that names the fields it defers (rag here, the precondition) leaves it out.
    warn.mockClear();
    gmi({ ...route(k), agencies: { launch: true }, rag: { topK: 3 } });
    const gmiWarning = warn.mock.calls.map(([message]) => String(message)).join('\n');
    expect(gmiWarning).toContain('gmi() accepted config it does not enforce yet: rag.');
    expect(gmiWarning).not.toContain('agencies');
    expect(getCapabilitySupport('gmi', 'agencies')).toBe('enforced');
    expect(getCapabilitySupport('runtime', 'agencies')).toBe('enforced');
    expect(getCapabilitySupport('agent', 'agencies')).toBe('accepted_but_deferred');
    expect(getCapabilitySupport('generation', 'agencies')).toBe('runtime_only');
  });

  it('allowlists the parent cannot give are refused before any seat runs; a member named without them takes its seat as itself', async () => {
    const k = key();
    const tool = (name: string) => ({ description: `The ${name} tool.`, parameters: { type: 'object', properties: {} }, execute: async () => name });
    const s = script('openai', k, {
      replies: [
        reply.tools([
          // maxDepth 1: a level-1 seat cannot launch.
          { id: 'a', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['launch_agency'] }] } },
          // The parent has no web_fetch.
          { id: 'b', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['web_fetch'] }] } },
          // memory_add is the parent's, and never a seat's in this release.
          { id: 'c', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['memory_add'] }] } },
          { id: 'd', name: 'launch_agency', args: { goal: 'Check 2 + 2.', seats: [{ role: 'checker', agentKey: 'tutor', brief: 'Check the sum.' }] } },
        ]),
        reply.text('2 + 2 is 4.'),
        reply.text('Checked.'),
        reply.text('Hello.'),
      ],
    });
    const tutor = gmi({ ...route(k), name: 'Tutor', instructions: 'You are the maths tutor.', tools: { memory_add: tool('memory_add') } });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { search: tool('search'), memory_add: tool('memory_add') },
      agencies: { launch: true, maxDepth: 1, members: { tutor } },
    });

    const result = await parent.session('p1').send('Check the sum.');
    expect([0, 1, 2].map((i) => refusalOf(result, i))).toEqual(['tool_not_allowed', 'unknown_tool', 'tool_not_allowed']);
    expect(result.toolCalls[2].error).toContain('a memory tool');
    // The fourth launch ran, so a seat call is reachable: the member's turn is the one seat call the stub saw.
    expect(launchOf(result, 3).seats).toMatchObject([{ role: 'checker', form: 'persistent', member: 'tutor', status: 'completed', summary: '2 + 2 is 4.' }]);
    expect(s.seen).toHaveLength(3);
    expect(systemText(s.seen[1])).toContain('You are the maths tutor.');
    expect(lastUserText(s.seen[1])).toContain('Your role in this team: checker. Check the sum.');
    // The schema offers the member form, since the agent lists members.
    expect(JSON.stringify(s.seen[0].options.tools)).toContain('agentKey');
    // The seat names no tools, so the member's seat call offers none of its own: its memory_add stays out of the team.
    expect(offered(s.seen[1])).toEqual([]);
    // The launch closed the seat's session alone: the member still serves its own sessions, with its own tools.
    await tutor.session('t1').send('Hi.');
    expect(offered(s.seen[3])).toEqual(['memory_add']);
  });
});
