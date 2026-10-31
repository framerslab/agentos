/**
 * `agencies` and `launch_agency` as a host uses the package. Every agent, tool and type comes from the package's root
 * index, the module `@framers/agentos` resolves to, and a composition or a workflow a host builds from the module the
 * package's `./emergent` entry serves (the launch types also from the one its `./api` entry serves); only the provider
 * classes are stubbed (helpers/stubProviders.ts), at their module boundary, so the real gmi(), agent(), agency(),
 * launch engine, provider manager, completion gateway, GMI and tool orchestrator run, with no network and no key. Each
 * case reads only what a host can observe: the types the package names for it, the tools a model call is
 * offered, the requests the provider receives, a send's tool calls and their results, the context a host's own tool is
 * handed, a session's kept messages, the events an agent's callbacks receive, the approvals a host's handler is asked,
 * budgets, warnings and construction errors. On the full runtime (`AgentOS.create()` with `agencies`) the cases read the
 * same, and what the runtime itself shows a host: the agencies it lists, the GMIs its snapshot names, the logger it was
 * given, the approvals its own HITL manager is asked and the errors it starts with, and the key and base URL each
 * provider it starts was given.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The provider class alone is replaced: the package root reads the module's other exports (its default base URL). It is
// the repository's stub, and a script that sets `answerWhole` answers each unstreamed call with that text and spends no
// reply: what the full runtime's own unstreamed calls (an emergent judge's, a parallel team's synthesizer's) receive.
// Each provider that starts records on its script the key and base URL it was started with, and each unstreamed call it
// answers records them beside the call's model.
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => {
  const { stubProviderClass } = await import('./helpers/stubProviders');
  const Stub = stubProviderClass('openai');
  class OpenAIProvider extends Stub {
    /** The key and base URL this provider was started with. */
    startedWith: StartedWith = {};
    override async initialize(config: { apiKey?: string; baseURL?: string }): Promise<void> {
      await super.initialize(config);
      this.startedWith = {
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      };
      ((this.script as WholeAnswering).starts ??= []).push({ ...this.startedWith });
    }
    override async generateCompletion(...args: Parameters<InstanceType<typeof Stub>['generateCompletion']>) {
      const s = this.script as WholeAnswering | undefined;
      const answer = s?.answerWhole;
      if (s === undefined || answer === undefined) return super.generateCompletion(...args);
      (s.wholeSeen ??= []).push(JSON.stringify(args[1]));
      (s.wholeFrom ??= []).push({ modelId: args[0], ...this.startedWith });
      return {
        id: 'stub',
        object: 'chat.completion',
        created: 0,
        modelId: args[0],
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finishReason: 'stop' }],
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      };
    }
  }
  return {
    ...(await importOriginal<typeof import('../../core/llm/providers/implementations/OpenAIProvider')>()),
    OpenAIProvider,
  };
});
import {
  AgencyConfigError,
  AgentOS,
  AgentOSResponseChunkType,
  AgentOSServiceError,
  GMIManagerError,
  GuardrailAction,
  LAUNCH_AGENCY_TOOL_NAME,
  SpendBudget,
  agency,
  agent,
  gmi,
  readRecordedAgentOSUsageEvents,
} from '../../index';
import type {
  AgencyCallbacks,
  AgencyLaunchFrame,
  AgencyLaunchOptions,
  AgencySession,
  AgentOSInput,
  AgentOSResponse,
  AgentOSToolCallRequestChunk,
  AgentSession,
  ApprovalDecision,
  ApprovalRequest,
  CallerTurnContext,
  GenerateTextResult,
  GuardrailOutputPayload,
  IGuardrailService,
  ILogger,
  IPersonaDefinition,
  IRetrievalAugmentor,
  ITool,
  LaunchAgencyResult,
  LaunchLimits,
  LaunchRecordMetadata,
  RagRetrievedChunk,
  RuntimeAgencyLaunchOptions,
  ToolCallHook,
  ToolExecutionContext,
  UserFeedbackPayload,
} from '../../index';
// The module the package's './api' entry serves, which names the launch types as the root does.
import type * as ApiEntry from '../index';
// The module the package's './emergent' entry serves: the parts a host builds a composition or a workflow from.
import { ComposableToolBuilder, CreateWorkflowTool, checkChainable, createStepGate } from '../../cognition/emergent/index';
import type { StepGate } from '../../cognition/emergent/index';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

/** The key and base URL a provider was started with, each when it was given one. */
type StartedWith = { apiKey?: string; baseURL?: string };
/**
 * A script whose provider answers unstreamed calls itself (see the provider mock above), and those calls' messages; for
 * each of those calls its model and what its provider was started with; and each start of a provider that plays it.
 */
type WholeAnswering = ProviderScript & {
  answerWhole?: string;
  wholeSeen?: string[];
  wholeFrom?: Array<{ modelId: string } & StartedWith>;
  starts?: StartedWith[];
};

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
/** A provider's error whose message holds a credential, as a provider's message can. */
const providerFailure = (canary: string): Error =>
  Object.assign(new Error(`upstream refused key ${canary}`), { name: 'ProviderError', code: 'E_UPSTREAM' });
