/**
 * launch_agency on gmi(), end to end: the route a launched team's coordinator runs on, and the budgets a persistent
 * member's seat runs under. The real gmi(), agency(), its strategies, agent(), the launch engine, the provider manager,
 * completion gateway, GMI and tool orchestrator run; only the provider classes are stubbed (helpers/stubProviders.ts),
 * at their module boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({ AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic') }));
import { gmi } from '../gmi';
import type { GenerateTextResult } from '../generateText';
import type { LaunchAgencyResult } from '../runtime/agencyLaunch/types';
import { clearProviderPriority, setProviderPriority } from '../runtime/provider-priority';
import { SpendBudget } from '../runtime/spendBudget';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { CostGuard } from '../../safety/runtime/CostGuard';

let n = 0;
const key = () => `k-launch-route-${++n}`;
type SeenCall = { messages: Array<{ role: string; content: unknown }> };
/** The text of a model call's last user message. */
const lastUserText = (call: SeenCall): string => {
  const users = call.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
};
/** A model step that calls launch_agency once with `args`. */
const launchStep = (args: Record<string, unknown>, id = 'l1') => reply.tools([{ id, name: 'launch_agency', args }]);
/** The output of a send's `i`-th tool call: a launch that started. */
const launchOf = (result: GenerateTextResult, i = 0): LaunchAgencyResult => {
  const call = result.toolCalls[i];
  expect(call?.name).toBe('launch_agency');
  expect(call?.error).toBeUndefined();
  return call.result as LaunchAgencyResult;
};
/** An agent's route under a key of its own; no fallback, so a failed hop ends the turn. */
const route = (k: string) => ({ provider: 'openai', model: 'stub-model', apiKey: k, fallbackProviders: [] });

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProviderPriority();
});

