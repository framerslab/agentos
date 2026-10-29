/**
 * @file GMI.tool-call-stop.test.ts
 * A GMI's tool call carries its turn's stop, which the caller's abort signal and the GMI's own shutdown() both abort,
 * on a host that hands the GMI a plain tool orchestrator, as the full runtime does: a call already running finishes,
 * with the stop as its context's signal; a call whose checks or approval finish after the turn stopped is refused
 * (STEP_ABORTED) before it runs, and a call or a step the turn reaches after it stopped is refused before its approval
 * is asked; and a composed tool or a workflow stops between its steps. The real ToolOrchestrator, ToolExecutor and
 * emergent engine run (the emergent suite's forge host); only the model provider is scripted.
 */
import { describe, expect, it, vi } from 'vitest';
import { GMIOutputChunkType, type GMIOutputChunk, type ToolResultChunkPayload } from '../IGMI';
import type { ITool, ToolExecutionContext } from '../../../core/tools/ITool';
import { GMIErrorCode } from '../../../core/utils/errors';
import type { ChatMessage, IProvider, ModelCompletionOptions, ModelCompletionResponse } from '../../../core/llm/providers/IProvider';
import type { ApprovalDecision, IHumanInteractionManager, PendingAction } from '../../../orchestration/hitl/IHumanInteractionManager';
import { approvingHitl, callTool, makeForgeHost } from '../../emergent/__tests__/helpers/forge-host';
import { TEXT_IN, TEXT_OUT } from '../../emergent/__tests__/helpers/seed-rows';
import { createScriptedGmi, runTurn, textTurn, toolCallReply } from './helpers/scriptedGmi';

/** A scripted provider that ends a call whose signal has already aborted with the abort chunk, as the providers do. */
function stoppingProvider(replies: ModelCompletionResponse[][]): IProvider {
  const queue = [...replies];
  return {
    providerId: 'scripted',
    isInitialized: true,
    generateCompletionStream: async function* (_modelId: string, _messages: ChatMessage[], options: ModelCompletionOptions) {
      if (options.abortSignal?.aborted) {
        yield { id: 'scripted', object: 'chat.completion.chunk', created: 0, modelId: 'scripted-model', choices: [], isFinal: true, error: { message: 'Stream aborted by caller', type: 'abort' } };
        return;
      }
      const reply = queue.shift();
      if (!reply) throw new Error('unexpected model call');
      yield* reply;
    },
  } as unknown as IProvider;
}

/** A host tool that takes a `text` and needs no capability; `execute` is the test's. */
function hostTool(name: string, hasSideEffects: boolean, execute: ITool['execute']): ITool {
  return {
    id: `${name}-v1`,
    name,
    displayName: name,
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    hasSideEffects,
    execute,
  };
}

/** The tool results a turn streamed, in the order it recorded them. */
const toolResults = (chunks: GMIOutputChunk[]): ToolResultChunkPayload[] =>
  chunks.filter((chunk) => chunk.type === GMIOutputChunkType.TOOL_RESULT).map((chunk) => chunk.content as ToolResultChunkPayload);

