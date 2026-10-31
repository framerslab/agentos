/**
 * @file GMI.learning.test.ts
 * What a GMI does with a learner session and with the persona's traits: the personality section it sends as a
 * system prompt after the base prompt, once per turn and the same on every model step; the learner and mode it
 * tells each tool call; the section it renders itself when it has no session or the session does not answer;
 * and the prompt it sends when it is given neither, which is the prompt it sent before the learning layer existed.
 */
import { describe, expect, it, vi } from 'vitest';
import { createConversationMessage, MessageRole } from '../../../core/conversation/ConversationMessage';
import type { ChatMessage } from '../../../core/llm/providers/IProvider';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import type { ToolExecutionRequestDetails } from '../../../core/tools/ToolExecutor';
import type { ILearnerSession, TurnInputForLearning, TurnPreparation } from '../../learning/types';
import { ReasoningEntryType, type ToolCallResult } from '../IGMI';
import { renderPersonalitySection } from '../personas/personalityPrompt';
import { createScriptedGmi, LOOKUP_TOOL, runTurn, scriptedProvider, textReply, textTurn, toolCallReply } from './helpers/scriptedGmi';

const BASE = 'You are the scripted test persona.';
const SECTION = renderPersonalitySection({ extraversion: 0.9 })!;
const lookupStep = () => toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]);
/** The system prompt of one model call: the content of its first message. */
const systemOf = (prompt: ChatMessage[]): string => (prompt[0]?.role === 'system' ? String(prompt[0].content) : '');
const prepared = (over: Partial<TurnPreparation> = {}): TurnPreparation => ({
  systemPrompts: [{ content: SECTION, priority: 2, source: 'learning:personality' }],
  learner: 'bound',
  mode: 'on',
  ...over,
});

/** A learner session that records what the GMI asks it. */
function stubSession(prepare: (input: TurnInputForLearning) => Promise<TurnPreparation> = async () => prepared()) {
  const inputs: TurnInputForLearning[] = [];
  const session: ILearnerSession = {
    prepareTurn: vi.fn((input: TurnInputForLearning) => {
      inputs.push(input);
      return prepare(input);
    }),
    endSession: vi.fn(async () => undefined),
    currentTraits: () => ({}),
  };
  return { session, inputs };
}

describe('a GMI with neither a learner session nor persona traits', () => {
  it('sends the base prompt alone and tells its tools nothing about learning', async () => {
    const { provider, received } = scriptedProvider([lookupStep(), textReply('Found it.')]);
    const { gmi, processToolCall } = await createScriptedGmi({ provider, persona: { personalityTraits: { extraversion: 0.9 } } });
    await runTurn(gmi, textTurn('t1', 'Look it up.'));
    expect(received.map(systemOf)).toEqual([BASE, BASE]);
    expect(processToolCall.mock.calls[0][0].sessionData).toEqual({ sessionId: 'session-1', conversationId: 'session-1' });
    expect(gmi.getLearnerSession()).toBeUndefined();
  });
});

