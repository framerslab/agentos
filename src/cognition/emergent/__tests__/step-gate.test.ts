import { describe, it, expect, vi } from 'vitest';
import type { ITool, ToolExecutionContext } from '../../../core/tools/ITool.js';
import type { ApprovalDecision, PendingAction } from '../../../orchestration/hitl/IHumanInteractionManager.js';
import { ComposableToolBuilder } from '../ComposableToolBuilder.js';
import { checkChainable, createStepGate, MAX_COMPOSITION_DEPTH } from '../StepGate.js';
import type { ComposableToolSpec } from '../types.js';

function tool(name: string, hasSideEffects: boolean | undefined, run = vi.fn()): ITool {
  return {
    id: `${name}-v1`,
    name,
    displayName: name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    ...(hasSideEffects === undefined ? {} : { hasSideEffects }),
    execute: async (args: Record<string, unknown>) => {
      run(args);
      return { success: true, output: { from: name, ...args } };
    },
  };
}

const ctx: ToolExecutionContext = {
  gmiId: 'gmi-1',
  personaId: 'persona-1',
  userContext: { userId: 'user-1' } as ToolExecutionContext['userContext'],
  personaCapabilities: ['messaging'],
};

const spec: ComposableToolSpec = {
  mode: 'compose',
  steps: [
    { name: 'send', tool: 'send', inputMapping: { text: '$input.text' } },
    { name: 'read', tool: 'read', inputMapping: { text: '$prev.text' } },
  ],
};

describe('checkChainable', () => {
  it('chains a tool that declares no side effects, listed or not', () => {
    expect(checkChainable('read', tool('read', false), [])).toEqual({ ok: true, sideEffects: false });
    expect(checkChainable('read', tool('read', false), ['read'])).toEqual({ ok: true, sideEffects: false });
  });

  it('chains a tool with side effects only when the host lists it', () => {
    expect(checkChainable('send', tool('send', true), ['send'])).toEqual({ ok: true, sideEffects: true });
    expect(checkChainable('send', tool('send', true), [])).toMatchObject({ ok: false, code: 'step_not_chainable' });
  });

  it('chains a tool whose flag is unset for no one, even when listed', () => {
    expect(checkChainable('old', tool('old', undefined), ['old'])).toMatchObject({
      ok: false,
      code: 'side_effects_undeclared',
    });
  });

  it('reports a name that resolves to nothing', () => {
    expect(checkChainable('gone', undefined, ['gone'])).toMatchObject({ ok: false, code: 'step_missing' });
  });
});

describe('createStepGate', () => {
  it('runs the instance it was given, not whatever the name resolves to by then', async () => {
    const ranA = vi.fn();
    const ranB = vi.fn();
    const tools = new Map<string, ITool>([['send', tool('send', true, ranA)]]);
    const gate = createStepGate({ resolve: (n) => tools.get(n) });
    const checked = gate.resolve('send')!;
    tools.set('send', tool('send', true, ranB));

    const result = await gate.run(checked, { text: 'hi' }, ctx);

    expect(result.success).toBe(true);
    expect(ranA).toHaveBeenCalledWith({ text: 'hi' });
    expect(ranB).not.toHaveBeenCalled();
  });

  it('a permission refusal carries the permission_denied code and the manager details', async () => {
    const gate = createStepGate({
      resolve: () => undefined,
      permissionManager: {
        isExecutionAllowed: async () => ({ isAllowed: false, reason: 'not yours', details: { missing: ['x'] } }),
      },
    });
    const ran = vi.fn();
    const result = await gate.run(tool('send', true, ran), {}, ctx);
    expect(result).toMatchObject({ success: false, error: 'not yours', details: { code: 'permission_denied', missing: ['x'] } });
    expect(ran).not.toHaveBeenCalled();
  });

  it('a step whose signal is already aborted stops before its tool, after the checks', async () => {
    const ran = vi.fn();
    const checked = vi.fn(async () => ({ isAllowed: true }));
    const gate = createStepGate({ resolve: () => undefined, permissionManager: { isExecutionAllowed: checked } });
    const controller = new AbortController();
    controller.abort();

    const result = await gate.run(tool('send', true, ran), {}, ctx, controller.signal);

    expect(result).toMatchObject({ success: false, details: { code: 'step_aborted' } });
    expect(checked).toHaveBeenCalledOnce();
    expect(ran).not.toHaveBeenCalled();
  });

  it("a step tool's own refusal code arrives as innerCode, so it is not the composition's own refusal", async () => {
    const nested: ITool = {
      ...tool('nested', false),
      execute: async () => ({ success: false, error: 'inner step gone', details: { code: 'step_missing', step: 's' } }),
    };
    const gate = createStepGate({ resolve: () => nested });

    const result = await gate.run(nested, {}, ctx);

    expect(result).toMatchObject({ success: false, details: { innerCode: 'step_missing', step: 's' } });
    expect((result.details as Record<string, unknown>).code).toBeUndefined();
  });

  it('a side-effecting step asks approval for that registration, and a rejection stops it', async () => {
    const ran = vi.fn();
    const requestApproval = vi.fn(
      async (action: PendingAction): Promise<ApprovalDecision> => ({
        actionId: action.actionId,
        approved: false,
        rejectionReason: 'no sending today',
        decidedBy: 'reviewer',
        decidedAt: new Date(0),
      }),
    );
    const gate = createStepGate({
      resolve: () => undefined,
      hitlManager: { requestApproval },
      hitl: { enabled: true },
    });
    const send = tool('send', true, ran);

    const result = await gate.run(send, { text: 'hi' }, ctx);

    expect(result).toMatchObject({ success: false, error: 'no sending today', details: { code: 'approval_rejected' } });
    expect(requestApproval.mock.calls[0][0].actionId).toContain(send.id);
    expect(ran).not.toHaveBeenCalled();
  });
});

