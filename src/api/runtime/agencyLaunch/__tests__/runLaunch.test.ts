/**
 * The launch engine, with a fake host and fake seats under the real agency(): validation, the child's
 * caps, one case per refusal code, the run and its statuses, and the deadline and the grace. Pure engine logic; the
 * surfaces' own tests run the real seats.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../../../../core/tools/ITool.js';
import { SpendBudget } from '../../spendBudget.js';
import { launchRegistry, type LaunchEntry } from '../launchRegistry.js';
import { childBudgetCaps, runLaunch, validateLaunchArgs, type LaunchHost, type LaunchParent, type ResolvedSeat } from '../runLaunch.js';
import type { SeatHandle } from '../sessionSeat.js';
import {
  resolveLaunchLimits,
  type LaunchAgencyArgs,
  type LaunchAgencyResult,
  type LaunchLimits,
  type LaunchRefusal,
  type LaunchSeatRecord,
} from '../types.js';

const seat = (role: string, extra: Record<string, unknown> = {}) => ({ role, instructions: `Be the ${role}.`, ...extra });
const args = (extra: Partial<LaunchAgencyArgs> & Record<string, unknown> = {}): LaunchAgencyArgs =>
  ({ goal: 'Write the report.', seats: [seat('writer')], ...extra }) as LaunchAgencyArgs;

describe('validateLaunchArgs', () => {
  it('accepts a one-seat subagent and every strategy with its seat count', () => {
    expect(validateLaunchArgs(args())).toBeUndefined();
    expect(validateLaunchArgs(args({ strategy: 'review-loop', seats: [seat('writer'), seat('critic')] }))).toBeUndefined();
    expect(validateLaunchArgs(args({ strategy: 'graph', seats: [seat('a'), seat('b', { dependsOn: ['a'] })] }))).toBeUndefined();
    expect(validateLaunchArgs(args({ seats: [{ role: 'tutor', agentKey: 'tutor', brief: 'Check the maths.' }] as LaunchAgencyArgs['seats'] }))).toBeUndefined();
  });

  it('refuses each malformed argument with invalid_arguments, naming the first problem', () => {
    const cases: Array<[LaunchAgencyArgs, RegExp]> = [
      [args({ goal: '' }), /goal/],
      [args({ goal: 'x'.repeat(8_001) }), /goal/],
      [args({ extra: true }), /unknown argument 'extra'/],
      [args({ strategy: 'panel' as never }), /strategy/],
      [args({ seats: [] }), /at least one seat/],
      [args({ seats: [seat('writer', { colour: 'blue' })] }), /unknown key 'colour'/],
      [args({ seats: [seat('9lives')] }), /role/],
      [args({ seats: [seat('r'.repeat(53))] }), /52 characters/],
      [args({ seats: [seat('delegate_to_writer')] }), /hierarchical strategy uses/],
      [args({ seats: [seat('plan')] }), /hierarchical strategy uses/],
      [args({ seats: [seat('writer'), seat('writer')] }), /unique/],
      [args({ seats: [{ role: 'writer' } as never] }), /exactly one of instructions, agentKey and personaId/],
      [args({ seats: [{ role: 'w', instructions: 'x', agentKey: 'k' } as never] }), /exactly one/],
      [args({ seats: [seat('writer', { instructions: 'x'.repeat(8_193) })] }), /8,192/],
      [args({ seats: [{ role: 'tutor', agentKey: 'tutor', brief: 'x'.repeat(1_001) }] as never }), /1,000/],
      [args({ seats: [seat('writer', { brief: 'Short.' })] }), /brief/],
      [args({ seats: [seat('writer', { tools: 'search' })] }), /tools/],
      [args({ seats: [seat('a', { dependsOn: ['ghost'] })] }), /dependsOn names 'ghost'/],
      [args({ strategy: 'graph', seats: [seat('a', { dependsOn: ['b'] }), seat('b', { dependsOn: ['a'] })] }), /cycle/],
      [args({ strategy: 'review-loop', seats: [seat('a'), seat('b'), seat('c')] }), /review-loop takes exactly 2 seats/],
      [args({ strategy: 'parallel' }), /parallel takes at least 2 seats/],
      [args({ strategy: 'debate' }), /debate takes at least 2 seats/],
      [args({ deadlineMs: 999 }), /deadlineMs/],
      [args({ maxRounds: 4 }), /maxRounds/],
      [args({ budgetUsd: 0 }), /budgetUsd/],
      [args({ maxTokens: -1 }), /maxTokens/],
    ];
    for (const [input, reason] of cases) {
      const refusal = validateLaunchArgs(input);
      expect(refusal?.code, String(reason)).toBe('invalid_arguments');
      expect(refusal?.reason).toMatch(reason);
    }
  });
});

describe('childBudgetCaps', () => {
  const limits = resolveLaunchLimits({});
  const pool = (tokens = 200_000, usd = Number.POSITIVE_INFINITY) => new SpendBudget({ maxCostUSD: usd, maxTotalTokens: tokens, unpriced: 'allow' });

  it("takes the parent's remaining times the share, the pool and the arguments, the least of each", () => {
    const parent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 20_000, unpriced: 'allow' });
    parent.record(0.2, 6_000, 'step');
    expect(childBudgetCaps(parent, pool(), limits, {}, 2_000)).toEqual({ maxCostUSD: 0.4, maxTotalTokens: 7_000 });
    expect(childBudgetCaps(parent, pool(5_000, 0.1), limits, {}, 2_000)).toEqual({ maxCostUSD: 0.1, maxTotalTokens: 5_000 });
    expect(childBudgetCaps(parent, pool(), limits, { budgetUsd: 0.05, maxTokens: 4_500 }, 2_000)).toEqual({ maxCostUSD: 0.05, maxTotalTokens: 4_500 });
  });

  it('a parent with no token cap, or no budget at all, leaves the pool to bound the tokens', () => {
    const noTokenCap = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    expect(childBudgetCaps(noTokenCap, pool(3_000), limits, {}, 1_000)).toEqual({ maxCostUSD: 0.5, maxTotalTokens: 3_000 });
    expect(childBudgetCaps(undefined, pool(3_000), limits, {}, 1_000)).toEqual({ maxCostUSD: Number.POSITIVE_INFINITY, maxTotalTokens: 3_000 });
  });

  it("an unpriced parent's spend counts tokens and no dollars", () => {
    const parent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    parent.record(undefined, 4_000, 'step');
    expect(childBudgetCaps(parent, pool(), limits, {}, 1_000)).toEqual({ maxCostUSD: 0.5, maxTotalTokens: 3_000 });
  });

  it('refuses a cap that cannot cover one call, and a spent parent', () => {
    expect(childBudgetCaps(undefined, pool(2_500), limits, {}, 1_000)).toMatchObject({ code: 'budget_unavailable' });
    expect(childBudgetCaps(undefined, pool(3_000), limits, {}, 1_000)).toEqual({ maxCostUSD: Number.POSITIVE_INFINITY, maxTotalTokens: 3_000 });
    const spent = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 10_000, unpriced: 'allow' });
    spent.record(1, 1_000, 'step');
    expect(childBudgetCaps(spent, pool(), limits, {}, 1_000)).toMatchObject({ code: 'budget_unavailable', reason: expect.stringContaining('dollars') });
  });
});

type Answer = (input: string, opts: Record<string, unknown> | undefined) => Promise<string>;
interface FakeSeat extends SeatHandle {
  closed: boolean;
  inputs: string[];
}

/** A seat that answers with `answer`, records what it did, and closes with `close`. */
function fakeSeat(role: string, answer: Answer = async () => `${role} done.`, close: () => Promise<void> = async () => undefined): FakeSeat {
  const record: LaunchSeatRecord = { role, form: 'temporary', status: 'not_run', calls: 0, summary: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  const fake: FakeSeat = {
    seatId: `seat:test:${role}`,
    closed: false,
    inputs: [],
    async generate(input: string, opts?: Record<string, unknown>) {
      record.calls += 1;
      fake.inputs.push(input);
      try {
        const text = await answer(input, opts);
        record.status = 'completed';
        record.summary = text;
        record.usage.totalTokens += 10;
        return { text, usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 }, toolCalls: [] };
      } catch (error) {
        const signal = opts?.abortSignal as AbortSignal | undefined;
        const code = (error as { code?: unknown }).code;
        record.status = signal?.aborted ? 'cut' : 'failed';
        record.error = { name: (error as Error).name, ...(typeof code === 'string' ? { code } : {}) };
        throw error;
      }
    },
    stream(): never {
      throw new Error('the engine runs generate()');
    },
    session(): never {
      throw new Error('one session');
    },
    async usage() {
      return { ...record.usage };
    },
    async close() {
      fake.closed = true;
      await close();
    },
    record: () => ({ ...record, usage: { ...record.usage }, ...(record.error ? { error: { ...record.error } } : {}) }),
  };
  return fake;
}