describe("a GMI's own personality section", () => {
  it('follows the base prompt, takes the overlay on the traits it may set and keeps the registry honesty, with one warning', async () => {
    const { provider, received } = scriptedProvider([textReply('One.'), textReply('Two.')]);
    const { gmi } = await createScriptedGmi({
      provider,
      config: { personaTraits: { authored: { honesty: 0.9, extraversion: 0.5 }, overlay: { honesty: 0.2, extraversion: 0.9 } } },
    });
    await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(systemOf(received[0])).toBe(`${BASE}\n\n${renderPersonalitySection({ honesty: 0.9, extraversion: 0.9 })}`);
    const warnings = gmi
      .getReasoningTrace()
      .entries.filter((e) => e.type === ReasoningEntryType.WARNING && String(e.message).includes('role overlay'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0].message)).toContain('sets honesty');

    // A trait set on the running GMI never reaches the section: it was read once, at initialize().
    gmi.setPersonalityTrait('extraversion', 0.1);
    gmi.setPersonalityTrait('honesty', 0.1);
    await runTurn(gmi, textTurn('t2', 'Again.'));
    expect(systemOf(received[1])).toBe(systemOf(received[0]));
  });

  it('is absent when the traits are all moderate', async () => {
    const { provider, received } = scriptedProvider([textReply('One.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { personaTraits: { authored: { honesty: 0.5 } } } });
    await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(systemOf(received[0])).toBe(BASE);
  });
});

describe('a GMI with a learner session', () => {
  it('asks it once per turn, sends its section on every model step and tells each tool call the learner and mode', async () => {
    const { provider, received } = scriptedProvider([lookupStep(), textReply('Found it.')]);
    const { session, inputs } = stubSession();
    const { gmi, processToolCall } = await createScriptedGmi({ provider, config: { learning: session } });
    await runTurn(gmi, textTurn('t1', 'Look it up.'));
    expect(inputs).toEqual([
      { turnId: 't1', userId: 'user-1', namespace: '', text: 'Look it up.', modelIds: ['scripted-model'], workflowSeat: false },
    ]);
    expect(received.map(systemOf)).toEqual([`${BASE}\n\n${SECTION}`, `${BASE}\n\n${SECTION}`]);
    expect(processToolCall.mock.calls[0][0].sessionData).toEqual({
      sessionId: 'session-1',
      conversationId: 'session-1',
      learning: { learner: 'bound', mode: 'on' },
    });
    expect(gmi.getLearnerSession()).toBe(session);
  });

  it("passes the turn's organization and whether it is a workflow turn", async () => {
    const { provider } = scriptedProvider([textReply('Done.')]);
    const { session, inputs } = stubSession();
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session } });
    await runTurn(gmi, textTurn('t1', 'Do the task.', { organizationId: ' acme ', workflowId: 'wf-1' }));
    expect(inputs[0]).toMatchObject({ namespace: 'acme', workflowSeat: true });
  });

  it('tells its tools a turn has no learner, with the turn mode, and traces why', async () => {
    const { provider } = scriptedProvider([lookupStep(), textReply('Found it.')]);
    const { session } = stubSession(async () => prepared({ learner: 'none', noLearnerReason: 'placeholder_user', mode: 'frozen' }));
    const { gmi, processToolCall } = await createScriptedGmi({ provider, config: { learning: session } });
    await runTurn(gmi, textTurn('t1', 'Look it up.'));
    expect(processToolCall.mock.calls[0][0].sessionData?.learning).toEqual({ learner: 'none', mode: 'frozen' });
    expect(gmi.getReasoningTrace().entries.some((e) => String(e.message).includes('no learner (placeholder_user)'))).toBe(true);
  });

  it('reuses the preparation of the turn a tool continuation continues', async () => {
    const { provider, received } = scriptedProvider([textReply('One.'), textReply('Continued.')]);
    const { session, inputs } = stubSession();
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session } });
    await runTurn(gmi, textTurn('t1', 'Hi.'));
    const output = await gmi.handleToolResults([{ toolCallId: 'call_x', toolName: 'lookup', output: { ok: true } }], 'user-1');
    expect(output.responseText).toBe('Continued.');
    expect(inputs).toHaveLength(1);
    expect(systemOf(received[1])).toBe(`${BASE}\n\n${SECTION}`);
  });

  it('asks again for a tool continuation under another organization than its turn', async () => {
    // What a tool-result resume does when its host passes another organization.
    const { provider } = scriptedProvider([textReply('One.'), textReply('Continued.')]);
    const { session, inputs } = stubSession();
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session } });
    await runTurn(gmi, textTurn('t1', 'Hi.', { organizationId: 'A' }));
    gmi.hydrateTurnContext({ organizationId: 'B' });
    await gmi.handleToolResults([{ toolCallId: 'call_x', toolName: 'lookup', output: { ok: true } }], 'user-1');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ continuation: true, namespace: 'B', text: null });
  });

  it('says so when a GMI built again for a continuation asks for the preparation', async () => {
    const { provider } = scriptedProvider([textReply('Found it.')]);
    const { session, inputs } = stubSession();
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session } });
    gmi.hydrateConversationHistory([
      createConversationMessage(MessageRole.USER, 'Look up the release date.'),
      createConversationMessage(MessageRole.ASSISTANT, null, { tool_calls: [{ id: 'call_a', name: 'lookup', arguments: { q: 'release date' } }] }),
    ]);
    await gmi.handleToolResults([{ toolCallId: 'call_a', toolName: 'lookup', output: { date: 'May 4' } }], 'user-1');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ continuation: true, text: null });
  });
});

