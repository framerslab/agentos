/**
 * `agencies` and `launch_agency` as a host uses the package. Every agent, tool and type comes from the package's root
 * index, the module `@framers/agentos` resolves to, and a composition or a workflow a host builds from the module the
 * package's `./emergent` entry serves; only the provider classes are stubbed (helpers/stubProviders.ts), at their module
 * boundary, so the real gmi(), agent(), agency(), launch engine, provider manager, completion gateway, GMI and tool
 * orchestrator run, with no network and no key. Each case reads only what a host can observe: the tools a model call is
 * offered, the requests the provider receives, a send's tool calls and their results, the context a host's own tool is
 * handed, a session's kept messages, the events an agent's callbacks receive, budgets, warnings and construction errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// The provider class alone is replaced: the package root reads the module's other exports (its default base URL).
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
import { AgencyConfigError, LAUNCH_AGENCY_TOOL_NAME, SpendBudget, agency, agent, gmi } from '../../index';
import type { AgencyCallbacks, AgencyLaunchOptions, AgentSession, ApprovalDecision, ApprovalRequest, GenerateTextResult, ITool, LaunchAgencyResult } from '../../index';
// The module the package's './emergent' entry serves: the parts a host builds a composition or a workflow from.
import { ComposableToolBuilder, CreateWorkflowTool, createStepGate } from '../../cognition/emergent/index';
import type { StepGate } from '../../cognition/emergent/index';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

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
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id = 'l1') => reply.tools([{ id, name: LAUNCH_AGENCY_TOOL_NAME, args }]);
/** A tool-call step reporting `totalTokens` of usage. */
const toolsCosting = (calls: Parameters<typeof reply.tools>[0], totalTokens: number) =>
  reply.tools(calls).map((chunk) => ('usage' in chunk ? { ...chunk, usage: { promptTokens: totalTokens - 50, completionTokens: 50, totalTokens } } : chunk));
/** A text answer reporting `totalTokens` of usage. */
const textCosting = (text: string, totalTokens: number) => reply.text(text, 'stub-model', { promptTokens: totalTokens - 50, completionTokens: 50, totalTokens });
/** A launch of one temporary seat. */
const oneSeat = (role: string) => ({ goal: `Do the ${role} part.`, seats: [{ role, instructions: `Do the ${role} part.` }] });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A plain-form tool whose execute is the test's. */
const plain = (description: string, execute: () => Promise<string>) => ({ description, parameters: { type: 'object', properties: {} }, execute });
/** The last message a session keeps. */
const lastKept = (session: AgentSession) => {
  const kept = session.messages();
  return kept[kept.length - 1];
};
/** A host ITool, whose execute reads the call's context. */
const hostTool = (name: string, execute: ITool['execute']): ITool => ({
  id: `host-${name}`,
  name,
  displayName: name,
  description: `The ${name} tool.`,
  inputSchema: { type: 'object', properties: {} },
  hasSideEffects: false,
  execute,
});
/**
 * What a host does while its session's scope is closing: send again until the launch the turn makes is admitted. Each
 * try scripts the stub afresh (the launch step, then the replies after it); at most 50 tries, 100 ms apart.
 */
