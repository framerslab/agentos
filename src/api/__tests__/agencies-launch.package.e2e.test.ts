/**
 * `agencies` and `launch_agency` as a host uses the package. Every agent, tool and type comes from the package's root
 * index, the module `@framers/agentos` resolves to; only the provider classes are stubbed (helpers/stubProviders.ts), at
 * their module boundary, so the real gmi(), agent(), agency(), launch engine, provider manager, completion gateway,
 * GMI and tool orchestrator run, with no network and no key. Each case reads only what a host can observe: the tools a
 * model call is offered, the requests the provider receives, a send's tool calls and their results, the context a
 * host's own tool is handed, warnings and construction errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// The provider class alone is replaced: the package root reads the module's other exports (its default base URL).
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
import { AgencyConfigError, LAUNCH_AGENCY_TOOL_NAME, agent, gmi } from '../../index';
import type { AgencyLaunchOptions, GenerateTextResult, ITool, LaunchAgencyResult } from '../../index';
import { reply, script } from './helpers/stubProviders';

let n = 0;
const key = () => `k-agencies-package-${++n}`;
type SeenMessage = { role: string; content: unknown; tool_call_id?: string };
type SeenCall = { messages: SeenMessage[]; options: Record<string, unknown> };
type OfferedTool = { function: { name: string; description?: string; parameters?: unknown } };
const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content));
/** The system prompt a model call sent. */
const systemText = (call: SeenCall): string =>
  call.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
