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
import type { ToolExecutionContext } from '../../../core/tools/ITool';
import type { ToolCallResult, UserContext } from '../../substrate/IGMI';
import { echoTool, makeForgeHost, type ForgeHost } from './helpers/forge-host';

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

  it('keeps its rules without a layer: a step of 0.5 succeeds, and honesty stays operator-only', async () => {
    const { tool, traits } = make();
    expect((await tool.execute({ trait: 'honesty', delta: 0.1, reasoning: 'State uncertainty plainly.' }, noLayer())).details?.reason).toBe('operator_only');
    expect((await tool.execute({ trait: 'openness', delta: 0.5, reasoning: 'Explore.' }, noLayer())).success).toBe(true);
    expect(traits.honesty).toBe(0.5);
  });
});

describe('the other four self-modification tools through the tool orchestrator', () => {
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

  it("are not refused on a learner's turn in mode on, nor without a layer", async () => {
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    // A refusal and any other failure both leave `details` unset, so each call is read for its success.
    const created = await call(host, 'create_workflow', CREATE, bound);
    expect(created.isError, JSON.stringify(created.errorDetails)).toBe(false);
    const forged = await call(host, 'forge_tool', FORGE, bound);
    expect(forged.isError, JSON.stringify(forged.errorDetails)).toBe(false);
    expect(host.judge).toHaveBeenCalled();
    const enabled = await call(host, 'manage_skills', { action: 'enable', skillId: 'web-search' }, bound);
    expect(enabled.isError, JSON.stringify(enabled.errorDetails)).toBe(false);
    expect(enabled.output).toMatchObject({ status: 'enabled' });
    const adjusted = await call(host, 'self_evaluate', { action: 'adjust', param: 'temperature', value: 0.2 });
    expect(adjusted.isError, JSON.stringify(adjusted.errorDetails)).toBe(false);
    expect((await call(host, 'self_evaluate', { action: 'adjust', param: 'temperature', value: 0.2 }, bound)).isError).toBe(false);
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
