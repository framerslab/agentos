/**
 * agency() with GMI seats, end to end: the agency-level runtime, seat metadata on pre-built seats, and
 * sessionSeat(), which seats a persistent gmi() agent as itself. The real agency(), its strategies, agent(),
 * gmi(), provider manager, completion gateway, GMI and tool orchestrator run; only the provider classes are
 * stubbed (helpers/stubProviders.ts), at their module boundary.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agency } from '../agency';
import { agent, type AgentOptions } from '../agent';
import { gmi } from '../gmi';
import { AgencyConfigError } from '../types';
import type { ApprovalDecision, ApprovalRequest } from '../types';
import { SpendBudget } from '../runtime/spendBudget';
import { buildSessionSeat, sessionSeat } from '../runtime/agencyLaunch/sessionSeat';
import { seatMetadataOf } from '../runtime/strategies/shared';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-seats-${++n}`;
/** The system prompt a model call sent: the text of its system messages. */
const systemText = (call: { messages: Array<{ role: string; content: unknown }> }): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
/** The text of a model call's last user message. */
const lastUserText = (call: { messages: Array<{ role: string; content: unknown }> }): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agency() seats served by GMIs', () => {
  it("agency({ runtime: 'gmi' }) serves every config seat with a GMI, and a seat's runtime: 'legacy' wins", async () => {
    const k = key();
    // `whole` lets agent()'s legacy path ask for a whole response; a GMI streams every call.
    const s = script('openai', k, { replies: [reply.text('Notes.'), reply.text('Summary.')], whole: true });
    const team = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      strategy: 'sequential',
      runtime: 'gmi',
      agents: {
        researcher: { instructions: 'Research.' },
        writer: { runtime: 'legacy', instructions: 'Write.' },
      },
    });

    const result = (await team.generate('Find sources.')) as { text: string };
    expect(result.text).toBe('Summary.');
    expect(s.seen.map((call) => call.streamed)).toEqual([true, false]);
    expect(systemText(s.seen[0])).toContain('Research.');

    expect(() => agency({ provider: 'openai', model: 'stub-model', apiKey: k, runtime: 'fast' as 'gmi', agents: { a: { instructions: 'x' } } })).toThrow(AgencyConfigError);
  });

  it("a pre-built seat's description reaches the manager and its dependsOn orders the graph", async () => {
    // The manager of a hierarchical agency reads a pre-built seat's description into its roster.
    const k1 = key();
    const s1 = script('openai', k1, { replies: [reply.text('Nothing to delegate.')], whole: true });
    const checker = Object.assign(agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k1, instructions: 'Check.' }), {
      description: 'Checks facts against sources.',
    });
    const managed = agency({ provider: 'openai', model: 'stub-model', apiKey: k1, strategy: 'hierarchical', agents: { checker } });
    await managed.generate('Check the claim.');
    expect(systemText(s1.seen[0])).toContain('- checker: Checks facts against sources.');

    // A pre-built seat's dependsOn selects the graph strategy and orders the run: `b` waits for `a`, though the
    // roster lists `b` first, and receives `a`'s output as a dependency.
    const k2 = key();
    const s2 = script('openai', k2, { replies: [reply.text('Fact A.'), reply.text('Report B.')] });
    const seat = (instructions: string) => agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k2, instructions });
    const b = Object.assign(seat('Report.'), { dependsOn: ['a'] });
    const a = seat('Find a fact.');
    const graphTeam = agency({ provider: 'openai', model: 'stub-model', apiKey: k2, agents: { b, a } });
    const result = (await graphTeam.generate('Write the report.')) as { agentCalls: Array<{ agent: string; input: string }> };
    expect(result.agentCalls.map((call) => call.agent)).toEqual(['a', 'b']);
    expect(lastUserText(s2.seen[1])).toContain('Outputs from dependencies:');
    expect(lastUserText(s2.seen[1])).toContain('[a]:\nFact A.');
  });

  it('sessionSeat refuses a legacy agent and a tool the member lacks, and a seat whose id the member has open', async () => {
    const k = key();
    script('openai', k, { replies: [] });
    const legacy = agent({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'x' });
    expect(() => sessionSeat(legacy)).toThrow(TypeError);
    expect(() => sessionSeat(legacy)).toThrow('gmi() agent');
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Tutor.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: async () => 'hit' } },
    });
    expect(() => sessionSeat(member, { tools: ['send_email'] })).toThrow(TypeError);
    expect(() => sessionSeat(member, { tools: ['send_email'] })).toThrow("'send_email'");
    // The member serves a session under the id the seat would take: the seat's first call rejects, naming it.
    member.session('seat:lesson-1');
    const seat = sessionSeat(member, { sessionId: 'lesson-1' });
    await expect(seat.generate('Hi.')).rejects.toThrow(TypeError);
    await expect(seat.generate('Hi.')).rejects.toThrow("'seat:lesson-1'");
  });

  it('sessionSeat refuses the working-memory tools, which are memory tools', async () => {
    // The member keeps persistent notes through the package's two working-memory tools; nothing here reads or writes the file.
    const { MarkdownWorkingMemory } = await import('../../cognition/memory/core/working/MarkdownWorkingMemory');
    const { ReadWorkingMemoryTool } = await import('../../cognition/memory/core/working/ReadWorkingMemoryTool');
    const { UpdateWorkingMemoryTool } = await import('../../cognition/memory/core/working/UpdateWorkingMemoryTool');
    const notes = new MarkdownWorkingMemory('seat-notes.md');
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: key(), instructions: 'Keep notes.',
      tools: { read_working_memory: new ReadWorkingMemoryTool(notes), update_working_memory: new UpdateWorkingMemoryTool(notes) },
    });
    // The member has both tools, so each refusal names a memory tool, not a tool the member lacks.
    for (const name of ['read_working_memory', 'update_working_memory']) {
      expect(() => sessionSeat(member, { tools: [name] }), name).toThrow(TypeError);
      expect(() => sessionSeat(member, { tools: [name] }), name).toThrow(`'${name}' is a memory tool`);
    }
  });

  it('sessionSeat runs the member as itself, in one session for the run', async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'd1', name: 'delegate_to_tutor', args: { task: 'Explain recursion.' } }]),
        reply.text('Recursion calls itself.'),
        reply.tools([{ id: 'd2', name: 'delegate_to_tutor', args: { task: 'Give an example.' } }]),
        reply.text('factorial(n) calls factorial(n - 1).'),
        reply.text('Done.'),
        reply.text('Hello again.'),
      ],
      whole: true,
    });
    const member = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, name: 'Tutor', instructions: 'You are the tutor. Explain clearly.' });
    const seat = sessionSeat(member);
    const team = agency({ provider: 'openai', model: 'stub-model', apiKey: k, strategy: 'hierarchical', agents: { tutor: seat } });

    const result = (await team.generate('Teach recursion.')) as { text: string };
    expect(result.text).toBe('Done.');
    // The manager (agent()'s legacy path) asks for whole responses; the member's GMI streams.
    const tutorCalls = s.seen.filter((call) => call.streamed);
    expect(tutorCalls).toHaveLength(2);
    for (const call of tutorCalls) expect(systemText(call)).toContain('You are the tutor. Explain clearly.');
    // One session for the run: the second delegation's request holds the first exchange.
    const second = JSON.stringify(tutorCalls[1].messages);
    expect(second).toContain('Explain recursion.');
    expect(second).toContain('Recursion calls itself.');
    // The manager reads the member's own description.
    expect(systemText(s.seen[0])).toContain('- tutor: You are the tutor. Explain clearly.');

    await team.close();
    // The seat session's tally went with it; the agent's tally holds its usage, read before the member's own session
    // adds any.
    expect((await member.usage(seat.seatId)).totalTokens).toBe(0);
    const seatTokens = seat.record().usage.totalTokens;
    expect(seatTokens).toBeGreaterThan(0);
    expect((await member.usage()).totalTokens).toBe(seatTokens);
    await expect(seat.generate('Again.')).rejects.toThrow('seat closed');
    // agency().close() closed the seat's session and left the member serving its own users.
    await expect(member.session('own').send('Hello?')).resolves.toMatchObject({ text: 'Hello again.' });
  });

  it('a persistent member in a seat recalls nothing of its caller and files nothing under the caller', async () => {
    const k = key();
    const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('I cannot say.'), reply.text('I recall the locker.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], instructions: 'Help.',
      cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false } as never,
      tools: { memory_add: { description: 'Add a memory.', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' } },
    });

    // The caller tells the member something in its own session.
    await member.session('mine', { userId: 'u1' }).send('My locker code is CANARY-ONE-7731.');
    // A seat that runs as the caller (a launch's seat names the parent turn's user).
    const seat = buildSessionSeat(member, { form: 'persistent', role: 'helper', userId: 'u1' });
    await seat.generate('Remember: the vault word is CANARY-TWO-4410. What is my locker code?');
    expect(JSON.stringify(s.seen[1].messages)).not.toContain('CANARY-ONE-7731');
    // The caller's next session recalls its own words (the precondition) and nothing the seat was told.
    await member.session('mine-2', { userId: 'u1' }).send('Which locker code and vault word do you remember?');
    const recalled = JSON.stringify(s.seen[2].messages);
    expect(recalled).toContain('CANARY-ONE-7731');
    expect(recalled).not.toContain('CANARY-TWO-4410');

    // A memory tool never runs in a seat.
    expect(() => sessionSeat(member, { tools: ['memory_add'] })).toThrow(TypeError);
    expect(() => sessionSeat(member, { tools: ['memory_add'] })).toThrow("'memory_add'");

    // A member with a memory provider: no getContext and no observe on a seat turn.
    const k2 = key();
    script('openai', k2, { replies: [reply.text('Seat answer.'), reply.text('Own answer.')] });
    const getContext = vi.fn(async (_text: string) => ({ contextText: 'FROM PROVIDER' }));
    const observe = vi.fn(async (_role: string, _text: string) => undefined);
    const withProvider = gmi({ provider: 'openai', model: 'stub-model', apiKey: k2, instructions: 'Help.', memoryProvider: { getContext, observe } });
    await buildSessionSeat(withProvider, { form: 'persistent', role: 'helper', userId: 'u1' }).generate('The word is CANARY-THREE-9020.');
    await withProvider.session('own', { userId: 'u1' }).send('Own words.');
    // The provider is wired: the member's own turn reaches it.
    await vi.waitFor(() => expect(observe).toHaveBeenCalledWith('user', 'Own words.'));
    expect(getContext.mock.calls.some(([text]) => text.includes('CANARY-THREE'))).toBe(false);
    expect(observe.mock.calls.some(([, text]) => text.includes('CANARY-THREE'))).toBe(false);
  });

  it("a sessionSeat streams under the agency's gate, budget and names", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'c1', name: 'send_email', args: { to: 'team' } }, { id: 'c2', name: 'search', args: { q: 'x' } }]),
        reply.text('Mail held.'),
      ],
    });
    const sendEmail = vi.fn(async () => 'sent');
    const search = vi.fn(async () => 'found');
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Send mail.',
      tools: {
        send_email: { description: 'Send an email.', parameters: { type: 'object', properties: { to: { type: 'string' } } }, execute: sendEmail },
        search: { description: 'Look things up.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: search },
      },
    });
    const asked: string[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(request.action);
      return { approved: false, reason: 'mail is paused' };
    };
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 100_000, unpriced: 'allow' });
    const team = agency({
      provider: 'openai', model: 'stub-model', apiKey: k, strategy: 'sequential',
      hitl: { approvals: { beforeTool: ['send_email'] }, handler },
      agents: { mailer: sessionSeat(member, { tools: ['send_email'] }) },
    });

    const streamed = team.stream('Email the team.', { budget });
    expect(await streamed.text).toBe('Mail held.');
    expect(asked).toEqual(['send_email']);
    expect(sendEmail).not.toHaveBeenCalled();
    // A tool outside the seat's names is neither offered nor run.
    expect(search).not.toHaveBeenCalled();
    const offered = JSON.stringify(s.seen[0].options.tools ?? []);
    expect(offered).toContain('send_email');
    expect(offered).not.toContain('search');
    // The budget the stream carried was charged for the seat's steps.
    expect(budget.tokensUsed()).toBeGreaterThan(0);
  });

  it('agency() warns about an agencies config, which it applies to none of its seats', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('A draft.')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // An agent's options spread into the agency's, as a host that shares one options object does: the type check reads
    // no property a spread brings, so `agencies` reaches agency() as it does from JavaScript.
    const shared: Pick<AgentOptions, 'provider' | 'model' | 'apiKey' | 'agencies'> = { provider: 'openai', model: 'stub-model', apiKey: k, agencies: { launch: true } };
    const team = agency({ ...shared, runtime: 'gmi', strategy: 'sequential', agents: { writer: { instructions: 'Write.' } } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agency() accepted an agencies config'));

    const result = (await team.generate('Write it.')) as { text: string };
    // The seat ran on a GMI (the precondition) and was offered no launch_agency: the agency's config reached no seat.
    expect(result.text).toBe('A draft.');
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].streamed).toBe(true);
    const offered = ((s.seen[0].options.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((tool) => tool.function.name);
    expect(offered).not.toContain('launch_agency');
  });

  it("refuses a seat's runtime that is neither 'legacy' nor 'gmi', names a value JSON cannot print, and reads null as unset", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Done.')] });
    const base = { provider: 'openai', model: 'stub-model', apiKey: k } as const;
    // A seat's typo, which agent() would run on the legacy engine without a word, is refused as the agency's is.
    const typo = () => agency({ ...base, runtime: 'gmi', agents: { a: { runtime: 'GMI' as 'gmi', instructions: 'x' } } });
    expect(typo).toThrow(AgencyConfigError);
    expect(typo).toThrow("seat 'a'");
    // A value JSON.stringify cannot print is refused with the agency's own error, which names it.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const unprintable: Array<[unknown, string]> = [[1n, '1n'], [circular, '[object Object]'], [Symbol('gmi'), 'Symbol(gmi)']];
    for (const [runtime, named] of unprintable) {
      const build = () => agency({ ...base, runtime: runtime as 'gmi', agents: { a: { instructions: 'x' } } });
      expect(build).toThrow(AgencyConfigError);
      expect(build).toThrow(named);
    }
    // null is unset at both levels: an agency's null leaves its seats on agent()'s default, and a seat's null takes the agency's runtime.
    expect(() => agency({ ...base, runtime: null as unknown as 'gmi', agents: { a: { instructions: 'x' } } })).not.toThrow();
    const team = agency({ ...base, runtime: 'gmi', strategy: 'sequential', agents: { a: { runtime: null as unknown as 'gmi', instructions: 'x' } } });
    await team.generate('Go.');
    expect(s.seen.map((call) => call.streamed)).toEqual([true]);
  });

  it("refuses a dependsOn that is not a list of seat names, takes an empty one as none, and streams a pre-built seat its dependencies' output", async () => {
    const k = key();
    const base = { provider: 'openai', model: 'stub-model', apiKey: k } as const;
    const seat = (instructions: string) => agent({ runtime: 'gmi', provider: 'openai', model: 'stub-model', apiKey: k, instructions });
    // A config's dependsOn written as one name, and a pre-built seat's with a number among its names: each refused, naming the seat.
    const asName = () => agency({ ...base, strategy: 'graph', agents: { researcher: { instructions: 'r' }, writer: { instructions: 'w', dependsOn: 'researcher' as unknown as string[] } } });
    expect(asName).toThrow(AgencyConfigError);
    expect(asName).toThrow("seat 'writer'");
    const withNumber = () => agency({ ...base, agents: { a: seat('A.'), b: Object.assign(seat('B.'), { dependsOn: ['a', 1] }) } });
    expect(withNumber).toThrow(AgencyConfigError);
    expect(withNumber).toThrow("seat 'b'");
    // An empty dependsOn lists no seat, on either form.
    expect(seatMetadataOf({ instructions: 'x', dependsOn: [] })).toEqual({ description: 'x' });
    expect(seatMetadataOf(Object.assign(seat('y'), { dependsOn: [] }))).toEqual({});

    // The graph strategy's stream reads a pre-built seat's dependsOn: `b` waits for `a` and streams with its output.
    const s = script('openai', k, { replies: [reply.text('Fact A.'), reply.text('Report B.')] });
    const b = Object.assign(seat('Report.'), { dependsOn: ['a'] });
    const graphTeam = agency({ ...base, agents: { b, a: seat('Find a fact.') } });
    const parts: Array<{ type: string; agent?: string; input?: string }> = [];
    for await (const part of graphTeam.stream('Write the report.').fullStream) parts.push(part as { type: string; agent?: string; input?: string });
    const starts = parts.filter((part) => part.type === 'agent-start' && part.agent !== '__agency__');
    expect(starts.map((part) => part.agent)).toEqual(['a', 'b']);
    expect(starts[1].input).toContain('Outputs from dependencies:');
    expect(starts[1].input).toContain('[a]:\nFact A.');
    expect(lastUserText(s.seen[1])).toContain('[a]:\nFact A.');
  });

  it('sessionSeat reads its own five options alone: an options object that carries other keys changes nothing', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.tools([{ id: 't1', name: 'search', args: {} }]), reply.text('Lesson.'), reply.text('Still open.')] });
    const search = vi.fn(async () => 'found');
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], instructions: 'Tutor.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: search } },
    });
    const mine = member.session('mine');
    const hook = vi.fn(async () => null);
    // An object, not a literal: the type check reads no key beyond SessionSeatOptions' own, as a host's shared object or
    // a JavaScript caller passes them.
    const o = { brief: 'Tutor the team.', ownsMember: true, userId: 'u1', toolHooks: [hook] };
    const team = agency({ provider: 'openai', model: 'stub-model', apiKey: k, strategy: 'sequential', agents: { tutor: sessionSeat(member, o) } });
    await team.generate('Teach.');
    // No carried hook ran, the tool did, and the seat's requests name no user.
    expect(hook).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(1);
    expect(s.seen[0].options.userId).toBeUndefined();
    // agency().close() leaves the member serving the session it opened before.
    await team.close();
    await expect(mine.send('Hello?')).resolves.toMatchObject({ text: 'Still open.' });
  });

  it("a seat sends the call's maxTokens, and warns once about each per-call option it does not apply", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('One.'), reply.text('Two.')] });
    const member = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Tutor.', maxTokens: 500 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const team = agency({ provider: 'openai', model: 'stub-model', apiKey: k, strategy: 'sequential', agents: { tutor: sessionSeat(member) } });
    await team.generate('Teach.', { maxTokens: 32, temperature: 0.1 });
    await team.generate('Again.', { maxTokens: 32, temperature: 0.1 });
    expect(s.seen.map((call) => call.options.maxTokens)).toEqual([32, 32]);
    // The member's own temperature holds; the warning names the option once for the seat.
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("'temperature'"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sessionSeat()');
  });

  it("a seat's call that fails after a billed step adds that step's usage to the seat's record", async () => {
    const k = key();
    // One tool step (14 tokens), then the provider fails before any output: the turn fails with a billed step behind it.
    script('openai', k, { replies: [reply.tools([{ id: 't1', name: 'search', args: {} }]), new Error('upstream down')] });
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], instructions: 'Look it up.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: async () => 'found' } },
    });
    const seat = sessionSeat(member);
    await expect(seat.generate('Find it.')).rejects.toThrow();
    const record = seat.record();
    expect(record).toMatchObject({ status: 'failed', calls: 1 });
    expect(record.usage.totalTokens).toBe(14);
    await expect(seat.usage()).resolves.toMatchObject({ totalTokens: 14 });
  });

  it('sessionSeat refuses a long brief, a self-modification tool and launch_agency, seats the rest by default, and records a stream that failed', async () => {
    const k = key();
    // A tool step (14 tokens), then a reply whose connection drops after its first delta.
    const s = script('openai', k, { replies: [reply.tools([{ id: 't1', name: 'search', args: {} }]), reply.breakAfterFirstDelta('Half')] });
    const tool = (description: string) => ({ description, parameters: { type: 'object', properties: {} }, execute: async () => 'ok' });
    const member = gmi({
      provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [], instructions: 'Tutor.',
      tools: { search: tool('Search.'), forge_tool: tool('Forge a tool.') },
      agencies: { launch: true },
    });
    expect(() => sessionSeat(member, { brief: 'x'.repeat(1_001) })).toThrow(TypeError);
    expect(() => sessionSeat(member, { brief: 'x'.repeat(1_000) })).not.toThrow();
    expect(() => sessionSeat(member, { tools: ['forge_tool'] })).toThrow("'forge_tool' is a self-modification tool");
    expect(() => sessionSeat(member, { tools: ['launch_agency'] })).toThrow("'launch_agency' runs in a seat only when a launch gives it");

    // By default the seat offers the member's own tools but those two.
    const seat = sessionSeat(member);
    const result = seat.stream('Teach.');
    let failure: unknown;
    for await (const part of result.fullStream) if (part.type === 'error') failure = part.error;
    expect(failure).toBeDefined();
    const offered = ((s.seen[0].options.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name);
    expect(offered).toEqual(['search']);
    // The stream ended with an error part: the record says the call failed and keeps the billed step's usage.
    await result.usage;
    await vi.waitFor(() => expect(seat.record()).toMatchObject({ status: 'failed', calls: 1 }));
    expect(seat.record().usage.totalTokens).toBe(14);
  });

  it("a seat's close leaves the tally a member's own earlier session of that id kept", async () => {
    const k = key();
    script('openai', k, { replies: [reply.text('Hi.'), reply.text('Go.')] });
    const member = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.' });
    // The host names its own session as a seat's id would read.
    await member.session('seat:lesson-1').send('Hi.');
    await member.session('seat:lesson-1').close();
    const seat = sessionSeat(member, { sessionId: 'lesson-1' });
    await seat.generate('Go.');
    await seat.close();
    // The host's turn and the seat's, 15 tokens each, stay under the id.
    expect((await member.usage('seat:lesson-1')).totalTokens).toBe(30);
  });

  it("a seat session's ledger rows name its ledger's own source, else the session's, and the member's own session keeps its source", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentos-seat-ledger-'));
    try {
      const rowsOf = (path: string): Array<Record<string, unknown>> =>
        readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const k = key();
      script('openai', k, { replies: [reply.text('A.'), reply.text('B.'), reply.text('C.')] });
      const named = join(dir, 'named.jsonl');
      const member = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.', usageLedger: { enabled: true, path: named, source: 'launch_agency' } });
      await buildSessionSeat(member, { form: 'temporary', role: 'r' }).generate('Hi.');
      await member.session('s').send('Hi.');
      expect(rowsOf(named).map((row) => row.source)).toEqual(['launch_agency', 'agent.session.send']);
      // A ledger that names no source: the seat's row names the session's.
      const unnamed = join(dir, 'unnamed.jsonl');
      const plain = gmi({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Help.', usageLedger: { enabled: true, path: unnamed } });
      await buildSessionSeat(plain, { form: 'temporary', role: 'r' }).generate('Hi.');
      expect(rowsOf(unnamed).map((row) => row.source)).toEqual(['agent.session.send']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
