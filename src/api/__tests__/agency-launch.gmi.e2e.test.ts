/**
 * launch_agency on gmi(), end to end: a gmi() agent with agencies.launch launches a temporary agency() team from
 * inside a turn and gets one tool result, under the launch's bounds, budget, deadline, tool set and approval gate. The
 * real gmi(), agency(), its strategies, the launch engine, the provider manager, completion gateway, GMI and tool
 * orchestrator run; only the provider classes are stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agency } from '../agency';
import { agent } from '../agent';
import type { AgentOSConfig } from '../AgentOS';
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import { launchRegistry } from '../runtime/agencyLaunch/launchRegistry';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { getCapabilitySupport } from '../runtime/capabilityContract';
import { SpendBudget } from '../runtime/spendBudget';
import type { AgencyCallbacks, Agent, AgentEndEvent, AgentStartEvent, ApprovalDecision, ApprovalRequest } from '../types';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { ITool } from '../../core/tools/ITool';

let n = 0;
const key = () => `k-launch-${++n}`;
type SeenCall = { messages: Array<{ role: string; content: unknown }>; options: Record<string, unknown> };
/** What an agent's on.error receives. */
type HostErrorEvent = Parameters<NonNullable<AgencyCallbacks['error']>>[0];
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
/** `reply.tools`, reporting `totalTokens` of usage. */
const toolsCosting = (calls: Parameters<typeof reply.tools>[0], totalTokens: number) =>
  reply.tools(calls).map((chunk) => ('usage' in chunk ? { ...chunk, usage: { promptTokens: totalTokens - 50, completionTokens: 50, totalTokens } } : chunk));
