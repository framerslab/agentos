/**
 * @fileoverview The forge trace on the real path: a real engine over a real
 * tool executor, with a scripted judge, reached directly, through forge_tool,
 * through a host's wrapper and through an orchestrator's own forge_tool. One
 * forge per stage a forge can end at, each asserting that every carrier that
 * applies (the forge's result, the host's hook, the wrapper's capture) holds
 * the same trace, with that stage's outcome, reason, verdict, executor and
 * tool id.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import type { ToolExecutionRequestDetails } from '../../../core/tools/ToolExecutor.js';
import type {
  ApprovalDecision,
  IHumanInteractionManager,
  PendingAction,
} from '../../../orchestration/hitl/IHumanInteractionManager.js';
import type { ToolCallResult, UserContext } from '../../substrate/IGMI.js';
import type { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import type { ForgedCodeExecutor } from '../executor/types.js';
import {
  ForgeToolMetaTool,
  wrapForgeTool,
  type CapturedForge,
  type ForgeToolInput,
  type WrapForgeToolOptions,
} from '../index.js';
import type { ForgeResult, ForgeToolRequest } from '../types.js';
import {
  approvingHitl,
  callTool,
  echoTool,
  makeForgeHost,
  sendMessageTool,
  type ForgeHost,
  type ForgeHostOptions,
} from './helpers/forge-host.js';
import {
  REJECTED_JSON,
  composeArgs,
  directEngine,
  hookRecorder,
  sandboxArgs,
  traceOf,
  wrapperArgs,
  type TraceShape,
} from './helpers/forge-trace-harness.js';

type DirectEngineOptions = NonNullable<Parameters<typeof directEngine>[0]>;
type ForgeContext = Parameters<EmergentCapabilityEngine['forge']>[1];

const FORGE_ID = /^forge_[0-9a-f-]{36}$/;
const MINTED_TOOL_ID = /^emergent_/;
const IN_PROCESS = { name: 'in-process', isolates: false };
const ADD_CODE = 'function execute(input) { return { sum: input.a + input.b }; }';

/** The code forge of `sandboxArgs` with fields of its implementation replaced. */
function sandboxWith(implementation: Record<string, unknown>): Record<string, unknown> {
  return sandboxArgs({ implementation: { mode: 'sandbox', code: ADD_CODE, allowlist: [], ...implementation } });
}

/** The context of a host's direct call: an agent and the id it forges under. */
function directContext(): ForgeContext {
  return { agentId: 'agent-1', sessionId: 'turn-1' };
}

/** A host tool with side effects and no capability: a composition's test never executes it. */
function sendNoteTool(): ITool {
  return {
    id: 'send-note-v1',
    name: 'send_note',
    displayName: 'Send note',
    description: 'Sends a note.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    hasSideEffects: true,
    execute: async (args: Record<string, unknown>) => ({
      success: true,
      output: { text: `sent: ${String(args.text)}` },
    }),
  };
}

/** An executor that cannot load: `ready()` rejects with its reason. */
function brokenExecutor(): ForgedCodeExecutor {
  return {
    name: 'broken-wasm',
    isolates: true,
    ready: () => Promise.reject(new Error('engine did not load')),
    run: async () => ({ status: 'error' as const, error: 'unreachable', memoryUsedBytes: 0 }),
  } as ForgedCodeExecutor;
}

/** What every trace of a direct engine call carries, whatever its stage. */
function expectDirectEngineTrace(trace: TraceShape): void {
  expect(trace.traceVersion).toBe(1);
  expect(trace.forgeId).toMatch(FORGE_ID);
  expect(trace.recordedBy).toBe('engine');
  expect(trace.via).toBe('direct');
  expect(trace.agentId).toBe('agent-1');
  expect(trace.correlationId).toBe('turn-1');
  expect(trace.sessionId).toBeNull();
}

/** One forge that ends in the engine, and what its trace holds. */
interface EngineRow {
  title: string;
  stage: string;
  outcome: 'approved' | 'rejected' | 'refused' | 'failed';
  /** The engine's options beside the hook. */
  engine?: () => Omit<DirectEngineOptions, 'onForgeTrace'>;
  args: () => Record<string, unknown>;
  /** The forge's context; a direct call's by default. */
  context?: () => ForgeContext;
  /** What the forge's result reads at this stage. It holds with or without a trace, so it shows the forge ended here. */
  result: (result: ForgeResult) => void;
  /** The trace's reason, read from the result. */
  reason: (result: ForgeResult) => string | null;
  /** Whether the judge ran: the trace's verdict is the result's and every test ran. */
  judged: boolean;
  executor: { name: string; isolates: boolean } | null;
  /** The trace's tool id: none minted, the id the engine minted, or the result's own. */
  toolId: 'none' | 'minted' | 'result';
  /** The checks this row alone makes. */
  also?: (trace: TraceShape, result: ForgeResult) => void;
}

