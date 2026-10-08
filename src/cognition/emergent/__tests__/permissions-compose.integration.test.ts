import { describe, it, expect, vi } from 'vitest';
import type { ITool, ToolExecutionContext } from '../../../core/tools/ITool.js';
import type { PermissionCheckContext } from '../../../core/tools/permissions/IToolPermissionManager.js';
import type { IHumanInteractionManager, PendingAction } from '../../../orchestration/hitl/IHumanInteractionManager.js';
import { ExtensionRegistry, EXTENSION_KIND_TOOL } from '../../../extensions/index.js';
import { ComposableToolBuilder } from '../ComposableToolBuilder.js';
import { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { EmergentJudge } from '../EmergentJudge.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import { createStepGate } from '../StepGate.js';
import { DEFAULT_EMERGENT_CONFIG } from '../types.js';
import type { EmergentConfig, ForgeToolRequest } from '../types.js';
import { createSqliteAdapter, readStateRow } from './helpers/sqlite-adapter.js';
import {
  APPROVED_VERDICT,
  approvingHitl,
  callTool,
  echoTool,
  makeForgeHost,
  sendMessageTool,
  type ForgeHost,
} from './helpers/forge-host.js';
import { DOUBLED_OUT, NUMBER_IN, RAW_DOUBLE, TEXT_IN, TEXT_OUT, seedStateRow, seedToolRow } from './helpers/seed-rows.js';

/** A composition that sends a message, then echoes what the send returned. */
const NOTIFY_AND_ECHO = {
  name: 'notify_and_echo',
  description: 'Sends a message, then echoes what was sent.',
  inputSchema: TEXT_IN,
  outputSchema: TEXT_OUT,
  implementation: {
    mode: 'compose',
    steps: [
      { name: 'send', tool: 'send_message', inputMapping: { text: '$input.text' } },
      { name: 'echo', tool: 'echo', inputMapping: { text: '$prev.text' } },
    ],
  },
  testCases: [
    { input: { text: 'hi' }, expectedOutput: { text: 'sent: hi' }, stepOutputs: { send: { text: 'sent: hi' } } },
  ],
};

/** Allows a call only when the caller holds every capability the tool requires. */
async function capabilityCheck(ctx: PermissionCheckContext) {
  const missing = (ctx.tool.requiredCapabilities ?? []).filter(
    (capability) => !ctx.personaCapabilities.includes(capability),
  );
  return missing.length === 0
    ? { isAllowed: true }
    : { isAllowed: false, reason: `missing capability: ${missing.join(', ')}` };
}

/** A host tool with no side effects that needs the `reading` capability. */
function readTool(): ITool {
  return {
    id: 'read-it-v1',
    name: 'read_it',
    displayName: 'read_it',
    description: 'Returns the text it is given, for a reader.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    requiredCapabilities: ['reading'],
    hasSideEffects: false,
    execute: async (args: Record<string, unknown>) => ({ success: true, output: { text: String(args.text) } }),
  };
}

/** A one-step composition over `tool`, named `name`. */
function composeOver(name: string, tool: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: `Runs ${tool}.`,
    inputSchema: TEXT_IN,
    outputSchema: TEXT_OUT,
    implementation: { mode: 'compose', steps: [{ name: 's', tool, inputMapping: { text: '$input.text' } }] },
    testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
    ...extra,
  };
}