describe("a GMI's tool call carries its turn's stop", () => {
  it('a call running when the GMI shuts down finishes, its signal the stop, and the next call of the step never starts', async () => {
    const ran: string[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    const first = hostTool('first', false, async (_args: Record<string, unknown>, context: ToolExecutionContext) => {
      firstSignal = context.signal;
      started();
      await released;
      ran.push('first');
      return { success: true, output: { text: 'first' } };
    });
    const second = hostTool('second', false, async () => {
      ran.push('second');
      return { success: true, output: { text: 'second' } };
    });
    const host = await makeForgeHost({ tools: [first, second] });
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_1', name: 'first', args: {} }, { id: 'call_2', name: 'second', args: {} }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const turn = runTurn(gmi, textTurn('t1', 'Run both.'));
    await running;
    // shutdown() stops the turn while first runs: no caller signal is involved, so only the turn's own stop can reach the calls.
    const shuttingDown = gmi.shutdown();
    release();
    const { chunks } = await turn;
    await shuttingDown;

    // The running call finished (the precondition); the call after it never started.
    expect(ran).toEqual(['first']);
    // The running call's signal was the turn's stop, aborted while it ran, and the call ran to its end anyway.
    expect(firstSignal?.aborted).toBe(true);
    const results = toolResults(chunks);
    expect(results.map((result) => [result.name, result.isError])).toEqual([['first', false], ['second', true]]);
    // Refused at delegation, after its checks: nothing ran.
    expect(results[1].errorDetails).toMatchObject({ code: 'STEP_ABORTED' });
    // The history the next turn reads says the call was stopped: nothing expired.
    expect(String((results[1].errorDetails as { message?: unknown }).message)).toMatch(/^step_aborted: the call to 'second' was stopped before it ran/);
  });

  it('a call whose approval arrives after its turn stopped is refused before it runs', async () => {
    const sent: string[] = [];
    let approve!: () => void;
    const approved = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const requestApproval = vi.fn(async (action: PendingAction): Promise<ApprovalDecision> => {
      await approved;
      return { actionId: action.actionId, approved: true, decidedBy: 'reviewer', decidedAt: new Date() };
    });
    const sendEmail = hostTool('send_email', true, async (args: Record<string, unknown>) => {
      sent.push(String(args.text));
      return { success: true, output: { text: 'sent' } };
    });
    const host = await makeForgeHost({
      tools: [sendEmail],
      hitlManager: { requestApproval } as unknown as IHumanInteractionManager,
      orchestratorConfig: { hitl: { enabled: true } },
    });
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_e', name: 'send_email', args: { text: 'hi' } }])]),
      config: { toolOrchestrator: host.orchestrator },
    });
    const caller = new AbortController();

    const turn = runTurn(gmi, textTurn('t1', 'Send it.', { options: { abortSignal: caller.signal } }));
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(1));
    // The caller stops the turn while the approval is pending; the reviewer approves after that.
    caller.abort();
    approve();
    const { chunks } = await turn;

    // The approval was asked for this call (the precondition), and the call it approved was refused: its turn had stopped.
    expect(requestApproval.mock.calls[0][0].context).toMatchObject({ toolName: 'send_email' });
    expect(sent).toEqual([]);
    expect(toolResults(chunks)).toEqual([
      expect.objectContaining({ name: 'send_email', isError: true, errorDetails: expect.objectContaining({ code: 'STEP_ABORTED' }) }),
    ]);
  });

  it('a call the turn reaches after it stopped is refused before its approval is asked', async () => {
    const sent: string[] = [];
    const caller = new AbortController();
    // first stops the turn as it runs, as a session's close() or a launch's deadline would.
    const first = hostTool('first', false, async () => {
      caller.abort();
      return { success: true, output: { text: 'first' } };
    });
    const sendEmail = hostTool('send_email', true, async (args: Record<string, unknown>) => {
      sent.push(String(args.text));
      return { success: true, output: { text: 'sent' } };
    });
    const { manager, requestApproval } = approvingHitl();
    const host = await makeForgeHost({ tools: [first, sendEmail], hitlManager: manager, orchestratorConfig: { hitl: { enabled: true } } });
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_1', name: 'first', args: {} }, { id: 'call_e', name: 'send_email', args: { text: 'hi' } }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const { chunks } = await runTurn(gmi, textTurn('t1', 'Run both.', { options: { abortSignal: caller.signal } }));

    // The call before the stop ran (the precondition); the call after it was refused, and no one was asked about it.
    const results = toolResults(chunks);
    expect(results.map((result) => [result.name, result.isError])).toEqual([['first', false], ['send_email', true]]);
    expect(results[1].errorDetails).toMatchObject({ code: 'STEP_ABORTED' });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('a fail_closed turn that stopped ends as a stopped turn does, not with a tool failure, when its next call is refused', async () => {
    const ran: string[] = [];
    const caller = new AbortController();
    // first stops the turn as it runs, as a session's close() or a launch's deadline would.
    const first = hostTool('first', false, async () => {
      ran.push('first');
      caller.abort();
      return { success: true, output: { text: 'first' } };
    });
    const second = hostTool('second', false, async () => {
      ran.push('second');
      return { success: true, output: { text: 'second' } };
    });
    const host = await makeForgeHost({ tools: [first, second] });
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_1', name: 'first', args: {} }, { id: 'call_2', name: 'second', args: {} }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const { chunks, output } = await runTurn(
      gmi,
      textTurn('t1', 'Run both.', { options: { abortSignal: caller.signal }, executionPolicy: { toolFailureMode: 'fail_closed' } }),
    );

    // The call after the stop was refused and never ran (the precondition).
    expect(ran).toEqual(['first']);
    expect(toolResults(chunks).map((result) => [result.name, result.isError])).toEqual([['first', false], ['second', true]]);
    // The refusal is the stop's, not a tool's failure: the turn ends with the stop's abort, as a stopped turn that
    // runs no fail_closed policy does.
    expect(output.error?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(output.error?.message).toMatch(/aborted/);
  });

  it('a fail_closed turn whose running call fails when the turn stops ends as a stopped turn does, not with a tool failure', async () => {
    const caller = new AbortController();
    let sawStop = false;
    // The turn stops while the call runs, as a session's close() or a launch's deadline would; the tool ends its own
    // work at its signal, as a tool may, and reports a failure.
    const slow = hostTool('slow', false, async (_args: Record<string, unknown>, context: ToolExecutionContext) => {
      caller.abort();
      sawStop = context.signal?.aborted === true;
      return { success: false, error: 'cut short: the work was stopped' };
    });
    const host = await makeForgeHost({ tools: [slow] });
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_s', name: 'slow', args: {} }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const { chunks, output } = await runTurn(
      gmi,
      textTurn('t1', 'Run it.', { options: { abortSignal: caller.signal }, executionPolicy: { toolFailureMode: 'fail_closed' } }),
    );

    // The call was running when the turn stopped, and it failed (the precondition).
    expect(sawStop).toBe(true);
    expect(toolResults(chunks).map((result) => [result.name, result.isError])).toEqual([['slow', true]]);
    // A call that fails once the turn has stopped is the stop's, not a tool failure: the turn ends with the stop's
    // abort, as a stopped turn that runs no fail_closed policy does.
    expect(output.error?.code).toBe(GMIErrorCode.LLM_PROVIDER_ERROR);
    expect(output.error?.message).toMatch(/aborted/);
  });

  it('a composed tool running when its turn stops finishes the step in flight, and its later steps are refused', async () => {
    const ran: string[] = [];
    const caller = new AbortController();
    const step = (name: string, then?: () => void) =>
      hostTool(name, true, async (args: Record<string, unknown>) => {
        ran.push(name);
        then?.();
        return { success: true, output: { text: String(args.text) } };
      });
    const host = await makeForgeHost({
      // step_a stops the turn as it runs, as a session's close() or a deadline would.
      tools: [step('step_a', () => caller.abort()), step('step_b')],
      config: { compose: { sideEffectingTools: ['step_a', 'step_b'] } },
    });
    const forged = await callTool(host.orchestrator, 'forge_tool', {
      name: 'a_then_b',
      description: 'Runs step_a, then step_b.',
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
      implementation: {
        mode: 'compose',
        steps: [
          { name: 'a', tool: 'step_a', inputMapping: { text: '$input.text' } },
          { name: 'b', tool: 'step_b', inputMapping: { text: '$prev.text' } },
        ],
      },
      testCases: [{ input: { text: 'hi' }, stepOutputs: { a: { text: 'hi' }, b: { text: 'hi' } } }],
    });
    // The composition was forged (the precondition), and forging ran neither step: both have side effects.
    expect(forged.isError).toBeFalsy();
    expect(ran).toEqual([]);
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_c', name: 'a_then_b', args: { text: 'go' } }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const { chunks } = await runTurn(gmi, textTurn('t1', 'Run it.', { options: { abortSignal: caller.signal } }));

    // The step in flight finished; the step after it was refused at the step gate and never ran.
    expect(ran).toEqual(['step_a']);
    const results = toolResults(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'a_then_b',
      isError: true,
      errorDetails: { details: { code: 'step_aborted', step: 'b', completed: ['a'] } },
    });
  });

  it("a composed tool's step after its turn stopped is refused before its approval is asked", async () => {
    const ran: string[] = [];
    const caller = new AbortController();
    const step = (name: string, then?: () => void) =>
      hostTool(name, true, async (args: Record<string, unknown>) => {
        ran.push(name);
        then?.();
        return { success: true, output: { text: String(args.text) } };
      });
    const { manager, requestApproval } = approvingHitl();
    const host = await makeForgeHost({
      // step_a stops the turn as it runs, as a session's close() or a deadline would.
      tools: [step('step_a', () => caller.abort()), step('step_b')],
      config: { compose: { sideEffectingTools: ['step_a', 'step_b'] } },
      hitlManager: manager,
      orchestratorConfig: { hitl: { enabled: true } },
    });
    const forged = await callTool(host.orchestrator, 'forge_tool', {
      name: 'a_then_b',
      description: 'Runs step_a, then step_b.',
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
      implementation: {
        mode: 'compose',
        steps: [
          { name: 'a', tool: 'step_a', inputMapping: { text: '$input.text' } },
          { name: 'b', tool: 'step_b', inputMapping: { text: '$prev.text' } },
        ],
      },
      testCases: [{ input: { text: 'hi' }, stepOutputs: { a: { text: 'hi' }, b: { text: 'hi' } } }],
    });
    // The composition was forged (the precondition); only the run's own approvals count below.
    expect(forged.isError).toBeFalsy();
    requestApproval.mockClear();
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_c', name: 'a_then_b', args: { text: 'go' } }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const { chunks } = await runTurn(gmi, textTurn('t1', 'Run it.', { options: { abortSignal: caller.signal } }));

    // Each side-effecting step is asked when it runs: step_a was, before the stop (the precondition); step_b, which the
    // composition reached after the stop, was refused at the step gate without being asked, and never ran.
    expect(ran).toEqual(['step_a']);
    expect(requestApproval.mock.calls.map(([action]) => (action as PendingAction).context.toolName)).toEqual(['step_a']);
    expect(toolResults(chunks)).toEqual([
      expect.objectContaining({ name: 'a_then_b', isError: true, errorDetails: expect.objectContaining({ details: expect.objectContaining({ code: 'step_aborted', step: 'b' }) }) }),
    ]);
  });

  it('a workflow running when its turn stops finishes the step in flight, and its later steps are refused', async () => {
    const ran: string[] = [];
    const caller = new AbortController();
    const step = (name: string, then?: () => void) =>
      hostTool(name, true, async (args: Record<string, unknown>) => {
        ran.push(name);
        then?.();
        return { success: true, output: { text: String(args.text) } };
      });
    const host = await makeForgeHost({
      selfImprovement: true,
      // step_a stops the turn as it runs, as a session's close() or a deadline would.
      tools: [step('step_a', () => caller.abort()), step('step_b')],
      config: { compose: { sideEffectingTools: ['step_a', 'step_b'] } },
    });
    const workflows = await host.orchestrator.getTool('create_workflow');
    expect(workflows).toBeDefined();
    // Stored under the session the GMI's calls name (their sessionData.sessionId).
    const created = await workflows!.execute(
      {
        action: 'create',
        name: 'a_then_b',
        description: 'Runs step_a, then step_b.',
        steps: [{ tool: 'step_a', args: { text: '$input' } }, { tool: 'step_b', args: { text: '$input' } }],
      },
      {
        gmiId: 'gmi-test',
        personaId: 'persona-test',
        userContext: { userId: 'user-1' } as ToolExecutionContext['userContext'],
        sessionData: { sessionId: 'session-1' },
      },
    );
    // The workflow was stored (the precondition), and storing it ran neither step.
    expect(created.success).toBe(true);
    expect(ran).toEqual([]);
    const { workflowId } = created.output as { workflowId: string };
    const { gmi } = await createScriptedGmi({
      provider: stoppingProvider([toolCallReply([{ id: 'call_w', name: 'create_workflow', args: { action: 'run', workflowId, input: 'go' } }])]),
      config: { toolOrchestrator: host.orchestrator },
    });

    const { chunks } = await runTurn(gmi, textTurn('t1', 'Run it.', { options: { abortSignal: caller.signal } }));

    // The step in flight finished; the step after it was refused before its tool ran.
    expect(ran).toEqual(['step_a']);
    const results = toolResults(chunks);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'create_workflow', isError: true });
    expect(String((results[0].errorDetails as { message?: unknown } | undefined)?.message)).toContain('step_aborted');
  });
});
