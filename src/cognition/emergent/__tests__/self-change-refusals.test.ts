/**
 * @file self-change-refusals.test.ts
 * The five self-modification tools on a host with a learning layer, called the way a model's tool call reaches them:
 * through a real ToolOrchestrator with forging and the self-improvement tools on (helpers/forge-host.ts), with the
 * call's `sessionData.learning` as a GMI with a learner session sets it. With a layer they refuse on a turn with no
 * learner (`no_learner`), in mode `off` (`off`) and in mode `frozen` (`frozen`); every one of them refuses under
 * AGENTOS_LEARNING_FREEZE=1, with a layer and without one; adapt_personality keeps a layer's bounds. Without a layer
 * and without the freeze each acts as before, except that adapt_personality refuses honesty and emotionality on every
 * host (`operator_only`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptPersonalityTool, type AdaptPersonalityDeps } from '../AdaptPersonalityTool';
import { SelfEvaluateTool, type SelfEvaluateDeps, type SelfEvaluateInput } from '../SelfEvaluateTool';
import type { ForgeToolMetaTool } from '../ForgeToolMetaTool';
import { wrapForgeTool } from '../wrapForgeTool';
import type { ToolExecutionContext } from '../../../core/tools/ITool';
import type { ToolCallResult, UserContext } from '../../substrate/IGMI';
import { approvingHitl, echoTool, makeForgeHost, type ForgeHost } from './helpers/forge-host';

type TurnLearning = { learner: 'bound' | 'none'; mode: 'on' | 'frozen' | 'off' };

let callCount = 0;
/** Calls a tool through the orchestrator with the session data a GMI puts on the call. */
function call(host: ForgeHost, name: string, args: Record<string, unknown>, learning?: TurnLearning): Promise<ToolCallResult> {
  callCount += 1;
  return host.orchestrator.processToolCall({
    toolCallRequest: { id: `call-${callCount}`, name, arguments: args },
    gmiId: 'gmi-test',
    personaId: 'persona-test',
    correlationId: 'session-test',
    personaCapabilities: [],
    userContext: { userId: 'user-test' } as UserContext,
    sessionData: { sessionId: 'session-test', ...(learning ? { learning } : {}) },
  });
}
/** The reason a refusal names (`errorDetails.details.reason`), or undefined for any other result. */
const reasonOf = (result: ToolCallResult): string | undefined =>
  (result.errorDetails as { details?: { reason?: string } } | undefined)?.details?.reason;