/** None of `texts` carries a word of a failure's message (see `providerFailure`). */
const expectNoWordOf = (canary: string, texts: string[]): void => {
  for (const text of texts) {
    expect(text).not.toContain('upstream refused');
    expect(text).not.toContain(canary);
  }
};
/** A host's callbacks as an instance of its own class, whose error method reads `this`. */
class HostCallbacks {
  readonly reports: TeamErrorEvent[] = [];
  error(event: TeamErrorEvent): void {
    this.reports.push(event);
  }
}

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

  it("a seat whose call fails hands its team the error's name and code alone: a hierarchical manager's next request, the result and the parent's next request carry no word of its message, and the agent's error callback receives the original once, under the seat's name", async () => {
    const k = key();
    const canary = 'sk-CANARY-7070';
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Check the claim.', strategy: 'hierarchical', seats: [{ role: 'checker', instructions: 'Check claims.' }] }),
        // The manager, on agent()'s path, which asks for whole responses, delegates to the checker.
        reply.tools([{ id: 'd1', name: 'delegate_to_checker', args: { task: 'Check it.' } }]),
        // The checker's request fails with a message that holds a credential.
        providerFailure(canary),
        reply.text('The checker could not run.'),
        reply.text('Reported.'),
      ],
      whole: true,
    });
    const on = new HostCallbacks();
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', on, agencies: { launch: true } });
    const session = parent.session('p1');

    const result = await session.send('Check it.');
    expect(result.text).toBe('Reported.');
    // Root, the manager, the checker's failed request, the manager, root: the seat's call failed (the precondition).
    expect(s.seen.map((call) => call.streamed)).toEqual([true, false, true, false, true]);
    expect(offered(s.seen[1])).toContain('delegate_to_checker');
    expect(systemText(s.seen[2])).toContain('Check claims.');
    // The manager's next request reads the delegation's error by its name and code.
    const delegated = toolText(s.seen[3], 'd1');
    expect(delegated).toContain('GMIError (LLM_PROVIDER_ERROR)');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'The checker could not run.' });
    expect(out.seats).toEqual([
      expect.objectContaining({ role: 'checker', form: 'temporary', status: 'failed', calls: 1, error: { name: 'GMIError', code: 'LLM_PROVIDER_ERROR' } }),
    ]);
    // No word of the message reaches the manager, the result, the parent's next request, the send or the session.
    expectNoWordOf(canary, [
      delegated,
      JSON.stringify(s.seen[3].messages),
      JSON.stringify(out),
      JSON.stringify(s.seen[4].messages),
      JSON.stringify(result.toolCalls),
      JSON.stringify(session.messages()),
    ]);
    // The manager's two calls (14 and 15 tokens) are the coordinator's, charged to the launch's budget.
    expect(out.coordinatorUsage.totalTokens).toBe(29);
    expect(out.provenance.budget.tokensUsed).toBeGreaterThanOrEqual(29);
    // The agent's error callback received the original error, once, under the seat's name, called on the host's own
    // object: the instance's method found its own reports.
    expect(on.reports).toHaveLength(1);
    expect(on.reports[0]).toMatchObject({ agent: 'launch_agency seat checker', error: { name: 'GMIError', code: 'LLM_PROVIDER_ERROR' } });
    expect(on.reports[0].error.message).toContain(canary);
    expect(on.reports[0].timestamp).toEqual(expect.any(Number));
  });

  it("a team that fails with a member's seat reports the seat's error and then the team's, once, to the launching agent's error callback, names the seat's error by its name and code alone, and with no error callback writes the seat's report and the run's to the console", async () => {
    const k = key();
    const canary = 'sk-CANARY-7171';
    const s = script('openai', k, {
      replies: [
        // A sequential team of one member seat, launched by an agent with an error callback.
        launchStep({ goal: 'Check the claim.', seats: [{ role: 'checker', agentKey: 'tutor' }] }),
        providerFailure(canary),
        reply.text('The team failed.'),
        // The same team, launched by an agent with no callbacks.
        launchStep({ goal: 'Check the claim.', seats: [{ role: 'checker', agentKey: 'tutor' }] }),
        providerFailure(canary),
        reply.text('The team failed again.'),
      ],
    });
    const tutorErrors = vi.fn<(e: TeamErrorEvent) => void>();
    const tutor = gmi({ ...route(k), name: 'Tutor', instructions: 'You check claims.', on: { error: tutorErrors } });
    const errors: TeamErrorEvent[] = [];
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      on: {
        error: (e: TeamErrorEvent) => {
          errors.push(e);
        },
      },
      agencies: { launch: true, members: { tutor } },
    });

    const result = await parent.session('p1').send('Check it.');
    expect(result.text).toBe('The team failed.');
    // Root, the member's failed request, root: the seat ran as the member and its call failed (the precondition).
    expect(s.seen).toHaveLength(3);
    expect(systemText(s.seen[1])).toContain('You check claims.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'failed', reason: "seat 'checker' failed: GMIError (LLM_PROVIDER_ERROR)" });
    expect(out.seats).toEqual([
      expect.objectContaining({ role: 'checker', form: 'persistent', member: 'tutor', status: 'failed', calls: 1, error: { name: 'GMIError', code: 'LLM_PROVIDER_ERROR' } }),
    ]);
    expectNoWordOf(canary, [JSON.stringify(out), JSON.stringify(s.seen[2].messages)]);
    // The launching agent's error callback heard the seat's original error, then the team's, once, which carries the
    // seat's by its name and code alone.
    expect(errors.map((e) => e.agent)).toEqual(['launch_agency seat checker', `launch:${out.agencyId}`]);
    expect(errors[0].error).toMatchObject({ name: 'GMIError', code: 'LLM_PROVIDER_ERROR' });
    expect(errors[0].error.message).toContain(canary);
    for (const e of errors.slice(1)) {
      expect(e.error).toMatchObject({ name: 'GMIError', code: 'LLM_PROVIDER_ERROR', message: 'GMIError (LLM_PROVIDER_ERROR)' });
    }
    // The member's own callbacks hear nothing of a seat it holds in another agent's team.
    expect(tutorErrors).not.toHaveBeenCalled();

    // With no error callback, the console receives each report with its error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const quiet = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true, members: { tutor } } });
    const again = await quiet.session('p2').send('Check it.');
    expect(again.text).toBe('The team failed again.');
    expect(launchOf(again)).toMatchObject({ status: 'failed', reason: "seat 'checker' failed: GMIError (LLM_PROVIDER_ERROR)" });
    const reported = (what: string): unknown[] =>
      warn.mock.calls.filter(([line]) => typeof line === 'string' && line.includes(what)).map(([, error]) => error);
    expect(reported('launch_agency seat checker')).toEqual([expect.objectContaining({ name: 'GMIError', message: expect.stringContaining(canary) })]);
    expect(reported('launch_agency run')).toEqual([expect.objectContaining({ name: 'GMIError', message: 'GMIError (LLM_PROVIDER_ERROR)' })]);
    expect(tutorErrors).not.toHaveBeenCalled();
  });

  it("an error callback that throws or rejects fails no launch: the parent's turn goes on, and the console gets the callback's error and the error it was handed", async () => {
    const k = key();
    const canary = 'sk-CANARY-7272';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = script('openai', k, {
      replies: [
        launchStep({
          goal: 'Check the claim.',
          strategy: 'parallel',
          seats: [
            { role: 'checker', instructions: 'Check claims.' },
            { role: 'verifier', instructions: 'Verify claims.' },
          ],
        }),
        // Both seats' requests fail, and with them the parallel team.
        providerFailure(canary),
        providerFailure(canary),
        reply.text('The team failed.'),
        reply.text('Still here.'),
      ],
    });
    const thrown = new Error('the error callback broke');
    const rejected = new Error('the error callback rejected');
    const heard: string[] = [];
    const parent = gmi({
      ...route(k),
      instructions: 'Coordinate.',
      on: {
        // The checker's report throws; the verifier's rejects.
        error: (e: TeamErrorEvent) => {
          heard.push(e.agent);
          if (e.agent === 'launch_agency seat checker') throw thrown;
          if (e.agent === 'launch_agency seat verifier') return Promise.reject(rejected);
          return undefined;
        },
      },
      agencies: { launch: true },
    });
    const session = parent.session('p1');

    const result = await session.send('Check it.');
    // What the callback did failed neither the launch nor the parent's turn, and the session answers again.
    expect(result.text).toBe('The team failed.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'failed', reason: "seat 'checker' failed: GMIError (LLM_PROVIDER_ERROR)" });
    // The callback was handed both seats' reports (the precondition), and the team's failure once, from the team.
    expect(heard.filter((agent) => agent.startsWith(LAUNCH_AGENCY_TOOL_NAME)).sort()).toEqual(['launch_agency seat checker', 'launch_agency seat verifier']);
    expect(heard.filter((agent) => agent === `launch:${out.agencyId}`)).toHaveLength(1);
    expect((await session.send('Are you there?')).text).toBe('Still here.');
    // Root, the two seats' failed requests, root, root.
    expect(s.seen).toHaveLength(5);
    // The console received each callback's failure and the error the callback was handed: each seat's original.
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.any(String), rejected));
    expect(warn).toHaveBeenCalledWith(expect.any(String), thrown);
    const handed = (what: string): unknown[] =>
      warn.mock.calls.filter(([line]) => typeof line === 'string' && line.includes(what)).map(([, error]) => error);
    expect(handed('launch_agency seat checker')).toEqual([expect.objectContaining({ name: 'GMIError', message: expect.stringContaining(canary) })]);
    expect(handed('launch_agency seat verifier')).toEqual([expect.objectContaining({ name: 'GMIError', message: expect.stringContaining(canary) })]);
  });

  it("a launch's arguments hold as the docs' table writes them: the table offers the six strategies but panel, an argument outside its rule is refused invalid_arguments naming it before any seat runs, a call the table's types refuse never starts, and a launch that names no strategy runs its seats in the order listed, whatever their dependsOn", async () => {
    const k = key();
    const launch = (id: string, args: Record<string, unknown>) => ({ id, name: LAUNCH_AGENCY_TOOL_NAME, args });
    const one = [{ role: 'solo', instructions: 'Answer.' }];
    const two = [
      { role: 'a', instructions: 'A.' },
      { role: 'b', instructions: 'B.' },
    ];
    // Each call breaks one rule of the table, and the reason the launch gives.
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['u1', { goal: 'Go.', seats: one, colour: 'red' }, "unknown argument 'colour'"],
      ['u2', { goal: 'Go.', seats: [{ role: 'solo', instructions: 'Answer.', model: 'big' }] }, "seat 1: unknown key 'model'"],
      ['g1', { goal: '   ', seats: one }, 'goal must be 1 to 8,000 characters'],
      ['g2', { goal: 'x'.repeat(8_001), seats: one }, 'goal must be 1 to 8,000 characters'],
      ['r1', { goal: 'Go.', strategy: 'review-loop', seats: [...two, { role: 'c', instructions: 'C.' }] }, 'review-loop takes exactly 2 seats'],
      ['r2', { goal: 'Go.', strategy: 'parallel', seats: one }, 'parallel takes at least 2 seats'],
      ['r3', { goal: 'Go.', strategy: 'debate', seats: one }, 'debate takes at least 2 seats'],
      ['i1', { goal: 'Go.', seats: [{ role: 'solo', instructions: 'x'.repeat(8_193) }] }, "seat 'solo': instructions are at most 8,192 characters"],
      ['n1', { goal: 'Go.', seats: [{ role: '1st', instructions: 'A.' }] }, "seat 1: a role starts with a letter and holds only letters, digits, '_' and '-'"],
      ['n2', { goal: 'Go.', seats: [{ role: `a${'b'.repeat(52)}`, instructions: 'A.' }] }, 'a role is at most 52 characters'],
      ['n3', { goal: 'Go.', seats: [{ role: 'plan', instructions: 'A.' }] }, "seat 'plan': the role is a name the hierarchical strategy uses"],
      ['n4', { goal: 'Go.', seats: [{ role: 'delegate_to_x', instructions: 'A.' }] }, "seat 'delegate_to_x': the role is a name the hierarchical strategy uses"],
      ['n5', { goal: 'Go.', seats: [{ role: 'a', instructions: 'A.' }, { role: 'a', instructions: 'B.' }] }, "seat 'a': roles must be unique"],
      ['d1', { goal: 'Go.', strategy: 'graph', seats: [{ role: 'a', instructions: 'A.', dependsOn: ['b'] }, { role: 'b', instructions: 'B.', dependsOn: ['a'] }] }, 'dependsOn makes a cycle through'],
      ['d2', { goal: 'Go.', seats: [{ role: 'a', instructions: 'A.', dependsOn: ['ghost'] }] }, "seat 'a': dependsOn names 'ghost', which is not another seat"],
      ['c1', { goal: 'Go.', seats: one, budgetUsd: 0 }, 'budgetUsd must be above 0'],
      ['c2', { goal: 'Go.', seats: one, maxTokens: -5 }, 'maxTokens must be above 0'],
      ['t1', { goal: 'Go.', seats: one, deadlineMs: 999 }, 'deadlineMs must be at least 1,000'],
      ['m1', { goal: 'Go.', strategy: 'debate', seats: two, maxRounds: 4 }, 'maxRounds must be 1, 2 or 3'],
    ];
    // Calls the tool's input schema refuses: a strategy the table does not offer, a round count that is no integer.
    const untyped: Array<[string, Record<string, unknown>]> = [
      ['p1', { goal: 'Go.', strategy: 'panel', seats: two }],
      ['p2', { goal: 'Go.', strategy: 'debate', seats: two, maxRounds: 2.5 }],
    ];
    const s = script('openai', k, {
      replies: [
        reply.tools([
          ...invalid.map(([id, args]) => launch(id, args)),
          ...untyped.map(([id, args]) => launch(id, args)),
          // No strategy: the seats run in the order listed, though the first names the second in its dependsOn.
          launch('ok', { goal: 'Answer in order.', seats: [{ role: 'first', instructions: 'You go first.', dependsOn: ['second'] }, { role: 'second', instructions: 'You go second.' }] }),
          // A seat whose answer passes what a result holds.
          launch('long', { goal: 'Say it all.', seats: [{ role: 'talker', instructions: 'You talk.' }] }),
        ]),
        reply.text('First answer.'),
        reply.text('Second answer.'),
        reply.text('y'.repeat(16_001)),
        reply.text('Done.'),
      ],
    });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', agencies: { launch: true } });
    const result = await parent.session('p-args').send('Launch the team for the sunny report.');
    expect(result.text).toBe('Done.');

    // The table offers the six strategies but panel.
    const strategy = (launchTool(s.seen[0]).parameters as { properties: { strategy: { enum: string[] } } }).properties.strategy;
    expect(strategy.enum).toEqual(['sequential', 'parallel', 'debate', 'review-loop', 'hierarchical', 'graph']);
    // Each argument outside its rule is refused invalid_arguments, the reason naming it.
    invalid.forEach(([id, , reason], i) => {
      const refusal = refusalOf(result, i);
      expect(codeOf(refusal), id).toBe('invalid_arguments');
      expect(refusal, id).toContain(reason);
    });
    // A call the schema refuses never reaches the launch: the tool's own check names the tool.
    untyped.forEach(([id], i) => {
      expect(refusalOf(result, invalid.length + i), id).toContain("Invalid arguments for tool 'launch_agency'");
    });
    // The parent's two steps and the seats of the two launches that started: no refused call ran a seat.
    expect(s.seen).toHaveLength(5);
    const ran = launchOf(result, invalid.length + untyped.length);
    expect(ran).toMatchObject({ status: 'completed', text: 'Second answer.', provenance: { strategy: 'sequential' } });
    expect(ran.seats.map((seat) => [seat.role, seat.status, seat.summary])).toEqual([
      ['first', 'completed', 'First answer.'],
      ['second', 'completed', 'Second answer.'],
    ]);
    // The first seat ran first, on the goal; the second took its output.
    expect(systemText(s.seen[1])).toContain('You go first.');
    expect(lastUserText(s.seen[1])).toContain('Answer in order.');
    // The team sees nothing of the launching conversation.
    expect(JSON.stringify(s.seen[0].messages)).toContain('sunny');
    expect(JSON.stringify(s.seen.slice(1, 3).map((call) => call.messages))).not.toContain('sunny');
    expect(systemText(s.seen[2])).toContain('You go second.');
    expect(lastUserText(s.seen[2])).toContain('First answer.');
    // A result holds 16,000 characters of the team's text and says it was cut, and 1,000 of a seat's summary.
    const long = launchOf(result, invalid.length + untyped.length + 1);
    expect(long).toMatchObject({ status: 'completed', truncated: true });
    expect(long.text).toBe('y'.repeat(16_000));
    expect(long.seats[0].summary).toHaveLength(1_000);
  });

  it("the agent's usage ledger records a temporary seat's calls and the team's manager's under the source launch_agency, beside the agent's own, and a member's seat records its calls to the member's own ledger; the manager is offered no spawn_specialist", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentos-launch-ledger-'));
    const parentLedger = join(dir, 'parent.jsonl');
    const memberLedger = join(dir, 'member.jsonl');
    const k = key();
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Check the claim.', strategy: 'hierarchical', seats: [{ role: 'checker', instructions: 'Check claims.' }, { role: 'tutor', agentKey: 'tutor' }] }),
        // The manager, on agent()'s path, which asks for whole responses, delegates to each seat in turn.
        reply.tools([{ id: 'd1', name: 'delegate_to_checker', args: { task: 'Check it.' } }]),
        reply.text('Checked.'),
        reply.tools([{ id: 'd2', name: 'delegate_to_tutor', args: { task: 'Explain it.' } }]),
        reply.text('Explained.'),
        reply.text('The claim holds.'),
        reply.text('Reported.'),
      ],
      whole: true,
    });
    const tutor = gmi({ ...route(k), name: 'Tutor', instructions: 'You teach.', usageLedger: { enabled: true, path: memberLedger } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', usageLedger: { enabled: true, path: parentLedger }, agencies: { launch: true, members: { tutor } } });
    const result = await parent.session('p-ledger').send('Check it.');
    expect(result.text).toBe('Reported.');
    // Root, the manager, the checker, the manager, the tutor, the manager, root (the precondition).
    expect(s.seen.map((call) => call.streamed)).toEqual([true, false, true, false, true, false, true]);
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'The claim holds.' });
    // The manager's three calls: 14, 14 and 15 tokens.
    expect(out.coordinatorUsage.totalTokens).toBe(43);
    // The team's manager is offered its delegations and no spawn_specialist.
    expect(offered(s.seen[1]).sort()).toEqual(['delegate_to_checker', 'delegate_to_tutor']);
    const total = (rows: Array<{ totalTokens: number }>) => rows.reduce((sum, row) => sum + row.totalTokens, 0);
    await vi.waitFor(async () => {
      const rows = await readRecordedAgentOSUsageEvents({ path: parentLedger });
      const launched = rows.filter((row) => row.source === LAUNCH_AGENCY_TOOL_NAME);
      const own = rows.filter((row) => row.source !== LAUNCH_AGENCY_TOOL_NAME);
      // Under launch_agency: the manager's three calls (43) and the checker's one (15), and nothing of the tutor's.
      expect(launched.length).toBeGreaterThan(0);
      expect(total(launched)).toBe(43 + 15);
      // The agent's own two steps (14 and 15) under its session's source.
      expect(own.length).toBeGreaterThan(0);
      expect(own.map((row) => row.source)).toEqual(own.map(() => 'agent.session.send'));
      expect(total(own)).toBe(29);
      // The member's ledger holds its seat's one call (15).
      const memberRows = await readRecordedAgentOSUsageEvents({ path: memberLedger });
      expect(total(memberRows)).toBe(15);
    });
  });

  it("the bounds hold as the docs' table writes them with nothing set: a null takes its default, the default deadline never passes maxDeadlineMs, a count must be an integer, and gmi() warns when it is built about a launch pool that cannot cover one call of its route", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('A.'), reply.text('B.'), reply.text('C.')] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    /** What the agent's table says of `agencies`: the launch_agency definition its first model call offered. */
    const tableOf = async (agencies: AgencyLaunchOptions): Promise<OfferedTool['function']> => {
      const asked = s.seen.length;
      await gmi({ ...route(k), instructions: 'Answer.', agencies }).session('p-bounds').send('Hi.');
      return launchTool(s.seen[asked]);
    };
    const warnings = (): string => warn.mock.calls.map(([message]) => String(message)).join('\n');

    // With nothing set the table states the defaults.
    const defaults = await tableOf({ launch: true });
    expect(JSON.stringify(defaults.parameters)).toContain('default 120000, at most 600000');
    expect(defaults.description).toContain('At most 5 seats');
    // A field set to null takes its default.
    const unset = await tableOf({ launch: true, maxSeats: null, maxDeadlineMs: null, defaultDeadlineMs: null } as unknown as AgencyLaunchOptions);
    expect(JSON.stringify(unset.parameters)).toContain('default 120000, at most 600000');
    expect(unset.description).toContain('At most 5 seats');
    // A maxDeadlineMs below the default deadline is the default too.
    const short = await tableOf({ launch: true, maxDeadlineMs: 5_000 });
    expect(JSON.stringify(short.parameters)).toContain('default 5000, at most 5000');

    // A count must be an integer, launch on or off.
    const fractions: Array<[AgencyLaunchOptions, string]> = [
      [{ maxDepth: 1.5 }, 'agencies.maxDepth must be an integer from 1 to 4, not 1.5'],
      [{ maxSeats: 2.5 }, 'agencies.maxSeats must be an integer from 1 to 12, not 2.5'],
      [{ maxConcurrent: 1.5 }, 'agencies.maxConcurrent must be an integer from 1 to 4, not 1.5'],
    ];
    for (const [agencies, words] of fractions) {
      expect(() => gmi({ ...route(k), agencies })).toThrow(RangeError);
      expect(() => gmi({ ...route(k), agencies })).toThrow(words);
    }

    // A pool that cannot cover one call of the agent's route (2,000 for the prompt and its 1,000 output tokens) is
    // warned about when the agent is built, and one that can is not.
    warn.mockClear();
    gmi({ ...route(k), maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 2_500 } });
    expect(warnings()).toContain("agencies.maxLaunchTokens (2500) cannot cover one call of this agent's route (3000:");
    warn.mockClear();
    gmi({ ...route(k), maxTokens: 1_000, agencies: { launch: true, maxLaunchTokens: 3_000 } });
    expect(warnings()).not.toContain('agencies.maxLaunchTokens');
  });
});