interface FakeHostOptions {
  surface?: 'gmi' | 'runtime';
  limits?: LaunchLimits;
  parentNames?: string[];
  tools?: Record<string, { name: string; stepTools?: string[] }>;
  members?: string[];
  seat?: (seat: ResolvedSeat, launch: LaunchEntry) => SeatHandle | LaunchRefusal | Promise<SeatHandle | LaunchRefusal>;
  route?: { provider?: string; model?: string };
  recorder?: LaunchHost['recorder'];
  /** The root scope's id; by default the calling GMI's and the session's. */
  scopeId?: string;
}
type FakeHost = LaunchHost & { sessionId: string; built: string[]; logged: Array<[unknown, string]> };

/** A host for one parent session: a 200 ms grace, a 1,000-token output estimate, and fake seats unless told otherwise. */
function fakeHost(o: FakeHostOptions = {}): FakeHost {
  const limits = o.limits ?? resolveLaunchLimits({});
  const host: FakeHost = {
    surface: o.surface ?? 'gmi',
    sessionId: `s-${randomUUID()}`,
    built: [],
    logged: [],
    settleGraceMs: 200,
    async rootParent(context: ToolExecutionContext): Promise<LaunchParent> {
      return {
        gmiId: context.gmiId,
        personaId: context.personaId,
        sessionId: host.sessionId,
        depth: 0,
        limits,
        toolHooks: [],
        namespace: '',
        outputEstimateTokens: 1_000,
        scopeId: o.scopeId ?? `${context.gmiId}:${host.sessionId}`,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.correlationId ? { turnId: context.correlationId } : {}),
      };
    },
    async parentToolNames() {
      return new Set(o.parentNames ?? []);
    },
    async toolOf(_context: ToolExecutionContext, name: string) {
      return o.tools?.[name];
    },
    hasMember: (ref: string) => (o.members ?? []).includes(ref),
    async buildSeat(seat: ResolvedSeat, launch: LaunchEntry) {
      host.built.push(seat.role);
      return o.seat ? o.seat(seat, launch) : fakeSeat(seat.role);
    },
    async agencyRoute() {
      return o.route ?? { provider: 'openai', model: 'stub-model' };
    },
    recorder: o.recorder ?? { start: () => undefined, close: () => undefined },
    logError: (error: unknown, where: string) => {
      host.logged.push([error, where]);
    },
  };
  return host;
}