const TRAIT_CALL = { trait: 'openness', delta: 0.02, reasoning: 'The user asked for unconventional ideas.' };
const FORGE = {
  name: 'echo_twice',
  description: 'Echoes the text twice.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  implementation: { mode: 'compose', steps: [{ name: 'first', tool: 'echo', inputMapping: { text: '$input.text' } }] },
  testCases: [{ input: { text: 'a' } }],
};
const CREATE = { action: 'create', name: 'twice', description: 'Echo twice.', steps: [{ tool: 'echo', args: { text: 'a' } }] };
const SELF_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['forge_tool', FORGE],
  ['create_workflow', CREATE],
  ['manage_skills', { action: 'enable', skillId: 'web-search' }],
  ['manage_skills', { action: 'disable', skillId: 'web-search' }],
  ['self_evaluate', { action: 'adjust', param: 'temperature', value: 0.2, reasoning: 'Less variance.' }],
];
const bound: TurnLearning = { learner: 'bound', mode: 'on' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('adapt_personality through the tool orchestrator', () => {
  it('refuses on a turn with no learner, in mode off and in mode frozen, with a layer', async () => {
    const host = await makeForgeHost({ selfImprovement: true });
    const none = await call(host, 'adapt_personality', TRAIT_CALL, { learner: 'none', mode: 'on' });
    expect(none.isError).toBe(true);
    expect(reasonOf(none)).toBe('no_learner');
    expect(none.errorDetails?.message).toBe('adapt_personality refused (no_learner): this turn has no learner; nothing was changed.');
    expect(reasonOf(await call(host, 'adapt_personality', TRAIT_CALL, { learner: 'bound', mode: 'off' }))).toBe('off');
    expect(reasonOf(await call(host, 'adapt_personality', TRAIT_CALL, { learner: 'bound', mode: 'frozen' }))).toBe('frozen');
    expect(reasonOf(await call(host, 'adapt_personality', TRAIT_CALL, { learner: 'none', mode: 'off' }))).toBe('off');
  });

  it('refuses every call under AGENTOS_LEARNING_FREEZE=1, with a layer and without one', async () => {
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const host = await makeForgeHost({ selfImprovement: true });
    expect(reasonOf(await call(host, 'adapt_personality', TRAIT_CALL))).toBe('frozen');
    expect(reasonOf(await call(host, 'adapt_personality', TRAIT_CALL, { learner: 'bound', mode: 'on' }))).toBe('frozen');
  });

  it('reaches its own answer without a layer, as before', async () => {
    const host = await makeForgeHost({ selfImprovement: true });
    const result = await call(host, 'adapt_personality', TRAIT_CALL);
    // forge-host resolves no calling GMI, so the tool answers past every refusal with its own "no agent instance".
    expect(result.errorDetails?.message).toContain('could not resolve the calling agent instance');
    expect(reasonOf(result)).toBeUndefined();
  });
});

describe("adapt_personality's bounds where a learning layer exists", () => {
  const authored = () => ({ openness: 0.5, conscientiousness: 0.5, emotionality: 0.5, extraversion: 0.5, agreeableness: 0.5, honesty: 0.5 });
  const make = () => {
    const traits: Record<string, number> = authored();
    const deps: AdaptPersonalityDeps = {
      config: { maxDeltaPerSession: 0.3 },
      getPersonality: () => traits,
      setPersonality: (trait, value) => {
        traits[trait] = value;
      },
    };
    return { tool: new AdaptPersonalityTool(deps), traits };
  };
  const learnerTurn = (sessionId = 's-1'): ToolExecutionContext =>
    ({ gmiId: 'g', personaId: 'p', userContext: { userId: 'u' }, correlationId: sessionId, sessionData: { sessionId, learning: { learner: 'bound', mode: 'on' } } }) as ToolExecutionContext;
  const noLayer = (sessionId = 's-1'): ToolExecutionContext => ({ gmiId: 'g', correlationId: sessionId }) as ToolExecutionContext;

  it('refuses honesty and emotionality, and a step above 0.02 in either direction, and changes nothing', async () => {
    const { tool, traits } = make();
    for (const trait of ['honesty', 'emotionality']) {
      const result = await tool.execute({ trait, delta: 0.01, reasoning: 'Be plainer.' }, learnerTurn());
      expect(result).toMatchObject({ success: false, details: { status: 'rejected', reason: 'operator_only' } });
    }
    expect((await tool.execute({ trait: 'openness', delta: 0.05, reasoning: 'More ideas.' }, learnerTurn())).details?.reason).toBe('step_bound');
    expect((await tool.execute({ trait: 'openness', delta: -0.021, reasoning: 'Fewer ideas.' }, learnerTurn())).details?.reason).toBe('step_bound');
    expect(traits).toEqual(authored());
  });

  it('accepts three calls a session within the step and refuses the fourth; another session has its own three', async () => {
    const { tool, traits } = make();
    for (const delta of [0.02, -0.01, 0.02]) {
      expect((await tool.execute({ trait: 'openness', delta, reasoning: 'Adjust.' }, learnerTurn())).success).toBe(true);
    }
    expect(traits.openness).toBeCloseTo(0.53);
    expect((await tool.execute({ trait: 'extraversion', delta: 0.01, reasoning: 'Adjust.' }, learnerTurn())).details?.reason).toBe('call_limit');
    expect((await tool.execute({ trait: 'extraversion', delta: 0.01, reasoning: 'Adjust.' }, learnerTurn('s-2'))).success).toBe(true);
  });

  it("counts a session's accepted calls per organization and user, and counts no refused call", async () => {
    const { tool } = make();
    const turnOf = (organizationId: string, userId: string): ToolExecutionContext =>
      ({
        gmiId: 'g',
        personaId: 'p',
        userContext: { userId },
        correlationId: 's-1',
        sessionData: { sessionId: 's-1', organizationId, learning: { learner: 'bound', mode: 'on' } },
      }) as ToolExecutionContext;
    const adjust = (context: ToolExecutionContext, delta = 0.01) => tool.execute({ trait: 'openness', delta, reasoning: 'Adjust.' }, context);
    // A refused call changes nothing, and counts for none.
    expect((await adjust(turnOf('A', '42'), 0.05)).details?.reason).toBe('step_bound');
    expect((await tool.execute({ trait: 'honesty', delta: 0.01, reasoning: 'Plainer.' }, turnOf('A', '42'))).details?.reason).toBe('operator_only');
    for (let accepted = 0; accepted < 3; accepted += 1) {
      expect((await adjust(turnOf('A', '42'))).success).toBe(true);
    }
    expect((await adjust(turnOf('A', '42'))).details?.reason).toBe('call_limit');
    // Tenant B's user 42 and tenant A's user 7 made no call on this session id.
    expect((await adjust(turnOf('B', '42'))).success).toBe(true);
    expect((await adjust(turnOf('A', '7'))).success).toBe(true);
  });

  it('keeps its rules without a layer: a step of 0.5 succeeds, and honesty stays operator-only', async () => {
    const { tool, traits } = make();
    expect((await tool.execute({ trait: 'honesty', delta: 0.1, reasoning: 'State uncertainty plainly.' }, noLayer())).details?.reason).toBe('operator_only');
    expect((await tool.execute({ trait: 'openness', delta: 0.5, reasoning: 'Explore.' }, noLayer())).success).toBe(true);
    expect(traits.honesty).toBe(0.5);
  });
});

describe('the other four self-modification tools through the tool orchestrator', () => {
  it('refuse with no_learner on a turn with no learner, off in mode off and frozen in mode frozen, with a layer, and change nothing', async () => {
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    for (const [name, args] of SELF_CHANGES) {
      expect(reasonOf(await call(host, name, args, { learner: 'none', mode: 'on' })), name).toBe('no_learner');
      expect(reasonOf(await call(host, name, args, { learner: 'bound', mode: 'off' })), name).toBe('off');
      expect(reasonOf(await call(host, name, args, { learner: 'bound', mode: 'frozen' })), name).toBe('frozen');
    }
    expect(host.judge).not.toHaveBeenCalled();
    expect((await call(host, 'create_workflow', { action: 'list' }, bound)).output).toEqual({ workflows: [] });
    expect(((await call(host, 'self_evaluate', { action: 'report' }, bound)).output as { adjustments: unknown[] }).adjustments).toEqual([]);
  });

  it('refuse under AGENTOS_LEARNING_FREEZE=1 with a layer and without one, while their reads answer', async () => {
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    for (const [name, args] of SELF_CHANGES) {
      expect(reasonOf(await call(host, name, args)), name).toBe('frozen');
      expect(reasonOf(await call(host, name, args, bound)), name).toBe('frozen');
    }
    expect((await call(host, 'create_workflow', { action: 'list' })).isError).toBe(false);
    expect((await call(host, 'manage_skills', { action: 'list' })).isError).toBe(false);
  });

  it("act on a learner's turn in mode on, and without a layer", async () => {
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    // Each call succeeds: a failure for any other reason has no refusal reason either, so the reason alone proves nothing.
    expect((await call(host, 'create_workflow', CREATE, bound)).isError).toBe(false);
    expect((await call(host, 'self_evaluate', { action: 'adjust', param: 'temperature', value: 0.2 })).isError).toBe(false);
    expect((await call(host, 'self_evaluate', { action: 'adjust', param: 'temperature', value: 0.2 }, bound)).isError).toBe(false);
    expect((await call(host, 'manage_skills', { action: 'enable', skillId: 'web-search' }, bound)).isError).toBe(false);
    expect((await call(host, 'forge_tool', FORGE, bound)).isError).toBe(false);
    expect(host.judge).toHaveBeenCalledTimes(1);
  });
});

describe("self_evaluate's evaluate on a turn the layer refuses", () => {
  const JUDGED = JSON.stringify({
    relevance: 0.9, clarity: 0.8, accuracy: 0.7, helpfulness: 0.6,
    adjustments: [{ param: 'temperature', value: 0.2, reasoning: 'Less variance.' }],
  });
  const make = () => {
    const storeMemory = vi.fn(async () => undefined);
    const setSessionParam = vi.fn();
    const generateTextImpl = vi.fn(async () => ({ text: JUDGED })) as unknown as SelfEvaluateDeps['generateTextImpl'];
    const tool = new SelfEvaluateTool({
      config: { autoAdjust: true, adjustableParams: ['temperature'], maxEvaluationsPerSession: 10 },
      storeMemory,
      setSessionParam,
      generateTextImpl,
    });
    return { tool, storeMemory, setSessionParam };
  };
  const turnWith = (learning: TurnLearning): ToolExecutionContext =>
    ({ gmiId: 'g', personaId: 'p', userContext: { userId: 'u' }, correlationId: 's-1', sessionData: { sessionId: 's-1', learning } }) as ToolExecutionContext;
  // Typed: a plain literal widens `action` to string, which execute() does not take.
  const ASK: SelfEvaluateInput = { action: 'evaluate', query: 'What is QUIC?', response: 'A transport protocol.' };

  it('answers and keeps its in-session record, and stores no trace and applies no adjustment', async () => {
    const { tool, storeMemory, setSessionParam } = make();
    const context = turnWith({ learner: 'none', mode: 'on' });
    const result = await tool.execute(ASK, context);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ scores: { relevance: 0.9 }, evalCount: 1, selfChangeRefused: 'no_learner' });
    expect(storeMemory).not.toHaveBeenCalled();
    expect(setSessionParam).not.toHaveBeenCalled();
    expect((await tool.execute({ action: 'report' }, context)).output).toMatchObject({ totalEvaluations: 1, adjustments: [] });
  });

  it("stores its trace and applies the adjustment on a learner's turn in mode on, as before", async () => {
    const { tool, storeMemory, setSessionParam } = make();
    const result = await tool.execute(ASK, turnWith({ learner: 'bound', mode: 'on' }));
    expect(result.success).toBe(true);
    expect(result.output).not.toHaveProperty('selfChangeRefused');
    expect(storeMemory).toHaveBeenCalledTimes(1);
    expect(setSessionParam).toHaveBeenCalledWith('temperature', 0.2, expect.anything());
  });
});