describe('launch_agency on gmi(): the coordinator route and the budgets of a seat', () => {
  it('an agent whose provider and model come from the environment launches a parallel team, which synthesizes on that route', async () => {
    const k = key();
    // Only OPENAI_API_KEY is probed, so a CLI on the runner's PATH cannot answer.
    setProviderPriority(['openai']);
    vi.stubEnv('OPENAI_API_KEY', k);
    const s = script('openai', k, {
      replies: [
        launchStep({
          goal: 'Name a colour.',
          strategy: 'parallel',
          seats: [{ role: 'warm', instructions: 'Name a warm colour.' }, { role: 'cool', instructions: 'Name a cool colour.' }],
        }),
        reply.text('Red.'),
        reply.text('Blue.'),
        reply.text('Red and blue.'),
        reply.text('Two colours.'),
      ],
      // The synthesizer runs on agent()'s legacy path, which asks for a whole response; a GMI streams every call.
      whole: true,
    });
    // No provider and no model: the agent's first call resolves them from the environment.
    const parent = gmi({ instructions: 'Coordinate.', fallbackProviders: [], agencies: { launch: true } });

    const result = await parent.session('p1').send('Name two colours.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'Red and blue.' });
    // The seats answer at once, so either may take either reply.
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['warm', 'completed'], ['cool', 'completed']]);
    expect(out.seats.map((r) => r.summary).sort()).toEqual(['Blue.', 'Red.']);
    // The parent's step, the two seats, the synthesizer (a whole response), the parent's last step: every call on the
    // model the parent's first call resolved.
    expect(s.seen.map((call) => call.streamed)).toEqual([true, true, true, false, true]);
    expect(new Set(s.seen.map((call) => call.modelId))).toEqual(new Set([s.seen[0].modelId]));
    expect(lastUserText(s.seen[3])).toContain('Synthesize these into a single coherent response.');
    expect(result.text).toBe('Two colours.');
  });

  it('a launched team runs on the route the agent resolved on its first call, after the environment comes to prefer another provider', async () => {
    const k = key();
    const ka = key();
    setProviderPriority(['openai']);
    vi.stubEnv('OPENAI_API_KEY', k);
    const s = script('openai', k, {
      replies: [
        reply.text('Ready.'),
        launchStep({
          goal: 'Name a colour.',
          strategy: 'parallel',
          seats: [{ role: 'warm', instructions: 'Name a warm colour.' }, { role: 'cool', instructions: 'Name a cool colour.' }],
        }),
        reply.text('Red.'),
        reply.text('Blue.'),
        reply.text('Red and blue.'),
        reply.text('Two colours.'),
      ],
      whole: true,
    });
    // Scripted with no replies: a call that reaches it left the agent's route.
    const other = script('anthropic', ka, { replies: [], whole: true });
    const parent = gmi({ instructions: 'Coordinate.', fallbackProviders: [], agencies: { launch: true } });
    const session = parent.session('p1');
    // The first call resolves the agent's provider and model from the environment.
    expect((await session.send('Are you there?')).text).toBe('Ready.');
    // Then the environment comes to prefer another provider.
    vi.stubEnv('ANTHROPIC_API_KEY', ka);
    setProviderPriority(['anthropic', 'openai']);

    const result = await session.send('Name two colours.');
    expect(other.seen.map((call) => call.modelId)).toEqual([]);
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'Red and blue.' });
    // The parent's three steps, the two seats and the synthesizer, every one on the model the first call resolved.
    expect(s.seen).toHaveLength(6);
    expect(new Set(s.seen.map((call) => call.modelId))).toEqual(new Set([s.seen[0].modelId]));
    expect(result.text).toBe('Two colours.');
  });

  it("a persistent member's own budget holds on its seat's turns: each call is checked against it and charged to it, once, beside the launch's budget", async () => {
    const k = key();
    const kr = key();
    const kt = key();
    script('openai', k, {
      replies: [
        launchStep({ goal: 'Review the plan.', seats: [{ role: 'reader', agentKey: 'roomy' }, { role: 'checker', agentKey: 'tight' }] }),
        reply.text('Reviewed.'),
      ],
    });
    const roomyCalls = script('openai', kr, { replies: [reply.text('The plan holds.')] });
    const tightCalls = script('openai', kt, { replies: [reply.text('Never sent.')] });
    // The host's budget, which the launching agent runs under, and the members' own: one draws on the host's, the
    // other caps its tokens below one call.
    const host = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    const roomyOwn = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow', parent: host });
    const tightOwn = new SpendBudget({ maxCostUSD: 1, maxTotalTokens: 1_000, unpriced: 'allow' });
    const roomy = gmi({ ...route(kr), instructions: 'Read the plan.', budget: roomyOwn });
    const tight = gmi({ ...route(kt), instructions: 'Check the plan.', budget: tightOwn });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', budget: host, agencies: { launch: true, members: { roomy, tight } } });

    const result = await parent.session('p1').send('Have the plan reviewed.');
    const out = launchOf(result);
    // The roomy member's own budget is charged for its seat's call (15 tokens).
    expect(roomyCalls.seen).toHaveLength(1);
    expect(roomyOwn.tokensUsed()).toBe(15);
    // The host's budget, which the launch and the roomy member's own budget both draw on, counts that call once:
    // the parent's two steps (14 and 15 tokens) and the seat's 15.
    expect(host.tokensUsed()).toBe(44);
    // The tight member's own cap refuses its seat's call before it is sent, though the launch's budget has room.
    expect(tightCalls.seen).toHaveLength(0);
    expect(tightOwn.tokensUsed()).toBe(0);
    // A budget the seat's call draws on ended it, as the launch's own would have: the seat is cut, and the launch
    // reports the budget and the cap that refused, while its own budget counted the one call.
    expect(out.seats.map((r) => [r.role, r.status])).toEqual([['reader', 'completed'], ['checker', 'cut']]);
    expect(out.seats[1].error?.code).toBe('LLM_PROVIDER_ERROR');
    expect(out.status).toBe('budget_exhausted');
    expect(out.reason).toMatch(/^a budget the team draws on refused a call: \d+ tokens would pass 1000$/);
    expect(out.provenance.budget.tokensUsed).toBe(15);
    expect(result.text).toBe('Reviewed.');
  });

  it("a team a persistent member launches from its seat is charged to the member's own budget beside the launch's", async () => {
    const k = key();
    const km = key();
    script('openai', k, {
      replies: [
        launchStep({ goal: 'Draft the plan.', seats: [{ role: 'lead', agentKey: 'planner', tools: ['launch_agency'] }] }),
        reply.text('Planned.'),
      ],
    });
    // The member's two steps and, between them, the call of the seat its own launch builds on the member's route.
    const memberCalls = script('openai', km, {
      replies: [
        launchStep({ goal: 'List the steps.', seats: [{ role: 'helper', instructions: 'List the steps.' }] }, 'l2'),
        reply.text('Three steps.'),
        reply.text('The plan has three steps.'),
      ],
    });
    const host = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow' });
    const plannerOwn = new SpendBudget({ maxCostUSD: 1, unpriced: 'allow', parent: host });
    const planner = gmi({ ...route(km), instructions: 'Plan.', budget: plannerOwn, agencies: { launch: true } });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', budget: host, agencies: { launch: true, members: { planner } } });

    const result = await parent.session('p1').send('Have a plan drafted.');
    const out = launchOf(result);
    expect(out).toMatchObject({ status: 'completed', text: 'The plan has three steps.' });
    expect(memberCalls.seen).toHaveLength(3);
    // The member's own budget: its two steps (14 and 15 tokens) and the call of the team it launched (15).
    expect(plannerOwn.tokensUsed()).toBe(44);
    // The launch's budget counted the member's calls and its nested team's.
    expect(out.provenance.budget.tokensUsed).toBe(44);
    // The host's budget, which the launch and the member's own both draw on, counts every call once: the parent's two
    // steps (14 and 15), the member's two (14 and 15) and the nested seat's (15).
    expect(host.tokensUsed()).toBe(73);
    expect(result.text).toBe('Planned.');
  });

  it("a seat's call is charged once to a spending total the host's budget and the member's own share by guard and id", async () => {
    const k = key();
    const km = key();
    script('openai', k, {
      replies: [launchStep({ goal: 'Price the plan.', seats: [{ role: 'pricer', agentKey: 'pricer' }] }), reply.text('Priced.')],
    });
    // The seat's call reports what it cost.
    const billed = { promptTokens: 12, completionTokens: 3, totalTokens: 15, costUSD: 0.3 };
    const pricerCalls = script('openai', km, { replies: [reply.text('Thirty cents.', 'stub-model', billed)] });
    // Two budgets on one guard and one id keep one spending total: the host's, which the launch draws on, and the
    // member's own.
    const guard = new CostGuard({ maxDailyCostUsd: 100, maxSingleOperationCostUsd: 100 });
    const host = new SpendBudget({ maxCostUSD: 5, guard, budgetId: 'account', unpriced: 'allow' });
    const pricerOwn = new SpendBudget({ maxCostUSD: 5, guard, budgetId: 'account', unpriced: 'allow' });
    const pricer = gmi({ ...route(km), instructions: 'Price the plan.', budget: pricerOwn });
    const parent = gmi({ ...route(k), instructions: 'Coordinate.', budget: host, agencies: { launch: true, members: { pricer } } });

    const result = await parent.session('p1').send('Have the plan priced.');
    const out = launchOf(result);
    expect(out.status).toBe('completed');
    expect(pricerCalls.seen).toHaveLength(1);
    // The one call cost 0.3, and the total the two budgets share holds it once.
    expect(guard.getSnapshot('account').sessionCostUsd).toBeCloseTo(0.3, 10);
    expect(host.spentUSD()).toBeCloseTo(0.3, 10);
    // Each budget still counts the call's tokens: the member's own its 15; the host's the parent's two steps (14 and
    // 15) and the seat's 15.
    expect(pricerOwn.tokensUsed()).toBe(15);
    expect(host.tokensUsed()).toBe(44);
    expect(result.text).toBe('Priced.');
  });
});