const ctxFor = (extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  gmiId: 'gmi-test',
  personaId: 'parent',
  userContext: { userId: 'u1' },
  correlationId: `turn-${randomUUID()}`,
  ...extra,
});

async function refusalOf(host: LaunchHost, input: LaunchAgencyArgs, context: ToolExecutionContext = ctxFor()): Promise<LaunchRefusal> {
  const result = await runLaunch(host, input, context);
  expect(result.success).toBe(false);
  const details = result.details as LaunchRefusal;
  expect(result.error).toBe(`${details.code}: ${details.reason}`);
  return details;
}

/** A launch in flight at `depth`, as a frame names it; `scopeKey` defaults to a scope of its own. */
function inFlight(depth: number, limits: LaunchLimits, seatTools: Record<string, string[]> = {}, state: LaunchEntry['state'] = 'running', scopeKey = `root-${randomUUID()}`): LaunchEntry {
  const e: LaunchEntry = {
    launchId: `agency-${randomUUID()}`,
    depth,
    limits,
    scopeKey,
    budget: new SpendBudget({ maxCostUSD: Number.POSITIVE_INFINITY, maxTotalTokens: 100_000, unpriced: 'allow' }),
    signal: new AbortController().signal,
    namespace: '',
    toolHooks: [],
    seatTools: new Map(Object.entries(seatTools).map(([role, names]) => [role, new Set(names)])),
    outputEstimateTokens: 1_000,
    state,
  };
  launchRegistry.admit(e);
  return e;
}
const framed = (entry: LaunchEntry, role: string): ToolExecutionContext =>
  ctxFor({ sessionData: { sessionId: 'seat-session', agencyLaunch: { launchId: entry.launchId, role, depth: entry.depth } } });