describe('the self-modification tools behind the approval gate', () => {
  it('answer a call the learning layer refuses with its refusal, and ask for no approval', async () => {
    const { manager, requestApproval } = approvingHitl();
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()], hitlManager: manager, orchestratorConfig: { hitl: { enabled: true } } });
    for (const [name, args] of SELF_CHANGES) {
      expect(reasonOf(await call(host, name, args, { learner: 'bound', mode: 'off' })), name).toBe('off');
    }
    expect(reasonOf(await call(host, 'adapt_personality', TRAIT_CALL, { learner: 'none', mode: 'on' }))).toBe('no_learner');
    expect(reasonOf(await call(host, 'adapt_personality', { ...TRAIT_CALL, trait: 'honesty' }, bound))).toBe('operator_only');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(host.judge).not.toHaveBeenCalled();
    // A call the layer lets act is asked about, as before.
    expect((await call(host, 'create_workflow', { action: 'list' }, { learner: 'bound', mode: 'off' })).isError).toBe(false);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('keep the refusal through wrapForgeTool, which a host wraps forge_tool with', async () => {
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    const raw = (await host.orchestrator.getTool('forge_tool')) as unknown as ForgeToolMetaTool;
    const wrapped = wrapForgeTool({ raw, agentId: 'agent-1', sessionId: 'session-test', capture: () => undefined });
    const contextOf = (learning: TurnLearning): ToolExecutionContext =>
      ({ gmiId: 'g', personaId: 'p', userContext: { userId: 'u' }, sessionData: { sessionId: 'session-test', learning } }) as ToolExecutionContext;
    expect(wrapped.refusalBeforeApproval?.(FORGE, contextOf({ learner: 'bound', mode: 'off' }))?.details).toEqual({ status: 'rejected', reason: 'off' });
    expect(wrapped.refusalBeforeApproval?.(FORGE, contextOf(bound))).toBeUndefined();
  });

  it('name the learning refusal, not a missing approval manager, with the gate on and no manager', async () => {
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()], orchestratorConfig: { hitl: { enabled: true } } });
    expect(reasonOf(await call(host, 'forge_tool', FORGE, { learner: 'bound', mode: 'off' }))).toBe('off');
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect(reasonOf(await call(host, 'manage_skills', { action: 'enable', skillId: 'web-search' }))).toBe('frozen');
  });
});

describe("a forged tool's use on a turn the learning layer refuses", () => {
  it('runs and checks no promotion, as a use on a learner turn in mode on, or on a host with no layer, does', async () => {
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    expect((await call(host, 'forge_tool', FORGE, bound)).isError).toBe(false);
    const promotion = vi.spyOn(host.engine, 'checkPromotion');
    const refused: TurnLearning[] = [
      { learner: 'bound', mode: 'frozen' },
      { learner: 'bound', mode: 'off' },
      { learner: 'none', mode: 'on' },
    ];
    for (const learning of refused) {
      expect((await call(host, 'echo_twice', { text: 'a' }, learning)).output, JSON.stringify(learning)).toEqual({ text: 'a' });
    }
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    expect((await call(host, 'echo_twice', { text: 'a' })).output).toEqual({ text: 'a' });
    vi.unstubAllEnvs();
    expect(promotion).not.toHaveBeenCalled();

    await call(host, 'echo_twice', { text: 'a' }, bound);
    await call(host, 'echo_twice', { text: 'a' });
    expect(promotion).toHaveBeenCalledTimes(2);
  });
});