/** `reply.text`, reporting `totalTokens` of usage. */
const textCosting = (text: string, totalTokens: number) => reply.text(text, 'stub-model', { promptTokens: totalTokens - 50, completionTokens: 50, totalTokens });
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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  it("a temporary seat's calls carry the launching agent's prompt-cache setting, as they carry the rest of its route", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [launchStep({ goal: 'Answer.', seats: [{ role: 'answerer', instructions: 'Answer.' }] }), reply.text('Answered.'), reply.text('Done.')],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, cache: { ttl: '1h' }, agencies: { launch: true } });

    const result = await parent.session('p1').send('Go.');
    expect(launchOf(result)).toMatchObject({ status: 'completed', text: 'Answered.' });
    // The agent's own call carries the setting (the precondition); its seat's call carries it with the route's maxTokens.
    expect(s.seen[0].options.cache).toEqual({ ttl: '1h' });
    expect(s.seen[1].options).toMatchObject({ maxTokens: 1_000, cache: { ttl: '1h' } });
    expect(s.seen).toHaveLength(3);
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
    // The full runtime's AgentOSConfig declares agencies, so the contract enforces the field there. A config that drops
    // the option fails the type check on this line.
    const runtimeTakesAgencies: 'agencies' extends keyof AgentOSConfig ? true : false = true;
    expect(getCapabilitySupport('runtime', 'agencies')).toBe(runtimeTakesAgencies ? 'enforced' : 'accepted_but_deferred');
    expect(getCapabilitySupport('agent', 'agencies')).toBe('accepted_but_deferred');
    expect(getCapabilitySupport('generation', 'agencies')).toBe('runtime_only');
  });

  it('allowlists the parent or the member cannot give, and an agentKey the agent does not list, are refused before any seat runs; a listed member takes its seat as itself', async () => {
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
          // search is the parent's and not the member's: a member's seat uses only its own tools.
          { id: 'e', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['search'] }] } },
          // A key the agent does not list, here a name every object inherits.
          { id: 'f', name: 'launch_agency', args: { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'toString' }] } },
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
    // A session of the member's own, open before the launch.
    const ownSession = tutor.session('t1');

    const result = await parent.session('p1').send('Check the sum.');
    expect([0, 1, 2].map((i) => refusalOf(result, i))).toEqual(['tool_not_allowed', 'unknown_tool', 'tool_not_allowed']);
    expect(result.toolCalls[2].error).toContain('a memory tool');
    // The fourth launch ran, so a seat call is reachable: the member's turn is the one seat call the stub saw.
    expect(launchOf(result, 3).seats).toMatchObject([{ role: 'checker', form: 'persistent', member: 'tutor', status: 'completed', summary: '2 + 2 is 4.' }]);
    expect([4, 5].map((i) => refusalOf(result, i))).toEqual(['unknown_tool', 'unknown_member']);
    expect(result.toolCalls[4].error).toContain("the member 'tutor' has no tool 'search'");
    expect(s.seen).toHaveLength(3);
    expect(systemText(s.seen[1])).toContain('You are the maths tutor.');
    expect(lastUserText(s.seen[1])).toContain('Your role in this team: checker. Check the sum.');
    // The schema offers the member form, since the agent lists members.
    expect(JSON.stringify(s.seen[0].options.tools)).toContain('agentKey');
    // The description names the member form and the one-seat form.
    const described = (s.seen[0].options.tools as Array<{ function: { name: string; description?: string } }>).find((t) => t.function.name === 'launch_agency')?.function.description ?? '';
    expect(described).toContain('a member you seat as itself by agentKey (tutor)');
    expect(described).toContain('One seat makes a subagent.');
    // And that a member's seat names only tools the member has too: the launch that gave the tutor search was refused.
    expect(described).toContain("A member's seat may name only tools the member also has.");
    expect(JSON.stringify(s.seen[0].options.tools)).toContain('for a member, only those it also has');
    // The seat names no tools, so the member's seat call offers none of its own: its memory_add stays out of the team.
    expect(offered(s.seen[1])).toEqual([]);
    // The launch never closes the member: its own session, open since before the launch, still answers, offering the
    // member's own tools (closing the member would have closed that session, and its send would reject).
    await expect(ownSession.send('Hi.')).resolves.toMatchObject({ text: 'Hello.' });
    expect(offered(s.seen[3])).toEqual(['memory_add']);
  });

  it('a member put in the agencies.members record after the agent is built is never seated', async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [reply.tools([{ id: 'a', name: 'launch_agency', args: { goal: 'Help.', seats: [{ role: 'helper', agentKey: 'helper' }] } }]), reply.text('No team ran.')],
    });
    // The late member is a legacy agent, which the construction check refuses: its session runs every tool it has,
    // with no seat's names and no gate. Its own key, so any call it made would show on its own script.
    const k2 = key();
    const late = script('openai', k2, { whole: true, replies: [reply.tools([{ id: 'x', name: 'wipe', args: {} }]), reply.text('Wiped.')] });
    const wipe = vi.fn(async () => 'wiped');
    const members: Record<string, Agent> = {};
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, members } });
    members.helper = agent({ ...route(k2), instructions: 'Help.', tools: { wipe: { description: 'Wipes the store.', parameters: { type: 'object', properties: {} }, execute: wipe } } });

    const result = await parent.session('p1').send('Get help.');
    // The record is read when the agent is built, as the check reads it: a key added later names no member.
    expect(refusalOf(result, 0)).toBe('unknown_member');
    expect(late.seen).toHaveLength(0);
    expect(wipe).not.toHaveBeenCalled();
    expect(s.seen).toHaveLength(2);
    // The table was built from the same record: it offers no member form.
    expect(JSON.stringify(s.seen[0].options.tools)).not.toContain('agentKey');
  });

  it('a turn at the deepest level cannot launch, and its frame reaches its tools', async () => {
    const k = key();
    const frames: unknown[] = [];
    // ITools, so `execute` receives the call's context.
    const note = (record: boolean): ITool => ({
      id: 'note-v1', name: 'note', displayName: 'Note', description: 'Note something.',
      inputSchema: { type: 'object', properties: {} }, hasSideEffects: false,
      execute: async (_args, context) => {
        if (record) frames.push(context.sessionData?.agencyLaunch);
        return { success: true, output: 'noted' };
      },
    });
    const s = script('openai', k, {
      replies: [
        // The root's step: a level-1 team whose lead may note and launch.
        launchStep({ goal: 'Check the claim.', seats: [{ role: 'lead', instructions: 'Lead the check.', tools: ['note', 'launch_agency'] }] }),
        // The lead's step: a level-2 team whose member may launch (refused under maxDepth 2), then one whose member may note.
        reply.tools([
          { id: 'x', name: 'launch_agency', args: { goal: 'Verify.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['launch_agency'] }] } },
          { id: 'y', name: 'launch_agency', args: { goal: 'Verify.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['note'] }] } },
        ]),
        // The member's level-2 turn: it notes, and calls launch_agency, which its own table has and its seat does not.
        reply.tools([{ id: 'n', name: 'note', args: {} }, { id: 'z', name: 'launch_agency', args: { goal: 'Deeper.', seats: [{ role: 'deep', instructions: 'Go deeper.' }] } }]),
        reply.text('Verified.'),
        reply.text('Lead done.'),
        reply.text('All done.'),
      ],
    });
    const tutor = gmi({ ...route(k), name: 'Tutor', instructions: 'You are the tutor.', tools: { note: note(true) }, agencies: { launch: true } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', tools: { note: note(false) }, agencies: { launch: true, maxDepth: 2, members: { tutor } } });

    const result = await parent.session('p1').send('Check it.');
    expect(launchOf(result).status).toBe('completed');
    // The calls: root, lead, the member's two steps, lead, root.
    expect(s.seen).toHaveLength(6);
    expect(systemText(s.seen[2])).toContain('You are the tutor.');
    // The lead's first launch was refused: a level-2 seat cannot launch under maxDepth 2.
    expect(JSON.stringify(s.seen[4].messages)).toContain('tool_not_allowed');
    // The member's level-2 turn: launch_agency is not offered, and its call is skipped.
    expect(offered(s.seen[2])).toEqual(['note']);
    expect(JSON.stringify(s.seen[3].messages)).toContain('not available in this seat');
    // The frame reached the member's tool: the level-2 team, the seat's role.
    expect(frames).toEqual([expect.objectContaining({ role: 'checker', depth: 2 })]);
  });

  it("a nested launch is bounded by its seat's names, not by its member's own table", async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Scout.', seats: [{ role: 'scout', agentKey: 'scout', tools: ['launch_agency'] }] }),
        // The member's seat turn: a team that asks for search, a tool of the member's own table but not of its seat.
        launchStep({ goal: 'Find.', seats: [{ role: 'finder', instructions: 'Find.', tools: ['search'] }] }, 'n1'),
        reply.text('Could not.'),
        reply.text('Scouted.'),
      ],
    });
    const scout = gmi({
      ...route(k), name: 'Scout', instructions: 'You scout.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: search } },
      agencies: { launch: true },
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, members: { scout } } });

    const result = await parent.session('p1').send('Scout it.');
    expect(launchOf(result).status).toBe('completed');
    // The member's turn ran (the precondition) and its launch was refused: its seat's names hold launch_agency alone.
    expect(systemText(s.seen[1])).toContain('You scout.');
    expect(JSON.stringify(s.seen[2].messages)).toContain('unknown_tool');
    // No finder seat ran: root, the member's two steps, root.
    expect(s.seen).toHaveLength(4);
    expect(search).not.toHaveBeenCalled();
  });

  it('a tool cannot change the frame a later call of its turn is handed', async () => {
    const k = key();
    // The launch the frame named once the tool had tried to point it at another.
    const after: unknown[] = [];
    const tamper: ITool = {
      id: 'tamper-v1', name: 'tamper', displayName: 'Tamper', description: 'Point the launch frame elsewhere.',
      inputSchema: { type: 'object', properties: {} }, hasSideEffects: false,
      execute: async (_args, context) => {
        const frame = context.sessionData?.agencyLaunch as { launchId: string } | undefined;
        try {
          if (frame) frame.launchId = 'agency-gone';
        } catch {
          // A frozen frame refuses the write.
        }
        after.push(frame?.launchId);
        return { success: true, output: 'tried' };
      },
    };
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Scout.', seats: [{ role: 'scout', agentKey: 'scout', tools: ['tamper', 'launch_agency'] }] }),
        // The member's seat turn: the tool rewrites its frame, then a team that asks for a tool the seat lacks.
        reply.tools([
          { id: 't', name: 'tamper', args: {} },
          { id: 'n1', name: 'launch_agency', args: { goal: 'Find.', seats: [{ role: 'finder', instructions: 'Find.', tools: ['search'] }] } },
        ]),
        reply.text('Could not.'),
        reply.text('Scouted.'),
      ],
    });
    const search = { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: async () => 'found' };
    const scout = gmi({ ...route(k), name: 'Scout', instructions: 'You scout.', tools: { tamper, search }, agencies: { launch: true } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', tools: { tamper }, agencies: { launch: true, members: { scout } } });

    const result = await parent.session('p1').send('Scout it.');
    const launch = launchOf(result);
    expect(launch.status).toBe('completed');
    // The tool ran in the member's seat turn (the precondition), and the frame it was handed still names the scout's team.
    expect(after).toEqual([launch.agencyId]);
    // The launch after it nested under that team, whose seat's names refused search; a frame that named no running
    // launch would have answered parent_launch_closed.
    const seatStep = JSON.stringify(s.seen[2].messages);
    expect(seatStep).toContain('unknown_tool');
    expect(seatStep).not.toContain('parent_launch_closed');
    expect(s.seen).toHaveLength(4);
  });

  it('the deadline returns timed_out with what the seats produced, and the parent turn goes on', async () => {
    const k = key();
    const never = new Promise<void>(() => undefined);
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Draft and edit.', deadlineMs: 1_000, seats: [{ role: 'drafter', instructions: 'Draft.' }, { role: 'editor', instructions: 'Edit.' }] }),
        reply.text('A draft.'),
        // The editor's request holds until it is aborted.
        reply.hold([], never),
        reply.text('Partial work.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true } });

    const started = Date.now();
    const result = await parent.session('p1').send('Go.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'timed_out', reason: 'the deadline of 1000 ms passed' });
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['drafter', 'completed'], ['editor', 'cut']]);
    expect(out.seats[0].summary).toBe('A draft.');
    expect(s.aborts).toBe(1);
    // Within the deadline and one grace, the settle wait and the close sharing it.
    expect(Date.now() - started).toBeLessThan(1_000 + 5_000);
    expect(result.text).toBe('Partial work.');
  }, 20_000);

  it('a launch while an earlier one of its scope is closing is concurrency_exceeded until its seats are released', async () => {
    const k = key();
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = vi.fn(async () => {
      await hanging;
      return 'done';
    });
    const oneSeat = { goal: 'Answer.', seats: [{ role: 'second', instructions: 'Answer.' }] };
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Wait.', deadlineMs: 1_000, seats: [{ role: 'waiter', instructions: 'Call hang.', tools: ['hang'] }] }),
        // The waiter's tool runs past the deadline and the grace.
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        launchStep(oneSeat, 'l2'),
        reply.text('Waited.'),
        launchStep(oneSeat, 'l3'),
        reply.text('Answered.'),
        reply.text('Now it ran.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: { hang: { description: 'Hangs.', parameters: { type: 'object', properties: {} }, execute: hang } },
      agencies: { launch: true },
    });
    const session = parent.session('p1');

    const first = await session.send('Start.');
    const timedOut = launchOf(first, 0);
    expect(timedOut.status).toBe('timed_out');
    expect(launchRegistry.get(timedOut.agencyId)?.state).toBe('closing');
    // The closing launch still counts toward the session's one launch in flight.
    expect(refusalOf(first, 1)).toBe('concurrency_exceeded');
    // Another agent's session of the same id is a scope of its own: it launches while this one is closing.
    const k2 = key();
    script('openai', k2, { replies: [launchStep(oneSeat, 'o1'), reply.text('Answered.'), reply.text('Ran.')] });
    const other = gmi({ ...route(k2), instructions: 'Coordinate.', agencies: { launch: true } });
    expect(launchOf(await other.session('p1').send('Go.')).status).toBe('completed');
    release();
    await vi.waitFor(() => expect(launchRegistry.get(timedOut.agencyId)).toBeUndefined(), { timeout: 10_000 });
    const second = await session.send('Again.');
    expect(launchOf(second).status).toBe('completed');
    expect(hang).toHaveBeenCalledTimes(1);
    // Root (three steps), the waiter, root, the second team's seat, root: nothing was sent for the waiter after its tool.
    expect(s.seen).toHaveLength(7);
  }, 40_000);

  it('a session that keeps no history counts its closing launch toward its next turn', async () => {
    const k = key();
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = vi.fn(async () => {
      await hanging;
      return 'done';
    });
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Wait.', deadlineMs: 1_000, seats: [{ role: 'waiter', instructions: 'Call hang.', tools: ['hang'] }] }),
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('Waited.'),
        // The next send runs on a GMI of its own (history: false), in the same session.
        launchStep({ goal: 'Answer.', seats: [{ role: 'second', instructions: 'Answer.' }] }, 'l2'),
        reply.text('Refused.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.', history: false,
      tools: { hang: { description: 'Hangs.', parameters: { type: 'object', properties: {} }, execute: hang } },
      agencies: { launch: true },
    });
    const session = parent.session('p1');

    const timedOut = launchOf(await session.send('Start.'));
    expect(launchRegistry.get(timedOut.agencyId)?.state).toBe('closing');
    // The closing launch still counts toward the session's one launch in flight, from the next turn's GMI too.
    expect(refusalOf(await session.send('Again.'), 0)).toBe('concurrency_exceeded');
    release();
    await vi.waitFor(() => expect(launchRegistry.get(timedOut.agencyId)).toBeUndefined(), { timeout: 10_000 });
    expect(hang).toHaveBeenCalledTimes(1);
    // The first send's root, waiter and root steps, the second's two root steps: nothing was sent for the waiter after its tool.
    expect(s.seen).toHaveLength(5);
  }, 40_000);

  it('a tool already running at the deadline finishes, and nothing starts after it', async () => {
    const k = key();
    const effects: string[] = [];
    const slowWrite = vi.fn(async () => {
      await sleep(1_500);
      effects.push('written');
      return 'written';
    });
    const note = vi.fn(async () => {
      effects.push('noted');
      return 'noted';
    });
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Write, then note.', deadlineMs: 1_000, seats: [{ role: 'writer', instructions: 'Write, then note.', tools: ['slow_write', 'note'] }] }),
        // The writer's step: slow_write runs past the 1,000 ms deadline; note comes after it in the same step.
        reply.tools([{ id: 'w1', name: 'slow_write', args: {} }, { id: 'n1', name: 'note', args: {} }]),
        reply.text('Parent done.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: {
        slow_write: { description: 'Writes slowly.', parameters: { type: 'object', properties: {} }, execute: slowWrite },
        note: { description: 'Notes.', parameters: { type: 'object', properties: {} }, execute: note },
      },
      agencies: { launch: true },
    });

    const result = await parent.session('p1').send('Go.');
    expect(launchOf(result).status).toBe('timed_out');
    // The running tool finished once (the precondition); the call after it never started.
    expect(effects).toEqual(['written']);
    expect(note).not.toHaveBeenCalled();
    // Nothing was sent for the writer after its tools: root, writer, root.
    expect(s.seen).toHaveLength(3);
  }, 20_000);

  it('a tool whose approval arrives after the deadline is refused before it runs', async () => {
    const k = key();
    const sendEmail = vi.fn(async () => 'sent');
    const asked: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(request.action);
      // Approved after the 1,000 ms deadline.
      await sleep(1_500);
      return { approved: true };
    };
    script('openai', k, {
      replies: [
        launchStep({ goal: 'Send it.', deadlineMs: 1_000, seats: [{ role: 'sender', instructions: 'Send the mail.', tools: ['send_email'] }] }),
        reply.tools([{ id: 'e1', name: 'send_email', args: { to: 'team' } }]),
        reply.text('Parent done.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: { send_email: { description: 'Sends an email.', parameters: { type: 'object', properties: { to: { type: 'string' } } }, execute: sendEmail } },
      agencies: { launch: true, hitl: { approvals: { beforeTool: ['send_email'] }, handler } },
    });

    const result = await parent.session('p1').send('Go.');
    expect(launchOf(result).status).toBe('timed_out');
    // The approval was asked (the precondition), and the call it approved was refused: its turn had stopped.
    expect(asked).toEqual(['send_email']);
    expect(sendEmail).not.toHaveBeenCalled();
  }, 20_000);

  it('a tool call the seat reaches after the deadline runs no hook and asks no approver', async () => {
    const k = key();
    const asked: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(request.action);
      return { approved: true };
    };
    const hooked: string[] = [];
    const slowWrite = vi.fn(async () => {
      await sleep(1_500);
      return 'written';
    });
    const note = vi.fn(async () => 'noted');
    script('openai', k, {
      replies: [
        launchStep({ goal: 'Write, then note.', deadlineMs: 1_000, seats: [{ role: 'writer', instructions: 'Write, then note.', tools: ['slow_write', 'note'] }] }),
        // The writer's step: slow_write runs past the 1,000 ms deadline; note comes after it in the same step.
        reply.tools([{ id: 'w1', name: 'slow_write', args: {} }, { id: 'n1', name: 'note', args: {} }]),
        reply.text('Parent done.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: {
        slow_write: { description: 'Writes slowly.', parameters: { type: 'object', properties: {} }, execute: slowWrite },
        note: { description: 'Notes.', parameters: { type: 'object', properties: {} }, execute: note },
      },
      // The parent's hook runs on its own calls and on every seat's.
      onBeforeToolExecution: async (call) => {
        hooked.push(call.name);
        return call;
      },
      agencies: { launch: true, hitl: { approvals: { beforeTool: ['slow_write', 'note'] }, handler } },
    });

    const result = await parent.session('p1').send('Go.');
    expect(launchOf(result).status).toBe('timed_out');
    // Before the deadline the hook ran and the approver was asked (the precondition); the call the seat reached after
    // it was refused with neither, and never ran.
    expect(slowWrite).toHaveBeenCalledOnce();
    expect(asked).toEqual(['slow_write']);
    expect(hooked).toEqual(['launch_agency', 'slow_write']);
    expect(note).not.toHaveBeenCalled();
  }, 20_000);

  it("a launch draws on the parent's budget", async () => {
    const k = key();
    const twoSeats = { goal: 'Two parts.', seats: [{ role: 'first', instructions: 'Part one.' }, { role: 'second', instructions: 'Part two.' }] };
    const s = script('openai', k, {
      replies: [
        toolsCosting([{ id: 'l1', name: 'launch_agency', args: twoSeats }], 6_000),
        textCosting('Part one done.', 6_000),
        reply.text('Partial.'),
      ],
    });
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 20_000, unpriced: 'allow' });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 2_000, budget, agencies: { launch: true } });

    const out = launchOf(await parent.session('p1').send('Go.'));
    expect(out.status).toBe('budget_exhausted');
    // The parent's step (6,000) was recorded before its tool ran: the child's cap is half of the 14,000 left.
    expect(out.provenance.budget.maxTotalTokens).toBe(7_000);
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['first', 'completed'], ['second', 'cut']]);
    // The launch's own cap refused the second seat's call before its request: the 6,000 tokens the launch had used and
    // the call's estimate, at least its 2,000 output tokens, would pass the 7,000. The stub saw the parent's two steps
    // and the first seat's call.
    expect(out.reason).toMatch(/^the launch's budget refused a call: \d+ tokens would pass 7000$/);
    expect(Number(out.reason?.match(/(\d+) tokens/)?.[1])).toBeGreaterThanOrEqual(8_000);
    expect(out.provenance.budget.tokensUsed).toBe(6_000);
    expect(s.seen).toHaveLength(3);
    // The parent's budget holds its own two steps (6,000 and 15 tokens) and the first seat's 6,000.
    expect(budget.tokensUsed()).toBe(12_015);
  });

  it('a parent with no budget draws on the launch pool, and the one-call floor counts its output cap', async () => {
    const twoSeats = { goal: 'Two parts.', seats: [{ role: 'first', instructions: 'Part one.' }, { role: 'second', instructions: 'Part two.' }] };
    const k = key();
    const s = script('openai', k, { replies: [launchStep(twoSeats), textCosting('Part one done.', 2_500), reply.text('Partial.')] });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 3_000 } });
    const out = launchOf(await parent.session('p1').send('Go.'));
    expect(out.status).toBe('budget_exhausted');
    expect(out.provenance.budget.maxTotalTokens).toBe(3_000);
    expect(out.seats.map((r) => r.status)).toEqual(['completed', 'cut']);
    // The pool refused the second seat's call before its request: the 2,500 tokens the first used and the call's
    // estimate, at least its 1,000 output tokens, would pass the pool's 3,000. The stub saw root, first, root.
    expect(out.reason).toMatch(/^a budget the team draws on refused a call: \d+ tokens would pass 3000$/);
    expect(Number(out.reason?.match(/(\d+) tokens/)?.[1])).toBeGreaterThanOrEqual(3_500);
    expect(out.provenance.budget.tokensUsed).toBe(2_500);
    expect(s.seen).toHaveLength(3);

    // 2,500 cannot cover one call: 2,000 for the prompt and the route's 1,000 output tokens.
    const k2 = key();
    const s2 = script('openai', k2, { replies: [launchStep(twoSeats), reply.text('No team.')] });
    const poor = gmi({ ...route(k2), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 2_500 } });
    const refused = await poor.session('p2').send('Go.');
    expect(refusalOf(refused, 0)).toBe('budget_unavailable');
    expect(refused.toolCalls[0].error).toBe("budget_unavailable: the launch's token cap, 2500, cannot cover one call (3000: 2000 for the prompt and 1000 for the output)");
    expect(s2.seen).toHaveLength(2);
  });

  it("the one-call floor holds the route's maxTokens to the output ceiling of the model the agent resolved", async () => {
    const oneSeat = { goal: 'Answer.', seats: [{ role: 'answerer', instructions: 'Answer.' }] };
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'c1', name: 'launch_agency', args: { ...oneSeat, maxTokens: 18_000 } },
          { id: 'c2', name: 'launch_agency', args: oneSeat },
        ]),
        reply.text('Answered.'),
        reply.text('Done.'),
      ],
    });
    // No model named: the agent runs on OpenAI's default, gpt-4o, which writes at most 16,384 tokens a call, so each
    // seat's own check counts the 32,000 as 16,384.
    const parent = gmi({ provider: 'openai', apiKey: k, fallbackProviders: [], instructions: 'Coordinate.', maxTokens: 32_000, agencies: { launch: true, maxLaunchTokens: 20_000 } });

    const result = await parent.session('p1').send('Go.');
    // 18,000 cannot cover one call: 2,000 for the prompt and the 16,384 a call of the route writes at most.
    expect(refusalOf(result, 0)).toBe('budget_unavailable');
    expect(result.toolCalls[0].error).toBe("budget_unavailable: the launch's token cap, 18000, cannot cover one call (18384: 2000 for the prompt and 16384 for the output)");
    // The pool's 20,000 can, and the seat runs on the agent's route with its maxTokens: root, the seat, root.
    expect(launchOf(result, 1)).toMatchObject({ status: 'completed', text: 'Answered.' });
    expect(s.seen.map((call) => call.modelId)).toEqual(['gpt-4o', 'gpt-4o', 'gpt-4o']);
    expect(s.seen[1].options.maxTokens).toBe(32_000);
    expect(result.text).toBe('Done.');
  });

  it("a member's launch from its seat is floored on the member's own route, which its team's seats run on", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        // The root's step: the member takes the team's one seat, and may launch from it.
        launchStep({ goal: 'Plan the trip.', seats: [{ role: 'lead', agentKey: 'planner', tools: ['launch_agency'] }] }),
        // The member's seat turn: a team of one under a 5,000-token cap, whose seat the member builds on its own route,
        // at 8,000 output tokens a call.
        launchStep({ goal: 'Draft the plan.', maxTokens: 5_000, seats: [{ role: 'drafter', instructions: 'Draft the plan.' }] }, 'n1'),
        reply.text('No team.'),
        reply.text('Planned.'),
      ],
    });
    const planner = gmi({ ...route(k), name: 'Planner', instructions: 'You plan trips.', maxTokens: 8_000, agencies: { launch: true } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, members: { planner } } });

    const result = await parent.session('p1').send('Plan a trip.');
    expect(launchOf(result).status).toBe('completed');
    // The member's seat turn ran (the precondition), and its launch was refused before a seat was built: 5,000 covers
    // one call of the root's route, but not one of the member's (2,000 for the prompt and its 8,000 output tokens).
    expect(systemText(s.seen[1])).toContain('You plan trips.');
    const memberStep = JSON.stringify(s.seen[2].messages);
    expect(memberStep).toContain('(10000: 2000 for the prompt and 8000 for the output)');
    expect(memberStep).toContain('budget_unavailable');
    // Root, the member's two steps, root: no drafter call.
    expect(s.seen).toHaveLength(4);
    expect(result.text).toBe('Planned.');
  });

  it("a launch of persistent members is floored on the largest call its seats make, each on its member's own route", async () => {
    const k = key();
    const kb = key();
    const kw = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'c1', name: 'launch_agency', args: { goal: 'Answer.', maxTokens: 5_000, seats: [{ role: 'answerer', agentKey: 'brief' }] } },
          {
            id: 'c2',
            name: 'launch_agency',
            args: { goal: 'Answer.', maxTokens: 18_000, seats: [{ role: 'answerer', agentKey: 'brief' }, { role: 'expander', agentKey: 'wordy' }] },
          },
          { id: 'c3', name: 'launch_agency', args: { goal: 'Expand.', maxTokens: 20_000, seats: [{ role: 'expander', agentKey: 'wordy' }] } },
        ]),
        reply.text('Done.'),
      ],
    });
    const briefCalls = script('openai', kb, { replies: [reply.text('Short answer.')] });
    const wordyCalls = script('openai', kw, { replies: [reply.text('A long answer.')] });
    // A member's seat calls run on its own route and maxTokens: 1,000 on stub-model, and 32,000 on OpenAI's default,
    // gpt-4o, which writes at most 16,384 tokens a call. The launching agent's own route counts 32,000.
    const brief = gmi({ ...route(kb), instructions: 'Answer briefly.', maxTokens: 1_000 });
    const wordy = gmi({ provider: 'openai', apiKey: kw, fallbackProviders: [], instructions: 'Answer at length.', maxTokens: 32_000 });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 32_000, agencies: { launch: true, members: { brief, wordy } } });

    const result = await parent.session('p1').send('Go.');
    // 5,000 covers one call of the brief member's (2,000 for the prompt and its 1,000 output tokens), though not one of
    // the launching agent's route: the member's seat runs, at its own maxTokens.
    expect(launchOf(result, 0)).toMatchObject({ status: 'completed', text: 'Short answer.' });
    expect(briefCalls.seen).toHaveLength(1);
    expect(briefCalls.seen[0].options.maxTokens).toBe(1_000);
    // 18,000 cannot cover one call of the wordy member's, the largest its team makes: refused before a seat is built,
    // so the brief member is not called again.
    expect(refusalOf(result, 1)).toBe('budget_unavailable');
    expect(result.toolCalls[1].error).toBe("budget_unavailable: the launch's token cap, 18000, cannot cover one call (18384: 2000 for the prompt and 16384 for the output)");
    // 20,000 can: the wordy member's seat runs on gpt-4o with its 32,000.
    expect(launchOf(result, 2)).toMatchObject({ status: 'completed', text: 'A long answer.' });
    expect(wordyCalls.seen.map((call) => call.modelId)).toEqual(['gpt-4o']);
    expect(wordyCalls.seen[0].options.maxTokens).toBe(32_000);
    expect(briefCalls.seen).toHaveLength(1);
    expect(s.seen).toHaveLength(2);
    expect(result.text).toBe('Done.');
  });

  it('a member whose calls take their cap from controls.maxTotalTokens is floored on that cap', async () => {
    const k = key();
    const kl = key();
    const ks = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'c1', name: 'launch_agency', args: { goal: 'Answer.', maxTokens: 7_000, seats: [{ role: 'answerer', agentKey: 'long' }] } },
          { id: 'c2', name: 'launch_agency', args: { goal: 'Answer.', maxTokens: 5_000, seats: [{ role: 'answerer', agentKey: 'short' }] } },
        ]),
        reply.text('Done.'),
      ],
    });
    const longCalls = script('openai', kl, { replies: [reply.text('A long answer.')] });
    const shortCalls = script('openai', ks, { replies: [reply.text('Short answer.')] });
    // Neither member sets maxTokens: each call a member makes is sent with its controls.maxTotalTokens as its cap.
    const long = gmi({ ...route(kl), instructions: 'Answer at length.', controls: { maxTotalTokens: 8_000 } });
    const short = gmi({ ...route(ks), instructions: 'Answer briefly.', controls: { maxTotalTokens: 1_000 } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, members: { long, short } } });

    const result = await parent.session('p1').send('Go.');
    // 7,000 cannot cover one call of the long member's: 2,000 for the prompt and the 8,000 its calls are sent with.
    // Refused before a seat is built, so the member is never called.
    expect(refusalOf(result, 0)).toBe('budget_unavailable');
    expect(result.toolCalls[0].error).toBe("budget_unavailable: the launch's token cap, 7000, cannot cover one call (10000: 2000 for the prompt and 8000 for the output)");
    expect(longCalls.seen).toHaveLength(0);
    // 5,000 covers one call of the short member's (2,000 for the prompt and its 1,000): its seat runs, at that cap.
    expect(launchOf(result, 1)).toMatchObject({ status: 'completed', text: 'Short answer.' });
    expect(shortCalls.seen).toHaveLength(1);
    expect(shortCalls.seen[0].options.maxTokens).toBe(1_000);
    expect(s.seen).toHaveLength(2);
    expect(result.text).toBe('Done.');
  });

  it('the root launches of one turn share one pool, and the next turn launches from a fresh one', async () => {
    const k = key();
    const oneSeat = (role: string) => ({ goal: `Do the ${role} part.`, seats: [{ role, instructions: `Do the ${role} part.` }] });
    const s = script('openai', k, {
      replies: [
        // Two launches in one step: the first spends 5,000 of the pool's 6,000.
        reply.tools([{ id: 'a', name: 'launch_agency', args: oneSeat('first') }, { id: 'b', name: 'launch_agency', args: oneSeat('second') }]),
        textCosting('First done.', 5_000),
        // The turn's next step launches again, from the same pool.
        launchStep(oneSeat('third'), 'c'),
        reply.text('One of three ran.'),
        launchStep(oneSeat('fourth')),
        textCosting('Fourth done.', 5_000),
        reply.text('Ran again.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 6_000 } });
    const session = parent.session('p1');

    const first = await session.send('Go.');
    expect(launchOf(first, 0)).toMatchObject({ status: 'completed', text: 'First done.' });
    // The 1,000 left cannot cover one call, 2,000 for the prompt and 1,000 for the output, in the same step or the next.
    const unavailable = "budget_unavailable: the launch's token cap, 1000, cannot cover one call (3000: 2000 for the prompt and 1000 for the output)";
    expect(first.toolCalls.map((call) => call.error)).toEqual([undefined, unavailable, unavailable]);
    expect(first.text).toBe('One of three ran.');
    // The next turn draws on a pool of its own: its launch has the whole 6,000.
    const second = await session.send('Go again.');
    const out = launchOf(second);
    expect(out).toMatchObject({ status: 'completed', text: 'Fourth done.' });
    expect(out.provenance.budget).toMatchObject({ maxTotalTokens: 6_000, tokensUsed: 5_000 });
    expect(second.text).toBe('Ran again.');
    // The first turn's three steps and its one seat, then the second turn's two steps and its seat: the refused
    // launches built no seat.
    expect(s.seen).toHaveLength(7);
  });

  it('the gate the parent carries governs the seats', async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const asked: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(request.action);
      return { approved: false, reason: 'search is paused' };
    };
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Look it up.', seats: [{ role: 'finder', instructions: 'Find it.', tools: ['search'] }] }),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.text('Search held.'),
        reply.text('Team done.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: search } },
      agencies: { launch: true },
    });
    // The parent is a member of a host agency whose rejecting handler covers search.
    const host = agency({ provider: 'openai', model: 'stub-model', apiKey: k, strategy: 'sequential', hitl: { approvals: { beforeTool: ['search'] }, handler }, agents: { coordinator: parent } });

    const result = await host.generate('Find x.');
    expect(result.text).toBe('Team done.');
    // The seat was offered search and called it (the precondition).
    expect(systemText(s.seen[1])).toContain('Find it.');
    expect(offered(s.seen[1])).toEqual(['search']);
    // The launched seat's search was asked once, by the host's handler, and did not run; the seat's next step was told why.
    expect(asked).toEqual(['search']);
    expect(search).not.toHaveBeenCalled();
    expect(JSON.stringify(s.seen[2].messages)).toContain('search is paused');
    // The host's one call record is the parent's, and its one tool call is the launch, which completed with the seat's answer.
    expect(result.agentCalls.map((call) => call.agent)).toEqual(['coordinator']);
    expect(result.agentCalls[0].toolCalls.map((call) => [call.name, call.error])).toEqual([['launch_agency', undefined]]);
    expect(result.agentCalls[0].toolCalls[0].result).toMatchObject({ status: 'completed', text: 'Search held.' });
    // Root, the seat's two steps, root.
    expect(s.seen).toHaveLength(4);

    // With agencies.hitl of its own, the parent's team asks the gate the parent carries first, and that gate's refusal
    // is final: the host approves the seat's first search and refuses its second.
    const k2 = key();
    const ran: string[] = [];
    const order: string[] = [];
    let hostAsks = 0;
    const s2 = script('openai', k2, {
      replies: [
        launchStep({ goal: 'Look up x, then y.', seats: [{ role: 'finder', instructions: 'Find them.', tools: ['search'] }] }),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.tools([{ id: 's2', name: 'search', args: { q: 'y' } }]),
        reply.text('Found x.'),
        reply.text('Team done.'),
      ],
    });
    const gated = gmi({
      ...route(k2), instructions: 'Coordinate.',
      tools: {
        search: {
          description: 'Search.',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          execute: async (args: { q?: string }) => {
            ran.push(String(args.q));
            return 'found';
          },
        },
      },
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['search'] },
          handler: async (request) => {
            order.push(`own ${request.action}`);
            return { approved: true };
          },
        },
      },
    });
    const host2 = agency({
      provider: 'openai', model: 'stub-model', apiKey: k2, strategy: 'sequential',
      hitl: {
        approvals: { beforeTool: ['search'] },
        handler: async (request) => {
          order.push(`host ${request.action}`);
          hostAsks += 1;
          return hostAsks === 1 ? { approved: true } : { approved: false, reason: 'search is paused' };
        },
      },
      agents: { coordinator: gated },
    });

    const composed = await host2.generate('Find x and y.');
    expect(composed.agentCalls[0].toolCalls.map((call) => [call.name, call.error])).toEqual([['launch_agency', undefined]]);
    expect(composed.agentCalls[0].toolCalls[0].result).toMatchObject({ status: 'completed', text: 'Found x.' });
    // The host's handler is asked first, the parent's own only after the host approved, and the host's refusal ends the
    // second search before the parent's handler is asked.
    expect(order).toEqual(['host search', 'own search', 'host search']);
    expect(ran).toEqual(['x']);
    expect(JSON.stringify(s2.seen[3].messages)).toContain('search is paused');
    // Root, the seat's three steps, root.
    expect(s2.seen).toHaveLength(5);
    expect(composed.text).toBe('Team done.');
  });

  it("agencies.hitl and the host's callbacks see a launched team, and a level-2 seat is asked once", async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const asked: string[] = [];
    const askedBy: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(request.action);
      askedBy.push(request.agent);
      return { approved: true };
    };
    const agentStart = vi.fn<(e: AgentStartEvent) => void>();
    const agentEnd = vi.fn<(e: AgentEndEvent) => void>();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Plan the search.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['search', 'launch_agency'] }] }),
        launchStep({ goal: 'Search.', seats: [{ role: 'finder', instructions: 'Find.', tools: ['search'] }] }, 'n1'),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.text('Found.'),
        reply.text('Lead done.'),
        reply.text('All done.'),
      ],
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: search } },
      on: { agentStart, agentEnd },
      agencies: { launch: true, hitl: { approvals: { beforeTool: ['search'] }, handler } },
    });

    const result = await parent.session('p1').send('Search for x.');
    const out = launchOf(result);
    expect(out.status).toBe('completed');
    expect(result.text).toBe('All done.');
    // Root, the lead, the finder's two steps, the lead, root: the finder was offered search and called it (the precondition).
    expect(s.seen).toHaveLength(6);
    expect(systemText(s.seen[2])).toContain('Find.');
    expect(offered(s.seen[2])).toEqual(['search']);
    // The level-2 seat's search ran once and was asked once: the nested launch passes the gate it received, uncomposed.
    expect(search).toHaveBeenCalledTimes(1);
    expect(asked).toEqual(['search']);
    // The gate that asked is that of the team the parent launched; the level-2 team, with no hitl of its own, passed it on.
    expect(askedBy).toEqual([`launch:${out.agencyId}`]);
    // The parent's callbacks see the team it launched, by its name.
    expect(agentStart).toHaveBeenCalledWith(expect.objectContaining({ agent: `launch:${out.agencyId}` }));
    expect(agentEnd).toHaveBeenCalledWith(expect.objectContaining({ agent: `launch:${out.agencyId}` }));
    // They carry its goal and its answer, and see the team its lead launched through the parent's own tool, inside it.
    const nested = agentStart.mock.calls[1]?.[0].agent;
    expect(nested).toMatch(/^launch:agency-/);
    expect(nested).not.toBe(`launch:${out.agencyId}`);
    expect(agentStart.mock.calls.map(([e]) => [e.agent, e.input])).toEqual([[`launch:${out.agencyId}`, 'Plan the search.'], [nested, 'Search.']]);
    expect(agentEnd.mock.calls.map(([e]) => [e.agent, e.output])).toEqual([[nested, 'Found.'], [`launch:${out.agencyId}`, 'Lead done.']]);
  });

  it("the parent's tool hook governs every seat, a member's included, and a temporary seat takes its generation hooks and request timeout", async () => {
    const k = key();
    const memberSend = vi.fn(async () => 'sent');
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Email the team.', seats: [{ role: 'mailer', agentKey: 'mailer', tools: ['send_email'] }, { role: 'writer', instructions: 'Write the note.' }] }),
        reply.tools([{ id: 'e1', name: 'send_email', args: { to: 'team' } }]),
        reply.text('Mail held.'),
        reply.text('Note written.'),
        reply.text('Done.'),
      ],
    });
    const emailTool = (execute: () => Promise<string>) => ({ description: 'Sends an email.', parameters: { type: 'object', properties: { to: { type: 'string' } } }, execute });
    const mailer = gmi({
      ...route(k), name: 'Mailer', instructions: 'You send mail.',
      tools: { send_email: emailTool(memberSend) },
      // The member's own hook allows every call.
      onBeforeToolExecution: async (info) => info,
    });
    const parent = gmi({
      ...route(k), instructions: 'Coordinate.',
      tools: { send_email: emailTool(async () => 'parent sent') },
      // The parent's hook skips every email, its seats' included.
      onBeforeToolExecution: async (info) => (info.name === 'send_email' ? null : info),
      onBeforeGeneration: async (context) => ({ ...context, messages: [...context.messages, { role: 'system', content: 'Policy: no customer names.' }] }),
      onAfterGeneration: async (step) => ({ ...step, text: step.text.replace('Note', 'Memo') }),
      controls: { maxDurationMs: 45_000 },
      agencies: { launch: true, members: { mailer } },
    });

    const result = await parent.session('p1').send('Send it.');
    const out = launchOf(result);
    expect(out.status).toBe('completed');
    expect(result.text).toBe('Done.');
    // Root, the member's two steps, the writer, root.
    expect(s.seen).toHaveLength(5);
    // The member's send_email was offered and called (the precondition), and the parent's hook skipped it.
    expect(offered(s.seen[1])).toEqual(['send_email']);
    expect(JSON.stringify(s.seen[2].messages)).toContain('Skipped by onBeforeToolExecution hook');
    expect(memberSend).not.toHaveBeenCalled();
    // The temporary seat's request carries the parent's onBeforeGeneration rewrite.
    expect(systemText(s.seen[3])).toContain('Write the note.');
    expect(systemText(s.seen[3])).toContain('Policy: no customer names.');
    // Its answer, the team's, carries the parent's onAfterGeneration rewrite.
    expect(out.text).toBe('Memo written.');
    // It is sent with the parent's request timeout, as the parent's own calls are.
    expect(s.seen[0].options.requestTimeout).toBe(45_000);
    expect(s.seen[3].options.requestTimeout).toBe(45_000);
  });

  it("a failed seat's message reaches neither the coordinator nor the result", async () => {
    const k = key();
    const canary = 'sk-CANARY-4242';
    const onError = vi.fn<(event: HostErrorEvent) => void>();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Check the claim.', strategy: 'hierarchical', seats: [{ role: 'checker', instructions: 'Check claims.' }] }),
        // The manager delegates to the checker.
        reply.tools([{ id: 'd1', name: 'delegate_to_checker', args: { task: 'Check it.' } }]),
        // The checker's request fails with a message that holds a credential.
        Object.assign(new Error(`upstream refused key ${canary}`), { name: 'ProviderError', code: 'E_UPSTREAM' }),
        reply.text('The checker could not run.'),
        reply.text('Reported.'),
      ],
      // The manager runs on agent()'s path, which asks for whole responses; the GMIs stream.
      whole: true,
    });
    const on = { error: onError };
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', on, agencies: { launch: true } });

    const result = await parent.session('p1').send('Check it.');
    expect(result.text).toBe('Reported.');
    const out = launchOf(result);
    // Root, the manager, the checker's failed request, the manager, root.
    expect(s.seen.map((call) => call.streamed)).toEqual([true, false, true, false, true]);
    expect(systemText(s.seen[2])).toContain('Check claims.');
    // The manager's request after the failed delegation names the seat's error by name and code (the precondition).
    const afterDelegation = JSON.stringify(s.seen[3].messages);
    expect(afterDelegation).toContain('GMIError (LLM_PROVIDER_ERROR)');
    expect(afterDelegation).not.toContain(canary);
    expect(out).toMatchObject({ status: 'completed', text: 'The checker could not run.' });
    expect(out.seats).toMatchObject([{ role: 'checker', status: 'failed', calls: 1, error: { name: 'GMIError', code: 'LLM_PROVIDER_ERROR' } }]);
    expect(JSON.stringify(out)).not.toContain(canary);
    // The parent's next step reads the result, with no word of the message.
    expect(JSON.stringify(s.seen[4].messages)).not.toContain(canary);
    // The manager's calls are the coordinator's: charged to its sub-budget, which the launch's budget counts.
    expect(out.coordinatorUsage.totalTokens).toBeGreaterThan(0);
    expect(out.provenance.budget.tokensUsed).toBeGreaterThanOrEqual(out.coordinatorUsage.totalTokens);
    // The host receives the original error, once, under the seat's name, with its callbacks object as `this`, as
    // agency() calls them.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.contexts[0]).toBe(on);
    const [event] = onError.mock.calls[0];
    expect(event).toMatchObject({ agent: 'launch_agency seat checker', error: { name: 'GMIError', code: 'LLM_PROVIDER_ERROR' } });
    expect(event.error.message).toContain(canary);
  });

  it('an error callback that throws or rejects fails no launch, and the error it was handed goes to the console', async () => {
    const k = key();
    const canary = 'sk-CANARY-5151';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Check the claim.', seats: [{ role: 'checker', instructions: 'Check claims.' }] }),
        // The checker's request fails, and with it the sequential team.
        Object.assign(new Error(`upstream refused key ${canary}`), { name: 'ProviderError', code: 'E_UPSTREAM' }),
        reply.text('The team failed.'),
      ],
    });
    const thrown = new Error('the error callback broke');
    const rejected = new Error('the error callback rejected');
    // The seat's report throws; every other report rejects.
    const onError = vi.fn((event: HostErrorEvent): void | Promise<void> => {
      if (event.agent === 'launch_agency seat checker') throw thrown;
      return Promise.reject(rejected);
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', on: { error: onError }, agencies: { launch: true } });

    const result = await parent.session('p1').send('Check it.');
    // What the callback did failed neither the launch nor the parent's turn.
    expect(result.text).toBe('The team failed.');
    expect(s.seen).toHaveLength(3);
    const out = launchOf(result);
    expect(out.status).toBe('failed');
    expect(out.seats).toMatchObject([{ role: 'checker', status: 'failed', error: { name: 'GMIError', code: 'LLM_PROVIDER_ERROR' } }]);
    // The launch reported the seat's failure, whose callback threw, and the run's, whose callback rejected (the precondition).
    expect(onError.mock.calls.map(([event]) => event.agent).filter((agent) => agent.startsWith('launch_agency'))).toEqual(['launch_agency seat checker', 'launch_agency run']);
    // The console received each callback's failure and the error the callback was handed: the seat's original, and the
    // run's, which carries the seat's error by name and code.
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), rejected));
    expect(warn).toHaveBeenCalledWith(expect.any(String), thrown);
    const logged = warn.mock.calls.map(([, value]) => value).filter((value): value is Error => value instanceof Error);
    expect(logged.some((error) => error.message.includes(canary))).toBe(true);
    expect(logged.some((error) => error.message === 'GMIError (LLM_PROVIDER_ERROR)')).toBe(true);
  });
});