describe('runLaunch: refusals', () => {
  it('refuses before any seat runs, each with its code', async () => {
    const limits = resolveLaunchLimits({ maxDepth: 2, maxSeats: 5 });
    const host = fakeHost({
      limits,
      parentNames: ['search', 'send_email', 'report', 'forge_tool', 'memory_add'],
      members: ['tutor'],
      tools: { report: { name: 'report', stepTools: ['search', 'send_email'] } },
    });
    expect((await refusalOf(host, args({ seats: [seat('9lives')] }))).code).toBe('invalid_arguments');
    expect((await refusalOf(host, args({ seats: ['a', 'b', 'c', 'd', 'e', 'f'].map((role) => seat(role)) }))).code).toBe('too_many_seats');
    expect((await refusalOf(host, args({ seats: [{ role: 'r', personaId: 'p' }] as never }))).code).toBe('seat_form_unsupported');
    expect((await refusalOf(fakeHost({ surface: 'runtime', members: ['tutor'] }), args({ seats: [{ role: 'r', agentKey: 'tutor' }] as never }))).code).toBe('seat_form_unsupported');
    expect((await refusalOf(host, args({ seats: [{ role: 'r', agentKey: 'ghost' }] as never }))).code).toBe('unknown_member');
    expect((await refusalOf(host, args({ seats: [{ role: 'a', agentKey: 'tutor' }, { role: 'b', agentKey: 'tutor' }] as never }))).code).toBe('duplicate_member');
    expect((await refusalOf(host, args({ seats: [seat('w', { tools: ['web_fetch'] })] }))).code).toBe('unknown_tool');
    for (const name of ['forge_tool', 'memory_add']) {
      expect((await refusalOf(host, args({ seats: [seat('w', { tools: [name] })] }))).code, name).toBe('tool_not_allowed');
    }
    const composed = await refusalOf(host, args({ seats: [seat('w', { tools: ['report', 'search'] })] }));
    expect(composed).toMatchObject({ code: 'tool_not_allowed', reason: expect.stringContaining("step 'send_email'") });
    // A root launch's seats sit at level 1; with maxDepth 1 none of them can launch.
    const shallow = fakeHost({ limits: resolveLaunchLimits({ maxDepth: 1 }), parentNames: ['launch_agency'] });
    expect((await refusalOf(shallow, args({ seats: [seat('w', { tools: ['launch_agency'] })] }))).code).toBe('tool_not_allowed');
    // 2,000 tokens cannot cover one call: 2,000 for the prompt and the host's 1,000 for the output.
    const poor = fakeHost({ limits: resolveLaunchLimits({ maxLaunchTokens: 2_000 }) });
    expect((await refusalOf(poor, args())).code).toBe('budget_unavailable');
    expect([...host.built, ...shallow.built, ...poor.built]).toEqual([]);
  });

  it("refuses past the depth, under a closing or missing parent, and past its scope's concurrency", async () => {
    const limits = resolveLaunchLimits({ maxDepth: 2 });
    // The host's own limits reach deeper: a nested launch takes its tree's limits from its entry, never the host's.
    const host = fakeHost({ limits: resolveLaunchLimits({ maxDepth: 4 }) });
    const level2 = inFlight(2, limits, { worker: [] });
    expect((await refusalOf(host, args(), framed(level2, 'worker'))).code).toBe('depth_exceeded');
    const closing = inFlight(1, limits, { worker: [] }, 'closing');
    expect((await refusalOf(host, args(), framed(closing, 'worker'))).code).toBe('parent_launch_closed');
    expect((await refusalOf(host, args(), framed({ ...level2, launchId: 'agency-gone' }, 'worker'))).code).toBe('parent_launch_closed');
    const busy = inFlight(1, limits, {}, 'running', `gmi:gmi-test:${host.sessionId}`);
    expect((await refusalOf(host, args())).code).toBe('concurrency_exceeded');
    for (const e of [level2, closing, busy]) launchRegistry.remove(e.launchId);
    expect(host.built).toEqual([]);
  });

  it("a root launch's scope is its session as the host names it, never the calling GMI", async () => {
    const limits = resolveLaunchLimits({});
    // Two agents whose sessions share an id and whose turns share a GMI id: two scopes.
    const agentA = fakeHost({ limits, scopeId: 'agent-a:p1' });
    const agentB = fakeHost({ limits, scopeId: 'agent-b:p1' });
    const busy = inFlight(1, limits, {}, 'running', 'gmi:agent-a:p1');
    expect((await refusalOf(agentA, args())).code).toBe('concurrency_exceeded');
    expect(((await runLaunch(agentB, args(), ctxFor())).output as LaunchAgencyResult).status).toBe('completed');
    // One session whose turns each run a GMI of their own (no history): one scope.
    expect((await refusalOf(agentA, args(), ctxFor({ gmiId: 'gmi-p1-turn-2' }))).code).toBe('concurrency_exceeded');
    launchRegistry.remove(busy.launchId);
  });
});