/** The result of a forge the engine refused or failed before the judge: no tool, and an error that begins as given. */
function refusedWith(start: RegExp | string): (result: ForgeResult) => void {
  return (result) => {
    expect(result.success).toBe(false);
    expect(result.toolId).toBeUndefined();
    expect(result.verdict).toBeUndefined();
    if (typeof start === 'string') {
      expect(result.error).toBe(start);
    } else {
      expect(result.error).toMatch(start);
    }
  };
}

const errorOf = (result: ForgeResult): string | null => result.error ?? null;

const ENGINE_ROWS: EngineRow[] = [
  {
    title: 'stage engine_disabled (engine)',
    stage: 'engine_disabled',
    outcome: 'refused',
    engine: () => ({ config: { enabled: false } }),
    args: () => sandboxArgs(),
    result: refusedWith('Emergent capabilities are disabled.'),
    reason: () => 'Emergent capabilities are disabled.',
    judged: false,
    executor: null,
    toolId: 'none',
  },
  {
    title: 'stage name_refused (engine)',
    stage: 'name_refused',
    outcome: 'refused',
    args: () => sandboxArgs({ name: '1st tool' }),
    result: refusedWith(/^tool name .+ refused: /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'none',
  },
  {
    title: 'stage compose_refused (engine)',
    stage: 'compose_refused',
    outcome: 'refused',
    args: () => composeArgs([{ name: 's1', tool: 'missing_tool', inputMapping: {} }]),
    result: refusedWith(/^step_missing: /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage compose_needs_step_output (engine)',
    stage: 'compose_needs_step_output',
    outcome: 'refused',
    engine: () => ({
      hostTools: [sendNoteTool()],
      config: { compose: { sideEffectingTools: ['send_note'] } },
    }),
    // The test case gives no stepOutputs for the step that has side effects.
    args: () => composeArgs([{ name: 'send', tool: 'send_note', inputMapping: { text: '$input.text' } }]),
    result: refusedWith(/^dry_run_needs_output: /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage caller_context_required (engine)',
    stage: 'caller_context_required',
    outcome: 'refused',
    // The step's tool needs the `messaging` capability, and the forge is given no caller.
    engine: () => ({ hostTools: [sendMessageTool([], false)] }),
    args: () => composeArgs([{ name: 'send', tool: 'send_message', inputMapping: { text: '$input.text' } }]),
    result: refusedWith(/^caller_context_required: /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage sandbox_disabled (engine)',
    stage: 'sandbox_disabled',
    outcome: 'refused',
    engine: () => ({ config: { allowSandboxTools: false } }),
    args: () => sandboxArgs(),
    result: refusedWith(/^Sandboxed emergent tools are disabled\./),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage allowlist_unknown (engine)',
    stage: 'allowlist_unknown',
    outcome: 'refused',
    args: () => sandboxWith({ allowlist: ['net'] }),
    result: refusedWith(/^allowlist names capabilities outside the catalogue: net$/),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage effects_need_ceiling (engine)',
    stage: 'effects_need_ceiling',
    outcome: 'refused',
    args: () => sandboxWith({ allowlist: ['fs.write'] }),
    result: refusedWith(/^effects_need_ceiling: fs\.write /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage capability_not_granted (engine)',
    stage: 'capability_not_granted',
    outcome: 'refused',
    engine: () => ({
      config: { capabilities: { fetch: { domains: ['example.com'] } }, audit: { store: 'none' } },
    }),
    args: () => sandboxWith({ allowlist: ['fs.read'] }),
    result: refusedWith(/^capability_not_granted: fs\.read; /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage code_validation (engine)',
    stage: 'code_validation',
    outcome: 'refused',
    args: () => sandboxWith({ code: 'function execute(input) { return eval("1"); }' }),
    result: refusedWith(/^Code validation failed: /),
    reason: errorOf,
    judged: false,
    executor: null,
    toolId: 'minted',
  },
  {
    title: 'stage executor_unavailable (engine)',
    stage: 'executor_unavailable',
    outcome: 'failed',
    engine: () => ({ config: { executor: brokenExecutor() } }),
    args: () => sandboxArgs(),
    result: refusedWith('engine did not load'),
    reason: () => 'engine did not load',
    judged: false,
    executor: { name: 'broken-wasm', isolates: true },
    toolId: 'minted',
  },
  {
    title: 'stage test_responses_refused (engine)',
    stage: 'test_responses_refused',
    outcome: 'refused',
    // The answer's URL is not absolute.
    args: () =>
      sandboxArgs({
        testCases: [
          {
            input: { a: 2, b: 3 },
            expectedOutput: { sum: 5 },
            responses: [{ method: 'POST', url: 'items', status: 201 }],
          },
        ],
      }),
    result: refusedWith(/^invalid_test_responses: /),
    reason: errorOf,
    judged: false,
    executor: IN_PROCESS,
    toolId: 'minted',
  },
  {
    title: 'stage judge_rejected (engine)',
    stage: 'judge_rejected',
    outcome: 'rejected',
    engine: () => ({ judgeReplies: [REJECTED_JSON] }),
    args: () => sandboxArgs(),
    result: (result) => {
      expect(result.success).toBe(false);
      expect(result.toolId).toBeUndefined();
      expect(result.error).toBe('Tool contains unsafe patterns.');
      expect(result.verdict).toMatchObject({ approved: false, reasoning: 'Tool contains unsafe patterns.' });
    },
    reason: () => 'Tool contains unsafe patterns.',
    judged: true,
    executor: IN_PROCESS,
    toolId: 'minted',
    also: (trace) => {
      expect(trace.provenance.verdict).toMatchObject({
        kind: 'model',
        role: 'judge',
        aiGenerated: true,
        provider: 'judge-provider',
        model: 'judge-model',
        modelSource: 'requested',
      });
    },
  },
  {
    title: 'stage approved (engine, sandbox)',
    stage: 'approved',
    outcome: 'approved',
    args: () => sandboxArgs(),
    // A host's direct call that names its forge and the model it asked.
    context: () =>
      ({
        agentId: 'agent-1',
        sessionId: 'turn-1',
        forgeId: 'forge_00000000-0000-4000-8000-000000000001',
        author: { provider: 'host-provider', model: 'host-model' },
      }) as ForgeContext,
    result: (result) => {
      expect(result.success).toBe(true);
      expect(result.toolId).toMatch(MINTED_TOOL_ID);
      expect(result.verdict).toMatchObject({ approved: true });
    },
    reason: () => null,
    judged: true,
    executor: IN_PROCESS,
    toolId: 'result',
    also: (trace) => {
      expect(trace.forgeId).toBe('forge_00000000-0000-4000-8000-000000000001');
      expect(trace.provenance.request).toMatchObject({
        kind: 'model',
        role: 'direct_caller',
        aiGenerated: true,
        provider: 'host-provider',
        model: 'host-model',
        modelSource: 'requested',
      });
    },
  },
  {
    title: 'stage approved (engine, compose)',
    stage: 'approved',
    outcome: 'approved',
    engine: () => ({ hostTools: [echoTool('echo')] }),
    args: () =>
      composeArgs([{ name: 'say', tool: 'echo', inputMapping: { text: '$input.text' } }], {
        testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
      }),
    result: (result) => {
      expect(result.success).toBe(true);
      expect(result.toolId).toMatch(MINTED_TOOL_ID);
      expect(result.verdict).toMatchObject({ approved: true });
    },
    reason: () => null,
    judged: true,
    // A composition runs through its steps' own tools: no executor of forged code.
    executor: null,
    toolId: 'result',
    also: (trace) => {
      expect(trace.provenance.request).toMatchObject({
        kind: 'caller',
        role: 'direct_caller',
        aiGenerated: null,
        provider: null,
        model: null,
        modelSource: null,
      });
    },
  },
];

/** The context of a model's call to forge_tool: its persona, its turn and its session. */
function toolContext(): ToolExecutionContext {
  return {
    gmiId: 'gmi-1',
    personaId: 'persona-1',
    userContext: { userId: 'user-1' } as UserContext,
    correlationId: 'turn-1',
    sessionData: { sessionId: 'session-1' },
  };
}

/** What every trace carries whatever its stage, and who recorded it. */
function expectTraceBy(trace: TraceShape, recordedBy: string, via: string): void {
  expect(trace.traceVersion).toBe(1);
  expect(trace.forgeId).toMatch(FORGE_ID);
  expect(trace.recordedBy).toBe(recordedBy);
  expect(trace.via).toBe(via);
}

/** A forge_tool a host subclasses to refuse a forge on its own rule: it returns before forge_tool's own `execute`. */
class RefusingForgeTool extends ForgeToolMetaTool {
  override async execute(_args: ForgeToolInput, _context: ToolExecutionContext): Promise<ToolExecutionResult<ForgeResult>> {
    return { success: false, error: 'this host refuses async code' };
  }
}

/** A department's wrapper over `raw`, which records every attempt in `captures` and names the model it asked when `author` is set. */
function departmentWrapper(raw: ForgeToolMetaTool, captures: CapturedForge[], author = true): ITool {
  return wrapForgeTool({
    raw,
    agentId: 'dept-agent',
    sessionId: 'dept-session',
    capture: (record: CapturedForge) => {
      captures.push(record);
    },
    ...(author ? { author: { provider: 'dept-provider', model: 'dept-model' } } : {}),
  } as WrapForgeToolOptions);
}

/** The author a forge_tool call names when no layer knows the answering model and no author was given. */
const UNNAMED_FORGING_AGENT = {
  kind: 'model',
  role: 'forging_agent',
  aiGenerated: true,
  provider: null,
  model: null,
  modelSource: null,
};

/** The persona and turn of a model's call that reaches an orchestrator's own forge_tool. */
const CALLER = { personaId: 'persona-1', correlationId: 'turn-1' };

/** A host's own call to its orchestrator's forge_tool, with what `processToolCall` carries beside the request. */
function processForgeCall(
  host: ForgeHost,
  args: Record<string, any>,
  extra: Partial<ToolExecutionRequestDetails> = {},
): Promise<ToolCallResult> {
  return host.orchestrator.processToolCall({
    toolCallRequest: { id: 'call-forge', name: 'forge_tool', arguments: args },
    gmiId: 'gmi-1',
    personaId: CALLER.personaId,
    personaCapabilities: [],
    userContext: { userId: 'user-1' } as UserContext,
    correlationId: CALLER.correlationId,
    ...extra,
  });
}

/** An approval manager whose every answer is `decide`'s. */
function scriptedHitl(decide: (action: PendingAction) => Promise<ApprovalDecision>): {
  manager: IHumanInteractionManager;
  requestApproval: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(decide);
  return { manager: { requestApproval } as unknown as IHumanInteractionManager, requestApproval };
}

/** A person's answer to `action`. */
function decision(action: PendingAction, approved: boolean, rejectionReason?: string): ApprovalDecision {
  return {
    actionId: action.actionId,
    approved,
    ...(rejectionReason === undefined ? {} : { rejectionReason }),
    decidedBy: 'test',
    decidedAt: new Date(),
  };
}

/** The one trace an orchestrator's own forge_tool call was handed to the hook with, and what every such trace reads. */
function orchestratorTrace(traces: TraceShape[], stage: string, outcome: string): TraceShape {
  expect(traces).toHaveLength(1);
  const trace = traces[0];
  expectTraceBy(trace, 'orchestrator', 'forge_tool');
  expect(trace.agentId).toBe('persona-1');
  expect(trace.correlationId).toBe('turn-1');
  expect(trace.stage).toBe(stage);
  expect(trace.outcome).toBe(outcome);
  expect(trace.verdict).toBeNull();
  return trace;
}

/** One way an orchestrator ends a call to its own forge_tool before the tool runs. */
interface OrchestratorRefusal {
  label: string;
  /** The host's options beside the hook; `late.host` is the host once it is made. */
  host?: (late: { host?: ForgeHost }, stop: AbortController) => Omit<ForgeHostOptions, 'onForgeTrace'>;
  /** The call; through `callTool` unless the row needs what `processToolCall` carries. */
  call?: (host: ForgeHost, stop: AbortController) => Promise<ToolCallResult>;
  /** What the host's permission manager answers before the call. */
  before?: (host: ForgeHost) => void;
  /** The refusal's message, as the tool result reads it at this stage. */
  message: RegExp | string;
}

const ORCHESTRATOR_REFUSALS: OrchestratorRefusal[] = [
  {
    label: 'disabled by name',
    host: () => ({ orchestratorConfig: { globalDisabledTools: ['forge_tool'] } }),
    message: "Attempted to execute globally disabled tool 'forge_tool'. Execution denied.",
  },
  {
    label: 'disabled by id',
    host: () => ({ orchestratorConfig: { globalDisabledTools: ['com.framers.emergent.forge-tool'] } }),
    message: /^Attempted to execute globally disabled tool 'forge_tool' \(ID: 'com\.framers\.emergent\.forge-tool'\)/,
  },
  {
    label: 'permission refused',
    before: (host) => {
      host.permissionManager.isExecutionAllowed.mockResolvedValueOnce({ isAllowed: false, reason: 'no forging here' });
    },
    message: 'no forging here',
  },
  {
    label: 'no approval manager',
    host: () => ({ orchestratorConfig: { hitl: { enabled: true } } }),
    message: /requires approval, but no HITL manager is configured\.$/,
  },
  {
    label: 'stopped before approval',
    call: (host) => processForgeCall(host, sandboxArgs(), { signal: AbortSignal.abort() }),
    message: /^step_aborted: /,
  },
  {
    label: 'stopped during approval',
    // The turn stops while the person is asked, and the person approves.
    host: (_late, stop) => ({
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: scriptedHitl(async (action) => {
        stop.abort();
        return decision(action, true);
      }).manager,
    }),
    call: (host, stop) => processForgeCall(host, sandboxArgs(), { signal: stop.signal }),
    message: /^step_aborted: /,
  },
  {
    label: 'replaced during approval',
    // forge_tool is unregistered while the person is asked, and the person approves.
    host: (late) => ({
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: scriptedHitl(async (action) => {
        await late.host!.executor.unregisterTool('forge_tool');
        return decision(action, true);
      }).manager,
    }),
    message: /^tool_replaced: /,
  },
];

describe('forge trace: one trace per forge, on every carrier that applies', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  for (const row of ENGINE_ROWS) {
    it(row.title, async () => {
      const { onForgeTrace, traces } = hookRecorder();
      const { engine } = await directEngine({ ...(row.engine?.() ?? {}), onForgeTrace });
      const args = row.args();

      const result = await engine.forge(args as unknown as ForgeToolRequest, (row.context ?? directContext)());
      row.result(result);

      // The carriers: the hook was handed one trace, and the result holds that same object.
      expect(traces).toHaveLength(1);
      const trace = traces[0];
      expect(traceOf(result)).toBe(trace);

      expectDirectEngineTrace(trace);
      expect(trace.stage).toBe(row.stage);
      expect(trace.outcome).toBe(row.outcome);
      expect(trace.reason).toBe(row.reason(result));
      expect(trace.executor).toEqual(row.executor);
      if (row.toolId === 'none') {
        expect(trace.toolId).toBeNull();
      } else if (row.toolId === 'minted') {
        expect(trace.toolId).toMatch(MINTED_TOOL_ID);
      } else {
        expect(trace.toolId).toBe(result.toolId);
      }

      // The request is whole whatever the stage; its test cases are in `tests`, in order.
      expect(trace.request).toMatchObject({ name: args.name, description: args.description });
      expect(trace.tests).toHaveLength((args.testCases as unknown[]).length);
      if (row.judged) {
        expect(trace.verdict).toEqual(result.verdict);
        for (const test of trace.tests) {
          expect(test.ran).toBe(true);
          expect(test.result).toBeDefined();
        }
        expect(trace.provenance.testResults).toMatchObject({ kind: 'execution' });
      } else {
        // The forge ended before any test case ran, and no judge was asked.
        expect(trace.verdict).toBeNull();
        for (const test of trace.tests) {
          expect(test.ran).toBe(false);
          expect(test.result).toBeUndefined();
        }
      }
      row.also?.(trace, result);
    });
  }

  const THROWN_ROWS: Array<{ title: string; thrown: () => unknown; reason: string }> = [
    {
      title: 'stage thrown (engine)',
      thrown: () => new Error('register failed'),
      reason: 'register failed',
    },
    {
      // String() of this value throws, so the reason is its JSON text.
      title: 'stage thrown (engine, a value with no toString)',
      thrown: () => Object.create(null) as unknown,
      reason: '{}',
    },
  ];

  for (const row of THROWN_ROWS) {
    it(row.title, async () => {
      const { onForgeTrace, traces } = hookRecorder();
      const { engine } = await directEngine({ onForgeTrace });
      const thrown = row.thrown();
      // The registration of an approved tool throws: the tests ran and the judge approved before it.
      vi.spyOn(EmergentToolRegistry.prototype, 'register').mockImplementationOnce(() => {
        throw thrown;
      });

      // The forge rejects with the thrown value itself, so no result exists to carry a trace.
      await expect(engine.forge(sandboxArgs() as unknown as ForgeToolRequest, directContext())).rejects.toBe(thrown);

      // The hook's one trace is the whole record of this forge.
      expect(traces).toHaveLength(1);
      const trace = traces[0];
      expectDirectEngineTrace(trace);
      expect(trace.stage).toBe('thrown');
      expect(trace.outcome).toBe('failed');
      expect(trace.reason).toBe(row.reason);
      expect(trace.verdict).toMatchObject({ approved: true, reasoning: 'Tool is safe and correct.' });
      expect(trace.executor).toEqual(IN_PROCESS);
      expect(trace.toolId).toMatch(MINTED_TOOL_ID);
    });
  }

  // forge_tool's own stages: it refuses before the engine runs, so it records the forge itself.

  const FORGE_TOOL_ROWS: Array<{
    title: string;
    stage: string;
    args: () => Record<string, unknown>;
    frozen?: boolean;
    result: (result: ToolExecutionResult<ForgeResult>) => void;
    also?: (trace: TraceShape) => void;
  }> = [
    {
      title: 'stage self_change_refused (forge_tool)',
      stage: 'self_change_refused',
      frozen: true,
      args: () => sandboxArgs(),
      result: (result) => {
        expect(result.error).toMatch(/self-change is frozen/);
      },
      also: (trace) => {
        // The request arrived whole; none of its test cases ran.
        expect(trace.request).toMatchObject({ name: 'add_numbers', description: 'Add two numbers.' });
        expect(trace.tests).toHaveLength(1);
        for (const test of trace.tests) {
          expect(test.ran).toBe(false);
          expect(test.result).toBeUndefined();
        }
      },
    },
    {
      title: 'stage name_refused (forge_tool)',
      stage: 'name_refused',
      args: () => sandboxArgs({ name: 'bad name' }),
      result: (result) => {
        expect(result.details).toMatchObject({ code: 'INVALID_TOOL_NAME' });
      },
    },
    {
      title: 'stage description_missing (forge_tool)',
      stage: 'description_missing',
      args: () => sandboxArgs({ description: '' }),
      result: (result) => {
        expect(result.error).toBe('description is required and must be a string');
      },
    },
  ];

  for (const row of FORGE_TOOL_ROWS) {
    it(row.title, async () => {
      const { onForgeTrace, traces } = hookRecorder();
      const { forgeTool, generateText } = await directEngine({ onForgeTrace });
      if (row.frozen) {
        vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
      }

      const result = await forgeTool.execute(row.args() as unknown as ForgeToolInput, toolContext());
      expect(result.success).toBe(false);
      row.result(result);
      expect(generateText).not.toHaveBeenCalled();

      // forge_tool's result is the model's tool result: the hook is the carrier.
      expect(traces).toHaveLength(1);
      const trace = traces[0];
      expectTraceBy(trace, 'forge_tool', 'forge_tool');
      expect(trace.agentId).toBe('persona-1');
      expect(trace.correlationId).toBe('turn-1');
      expect(trace.sessionId).toBe('session-1');
      expect(trace.stage).toBe(row.stage);
      expect(trace.outcome).toBe('refused');
      expect(trace.reason).toBe(result.error);
      expect(trace.verdict).toBeNull();
      row.also?.(trace);
    });
  }

  // The wrapper's own stages: it ends the call before forge_tool's own execute, or the call throws inside it.

  /** What every trace the wrapper records reads. */
  function expectWrapperTrace(trace: TraceShape, stage: string, outcome: string): void {
    expectTraceBy(trace, 'wrapper', 'forge_tool');
    expect(trace.agentId).toBe('dept-agent');
    expect(trace.sessionId).toBe('dept-session');
    expect(trace.stage).toBe(stage);
    expect(trace.outcome).toBe(outcome);
    expect(trace.verdict).toBeNull();
  }

  it('stage refused_before_approval (wrapper)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { forgeTool } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(forgeTool, captures);
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');

    const refusal = wrapped.refusalBeforeApproval!(sandboxArgs(), toolContext());
    expect(refusal?.success).toBe(false);
    expect(captures).toHaveLength(1);

    // The method is synchronous: the trace is delivered after it returns.
    await vi.waitFor(() => expect(traces).toHaveLength(1));
    const trace = traces[0];
    expectWrapperTrace(trace, 'refused_before_approval', 'refused');
    expect(trace.reason).toBe(refusal?.error);
    expect(traceOf(captures[0])).toBe(trace);
    // No layer knows the answering model: the wrapper's author is the request's.
    expect(trace.provenance.request).toMatchObject({
      kind: 'model',
      role: 'forging_agent',
      aiGenerated: true,
      provider: 'dept-provider',
      model: 'dept-model',
      modelSource: 'requested',
    });
  });

  /** Arguments the wrapper's shape check refuses: no declared properties, one test case, an empty input. */
  const shapeRefusedArgs = (): Record<string, unknown> =>
    sandboxArgs({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, testCases: [{ input: {} }] });

  it('stage shape_check (wrapper)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { forgeTool, generateText } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(forgeTool, captures);
    // The call names the model that answered it (`ToolExecutionContext.callerModel`).
    const context = {
      ...toolContext(),
      callerModel: { providerId: 'answer-provider', modelId: 'answer-model' },
    } as ToolExecutionContext;

    const result = await wrapped.execute(shapeRefusedArgs(), context);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Shape check failed: /);
    expect(captures).toHaveLength(1);
    expect(generateText).not.toHaveBeenCalled();

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(captures[0])).toBe(trace);
    expectWrapperTrace(trace, 'shape_check', 'refused');
    expect(trace.reason).toBe(result.error);
    // The request is the arguments as the wrapper normalized them.
    expect(trace.request).toMatchObject({
      name: 'add_numbers',
      description: 'Add two numbers.',
      implementation: { mode: 'sandbox' },
    });
    expect(trace.rawArguments).toBeUndefined();
    for (const test of trace.tests) {
      expect(test.ran).toBe(false);
    }
    // The answering model wins over the wrapper's author.
    expect(trace.provenance.request).toMatchObject({
      kind: 'model',
      role: 'forging_agent',
      aiGenerated: true,
      provider: 'answer-provider',
      model: 'answer-model',
      modelSource: 'answered',
    });
  });

  it('stage shape_check (wrapper, no author)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { forgeTool } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(forgeTool, captures, false);

    const result = await wrapped.execute(shapeRefusedArgs(), toolContext());
    expect(result.error).toMatch(/^Shape check failed: /);
    expect(captures).toHaveLength(1);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(captures[0])).toBe(trace);
    expectWrapperTrace(trace, 'shape_check', 'refused');
    // A model wrote the request, and no layer knows which: never the direct caller's author.
    expect(trace.provenance.request).toEqual(expect.objectContaining(UNNAMED_FORGING_AGENT));
  });

  it('stage host_refused (wrapper)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { engine, generateText } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(new RefusingForgeTool(engine), captures);

    const result = await wrapped.execute(wrapperArgs(), toolContext());
    expect(result).toEqual({ success: false, error: 'this host refuses async code' });
    expect(captures).toHaveLength(1);
    expect(generateText).not.toHaveBeenCalled();

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(captures[0])).toBe(trace);
    expectWrapperTrace(trace, 'host_refused', 'refused');
    expect(trace.reason).toBe('this host refuses async code');
  });

  it('stage thrown (wrapper)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { forgeTool } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(forgeTool, captures);
    const args = sandboxArgs({ testCases: [null] });

    // The wrapper's normalization reads a property of the null test case.
    const thrown = await wrapped.execute(args, toolContext()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(TypeError);
    expect(captures).toHaveLength(0);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expectTraceBy(trace, 'wrapper', 'forge_tool');
    expect(trace.agentId).toBe('dept-agent');
    expect(trace.sessionId).toBe('dept-session');
    expect(trace.stage).toBe('thrown');
    expect(trace.outcome).toBe('failed');
    expect(trace.reason).toBe((thrown as TypeError).message);
    // A test case that is not an object: the arguments are kept as they arrived.
    expect(trace.request).toBeNull();
    expect(trace.tests).toEqual([]);
    expect(trace.rawArguments).toEqual(args);
  });

  // The orchestrator's stages, for its own forge_tool: the call ends before the tool runs.

  it('stage schema_check (input schema)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const host = await makeForgeHost({ onForgeTrace });
    const args = sandboxArgs();
    delete args.testCases;

    const result = await callTool(host.orchestrator, 'forge_tool', args, CALLER);
    expect(result.isError).toBe(true);
    const details = result.errorDetails.details as { validationErrors: Array<{ message: string }> };
    expect(details.validationErrors.length).toBeGreaterThan(0);
    expect(host.judge).not.toHaveBeenCalled();

    const trace = orchestratorTrace(traces, 'schema_check', 'refused');
    expect(trace.reason).toBe(
      `${result.errorDetails.message} ${details.validationErrors.map((error) => error.message).join('; ')}`,
    );
    expect(trace.request).toBeNull();
    expect(trace.tests).toEqual([]);
    expect(trace.rawArguments).toEqual(args);
  });

  it('stage schema_check (unparsable arguments)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const host = await makeForgeHost({ onForgeTrace });

    // A host's direct call: a model's call through the GMI is parsed before it reaches the orchestrator.
    const result = await processForgeCall(host, '{not json' as unknown as Record<string, any>);
    expect(result.isError).toBe(true);
    const details = result.errorDetails.details as { argumentParsingError: string };
    expect(typeof details.argumentParsingError).toBe('string');

    const trace = orchestratorTrace(traces, 'schema_check', 'refused');
    expect(trace.reason).toBe(`${result.errorDetails.message} ${details.argumentParsingError}`);
    expect(trace.request).toBeNull();
    expect(trace.rawArguments).toBe('{not json');
  });

  it('stage refused_before_approval (orchestrator)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const hitl = approvingHitl();
    const host = await makeForgeHost({
      onForgeTrace,
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: hitl.manager,
    });
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');

    const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
    expect(result.isError).toBe(true);
    expect(result.errorDetails.message).toMatch(/self-change is frozen/);
    // Nobody is asked to approve a call that cannot act.
    expect(hitl.requestApproval).not.toHaveBeenCalled();

    const trace = orchestratorTrace(traces, 'refused_before_approval', 'refused');
    expect(trace.reason).toBe(result.errorDetails.message);
  });

  it.each(ORCHESTRATOR_REFUSALS.map((row): [string, OrchestratorRefusal] => [row.label, row]))(
    'stage orchestrator_refused (%s)',
    async (_label, row) => {
      const { onForgeTrace, traces } = hookRecorder();
      const stop = new AbortController();
      const late: { host?: ForgeHost } = {};
      const host = await makeForgeHost({ ...(row.host?.(late, stop) ?? {}), onForgeTrace });
      late.host = host;
      row.before?.(host);

      const result = await (row.call?.(host, stop) ?? callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER));
      expect(result.isError).toBe(true);
      if (typeof row.message === 'string') {
        expect(result.errorDetails.message).toBe(row.message);
      } else {
        expect(result.errorDetails.message).toMatch(row.message);
      }
      expect(host.judge).not.toHaveBeenCalled();

      const trace = orchestratorTrace(traces, 'orchestrator_refused', 'refused');
      expect(trace.reason).toBe(result.errorDetails.message);
    },
  );

  it('stage permission_check_failed', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const host = await makeForgeHost({ onForgeTrace });
    host.permissionManager.isExecutionAllowed.mockRejectedValueOnce(new Error('permission store down'));

    const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
    expect(result.isError).toBe(true);
    expect(result.errorDetails.message).toContain('permission store down');

    const trace = orchestratorTrace(traces, 'permission_check_failed', 'failed');
    expect(trace.reason).toBe(result.errorDetails.message);
  });

  it('stage human_denied', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const hitl = scriptedHitl(async (action) => decision(action, false, 'Not this tool.'));
    const host = await makeForgeHost({
      onForgeTrace,
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: hitl.manager,
    });
    // Over 1 KiB of code, then the justification as the arguments' last key: past the approval's 800-character preview.
    const justification = 'No tool here reads the sensor log.';
    const args = {
      ...sandboxWith({ code: `${ADD_CODE}${' '.repeat(1040)}` }),
      justification,
    };

    const result = await callTool(host.orchestrator, 'forge_tool', args, CALLER);
    expect(result.isError).toBe(true);
    expect(result.errorDetails.message).toBe('Not this tool.');

    // The person was shown the justification beside the preview, which is cut before it.
    expect(hitl.requestApproval).toHaveBeenCalledTimes(1);
    const pending = hitl.requestApproval.mock.calls[0][0] as PendingAction;
    expect(String(pending.context.argsPreview)).not.toContain(justification);
    expect.soft(pending.context.justification).toBe(justification);

    const trace = orchestratorTrace(traces, 'human_denied', 'refused');
    expect(trace.reason).toBe('Not this tool.');
    expect(trace.justification).toBe(justification);
  });

  it('stage approval_failed', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const hitl = scriptedHitl(async () => {
      throw new Error('approval service down');
    });
    const host = await makeForgeHost({
      onForgeTrace,
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: hitl.manager,
    });

    const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
    expect(result.isError).toBe(true);
    expect(result.errorDetails.message).toBe('Approval request failed: approval service down');

    const trace = orchestratorTrace(traces, 'approval_failed', 'failed');
    expect(trace.reason).toBe('Approval request failed: approval service down');
  });

  it('a justification that is not a string is accepted and kept as its JSON text', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const host = await makeForgeHost({ onForgeTrace });

    // Any JSON value passes forge_tool's schema; a string-only property would refuse this call at schema_check.
    const result = await callTool(
      host.orchestrator,
      'forge_tool',
      { ...sandboxArgs(), justification: { gap: 'sensor data' } },
      CALLER,
    );
    expect(result.isError).toBeFalsy();
    expect((result.output as ForgeResult).success).toBe(true);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.outcome).toBe('approved');
    expect(trace.justification).toBe('{"gap":"sensor data"}');
    expect(trace.provenance.justification).toMatchObject({ kind: 'model', role: 'forging_agent' });
  });
});