describe('compositions and workflows: one gate, one rule', () => {
  it('refuses to chain a tool with side effects that the host has not listed, before any test case runs', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const host = await makeForgeHost({ tools: [sendMessageTool(sent), echoTool()] });

    const forged = await callTool(host.orchestrator, 'forge_tool', NOTIFY_AND_ECHO, {
      personaCapabilities: ['messaging'],
    });

    expect(forged.isError).toBe(true);
    expect(String(forged.errorDetails?.message)).toContain('step_not_chainable');
    expect(sent).toEqual([]);
    expect(host.judge).not.toHaveBeenCalled();
  });

  it('chains nothing whose flag is unset, even when listed', async () => {
    const host = await makeForgeHost({
      tools: [sendMessageTool([], 'unset'), echoTool()],
      config: { compose: { sideEffectingTools: ['send_message'] } },
    });

    const forged = await callTool(host.orchestrator, 'forge_tool', NOTIFY_AND_ECHO);

    expect(forged.isError).toBe(true);
    expect(String(forged.errorDetails?.message)).toContain('side_effects_undeclared');
  });

  it('a listed step is not run while forging, and at call time meets the permission check as the caller and one approval', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const hitl = approvingHitl();
    const db = createSqliteAdapter();
    const host = await makeForgeHost({
      db,
      tools: [sendMessageTool(sent), echoTool()],
      hitlManager: hitl.manager,
      orchestratorConfig: { hitl: { enabled: true } },
      config: { compose: { sideEffectingTools: ['send_message'] } },
    });
    host.permissionManager.isExecutionAllowed.mockImplementation(capabilityCheck);

    // Forging: the side-effecting step takes its output from the test case.
    const forged = await callTool(host.orchestrator, 'forge_tool', NOTIFY_AND_ECHO, {
      personaCapabilities: ['messaging'],
    });
    expect(forged.isError).toBeFalsy();
    expect(sent).toEqual([]);
    const prompt = String(host.judge.mock.calls[0][1]);
    expect(prompt).toContain('wouldRun');
    expect(prompt).toContain('sent: hi');

    // A test case that reaches that step without an output refuses the forge.
    const missingOutput = await callTool(
      host.orchestrator,
      'forge_tool',
      { ...NOTIFY_AND_ECHO, name: 'notify_again', testCases: [{ input: { text: 'hi' } }] },
      { personaCapabilities: ['messaging'] },
    );
    expect(missingOutput.isError).toBe(true);
    expect(String(missingOutput.errorDetails?.message)).toContain('dry_run_needs_output');

    // Calling: the step is checked as the caller, and asked once, at the step.
    hitl.requestApproval.mockClear();
    const called = await callTool(host.orchestrator, 'notify_and_echo', { text: 'hello' }, {
      personaCapabilities: ['messaging'],
    });
    expect(called.isError).toBeFalsy();
    expect(called.output).toEqual({ text: 'sent: hello' });
    expect(sent).toEqual([{ text: 'hello' }]);
    expect(host.permissionManager.isExecutionAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: expect.objectContaining({ name: 'send_message' }),
        personaCapabilities: ['messaging'],
      }),
    );
    expect(hitl.requestApproval).toHaveBeenCalledTimes(1);
    expect((hitl.requestApproval.mock.calls[0][0] as PendingAction).context).toMatchObject({
      toolName: 'send_message',
    });

    // A caller without the capability is refused at the step; nothing is sent.
    const refused = await callTool(host.orchestrator, 'notify_and_echo', { text: 'nope' }, {
      personaCapabilities: [],
    });
    expect(refused.isError).toBe(true);
    expect(String(refused.errorDetails?.message)).toContain('missing capability: messaging');
    expect(sent).toEqual([{ text: 'hello' }]);

    // The step tool is replaced by one that no longer declares its side effects.
    await host.orchestrator.registerTool(sendMessageTool(sent, 'unset'));
    const afterReplace = await callTool(host.orchestrator, 'notify_and_echo', { text: 'again' }, {
      personaCapabilities: ['messaging'],
    });
    expect(afterReplace.isError).toBe(true);
    expect(String(afterReplace.errorDetails?.message)).toContain('side_effects_undeclared');
    const toolId = String((forged.output as { toolId: string }).toolId);
    expect(readStateRow(db, toolId)).toMatchObject({ state: 'suspended', state_reason: 'step_replaced' });
    expect(await host.orchestrator.getTool('notify_and_echo')).toBeUndefined();

    // A tool that declares itself again brings the composition back.
    await host.orchestrator.registerTool(sendMessageTool(sent, true));
    await vi.waitFor(async () => {
      expect(await host.orchestrator.getTool('notify_and_echo')).toBeDefined();
    });
    expect(readStateRow(db, toolId)).toMatchObject({ state: 'active' });
  });

  it('a composition stored with a missing step comes back when an extension pack registers that tool', async () => {
    const registry = new ExtensionRegistry<ITool>(EXTENSION_KIND_TOOL);
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, registry });
    seedToolRow(db, {
      id: 'compose-late',
      name: 'echo_later',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 's1', tool: 'late_echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(summary.outcomes).toEqual([
      { toolId: 'compose-late', name: 'echo_later', state: 'suspended', reason: 'step_missing' },
    ]);

    // Straight into the registry the executor reads, as a pack does; not through registerTool.
    await registry.register({ id: 'late_echo', kind: EXTENSION_KIND_TOOL, payload: echoTool('late_echo') });

    await vi.waitFor(async () => {
      expect(await host.orchestrator.getTool('echo_later')).toBeDefined();
    });
    expect((await callTool(host.orchestrator, 'echo_later', { text: 'ok' })).output).toEqual({ text: 'ok' });
  });

  it('with allowSandboxTools off, stored code tools load suspended and compositions load; turning it on brings them back', async () => {
    const db = createSqliteAdapter();
    const off = await makeForgeHost({ db, config: { allowSandboxTools: false }, tools: [echoTool()] });
    seedToolRow(db, {
      id: 'raw-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    seedToolRow(db, {
      id: 'compose-1',
      name: 'echo_once',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 's1', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });

    const first = await off.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(first.outcomes).toEqual(
      expect.arrayContaining([
        { toolId: 'raw-1', name: 'double_it', state: 'suspended', reason: 'sandbox_tools_off' },
        { toolId: 'compose-1', name: 'echo_once', state: 'active', reason: null },
      ]),
    );
    expect(await off.orchestrator.getTool('double_it')).toBeUndefined();

    // Another process with the flag on: the library's own reason is re-checked.
    const on = await makeForgeHost({ db, tools: [echoTool()] });
    const second = await on.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(second.outcomes).toEqual(
      expect.arrayContaining([{ toolId: 'raw-1', name: 'double_it', state: 'active', reason: null }]),
    );
    expect((await callTool(on.orchestrator, 'double_it', { n: 3 })).output).toEqual({ doubled: 6 });
  });

  it('an engine built directly with a bare callback forges code and refuses to compose; with a gate it composes', async () => {
    const config: EmergentConfig = { ...DEFAULT_EMERGENT_CONFIG, enabled: true, allowSandboxTools: true };
    const judge = new EmergentJudge({
      judgeModel: 'judge',
      promotionModel: 'judge',
      generateText: async () => APPROVED_VERDICT,
    });
    const context = { agentId: 'agent-1', sessionId: 'sess-1' };
    const composeRequest: ForgeToolRequest = {
      name: 'echo_once',
      description: 'Echoes once.',
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
      implementation: {
        mode: 'compose',
        steps: [{ name: 's1', tool: 'echo', inputMapping: { text: '$input.text' } }],
      },
      testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
    };

    const bare = new EmergentCapabilityEngine({
      config,
      composableBuilder: new ComposableToolBuilder(async () => ({ success: true, output: {} })),
      sandboxForge: new SandboxedToolForge(),
      judge,
      registry: new EmergentToolRegistry(config),
    });
    const code = await bare.forge(
      {
        name: 'double_it',
        description: 'Doubles a number.',
        inputSchema: NUMBER_IN,
        outputSchema: DOUBLED_OUT,
        implementation: { mode: 'sandbox', code: RAW_DOUBLE, allowlist: [] },
        testCases: [{ input: { n: 2 }, expectedOutput: { doubled: 4 } }],
      },
      context,
    );
    expect(code.success).toBe(true);
    const refused = await bare.forge(composeRequest, context);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('compose_needs_gate');

    const tools = new Map<string, ITool>([['echo', echoTool()]]);
    const gated = new EmergentCapabilityEngine({
      config,
      composableBuilder: new ComposableToolBuilder(createStepGate({ resolve: (name) => tools.get(name) })),
      sandboxForge: new SandboxedToolForge(),
      judge,
      registry: new EmergentToolRegistry(config),
    });
    const composed = await gated.forge(composeRequest, context);
    expect(composed.success).toBe(true);
    const callContext: ToolExecutionContext = {
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      userContext: { userId: 'user-1' } as ToolExecutionContext['userContext'],
    };
    const run = await gated.createExecutableTool(composed.tool!).execute({ text: 'hello' }, callContext);
    expect(run.output).toEqual({ text: 'hello' });
  });

  it('a gate built with createStepGate asks no approval at a nested composed call, only at the steps that have side effects', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const tools = new Map<string, ITool>([
      ['send_email', { ...sendMessageTool(sent), id: 'send-email-v1', name: 'send_email', requiredCapabilities: [] }],
    ]);
    const hitl = approvingHitl();
    const config: EmergentConfig = {
      ...DEFAULT_EMERGENT_CONFIG,
      enabled: true,
      compose: { sideEffectingTools: ['send_email', 'notify'] },
    };
    const engine = new EmergentCapabilityEngine({
      config,
      composableBuilder: new ComposableToolBuilder(
        createStepGate({ resolve: (name) => tools.get(name), hitlManager: hitl.manager, hitl: { enabled: true } }),
      ),
      judge: new EmergentJudge({ judgeModel: 'judge', promotionModel: 'judge', generateText: async () => APPROVED_VERDICT }),
      registry: new EmergentToolRegistry(config),
      onToolForged: async (_tool, executable) => {
        tools.set(executable.name, executable);
      },
    });
    const context = { agentId: 'agent-1', sessionId: 'sess-1' };
    const nestedCase = {
      testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'sent: hi' }, stepOutputs: { s: { text: 'sent: hi' } } }],
    };
    const notify = await engine.forge(composeOver('notify', 'send_email', nestedCase) as unknown as ForgeToolRequest, context);
    expect(notify.success).toBe(true);
    const campaign = await engine.forge(composeOver('campaign', 'notify', nestedCase) as unknown as ForgeToolRequest, context);
    expect(campaign.success).toBe(true);

    hitl.requestApproval.mockClear();
    const callContext: ToolExecutionContext = {
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      userContext: { userId: 'user-1' } as ToolExecutionContext['userContext'],
    };
    const run = await tools.get('campaign')!.execute({ text: 'hello' }, callContext);

    expect(run.success).toBe(true);
    expect(sent).toEqual([{ text: 'hello' }]);
    // Asked once, at the step that sends; not at notify, the composed step.
    expect(hitl.requestApproval).toHaveBeenCalledTimes(1);
    expect((hitl.requestApproval.mock.calls[0][0] as PendingAction).context).toMatchObject({ toolName: 'send_email' });
  });

  it('a workflow step meets the rule at create, and the permission check and approval when it runs', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const hitl = approvingHitl();
    const workflow = {
      action: 'create',
      name: 'notify',
      description: 'Sends a note.',
      steps: [{ tool: 'send_message', args: { text: '$input' } }],
    };

    const strict = await makeForgeHost({
      selfImprovement: true,
      tools: [sendMessageTool(sent)],
      hitlManager: hitl.manager,
      orchestratorConfig: { hitl: { enabled: true } },
    });
    const refused = await callTool(strict.orchestrator, 'create_workflow', workflow, {
      personaCapabilities: ['messaging'],
      correlationId: 'wf-strict',
    });
    expect(refused.isError).toBe(true);
    expect(String(refused.errorDetails?.message)).toContain('step_not_chainable');

    const listed = await makeForgeHost({
      selfImprovement: true,
      tools: [sendMessageTool(sent)],
      hitlManager: hitl.manager,
      orchestratorConfig: { hitl: { enabled: true } },
      config: { compose: { sideEffectingTools: ['send_message'] } },
    });
    const created = await callTool(listed.orchestrator, 'create_workflow', workflow, {
      personaCapabilities: ['messaging'],
      correlationId: 'wf-listed',
    });
    expect(created.isError).toBeFalsy();

    hitl.requestApproval.mockClear();
    const run = await callTool(
      listed.orchestrator,
      'create_workflow',
      { action: 'run', workflowId: (created.output as { workflowId: string }).workflowId, input: 'hello' },
      { personaCapabilities: ['messaging'], correlationId: 'wf-listed' },
    );
    expect(run.isError).toBeFalsy();
    expect(sent).toEqual([{ text: 'hello' }]);
    expect(listed.permissionManager.isExecutionAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: expect.objectContaining({ name: 'send_message' }),
        personaCapabilities: ['messaging'],
      }),
    );
    // create_workflow has side effects of its own, so its run call is asked; the step is asked at the step.
    expect(
      hitl.requestApproval.mock.calls.map((call) => (call[0] as PendingAction).context.toolName),
    ).toEqual(['create_workflow', 'send_message']);
  });

  it('a step tool replaced after it was checked is not run, and the composition is checked again at once', async () => {
    const first: Array<Record<string, unknown>> = [];
    const second: Array<Record<string, unknown>> = [];
    const db = createSqliteAdapter();
    let host: ForgeHost | undefined;
    let swapDuringApproval = false;
    const requestApproval = vi.fn(async (action: PendingAction) => {
      if (swapDuringApproval && action.context.toolName === 'send_message' && host) {
        // Another registration under the name lands while the approval is pending.
        await host.orchestrator.registerTool(sendMessageTool(second, true));
      }
      return { actionId: action.actionId, approved: true, decidedBy: 'test', decidedAt: new Date() };
    });
    host = await makeForgeHost({
      db,
      tools: [sendMessageTool(first), echoTool()],
      hitlManager: { requestApproval } as unknown as IHumanInteractionManager,
      orchestratorConfig: { hitl: { enabled: true } },
      config: { compose: { sideEffectingTools: ['send_message'] } },
    });
    const forged = await callTool(host.orchestrator, 'forge_tool', NOTIFY_AND_ECHO, {
      personaCapabilities: ['messaging'],
    });
    expect(forged.isError).toBeFalsy();

    swapDuringApproval = true;
    const called = await callTool(host.orchestrator, 'notify_and_echo', { text: 'hello' }, {
      personaCapabilities: ['messaging'],
    });
    swapDuringApproval = false;

    expect(called.isError).toBe(true);
    expect(String(called.errorDetails?.message)).toContain('step_replaced');
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // The replacement fits the rule, so the composition is checked again and back.
    const toolId = String((forged.output as { toolId: string }).toolId);
    expect(readStateRow(db, toolId)).toMatchObject({ state: 'active' });
    const again = await callTool(host.orchestrator, 'notify_and_echo', { text: 'again' }, {
      personaCapabilities: ['messaging'],
    });
    expect(again.output).toEqual({ text: 'sent: again' });
    expect(first).toEqual([]);
    expect(second).toEqual([{ text: 'again' }]);
  });

  it('a stored chain of compositions loads in any row order', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool()], config: { compose: { sideEffectingTools: ['middle_c'] } } });
    const composition = (id: string, name: string, step: string, createdAt: number) => {
      seedToolRow(db, {
        id,
        name,
        mode: 'compose',
        source: JSON.stringify({ mode: 'compose', steps: [{ name: 's', tool: step, inputMapping: { text: '$input.text' } }] }),
        inputSchema: TEXT_IN,
        outputSchema: TEXT_OUT,
      });
      db.raw.prepare('UPDATE agentos_emergent_tools SET created_at = ? WHERE id = ?').run(createdAt, id);
    };
    // Outer first: each step's composition is stored after the one that chains it.
    composition('c-outer', 'outer_c', 'middle_c', 1_700_000_000_001);
    composition('c-middle', 'middle_c', 'inner_c', 1_700_000_000_002);
    composition('c-inner', 'inner_c', 'echo', 1_700_000_000_003);

    const summary = await host.engine.loadPersistedTools({ tiers: ['shared'] });

    expect(summary.outcomes).toEqual([
      { toolId: 'c-outer', name: 'outer_c', state: 'active', reason: null },
      { toolId: 'c-middle', name: 'middle_c', state: 'active', reason: null },
      { toolId: 'c-inner', name: 'inner_c', state: 'active', reason: null },
    ]);
    expect((await callTool(host.orchestrator, 'outer_c', { text: 'deep' })).output).toEqual({ text: 'deep' });
  });

  it("a nested composition's refusal suspends that composition only", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool('base')] });
    const inner = await callTool(host.orchestrator, 'forge_tool', composeOver('inner_echo', 'base'));
    expect(inner.isError).toBeFalsy();
    const outer = await callTool(
      host.orchestrator,
      'forge_tool',
      composeOver('outer_echo', 'inner_echo', {
        testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' }, stepOutputs: { s: { text: 'hi' } } }],
      }),
    );
    expect(outer.isError).toBeFalsy();

    // The inner composition's own step tool goes away.
    await host.orchestrator.unregisterTool('base');
    const called = await callTool(host.orchestrator, 'outer_echo', { text: 'x' });

    expect(called.isError).toBe(true);
    const innerId = String((inner.output as { toolId: string }).toolId);
    const outerId = String((outer.output as { toolId: string }).toolId);
    expect(readStateRow(db, innerId)).toMatchObject({ state: 'suspended', state_reason: 'step_missing' });
    expect(readStateRow(db, outerId)).toMatchObject({ state: 'active' });
  });

  it('a workflow step runs the instance its check resolved, never a replacement registered meanwhile', async () => {
    const replacementCalls: Array<Record<string, unknown>> = [];
    const host = await makeForgeHost({ selfImprovement: true, tools: [echoTool()] });
    let swapped = false;
    host.permissionManager.isExecutionAllowed.mockImplementation(async (ctx: PermissionCheckContext) => {
      if (!swapped && ctx.tool.name === 'echo') {
        swapped = true;
        // A tool with side effects takes the name while the step's check is awaited.
        await host.orchestrator.registerTool({ ...sendMessageTool(replacementCalls, true), name: 'echo', requiredCapabilities: [] });
      }
      return { isAllowed: true };
    });
    const workflowTool = await host.orchestrator.getTool('create_workflow');
    const caller: ToolExecutionContext = {
      gmiId: 'gmi-test',
      personaId: 'persona-test',
      personaCapabilities: [],
      userContext: { userId: 'user-test' } as ToolExecutionContext['userContext'],
      correlationId: 'wf-swap',
    };
    const created = await workflowTool!.execute(
      { action: 'create', name: 'echo_flow', description: 'Echoes.', steps: [{ tool: 'echo', args: { text: '$input' } }] },
      caller,
    );
    expect(created.success).toBe(true);

    const run = await workflowTool!.execute(
      { action: 'run', workflowId: (created.output as { workflowId: string }).workflowId, input: 'hi' },
      caller,
    );

    expect(run.success).toBe(false);
    expect(run.error).toContain('step_replaced');
    expect(replacementCalls).toEqual([]);
  });

  it('an approval that arrives after a workflow step expired starts nothing', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let releaseApproval!: () => void;
    const approvalHeld = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const requestApproval = vi.fn(async (action: PendingAction) => {
      if (action.context.toolName === 'send_message') {
        await approvalHeld;
      }
      return { actionId: action.actionId, approved: true, decidedBy: 'test', decidedAt: new Date() };
    });
    const host = await makeForgeHost({
      selfImprovement: true,
      tools: [sendMessageTool(sent)],
      hitlManager: { requestApproval } as unknown as IHumanInteractionManager,
      orchestratorConfig: { hitl: { enabled: true } },
      config: { compose: { sideEffectingTools: ['send_message'] } },
    });
    const workflowTool = await host.orchestrator.getTool('create_workflow');
    expect(workflowTool).toBeDefined();
    const caller: ToolExecutionContext = {
      gmiId: 'gmi-test',
      personaId: 'persona-test',
      personaCapabilities: ['messaging'],
      userContext: { userId: 'user-test' } as ToolExecutionContext['userContext'],
      correlationId: 'wf-late',
    };
    const created = await workflowTool!.execute(
      {
        action: 'create',
        name: 'notify',
        description: 'Sends a note.',
        steps: [{ tool: 'send_message', args: { text: '$input' } }],
      },
      caller,
    );
    expect(created.success).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const running = workflowTool!.execute(
        { action: 'run', workflowId: (created.output as { workflowId: string }).workflowId, input: 'hello' },
        caller,
      );
      // Past the step's limit while its approval is still pending.
      await vi.advanceTimersByTimeAsync(31_000);
      const run = await running;

      expect(run.success).toBe(false);
      expect(run.error).toContain('timed out');
      expect((run.output as { stepResults: unknown[] }).stepResults).toEqual([
        { status: 'expired', effect: 'unknown' },
      ]);
    } finally {
      vi.useRealTimers();
    }

    // The approval arrives late: the step's run was revoked, so nothing starts.
    releaseApproval();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("an approval that arrives after a workflow step expired starts nothing inside a composed step either", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let releaseApproval!: () => void;
    const approvalHeld = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const requestApproval = vi.fn(async (action: PendingAction) => {
      if (action.context.toolName === 'send_message') {
        await approvalHeld;
      }
      return { actionId: action.actionId, approved: true, decidedBy: 'test', decidedAt: new Date() };
    });
    const host = await makeForgeHost({
      selfImprovement: true,
      tools: [sendMessageTool(sent)],
      hitlManager: { requestApproval } as unknown as IHumanInteractionManager,
      orchestratorConfig: { hitl: { enabled: true } },
      config: { compose: { sideEffectingTools: ['send_message', 'notify_customer'] } },
    });
    // A composition whose one step sends: the workflow step is the composed call.
    const forged = await callTool(
      host.orchestrator,
      'forge_tool',
      composeOver('notify_customer', 'send_message', {
        testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'sent: hi' }, stepOutputs: { s: { text: 'sent: hi' } } }],
      }),
      { personaCapabilities: ['messaging'] },
    );
    expect(forged.isError).toBeFalsy();
    requestApproval.mockClear();
    const workflowTool = await host.orchestrator.getTool('create_workflow');
    const caller: ToolExecutionContext = {
      gmiId: 'gmi-test',
      personaId: 'persona-test',
      personaCapabilities: ['messaging'],
      userContext: { userId: 'user-test' } as ToolExecutionContext['userContext'],
      correlationId: 'wf-composed',
    };
    const created = await workflowTool!.execute(
      {
        action: 'create',
        name: 'notify',
        description: 'Notifies a customer.',
        steps: [{ tool: 'notify_customer', args: { text: '$input' } }],
      },
      caller,
    );
    expect(created.success).toBe(true);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const running = workflowTool!.execute(
        { action: 'run', workflowId: (created.output as { workflowId: string }).workflowId, input: 'hello' },
        caller,
      );
      // Past the step's limit while the composed step's own approval is pending.
      await vi.advanceTimersByTimeAsync(31_000);
      const run = await running;

      expect(run.success).toBe(false);
      expect(run.error).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }

    // The approval arrives late: the composed call expired, so its step starts nothing.
    releaseApproval();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect((requestApproval.mock.calls[0][0] as PendingAction).context).toMatchObject({ toolName: 'send_message' });
    expect(sent).toEqual([]);
  });

  it('a nested composition is not run while forging, and a composition that reaches itself is refused', async () => {
    const host = await makeForgeHost({
      tools: [echoTool()],
      config: { compose: { sideEffectingTools: ['loop_b'] } },
    });

    const echoTwice = {
      name: 'echo_twice',
      description: 'Echoes twice.',
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
      implementation: {
        mode: 'compose',
        steps: [
          { name: 'a', tool: 'echo', inputMapping: { text: '$input.text' } },
          { name: 'b', tool: 'echo', inputMapping: { text: '$prev.text' } },
        ],
      },
      testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
    };
    expect((await callTool(host.orchestrator, 'forge_tool', echoTwice)).isError).toBeFalsy();

    // A step that is itself a composition takes its output from the test case.
    const noOutput = await callTool(host.orchestrator, 'forge_tool', composeOver('wrap_echo', 'echo_twice'));
    expect(noOutput.isError).toBe(true);
    expect(String(noOutput.errorDetails?.message)).toContain('dry_run_needs_output');

    host.judge.mockClear();
    const withOutput = await callTool(
      host.orchestrator,
      'forge_tool',
      composeOver('wrap_echo', 'echo_twice', {
        testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' }, stepOutputs: { s: { text: 'hi' } } }],
      }),
    );
    expect(withOutput.isError).toBeFalsy();
    expect(String(host.judge.mock.calls[0][1])).toContain('"nested":true');
    // At run time the nested composition runs for real.
    expect((await callTool(host.orchestrator, 'wrap_echo', { text: 'yo' })).output).toEqual({ text: 'yo' });

    // loop_a over echo; loop_b over loop_a; a new loop_a over loop_b reaches itself.
    expect((await callTool(host.orchestrator, 'forge_tool', composeOver('loop_a', 'echo'))).isError).toBeFalsy();
    expect(
      (
        await callTool(
          host.orchestrator,
          'forge_tool',
          composeOver('loop_b', 'loop_a', {
            testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' }, stepOutputs: { s: { text: 'hi' } } }],
          }),
        )
      ).isError,
    ).toBeFalsy();
    host.judge.mockClear();
    const cycle = await callTool(
      host.orchestrator,
      'forge_tool',
      composeOver('loop_a', 'loop_b', {
        testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' }, stepOutputs: { s: { text: 'hi' } } }],
      }),
    );
    expect(cycle.isError).toBe(true);
    expect(String(cycle.errorDetails?.message)).toContain('step_cycle');
    expect(host.judge).not.toHaveBeenCalled();
  });

  it("a composition's test steps run as the forging caller", async () => {
    const host = await makeForgeHost({ tools: [readTool()] });
    host.permissionManager.isExecutionAllowed.mockImplementation(capabilityCheck);

    const reader = await callTool(host.orchestrator, 'forge_tool', composeOver('read_twice', 'read_it'), {
      personaCapabilities: ['reading'],
    });
    expect(reader.isError).toBeFalsy();
    expect(host.permissionManager.isExecutionAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: expect.objectContaining({ name: 'read_it' }),
        personaCapabilities: ['reading'],
      }),
    );

    // Without the capability the test step is refused, and the judge sees why.
    host.judge.mockClear();
    await callTool(host.orchestrator, 'forge_tool', composeOver('read_again', 'read_it'), {
      personaCapabilities: [],
    });
    expect(String(host.judge.mock.calls[0][1])).toContain('missing capability: reading');

    // An engine built directly, forging without the caller, asks for it.
    const config: EmergentConfig = { ...DEFAULT_EMERGENT_CONFIG, enabled: true };
    const tools = new Map<string, ITool>([['read_it', readTool()]]);
    const direct = new EmergentCapabilityEngine({
      config,
      composableBuilder: new ComposableToolBuilder(
        createStepGate({ resolve: (name) => tools.get(name), permissionManager: { isExecutionAllowed: capabilityCheck } }),
      ),
      sandboxForge: new SandboxedToolForge(),
      judge: new EmergentJudge({ judgeModel: 'judge', promotionModel: 'judge', generateText: async () => APPROVED_VERDICT }),
      registry: new EmergentToolRegistry(config),
    });
    const withoutCaller = await direct.forge(
      composeOver('read_direct', 'read_it') as unknown as ForgeToolRequest,
      { agentId: 'agent-1', sessionId: 'sess-1' },
    );
    expect(withoutCaller.success).toBe(false);
    expect(withoutCaller.error).toContain('caller_context_required');
  });

  it('a direct forge without a caller is asked for the caller when the executor, not the permission manager, refuses a capability', async () => {
    // The permission manager lets every call through (as one that does not
    // check capabilities does); the executor's own check refuses the step.
    const host = await makeForgeHost({ tools: [readTool()] });

    const withoutCaller = await host.engine.forge(composeOver('read_direct', 'read_it') as unknown as ForgeToolRequest, {
      agentId: 'agent-1',
      sessionId: 'sess-1',
    });

    expect(withoutCaller.success).toBe(false);
    expect(withoutCaller.error).toContain('caller_context_required');
    expect(host.judge).not.toHaveBeenCalled();
  });

  it("a composed step that is another agent's tool is refused as the caller", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, config: { compose: { sideEffectingTools: ['double_it'] } } });
    seedToolRow(db, {
      id: 'agent-a-1',
      name: 'double_it',
      mode: 'sandbox',
      source: RAW_DOUBLE,
      tier: 'agent',
      createdBy: 'agent-a',
      inputSchema: NUMBER_IN,
      outputSchema: DOUBLED_OUT,
    });
    const loaded = await host.engine.loadPersistedTools({ tiers: ['agent'], agentId: 'agent-a' });
    expect(loaded.outcomes).toEqual([{ toolId: 'agent-a-1', name: 'double_it', state: 'active', reason: null }]);

    const forged = await callTool(
      host.orchestrator,
      'forge_tool',
      {
        name: 'double_via',
        description: 'Doubles through the stored tool.',
        inputSchema: NUMBER_IN,
        outputSchema: DOUBLED_OUT,
        implementation: { mode: 'compose', steps: [{ name: 'd', tool: 'double_it', inputMapping: { n: '$input.n' } }] },
        testCases: [{ input: { n: 2 }, expectedOutput: { doubled: 4 }, stepOutputs: { d: { doubled: 4 } } }],
      },
      { personaId: 'agent-a' },
    );
    expect(forged.isError).toBeFalsy();

    const asOther = await callTool(host.orchestrator, 'double_via', { n: 2 }, { personaId: 'agent-b' });
    expect(asOther.isError).toBe(true);
    expect(String(asOther.errorDetails?.message)).toContain('belongs to agent agent-a');

    const asOwner = await callTool(host.orchestrator, 'double_via', { n: 2 }, { personaId: 'agent-a' });
    expect(asOwner.output).toEqual({ doubled: 4 });
  });

  it("a run's refused step never replaces a host's suspension, made in this process or in another, and the step's return does not lift it", async () => {
    const db = createSqliteAdapter();
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitTool: ITool = {
      id: 'wait-it-v1',
      name: 'wait_it',
      displayName: 'wait_it',
      description: 'Waits, then returns the text it is given.',
      inputSchema: TEXT_IN,
      hasSideEffects: false,
      execute: async (args: Record<string, unknown>) => {
        reached();
        await released;
        return { success: true, output: { text: String(args.text) } };
      },
    };
    const hostA = await makeForgeHost({ db, tools: [waitTool, echoTool()] });
    const hostB = await makeForgeHost({ db, tools: [echoTool()] });
    seedToolRow(db, {
      id: 'c-wait',
      name: 'wait_then_echo',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [
          { name: 'w', tool: 'wait_it', inputMapping: { text: '$input.text' } },
          { name: 'e', tool: 'echo', inputMapping: { text: '$prev.text' } },
        ],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });
    seedToolRow(db, {
      id: 'c-echo',
      name: 'echo_once',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 'e', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });
    db.raw.prepare('UPDATE agentos_emergent_tools SET created_at = ? WHERE id = ?').run(1_700_000_000_001, 'c-echo');
    expect((await hostA.engine.loadPersistedTools({ tiers: ['shared'] })).active).toBe(2);

    // In this process: a call is under way when the host suspends the
    // composition and takes its second step's tool away.
    const calling = callTool(hostA.orchestrator, 'wait_then_echo', { text: 'x' });
    await waiting;
    expect(await hostA.engine.suspendTool('c-wait', 'policy')).toBe(true);
    await hostA.orchestrator.unregisterTool('echo');
    release();
    expect((await calling).isError).toBe(true);
    expect(readStateRow(db, 'c-wait')).toMatchObject({ state: 'suspended', state_reason: 'policy', set_by: 'host' });

    // In another process: the host suspends a composition this process still
    // holds active, and a call here meets the missing step.
    expect(await hostB.engine.suspendTool('c-echo', 'policy')).toBe(true);
    expect((await callTool(hostA.orchestrator, 'echo_once', { text: 'y' })).isError).toBe(true);
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'suspended', state_reason: 'policy', set_by: 'host' });

    // The step's tool returns: the host's suspensions stay, here and in the rows.
    await hostA.orchestrator.registerTool(echoTool());
    await hostA.engine.onHostToolRegistered('echo');
    expect(await hostA.orchestrator.getTool('wait_then_echo')).toBeUndefined();
    expect(await hostA.orchestrator.getTool('echo_once')).toBeUndefined();
    expect(readStateRow(db, 'c-wait')).toMatchObject({ state: 'suspended', state_reason: 'policy', set_by: 'host' });
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'suspended', state_reason: 'policy', set_by: 'host' });
    const again = await hostA.engine.loadPersistedTools({ tiers: ['shared'] });
    expect(again.outcomes).toEqual([
      { toolId: 'c-wait', name: 'wait_then_echo', state: 'suspended', reason: 'policy' },
      { toolId: 'c-echo', name: 'echo_once', state: 'suspended', reason: 'policy' },
    ]);
  });

  it('a composition whose row already holds the step suspension is re-checked when its step tool registers, on a later start too', async () => {
    const db = createSqliteAdapter();
    // First start: the step's tool is not there yet, so the load suspends the
    // composition and stores the library's step suspension.
    const first = await makeForgeHost({ db });
    seedToolRow(db, {
      id: 'c-echo',
      name: 'echo_once',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 'e', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });
    expect((await first.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'c-echo', name: 'echo_once', state: 'suspended', reason: 'step_missing' },
    ]);
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'suspended', state_reason: 'step_missing', set_by: 'library' });

    // A later start reads that suspension from the row, then the step's tool
    // arrives: the composition is checked again and comes back.
    const later = await makeForgeHost({ db });
    expect((await later.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'c-echo', name: 'echo_once', state: 'suspended', reason: 'step_missing' },
    ]);
    await later.orchestrator.registerTool(echoTool());
    await later.engine.onHostToolRegistered('echo');
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'active' });
    expect((await callTool(later.orchestrator, 'echo_once', { text: 'back' })).output).toEqual({ text: 'back' });
  });

  it('a stored step suspension whose row holds no request is re-checked from its source, and one whose rows are gone is let go', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db });
    const source = JSON.stringify({
      mode: 'compose',
      steps: [{ name: 'e', tool: 'echo', inputMapping: { text: '$input.text' } }],
    });
    seedToolRow(db, { id: 'c-plain', name: 'echo_once', mode: 'compose', source, inputSchema: TEXT_IN, outputSchema: TEXT_OUT });
    seedStateRow(db, { toolId: 'c-plain', state: 'suspended', reason: 'step_missing', setBy: 'library', requestJson: null });
    seedToolRow(db, { id: 'c-gone', name: 'echo_again', mode: 'compose', source, inputSchema: TEXT_IN, outputSchema: TEXT_OUT });
    seedStateRow(db, { toolId: 'c-gone', state: 'suspended', reason: 'step_missing', setBy: 'library', requestJson: null });
    db.raw.prepare('UPDATE agentos_emergent_tools SET created_at = ? WHERE id = ?').run(1_700_000_000_001, 'c-gone');

    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'c-plain', name: 'echo_once', state: 'suspended', reason: 'step_missing' },
      { toolId: 'c-gone', name: 'echo_again', state: 'suspended', reason: 'step_missing' },
    ]);
    // Another process removes one of the two.
    db.raw.prepare('DELETE FROM agentos_emergent_tools WHERE id = ?').run('c-gone');
    db.raw.prepare('DELETE FROM agentos_emergent_tool_state WHERE tool_id = ?').run('c-gone');

    await host.orchestrator.registerTool(echoTool());
    await host.engine.onHostToolRegistered('echo');

    expect(readStateRow(db, 'c-plain')).toMatchObject({ state: 'active' });
    expect((await callTool(host.orchestrator, 'echo_once', { text: 'back' })).output).toEqual({ text: 'back' });
    const registry = (host.engine as unknown as { registry: EmergentToolRegistry }).registry;
    expect(registry.getState('c-gone')).toBeUndefined();
    expect(await host.orchestrator.getTool('echo_again')).toBeUndefined();
  });

  it("a run's suspension whose write failed gives way to the row at the next re-check, and the composition comes back with its step", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool()] });
    seedToolRow(db, {
      id: 'c-echo',
      name: 'echo_once',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 'e', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });
    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).active).toBe(1);

    // The step's tool goes away, and the run's suspension does not reach the
    // row: it is held here only, and the row still reads active.
    await host.orchestrator.unregisterTool('echo');
    db.failNext('INSERT INTO agentos_emergent_tool_state');
    expect((await callTool(host.orchestrator, 'echo_once', { text: 'x' })).isError).toBe(true);
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'active' });
    expect(await host.orchestrator.getTool('echo_once')).toBeUndefined();

    // The step's tool returns: the row reads active and the composition fits,
    // so the suspension held here, whose write is no longer under way, gives way.
    await host.orchestrator.registerTool(echoTool());
    await host.engine.onHostToolRegistered('echo');
    expect((await callTool(host.orchestrator, 'echo_once', { text: 'back' })).output).toEqual({ text: 'back' });
    // And the next load agrees.
    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'c-echo', name: 'echo_once', state: 'active', reason: null },
    ]);
  });

  it("a re-check a registration starts while a run's suspension is being written reads that suspension, and lifts it", async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool()] });
    seedToolRow(db, {
      id: 'c-echo',
      name: 'echo_once',
      mode: 'compose',
      source: JSON.stringify({
        mode: 'compose',
        steps: [{ name: 'e', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
    });
    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).active).toBe(1);

    // The host replaces the step's tool: unregistered, then registered again.
    // A call in the gap meets the missing step, and its suspension's write is
    // held while the new tool's registration starts a re-check.
    await host.orchestrator.unregisterTool('echo');
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const calling = callTool(host.orchestrator, 'echo_once', { text: 'x' });
    await gate.entered;
    await host.orchestrator.registerTool(echoTool());
    // The re-check runs as far as it can while the suspension's write is held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.release();
    expect((await calling).isError).toBe(true);

    // The composition comes back with its step present.
    await vi.waitFor(async () => {
      expect(await host.orchestrator.getTool('echo_once')).toBeDefined();
    });
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'active' });
    expect((await callTool(host.orchestrator, 'echo_once', { text: 'back' })).output).toEqual({ text: 'back' });

    // The same through a promotion check, which suspends a composition that
    // no longer fits: the registration's re-check waits for that suspension.
    await host.orchestrator.unregisterTool('echo');
    const gate2 = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const checking = host.engine.checkPromotion('c-echo');
    await gate2.entered;
    await host.orchestrator.registerTool(echoTool());
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate2.release();
    expect(await checking).toMatchObject({ success: false });
    await vi.waitFor(async () => {
      expect(await host.orchestrator.getTool('echo_once')).toBeDefined();
    });
    expect(readStateRow(db, 'c-echo')).toMatchObject({ state: 'active' });
  });

  it('a forge whose judge was out while another forge closed a cycle with it is refused before it is registered', async () => {
    const host = await makeForgeHost({ tools: [echoTool('loop_a'), echoTool('loop_b')] });
    let releaseJudge!: () => void;
    const judgeHeld = new Promise<void>((resolve) => {
      releaseJudge = resolve;
    });
    host.judge.mockImplementationOnce(async () => {
      await judgeHeld;
      return APPROVED_VERDICT;
    });

    // loop_a over the host's loop_b is with the judge when loop_b is forged
    // over the host's loop_a; each check saw only the host's tools.
    const forgingA = callTool(host.orchestrator, 'forge_tool', composeOver('loop_a', 'loop_b'));
    await vi.waitFor(() => expect(host.judge).toHaveBeenCalledTimes(1));
    const forgedB = await callTool(host.orchestrator, 'forge_tool', composeOver('loop_b', 'loop_a'));
    expect(forgedB.isError).toBeFalsy();
    releaseJudge();
    const forgedA = await forgingA;

    expect(forgedA.isError).toBe(true);
    expect(String(forgedA.errorDetails?.message)).toContain('step_cycle');
    // loop_b chains the host's loop_a, which was never replaced.
    expect((await callTool(host.orchestrator, 'loop_b', { text: 'hi' })).output).toEqual({ text: 'hi' });
  });

  it('a forge registered while another forge closed a cycle with it is taken out again', async () => {
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool('loop_a'), echoTool('loop_b')] });

    // loop_a has passed its checks and is registered in the registry; its
    // state write is held while loop_b is forged and registered in full.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const forgingA = callTool(host.orchestrator, 'forge_tool', composeOver('loop_a', 'loop_b'), {
      sessionId: 'sess-cycle',
    });
    await gate.entered;
    const forgedB = await callTool(host.orchestrator, 'forge_tool', composeOver('loop_b', 'loop_a'), {
      sessionId: 'sess-cycle',
    });
    expect(forgedB.isError).toBeFalsy();
    gate.release();
    const forgedA = await forgingA;

    expect(forgedA.isError).toBe(true);
    expect(String(forgedA.errorDetails?.message)).toContain('step_cycle');
    // Only loop_b is held, and no composition holds the name loop_a: the
    // cycle is not registered.
    expect(host.engine.getSessionTools('sess-cycle').map((tool) => tool.name)).toEqual(['loop_b']);
    const loopA = await host.orchestrator.getTool('loop_a');
    expect((loopA as { emergentMode?: string } | undefined)?.emergentMode).toBeUndefined();
  });

  it('a chain nested deeper than the limit is refused, and the composition at the limit, which has no cycle, stays active', async () => {
    const db = createSqliteAdapter();
    const names = Array.from({ length: 9 }, (_, i) => `c${i + 1}`);
    const host = await makeForgeHost({ db, tools: [echoTool()], config: { compose: { sideEffectingTools: names } } });
    // c1 chains c2, c2 chains c3, ..., c9 chains the host's echo; stored innermost first.
    names.forEach((name, i) => {
      const step = i + 1 < names.length ? names[i + 1] : 'echo';
      seedToolRow(db, {
        id: `id-${name}`,
        name,
        mode: 'compose',
        source: JSON.stringify({ mode: 'compose', steps: [{ name: 's', tool: step, inputMapping: { text: '$input.text' } }] }),
        inputSchema: TEXT_IN,
        outputSchema: TEXT_OUT,
      });
      db.raw
        .prepare('UPDATE agentos_emergent_tools SET created_at = ? WHERE id = ?')
        .run(1_700_000_000_000 + (names.length - i), `id-${name}`);
    });
    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).active).toBe(9);

    const deep = await callTool(host.orchestrator, 'c1', { text: 'deep' });
    expect(deep.isError).toBe(true);
    expect(String(deep.errorDetails?.message)).toContain('nesting_too_deep');
    // c9, where the limit was met, reaches nothing of its own: it stays active and runs.
    expect(readStateRow(db, 'id-c9')).toMatchObject({ state: 'active' });
    expect((await callTool(host.orchestrator, 'c9', { text: 'near' })).output).toEqual({ text: 'near' });
    expect((await callTool(host.orchestrator, 'c2', { text: 'within' })).output).toEqual({ text: 'within' });
  });

  it('a composition that reaches itself at run time is refused at the repeat, before its steps run again, and suspended', async () => {
    const db = createSqliteAdapter();
    const counted: Array<Record<string, unknown>> = [];
    const countTool: ITool = {
      id: 'count-it-v1',
      name: 'count_it',
      displayName: 'count_it',
      description: 'Counts its calls and returns the text it is given.',
      inputSchema: TEXT_IN,
      hasSideEffects: false,
      execute: async (args: Record<string, unknown>) => {
        counted.push(args);
        return { success: true, output: { text: String(args.text) } };
      },
    };
    const host = await makeForgeHost({
      db,
      tools: [countTool, echoTool('alias_step')],
      config: { compose: { sideEffectingTools: ['alias_step'] } },
    });
    const outer = await callTool(host.orchestrator, 'forge_tool', {
      name: 'outer_loop',
      description: 'Counts, then runs the alias step.',
      inputSchema: TEXT_IN,
      outputSchema: TEXT_OUT,
      implementation: {
        mode: 'compose',
        steps: [
          { name: 'count', tool: 'count_it', inputMapping: { text: '$input.text' } },
          { name: 'alias', tool: 'alias_step', inputMapping: { text: '$prev.text' } },
        ],
      },
      testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
    });
    expect(outer.isError).toBeFalsy();
    const inner = await callTool(
      host.orchestrator,
      'forge_tool',
      composeOver('inner_loop', 'outer_loop', {
        testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' }, stepOutputs: { s: { text: 'hi' } } }],
      }),
    );
    expect(inner.isError).toBeFalsy();
    // The host registers inner_loop's executable under the alias step's name
    // too: outer_loop now reaches itself through a name no forge-time check
    // follows.
    const innerExecutable = await host.orchestrator.getTool('inner_loop');
    await host.orchestrator.registerTool({ ...innerExecutable!, id: 'alias-of-inner-loop', name: 'alias_step' });

    counted.length = 0;
    const called = await callTool(host.orchestrator, 'outer_loop', { text: 'x' });

    expect(called.isError).toBe(true);
    // Its first step ran once: the repeat was refused before running anything.
    expect(counted).toEqual([{ text: 'x' }]);
    const outerId = String((outer.output as { toolId: string }).toolId);
    const innerId = String((inner.output as { toolId: string }).toolId);
    expect(readStateRow(db, outerId)).toMatchObject({ state: 'suspended', state_reason: 'step_cycle', set_by: 'library' });
    expect(readStateRow(db, innerId)).toMatchObject({ state: 'active' });
  });

  it('an approval for a direct call runs only the registration it named, never a tool registered under the name while it waited', async () => {
    const first: Array<Record<string, unknown>> = [];
    const second: Array<Record<string, unknown>> = [];
    const report = (calls: Array<Record<string, unknown>>, id: string): ITool => ({
      id,
      name: 'report',
      displayName: 'report',
      description: 'Files a report.',
      inputSchema: TEXT_IN,
      hasSideEffects: true,
      execute: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { success: true, output: { text: String(args.text) } };
      },
    });
    let host: ForgeHost | undefined;
    let swapped = false;
    const requestApproval = vi.fn(async (action: PendingAction) => {
      if (!swapped && action.context.toolName === 'report' && host) {
        swapped = true;
        // Another registration takes the name while this approval is pending.
        await host.orchestrator.registerTool(report(second, 'report-v2'));
      }
      return { actionId: action.actionId, approved: true, decidedBy: 'test', decidedAt: new Date() };
    });
    host = await makeForgeHost({
      tools: [report(first, 'report-v1')],
      hitlManager: { requestApproval } as unknown as IHumanInteractionManager,
      orchestratorConfig: { hitl: { enabled: true } },
    });

    const called = await callTool(host.orchestrator, 'report', { text: 'q3' });

    expect(called.isError).toBe(true);
    expect(called.errorDetails?.code).toBe('TOOL_REPLACED');
    // The approval named the first registration; neither tool ran.
    expect((requestApproval.mock.calls[0][0] as PendingAction).actionId).toContain('report-v1');
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // The tool that holds the name now runs after an approval of its own.
    expect((await callTool(host.orchestrator, 'report', { text: 'q4' })).output).toEqual({ text: 'q4' });
    expect(second).toEqual([{ text: 'q4' }]);
    expect((requestApproval.mock.calls[1][0] as PendingAction).actionId).toContain('report-v2');
  });
});