describe('ComposableToolBuilder with a gate', () => {
  it('refuses to run through a bare callback', async () => {
    const builder = new ComposableToolBuilder(async () => ({ success: true, output: {} }));
    expect(builder.hasGate()).toBe(false);
    expect(builder.check('send')).toMatchObject({ ok: false, code: 'compose_needs_gate' });
    const result = await builder.build('t', 't', {}, spec).execute({ text: 'hi' }, ctx);
    expect(result.success).toBe(false);
    expect(result.details).toMatchObject({ code: 'compose_needs_gate' });
  });

  it('re-checks every step at every run, so a replaced step tool is caught', async () => {
    const tools = new Map<string, ITool>([
      ['send', tool('send', true)],
      ['read', tool('read', false)],
    ]);
    const builder = new ComposableToolBuilder(createStepGate({ resolve: (n) => tools.get(n) }));
    builder.bind({ sideEffectingTools: ['send'] });
    const composed = builder.build('t', 't', {}, spec);

    const first = await composed.execute({ text: 'hi' }, ctx);
    expect(first).toMatchObject({ success: true, output: { from: 'read', text: 'hi' }, effects: [{ kind: 'step', step: 'send', ran: true }] });

    // The step tool is replaced by one that no longer declares its side effects.
    tools.set('send', tool('send', undefined));
    const after = await composed.execute({ text: 'hi' }, ctx);
    expect(after.success).toBe(false);
    expect(after.details).toMatchObject({ code: 'side_effects_undeclared', step: 'send' });
  });

  it('in a forge test, takes a side-effecting step from the test case and runs the rest', async () => {
    const sent = vi.fn();
    const tools = new Map<string, ITool>([
      ['send', tool('send', true, sent)],
      ['read', tool('read', false)],
    ]);
    const builder = new ComposableToolBuilder(createStepGate({ resolve: (n) => tools.get(n) }));
    builder.bind({ sideEffectingTools: ['send'] });

    const dry = await builder.runPipeline(spec, { text: 'hi' }, ctx, {
      dry: { stepOutputs: { send: { text: 'from the test case' } } },
    });

    expect(sent).not.toHaveBeenCalled();
    expect(dry).toMatchObject({ success: true, output: { from: 'read', text: 'from the test case' } });
    expect(dry.effects).toMatchObject([{ kind: 'step', step: 'send', tool: 'send', wouldRun: true, args: { text: 'hi' } }]);

    const missing = await builder.runPipeline(spec, { text: 'hi' }, ctx, { dry: { stepOutputs: {} } });
    expect(missing.success).toBe(false);
    expect(missing.details).toMatchObject({ code: 'dry_run_needs_output', step: 'send' });
  });

  it('in a forge test, a nested composition is taken from the test case too, whatever its flag says', async () => {
    const innerRan = vi.fn();
    const inner = { ...tool('inner', false, innerRan), emergentMode: 'compose' } as ITool;
    const tools = new Map<string, ITool>([
      ['inner', inner],
      ['read', tool('read', false)],
    ]);
    const builder = new ComposableToolBuilder(createStepGate({ resolve: (n) => tools.get(n) }));
    const nestedSpec: ComposableToolSpec = {
      mode: 'compose',
      steps: [
        { name: 'inner', tool: 'inner', inputMapping: {} },
        { name: 'read', tool: 'read', inputMapping: { text: '$prev.text' } },
      ],
    };

    expect(builder.hasSideEffectingStep(nestedSpec)).toBe(true);
    const dry = await builder.runPipeline(nestedSpec, {}, ctx, { dry: { stepOutputs: { inner: { text: 'given' } } } });
    expect(innerRan).not.toHaveBeenCalled();
    expect(dry).toMatchObject({
      success: true,
      output: { from: 'read', text: 'given' },
      effects: [{ kind: 'step', step: 'inner', tool: 'inner', wouldRun: true, nested: true }],
    });
  });

  it('passes the caller context on with the composition depth, and refuses past the limit', async () => {
    const seen: ToolExecutionContext[] = [];
    const read: ITool = {
      ...tool('read', false),
      execute: async (args: Record<string, unknown>, context: ToolExecutionContext) => {
        seen.push(context);
        return { success: true, output: args };
      },
    };
    const tools = new Map<string, ITool>([['read', read]]);
    const builder = new ComposableToolBuilder(createStepGate({ resolve: (n) => tools.get(n) }));
    const readOnly: ComposableToolSpec = {
      mode: 'compose',
      steps: [{ name: 'read', tool: 'read', inputMapping: { text: '$input.text' } }],
    };

    expect((await builder.runPipeline(readOnly, { text: 'hi' }, ctx)).success).toBe(true);
    expect(seen[0]).toMatchObject({ personaId: 'persona-1', personaCapabilities: ['messaging'], sessionData: { emergentDepth: 1 } });

    const deep = await builder.runPipeline(readOnly, { text: 'hi' }, {
      ...ctx,
      sessionData: { emergentDepth: MAX_COMPOSITION_DEPTH },
    });
    expect(deep).toMatchObject({ success: false, details: { code: 'step_cycle' } });
    const nearly = await builder.runPipeline(readOnly, { text: 'hi' }, {
      ...ctx,
      sessionData: { emergentDepth: MAX_COMPOSITION_DEPTH - 1 },
    });
    expect(nearly.success).toBe(true);
    expect(seen[1]).toMatchObject({ sessionData: { emergentDepth: MAX_COMPOSITION_DEPTH } });
  });
});
