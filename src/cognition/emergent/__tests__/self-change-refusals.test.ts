/**
 * @file self-change-refusals.test.ts
 * The five self-modification tools on a host with a learning layer, called the way a model's tool call reaches them:
 * through a real ToolOrchestrator with forging and the self-improvement tools on (helpers/forge-host.ts), with the
 * call's `sessionData.learning` as a GMI with a learner session sets it. With a layer they refuse on a turn with no
 * learner (`no_learner`), in mode `off` (`off`) and in mode `frozen` (`frozen`); every one of them refuses under
 * AGENTOS_LEARNING_FREEZE=1, with a layer and without one; adapt_personality keeps a layer's bounds. Without a layer
 * and without the freeze each acts as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptPersonalityTool, type AdaptPersonalityDeps } from '../AdaptPersonalityTool';
import type { ToolExecutionContext } from '../../../core/tools/ITool';
import type { ToolCallResult, UserContext } from '../../substrate/IGMI';
import { makeForgeHost, type ForgeHost } from './helpers/forge-host';

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

  it('keeps its rules without a layer: honesty and a step of 0.5 succeed, as on master', async () => {
    const { tool, traits } = make();
    expect((await tool.execute({ trait: 'honesty', delta: 0.1, reasoning: 'State uncertainty plainly.' }, noLayer())).success).toBe(true);
    expect((await tool.execute({ trait: 'openness', delta: 0.5, reasoning: 'Explore.' }, noLayer())).success).toBe(true);
    expect(traits.honesty).toBeCloseTo(0.6);
  });
});