/** The text of a model call's last user message. */
const lastUserText = (call: SeenCall): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  return users.length > 0 ? textOf(users[users.length - 1].content) : '';
};
/** The tools a model call offered. */
const toolsOf = (call: SeenCall): OfferedTool[] => (call.options.tools as OfferedTool[] | undefined) ?? [];
/** The names of the tools a model call offered. */
const offered = (call: SeenCall): string[] => toolsOf(call).map((tool) => tool.function.name);
/** The launch_agency definition a model call offered. */
const launchTool = (call: SeenCall): OfferedTool['function'] => {
  const found = toolsOf(call).find((tool) => tool.function.name === LAUNCH_AGENCY_TOOL_NAME);
  expect(found, 'launch_agency is offered').toBeDefined();
  return found!.function;
};
/** What a model call carried for tool call `id`: a result's JSON, or a refused or skipped call's error line. */
const toolText = (call: SeenCall, id: string): string => {
  const message = call.messages.find((m) => m.role === 'tool' && m.tool_call_id === id);
  expect(message, `a tool message for ${id}`).toBeDefined();
  return textOf(message?.content);
};
/** The output of a send's `i`-th tool call: a launch that started. */
const launchOf = (result: GenerateTextResult, i = 0): LaunchAgencyResult => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe(LAUNCH_AGENCY_TOOL_NAME);
  expect(call?.error).toBeUndefined();
  return call.result as LaunchAgencyResult;
};
/** The error of a send's `i`-th tool call: a launch refused, `<code>: <reason>`. */
const refusalOf = (result: GenerateTextResult, i: number): string => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe(LAUNCH_AGENCY_TOOL_NAME);
  return String(call?.error ?? '');
};
const codeOf = (refusal: string): string => refusal.split(':')[0];
/** An agent's route, under a key of its own; no fallback, so a failed hop ends the turn. */
const route = (k: string) => ({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] });
/** A host tool in the plain form, answering its own name. */
const tool = (name: string) => ({ description: `The ${name} tool.`, parameters: { type: 'object', properties: {} }, execute: async () => name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agencies and launch_agency, as a host uses the package', () => {
  it('agencies is off unless launch is set, launch_agency reaches the table only on the GMI path, every bound is checked when the agent is built, and a legacy agent() refuses launch and says where agencies applies', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Default.'), reply.text('Bounds only.'), reply.text('Launch on.'), reply.text('Through agent().')] });
    const search = tool('search');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await gmi({ ...route(k), instructions: 'Answer.', tools: { search } }).session('a').send('Hi.');
    await gmi({ ...route(k), instructions: 'Answer.', tools: { search }, agencies: { maxDepth: 3, maxSeats: 4 } }).session('b').send('Hi.');
    await gmi({ ...route(k), instructions: 'Answer.', tools: { search }, agencies: { launch: true } }).session('c').send('Hi.');
    await agent({ ...route(k), runtime: 'gmi', instructions: 'Answer.', tools: { search }, agencies: { launch: true } }).session('d').send('Hi.');
    expect(s.seen).toHaveLength(4);
    // Every call offered the agent's own table (the precondition); launch_agency joins it only where launch is true.
    expect(offered(s.seen[0])).toEqual(['search']);
    expect(offered(s.seen[1])).toEqual(['search']);
    expect([...offered(s.seen[2])].sort()).toEqual([LAUNCH_AGENCY_TOOL_NAME, 'search']);
    expect([...offered(s.seen[3])].sort()).toEqual([LAUNCH_AGENCY_TOOL_NAME, 'search']);
    // gmi() enforces agencies: the warning that names the fields it defers (rag here, the precondition) leaves it out.
    warn.mockClear();
    gmi({ ...route(k), agencies: { launch: true, maxDepth: 3 }, rag: { topK: 3 } });
    const gmiWarning = warn.mock.calls.map(([message]) => String(message)).join('\n');
    expect(gmiWarning).toContain('gmi() accepted config it does not enforce yet: rag.');
    expect(gmiWarning).not.toContain('agencies');

    // Each bound outside its range fails at construction, naming the field, whether launch is on or off.
    const outOfRange: Array<[AgencyLaunchOptions, string]> = [
      [{ maxDepth: 5 }, 'agencies.maxDepth'],
      [{ maxDepth: 0 }, 'agencies.maxDepth'],
      [{ maxSeats: 13 }, 'agencies.maxSeats'],
      [{ maxConcurrent: 5 }, 'agencies.maxConcurrent'],
      [{ budgetShare: 0 }, 'agencies.budgetShare'],
      [{ budgetShare: 1.5 }, 'agencies.budgetShare'],
      [{ maxLaunchTokens: 1_999 }, 'agencies.maxLaunchTokens'],
      [{ maxLaunchCostUSD: 0 }, 'agencies.maxLaunchCostUSD'],
      [{ maxDeadlineMs: 999 }, 'agencies.maxDeadlineMs'],
      [{ maxDeadlineMs: 5_000, defaultDeadlineMs: 6_000 }, 'agencies.defaultDeadlineMs'],
    ];
    for (const [bounds, field] of outOfRange) {
      for (const launch of [false, true]) {
        expect(() => gmi({ ...route(k), agencies: { ...bounds, launch } }), `${field}, launch ${launch}`).toThrow(RangeError);
        expect(() => gmi({ ...route(k), agencies: { ...bounds, launch } }), `${field}, launch ${launch}`).toThrow(field);
      }
    }
    // An approval rule with no handler, as agency() refuses one.
    expect(() => gmi({ ...route(k), agencies: { launch: true, hitl: { approvals: { beforeTool: ['search'] } } } })).toThrow(AgencyConfigError);
    // A host tool of the same name.
    expect(() => gmi({ ...route(k), tools: { launch_agency: tool('launch_agency') }, agencies: { launch: true } })).toThrow(`agencies.launch registers '${LAUNCH_AGENCY_TOOL_NAME}'`);

    // A legacy agent() runs no GMI tool loop: it refuses launch at construction, and its one warning for the other
    // fields says where they apply, not among the fields it sends to the full runtime or agency().
    const legacy = { provider: 'openai', model: 'stub-model', apiKey: k };
    expect(() => agent({ ...legacy, agencies: { launch: true } })).toThrow('agencies.launch runs on the GMI path');
    warn.mockClear();
    agent({ ...legacy, agencies: { maxDepth: 3 } });
    expect(warn).toHaveBeenCalledTimes(1);
    const legacyWarning = String(warn.mock.calls[0]?.[0]);
    expect(legacyWarning).toContain("agent() launches teams only with runtime: 'gmi' (agencies.launch); this agent does not apply agencies.");
    expect(legacyWarning).not.toMatch(/requires the full AgentOS runtime[^.]*agencies/);
    // launch: false alone sets nothing, so it is not reported.
    warn.mockClear();
    agent({ ...legacy, agencies: { launch: false } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a launch seats a host's member by agentKey as itself, and refuses before any seat runs each allowlist the launching agent or the member cannot give", async () => {
    const k = key();
    const launch = (id: string, args: Record<string, unknown>) => ({ id, name: LAUNCH_AGENCY_TOOL_NAME, args });
    const s = script('openai', k, {
      replies: [
        reply.tools([
          // maxDepth 1: a seat at level 1 cannot launch.
          launch('a', { goal: 'Check.', seats: [{ role: 'lead', instructions: 'Lead.', tools: [LAUNCH_AGENCY_TOOL_NAME] }] }),
          // The parent has no web_fetch.
          launch('b', { goal: 'Check.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['web_fetch'] }] }),
          // Memory tools are never a seat's, the parent's and the member's memory_add included; nor is a self-modification tool.
          launch('c', { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['memory_add'] }] }),
          launch('d', { goal: 'Check.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['read_working_memory'] }] }),
          launch('e', { goal: 'Check.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['forge_tool'] }] }),
          // One member, two seats.
          launch('f', { goal: 'Check.', seats: [{ role: 'one', agentKey: 'tutor' }, { role: 'two', agentKey: 'tutor' }] }),
          // A personaId seat is the full runtime's form.
          launch('g', { goal: 'Check.', seats: [{ role: 'reviewer', personaId: 'reviewer' }] }),
          // Keys the agent does not list, one of them a name every object inherits.
          launch('h', { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'toString' }] }),
          launch('i', { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'coach' }] }),
          // The member takes two seats, with a brief and without one.
          launch('j', { goal: 'Check 2 + 2.', seats: [{ role: 'checker', agentKey: 'tutor', brief: 'Check the sum.', tools: ['calc'] }] }),
          launch('k', { goal: 'Check 3 + 3.', seats: [{ role: 'second', agentKey: 'tutor' }] }),
          // search is the parent's and not the member's.
          launch('l', { goal: 'Check.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['search'] }] }),
        ]),
        reply.text('2 + 2 is 4.'),
        reply.text('3 + 3 is 6.'),
        reply.text('Checked.'),
        reply.text('Hello.'),
      ],
    });
    const tutor = gmi({ ...route(k), name: 'Tutor', instructions: 'You are the maths tutor.', tools: { memory_add: tool('memory_add'), calc: tool('calc') } });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { search: tool('search'), memory_add: tool('memory_add'), calc: tool('calc') },
      agencies: { launch: true, maxDepth: 1, members: { tutor } },
    });
    // A session of the member's own, open before the launch.
    const own = tutor.session('t1');

    const result = await parent.session('p1').send('Check the sums.');
    expect(result.text).toBe('Checked.');
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => codeOf(refusalOf(result, i)))).toEqual([
      'tool_not_allowed',
      'unknown_tool',
      'tool_not_allowed',
      'tool_not_allowed',
      'tool_not_allowed',
      'duplicate_member',
      'seat_form_unsupported',
      'unknown_member',
      'unknown_member',
    ]);
    expect(refusalOf(result, 0)).toContain('a seat at level 1 cannot use (maxDepth 1)');
    expect(refusalOf(result, 1)).toContain("the launching agent has no tool 'web_fetch'");
    expect(refusalOf(result, 2)).toContain("'memory_add' is a memory tool");
    expect(refusalOf(result, 3)).toContain("'read_working_memory' is a memory tool");
    expect(refusalOf(result, 4)).toContain("'forge_tool' is a self-modification tool");
    expect(refusalOf(result, 5)).toContain("member 'tutor' is named by two seats");
    expect(refusalOf(result, 7)).toContain("no member 'toString'");
    expect(refusalOf(result, 8)).toContain("no member 'coach'");

    // The member took both seats as itself, one call each.
    const briefed = launchOf(result, 9);
    expect(briefed).toMatchObject({ status: 'completed', text: '2 + 2 is 4.' });
    expect(briefed.seats).toEqual([expect.objectContaining({ role: 'checker', form: 'persistent', member: 'tutor', status: 'completed', calls: 1, summary: '2 + 2 is 4.' })]);
    expect(launchOf(result, 10).seats).toEqual([expect.objectContaining({ role: 'second', form: 'persistent', member: 'tutor', status: 'completed', calls: 1, summary: '3 + 3 is 6.' })]);
    // A member's seat names only tools the member has too.
    expect(codeOf(refusalOf(result, 11))).toBe('unknown_tool');
    expect(refusalOf(result, 11)).toContain("the member 'tutor' has no tool 'search'");
    // The parent's two steps and the member's two seat calls: no refused launch reached a seat.
    expect(s.seen).toHaveLength(4);
    expect(systemText(s.seen[1])).toContain('You are the maths tutor.');
    expect(systemText(s.seen[2])).toContain('You are the maths tutor.');
    expect(lastUserText(s.seen[1])).toMatch(/^Your role in this team: checker\. Check the sum\.\n\nCheck 2 \+ 2\./);
    expect(lastUserText(s.seen[2])).toMatch(/^Your role in this team: second\.\n\nCheck 3 \+ 3\./);
    // A seat offers its names, never the member's whole table: calc, and nothing for a seat that names none.
    expect(offered(s.seen[1])).toEqual(['calc']);
    expect(offered(s.seen[2])).toEqual([]);

    // The table offers the member form under its keys, and says what each form of seat may name.
    const described = launchTool(s.seen[0]);
    expect(JSON.stringify(described.parameters)).toContain('"agentKey"');
    expect(JSON.stringify(described.parameters)).toContain('"brief"');
    expect(described.description).toContain('a member you seat as itself by agentKey (tutor)');
    expect(described.description).toContain('One seat makes a subagent.');
    expect(described.description).toContain("A member's seat may name only tools the member also has.");

    // The launches closed their seats and never the member: its session, open since before them, still answers, with
    // its own table.
    await expect(own.send('Hi.')).resolves.toMatchObject({ text: 'Hello.' });
    expect([...offered(s.seen[4])].sort()).toEqual(['calc', 'memory_add']);
  });

  it('with no members the table offers no member form, a one-seat launch is a subagent, and the members record is read when the agent is built', async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'a', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Name a prime above 10.', seats: [{ role: 'solver', instructions: 'Answer in one line.' }] } },
          { id: 'b', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Help.', seats: [{ role: 'helper', agentKey: 'helper' }] } },
        ]),
        reply.text('11.'),
        reply.text('Eleven.'),
      ],
    });
    const members: NonNullable<AgencyLaunchOptions['members']> = {};
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, members } });
    // Put in the record after the agent was built, on the parent's key: a seat of it would take a scripted reply.
    members.helper = gmi({ ...route(k), name: 'Helper', instructions: 'Help.' });

    const result = await parent.session('p1').send('A prime, please.');
    expect(result.text).toBe('Eleven.');
    // One seat makes a subagent: the seat's answer is the launch's text.
    const subagent = launchOf(result, 0);
    expect(subagent).toMatchObject({ status: 'completed', text: '11.', truncated: false, provenance: { depth: 1, parentSessionId: 'p1' } });
    expect(subagent.seats).toEqual([expect.objectContaining({ role: 'solver', form: 'temporary', status: 'completed', calls: 1, summary: '11.' })]);
    expect(systemText(s.seen[1])).toContain('Answer in one line.');
    // The helper added later never takes a seat.
    expect(refusalOf(result, 1)).toMatch(/^unknown_member: /);
    expect(s.seen).toHaveLength(3);
    // The table was built from the same record: launch_agency is offered (the precondition), with no member form.
    expect(offered(s.seen[0])).toEqual([LAUNCH_AGENCY_TOOL_NAME]);
    const described = launchTool(s.seen[0]);
    expect(JSON.stringify(described.parameters)).toContain('"seats"');
    expect(JSON.stringify(described.parameters)).not.toContain('agentKey');
    expect(JSON.stringify(described.parameters)).not.toContain('"brief"');
    expect(described.description).toContain('One seat makes a subagent.');
    expect(described.description).not.toContain('agentKey');

    // A member must be a gmi() agent, listed under the key its learning names, if it names one.
    const legacyMember = agent({ provider: 'openai', model: 'stub-model', apiKey: k, instructions: 'Old.' });
    expect(() => gmi({ ...route(k), agencies: { launch: true, members: { old: legacyMember } } })).toThrow('agencies.members.old is not a gmi() handle');
    const keyed = gmi({ ...route(k), name: 'Tutor', instructions: 'Teach.', learning: { agentKey: 'tutor' } });
    expect(() => gmi({ ...route(k), agencies: { launch: true, members: { teacher: keyed } } })).toThrow("agencies.members.teacher is the agent 'tutor'");
    expect(() => gmi({ ...route(k), agencies: { launch: true, members: { tutor: keyed } } })).not.toThrow();
  });

  it("each tool call of a seat's turn is handed a frozen copy of its team's frame, a turn in no team is handed none, and the deepest level cannot launch", async () => {
    const k = key();
    type Frame = { launchId: string; role: string; depth: number };
    const calls: Array<{ by: string; sessionId: unknown; frame?: Frame; frozen?: boolean; rewritten?: boolean }> = [];
    // A host ITool, so its execute reads the call's context; it tries to point the frame at another team.
    const probe = (by: string): ITool => ({
      id: `probe-${by}`,
      name: 'probe',
      displayName: 'Probe',
      description: 'Note where this call runs.',
      inputSchema: { type: 'object', properties: {} },
      hasSideEffects: false,
      execute: async (_args, context) => {
        const frame = context.sessionData?.agencyLaunch as Frame | undefined;
        if (!frame) {
          calls.push({ by, sessionId: context.sessionData?.sessionId });
          return { success: true, output: 'noted' };
        }
        try {
          frame.launchId = 'agency-elsewhere';
        } catch {
          // A frozen frame refuses the write.
        }
        calls.push({ by, sessionId: context.sessionData?.sessionId, frame: { ...frame }, frozen: Object.isFrozen(frame), rewritten: frame.launchId === 'agency-elsewhere' });
        return { success: true, output: 'noted' };
      },
    });
    const s = script('openai', k, {
      replies: [
        // The root's step: a call of its own, then a level-1 team whose lead may probe and launch.
        reply.tools([
          { id: 'r1', name: 'probe', args: {} },
          { id: 'r2', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Check the claim.', seats: [{ role: 'lead', instructions: 'Lead the check.', tools: ['probe', LAUNCH_AGENCY_TOOL_NAME] }] } },
        ]),
        // The lead's step: a probe, a level-2 team whose member may launch (refused under maxDepth 2), then one whose
        // member may probe.
        reply.tools([
          { id: 'x1', name: 'probe', args: {} },
          { id: 'x2', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Verify.', seats: [{ role: 'checker', agentKey: 'tutor', tools: [LAUNCH_AGENCY_TOOL_NAME] }] } },
          { id: 'x3', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Verify.', seats: [{ role: 'checker', agentKey: 'tutor', tools: ['probe'] }] } },
        ]),
        // The member's level-2 turn: a probe and a launch_agency call, which its own table has and its seat does not;
        // then a second step that probes again; then its answer.
        reply.tools([
          { id: 'm1', name: 'probe', args: {} },
          { id: 'm2', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Deeper.', seats: [{ role: 'deep', instructions: 'Go deeper.' }] } },
        ]),
        reply.tools([{ id: 'm3', name: 'probe', args: {} }]),
        reply.text('Verified.'),
        reply.text('Lead done.'),
        reply.text('All done.'),
        // The member's own session, after the launch.
        reply.tools([{ id: 'o1', name: 'probe', args: {} }]),
        reply.text('Noted.'),
      ],
    });
    const tutor = gmi({ ...route(k), name: 'Tutor', instructions: 'You are the tutor.', tools: { probe: probe('tutor') }, agencies: { launch: true } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', tools: { probe: probe('parent') }, agencies: { launch: true, maxDepth: 2, members: { tutor } } });

    const result = await parent.session('p1').send('Check it.');
    expect(result.text).toBe('All done.');
    const root = launchOf(result, 1);
    expect(root).toMatchObject({ status: 'completed', text: 'Lead done.', provenance: { depth: 1, parentSessionId: 'p1' } });
    // The calls: root, lead, the member's three steps, lead, root.
    expect(s.seen).toHaveLength(7);
    // The lead, at level 1, is offered launch_agency; its launch naming it for a level-2 seat was refused.
    expect([...offered(s.seen[1])].sort()).toEqual([LAUNCH_AGENCY_TOOL_NAME, 'probe']);
    expect(toolText(s.seen[5], 'x2')).toContain('tool_not_allowed');
    expect(toolText(s.seen[5], 'x2')).toContain('a seat at level 2 cannot use (maxDepth 2)');
    // Its second launch made the level-2 team, from the lead's seat session, and the member's seat completed it.
    const nested = JSON.parse(toolText(s.seen[5], 'x3')) as LaunchAgencyResult;
    expect(nested).toMatchObject({ status: 'completed', text: 'Verified.', provenance: { depth: 2, parentSessionId: `seat:${root.agencyId}:lead` } });
    expect(nested.seats).toEqual([expect.objectContaining({ role: 'checker', form: 'persistent', member: 'tutor', status: 'completed', calls: 1 })]);
    // At level 2 the member is not offered launch_agency, though its own table has it, and its call is skipped.
    expect(systemText(s.seen[2])).toContain('You are the tutor.');
    expect(offered(s.seen[2])).toEqual(['probe']);
    expect(toolText(s.seen[3], 'm2')).toContain('not available in this seat');

    // The member's own session, after it served the seat, runs its own table.
    await expect(tutor.session('own').send('Note it.')).resolves.toMatchObject({ text: 'Noted.' });
    expect([...offered(s.seen[7])].sort()).toEqual([LAUNCH_AGENCY_TOOL_NAME, 'probe']);
    // Each call of a seat's turn, in each of its steps, was handed its team's frame, frozen so the tool's write did not
    // take, in the seat's session; a call of a turn in no team was handed none.
    const lead = { launchId: root.agencyId, role: 'lead', depth: 1 };
    const checker = { launchId: nested.agencyId, role: 'checker', depth: 2 };
    expect(calls).toEqual([
      { by: 'parent', sessionId: 'p1' },
      { by: 'parent', sessionId: `seat:${root.agencyId}:lead`, frame: lead, frozen: true, rewritten: false },
      { by: 'tutor', sessionId: `seat:${nested.agencyId}:checker`, frame: checker, frozen: true, rewritten: false },
      { by: 'tutor', sessionId: `seat:${nested.agencyId}:checker`, frame: checker, frozen: true, rewritten: false },
      { by: 'tutor', sessionId: 'own' },
    ]);
  });

  it("a nested launch runs under its tree's limits and its seat's names, never its member's own", async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'l1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Scout the area.', seats: [{ role: 'scout', agentKey: 'scout', tools: [LAUNCH_AGENCY_TOOL_NAME] }] } }]),
        // The member's seat turn: four launches through its own launch_agency, whose own bounds are wider than the tree's.
        reply.tools([
          { id: 'n1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Split it.', seats: [{ role: 'a', instructions: 'A.' }, { role: 'b', instructions: 'B.' }, { role: 'c', instructions: 'C.' }] } },
          { id: 'n2', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Find it.', seats: [{ role: 'finder', instructions: 'Find.', tools: ['search'] }] } },
          { id: 'n3', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Go deeper.', seats: [{ role: 'deep', instructions: 'Go deeper.', tools: [LAUNCH_AGENCY_TOOL_NAME] }] } },
          { id: 'n4', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Sum it up.', seats: [{ role: 'writer', instructions: 'Write one line.' }] } },
        ]),
        reply.text('One line.'),
        reply.text('Scouted.'),
        reply.text('Done.'),
      ],
    });
    const scout = gmi({
      ...route(k),
      name: 'Scout',
      instructions: 'You scout.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: {} }, execute: search } },
      agencies: { launch: true, maxDepth: 4, maxSeats: 12 },
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, maxDepth: 2, maxSeats: 2, members: { scout } } });

    const result = await parent.session('p1').send('Scout it.');
    expect(result.text).toBe('Done.');
    const launch = launchOf(result);
    expect(launch).toMatchObject({ status: 'completed', text: 'Scouted.' });
    expect(launch.seats).toEqual([expect.objectContaining({ role: 'scout', form: 'persistent', member: 'scout', status: 'completed' })]);
    // Root, the member's two steps around the writer's one call, root.
    expect(s.seen).toHaveLength(5);
    expect(systemText(s.seen[1])).toContain('You scout.');
    // The member's seat offers its seat's names alone: launch_agency, without its own search.
    expect(offered(s.seen[1])).toEqual([LAUNCH_AGENCY_TOOL_NAME]);
    const step = s.seen[3];
    // The tree's maxSeats (2), not the member's own 12.
    expect(toolText(step, 'n1')).toContain('too_many_seats: 3 seats; at most 2');
    // The seat's names, not the member's table.
    expect(toolText(step, 'n2')).toContain("unknown_tool: seat 'finder': the launching agent has no tool 'search'");
    // The tree's maxDepth (2), not the member's own 4: a seat at level 2 cannot launch.
    expect(toolText(step, 'n3')).toContain('tool_not_allowed');
    expect(toolText(step, 'n3')).toContain('a seat at level 2 cannot use (maxDepth 2)');
    // A launch within those bounds ran at level 2, from the member's seat session.
    const nested = JSON.parse(toolText(step, 'n4')) as LaunchAgencyResult;
    expect(nested).toMatchObject({ status: 'completed', text: 'One line.', provenance: { depth: 2, parentSessionId: `seat:${launch.agencyId}:scout` } });
    expect(systemText(s.seen[2])).toContain('Write one line.');
    expect(search).not.toHaveBeenCalled();
  });
});