describe('a learner session that does not prepare the turn', () => {
  const personaTraits = { authored: { extraversion: 0.1 } };
  const OWN = renderPersonalitySection({ extraversion: 0.1 })!;

  it('never fails the turn when it rejects: the GMI sends its own section and the turn has no learner', async () => {
    const { provider, received } = scriptedProvider([lookupStep(), textReply('Found it.')]);
    const { session } = stubSession(async () => {
      throw new Error('store offline');
    });
    const { gmi, processToolCall } = await createScriptedGmi({ provider, config: { learning: session, personaTraits } });
    const { output } = await runTurn(gmi, textTurn('t1', 'Look it up.'));
    expect(output.responseText).toBe('Found it.');
    expect(received.map(systemOf)).toEqual([`${BASE}\n\n${OWN}`, `${BASE}\n\n${OWN}`]);
    expect(processToolCall.mock.calls[0][0].sessionData?.learning).toEqual({ learner: 'none', mode: 'on' });
    const warned = gmi
      .getReasoningTrace()
      .entries.some((e) => e.type === ReasoningEntryType.WARNING && String(e.message).includes('did not prepare this turn (store offline)'));
    expect(warned).toBe(true);
  });

  it('goes on after 2,000 ms when it does not answer', async () => {
    const { provider, received } = scriptedProvider([textReply('Late start.')]);
    const { session } = stubSession(() => new Promise<TurnPreparation>(() => undefined));
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session, personaTraits } });
    const startedAt = Date.now();
    const { output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(output.responseText).toBe('Late start.');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(systemOf(received[0])).toBe(`${BASE}\n\n${OWN}`);
    expect(gmi.getReasoningTrace().entries.some((e) => String(e.message).includes('no answer within 2000 ms'))).toBe(true);
  });

  it('counts an answer that holds no preparation as none', async () => {
    const { provider, received } = scriptedProvider([textReply('Still here.')]);
    const { session } = stubSession(async () => undefined as unknown as TurnPreparation);
    const { gmi } = await createScriptedGmi({ provider, config: { learning: session } });
    const { output } = await runTurn(gmi, textTurn('t1', 'Hi.'));
    expect(output.responseText).toBe('Still here.');
    expect(systemOf(received[0])).toBe(BASE);
  });
});

describe("a turn's tool calls while other turns run on its GMI", () => {
  /** A promise and the function that settles it. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  };

  it('carry the learner and mode of their own turn through a continuation and a newer turn', async () => {
    const callA = { started: deferred<void>(), release: deferred<void>() };
    const callB = { started: deferred<void>(), release: deferred<void>() };
    const newerPrepared = deferred<TurnPreparation>();
    const learningOf: Record<string, unknown> = {};
    const processToolCall = vi.fn(async ({ toolCallRequest, sessionData }: ToolExecutionRequestDetails): Promise<ToolCallResult> => {
      learningOf[toolCallRequest.id] = sessionData?.learning;
      for (const [id, call] of [['call_a', callA], ['call_b', callB]] as const) {
        if (toolCallRequest.id === id) {
          call.started.resolve();
          await call.release.promise;
        }
      }
      return { toolCallId: toolCallRequest.id, toolName: toolCallRequest.name, output: { ok: true } };
    });
    const { provider } = scriptedProvider([
      toolCallReply([{ id: 'call_a', name: 'lookup', args: { q: 'a' } }]),
      textReply('Continued.'),
      toolCallReply([{ id: 'call_b', name: 'lookup', args: { q: 'b' } }]),
      textReply('The newer turn answers.'),
      toolCallReply([{ id: 'call_c', name: 'lookup', args: { q: 'c' } }]),
      textReply('Found it.'),
    ]);
    const { session } = stubSession((input) => (input.turnId === 'newer' ? newerPrepared.promise : Promise.resolve(prepared())));
    const toolOrchestrator = { orchestratorId: 'scripted-tools', listAvailableTools: vi.fn(async () => [LOOKUP_TOOL]), processToolCall };
    const { gmi } = await createScriptedGmi({
      provider,
      config: { learning: session, toolOrchestrator: toolOrchestrator as unknown as IToolOrchestrator },
    });

    const first = runTurn(gmi, textTurn('first', 'Look it up.'));
    await callA.started.promise;
    // A tool-result continuation runs to its end while the first turn's call is pending, as a resume does.
    await gmi.handleToolResults([{ toolCallId: 'call_x', toolName: 'lookup', output: { ok: true } }], 'user-1');
    // A newer turn starts and waits for its preparation; the first turn makes its next call meanwhile.
    const newer = runTurn(gmi, textTurn('newer', 'Next question.'));
    callA.release.resolve();
    await callB.started.promise;
    // The newer turn is prepared with no learner, in mode frozen; the first turn makes its last call after that.
    newerPrepared.resolve(prepared({ learner: 'none', noLearnerReason: 'other_user', mode: 'frozen' }));
    await newer;
    callB.release.resolve();
    expect((await first).output.responseText).toBe('Found it.');

    const own = { learner: 'bound', mode: 'on' };
    expect(learningOf).toEqual({ call_a: own, call_b: own, call_c: own });
  });
});