describe('launch_agency on the full runtime, as a host uses the package', () => {
  /** A persona a host registers on the runtime, on the stub's provider and model. */
  const persona = (id: string, extra: Record<string, unknown> = {}): IPersonaDefinition =>
    ({
      id,
      name: id,
      description: `The ${id}.`,
      version: '1.0.0',
      baseSystemPrompt: `You are the ${id}.`,
      defaultProviderId: 'openai',
      defaultModelId: 'stub-model',
      ...extra,
    }) as unknown as IPersonaDefinition;
  /** A config tool of the host's: its output is what `execute` returns, handed the call's context. */
  const configTool = (name: string, execute: (context: ToolExecutionContext) => Promise<unknown>, hasSideEffects = false): ITool => ({
    ...hostTool(name, async (_args, context) => ({ success: true, output: await execute(context) })),
    hasSideEffects,
  });
  /** The script's provider answers unstreamed calls with `text`, spending no reply. */
  const answerWhole = (s: ProviderScript, text: string): WholeAnswering => Object.assign(s, { answerWhole: text });
  const runtimes: AgentOS[] = [];
  afterEach(async () => {
    for (const os of runtimes.splice(0)) await os.shutdown();
  });
  /**
   * A full runtime as a host starts one: its provider under key `k`, the personas `lead` (granted agency:launch),
   * `helper` and `checker`, the tool `search`, and launch_agency on. `overrides` replaces any of them.
   */
  const startRuntime = async (k: string, overrides: Record<string, unknown> = {}, logger?: ILogger): Promise<AgentOS> => {
    const os = await AgentOS.create(
      {
        modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: k } }] },
        turnPlanning: { enabled: false },
        personas: [persona('lead', { allowedCapabilities: ['agency:launch'] }), persona('helper'), persona('checker', { baseSystemPrompt: 'You check facts.' })],
        tools: { search: configTool('search', async () => 'found') },
        agencies: { launch: true },
        ...overrides,
      } as unknown as Parameters<typeof AgentOS.create>[0],
      logger,
    );
    runtimes.push(os);
    return os;
  };
  /** The error a runtime's start refused with, or undefined when it started. */
  const startRefusal = async (overrides: Record<string, unknown>): Promise<unknown> => {
    const k = key();
    script('openai', k);
    return startRuntime(k, overrides).then(
      () => undefined,
      (error: unknown) => error,
    );
  };
  /** One turn as a host runs it, for the user `ana`: every chunk the runtime streams, drained. */
  const runTurn = async (
    os: AgentOS,
    input: { selectedPersonaId: string; sessionId: string; textInput?: string; organizationId?: string },
  ): Promise<AgentOSResponse[]> => {
    const chunks: AgentOSResponse[] = [];
    for await (const chunk of os.processRequest({ userId: 'ana', textInput: 'Go.', ...input } as AgentOSInput)) chunks.push(chunk);
    return chunks;
  };
  /** The launch a model call read as the result of tool call `id`: one that started. */
  const launchedIn = (call: SeenCall, id: string): LaunchAgencyResult => {
    const text = toolText(call, id);
    expect(text, `tool call ${id} started a launch`).not.toContain('Error from tool');
    return JSON.parse(text) as LaunchAgencyResult;
  };
  /** The ids of the GMIs the runtime's snapshot names. */
  const activeGmis = async (os: AgentOS): Promise<string[]> => (await os.getRuntimeSnapshot()).gmis.items.map((item) => item.gmiId);
  /** What ran: each call of a host's tool, by its name and the arguments it ran with. */
  type Ran = Array<{ name: string; args: unknown }>;
  /** A config tool of the host's that records each call that ran in `ran`, after `takesMs`, and answers `<name> done`. */
  const recording = (name: string, ran: Ran, options: { hasSideEffects?: boolean; takesMs?: number } = {}): ITool => ({
    ...hostTool(name, async (args) => {
      ran.push({ name, args });
      if (options.takesMs) await sleep(options.takesMs);
      return { success: true, output: `${name} done` };
    }),
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, q: { type: 'string' } } },
    hasSideEffects: options.hasSideEffects ?? false,
  });
  /** What a host's agencies.hitl handler was asked: the request's kind, agent and action, and a tool call's arguments and id. */
  type Asked = { type: string; agent: string; action: string; args?: unknown; callId?: unknown };
  const askedOf = (request: ApprovalRequest): Asked => ({
    type: request.type,
    agent: request.agent,
    action: request.action,
    ...(request.type === 'tool' ? { args: request.details.args, callId: request.details.callId } : {}),
  });

  it("agencies registers launch_agency only with launch: true, its bounds and a host's tool of that name are checked when the runtime starts, and only a persona granted agency:launch lists and calls the tool, whose seats run on the caller's route or as a registered persona", async () => {
    // Without agencies, and with agencies that leave launch unset, the lead, granted agency:launch, is offered its
    // tools and no launch_agency.
    for (const agencies of [undefined, { maxDepth: 3 }]) {
      const k = key();
      const s = script('openai', k, { replies: [reply.text('Hello.')] });
      answerWhole(s, 'ok');
      const os = await startRuntime(k, { agencies });
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-off' });
      expect(offered(s.seen[0])).toContain('search');
      expect(offered(s.seen[0])).not.toContain(LAUNCH_AGENCY_TOOL_NAME);
    }

    // Every bound is checked when the runtime starts, launch on or off: a configuration error that names the field.
    for (const [agencies, words] of [
      [{ maxDepth: 9 }, 'agencies.maxDepth must be an integer from 1 to 4, not 9'],
      [{ launch: true, maxSeats: 0 }, 'agencies.maxSeats must be an integer from 1 to 12, not 0'],
      [{ budgetShare: 2 }, 'agencies.budgetShare must be above 0 and at most 1, not 2'],
    ] as const) {
      const error = await startRefusal({ agencies });
      expect(error).toBeInstanceOf(AgentOSServiceError);
      expect(error).toMatchObject({ code: 'SYS_CONFIGURATION_ERROR' });
      expect((error as Error).message).toContain(words);
    }

    // With launch on, a host's own tool named launch_agency fails the start, where the runtime would replace it without
    // a word; with launch off the runtime keeps the host's tool, and a persona granted nothing runs it.
    const own = configTool(LAUNCH_AGENCY_TOOL_NAME, async () => 'the host ran its own');
    const clash = await startRefusal({ tools: { search: configTool('search', async () => 'found'), [LAUNCH_AGENCY_TOOL_NAME]: own } });
    expect(clash).toBeInstanceOf(AgentOSServiceError);
    expect(clash).toMatchObject({ code: 'SYS_CONFIGURATION_ERROR', details: { toolName: LAUNCH_AGENCY_TOOL_NAME } });
    expect((clash as Error).message).toContain("agencies.launch registers 'launch_agency', and the runtime's tools already hold a tool of that name.");
    const kOwn = key();
    const sOwn = script('openai', kOwn, { replies: [reply.tools([{ id: 'o1', name: LAUNCH_AGENCY_TOOL_NAME, args: {} }]), reply.text('Done.')] });
    answerWhole(sOwn, 'ok');
    const withOwn = await startRuntime(kOwn, { tools: { [LAUNCH_AGENCY_TOOL_NAME]: own }, agencies: { maxDepth: 3 } });
    await runTurn(withOwn, { selectedPersonaId: 'helper', sessionId: 'r-own' });
    expect(offered(sOwn.seen[0])).toContain(LAUNCH_AGENCY_TOOL_NAME);
    expect(toolText(sOwn.seen[1], 'o1')).toContain('the host ran its own');

    // With launch on, a persona not granted agency:launch is not offered the tool, and its call is refused before it runs.
    const k = key();
    const s = script('openai', k, {
      replies: [
        launchStep(oneSeat('writer'), 'h1'),
        reply.text('I cannot.'),
        launchStep({ goal: 'Write the note.', seats: [{ role: 'writer', instructions: 'You write notes.' }] }, 'l1'),
        reply.text('Note written.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, {
      personas: [persona('lead', { allowedCapabilities: ['agency:launch'], defaultModelCompletionOptions: { maxTokens: 600 } }), persona('helper')],
    });
    await runTurn(os, { selectedPersonaId: 'helper', sessionId: 'r-helper' });
    expect(offered(s.seen[0])).toContain('search');
    expect(offered(s.seen[0])).not.toContain(LAUNCH_AGENCY_TOOL_NAME);
    const refused = toolText(s.seen[1], 'h1');
    expect(refused).toContain("Error from tool 'launch_agency'");
    expect(refused).toContain('agency:launch');
    // The helper's two calls alone: no seat ran.
    expect(s.seen).toHaveLength(2);

    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-lead' });
    // The lead is offered the tool, whose seat names instructions or a registered persona by personaId, never an agentKey.
    const definition = launchTool(s.seen[2]);
    const seatFields = Object.keys((definition.parameters as { properties: { seats: { items: { properties: Record<string, unknown> } } } }).properties.seats.items.properties);
    expect(seatFields).toEqual(expect.arrayContaining(['role', 'instructions', 'personaId', 'brief', 'tools']));
    expect(seatFields).not.toContain('agentKey');
    expect(definition.description).toContain('personaId');
    // A temporary seat runs on the lead's route: its instructions as its prompt, the lead's model, output cap and user.
    expect(s.seen[2].options).toMatchObject({ maxTokens: 600, userId: 'ana' });
    expect(systemText(s.seen[3])).toContain('You write notes.');
    expect(systemText(s.seen[3])).not.toContain('You are the lead.');
    expect(s.seen[3].modelId).toBe('stub-model');
    expect(s.seen[3].options).toMatchObject({ maxTokens: 600, userId: 'ana' });
    const out = launchedIn(s.seen[4], 'l1');
    expect(out).toMatchObject({ status: 'completed', text: 'Note written.' });
    expect(out.seats).toEqual([expect.objectContaining({ role: 'writer', form: 'temporary', status: 'completed', calls: 1, summary: 'Note written.' })]);
    expect(s.seen).toHaveLength(5);
  });

  it("a personaId seat runs as its registered persona over a view of the runtime's tools that lists and runs only its allowlist; an unknown persona, an agentKey seat and a self-modification tool are refused; the seat retrieves nothing; its tool calls see the parent's user and organization, its seat session and a frozen frame", async () => {
    const k = key();
    const queries: string[] = [];
    const filed: string[] = [];
    const augmentor = {
      retrieveContext: async (queryText: string) => {
        queries.push(queryText);
        return { queryText, augmentedContext: '', retrievedChunks: [] };
      },
      ingestDocuments: async (documents: unknown) => {
        filed.push(JSON.stringify(documents));
        return { ingestedIds: ['doc'], failedCount: 0, errors: [] };
      },
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    } as unknown as IRetrievalAugmentor;
    let searches = 0;
    let os!: AgentOS;
    const calls: Array<{ context: ToolExecutionContext; listed: AgencySession[]; gmis: string[] }> = [];
    const whoami = configTool('whoami', async (context) => {
      calls.push({ context, listed: os.listAgencies(), gmis: await activeGmis(os) });
      return 'ana';
    });
    const s = answerWhole(
      script('openai', k, {
        replies: [
          // The reader's own turn.
          reply.text('We know a little.'),
          // The lead: an agentKey seat, a persona no one registered, a self-modification tool, then two registered personas.
          reply.tools([
            { id: 'a1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'x', seats: [{ role: 'tutor', agentKey: 'tutor' }] } },
            { id: 'g1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'x', seats: [{ role: 'ghost', personaId: 'ghost' }] } },
            { id: 'f1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Forge.', seats: [{ role: 'smith', instructions: 'Forge a tool.', tools: ['forge_tool'] }] } },
            {
              id: 'l1',
              name: LAUNCH_AGENCY_TOOL_NAME,
              args: { goal: 'CANARY-SEAT-2: read this.', seats: [{ role: 'reader', personaId: 'reader' }, { role: 'checker', personaId: 'checker', tools: ['whoami'] }] },
            },
          ]),
          reply.text('Read.'),
          // The checker calls its own tool, and one outside its allowlist.
          reply.tools([
            { id: 'w1', name: 'whoami', args: {} },
            { id: 'x1', name: 'search', args: {} },
          ]),
          reply.text('Checked.'),
          reply.text('Done.'),
        ],
      }),
      'ok',
    );
    os = await startRuntime(k, {
      emergent: true,
      retrievalAugmentor: augmentor,
      personas: [
        persona('lead', { allowedCapabilities: ['agency:launch'] }),
        persona('checker', { baseSystemPrompt: 'You check facts.' }),
        persona('reader', { memoryConfig: { enabled: true, ragConfig: { enabled: true, retrievalTriggers: { onUserQuery: true }, ingestionTriggers: { onTurnSummary: true } } } }),
      ],
      tools: {
        search: configTool('search', async () => {
          searches += 1;
          return 'found';
        }),
        whoami,
      },
    });
    // The reader's own turn retrieves with its input and files a turn summary (the precondition).
    await runTurn(os, { selectedPersonaId: 'reader', sessionId: 'r-reader', textInput: 'CANARY-OWN-1 what do we know?' });
    expect(queries).toContain('CANARY-OWN-1 what do we know?');
    expect(filed.join('\n')).toContain('CANARY-OWN-1');

    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-lead', organizationId: 'org-7' });
    // The lead's own table is wider than any seat's (the precondition).
    expect(offered(s.seen[1])).toEqual(expect.arrayContaining(['search', 'whoami', 'forge_tool', LAUNCH_AGENCY_TOOL_NAME]));
    const lead = s.seen[5];
    expect(toolText(lead, 'a1')).toContain("seat_form_unsupported: seat 'tutor': agentKey seats run on gmi(); name a registered persona by personaId");
    expect(toolText(lead, 'g1')).toContain("unknown_member: seat 'ghost': no member 'ghost'");
    expect(toolText(lead, 'f1')).toContain("tool_not_allowed: seat 'smith': 'forge_tool' is a self-modification tool");
    const out = launchedIn(lead, 'l1');
    expect(out).toMatchObject({ status: 'completed', text: 'Checked.', provenance: expect.objectContaining({ depth: 1 }) });
    expect(out.seats).toEqual([
      expect.objectContaining({ role: 'reader', form: 'persistent', member: 'reader', status: 'completed', calls: 1, summary: 'Read.' }),
      expect.objectContaining({ role: 'checker', form: 'persistent', member: 'checker', status: 'completed', calls: 1, summary: 'Checked.' }),
    ]);
    // Each seat is its registered persona, handed its role before the goal, and offered its allowlist alone.
    expect(systemText(s.seen[2])).toContain('You are the reader.');
    expect(lastUserText(s.seen[2])).toContain('Your role in this team: reader.');
    expect(lastUserText(s.seen[2])).toContain('CANARY-SEAT-2: read this.');
    expect(offered(s.seen[2])).toEqual([]);
    expect(systemText(s.seen[3])).toContain('You check facts.');
    expect(offered(s.seen[3])).toEqual(['whoami']);
    // A call outside the seat's allowlist is answered "not available in this seat", and its tool never runs.
    expect(toolText(s.seen[4], 'x1')).toContain('not available in this seat');
    expect(searches).toBe(0);
    expect(toolText(s.seen[4], 'w1')).toContain('ana');
    // The seat's tool call saw the parent's user and organization, the seat's own session, and the frame, frozen.
    expect(calls).toHaveLength(1);
    const [{ context, listed, gmis }] = calls;
    expect(context.userContext.userId).toBe('ana');
    expect(context.sessionData?.organizationId).toBe('org-7');
    expect(context.sessionData?.sessionId).toBe(`seat:${out.agencyId}:checker`);
    expect(context.sessionData?.agencyLaunch).toEqual({ launchId: out.agencyId, role: 'checker', depth: 1 });
    expect(Object.isFrozen(context.sessionData?.agencyLaunch)).toBe(true);
    // While the team ran it was listed with its two seats, whose GMIs were active; afterwards neither stays.
    expect(listed.map((entry) => entry.agencyId)).toEqual([out.agencyId]);
    const seatGmis = Object.values(listed[0].seats).map((seat) => seat.gmiInstanceId);
    expect(seatGmis).toHaveLength(2);
    expect(gmis).toEqual(expect.arrayContaining(seatGmis));
    expect(os.listAgencies()).toEqual([]);
    expect((await activeGmis(os)).filter((id) => seatGmis.includes(id))).toEqual([]);
    // The reader's seat retrieved nothing and filed nothing: the team's goal reached neither the queries nor the store.
    expect(queries.some((query) => query.includes('CANARY-SEAT-2'))).toBe(false);
    expect(filed.join('\n')).not.toContain('CANARY-SEAT-2');
  });

  it("a personaId seat is bounded by its own persona: it names only tools its persona's capabilities allow, and the one-call floor counts its persona's route, whose output cap its calls are sent with", async () => {
    const k = key();
    const s = script('openai', k, {
      replies: [
        reply.tools([
          // The helper's persona is not granted agency:launch, though the lead is.
          { id: 'u1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Launch a team of your own.', seats: [{ role: 'helper', personaId: 'helper', tools: [LAUNCH_AGENCY_TOOL_NAME] }] } },
          // 3,000 covers one call of the lead's route (2,000 for the prompt, 500 for the output) and not one of big's.
          { id: 'b1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Think big.', maxTokens: 3_000, seats: [{ role: 'big', personaId: 'big' }] } },
          // 2,200 covers one call of small's route (2,000 and 100) and not one of the lead's.
          { id: 's1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Think small.', maxTokens: 2_200, seats: [{ role: 'small', personaId: 'small' }] } },
        ]),
        reply.text('Small.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, {
      personas: [
        persona('lead', { allowedCapabilities: ['agency:launch'], defaultModelCompletionOptions: { maxTokens: 500 } }),
        persona('helper'),
        persona('big', { defaultModelCompletionOptions: { maxTokens: 2_000 } }),
        persona('small', { baseSystemPrompt: 'You think small.', defaultModelCompletionOptions: { maxTokens: 100 } }),
      ],
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-own-route' });
    // The lead's call is sent with its own cap (the precondition).
    expect(s.seen[0].options.maxTokens).toBe(500);
    const lead = s.seen[2];
    expect(toolText(lead, 'u1')).toContain("unknown_tool: seat 'helper': the persona 'helper' has no tool 'launch_agency'");
    expect(toolText(lead, 'b1')).toContain('budget_unavailable');
    expect(toolText(lead, 'b1')).toContain('(4000: 2000 for the prompt and 2000 for the output)');
    expect(launchedIn(lead, 's1')).toMatchObject({ status: 'completed', text: 'Small.' });
    // Small's seat ran as its persona, its call sent with its own cap; no other seat ran.
    expect(systemText(s.seen[1])).toContain('You think small.');
    expect(s.seen[1].options.maxTokens).toBe(100);
    expect(s.seen).toHaveLength(3);
  });

  it("a team a personaId member launches from its seat is floored on the member's own route, and its temporary seats run on that route", async () => {
    const k = key();
    // The lead seats a member that may launch; the member's seat turn launches a team of one under a token cap.
    const memberLaunch = (personaId: string, maxTokens: number, ids: [string, string]) => [
      launchStep({ goal: 'Plan the trip.', seats: [{ role: personaId, personaId, tools: [LAUNCH_AGENCY_TOOL_NAME] }] }, ids[0]),
      launchStep({ goal: 'Draft the plan.', maxTokens, seats: [{ role: 'drafter', instructions: 'DRAFTER: draft the plan.' }] }, ids[1]),
    ];
    const s = script('openai', k, {
      replies: [
        // 4,000 covers one call of the lead's route (2,000 for the prompt, 500 for the output), not one of the planner's.
        ...memberLaunch('planner', 4_000, ['p1', 'p2']),
        reply.text('No team.'),
        reply.text('Planned.'),
        // 2,200 covers one call of the editor's route (2,000 and 100), not one of the lead's.
        ...memberLaunch('editor', 2_200, ['e1', 'e2']),
        reply.text('Drafted.'),
        reply.text('Edited.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, {
      personas: [
        persona('lead', { allowedCapabilities: ['agency:launch'], defaultModelCompletionOptions: { maxTokens: 500 } }),
        persona('planner', { allowedCapabilities: ['agency:launch'], baseSystemPrompt: 'You plan trips.', defaultModelCompletionOptions: { maxTokens: 3_000 } }),
        persona('editor', { allowedCapabilities: ['agency:launch'], baseSystemPrompt: 'You edit plans.', defaultModelCompletionOptions: { maxTokens: 100 } }),
      ],
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-member-1' });
    // The planner's seat turn ran as its persona (the precondition), and its launch was refused on the planner's route
    // before a seat was built: the lead, the planner's two steps, the lead.
    expect(systemText(s.seen[1])).toContain('You plan trips.');
    const refusal = toolText(s.seen[2], 'p2');
    expect(refusal).toContain('budget_unavailable');
    expect(refusal).toContain('(5000: 2000 for the prompt and 3000 for the output)');
    expect(launchedIn(s.seen[3], 'p1')).toMatchObject({ status: 'completed', text: 'No team.' });
    expect(s.seen).toHaveLength(4);

    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-member-2' });
    // The editor's launch was admitted, and its temporary seat ran on the editor's route: its call sent with the editor's
    // output cap, not the lead's.
    expect(systemText(s.seen[5])).toContain('You edit plans.');
    expect(systemText(s.seen[6])).toContain('DRAFTER: draft the plan.');
    expect(s.seen[6].options.maxTokens).toBe(100);
    expect(launchedIn(s.seen[7], 'e2')).toMatchObject({ status: 'completed', text: 'Drafted.' });
    expect(launchedIn(s.seen[8], 'e1')).toMatchObject({ status: 'completed', text: 'Edited.' });
    expect(s.seen).toHaveLength(9);
  });

  it("a running team is listed by its name, its parent and its seats, each seat call with its outcome, and listAgencies hands out copies; a seat that fails is named to its team and the result by its error's name and code alone, while the logger the host gave the runtime gets the original, and a logger that throws fails no launch", async () => {
    const k = key();
    const kc = key();
    const canary = 'sk-CANARY-7373';
    // The manager, on agent()'s path, which asks for whole responses, delegates to each seat in turn.
    const manager = script('openai', kc, {
      whole: true,
      replies: [
        reply.tools([{ id: 'd1', name: 'delegate_to_flaky', args: { task: 'Try it.' } }]),
        reply.tools([{ id: 'd2', name: 'delegate_to_writer', args: { task: 'Write it.' } }]),
        reply.tools([{ id: 'd3', name: 'delegate_to_peeker', args: { task: 'Look around.' } }]),
        reply.text('The team looked around.'),
      ],
    });
    const s = script('openai', k, {
      replies: [
        launchStep(
          {
            goal: 'Look around.',
            strategy: 'hierarchical',
            seats: [
              { role: 'flaky', instructions: 'You try things.' },
              { role: 'writer', instructions: 'You write.' },
              { role: 'peeker', personaId: 'checker', tools: ['peek'] },
            ],
          },
          'l1',
        ),
        // The flaky seat's request fails with a message that holds a credential.
        providerFailure(canary),
        reply.text('Written.'),
        reply.tools([{ id: 'p1', name: 'peek', args: {} }]),
        reply.text('Peeked.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
        // A host's logger may throw.
        if (message.startsWith('[AgentOS] launch_agency')) throw new Error('the logger broke');
      },
    };
    let os!: AgentOS;
    const peeks: Array<{ first: AgencySession[]; second: AgencySession[]; gmis: string[] }> = [];
    const peek = configTool('peek', async () => {
      const first = os.listAgencies();
      // What a caller does to the copies it was handed reaches the runtime not at all.
      for (const entry of first) {
        (entry.metadata as Record<string, unknown>).status = 'tampered';
        entry.seats.flaky?.history?.push({ timestamp: 'now', status: 'completed', outputPreview: 'tampered' });
        delete entry.seats.writer;
      }
      peeks.push({ first, second: os.listAgencies(), gmis: await activeGmis(os) });
      return 'looked';
    });
    os = await startRuntime(
      k,
      { tools: { search: configTool('search', async () => 'found'), peek }, agencies: { launch: true, coordinator: { provider: 'openai', model: 'stub-model', apiKey: kc } } },
      logger,
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-list' });
    // The lead, the flaky seat's failed request, the writer, the peeker's two steps, the lead; the manager's four calls
    // (the precondition).
    expect(s.seen).toHaveLength(6);
    expect(manager.seen).toHaveLength(4);
    const out = launchedIn(s.seen[5], 'l1');
    expect(out).toMatchObject({ status: 'completed', text: 'The team looked around.' });
    expect(out.seats).toEqual([
      expect.objectContaining({ role: 'flaky', form: 'temporary', status: 'failed', calls: 1, error: { name: 'GMIError', code: 'GMI_PROCESSING_ERROR' } }),
      expect.objectContaining({ role: 'writer', form: 'temporary', status: 'completed', calls: 1, summary: 'Written.' }),
      expect.objectContaining({ role: 'peeker', form: 'persistent', member: 'checker', status: 'completed', calls: 1, summary: 'Peeked.' }),
    ]);
    // The manager's next request read the delegation's error by its name and code; no request and not the result
    // carries the message.
    expect(toolText(manager.seen[1], 'd1')).toContain('GMIError (GMI_PROCESSING_ERROR)');
    expectNoWordOf(canary, [JSON.stringify(manager.seen), JSON.stringify(s.seen), JSON.stringify(out)]);
    // The logger the host gave the runtime got the seat's original error once, under the seat's name; it threw, and the
    // launch went on.
    const launchWarnings = warnings.filter(({ message }) => message.startsWith('[AgentOS] launch_agency'));
    expect(launchWarnings.map(({ message }) => message)).toEqual(['[AgentOS] launch_agency seat flaky failed']);
    expect(launchWarnings[0].meta).toEqual({ error: expect.objectContaining({ name: 'GMIError', message: expect.stringContaining(canary) }) });

    // Read from the peeker's tool while the team ran: one launched team, by its name, its parent and its three seats.
    expect(peeks).toHaveLength(1);
    const [{ first, second, gmis }] = peeks;
    // The copy the tool changed (the precondition), and the listing after it, which the change did not reach.
    expect(first).toHaveLength(1);
    expect(first[0].metadata).toMatchObject({ status: 'tampered' });
    expect(Object.keys(first[0].seats).sort()).toEqual(['flaky', 'peeker']);
    expect(second).toHaveLength(1);
    const entry = second[0];
    expect(entry).toMatchObject({
      agencyId: out.agencyId,
      workflowId: `launch:${out.agencyId}`,
      conversationId: expect.any(String),
      metadata: expect.objectContaining({
        kind: 'launched',
        parentGmiId: expect.any(String),
        parentPersonaId: 'lead',
        launchingSessionId: 'r-list',
        depth: 1,
        strategy: 'hierarchical',
        status: 'running',
        goalPreview: 'Look around.',
        startedAt: expect.any(String),
      }),
    });
    expect(Object.keys(entry.seats).sort()).toEqual(['flaky', 'peeker', 'writer']);
    expect(entry.seats.peeker).toMatchObject({ roleId: 'peeker', personaId: 'checker', metadata: { form: 'persistent', member: 'checker' }, history: [] });
    expect(entry.seats.writer).toMatchObject({ roleId: 'writer', personaId: `${out.agencyId}-writer`, metadata: { form: 'temporary' } });
    // Each call a seat ran: the failed one by its outcome and its error's name and code, the answered one with its start.
    expect(entry.seats.flaky.history).toEqual([
      { timestamp: expect.any(String), status: 'failed', metadata: { outcome: 'failed', error: { name: 'GMIError', code: 'GMI_PROCESSING_ERROR' } } },
    ]);
    expect(entry.seats.writer.history).toEqual([{ timestamp: expect.any(String), status: 'completed', outputPreview: 'Written.', metadata: { outcome: 'completed' } }]);
    // The seats' GMIs were active while the team ran; afterwards the list is empty and none of them is.
    const seatGmis = Object.values(entry.seats).map((seat) => seat.gmiInstanceId);
    expect(gmis).toEqual(expect.arrayContaining(seatGmis));
    expect(os.listAgencies()).toEqual([]);
    expect((await activeGmis(os)).filter((id) => seatGmis.includes(id))).toEqual([]);
  });

  it("a launch that returns while a seat's tool still runs stays listed, closing, and holds its session's scope until the seat is released, while another session launches; then the scope admits again", async () => {
    const k = key();
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hangs = 0;
    const hang = configTool('hang', async () => {
      hangs += 1;
      await hanging;
      return 'done';
    });
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Wait.', deadlineMs: 1_000, seats: [{ role: 'waiter', instructions: 'Call hang.', tools: ['hang'] }] }, 'l1'),
        // The waiter's tool runs past the deadline and the grace.
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('Timed out.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, { tools: { search: configTool('search', async () => 'found'), hang } });
    try {
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-close' });
      // The launch returned timed_out while the waiter's tool still runs (the precondition).
      const out = launchedIn(s.seen[2], 'l1');
      expect(out.status).toBe('timed_out');
      expect(hangs).toBe(1);
      // The waiter's call still ran when the launch stopped: its record reads cut, with no error.
      expect(out.seats).toEqual([expect.objectContaining({ role: 'waiter', form: 'temporary', status: 'cut', calls: 1 })]);
      expect(out.seats[0].error).toBeUndefined();
      // The team stays listed, closing, its seat's GMI still active.
      const listed = os.listAgencies();
      expect(listed.map((entry) => entry.agencyId)).toEqual([out.agencyId]);
      expect(listed[0].metadata).toMatchObject({ kind: 'launched', status: 'closing' });
      const waiterGmi = listed[0].seats.waiter.gmiInstanceId;
      expect(await activeGmis(os)).toContain(waiterGmi);
      // The same session's next launch is refused while its team closes; another session's is admitted.
      s.replies.push(launchStep(oneSeat('again'), 'l2'), reply.text('Not now.'));
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-close' });
      expect(toolText(s.seen[4], 'l2')).toContain('concurrency_exceeded');
      s.replies.push(launchStep(oneSeat('other'), 'l3'), reply.text('Other done.'), reply.text('Done.'));
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-other' });
      expect(launchedIn(s.seen[7], 'l3')).toMatchObject({ status: 'completed', text: 'Other done.' });
      // Once the tool returns and the seat is released, the team leaves the list and its GMI goes. Nothing more runs for
      // the waiter: its tool ran once, and its stopped turn sends no further request, not even one the provider would
      // answer with its abort chunk (the queued reply is there for a request that would reach it).
      s.replies.push(reply.text('SENTINEL: never read.'));
      release();
      await vi.waitFor(() => expect(os.listAgencies()).toEqual([]), { timeout: 10_000 });
      expect(await activeGmis(os)).not.toContain(waiterGmi);
      expect(s.seen).toHaveLength(8);
      expect(s.aborts).toBe(0);
      expect(hangs).toBe(1);
      s.replies.length = 0;
      // The session's scope admits again.
      s.replies.push(launchStep(oneSeat('later'), 'l4'), reply.text('Later done.'), reply.text('Done.'));
      const base = s.seen.length;
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-close' });
      expect(s.seen).toHaveLength(base + 3);
      expect(launchedIn(s.seen[base + 2], 'l4')).toMatchObject({ status: 'completed', text: 'Later done.' });
    } finally {
      release();
    }
  }, 40_000);

  it("a runtime seat's calls are metered against its launch's budget: a step that spends the cap leaves the launch budget_exhausted with nothing more sent, a reflection of the seat's persona included, and a billed failure is charged", async () => {
    const k = key();
    const s = answerWhole(
      script('openai', k, {
        replies: [
          // Under the default cap the moody seat's reflection reaches the provider (the precondition).
          launchStep({ goal: 'Feel it.', seats: [{ role: 'moody', personaId: 'moody' }] }, 'm1'),
          reply.text('Felt.'),
          reply.text('Done.'),
        ],
      }),
      'ok',
    );
    const reflect = { id: 'reflect', promptTemplate: 'REFLECT-ON-THE-TURN', maxOutputTokens: 400, trigger: { type: 'turn_interval', intervalTurns: 1 } };
    // Each seat's route counts 500 output tokens a call, so a 3,000-token launch covers one call of each.
    const os = await startRuntime(k, {
      personas: [
        persona('lead', { allowedCapabilities: ['agency:launch'], defaultModelCompletionOptions: { maxTokens: 500 } }),
        persona('checker', { defaultModelCompletionOptions: { maxTokens: 500 } }),
        persona('moody', { defaultModelCompletionOptions: { maxTokens: 500 }, metaPrompts: [reflect] }),
      ],
    });
    const reflections = (): number => (s.wholeSeen ?? []).filter((prompt) => prompt.includes('REFLECT-ON-THE-TURN')).length;
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-meter-1' });
    await vi.waitFor(() => expect(reflections()).toBe(1));
    expect(launchedIn(s.seen[2], 'm1')).toMatchObject({ status: 'completed', text: 'Felt.' });

    // Under a 3,000-token cap the moody seat's step reports 2,700: the checker's step and the reflection are refused
    // before their requests.
    s.replies.push(
      launchStep({ goal: 'Feel it again.', maxTokens: 3_000, seats: [{ role: 'moody', personaId: 'moody' }, { role: 'checker', personaId: 'checker' }] }, 'm2'),
      textCosting('Felt again.', 2_700),
      reply.text('Done.'),
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-meter-2' });
    await sleep(200);
    // The lead, the moody seat, the lead: no request after the refusal, and no second reflection.
    expect(s.seen).toHaveLength(6);
    expect(reflections()).toBe(1);
    const capped = launchedIn(s.seen[5], 'm2');
    expect(capped).toMatchObject({ status: 'budget_exhausted', provenance: expect.objectContaining({ budget: expect.objectContaining({ maxTotalTokens: 3_000 }) }) });
    expect(capped.provenance.budget.tokensUsed).toBeGreaterThanOrEqual(2_700);
    expect(capped.seats[0]).toMatchObject({ role: 'moody', status: 'completed', calls: 1, usage: expect.objectContaining({ totalTokens: 2_700 }) });
    expect(capped.seats[1]).toMatchObject({ role: 'checker' });
    expect(capped.seats[1].status).not.toBe('completed');

    // A seat's request that fails and is billed, as OpenAI's Responses path reports a failed response, is charged.
    const billed = Object.assign(new Error('The response failed.'), {
      name: 'OpenAIProviderError',
      details: { usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1_000 } },
    });
    s.replies.push(launchStep({ goal: 'Try.', seats: [{ role: 'checker', personaId: 'checker' }] }, 'b1'), billed, reply.text('Done.'));
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-meter-3' });
    expect(s.seen).toHaveLength(9);
    const failed = launchedIn(s.seen[8], 'b1');
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.provenance.budget.tokensUsed).toBeGreaterThanOrEqual(1_000);
  });

  it("a team's nested launches share one launch in flight: of three seats that launch at once, one is admitted and two are refused, and a later launch from a team is admitted once the earlier one has settled", async () => {
    const k = key();
    const kc = key();
    // A parallel team's answers are made one by the synthesizer on the coordinator's route.
    const coordinator = answerWhole(script('openai', kc), 'Three answers in one.');
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const nested = (role: string) => launchStep({ goal: `Answer ${role}.`, seats: [{ role, instructions: 'NESTED-SEAT: answer.' }] }, `n-${role}`);
    const isNestedSeat = (call: SeenCall): boolean => systemText(call).includes('NESTED-SEAT');
    const refusedSteps = (calls: SeenCall[]): SeenCall[] =>
      calls.filter((call) => call.messages.some((m) => m.role === 'tool' && textOf(m.content).includes('concurrency_exceeded')));
    const launchers = (roles: string[]) => roles.map((role) => ({ role, instructions: `Seat ${role}: launch one helper.`, tools: [LAUNCH_AGENCY_TOOL_NAME] }));
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Three at once.', strategy: 'parallel', seats: launchers(['a', 'b', 'c']) }, 'trio'),
        // Each seat's first step launches one helper.
        nested('n1'),
        nested('n2'),
        nested('n3'),
        // The admitted helper's answer and the refused seats' next steps wait until both refusals are in.
        reply.hold([], gate, reply.text('Done here.')),
        reply.hold([], gate, reply.text('Done here.')),
        reply.hold([], gate, reply.text('Done here.')),
        // The seat whose helper ran, then the lead.
        reply.text('Helped.'),
        reply.text('All three answered.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, { agencies: { launch: true, coordinator: { provider: 'openai', model: 'stub-model', apiKey: kc } } });
    const turn = runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-trio' });
    try {
      await vi.waitFor(() => expect(refusedSteps(s.seen)).toHaveLength(2), { timeout: 20_000 });
    } finally {
      open();
    }
    await turn;
    // One nested launch was admitted and its helper ran once; the other two were refused concurrency_exceeded.
    expect(refusedSteps(s.seen)).toHaveLength(2);
    expect(s.seen.filter(isNestedSeat)).toHaveLength(1);
    expect(s.replies).toHaveLength(0);
    const trio = launchedIn(s.seen[s.seen.length - 1], 'trio');
    expect(trio).toMatchObject({ status: 'completed', text: 'Three answers in one.' });
    expect(trio.seats.map((seat) => seat.status)).toEqual(['completed', 'completed', 'completed']);
    expect(coordinator.wholeSeen?.length).toBeGreaterThan(0);

    // A team's launches one after the other: each is admitted once the one before it has settled.
    s.replies.push(
      launchStep({ goal: 'One after the other.', seats: launchers(['first', 'second']) }, 'duo'),
      nested('m1'),
      reply.text('m1 done.'),
      reply.text('first done.'),
      nested('m2'),
      reply.text('m2 done.'),
      reply.text('second done.'),
      reply.text('Both answered.'),
    );
    const before = s.seen.length;
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-duo' });
    const later = s.seen.slice(before);
    expect(later.filter(isNestedSeat)).toHaveLength(2);
    expect(refusedSteps(later)).toEqual([]);
    expect(launchedIn(later[later.length - 1], 'duo')).toMatchObject({ status: 'completed', text: 'second done.' });
  }, 40_000);

  it("launch_agency is never a step on the full runtime: create_workflow and forge_tool refuse a step that names it, though the host lists it among the side-effecting tools a step may chain, before the judge, and the package's step check says why", async () => {
    const k = key();
    /** A forge request for a composition of one step that calls `stepTool`. */
    const forgeRequest = (name: string, stepTool: string) => ({
      name,
      description: `The ${name} tool.`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      implementation: { mode: 'compose', steps: [{ name: 'step', tool: stepTool, inputMapping: { goal: '$input.text' } }] },
      testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'done' }, stepOutputs: { step: { text: 'done' } } }],
    });
    const sendNote = configTool('send_note', async () => 'sent', true);
    const s = answerWhole(
      script('openai', k, {
        replies: [
          reply.tools([
            // A side-effecting tool the host lists chains (the precondition), and launch_agency, listed too, never does.
            { id: 'w1', name: 'create_workflow', args: { action: 'create', name: 'note_flow', description: 'Sends a note.', steps: [{ tool: 'send_note', args: { text: '$input' } }] } },
            { id: 'w2', name: 'create_workflow', args: { action: 'create', name: 'team_up', description: 'Launches a team.', steps: [{ tool: LAUNCH_AGENCY_TOOL_NAME, args: { goal: '$input' } }] } },
            // A composition of a chainable tool reaches the judge (the precondition); one naming launch_agency does not.
            { id: 'f0', name: 'forge_tool', args: forgeRequest('look_up', 'search') },
            { id: 'f1', name: 'forge_tool', args: forgeRequest('team_up', LAUNCH_AGENCY_TOOL_NAME) },
          ]),
          reply.text('Done.'),
        ],
      }),
      'not a verdict',
    );
    const os = await startRuntime(k, {
      emergent: true,
      emergentConfig: { selfImprovement: { enabled: true }, compose: { sideEffectingTools: [LAUNCH_AGENCY_TOOL_NAME, 'send_note'] } },
      tools: { search: configTool('search', async () => 'found'), send_note: sendNote },
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-steps' });
    expect(offered(s.seen[0])).toEqual(expect.arrayContaining(['create_workflow', 'forge_tool', 'send_note', LAUNCH_AGENCY_TOOL_NAME]));
    const next = s.seen[1];
    expect(toolText(next, 'w1')).not.toContain('Error from tool');
    expect(toolText(next, 'w1')).toContain('"name":"note_flow"');
    for (const id of ['w2', 'f1']) {
      expect(toolText(next, id)).toContain('step_not_chainable');
      expect(toolText(next, id)).toContain('can never be a step');
    }
    const judged = (name: string): string[] => (s.wholeSeen ?? []).filter((prompt) => prompt.includes('security auditor') && prompt.includes(`Tool name: ${name}`));
    expect(judged('look_up').length).toBeGreaterThan(0);
    expect(judged('team_up')).toEqual([]);
    // The package's step check, as a host reads it: a listed side-effecting tool chains, launch_agency never does.
    expect(checkChainable('send_note', sendNote, ['send_note'])).toMatchObject({ ok: true });
    expect(checkChainable(LAUNCH_AGENCY_TOOL_NAME, configTool(LAUNCH_AGENCY_TOOL_NAME, async () => 'launched', true), [LAUNCH_AGENCY_TOOL_NAME])).toMatchObject({
      ok: false,
      code: 'step_not_chainable',
      message: expect.stringContaining('can never be a step'),
    });
  });

  it("the output guardrails that judge the launching turn's tool calls judge each call of every seat before it runs, beside the sources the launching turn retrieved, a nested team's seat included", async () => {
    const k = key();
    const judged: string[] = [];
    let dangers = 0;
    const guard = {
      id: 'no-danger',
      config: { evaluateToolCalls: true },
      async evaluateOutput({ chunk, ragSources }: GuardrailOutputPayload) {
        if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
        const confidential = (ragSources ?? []).some((source) => source.metadata?.classification === 'confidential');
        const names = (chunk as AgentOSToolCallRequestChunk).toolCalls.map((call) => call.name);
        judged.push(...names.map((name) => (confidential ? `${name} (confidential)` : name)));
        return names.includes('danger') ? { action: GuardrailAction.BLOCK, reason: 'No danger.', reasonCode: 'NO_DANGER' } : null;
      },
    } as unknown as IGuardrailService;
    // The lead's turn retrieves a confidential source.
    const payroll = { id: 'chunk-payroll', content: 'October payroll.', originalDocumentId: 'doc-payroll', metadata: { classification: 'confidential' } } as unknown as RagRetrievedChunk;
    const augmentor = {
      retrieveContext: async (queryText: string) => ({ queryText, augmentedContext: 'October payroll.', retrievedChunks: [payroll] }),
      ingestDocuments: async () => ({ ingestedIds: [], failedCount: 0, errors: [] }),
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    } as unknown as IRetrievalAugmentor;
    const s = script('openai', k, {
      replies: [
        // A seat of the lead's team asks for danger.
        launchStep({ goal: 'Run danger.', seats: [{ role: 'doer', instructions: 'Call danger.', tools: ['danger'] }] }, 'l1'),
        reply.tools([{ id: 'x1', name: 'danger', args: {} }]),
        reply.text('Could not.'),
        reply.text('Done.'),
        // A seat of a team the lead's seat launches asks for danger.
        launchStep({ goal: 'Plan the work.', seats: [{ role: 'planner', instructions: 'Hand the work on.', tools: [LAUNCH_AGENCY_TOOL_NAME, 'danger'] }] }, 'l2'),
        launchStep({ goal: 'Run danger.', seats: [{ role: 'doer', instructions: 'Call danger.', tools: ['danger'] }] }, 'l3'),
        reply.tools([{ id: 'x2', name: 'danger', args: {} }]),
        reply.text('Could not.'),
        reply.text('Handed on.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, {
      guardrailService: guard,
      retrievalAugmentor: augmentor,
      personas: [persona('lead', { allowedCapabilities: ['agency:launch'], memoryConfig: { enabled: true, ragConfig: { enabled: true, retrievalTriggers: { onUserQuery: true } } } })],
      tools: {
        danger: configTool('danger', async () => {
          dangers += 1;
          return 'done';
        }),
      },
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-guard-1' });
    // The guardrail judged the lead's own call beside the confidential source its turn read, and the seat was offered
    // danger and asked for it (the precondition).
    expect(judged).toContain('launch_agency (confidential)');
    expect(offered(s.seen[1])).toEqual(['danger']);
    // The seat's call was judged beside the launching turn's sources and refused before it ran.
    expect(judged).toContain('danger (confidential)');
    expect(dangers).toBe(0);
    expect(toolText(s.seen[2], 'x1')).toContain('No danger.');

    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-guard-2' });
    // The planner launched the doer's team from its seat (the precondition), and that doer's call was judged and refused.
    expect(offered(s.seen[6])).toEqual(['danger']);
    expect(judged.filter((name) => name.startsWith('danger'))).toHaveLength(2);
    expect(dangers).toBe(0);
    expect(toolText(s.seen[7], 'x2')).toContain('No danger.');
  });

  it("agencies.hitl asks about each call of a runtime seat it covers, after the seat's names: a refusal, or any answer but a plain approval, skips the tool and the seat reads why, an approval runs it once with the call's arguments, a tool it does not cover runs unasked, and a personaId seat is asked as a temporary seat is", async () => {
    const k = key();
    const ran: Ran = [];
    const asked: Asked[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(askedOf(request));
      const to = (request.details.args as { to?: string } | undefined)?.to;
      if (to === 'team') return { approved: false, reason: 'mail is paused' };
      // An approval that names other arguments is not a plain approval.
      if (to === 'all') return { approved: true, modifications: { toolArgs: { to: 'nobody' } } };
      return { approved: true };
    };
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Mail them.', seats: [{ role: 'mailer', instructions: 'MAILER: send the mail.', tools: ['send_email', 'note'] }] }, 'l1'),
        // The mailer's step: a call the handler refuses, one it approves, one whose approval names other arguments, a
        // tool the policy does not cover, and a name outside the seat's allowlist that the policy covers.
        reply.tools([
          { id: 'e1', name: 'send_email', args: { to: 'team' } },
          { id: 'e2', name: 'send_email', args: { to: 'boss' } },
          { id: 'e3', name: 'send_email', args: { to: 'all' } },
          { id: 'n1', name: 'note', args: {} },
          { id: 'x1', name: 'search', args: { q: 'x' } },
        ]),
        reply.text('Mail sent to the boss.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, {
      personas: [persona('lead', { allowedCapabilities: ['agency:launch'] }), persona('clerk')],
      tools: { search: recording('search', ran), send_email: recording('send_email', ran, { hasSideEffects: true }), note: recording('note', ran) },
      agencies: { launch: true, hitl: { approvals: { beforeTool: ['send_email', 'search'] }, handler } },
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-hitl-mail' });
    // The lead, the mailer's two steps, the lead: the mailer was offered its two tools and made the five calls (the
    // precondition).
    expect(s.seen).toHaveLength(4);
    expect(systemText(s.seen[1])).toContain('MAILER: send the mail.');
    expect(offered(s.seen[1]).sort()).toEqual(['note', 'send_email']);
    const out = launchedIn(s.seen[3], 'l1');
    expect(out).toMatchObject({ status: 'completed', text: 'Mail sent to the boss.' });
    const team = `launch:${out.agencyId}`;
    // The handler was asked once for each send_email call, by the team's gate, with the call's arguments and id; never
    // for note, which the policy does not cover, nor for search, which the seat's names refused first.
    expect(asked).toEqual([
      { type: 'tool', agent: team, action: 'send_email', args: { to: 'team' }, callId: 'e1' },
      { type: 'tool', agent: team, action: 'send_email', args: { to: 'boss' }, callId: 'e2' },
      { type: 'tool', agent: team, action: 'send_email', args: { to: 'all' }, callId: 'e3' },
    ]);
    // Only the approved call and the uncovered tool ran, once each, with their arguments.
    expect(ran).toEqual([
      { name: 'send_email', args: { to: 'boss' } },
      { name: 'note', args: {} },
    ]);
    // The mailer's next step read each outcome: the refusal's reason, the approved call's answer, why the approval that
    // named other arguments was refused, note's answer, and the seat's own refusal.
    const next = s.seen[2];
    expect(toolText(next, 'e1')).toContain('mail is paused');
    expect(toolText(next, 'e2')).toContain('send_email done');
    expect(toolText(next, 'e3')).toContain('modifications.toolArgs');
    expect(toolText(next, 'n1')).toContain('note done');
    expect(toolText(next, 'x1')).toContain('not available in this seat');

    // A personaId seat's call is asked as a temporary seat's is.
    s.replies.push(
      launchStep({ goal: 'Mail the team.', seats: [{ role: 'clerk', personaId: 'clerk', tools: ['send_email'] }] }, 'l2'),
      reply.tools([{ id: 'e4', name: 'send_email', args: { to: 'team' } }]),
      reply.text('Held.'),
      reply.text('Done.'),
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-hitl-clerk' });
    // The lead, the clerk's two steps as its persona, the lead.
    expect(s.seen).toHaveLength(8);
    expect(systemText(s.seen[5])).toContain('You are the clerk.');
    const clerkOut = launchedIn(s.seen[7], 'l2');
    expect(clerkOut).toMatchObject({ status: 'completed', text: 'Held.' });
    expect(clerkOut.seats).toEqual([expect.objectContaining({ role: 'clerk', form: 'persistent', member: 'clerk' })]);
    expect(asked.slice(3)).toEqual([{ type: 'tool', agent: `launch:${clerkOut.agencyId}`, action: 'send_email', args: { to: 'team' }, callId: 'e4' }]);
    expect(toolText(s.seen[6], 'e4')).toContain('mail is paused');
    expect(ran).toHaveLength(2);
  });

  it("agencies.hitl covers a runtime seat's own launch_agency call, which refused launches no team, and asks once about a level-2 seat's call, by the gate of the team the root launch built; the lead's own launch and a call a seat reaches after its launch's deadline ask no one", async () => {
    const k = key();
    const ran: Ran = [];
    const asked: Asked[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(askedOf(request));
      const goal = (request.details.args as { goal?: string } | undefined)?.goal;
      return goal === 'Not today.' ? { approved: false, reason: 'no teams today' } : { approved: true };
    };
    const isFinder = (call: SeenCall): boolean => systemText(call).includes('FINDER');
    const s = script('openai', k, {
      replies: [
        // The lead's team's planner launches a team the policy refuses.
        launchStep({ goal: 'Plan it.', seats: [{ role: 'planner', instructions: 'Plan it.', tools: [LAUNCH_AGENCY_TOOL_NAME] }] }, 'l1'),
        launchStep({ goal: 'Not today.', seats: [{ role: 'finder', instructions: 'FINDER: find it.' }] }, 'n1'),
        reply.text('No team.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, {
      tools: { search: recording('search', ran), slow_write: recording('slow_write', ran, { takesMs: 1_500 }), note: recording('note', ran) },
      agencies: { launch: true, hitl: { approvals: { beforeTool: [LAUNCH_AGENCY_TOOL_NAME, 'search', 'slow_write', 'note'] }, handler } },
    });

    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-gate-refused' });
    // The lead, the planner's two steps, the lead: the planner was offered launch_agency and called it (the precondition).
    expect(s.seen).toHaveLength(4);
    expect(offered(s.seen[1])).toEqual([LAUNCH_AGENCY_TOOL_NAME]);
    const refusedRoot = launchedIn(s.seen[3], 'l1');
    expect(refusedRoot).toMatchObject({ status: 'completed', text: 'No team.' });
    // The planner's launch was asked once, by the lead's team's gate, and refused: no team ran, and the planner read why.
    // The lead's own launch asked no one.
    expect(asked).toEqual([
      { type: 'tool', agent: `launch:${refusedRoot.agencyId}`, action: LAUNCH_AGENCY_TOOL_NAME, args: expect.objectContaining({ goal: 'Not today.' }), callId: 'n1' },
    ]);
    expect(s.seen.filter(isFinder)).toEqual([]);
    expect(toolText(s.seen[2], 'n1')).toContain('no teams today');

    // Approved, the planner's launch makes a level-2 team, whose finder's search is asked once by the same gate, the
    // lead's team's, which the planner's team passed on; each ran once.
    s.replies.push(
      launchStep({ goal: 'Plan the search.', seats: [{ role: 'planner', instructions: 'Plan the search.', tools: ['search', LAUNCH_AGENCY_TOOL_NAME] }] }, 'l2'),
      launchStep({ goal: 'Search.', seats: [{ role: 'finder', instructions: 'FINDER: find it.', tools: ['search'] }] }, 'n2'),
      reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
      reply.text('Found.'),
      reply.text('Planned.'),
      reply.text('All done.'),
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-gate-nested' });
    // The lead, the planner, the finder's two steps, the planner, the lead: the finder was offered search and called it
    // (the precondition).
    expect(s.seen).toHaveLength(10);
    expect(isFinder(s.seen[6])).toBe(true);
    expect(offered(s.seen[6])).toEqual(['search']);
    expect(launchedIn(s.seen[8], 'n2')).toMatchObject({ status: 'completed', text: 'Found.', provenance: { depth: 2 } });
    const root = launchedIn(s.seen[9], 'l2');
    expect(root).toMatchObject({ status: 'completed', text: 'Planned.' });
    const outer = `launch:${root.agencyId}`;
    expect(asked.slice(1)).toEqual([
      { type: 'tool', agent: outer, action: LAUNCH_AGENCY_TOOL_NAME, args: expect.objectContaining({ goal: 'Search.' }), callId: 'n2' },
      { type: 'tool', agent: outer, action: 'search', args: { q: 'x' }, callId: 's1' },
    ]);
    expect(ran).toEqual([{ name: 'search', args: { q: 'x' } }]);

    // A call the writer reaches after its launch's deadline asks no one and never runs; the call before it was asked and ran.
    s.replies.push(
      launchStep({ goal: 'Write, then note.', deadlineMs: 1_000, seats: [{ role: 'writer', instructions: 'Write, then note.', tools: ['slow_write', 'note'] }] }, 'l3'),
      // slow_write runs past the 1,000 ms deadline; note comes after it in the same step.
      reply.tools([
        { id: 'w1', name: 'slow_write', args: {} },
        { id: 'w2', name: 'note', args: {} },
      ]),
      reply.text('Done.'),
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-gate-deadline' });
    await sleep(200);
    // The lead, the writer's step, the lead: nothing more was sent for the writer.
    expect(s.seen).toHaveLength(13);
    const late = launchedIn(s.seen[12], 'l3');
    expect(late.status).toBe('timed_out');
    expect(asked.slice(3)).toEqual([{ type: 'tool', agent: `launch:${late.agencyId}`, action: 'slow_write', args: {}, callId: 'w1' }]);
    expect(ran.slice(1)).toEqual([{ name: 'slow_write', args: {} }]);
  }, 30_000);

  it("a runtime seat's call whose agencies.hitl handler fails never runs, its model is told only that the handler failed, and the launch fails, named by the error's name and code alone, while the logger the host gave the runtime gets the handler's error", async () => {
    const k = key();
    const canary = 'sk-CANARY-3939';
    const thrown = Object.assign(new Error(`the approver at https://ops:${canary}@hooks.example refused`), { name: 'WebhookError', code: 'E_HOOK' });
    const ran: Ran = [];
    let asks = 0;
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Look it up.', seats: [{ role: 'finder', instructions: 'Find it.', tools: ['search'] }] }, 'l1'),
        reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
        reply.text('No search.'),
        reply.text('Handled.'),
      ],
    });
    answerWhole(s, 'ok');
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      },
    };
    const os = await startRuntime(
      k,
      {
        tools: { search: recording('search', ran) },
        agencies: {
          launch: true,
          hitl: {
            approvals: { beforeTool: ['search'] },
            handler: async (): Promise<ApprovalDecision> => {
              asks += 1;
              throw thrown;
            },
          },
        },
      },
      logger,
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-hitl-fails' });
    // The lead, the finder's two steps, the lead: the finder called search and the handler was asked once (the
    // precondition).
    expect(s.seen).toHaveLength(4);
    expect(asks).toBe(1);
    expect(ran).toEqual([]);
    expect(toolText(s.seen[2], 's1')).toContain('the approval handler failed');
    // The parent's turn went on past the failed team, which the result names by the error's name and code alone.
    const out = launchedIn(s.seen[3], 'l1');
    expect(out).toMatchObject({ status: 'failed', reason: 'the team failed: WebhookError (E_HOOK)' });
    expectNoWordOf(canary, [JSON.stringify(s.seen), JSON.stringify(out)]);
    // The logger the host gave the runtime got the handler's own error once, under the launch's run.
    const launchWarnings = warnings.filter(({ message }) => message.startsWith('[AgentOS] launch_agency'));
    expect(launchWarnings.map(({ message }) => message)).toEqual(['[AgentOS] launch_agency run failed']);
    expect(launchWarnings[0].meta).toEqual({ error: expect.objectContaining({ name: 'WebhookError', message: expect.stringContaining(canary) }) });
  });

  it("a runtime seat's call meets agencies.hitl first and then the runtime's own approval of a tool with side effects, which the lead's calls meet too: a refusal by agencies.hitl is final, and the runtime's approver is never asked about that call", async () => {
    const k = key();
    const ran: Ran = [];
    const order: string[] = [];
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Mail them.', seats: [{ role: 'mailer', instructions: 'Send the mail.', tools: ['send_email'] }] }, 'l1'),
        reply.tools([
          { id: 'e1', name: 'send_email', args: { to: 'team' } },
          { id: 'e2', name: 'send_email', args: { to: 'boss' } },
        ]),
        reply.text('Sent to the boss.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    // The runtime's own approver of tools with side effects, which its tool orchestrator asks once its HITL is on.
    const hitlManager = {
      requestApproval: async (pending: { actionId: string; context: { toolName: string } }) => {
        order.push(`runtime ${pending.context.toolName}`);
        return { actionId: pending.actionId, approved: true, decidedBy: 'host', decidedAt: new Date() };
      },
    };
    const os = await startRuntime(k, {
      tools: { search: recording('search', ran), send_email: recording('send_email', ran, { hasSideEffects: true }) },
      toolOrchestratorConfig: {
        orchestratorId: 'host-tools',
        defaultToolCallTimeoutMs: 30_000,
        maxConcurrentToolCalls: 10,
        logToolCalls: false,
        globalDisabledTools: [],
        toolRegistrySettings: { allowDynamicRegistration: true, persistRegistry: false },
        hitl: { enabled: true },
      },
      hitlManager,
      agencies: {
        launch: true,
        hitl: {
          approvals: { beforeTool: ['send_email'] },
          handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
            const to = (request.details.args as { to?: string } | undefined)?.to;
            order.push(`agencies ${request.action} ${to}`);
            return to === 'team' ? { approved: false, reason: 'mail is paused' } : { approved: true };
          },
        },
      },
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-two-approvers' });
    // The lead, the mailer's two steps, the lead.
    expect(s.seen).toHaveLength(4);
    expect(launchedIn(s.seen[3], 'l1')).toMatchObject({ status: 'completed', text: 'Sent to the boss.' });
    // The runtime's approver was asked about the lead's own launch (a tool with side effects), and about the mailer's call
    // after agencies.hitl approved it; never about the call agencies.hitl refused.
    expect(order).toEqual(['runtime launch_agency', 'agencies send_email team', 'agencies send_email boss', 'runtime send_email']);
    expect(ran).toEqual([{ name: 'send_email', args: { to: 'boss' } }]);
    expect(toolText(s.seen[2], 'e1')).toContain('mail is paused');
    expect(toolText(s.seen[2], 'e2')).toContain('send_email done');
  });

  it("agencies.hitl's beforeAgent and beforeReturn are asked in the root team alone, on the full runtime as on gmi(): a team a seat launches runs its seats and returns its answer unasked", async () => {
    const asked: Asked[] = [];
    const hitl = {
      approvals: { beforeAgent: ['planner', 'finder'], beforeReturn: true },
      handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
        asked.push(askedOf(request));
        return { approved: true };
      },
    };
    const replies = () => [
      launchStep({ goal: 'Plan the search.', seats: [{ role: 'planner', instructions: 'Plan the search.', tools: [LAUNCH_AGENCY_TOOL_NAME] }] }, 'l1'),
      launchStep({ goal: 'Search.', seats: [{ role: 'finder', instructions: 'FINDER: find it.' }] }, 'n1'),
      reply.text('Found.'),
      reply.text('Planned.'),
      reply.text('All done.'),
    ];

    // The full runtime.
    const k = key();
    const s = answerWhole(script('openai', k, { replies: replies() }), 'ok');
    const os = await startRuntime(k, { agencies: { launch: true, hitl } });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-root-asks' });
    // The lead, the planner, the finder, the planner, the lead: the planner launched the finder's team, which answered
    // (the precondition).
    expect(s.seen).toHaveLength(5);
    expect(systemText(s.seen[2])).toContain('FINDER: find it.');
    expect(launchedIn(s.seen[3], 'n1')).toMatchObject({ status: 'completed', text: 'Found.', provenance: { depth: 2 } });
    const root = launchedIn(s.seen[4], 'l1');
    expect(root).toMatchObject({ status: 'completed', text: 'Planned.' });
    // The root team asked before its planner ran and before its answer left; the finder's team asked nothing, though
    // beforeAgent names the finder.
    expect(asked).toEqual([
      { type: 'agent', agent: 'planner', action: 'execute' },
      { type: 'output', agent: `launch:${root.agencyId}`, action: 'return' },
    ]);

    // gmi().
    asked.length = 0;
    const kg = key();
    const sg = script('openai', kg, { replies: replies() });
    const parent = gmi({ ...route(kg), instructions: 'Coordinate.', agencies: { launch: true, hitl } });
    const result = await parent.session('p1').send('Plan the search.');
    expect(result.text).toBe('All done.');
    expect(sg.seen).toHaveLength(5);
    expect(systemText(sg.seen[2])).toContain('FINDER: find it.');
    expect(JSON.parse(toolText(sg.seen[3], 'n1'))).toMatchObject({ status: 'completed', text: 'Found.', provenance: { depth: 2 } });
    const gmiRoot = launchOf(result);
    expect(gmiRoot).toMatchObject({ status: 'completed', text: 'Planned.' });
    expect(asked).toEqual([
      { type: 'agent', agent: 'planner', action: 'execute' },
      { type: 'output', agent: `launch:${gmiRoot.agencyId}`, action: 'return' },
    ]);
  });

  it("a composition the runtime's engine holds runs in a seat only whole, each step through the seat's names and agencies.hitl's gate, while a composed call in no team runs its steps unasked, and a composition a host builds over createStepGate meets a seat's names and gate by its own call alone", async () => {
    const k = key();
    const ran: Ran = [];
    const asked: Asked[] = [];
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(askedOf(request));
      return request.action === 'send_email' ? { approved: false, reason: 'mail is paused' } : { approved: true };
    };
    const search = recording('search', ran);
    const note = recording('note', ran);
    // A composition the host builds over its own step gate, of two tools the runtime holds too.
    const hostSteps: Record<string, ITool> = { search, note };
    const hostNotify = new ComposableToolBuilder(createStepGate({ resolve: (name) => hostSteps[name] })).build(
      'host_notify',
      'Looks it up, then notes it.',
      { type: 'object', properties: { q: { type: 'string' } } },
      {
        mode: 'compose',
        steps: [
          { name: 'find', tool: 'search', inputMapping: { q: '$input.q' } },
          { name: 'jot', tool: 'note', inputMapping: { q: '$input.q' } },
        ],
      },
    );
    const s = answerWhole(
      script('openai', k, {
        replies: [
          // The lead forges a composition of search and send_email, as a model does.
          reply.tools([
            {
              id: 'f1',
              name: 'forge_tool',
              args: {
                name: 'notify',
                description: 'Looks it up, then emails the team.',
                inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
                outputSchema: {},
                implementation: {
                  mode: 'compose',
                  steps: [
                    { name: 'find', tool: 'search', inputMapping: { q: '$input.q' } },
                    { name: 'send', tool: 'send_email', inputMapping: { q: '$input.q' } },
                  ],
                },
                testCases: [{ input: { q: 'x' }, expectedOutput: 'sent', stepOutputs: { send: 'sent' } }],
              },
            },
          ]),
          reply.text('Forged.'),
        ],
      }),
      // The engine's judge approves what it is asked about.
      JSON.stringify({ safety: { passed: true, score: 1 }, correctness: { passed: true, score: 1 }, determinism: { likely: true }, confidence: 0.9, reasoning: 'Safe and correct.' }),
    );
    const os = await startRuntime(k, {
      emergent: true,
      // send_email has side effects, so a composition chains it only once the host lists it.
      emergentConfig: { compose: { sideEffectingTools: ['send_email'] } },
      tools: { search, send_email: recording('send_email', ran, { hasSideEffects: true }), note, host_notify: hostNotify },
      agencies: { launch: true, hitl: { approvals: { beforeTool: ['notify', 'send_email', 'host_notify', 'note'] }, handler } },
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-forge' });
    // The forge took (the precondition); its dry run may run the search step.
    expect(s.seen).toHaveLength(2);
    expect(toolText(s.seen[1], 'f1')).not.toContain('Error from tool');
    const afterForge = ran.length;

    s.replies.push(
      reply.tools([
        // Without send_email in the allowlist the composition could not run whole.
        { id: 'l1', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Notify.', seats: [{ role: 'mailer', instructions: 'Notify the team.', tools: ['notify', 'search'] }] } },
        { id: 'l2', name: LAUNCH_AGENCY_TOOL_NAME, args: { goal: 'Notify.', seats: [{ role: 'mailer', instructions: 'Notify the team.', tools: ['notify', 'search', 'send_email'] }] } },
      ]),
      reply.tools([{ id: 'c1', name: 'notify', args: { q: 'x' } }]),
      reply.text('Mail held.'),
      reply.text('Done.'),
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-compose' });
    // The lead, the mailer's two steps, the lead: the narrow launch ran no seat.
    expect(s.seen).toHaveLength(6);
    const narrow = toolText(s.seen[5], 'l1');
    expect(narrow).toContain('tool_not_allowed');
    expect(narrow).toContain("'notify' is a composed tool whose step 'send_email' the seat's allowlist leaves out");
    // With the whole allowlist the mailer was offered the three tools and called the composition (the precondition).
    expect(offered(s.seen[3]).sort()).toEqual(['notify', 'search', 'send_email']);
    const wide = launchedIn(s.seen[5], 'l2');
    expect(wide).toMatchObject({ status: 'completed', text: 'Mail held.' });
    const team = `launch:${wide.agencyId}`;
    // The team's gate asked about the composed call by its name, then about its send_email step by the step tool's
    // name, before the step ran; the search step, which the policy does not cover, ran unasked, and send_email never ran.
    expect(asked.map(({ agent, action }) => `${agent} ${action}`)).toEqual([`${team} notify`, `${team} send_email`]);
    expect(asked[0]).toMatchObject({ args: { q: 'x' }, callId: 'c1' });
    expect(asked[1]).toMatchObject({ args: { q: 'x' } });
    expect(ran.slice(afterForge)).toEqual([{ name: 'search', args: { q: 'x' } }]);
    expect(toolText(s.seen[4], 'c1')).toContain('mail is paused');

    // A composed call in no team, the lead's own, runs its steps as before: no one is asked, and both steps run.
    s.replies.push(reply.tools([{ id: 'c2', name: 'notify', args: { q: 'y' } }]), reply.text('Notified.'));
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-direct' });
    expect(s.seen).toHaveLength(8);
    expect(toolText(s.seen[7], 'c2')).not.toContain('Error from tool');
    expect(asked).toHaveLength(2);
    expect(ran.slice(afterForge + 1)).toEqual([
      { name: 'search', args: { q: 'y' } },
      { name: 'send_email', args: { q: 'y' } },
    ]);

    // A composition the host built over createStepGate runs its steps through its own gate: the seat's call to it is
    // asked by its name, and its steps run outside the seat's view, its names and its gate: note, which the seat's
    // allowlist leaves out and the policy covers, runs unasked.
    s.replies.push(
      launchStep({ goal: 'Run it.', seats: [{ role: 'runner', instructions: 'Run it.', tools: ['host_notify'] }] }, 'l3'),
      reply.tools([{ id: 'h1', name: 'host_notify', args: { q: 'z' } }]),
      reply.text('Ran.'),
      reply.text('Done.'),
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-host' });
    expect(s.seen).toHaveLength(12);
    expect(offered(s.seen[9])).toEqual(['host_notify']);
    const hostTeam = launchedIn(s.seen[11], 'l3');
    expect(hostTeam).toMatchObject({ status: 'completed', text: 'Ran.' });
    expect(asked.slice(2)).toEqual([{ type: 'tool', agent: `launch:${hostTeam.agencyId}`, action: 'host_notify', args: { q: 'z' }, callId: 'h1' }]);
    expect(ran.slice(afterForge + 3)).toEqual([
      { name: 'search', args: { q: 'z' } },
      { name: 'note', args: { q: 'z' } },
    ]);
  });

  it("an agencies.hitl approval on the full runtime is for the tool it was asked about: a tool the host registers under the name while the approval waits never runs under it, nor does the one it replaced", async () => {
    const k = key();
    const ran: Ran = [];
    const asked: Asked[] = [];
    let os!: AgentOS;
    const handler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(askedOf(request));
      // While the approval is pending, the host registers another send_email through the runtime's tool orchestrator.
      await os.getToolOrchestrator().registerTool({
        ...hostTool('send_email', async (args) => {
          ran.push({ name: 'send_email (replacement)', args });
          return { success: true, output: 'sent by the replacement' };
        }),
        id: 'host-send_email-replacement',
        inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
        hasSideEffects: true,
      });
      return { approved: true };
    };
    const s = answerWhole(
      script('openai', k, {
        replies: [
          launchStep({ goal: 'Email the team.', seats: [{ role: 'mailer', instructions: 'Send the mail.', tools: ['send_email'] }] }, 'l1'),
          reply.tools([{ id: 'e1', name: 'send_email', args: { to: 'team' } }]),
          reply.text('Mail held.'),
          reply.text('Done.'),
        ],
      }),
      'ok',
    );
    os = await startRuntime(k, {
      tools: { search: recording('search', ran), send_email: recording('send_email', ran, { hasSideEffects: true }) },
      agencies: { launch: true, hitl: { approvals: { beforeTool: ['send_email'] }, handler } },
    });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-replaced' });
    // The lead, the mailer's two steps, the lead: the mailer called send_email and the handler approved it (the
    // precondition).
    expect(s.seen).toHaveLength(4);
    const out = launchedIn(s.seen[3], 'l1');
    expect(out).toMatchObject({ status: 'completed', text: 'Mail held.' });
    expect(asked).toEqual([{ type: 'tool', agent: `launch:${out.agencyId}`, action: 'send_email', args: { to: 'team' }, callId: 'e1' }]);
    // The name then held another tool, which the approval was not asked about: neither tool ran, and the mailer read why.
    expect(ran).toEqual([]);
    expect(toolText(s.seen[2], 'e1')).toContain('step_replaced');
  });

  it("an agencies.hitl handler that fails on a level-2 seat's call fails the root team's call, whose gate it is: the level-2 team reports how it ran, every later call under that gate is refused unasked, and the root launch fails, named by the error's name and code alone", async () => {
    const k = key();
    const canary = 'sk-CANARY-4141';
    const thrown = Object.assign(new Error(`the approver at https://ops:${canary}@hooks.example refused`), { name: 'WebhookError', code: 'E_HOOK' });
    const ran: Ran = [];
    let asks = 0;
    const s = answerWhole(
      script('openai', k, {
        replies: [
          launchStep({ goal: 'Plan the search.', seats: [{ role: 'planner', instructions: 'Plan the search.', tools: ['search', LAUNCH_AGENCY_TOOL_NAME] }] }, 'l1'),
          launchStep({ goal: 'Search.', seats: [{ role: 'finder', instructions: 'FINDER: find it.', tools: ['search'] }] }, 'n1'),
          // The finder's search: the handler fails.
          reply.tools([{ id: 's1', name: 'search', args: { q: 'x' } }]),
          reply.text('No search.'),
          // The planner's own search, a later call under the same gate.
          reply.tools([{ id: 's2', name: 'search', args: { q: 'y' } }]),
          reply.text('Planned.'),
          reply.text('Handled.'),
        ],
      }),
      'ok',
    );
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
      },
    };
    const os = await startRuntime(
      k,
      {
        tools: { search: recording('search', ran) },
        agencies: {
          launch: true,
          hitl: {
            approvals: { beforeTool: ['search'] },
            handler: async (): Promise<ApprovalDecision> => {
              asks += 1;
              throw thrown;
            },
          },
        },
      },
      logger,
    );
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-nested-fails' });
    // The lead, the planner, the finder's two steps, the planner's two steps, the lead: the finder and then the planner
    // called search (the precondition).
    expect(s.seen).toHaveLength(7);
    expect(systemText(s.seen[2])).toContain('FINDER: find it.');
    // The handler was asked once, for the finder's call, and failed: the finder was told only that it failed.
    expect(asks).toBe(1);
    expect(ran).toEqual([]);
    expect(toolText(s.seen[3], 's1')).toContain('the approval handler failed');
    // The level-2 team reported how its own team ran.
    expect(launchedIn(s.seen[4], 'n1')).toMatchObject({ status: 'completed', text: 'No search.' });
    // The planner's later call under the root team's gate was refused, the handler not asked again.
    expect(toolText(s.seen[5], 's2')).toContain('an earlier tool approval failed');
    // The root team's call rejected with the handler's error: the root launch failed, named by its name and code alone.
    const root = launchedIn(s.seen[6], 'l1');
    expect(root).toMatchObject({ status: 'failed', reason: 'the team failed: WebhookError (E_HOOK)' });
    expectNoWordOf(canary, [JSON.stringify(s.seen), JSON.stringify(root)]);
    const launchWarnings = warnings.filter(({ message }) => message.startsWith('[AgentOS] launch_agency'));
    expect(launchWarnings.map(({ message }) => message)).toEqual(['[AgentOS] launch_agency run failed']);
    expect(launchWarnings[0].meta).toEqual({ error: expect.objectContaining({ name: 'WebhookError', message: expect.stringContaining(canary) }) });
  });

  it("a launched team's manager and synthesizer go out under the key and base URL of the runtime's entry for their provider, the one its own provider runs on, before the environment's; a coordinator the host names takes that pair when it names neither, and keeps a key or a base URL it names without the entry's", async () => {
    // A provider's key picks the script it plays, so a call shows the key it went out under; the base URL is what the
    // provider was started with. The environment holds no key and no base URL until a step sets one.
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_BASE_URL', '');
    try {
      /** The manager's call a script's provider answered: its model, and the key and base URL that provider started with. */
      const managerCall = (played: WholeAnswering) => {
        const i = (played.wholeSeen ?? []).findIndex((messages) => messages.includes('You are a manager agent'));
        return i < 0 ? undefined : played.wholeFrom?.[i];
      };
      const hierarchical = (id: string) => launchStep({ goal: 'Decide.', strategy: 'hierarchical', seats: [{ role: 'checker', personaId: 'checker' }] }, id);
      const entry = (apiKey: string, extra: Record<string, unknown> = {}, enabled = true) => ({ providerId: 'openai', enabled, isDefault: true, config: { apiKey, ...extra } });

      // The runtime's one entry names a key and a base URL, and the host names no coordinator: the hierarchical manager
      // goes out under the entry's key, to its base URL, on the lead's model, and its answer completes the launch.
      const k = key();
      const url = 'https://llm.example.test/v1';
      const s = answerWhole(script('openai', k, { replies: [hierarchical('h1'), reply.text('Done.')] }), 'Decided by the manager.');
      const os = await startRuntime(k, { modelProviderManagerConfig: { providers: [entry(k, { baseURL: url })] } });
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-key-1' });
      // The lead's two requests (the precondition): the manager answered without delegating.
      expect(s.seen).toHaveLength(2);
      const decided = launchedIn(s.seen[1], 'h1');
      expect(decided).toMatchObject({ status: 'completed', text: 'Decided by the manager.' });
      expect(managerCall(s)).toEqual({ modelId: 'stub-model', apiKey: k, baseURL: url });
      // The manager's calls are the coordinator's, charged to the launch's budget.
      expect(decided.coordinatorUsage.totalTokens).toBeGreaterThan(0);
      expect(decided.provenance.budget.tokensUsed).toBeGreaterThanOrEqual(decided.coordinatorUsage.totalTokens);

      // With a key in the environment too, a parallel team's synthesizer goes out under the entry's key and base URL.
      const kEnv = key();
      const fromEnv = answerWhole(script('openai', kEnv), "Answered under the environment's key.");
      vi.stubEnv('OPENAI_API_KEY', kEnv);
      s.answerWhole = 'Two answers in one.';
      s.replies.push(
        launchStep({ goal: 'Two views.', strategy: 'parallel', seats: [{ role: 'a', instructions: 'Give view A.' }, { role: 'b', instructions: 'Give view B.' }] }, 'p1'),
        reply.text('View A.'),
        reply.text('View B.'),
        reply.text('Done.'),
      );
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-key-2' });
      // The lead, the two seats, the lead (the precondition).
      expect(s.seen).toHaveLength(6);
      expect(launchedIn(s.seen[5], 'p1')).toMatchObject({ status: 'completed', text: 'Two answers in one.' });
      const synthesis = (s.wholeSeen ?? []).findIndex((messages) => messages.includes('Synthesize these into a single coherent response.'));
      expect(synthesis).toBeGreaterThanOrEqual(0);
      expect(s.wholeFrom?.[synthesis]).toEqual({ modelId: 'stub-model', apiKey: k, baseURL: url });
      expect(fromEnv.wholeSeen ?? []).toEqual([]);

      // The runtime's own provider runs on its last enabled entry for the provider, a disabled one passed over, and the
      // manager takes that entry's pair; a coordinator the host names with neither a key nor a base URL takes it too,
      // on the coordinator's own model.
      vi.stubEnv('OPENAI_API_KEY', '');
      const [kOff, kFirst, kLast] = [key(), key(), key()];
      const urlLast = 'https://last.example.test/v1';
      const off: WholeAnswering = script('openai', kOff);
      const first = answerWhole(script('openai', kFirst), 'Answered under the first entry.');
      const last = answerWhole(script('openai', kLast, { replies: [hierarchical('h2'), reply.text('Done.')] }), "Decided on the coordinator's model.");
      const os2 = await startRuntime(kLast, {
        modelProviderManagerConfig: { providers: [entry(kOff, { baseURL: 'https://off.example.test/v1' }, false), entry(kFirst), entry(kLast, { baseURL: urlLast })] },
        agencies: { launch: true, coordinator: { provider: 'openai', model: 'coordinator-model' } },
      });
      await runTurn(os2, { selectedPersonaId: 'lead', sessionId: 'r-key-3' });
      // The lead ran on the last entry and the disabled entry's provider never started (the preconditions).
      expect(last.seen).toHaveLength(2);
      expect(off.starts ?? []).toEqual([]);
      expect(launchedIn(last.seen[1], 'h2')).toMatchObject({ status: 'completed', text: "Decided on the coordinator's model." });
      expect(managerCall(last)).toEqual({ modelId: 'coordinator-model', apiKey: kLast, baseURL: urlLast });
      expect(first.wholeSeen ?? []).toEqual([]);

      // A coordinator that names its own key keeps it, and takes no base URL of the entry's.
      const [kRun, kOwn] = [key(), key()];
      const run = answerWhole(script('openai', kRun, { replies: [hierarchical('h3'), reply.text('Done.')] }), "Answered under the runtime's key.");
      const own = answerWhole(script('openai', kOwn), "Decided under the coordinator's key.");
      const os3 = await startRuntime(kRun, {
        modelProviderManagerConfig: { providers: [entry(kRun, { baseURL: 'https://run.example.test/v1' })] },
        agencies: { launch: true, coordinator: { provider: 'openai', model: 'stub-model', apiKey: kOwn } },
      });
      await runTurn(os3, { selectedPersonaId: 'lead', sessionId: 'r-key-4' });
      expect(run.seen).toHaveLength(2);
      expect(launchedIn(run.seen[1], 'h3')).toMatchObject({ status: 'completed', text: "Decided under the coordinator's key." });
      expect(managerCall(own)).toEqual({ modelId: 'stub-model', apiKey: kOwn });
      expect(managerCall(run)).toBeUndefined();

      // A coordinator that names its own base URL takes no key of the entry's: the key is the one generateText resolves
      // for a call that names none, here the environment's, so the runtime's key never goes to a base URL the host did
      // not name with it.
      vi.stubEnv('OPENAI_API_KEY', kEnv);
      fromEnv.answerWhole = "Decided under the environment's key.";
      const kRun2 = key();
      const mine = 'https://mine.example.test/v1';
      const run2 = answerWhole(script('openai', kRun2, { replies: [hierarchical('h4'), reply.text('Done.')] }), "Answered under the runtime's key.");
      const os4 = await startRuntime(kRun2, {
        modelProviderManagerConfig: { providers: [entry(kRun2, { baseURL: 'https://run2.example.test/v1' })] },
        agencies: { launch: true, coordinator: { provider: 'openai', model: 'stub-model', baseUrl: mine } },
      });
      await runTurn(os4, { selectedPersonaId: 'lead', sessionId: 'r-key-5' });
      expect(run2.seen).toHaveLength(2);
      expect(launchedIn(run2.seen[1], 'h4')).toMatchObject({ status: 'completed', text: "Decided under the environment's key." });
      expect(managerCall(fromEnv)).toEqual({ modelId: 'stub-model', apiKey: kEnv, baseURL: mine });
      expect((run2.starts ?? []).filter((start) => start.baseURL === mine)).toEqual([]);
      expect(managerCall(run2)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the package root and its ./api entry name the types of the runtime's agencies option, a launch tree's limits, a seat's frame, the turn that made a tool call, a tool hook and a launched team's registry record, and each fits what the package hands a host", async () => {
    // A host's bounds for its launch trees, typed by the package's LaunchLimits, given to the runtime as its agencies
    // option, which both entries name.
    const limits: LaunchLimits = { maxDepth: 2, maxSeats: 3, maxConcurrent: 1, budgetShare: 0.5, maxLaunchTokens: 100_000, defaultDeadlineMs: 60_000, maxDeadlineMs: 120_000 };
    const limitsViaApi: ApiEntry.LaunchLimits = limits;
    const agencies: RuntimeAgencyLaunchOptions = { launch: true, ...limitsViaApi };
    const agenciesViaApi: ApiEntry.RuntimeAgencyLaunchOptions = agencies;
    // On the full runtime a seat's tool reads its frame, the turn that made the call and its team's registry record by
    // the package's types.
    const reads: Array<{ frame?: ApiEntry.AgencyLaunchFrame; names?: string[]; record?: ApiEntry.LaunchRecordMetadata }> = [];
    let os!: AgentOS;
    const look = configTool('look', async (context) => {
      const frame: AgencyLaunchFrame | undefined = context.sessionData?.agencyLaunch;
      const turn: CallerTurnContext | undefined = context.callerTurn;
      // A listed session's metadata is a record of unknowns; a launched team's is the package's LaunchRecordMetadata.
      const record = os.listAgencies()[0]?.metadata as unknown as LaunchRecordMetadata | undefined;
      reads.push({ frame, names: turn?.toolNames ? [...turn.toolNames] : undefined, record });
      return 'looked';
    });
    const k = key();
    const s = answerWhole(
      script('openai', k, {
        replies: [
          launchStep({ goal: 'Look around.', strategy: 'sequential', seats: [{ role: 'eye', instructions: 'Look around.', tools: ['look'] }] }, 'l1'),
          reply.tools([{ id: 'x1', name: 'look', args: {} }]),
          reply.text('Seen.'),
          reply.text('Done.'),
        ],
      }),
      'ok',
    );
    os = await startRuntime(k, { tools: { search: configTool('search', async () => 'found'), look }, agencies: agenciesViaApi });
    await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-types' });
    // The lead, the eye's two steps, the lead (the precondition).
    expect(s.seen).toHaveLength(4);
    const out = launchedIn(s.seen[3], 'l1');
    expect(out).toMatchObject({ status: 'completed', text: 'Seen.' });
    expect(reads).toEqual([
      {
        frame: { launchId: out.agencyId, role: 'eye', depth: 1 },
        names: ['look'],
        record: expect.objectContaining({
          kind: 'launched',
          parentPersonaId: 'lead',
          launchingSessionId: 'r-types',
          depth: 1,
          strategy: 'sequential',
          status: 'running',
          goalPreview: 'Look around.',
        }),
      },
    ]);

    // On gmi() a host types its tool hook by the package's ToolCallHook: a seat's call runs under it, and the turn that
    // made the call names it among the hooks its calls run under.
    const hooked: string[] = [];
    const hook: ToolCallHook = async (info) => {
      hooked.push(info.name);
      return info;
    };
    const hookViaApi: ApiEntry.ToolCallHook = hook;
    const turns: Array<ApiEntry.CallerTurnContext | undefined> = [];
    const k2 = key();
    script('openai', k2, {
      replies: [
        launchStep({ goal: 'Peek.', seats: [{ role: 'peeker', instructions: 'Peek.', tools: ['peek'] }] }, 'g1'),
        reply.tools([{ id: 'p1', name: 'peek', args: {} }]),
        reply.text('Peeked.'),
        reply.text('Done.'),
      ],
    });
    const lead = gmi({
      ...route(k2),
      instructions: 'Lead.',
      tools: {
        peek: hostTool('peek', async (_args, context) => {
          turns.push(context.callerTurn);
          return { success: true, output: 'peeked' };
        }),
      },
      onBeforeToolExecution: hookViaApi,
      agencies: { launch: true },
    });
    const result = await lead.session('g-types').send('Go.');
    expect(launchOf(result)).toMatchObject({ status: 'completed', text: 'Peeked.' });
    expect(hooked).toEqual([LAUNCH_AGENCY_TOOL_NAME, 'peek']);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.toolHooks).toEqual([hook]);
    expect([...(turns[0]?.toolNames ?? [])]).toEqual(['peek']);
  });

  it("a seat's session is its team's until the seat is released: a request that names it is refused before any model call, under the seat's persona or another, and the seats run on as themselves; feedback that names it reaches no seat; once the seat is released, the session serves a request", async () => {
    const k = key();
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const hang = configTool('hang', async () => {
      held = true;
      await hanging;
      return 'done';
    });
    const s = script('openai', k, {
      replies: [
        launchStep(
          { goal: 'Check, then wait.', deadlineMs: 30_000, seats: [{ role: 'first', personaId: 'checker' }, { role: 'second', instructions: 'Call hang.', tools: ['hang'] }] },
          'l1',
        ),
        reply.text('Checked.'),
        // The second seat's tool holds its turn while the requests and the feedback name the seats' sessions.
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('Waited.'),
        reply.text('Done.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, { tools: { search: configTool('search', async () => 'found'), hang } });
    /** A request of another user's, as a host passes it on: every chunk the runtime streams. */
    const outside = async (input: { sessionId: string; selectedPersonaId: string; textInput: string }): Promise<AgentOSResponse[]> => {
      const chunks: AgentOSResponse[] = [];
      for await (const chunk of os.processRequest({ userId: 'eve', ...input } as AgentOSInput)) chunks.push(chunk);
      return chunks;
    };
    const feedback = (text: string): UserFeedbackPayload => ({ rating: 'negative', text });
    try {
      const parent = runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-seats' });
      await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 });
      const [team] = os.listAgencies();
      const firstSession = `seat:${team.agencyId}:first`;
      const secondSession = `seat:${team.agencyId}:second`;
      // Both seats hold a GMI: the first answered and is idle, the second waits in its tool (the precondition).
      const manager = os.getGMIManager();
      const gmiOf = (sessionId: string) => manager.activeGMIs.get(manager.gmiSessionMap.get(sessionId) ?? '');
      expect(gmiOf(firstSession)?.getPersona().id).toBe('checker');
      expect(gmiOf(secondSession)).toBeDefined();
      const firstGmi = gmiOf(firstSession)!;
      const secondGmiId = gmiOf(secondSession)!.getGMIId();
      const seen = s.seen.length;

      // A request naming the idle seat's session under the seat's own persona, and one naming the running seat's
      // session under another persona: each turn ends with the manager's refusal, and no model call receives either.
      const [own, other, unknown] = await Promise.all([
        outside({ sessionId: firstSession, selectedPersonaId: 'checker', textInput: 'First outside request.' }),
        outside({ sessionId: secondSession, selectedPersonaId: 'helper', textInput: 'Second outside request.' }),
        outside({ sessionId: firstSession, selectedPersonaId: 'no-such-persona', textInput: 'Third outside request.' }),
      ]);
      for (const chunks of [own, other, unknown]) {
        const error = chunks.find((chunk) => chunk.type === AgentOSResponseChunkType.ERROR) as { message?: string } | undefined;
        expect(error?.message).toContain('is a seat of a team a GMI launched; no request runs in it.');
        expect(chunks.some((chunk) => chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(false);
      }
      expect(s.seen).toHaveLength(seen);
      // The manager refuses the session itself with its permission code, whatever persona the caller names.
      const acquired = await manager.getOrCreateGMIForSession('eve', firstSession, 'helper').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(acquired).toBeInstanceOf(GMIManagerError);
      expect(acquired).toMatchObject({ code: 'AUTH_PERMISSION_DENIED' });
      // The running seat kept its GMI: the other persona's request shut nothing down.
      expect(manager.gmiSessionMap.get(secondSession)).toBe(secondGmiId);

      // Feedback naming the idle seat's session is not recorded; feedback on the launching session is (the control).
      await os.receiveFeedback('eve', firstSession, 'checker', feedback('Feedback from outside the team.'));
      await os.receiveFeedback('ana', 'r-seats', 'lead', feedback('Feedback on the lead.'));
      expect(JSON.stringify(firstGmi.getReasoningTrace().entries)).not.toContain('Feedback from outside the team.');
      expect(JSON.stringify(gmiOf('r-seats')?.getReasoningTrace().entries)).toContain('Feedback on the lead.');

      // The second seat's tool returns: both seats answered as themselves, and the launch completed.
      release();
      await parent;
      const out = launchedIn(s.seen[4], 'l1');
      expect(out.status).toBe('completed');
      expect(out.seats.map((seat) => [seat.role, seat.status, seat.summary])).toEqual([
        ['first', 'completed', 'Checked.'],
        ['second', 'completed', 'Waited.'],
      ]);
      expect(JSON.stringify(s.seen)).not.toContain('outside request');

      // Once the seats are released, the session no team holds serves a request again, on a GMI of its own.
      await vi.waitFor(() => expect(os.listAgencies()).toEqual([]), { timeout: 10_000 });
      expect(manager.gmiSessionMap.has(firstSession)).toBe(false);
      s.replies.push(reply.text('Served after the team.'));
      const later = await outside({ sessionId: firstSession, selectedPersonaId: 'helper', textInput: 'A later request.' });
      expect(later.some((chunk) => chunk.type === AgentOSResponseChunkType.ERROR)).toBe(false);
      expect(s.seen).toHaveLength(6);
      expect(lastUserText(s.seen[5])).toContain('A later request.');
      expect(systemText(s.seen[5])).toContain('You are the helper.');
    } finally {
      release();
    }
  }, 40_000);

  it("the idle cleanup passes by a seat its launch still holds: the seat keeps its GMI and its listing while the idle GMIs go, and its launch releases it", async () => {
    const k = key();
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = configTool('hang', async () => {
      await hanging;
      return 'done';
    });
    const s = script('openai', k, {
      replies: [
        launchStep({ goal: 'Wait.', deadlineMs: 1_000, seats: [{ role: 'waiter', instructions: 'Call hang.', tools: ['hang'] }] }, 'l1'),
        // The waiter's tool runs past the deadline and the grace, so the launch returns with the seat still held.
        reply.tools([{ id: 'h1', name: 'hang', args: {} }]),
        reply.text('Timed out.'),
      ],
    });
    answerWhole(s, 'ok');
    const os = await startRuntime(k, { tools: { search: configTool('search', async () => 'found'), hang } });
    try {
      await runTurn(os, { selectedPersonaId: 'lead', sessionId: 'r-idle' });
      const out = launchedIn(s.seen[2], 'l1');
      expect(out.status).toBe('timed_out');
      const [listed] = os.listAgencies();
      expect(listed.metadata).toMatchObject({ kind: 'launched', status: 'closing' });
      const waiterGmi = listed.seats.waiter.gmiInstanceId;
      const manager = os.getGMIManager();
      const leadGmi = manager.gmiSessionMap.get('r-idle');
      expect(leadGmi).toBeDefined();
      await sleep(5);

      // The cleanup ran (the lead's idle GMI went), and the seat its launch still holds kept its GMI and its listing.
      await manager.cleanupInactiveGMIs(0);
      expect(manager.gmiSessionMap.has('r-idle')).toBe(false);
      expect(await activeGmis(os)).not.toContain(leadGmi);
      expect(await activeGmis(os)).toContain(waiterGmi);
      expect(os.listAgencies().map((entry) => entry.agencyId)).toEqual([out.agencyId]);

      // Once the tool returns, its launch releases the seat, and the team and its GMI go.
      release();
      await vi.waitFor(() => expect(os.listAgencies()).toEqual([]), { timeout: 10_000 });
      expect(await activeGmis(os)).not.toContain(waiterGmi);
    } finally {
      release();
    }
  }, 40_000);
});