const sendUntilAdmitted = async (session: AgentSession, s: ProviderScript, replies: () => ProviderScript['replies']): Promise<GenerateTextResult> => {
  for (let tries = 0; tries < 50; tries++) {
    s.replies.length = 0;
    s.replies.push(...replies());
    const result = await session.send('Again.');
    if (codeOf(String(result.toolCalls[0]?.error ?? '')) !== 'concurrency_exceeded') return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no launch was admitted in 50 tries');
};
/** The events a host's callbacks receive, typed from the root's AgencyCallbacks. */
type StartEvent = Parameters<NonNullable<AgencyCallbacks['agentStart']>>[0];
type EndEvent = Parameters<NonNullable<AgencyCallbacks['agentEnd']>>[0];
type TeamErrorEvent = Parameters<NonNullable<AgencyCallbacks['error']>>[0];

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

  it('a launch past its deadline returns timed_out with what its seats produced, within one grace, and the parent turn goes on', async () => {
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
    expect(out).toMatchObject({ status: 'timed_out', reason: 'the deadline of 1000 ms passed', provenance: { deadlineMs: 1_000 } });
    expect(out.seats.map((r) => [r.role, r.status, r.summary])).toEqual([
      ['drafter', 'completed', 'A draft.'],
      ['editor', 'cut', ''],
    ]);
    // The editor's held request was aborted, once, and not tried again.
    expect(s.aborts).toBe(1);
    // Within the deadline and one grace, the settle wait and the close sharing it.
    expect(Date.now() - started).toBeLessThan(1_000 + 5_000);
    // The parent's next step ran: root, drafter, editor, root.
    expect(result.text).toBe('Partial work.');
    expect(s.seen).toHaveLength(4);
  }, 20_000);

  it('a launch runs under the least of its deadlineMs and maxDeadlineMs, defaultDeadlineMs when it names none, and the tool tells the model both', async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'a', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Answer.', seats: [{ role: 'solver', instructions: 'Answer.' }] } },
          { id: 'b', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Answer.', deadlineMs: 10_000, seats: [{ role: 'solver', instructions: 'Answer.' }] } },
        ]),
        reply.text('A.'),
        reply.text('B.'),
        reply.text('Both.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, defaultDeadlineMs: 2_000, maxDeadlineMs: 3_000 } });

    const result = await parent.session('p1').send('Go.');
    expect(result.text).toBe('Both.');
    expect(launchOf(result, 0)).toMatchObject({ status: 'completed', text: 'A.', provenance: { deadlineMs: 2_000 } });
    expect(launchOf(result, 1)).toMatchObject({ status: 'completed', text: 'B.', provenance: { deadlineMs: 3_000 } });
    expect(JSON.stringify(launchTool(s.seen[0]).parameters)).toContain('default 2000, at most 3000');
  });

  it("a launch whose seat holds past the deadline and the grace keeps its session's scope until the seat is released, and another agent's session of the same id is a scope of its own", async () => {
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
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { hang: { description: 'Hangs.', parameters: { type: 'object', properties: {} }, execute: hang } },
      agencies: { launch: true },
    });
    const session = parent.session('p1');

    const first = await session.send('Start.');
    expect(first.text).toBe('Waited.');
    expect(launchOf(first, 0).status).toBe('timed_out');
    // The seat still holds the tool, so the launch is closing and counts toward the session's one launch in flight.
    expect(hang).toHaveBeenCalledTimes(1);
    expect(refusalOf(first, 1)).toMatch(/^concurrency_exceeded: /);
    // Another agent's session of the same id is a scope of its own: it launches meanwhile.
    const k2 = key();
    script('openai', k2, { replies: [launchStep(oneSeat, 'o1'), reply.text('Answered.'), reply.text('Ran.')] });
    const other = gmi({ ...route(k2), instructions: 'Coordinate.', agencies: { launch: true } });
    expect(launchOf(await other.session('p1').send('Go.')).status).toBe('completed');

    // Once the tool returns, the seat is released and the session launches again.
    release();
    const again = await sendUntilAdmitted(session, s, () => [launchStep(oneSeat, 'l3'), reply.text('Answered.'), reply.text('Now it ran.')]);
    expect(launchOf(again)).toMatchObject({ status: 'completed', text: 'Answered.' });
    expect(again.text).toBe('Now it ran.');
    expect(hang).toHaveBeenCalledTimes(1);
    // Nothing was sent for the waiter after its tool: its one request is the step that called it.
    expect(s.seen.filter((call) => systemText(call).includes('Call hang.'))).toHaveLength(1);
  }, 40_000);

  it("a session that keeps no history keeps one scope across its turns: its closing launch refuses the next turn's launch until the seat is released", async () => {
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
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('Waited.'),
        // The next send runs on a GMI of its own (history: false), in the same session.
        launchStep(oneSeat, 'l2'),
        reply.text('Refused.'),
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      history: false,
      tools: { hang: { description: 'Hangs.', parameters: { type: 'object', properties: {} }, execute: hang } },
      agencies: { launch: true },
    });
    const session = parent.session('p1');

    expect(launchOf(await session.send('Start.')).status).toBe('timed_out');
    expect(hang).toHaveBeenCalledTimes(1);
    const next = await session.send('Again.');
    expect(refusalOf(next, 0)).toMatch(/^concurrency_exceeded: /);
    expect(next.text).toBe('Refused.');

    release();
    const again = await sendUntilAdmitted(session, s, () => [launchStep(oneSeat, 'l3'), reply.text('Answered.'), reply.text('Now it ran.')]);
    expect(launchOf(again)).toMatchObject({ status: 'completed', text: 'Answered.' });
    expect(hang).toHaveBeenCalledTimes(1);
    expect(s.seen.filter((call) => systemText(call).includes('Call hang.'))).toHaveLength(1);
  }, 40_000);

  it("at a launch's deadline the call running in a seat finishes with the stop on its signal, and the call after it never starts, runs no hook and asks no approver; the parent's turn goes on", async () => {
    const k = key();
    const signals: string[] = [];
    const hooked: string[] = [];
    const asked: string[] = [];
    const note = vi.fn(async () => 'noted');
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Write, then note.', deadlineMs: 1_000, seats: [{ role: 'writer', instructions: 'Write, then note.', tools: ['slow_write', 'note'] }] }),
        // The writer's step: slow_write runs past the 1,000 ms deadline; note comes after it in the same step.
        reply.tools([{ id: 'w1', name: 'slow_write', args: {} }, { id: 'n1', name: 'note', args: {} }]),
        reply.text('Parent done.'),
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: {
        slow_write: hostTool('slow_write', async (_args, context) => {
          signals.push(`start ${context.signal?.aborted === true ? 'stopped' : 'live'}`);
          await sleep(1_500);
          signals.push(`end ${context.signal?.aborted === true ? 'stopped' : 'live'}`);
          return { success: true, output: 'written' };
        }),
        note: plain('Notes.', note),
      },
      // The parent's hook runs on its own calls and on every seat's.
      onBeforeToolExecution: async (call) => {
        hooked.push(call.name);
        return call;
      },
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['slow_write', 'note'] },
          handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
            asked.push(request.action);
            return { approved: true };
          },
        },
      },
    });

    const started = Date.now();
    const result = await parent.session('p1').send('Go.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'timed_out', reason: 'the deadline of 1000 ms passed' });
    expect(out.seats.map((r) => [r.role, r.status, r.summary])).toEqual([['writer', 'cut', '']]);
    // The running call had the turn's stop as its signal, live when it started and aborted by its end, and it ran to
    // its end.
    expect(signals).toEqual(['start live', 'end stopped']);
    // The call after it never started: no hook ran for it and no one was asked about it.
    expect(note).not.toHaveBeenCalled();
    expect(hooked).toEqual([LAUNCH_AGENCY_TOOL_NAME, 'slow_write']);
    expect(asked).toEqual(['slow_write']);
    // Nothing was sent for the writer after its step, and the parent's turn went on: root, writer, root.
    expect(s.seen).toHaveLength(3);
    expect(result.text).toBe('Parent done.');
    expect(Date.now() - started).toBeLessThan(1_000 + 5_000);
  }, 20_000);

  it("a seat call whose approval arrives after the launch's deadline is refused before it runs", async () => {
    const k = key();
    const sendEmail = vi.fn(async () => 'sent');
    const asked: string[] = [];
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Send it.', deadlineMs: 1_000, seats: [{ role: 'sender', instructions: 'Send the mail.', tools: ['send_email'] }] }),
        reply.tools([{ id: 'e1', name: 'send_email', args: {} }]),
        reply.text('Parent done.'),
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { send_email: plain('Sends an email.', sendEmail) },
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['send_email'] },
          handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
            asked.push(request.action);
            // Approved after the 1,000 ms deadline.
            await sleep(1_500);
            return { approved: true };
          },
        },
      },
    });

    const result = await parent.session('p1').send('Go.');
    expect(launchOf(result)).toMatchObject({ status: 'timed_out', reason: 'the deadline of 1000 ms passed' });
    // The approval was asked (the precondition) and came after the stop: the call it approved never ran.
    expect(asked).toEqual(['send_email']);
    expect(sendEmail).not.toHaveBeenCalled();
    // Root, sender, root.
    expect(s.seen).toHaveLength(3);
    expect(result.text).toBe('Parent done.');
  }, 20_000);

  it("a caller's abort signal or the session's close() stops a turn as a deadline does: the call running finishes with the stop on its signal, the call after it never starts, and nothing more is sent", async () => {
    const state = (signal: AbortSignal | undefined) => (signal?.aborted === true ? 'stopped' : 'live');
    // The caller's own signal, which the running tool aborts.
    const k = key();
    const caller = new AbortController();
    const stopped = new Error('the caller stopped the turn');
    const signals: string[] = [];
    const hooked: string[] = [];
    const note = vi.fn(async () => 'noted');
    const s = script('openai', k, {
      replies: [reply.tools([{ id: 'w1', name: 'write', args: {} }, { id: 'n1', name: 'note', args: {} }]), reply.text('Still here.')],
    });
    const writer = gmi({
      ...route(k),
      instructions: 'Write, then note.',
      tools: {
        write: hostTool('write', async (_args, context) => {
          signals.push(`start ${state(context.signal)}`);
          caller.abort(stopped);
          signals.push(`after the stop ${state(context.signal)}`);
          return { success: true, output: 'written' };
        }),
        note: plain('Notes.', note),
      },
      onBeforeToolExecution: async (call) => {
        hooked.push(call.name);
        return call;
      },
    });
    const session = writer.session('w1');

    await expect(session.send('Go.', { abortSignal: caller.signal })).rejects.toBe(stopped);
    expect(signals).toEqual(['start live', 'after the stop stopped']);
    expect(note).not.toHaveBeenCalled();
    expect(hooked).toEqual(['write']);
    // No request after the stop.
    expect(s.seen).toHaveLength(1);
    // The step is kept, marked partial: the running call's result, then the refusal of the call after it.
    expect(session.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(session.messages()[2]).toMatchObject({ role: 'tool', tool_call_id: 'w1', content: 'written' });
    expect(lastKept(session)).toMatchObject({ role: 'tool', tool_call_id: 'n1', partial: true });
    expect(String(lastKept(session).content)).toContain("step_aborted: the call to 'note' was stopped before it ran");
    // The session stays open: its next send runs.
    await expect(session.send('Again.')).resolves.toMatchObject({ text: 'Still here.' });
    expect(s.seen).toHaveLength(2);

    // The session's close(), which the running tool calls.
    const k2 = key();
    let closing!: AgentSession;
    let closed: Promise<void> | undefined;
    const signals2: string[] = [];
    const hooked2: string[] = [];
    const note2 = vi.fn(async () => 'noted');
    const s2 = script('openai', k2, { replies: [reply.tools([{ id: 'w1', name: 'write', args: {} }, { id: 'n1', name: 'note', args: {} }])] });
    const closer = gmi({
      ...route(k2),
      instructions: 'Write, then note.',
      tools: {
        write: hostTool('write', async (_args, context) => {
          signals2.push(`start ${state(context.signal)}`);
          // close() waits for the turn to end, so the tool does not wait for it.
          closed = closing.close();
          signals2.push(`after close ${state(context.signal)}`);
          return { success: true, output: 'written' };
        }),
        note: plain('Notes.', note2),
      },
      onBeforeToolExecution: async (call) => {
        hooked2.push(call.name);
        return call;
      },
    });
    closing = closer.session('c1');

    await expect(closing.send('Go.')).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR', message: expect.stringMatching(/abort/i) });
    await expect(closed).resolves.toBeUndefined();
    expect(signals2).toEqual(['start live', 'after close stopped']);
    expect(note2).not.toHaveBeenCalled();
    expect(hooked2).toEqual(['write']);
    expect(s2.seen).toHaveLength(1);
    expect(lastKept(closing)).toMatchObject({ role: 'tool', tool_call_id: 'n1', partial: true });
    expect(String(lastKept(closing).content)).toContain("step_aborted: the call to 'note' was stopped before it ran");
  });

  it('a composed tool or a workflow a host builds from the package starts none of its later steps once its turn stopped', async () => {
    const k = key();
    const ran: string[] = [];
    let stopTurn: () => void = () => undefined;
    const stepTool = (name: string, then?: () => void): ITool =>
      hostTool(name, async (args: { text?: unknown }) => {
        ran.push(name);
        then?.();
        return { success: true, output: { text: String(args.text) } };
      });
    // step_a stops its turn as it runs, as a deadline or a session's close() would.
    const steps: Record<string, ITool> = { step_a: stepTool('step_a', () => stopTurn()), step_b: stepTool('step_b') };
    const gate = createStepGate({ resolve: (name) => steps[name] });
    const state = (signal: AbortSignal | undefined) => (signal?.aborted === true ? 'stopped' : 'live');
    // The stop each step was handed, by the composition's gate or by the workflow.
    const handed: string[] = [];
    const watched: StepGate = {
      resolve: (name) => gate.resolve(name),
      run: (tool, args, context, signal) => {
        handed.push(`${tool.name} ${state(signal)}`);
        return gate.run(tool, args, context, signal);
      },
    };
    const composed = new ComposableToolBuilder(watched).build('a_then_b', 'Runs step_a, then step_b.', { type: 'object', properties: { text: { type: 'string' } } }, {
      mode: 'compose',
      steps: [
        { name: 'a', tool: 'step_a', inputMapping: { text: '$input.text' } },
        { name: 'b', tool: 'step_b', inputMapping: { text: '$prev.text' } },
      ],
    });
    const workflows = new CreateWorkflowTool({
      config: { maxSteps: 4, allowedTools: ['step_a', 'step_b'] },
      listTools: () => Object.keys(steps),
      // The host runs each workflow step through its gate, with the stop the workflow hands it.
      executeTool: async (name, args, context, signal) => {
        handed.push(`${name} ${state(signal)}`);
        const outcome = await gate.run(steps[name], args as Record<string, unknown>, context!, signal);
        if (!outcome.success) throw new Error(outcome.error);
        return outcome.output;
      },
    });
    const s = script('openai', k, {
      replies: [
        reply.tools([{ id: 'c1', name: 'a_then_b', args: { text: 'go' } }]),
        // The workflow is stored, then run, in one step.
        reply.tools([
          {
            id: 'w1',
            name: 'create_workflow',
            args: { action: 'create', name: 'a_then_b', description: 'Runs step_a, then step_b.', steps: [{ tool: 'step_a', args: { text: '$input' } }, { tool: 'step_b', args: { text: '$prev' } }] },
          },
          { id: 'w2', name: 'create_workflow', args: { action: 'run', workflowId: 'workflow-1', input: 'go' } },
        ]),
      ],
    });
    const runner = gmi({ ...route(k), instructions: 'Run the steps.', tools: { a_then_b: composed, create_workflow: workflows } });
    const session = runner.session('r1');
    /** A send under a signal of its own, which step_a aborts; 'stopped' when the send rejects with that signal's reason. */
    const sendStopping = async (text: string): Promise<unknown> => {
      const caller = new AbortController();
      const reason = new Error(`stopped: ${text}`);
      stopTurn = () => caller.abort(reason);
      return session.send(text, { abortSignal: caller.signal }).then(
        () => 'resolved',
        (error: unknown) => (error === reason ? 'stopped' : error),
      );
    };

    // The composition: step a ran and stopped the turn; step b was handed the stop and refused before its tool.
    expect(await sendStopping('Run the composition.')).toBe('stopped');
    expect(ran).toEqual(['step_a']);
    expect(handed).toEqual(['step_a live', 'step_b stopped']);
    expect(lastKept(session)).toMatchObject({ role: 'tool', tool_call_id: 'c1', partial: true });
    expect(String(lastKept(session).content)).toContain('step_aborted: the step was stopped before its tool ran');
    expect(String(lastKept(session).content)).toContain('"completed":["a"]');

    // The workflow: its step b was handed the stop its call carries, joined with the step's own timer, and refused.
    expect(await sendStopping('Run the workflow.')).toBe('stopped');
    expect(ran).toEqual(['step_a', 'step_a']);
    expect(handed).toEqual(['step_a live', 'step_b stopped', 'step_a live', 'step_b stopped']);
    const stored = session.messages().find((m) => m.role === 'tool' && m.tool_call_id === 'w1');
    expect(String(stored?.content)).toContain('"workflowId":"workflow-1"');
    expect(lastKept(session)).toMatchObject({ role: 'tool', tool_call_id: 'w2', partial: true });
    expect(String(lastKept(session).content)).toContain('Workflow failed at step 1');
    expect(String(lastKept(session).content)).toContain('step_aborted: the step was stopped before its tool ran');
    // Nothing was sent after either stop.
    expect(s.seen).toHaveLength(2);
  });

  it("a launch takes its share of what the parent's budget has left after the step that called it, is held to that cap, and is charged to that budget", async () => {
    const k = key();
    const twoSeats = { goal: 'Two parts.', seats: [{ role: 'first', instructions: 'Part one.' }, { role: 'second', instructions: 'Part two.' }] };
    const s = script('openai', k, {
      replies: [toolsCosting([{ id: 'l1', name: LAUNCH_AGENCY_TOOL_NAME, args: twoSeats }], 6_000), textCosting('Part one done.', 6_000), reply.text('Partial.')],
    });
    const budget = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 20_000, unpriced: 'allow' });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 2_000, budget, agencies: { launch: true } });

    const result = await parent.session('p1').send('Go.');
    const out = launchOf(result);
    // The parent's step (6,000 tokens, at no price) was counted before its tool ran: the launch takes half of the
    // 14,000 tokens and of the $1 left.
    expect(out.provenance.budget).toMatchObject({ maxTotalTokens: 7_000, maxCostUSD: 0.5, tokensUsed: 6_000 });
    // Its own cap refused the second seat's call, which would pass it, before the call's request.
    expect(out.status).toBe('budget_exhausted');
    expect(out.reason).toMatch(/^the launch's budget refused a call: \d+ tokens would pass 7000$/);
    expect(Number(out.reason?.match(/(\d+) tokens/)?.[1])).toBeGreaterThanOrEqual(8_000);
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['first', 'completed'], ['second', 'cut']]);
    // Root, first, root.
    expect(s.seen).toHaveLength(3);
    expect(result.text).toBe('Partial.');
    // The parent's budget holds its own two steps (6,000 and 15 tokens) and the first seat's 6,000.
    expect(budget.tokensUsed()).toBe(12_015);
  });

  it("a launch draws on the budget its turn carries, a send's or a generate() call's, in place of the agent's own", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        toolsCosting([{ id: 'l1', name: LAUNCH_AGENCY_TOOL_NAME, args: oneSeat('solver') }], 6_000),
        textCosting('Solved.', 1_000),
        reply.text('Sent.'),
        toolsCosting([{ id: 'l2', name: LAUNCH_AGENCY_TOOL_NAME, args: oneSeat('solver') }], 6_000),
        reply.text('No team.'),
      ],
    });
    const own = new SpendBudget({ maxCostUSD: 10, maxTotalTokens: 100_000, unpriced: 'allow' });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 2_000, budget: own, agencies: { launch: true, budgetShare: 0.25 } });

    // The send's budget: a quarter of the 34,000 tokens and of the $2 it has left after the step that called the tool.
    const sendBudget = new SpendBudget({ maxCostUSD: 2, maxTotalTokens: 40_000, unpriced: 'allow' });
    const sent = await parent.session('p1').send('Go.', { budget: sendBudget });
    expect(launchOf(sent)).toMatchObject({ status: 'completed', text: 'Solved.', provenance: { budget: { maxTotalTokens: 8_500, maxCostUSD: 0.5, tokensUsed: 1_000 } } });
    expect(sent.text).toBe('Sent.');
    // The send's budget holds its two steps (6,000 and 15 tokens) and the seat's 1,000.
    expect(sendBudget.tokensUsed()).toBe(7_015);

    // A generate() call's budget: a quarter of the 8,000 tokens it has left is 2,000, below one call of the route.
    const generated = await parent.generate('Go.', { budget: new SpendBudget({ maxCostUSD: 2, maxTotalTokens: 14_000, unpriced: 'allow' }) });
    expect(refusalOf(generated, 0)).toBe("budget_unavailable: the launch's token cap, 2000, cannot cover one call (4000: 2000 for the prompt and 2000 for the output)");
    expect(generated.text).toBe('No team.');
    // The send's three calls and the generate() call's two.
    expect(s.seen).toHaveLength(5);
    // The agent's own budget took no part in either.
    expect(own.tokensUsed()).toBe(0);
  });

  it('a parent with no budget draws on its launch pool, and a cap below one call of its route is refused before any seat runs', async () => {
    const twoSeats = { goal: 'Two parts.', seats: [{ role: 'first', instructions: 'Part one.' }, { role: 'second', instructions: 'Part two.' }] };
    const k = key();
    const s = script('openai', k, { replies: [launchStep(twoSeats), textCosting('Part one done.', 2_500), reply.text('Partial.')] });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 3_000 } });

    const result = await parent.session('p1').send('Go.');
    const out = launchOf(result);
    // The pool's 3,000 tokens, and no dollar cap.
    expect(out.provenance.budget).toMatchObject({ maxTotalTokens: 3_000, tokensUsed: 2_500 });
    expect(out.provenance.budget.maxCostUSD).toBeUndefined();
    // The pool refused the second seat's call before its request.
    expect(out.status).toBe('budget_exhausted');
    expect(out.reason).toMatch(/^a budget the team draws on refused a call: \d+ tokens would pass 3000$/);
    expect(Number(out.reason?.match(/(\d+) tokens/)?.[1])).toBeGreaterThanOrEqual(3_500);
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['first', 'completed'], ['second', 'cut']]);
    expect(s.seen).toHaveLength(3);
    expect(result.text).toBe('Partial.');

    // 2,500 cannot cover one call: 2,000 for the prompt and the route's 1,000 output tokens.
    const k2 = key();
    const s2 = script('openai', k2, { replies: [launchStep(twoSeats), reply.text('No team.')] });
    const poor = gmi({ ...route(k2), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 2_500 } });
    const refused = await poor.session('p2').send('Go.');
    expect(refusalOf(refused, 0)).toBe("budget_unavailable: the launch's token cap, 2500, cannot cover one call (3000: 2000 for the prompt and 1000 for the output)");
    expect(refused.text).toBe('No team.');
    expect(s2.seen).toHaveLength(2);
  });

  it("the one-call floor holds the route's maxTokens to the output ceiling of the model the agent resolved", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'c1', name: LAUNCH_AGENCY_TOOL_NAME, args: { ...oneSeat('answerer'), maxTokens: 18_000 } },
          { id: 'c2', name: LAUNCH_AGENCY_TOOL_NAME, args: oneSeat('answerer') },
        ]),
        reply.text('Answered.'),
        reply.text('Done.'),
      ],
    });
    // No model named: the agent runs on OpenAI's default, gpt-4o, which writes at most 16,384 tokens a call.
    const parent = gmi({ provider: 'openai', apiKey: k, fallbackProviders: [], instructions: 'Coordinate.', maxTokens: 32_000, agencies: { launch: true, maxLaunchTokens: 20_000 } });

    const result = await parent.session('p1').send('Go.');
    // 18,000 cannot cover one call: 2,000 for the prompt and the 16,384 a call of the route writes at most.
    expect(refusalOf(result, 0)).toBe("budget_unavailable: the launch's token cap, 18000, cannot cover one call (18384: 2000 for the prompt and 16384 for the output)");
    // The pool's 20,000 can: the seat runs on the agent's route, with its maxTokens.
    expect(launchOf(result, 1)).toMatchObject({ status: 'completed', text: 'Answered.' });
    expect(s.seen.map((call) => call.modelId)).toEqual(['gpt-4o', 'gpt-4o', 'gpt-4o']);
    expect(s.seen[1].options.maxTokens).toBe(32_000);
    expect(result.text).toBe('Done.');
  });

  it("a team a member launches from its seat is floored on the member's own route", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        // The member takes the root team's one seat, and may launch from it.
        launchStep({ goal: 'Plan the trip.', seats: [{ role: 'lead', agentKey: 'planner', tools: [LAUNCH_AGENCY_TOOL_NAME] }] }),
        // Its seat turn: a team of one under a 5,000-token cap, whose seat would run on the member's route.
        launchStep({ goal: 'Draft the plan.', maxTokens: 5_000, seats: [{ role: 'drafter', instructions: 'Draft the plan.' }] }, 'n1'),
        reply.text('No team.'),
        reply.text('Planned.'),
      ],
    });
    const planner = gmi({ ...route(k), name: 'Planner', instructions: 'You plan trips.', maxTokens: 8_000, agencies: { launch: true } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, members: { planner } } });

    const result = await parent.session('p1').send('Plan a trip.');
    expect(launchOf(result)).toMatchObject({ status: 'completed', text: 'No team.' });
    expect(systemText(s.seen[1])).toContain('You plan trips.');
    // 5,000 covers one call of the root's route (3,000), not one of the member's: 2,000 for the prompt and its 8,000.
    expect(toolText(s.seen[2], 'n1')).toContain("budget_unavailable: the launch's token cap, 5000, cannot cover one call (10000: 2000 for the prompt and 8000 for the output)");
    // Root, the member's two steps, root: no drafter call.
    expect(s.seen).toHaveLength(4);
    expect(result.text).toBe('Planned.');
  });

  it("a team of members is floored on the largest call its seats make, each on its member's own route", async () => {
    const k = key();
    const kb = key();
    const kw = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'c1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Answer.', maxTokens: 5_000, seats: [{ role: 'answerer', agentKey: 'brief' }] } },
          {
            id: 'c2',
            name: LAUNCH_AGENCY_TOOL_NAME,
            args: { goal: 'Answer.', maxTokens: 18_000, seats: [{ role: 'answerer', agentKey: 'brief' }, { role: 'expander', agentKey: 'wordy' }] },
          },
          { id: 'c3', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Expand.', maxTokens: 20_000, seats: [{ role: 'expander', agentKey: 'wordy' }] } },
        ]),
        reply.text('Done.'),
      ],
    });
    const briefCalls = script('openai', kb, { replies: [reply.text('Short answer.')] });
    const wordyCalls = script('openai', kw, { replies: [reply.text('A long answer.')] });
    // Each member's seat runs on its own route: 1,000 tokens a call on stub-model, and 32,000 on OpenAI's default,
    // gpt-4o, which writes at most 16,384 a call. The launching agent's own route counts 32,000.
    const brief = gmi({ ...route(kb), instructions: 'Answer briefly.', maxTokens: 1_000 });
    const wordy = gmi({ provider: 'openai', apiKey: kw, fallbackProviders: [], instructions: 'Answer at length.', maxTokens: 32_000 });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 32_000, agencies: { launch: true, members: { brief, wordy } } });

    const result = await parent.session('p1').send('Go.');
    // 5,000 covers one call of the brief member's, though not one of the launching agent's route: its seat runs at its
    // own maxTokens.
    expect(launchOf(result, 0)).toMatchObject({ status: 'completed', text: 'Short answer.' });
    expect(briefCalls.seen.map((call) => call.options.maxTokens)).toEqual([1_000]);
    // 18,000 cannot cover one call of the wordy member's, the largest its team makes: refused before a seat is built.
    expect(refusalOf(result, 1)).toBe("budget_unavailable: the launch's token cap, 18000, cannot cover one call (18384: 2000 for the prompt and 16384 for the output)");
    // 20,000 can: the wordy member's seat runs on gpt-4o with its 32,000.
    expect(launchOf(result, 2)).toMatchObject({ status: 'completed', text: 'A long answer.' });
    expect(wordyCalls.seen.map((call) => [call.modelId, call.options.maxTokens])).toEqual([['gpt-4o', 32_000]]);
    expect(briefCalls.seen).toHaveLength(1);
    expect(s.seen).toHaveLength(2);
    expect(result.text).toBe('Done.');
  });

  it("the root launches of one turn share one pool, in its step and its next; the session's next turn and a generate() call each launch from a fresh one", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        // Two launches in one step: the first spends 5,000 of the pool's 6,000.
        reply.tools([
          { id: 'a', name: LAUNCH_AGENCY_TOOL_NAME, args: oneSeat('first') },
          { id: 'b', name: LAUNCH_AGENCY_TOOL_NAME, args: oneSeat('second') },
        ]),
        textCosting('First done.', 5_000),
        // The turn's next step launches again, from the same pool.
        launchStep(oneSeat('third'), 'c'),
        reply.text('One of three ran.'),
        // The session's next turn.
        launchStep(oneSeat('fourth')),
        textCosting('Fourth done.', 5_000),
        reply.text('Ran again.'),
        // A generate() call.
        launchStep(oneSeat('fifth')),
        textCosting('Fifth done.', 5_000),
        reply.text('Generated.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 6_000 } });
    const session = parent.session('p1');
    const fresh = { maxTotalTokens: 6_000, tokensUsed: 5_000 };

    const first = await session.send('Go.');
    expect(launchOf(first, 0)).toMatchObject({ status: 'completed', text: 'First done.', provenance: { budget: fresh } });
    // The 1,000 left cannot cover one call, 2,000 for the prompt and 1,000 for the output, in the same step or the next.
    const unavailable = "budget_unavailable: the launch's token cap, 1000, cannot cover one call (3000: 2000 for the prompt and 1000 for the output)";
    expect(first.toolCalls.map((call) => call.error)).toEqual([undefined, unavailable, unavailable]);
    expect(first.text).toBe('One of three ran.');
    const second = await session.send('Go again.');
    expect(launchOf(second)).toMatchObject({ status: 'completed', text: 'Fourth done.', provenance: { budget: fresh } });
    expect(second.text).toBe('Ran again.');
    const generated = await parent.generate('Go once more.');
    expect(launchOf(generated)).toMatchObject({ status: 'completed', text: 'Fifth done.', provenance: { budget: fresh } });
    expect(generated.text).toBe('Generated.');
    // The refused launches built no seat: three steps and a seat, then two steps and a seat, twice.
    expect(s.seen).toHaveLength(10);
  });

  it("a gmi() agent seated in a host agency launches its teams under the host's gate: the host is asked first on each seat's call, and its refusal is final", async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const asked: string[] = [];
    const searchTool = (execute: (args: { q?: string }) => Promise<string>) => ({
      description: 'Search.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute,
    });
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Look it up.', seats: [{ role: 'finder', instructions: 'Find it.', tools: ['search'] }] }),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.text('Search held.'),
        reply.text('Team done.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', tools: { search: searchTool(search) }, agencies: { launch: true } });
    // The parent is a member of a host agency whose handler refuses search.
    const host = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k,
      strategy: 'sequential',
      hitl: {
        approvals: { beforeTool: ['search'] },
        handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
          asked.push(request.action);
          return { approved: false, reason: 'search is paused' };
        },
      },
      agents: { coordinator: parent },
    });

    const result = await host.generate('Find x.');
    expect(result.text).toBe('Team done.');
    // The launched seat was offered search and called it (the precondition).
    expect(systemText(s.seen[1])).toContain('Find it.');
    expect(offered(s.seen[1])).toEqual(['search']);
    // The host's handler was asked once and refused: search never ran, and the seat's next step read why.
    expect(asked).toEqual(['search']);
    expect(search).not.toHaveBeenCalled();
    expect(toolText(s.seen[2], 's1')).toContain('search is paused');
    // The host's one call record is the parent's; its one tool call is the launch, completed with the seat's answer.
    expect(result.agentCalls.map((call) => call.agent)).toEqual(['coordinator']);
    expect(result.agentCalls[0].toolCalls.map((call) => [call.name, call.error])).toEqual([[LAUNCH_AGENCY_TOOL_NAME, undefined]]);
    expect(result.agentCalls[0].toolCalls[0].result).toMatchObject({ status: 'completed', text: 'Search held.' });
    // Root, the seat's two steps, root.
    expect(s.seen).toHaveLength(4);

    // With agencies.hitl of its own, the team asks the host's gate first and its own only after the host approved; the
    // host approves the seat's first search and refuses its second, and that refusal is final.
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
      ...route(k2),
      instructions: 'Coordinate.',
      tools: {
        search: searchTool(async (args) => {
          ran.push(String(args.q));
          return 'found';
        }),
      },
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['search'] },
          handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
            order.push(`own ${request.action}`);
            return { approved: true };
          },
        },
      },
    });
    const host2 = agency({
      provider: 'openai',
      model: 'stub-model',
      apiKey: k2,
      strategy: 'sequential',
      hitl: {
        approvals: { beforeTool: ['search'] },
        handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
          order.push(`host ${request.action}`);
          hostAsks += 1;
          return hostAsks === 1 ? { approved: true } : { approved: false, reason: 'search is paused' };
        },
      },
      agents: { coordinator: gated },
    });

    const composedGates = await host2.generate('Find x and y.');
    expect(composedGates.text).toBe('Team done.');
    expect(composedGates.agentCalls[0].toolCalls[0].result).toMatchObject({ status: 'completed', text: 'Found x.' });
    expect(order).toEqual(['host search', 'own search', 'host search']);
    expect(ran).toEqual(['x']);
    expect(toolText(s2.seen[3], 's2')).toContain('search is paused');
    // Root, the seat's three steps, root.
    expect(s2.seen).toHaveLength(5);
  });

  it("a gmi() agent's callbacks see each team it launches by its name, from its goal to its answer, a team one of its seats launches through the agent's own tool included, and the root team's agencies.hitl asks once for a level-2 seat's call and reports it to them", async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const asked: Array<[string, string]> = [];
    const agentStart = vi.fn<(e: StartEvent) => void>();
    const agentEnd = vi.fn<(e: EndEvent) => void>();
    const approvalRequested = vi.fn<(e: ApprovalRequest) => void>();
    const approvalDecided = vi.fn<(e: ApprovalDecision) => void>();
    const error = vi.fn<(e: TeamErrorEvent) => void>();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Plan the search.', seats: [{ role: 'lead', instructions: 'Lead.', tools: ['search', LAUNCH_AGENCY_TOOL_NAME] }] }),
        launchStep({ goal: 'Search.', seats: [{ role: 'finder', instructions: 'Find.', tools: ['search'] }] }, 'n1'),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.text('Found.'),
        reply.text('Lead done.'),
        reply.text('All done.'),
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: search } },
      on: { agentStart, agentEnd, approvalRequested, approvalDecided, error },
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['search'] },
          handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
            asked.push([request.action, request.agent]);
            return { approved: true };
          },
        },
      },
    });

    const result = await parent.session('p1').send('Search for x.');
    expect(result.text).toBe('All done.');
    const root = launchOf(result);
    expect(root).toMatchObject({ status: 'completed', text: 'Lead done.', provenance: { depth: 1 } });
    // Root, the lead, the finder's two steps, the lead, root: the finder was offered search and called it (the precondition).
    expect(s.seen).toHaveLength(6);
    expect(systemText(s.seen[2])).toContain('Find.');
    expect(offered(s.seen[2])).toEqual(['search']);
    // The lead's launch made the level-2 team, read from the lead's next step.
    const nested = JSON.parse(toolText(s.seen[4], 'n1')) as LaunchAgencyResult;
    expect(nested).toMatchObject({ status: 'completed', text: 'Found.', provenance: { depth: 2 } });
    const outer = `launch:${root.agencyId}`;
    const inner = `launch:${nested.agencyId}`;
    // The level-2 seat's search was asked once, by the root team's gate, which the level-2 team passed on, and ran once.
    expect(asked).toEqual([['search', outer]]);
    expect(search).toHaveBeenCalledTimes(1);
    // The agent's callbacks saw the approval, from the root team's gate.
    expect(approvalRequested).toHaveBeenCalledTimes(1);
    expect(approvalRequested).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool', agent: outer, action: 'search' }));
    expect(approvalDecided).toHaveBeenCalledTimes(1);
    expect(approvalDecided).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
    // They saw each team by its name, from its goal to its answer, the lead's team inside the root's.
    expect(agentStart.mock.calls.map(([e]) => [e.agent, e.input])).toEqual([[outer, 'Plan the search.'], [inner, 'Search.']]);
    expect(agentEnd.mock.calls.map(([e]) => [e.agent, e.output])).toEqual([[inner, 'Found.'], [outer, 'Lead done.']]);
    expect(agentEnd).toHaveBeenCalledWith(expect.objectContaining({ agent: outer, durationMs: expect.any(Number) }));
    expect(error).not.toHaveBeenCalled();
  });

  it("a member that launches from its seat reports that team to its own callbacks, the launching agent's see only the team it launched, and a callback that throws or rejects fails no launch", async () => {
    const k = key();
    const rootSaw: string[] = [];
    const scoutSaw: string[] = [];
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Scout it.', seats: [{ role: 'scout', agentKey: 'scout', tools: [LAUNCH_AGENCY_TOOL_NAME] }] }),
        // The member's seat turn launches through its own launch_agency.
        launchStep({ goal: 'Look around.', seats: [{ role: 'eye', instructions: 'Look around.' }] }, 'n1'),
        reply.text('Seen.'),
        reply.text('Scouted.'),
        reply.text('Done.'),
      ],
    });
    const scout = gmi({
      ...route(k),
      name: 'Scout',
      instructions: 'You scout.',
      on: {
        agentStart: (e: StartEvent) => scoutSaw.push(`start ${e.agent} ${e.input}`),
        agentEnd: (e: EndEvent) => scoutSaw.push(`end ${e.agent} ${e.output}`),
      },
      agencies: { launch: true },
    });
    // The launching agent's callbacks record the event, then throw or reject.
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      on: {
        agentStart: (e: StartEvent) => {
          rootSaw.push(`start ${e.agent} ${e.input}`);
          throw new Error('the host callback broke');
        },
        agentEnd: async (e: EndEvent) => {
          rootSaw.push(`end ${e.agent} ${e.output}`);
          throw new Error('the host callback broke');
        },
      },
      agencies: { launch: true, maxDepth: 2, members: { scout } },
    });

    const result = await parent.session('p1').send('Scout it.');
    // The callbacks that threw and rejected failed nothing: the launch completed and the parent's turn went on.
    expect(result.text).toBe('Done.');
    const root = launchOf(result);
    expect(root).toMatchObject({ status: 'completed', text: 'Scouted.' });
    expect(root.seats).toEqual([expect.objectContaining({ role: 'scout', form: 'persistent', member: 'scout', status: 'completed' })]);
    // Root, the member's two steps around the eye's one call, root.
    expect(s.seen).toHaveLength(5);
    expect(systemText(s.seen[1])).toContain('You scout.');
    const nested = JSON.parse(toolText(s.seen[3], 'n1')) as LaunchAgencyResult;
    expect(nested).toMatchObject({ status: 'completed', text: 'Seen.', provenance: { depth: 2, parentSessionId: `seat:${root.agencyId}:scout` } });
    // Each agent's callbacks saw the team its own tool launched, and only that team.
    expect(rootSaw).toEqual([`start launch:${root.agencyId} Scout it.`, `end launch:${root.agencyId} Scouted.`]);
    expect(scoutSaw).toEqual([`start launch:${nested.agencyId} Look around.`, `end launch:${nested.agencyId} Seen.`]);
  });

  it("a team whose agencies.hitl handler fails is reported to the agent's error callback by its name and never ends, and the launch returns failed with no word of the handler's message", async () => {
    const k = key();
    const search = vi.fn(async () => 'found');
    const thrown = new Error('approver offline');
    const agentStart = vi.fn<(e: StartEvent) => void>();
    const agentEnd = vi.fn<(e: EndEvent) => void>();
    const approvalRequested = vi.fn<(e: ApprovalRequest) => void>();
    const approvalDecided = vi.fn<(e: ApprovalDecision) => void>();
    const error = vi.fn<(e: TeamErrorEvent) => void>();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Look it up.', seats: [{ role: 'finder', instructions: 'Find it.', tools: ['search'] }] }),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.text('No search.'),
        reply.text('Handled.'),
      ],
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { search: { description: 'Search.', parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: search } },
      on: { agentStart, agentEnd, approvalRequested, approvalDecided, error },
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['search'] },
          handler: async (): Promise<ApprovalDecision> => {
            throw thrown;
          },
        },
      },
    });

    const result = await parent.session('p1').send('Find x.');
    // The parent's turn went on past the failed team.
    expect(result.text).toBe('Handled.');
    const out = launchOf(result);
    expect(out.status).toBe('failed');
    expect(out.reason ?? '').not.toContain('approver offline');
    const team = `launch:${out.agencyId}`;
    // Root, the seat's two steps, root. The seat's call was refused: the seat's model is told only that the handler failed.
    expect(s.seen).toHaveLength(4);
    expect(search).not.toHaveBeenCalled();
    expect(toolText(s.seen[2], 's1')).toContain('the approval handler failed');
    expect(toolText(s.seen[2], 's1')).not.toContain('approver offline');
    expect(JSON.stringify(s.seen[3].messages)).not.toContain('approver offline');
    // The agent's callbacks: the team started and asked; its handler's error went to error once, under the team's name;
    // no decision came and the team never ended.
    expect(agentStart.mock.calls.map(([e]) => [e.agent, e.input])).toEqual([[team, 'Look it up.']]);
    expect(approvalRequested).toHaveBeenCalledTimes(1);
    expect(approvalRequested).toHaveBeenCalledWith(expect.objectContaining({ agent: team, action: 'search' }));
    // Read by the team's name: the agent's own failure reports may reach error under other names.
    const teamErrors = error.mock.calls.map(([e]) => e).filter((e) => e.agent === team);
    expect(teamErrors).toHaveLength(1);
    expect(teamErrors[0].error).toBe(thrown);
    expect(approvalDecided).not.toHaveBeenCalled();
    expect(agentEnd).not.toHaveBeenCalled();
  });

  it("a stop that comes during the tool round of a turn's last step ends the send as it does in an earlier step: with the caller's reason, or the abort error after close()", async () => {
    const state = (signal: AbortSignal | undefined) => (signal?.aborted === true ? 'stopped' : 'live');
    // maxSteps 1: the tool round is the turn's last step, and no model call follows it to read the stop.
    const k = key();
    const caller = new AbortController();
    const stopped = new Error('the caller stopped the turn');
    const signals: string[] = [];
    const s = script('openai', k, { replies: [reply.tools([{ id: 'w1', name: 'write', args: {} }]), reply.text('Still here.')] });
    const writer = gmi({
      ...route(k),
      instructions: 'Write.',
      maxSteps: 1,
      tools: {
        write: hostTool('write', async (_args, context) => {
          signals.push(`start ${state(context.signal)}`);
          caller.abort(stopped);
          signals.push(`after the stop ${state(context.signal)}`);
          return { success: true, output: 'written' };
        }),
      },
    });
    const session = writer.session('w1');

    await expect(session.send('Go.', { abortSignal: caller.signal })).rejects.toBe(stopped);
    // The running call finished with the stop on its signal; no request came after it.
    expect(signals).toEqual(['start live', 'after the stop stopped']);
    expect(s.seen).toHaveLength(1);
    // The step is kept, marked partial, and the session stays open.
    expect(lastKept(session)).toMatchObject({ role: 'tool', tool_call_id: 'w1', partial: true });
    await expect(session.send('Again.')).resolves.toMatchObject({ text: 'Still here.' });

    // The session's close(), which the running tool calls.
    const k2 = key();
    let closing!: AgentSession;
    let closed: Promise<void> | undefined;
    const s2 = script('openai', k2, { replies: [reply.tools([{ id: 'w1', name: 'write', args: {} }])] });
    const closer = gmi({
      ...route(k2),
      instructions: 'Write.',
      maxSteps: 1,
      tools: {
        write: hostTool('write', async () => {
          closed = closing.close();
          return { success: true, output: 'written' };
        }),
      },
    });
    closing = closer.session('c1');

    await expect(closing.send('Go.')).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR', message: expect.stringMatching(/abort/i) });
    await expect(closed).resolves.toBeUndefined();
    expect(s2.seen).toHaveLength(1);
  });

  it('a member that sets no maxTokens is floored on the controls.maxTotalTokens its calls are sent with, and one that sets both on its maxTokens', async () => {
    const k = key();
    const kl = key();
    const kb = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          { id: 'c1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Answer.', maxTokens: 7_000, seats: [{ role: 'answerer', agentKey: 'long' }] } },
          { id: 'c2', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Answer.', maxTokens: 5_000, seats: [{ role: 'answerer', agentKey: 'both' }] } },
        ]),
        reply.text('Done.'),
      ],
    });
    const longCalls = script('openai', kl, { replies: [reply.text('A long answer.')] });
    const bothCalls = script('openai', kb, { replies: [reply.text('Short answer.')] });
    const long = gmi({ ...route(kl), instructions: 'Answer at length.', controls: { maxTotalTokens: 8_000 } });
    const both = gmi({ ...route(kb), instructions: 'Answer briefly.', maxTokens: 1_000, controls: { maxTotalTokens: 8_000 } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', maxTokens: 1_000, agencies: { launch: true, members: { long, both } } });

    const result = await parent.session('p1').send('Go.');
    // 7,000 cannot cover one call of the member whose calls are sent with its 8,000: refused before its seat is built.
    expect(refusalOf(result, 0)).toBe("budget_unavailable: the launch's token cap, 7000, cannot cover one call (10000: 2000 for the prompt and 8000 for the output)");
    expect(longCalls.seen).toHaveLength(0);
    // A member that sets maxTokens sends its calls with it, and is floored on it: 5,000 covers 2,000 and its 1,000.
    expect(launchOf(result, 1)).toMatchObject({ status: 'completed', text: 'Short answer.' });
    expect(bothCalls.seen.map((call) => call.options.maxTokens)).toEqual([1_000]);
    expect(s.seen).toHaveLength(2);
    expect(result.text).toBe('Done.');
  });

  it("every tool call of a launched team runs the launching turn's tool hooks first, a member's before its own: the parent's rewrite reaches the member's hook and tool, its skip is final, and a temporary seat runs the parent's hook once", async () => {
    const k = key();
    const hooked: string[] = [];
    const ran: string[] = [];
    const parentSend = vi.fn(async () => 'parent sent');
    const clerkSend = vi.fn(async () => 'clerk sent');
    const sendTool = (execute: () => Promise<string>) => ({ description: 'Sends an email.', parameters: { type: 'object', properties: { to: { type: 'string' } } }, execute });
    const lookupTool = (owner: string) => ({
      description: 'Looks up a record.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute: async (args: { q?: string }) => {
        ran.push(`${owner} ${String(args.q)}`);
        return 'found';
      },
    });
    const s = script('openai', k, {
      replies: [
        launchStep({
          goal: 'Mail and check.',
          seats: [
            { role: 'clerk', agentKey: 'clerk', tools: ['send_email', 'lookup'] },
            { role: 'writer', instructions: 'Write it up.', tools: ['lookup'] },
          ],
        }),
        reply.tools([{ id: 'e1', name: 'send_email', args: { to: 'team' } }, { id: 'q1', name: 'lookup', args: { q: 'x' } }]),
        reply.text('Clerk done.'),
        reply.tools([{ id: 'w1', name: 'lookup', args: { q: 'y' } }]),
        reply.text('Writer done.'),
        reply.text('Done.'),
      ],
    });
    const clerk = gmi({
      ...route(k),
      name: 'Clerk',
      instructions: 'You file mail.',
      tools: { send_email: sendTool(clerkSend), lookup: lookupTool('clerk') },
      // The member's own hook allows every call.
      onBeforeToolExecution: async (info) => {
        hooked.push(`clerk ${info.name}${info.args.q !== undefined ? ` ${String(info.args.q)}` : ''}`);
        return info;
      },
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { send_email: sendTool(parentSend), lookup: lookupTool('parent') },
      // The parent's hook skips every email and marks every lookup.
      onBeforeToolExecution: async (info) => {
        hooked.push(`parent ${info.name}${info.args.q !== undefined ? ` ${String(info.args.q)}` : ''}`);
        if (info.name === 'send_email') return null;
        return info.name === 'lookup' ? { ...info, args: { ...info.args, q: `${String(info.args.q)} (checked)` } } : info;
      },
      agencies: { launch: true, members: { clerk } },
    });

    const result = await parent.session('p1').send('Mail the team and check x.');
    expect(result.text).toBe('Done.');
    expect(launchOf(result)).toMatchObject({ status: 'completed', text: 'Writer done.' });
    // Root, the clerk's two steps, the writer's two steps, root.
    expect(s.seen).toHaveLength(6);
    // The clerk was offered both tools and called both (the precondition).
    expect([...offered(s.seen[1])].sort()).toEqual(['lookup', 'send_email']);
    // The parent's hook ran first on each of the team's calls: its skip was final (the clerk's hook never saw the email),
    // and its rewrite is what the clerk's hook and tool received. The writer's call ran the parent's hook once.
    expect(hooked).toEqual(['parent launch_agency', 'parent send_email', 'parent lookup x', 'clerk lookup x (checked)', 'parent lookup y']);
    expect(clerkSend).not.toHaveBeenCalled();
    expect(parentSend).not.toHaveBeenCalled();
    expect(toolText(s.seen[2], 'e1')).toContain('Skipped by onBeforeToolExecution hook');
    // Each seat ran its own tool instances: the clerk its own, the writer the parent's.
    expect(ran).toEqual(['clerk x (checked)', 'parent y (checked)']);
  });

  it("a temporary seat runs under the launching agent's generation hooks and request timeout, and a member runs as itself under its own", async () => {
    const k = key();
    const policy = 'Policy: no customer names.';
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Send the note.', seats: [{ role: 'mailer', agentKey: 'mailer' }, { role: 'writer', instructions: 'Write the note.' }] }),
        reply.text('Note sent.'),
        reply.text('Note written.'),
        reply.text('Done.'),
      ],
    });
    const mailer = gmi({ ...route(k), name: 'Mailer', instructions: 'You send mail.' });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      onBeforeGeneration: async (context) => ({ ...context, messages: [...context.messages, { role: 'system', content: policy }] }),
      onAfterGeneration: async (step) => ({ ...step, text: step.text.replace('Note', 'Memo') }),
      controls: { maxDurationMs: 45_000 },
      agencies: { launch: true, members: { mailer } },
    });

    const result = await parent.session('p1').send('Send it.');
    expect(result.text).toBe('Done.');
    const out = launchOf(result);
    // Root, the mailer, the writer, root.
    expect(s.seen).toHaveLength(4);
    // The parent's own calls run under its hooks and its request timeout (the precondition).
    expect(systemText(s.seen[0])).toContain(policy);
    expect(s.seen[0].options.requestTimeout).toBe(45_000);
    // The writer, a temporary seat, runs under them too: its request carries the rewrite and the timeout, and its answer,
    // the team's, the parent's onAfterGeneration rewrite.
    expect(systemText(s.seen[2])).toContain('Write the note.');
    expect(systemText(s.seen[2])).toContain(policy);
    expect(s.seen[2].options.requestTimeout).toBe(45_000);
    expect(out).toMatchObject({ status: 'completed', text: 'Memo written.' });
    // The mailer, a member, runs as itself: none of the parent's hooks or its timeout reach its call or its answer.
    expect(systemText(s.seen[1])).toContain('You send mail.');
    expect(systemText(s.seen[1])).not.toContain(policy);
    expect(s.seen[1].options.requestTimeout).not.toBe(45_000);
    expect(out.seats.map((seat) => [seat.role, seat.summary])).toEqual([['mailer', 'Note sent.'], ['writer', 'Memo written.']]);
  });

  it("a team a member launches from its seat runs the tool hooks that seat's turn ran under, the root's and then the member's, once each", async () => {
    const k = key();
    const hooked: string[] = [];
    const ran: string[] = [];
    const searchTool = (owner: string) => ({
      description: 'Search.',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      execute: async (args: { q?: string }) => {
        ran.push(`${owner} ${String(args.q)}`);
        return 'found';
      },
    });
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Scout it.', seats: [{ role: 'scout', agentKey: 'scout', tools: [LAUNCH_AGENCY_TOOL_NAME, 'search'] }] }),
        // The member's seat turn launches through its own launch_agency.
        launchStep({ goal: 'Look.', seats: [{ role: 'eye', instructions: 'Look.', tools: ['search'] }] }, 'n1'),
        reply.tools([{ id: 'x1', name: 'search', args: { q: 'x' } }]),
        reply.text('Seen.'),
        reply.text('Scouted.'),
        reply.text('Done.'),
      ],
    });
    const scout = gmi({
      ...route(k),
      name: 'Scout',
      instructions: 'You scout.',
      tools: { search: searchTool('scout') },
      onBeforeToolExecution: async (info) => {
        hooked.push(`scout ${info.name}`);
        return info;
      },
      agencies: { launch: true },
    });
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      tools: { search: searchTool('parent') },
      onBeforeToolExecution: async (info) => {
        hooked.push(`root ${info.name}`);
        return info;
      },
      agencies: { launch: true, maxDepth: 2, members: { scout } },
    });

    const result = await parent.session('p1').send('Scout it.');
    expect(result.text).toBe('Done.');
    expect(launchOf(result)).toMatchObject({ status: 'completed', text: 'Scouted.' });
    // Root, the scout's two steps around the eye's two, root.
    expect(s.seen).toHaveLength(6);
    const nested = JSON.parse(toolText(s.seen[4], 'n1')) as LaunchAgencyResult;
    expect(nested).toMatchObject({ status: 'completed', text: 'Seen.', provenance: { depth: 2 } });
    // The root's turn ran the root's hook; the scout's seat turn ran the root's, then its own; the eye's call, in the team
    // the scout launched, ran those two in that order, once each: the eye, a temporary seat, has no tool hook of its own.
    expect(hooked).toEqual(['root launch_agency', 'root launch_agency', 'scout launch_agency', 'root search', 'scout search']);
    // The eye ran the scout's own search, the tool instance of the agent that launched its team.
    expect(ran).toEqual(['scout x']);
  });
});