describe('runLaunch: the run and its result', () => {
  it('runs a sequential team once and returns one result; the entry goes with the team', async () => {
    const writer = fakeSeat('writer', async (input) => `Draft from: ${input}`);
    const editor = fakeSeat('editor', async () => 'Edited draft.');
    const seats: Record<string, FakeSeat> = { writer, editor };
    const host = fakeHost({ seat: (s) => seats[s.role] });
    const result = await runLaunch(host, args({ seats: [seat('writer'), seat('editor')] }), ctxFor());
    expect(result.success).toBe(true);
    const out = result.output as LaunchAgencyResult;
    expect(out).toMatchObject({ status: 'completed', text: 'Edited draft.', truncated: false, usage: { totalTokens: 20 } });
    expect(out.reason).toBeUndefined();
    expect(out.seats.map((r) => [r.role, r.status, r.calls])).toEqual([['writer', 'completed', 1], ['editor', 'completed', 1]]);
    expect(editor.inputs[0]).toContain('Draft from: Write the report.');
    expect(out.provenance).toMatchObject({ agencyId: out.agencyId, strategy: 'sequential', depth: 1, parentGmiId: 'gmi-test', parentSessionId: host.sessionId });
    expect([writer.closed, editor.closed]).toEqual([true, true]);
    expect(launchRegistry.get(out.agencyId)).toBeUndefined();
  });

  it('a seat that cannot be seated refuses the launch and releases the seats built before it', async () => {
    const first = fakeSeat('first');
    const host = fakeHost({ members: ['tutor'], seat: (s) => (s.role === 'first' ? first : { code: 'member_unavailable', reason: 'the tier refuses it' }) });
    const refusal = await refusalOf(host, args({ seats: [seat('first'), { role: 'tutor', agentKey: 'tutor' }] as never }));
    expect(refusal.code).toBe('member_unavailable');
    await vi.waitFor(() => expect(first.closed).toBe(true));
  });

  it('reports a failed seat by role, name and code, never its message, and logs the error', async () => {
    const failing = fakeSeat('writer', async () => {
      throw Object.assign(new Error('POST https://api.example.com/v1?key=sk-secret failed'), { name: 'ProviderError', code: 'E_UPSTREAM' });
    });
    const host = fakeHost({ seat: () => failing });
    const out = (await runLaunch(host, args(), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('failed');
    expect(out.reason).toBe("seat 'writer' failed: ProviderError (E_UPSTREAM)");
    expect(JSON.stringify(out)).not.toContain('sk-secret');
    expect(host.logged.some(([error]) => String((error as Error).message).includes('sk-secret'))).toBe(true);
  });

  it("the budget's refusal outranks a resolved run, whose text the result keeps", async () => {
    const host = fakeHost({
      seat: (s, launch) =>
        fakeSeat(s.role, async () => {
          if (s.role !== 'first') return 'The team carried on.';
          launch.budget.record(undefined, 1_000_000, 'test');
          try {
            launch.budget.assertCanSpend(0, 1, 'test');
          } catch {
            // The seat stops spending and answers with what it has.
          }
          return 'Partial.';
        }),
    });
    const out = (await runLaunch(host, args({ seats: [seat('first'), seat('second')] }), ctxFor())).output as LaunchAgencyResult;
    expect(out).toMatchObject({ status: 'budget_exhausted', text: 'The team carried on.' });
    expect(out.reason).toContain('budget');
    expect(out.provenance.budget.tokensUsed).toBeGreaterThanOrEqual(1_000_000);
  });

  it('truncates a long answer and says so', async () => {
    const host = fakeHost({ seat: (s) => fakeSeat(s.role, async () => 'x'.repeat(20_000)) });
    const out = (await runLaunch(host, args(), ctxFor())).output as LaunchAgencyResult;
    expect(out.text).toHaveLength(16_000);
    expect(out.truncated).toBe(true);
  });

  it("an agency() configuration error is invalid_arguments in agency()'s own words, and the seats are released", async () => {
    const made: FakeSeat[] = [];
    const started: string[] = [];
    const recorder: LaunchHost['recorder'] = {
      start: (record) => {
        started.push(record.agencyId);
      },
      close: () => undefined,
    };
    // The recorder hears of a launch whose team is built (the precondition).
    const ran = (await runLaunch(fakeHost({ recorder }), args(), ctxFor())).output as LaunchAgencyResult;
    expect(started).toEqual([ran.agencyId]);
    // parallel needs an agency-level route, which this host does not give.
    const host = fakeHost({ route: {}, recorder, seat: (s) => { const f = fakeSeat(s.role); made.push(f); return f; } });
    const refusal = await refusalOf(host, args({ strategy: 'parallel', seats: [seat('a'), seat('b')] }));
    expect(refusal).toMatchObject({ code: 'invalid_arguments', reason: expect.stringContaining('Parallel strategy requires') });
    // The record starts once the child is built, so a team agency() refuses leaves none.
    expect(started).toEqual([ran.agencyId]);
    await vi.waitFor(() => expect(made.every((f) => f.closed)).toBe(true));
  });

  it("the reason names the cap that refused: the launch's own token cap by its count once it is used up, any other refusal in its own words", async () => {
    /** A seat that records `tokens` (and `usd`), asks for `ask` more tokens, and answers with what it has. */
    const spender = (tokens: number, ask: number, usd?: number) => (s: ResolvedSeat, launch: LaunchEntry) =>
      fakeSeat(s.role, async () => {
        launch.budget.record(usd, tokens, 'test');
        try {
          launch.budget.assertCanSpend(usd === undefined ? undefined : 0.01, ask, 'test');
        } catch {
          // The seat stops spending and answers with what it has.
        }
        return 'Partial.';
      });
    const launched = async (seats: FakeHostOptions['seat'], extra: Parameters<typeof args>[0]): Promise<LaunchAgencyResult> =>
      (await runLaunch(fakeHost({ seat: seats }), args(extra), ctxFor())).output as LaunchAgencyResult;

    // A call too large for what the cap has left, before anything was spent: the refusal's words.
    const early = await launched(spender(0, 9_000), { maxTokens: 8_000 });
    expect(early.provenance.budget).toMatchObject({ maxTotalTokens: 8_000, tokensUsed: 0 });
    expect(early).toMatchObject({ status: 'budget_exhausted', reason: "the launch's budget refused a call: 9000 tokens would pass 8000" });
    // Calls that used the cap up: its count.
    const spent = await launched(spender(9_000, 1), { maxTokens: 8_000 });
    expect(spent).toMatchObject({ status: 'budget_exhausted', reason: "the launch's budget is spent: 9000 of 8000 tokens" });
    // The launch's dollar cap: in its own words.
    const dollars = await launched(spender(10, 1, 1), { budgetUsd: 0.5 });
    expect(dollars).toMatchObject({ status: 'budget_exhausted', reason: "the launch's budget refused a call: Session cost $1.0100 would exceed limit $0.50" });
  });

  it('a recorder that throws and a close that rejects are logged; the launch completes and its entry goes', async () => {
    const host = fakeHost({
      seat: (s) => fakeSeat(s.role, async () => 'Done.', async () => { throw new Error('close failed'); }),
      recorder: { start: () => { throw new Error('record failed'); }, close: () => undefined },
    });
    const out = (await runLaunch(host, args(), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('completed');
    expect(host.logged.map(([, where]) => where)).toEqual(expect.arrayContaining(['launch_agency record', 'launch_agency close']));
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  });

  it('a seat whose close rejects does not keep the seats after it open', async () => {
    const first = fakeSeat('first', async () => 'One.', async () => {
      throw new Error('close failed');
    });
    const second = fakeSeat('second');
    const seats: Record<string, FakeSeat> = { first, second };
    const host = fakeHost({ seat: (s) => seats[s.role] });
    const out = (await runLaunch(host, args({ seats: [seat('first'), seat('second')] }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('completed');
    // The first close rejected and was logged (the precondition); the second seat was closed all the same.
    expect(host.logged.map(([, where]) => where)).toContain('launch_agency close');
    expect(second.closed).toBe(true);
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  });

  it('a host logger that throws neither makes the launch throw nor keeps its seats open', async () => {
    const failing = fakeSeat('writer', async () => {
      throw Object.assign(new Error('upstream failed'), { name: 'ProviderError' });
    });
    const host = fakeHost({ seat: () => failing });
    host.logError = () => {
      throw new Error('the logger is down');
    };
    const out = (await runLaunch(host, args(), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('failed');
    expect(failing.closed).toBe(true);
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  });

  it('a run that rejects while a seat still runs stops that seat: the launch signal aborts once the run has settled', async () => {
    const signals: AbortSignal[] = [];
    const failing = fakeSeat('a', async () => {
      throw Object.assign(new Error('upstream failed'), { name: 'ProviderError' });
    });
    // Runs until its call's signal aborts, as a seat's turn does.
    const running = fakeSeat('b', (_input, opts) =>
      new Promise<string>((_resolve, reject) => {
        const signal = opts?.abortSignal as AbortSignal;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
    const seats: Record<string, FakeSeat> = { a: failing, b: running };
    const host = fakeHost({ seat: (s) => seats[s.role] });
    // A graph tier runs its seats together and rejects at the first that fails, while the others go on.
    const out = (await runLaunch(host, args({ strategy: 'graph', seats: [seat('a'), seat('b')] }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('failed');
    expect(out.reason).toBe("seat 'a' failed: ProviderError");
    // The second seat was running when the run failed (the precondition); the launch stopped its call.
    expect(running.inputs).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['a', 'failed'], ['b', 'cut']]);
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  });
});

/** A seat that answers only when its call's signal aborts, and then rejects with the signal's reason. */
const waitsForAbort = (role: string): FakeSeat =>
  fakeSeat(role, (_input, opts) =>
    new Promise<string>((_resolve, reject) => {
      const signal = opts?.abortSignal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  );

describe("runLaunch: the deadline and the parent's stop", () => {
  it('the deadline returns timed_out with what the seats produced, within the deadline and one grace', async () => {
    const seats: Record<string, FakeSeat> = { first: fakeSeat('first', async () => 'First part.'), second: waitsForAbort('second') };
    const host = fakeHost({ seat: (s) => seats[s.role] });
    const started = Date.now();
    const out = (await runLaunch(host, args({ seats: [seat('first'), seat('second')], deadlineMs: 1_000 }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('timed_out');
    expect(out.reason).toBe('the deadline of 1000 ms passed');
    expect(out.seats.map((r) => r.status)).toEqual(['completed', 'cut']);
    expect(out.seats[0].summary).toBe('First part.');
    expect(Date.now() - started).toBeLessThan(1_000 + 200 + 500);
  }, 10_000);

  it("the parent's stop returns cancelled", async () => {
    const parentTurn = new AbortController();
    const host = fakeHost({ seat: (s) => waitsForAbort(s.role) });
    const pending = runLaunch(host, args(), ctxFor({ signal: parentTurn.signal }));
    setTimeout(() => parentTurn.abort(), 50);
    const out = (await pending).output as LaunchAgencyResult;
    expect(out).toMatchObject({ status: 'cancelled', reason: 'the parent turn stopped' });
    expect(out.seats[0].status).toBe('cut');
  }, 10_000);

  it('a seat build that never settles returns at the deadline, and the seat is released when it settles', async () => {
    let finish!: (made: SeatHandle) => void;
    const late = fakeSeat('slow');
    const host = fakeHost({ seat: () => new Promise<SeatHandle>((resolve) => { finish = resolve; }) });
    const started = Date.now();
    const out = (await runLaunch(host, args({ deadlineMs: 1_000 }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('timed_out');
    expect(out.seats.map((r) => r.status)).toEqual(['not_run']);
    expect(Date.now() - started).toBeLessThan(1_000 + 500);
    finish(late);
    await vi.waitFor(() => expect(late.closed).toBe(true));
  }, 10_000);

  it('a team route that never settles returns at the deadline, and the seat built is released', async () => {
    const made: FakeSeat[] = [];
    const host = fakeHost({ seat: (s) => { const f = fakeSeat(s.role); made.push(f); return f; } });
    // The child agency's own route never comes.
    host.agencyRoute = () => new Promise<never>(() => undefined);
    const started = Date.now();
    const out = (await runLaunch(host, args({ deadlineMs: 1_000 }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('timed_out');
    // The seat was built (the precondition) and never called.
    expect(made).toHaveLength(1);
    expect(made[0].inputs).toEqual([]);
    expect(out.seats.map((r) => r.status)).toEqual(['not_run']);
    expect(Date.now() - started).toBeLessThan(1_000 + 500);
    expect(made[0].closed).toBe(true);
  }, 10_000);

  it("the parent's stop returns cancelled when the deadline passes while the team settles", async () => {
    const parentTurn = new AbortController();
    // Rejects 700 ms after its call's signal aborts: past the deadline, inside the grace.
    const slow = fakeSeat('writer', (_input, opts) =>
      new Promise<string>((_resolve, reject) => {
        const signal = opts?.abortSignal as AbortSignal;
        signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 700), { once: true });
      }),
    );
    const host = fakeHost({ seat: () => slow });
    host.settleGraceMs = 1_500;
    setTimeout(() => parentTurn.abort(), 500);
    const out = (await runLaunch(host, args({ deadlineMs: 1_000 }), ctxFor({ signal: parentTurn.signal }))).output as LaunchAgencyResult;
    // The deadline passed while the team settled (the precondition); the parent turn had stopped first.
    expect(out.durationMs).toBeGreaterThan(1_000);
    expect(out).toMatchObject({ status: 'cancelled', reason: 'the parent turn stopped' });
    expect(out.seats[0].status).toBe('cut');
  }, 10_000);

  it('a seat whose build settles after the deadline is released, and a close of it that rejects is logged', async () => {
    let finish!: (made: SeatHandle) => void;
    const late = fakeSeat('slow', undefined, async () => {
      throw new Error('close failed');
    });
    const host = fakeHost({ seat: () => new Promise<SeatHandle>((resolve) => { finish = resolve; }) });
    const out = (await runLaunch(host, args({ deadlineMs: 1_000 }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('timed_out');
    finish(late);
    // The late seat's close ran (the precondition), and its rejection is logged as every other close's is.
    await vi.waitFor(() => expect(late.closed).toBe(true));
    await vi.waitFor(() => expect(host.logged.map(([, where]) => where)).toContain('launch_agency close'));
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  }, 10_000);

  it('a launch whose parent turn has already stopped returns cancelled and builds no seat', async () => {
    const host = fakeHost();
    // A live turn's launch builds its seat (the precondition).
    expect(((await runLaunch(host, args(), ctxFor())).output as LaunchAgencyResult).status).toBe('completed');
    expect(host.built).toEqual(['writer']);
    const out = (await runLaunch(host, args(), ctxFor({ signal: AbortSignal.abort() }))).output as LaunchAgencyResult;
    expect(out).toMatchObject({ status: 'cancelled', reason: 'the parent turn stopped' });
    expect(out.seats.map((r) => r.status)).toEqual(['not_run']);
    expect(host.built).toEqual(['writer']);
    expect(launchRegistry.get(out.agencyId)).toBeUndefined();
  });
});

describe('runLaunch: the grace and the closing entry', () => {
  it('a run that settles late in the grace and a close that hangs return within one grace; the entry stays closing until the seats are released', async () => {
    let releaseClose!: () => void;
    const hangingClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    // Answers 100 ms after the abort, inside the 200 ms grace; its close hangs until released.
    const late = fakeSeat(
      'late',
      (_input, opts) =>
        new Promise<string>((resolve) => {
          (opts?.abortSignal as AbortSignal).addEventListener('abort', () => setTimeout(() => resolve('Late answer.'), 100), { once: true });
        }),
      () => hangingClose,
    );
    const host = fakeHost({ seat: () => late });
    const started = Date.now();
    const out = (await runLaunch(host, args({ deadlineMs: 1_000 }), ctxFor())).output as LaunchAgencyResult;
    // One grace for the settle and the close together.
    expect(Date.now() - started).toBeLessThan(1_000 + 200 + 300);
    expect(out).toMatchObject({ status: 'timed_out', text: 'Late answer.' });
    expect(launchRegistry.get(out.agencyId)?.state).toBe('closing');
    // A closing launch counts toward its scope: the next launch from the same session waits for the release.
    expect((await refusalOf(host, args())).code).toBe('concurrency_exceeded');
    releaseClose();
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  }, 10_000);

  it('a run that resolves first and a close that hangs return within one grace, completed though the parent stops during the close', async () => {
    let releaseClose!: () => void;
    const hangingClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const parentTurn = new AbortController();
    // The run resolves at once; the close hangs, and the parent turn stops while the launch waits for it.
    const writer = fakeSeat('writer', async () => 'Done.', () => {
      setTimeout(() => parentTurn.abort(), 50);
      return hangingClose;
    });
    const host = fakeHost({ seat: () => writer });
    const started = Date.now();
    const out = (await runLaunch(host, args(), ctxFor({ signal: parentTurn.signal }))).output as LaunchAgencyResult;
    // At most the grace for a close that still hangs; the parent's stop came during it (the precondition).
    expect(Date.now() - started).toBeLessThan(200 + 300);
    expect(writer.closed).toBe(true);
    expect(parentTurn.signal.aborted).toBe(true);
    // The status is what the run came to: a stop during the close does not change it.
    expect(out).toMatchObject({ status: 'completed', text: 'Done.' });
    expect(out.reason).toBeUndefined();
    expect(launchRegistry.get(out.agencyId)?.state).toBe('closing');
    releaseClose();
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
  }, 10_000);

  it("a team a seat launched keeps the launch it came from closing while that team's seat outlives the grace, so the session's next launch waits for it", async () => {
    let releaseWaiter!: () => void;
    const waited = new Promise<string>((resolve) => {
      releaseWaiter = () => resolve('Waited.');
    });
    // Its call runs on past every abort until released, as a seat whose tool hangs does.
    const waiter = fakeSeat('waiter', () => waited);
    let lead: FakeSeat | undefined;
    let nested: LaunchAgencyResult | undefined;
    const host: FakeHost = fakeHost({
      seat: (s, launch) => {
        if (s.role === 'waiter') return waiter;
        if (s.role !== 'lead') return fakeSeat(s.role);
        // The lead's call is a tool call that launches a team from its seat: a launch nested under the lead's team.
        lead = fakeSeat('lead', async () => {
          nested = (await runLaunch(host, args({ seats: [seat('waiter')] }), framed(launch, 'lead'))).output as LaunchAgencyResult;
          return 'Lead done.';
        });
        return lead;
      },
    });
    const out = (await runLaunch(host, args({ seats: [seat('lead')], deadlineMs: 1_000 }), ctxFor())).output as LaunchAgencyResult;
    expect(out.status).toBe('timed_out');
    // The lead's team stopped with its parent and came back while its waiter still holds its call (the precondition).
    await vi.waitFor(() => expect(nested?.status).toBe('cancelled'));
    expect(waiter.inputs).toHaveLength(1);
    expect(launchRegistry.get(nested!.agencyId)?.state).toBe('closing');
    // The lead itself is released: its call returned and its close ran, and every hold of either settles before the
    // next task runs.
    await vi.waitFor(() => expect(lead?.closed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The launch stays closing for the seat its lead's team holds, and counts toward the session's one launch in flight.
    expect(launchRegistry.get(out.agencyId)?.state).toBe('closing');
    expect((await refusalOf(host, args())).code).toBe('concurrency_exceeded');
    releaseWaiter();
    await vi.waitFor(() => expect(launchRegistry.get(nested!.agencyId)).toBeUndefined());
    await vi.waitFor(() => expect(launchRegistry.get(out.agencyId)).toBeUndefined());
    expect((await runLaunch(host, args(), ctxFor())).output).toMatchObject({ status: 'completed' });
  }, 10_000);
});
