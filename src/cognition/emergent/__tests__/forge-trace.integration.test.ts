/**
 * @fileoverview The forge trace on the real path: a real engine over a real
 * tool executor, with a scripted judge, reached directly, through forge_tool,
 * through a host's wrapper and through an orchestrator's own forge_tool. One
 * forge per stage a forge can end at, each asserting that every carrier that
 * applies (the forge's result, the host's hook, the wrapper's capture) holds
 * the same trace, with that stage's outcome, reason, verdict, executor and
 * tool id. A second group pins what a forge_tool call looks like to the model,
 * to a host's stream and to a wrapper's capture, so a trace changes none of it.
 * A third group forges on the full runtime and reads the model that answered
 * each tool call, and a fourth reads every log line a forge writes for the
 * content it must never hold. A fifth forges with every field over its cap
 * and reads the cuts, their paths and the trace's total size. A sixth forges
 * a fixed set of tools and records the sizes each trace states, then times
 * forges on an engine with a no-op hook and on one with none, and records
 * what the hook adds. The times are recorded and never asserted: a wall-clock
 * comparison on a shared runner is a benchmark, and benchmarks live in
 * agentos-bench.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the full runtime's model answers: its streamed replies in order, the judge's reply, and the judge's calls. */
const runtimeModel = vi.hoisted(() => ({
  replies: [] as Array<Array<Record<string, unknown>>>,
  judgeReply: '',
  judgeCalls: 0,
}));

// The OpenAI provider class the full runtime starts, stubbed at its module boundary. A streamed call answers the next
// scripted reply, each final chunk naming the model that answered it unless the reply sets its own modelId; an
// unstreamed call (the emergent judge's, on the full runtime) answers the judge's reply. Only the tests that build
// AgentOS start a provider of this class.
vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', async (importOriginal) => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() {
      this.isInitialized = true;
    }
    async generateCompletion() {
      runtimeModel.judgeCalls += 1;
      return {
        choices: [{ message: { role: 'assistant', content: runtimeModel.judgeReply }, finishReason: 'stop' }],
        responseText: runtimeModel.judgeReply,
      };
    }
    async *generateCompletionStream() {
      const reply = runtimeModel.replies.shift() ?? [
        { responseTextDelta: 'Done.' },
        { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }] },
      ];
      for (const chunk of reply) {
        yield chunk.isFinal && !('modelId' in chunk) ? { ...chunk, modelId: 'stream-model-7' } : chunk;
      }
    }
    async generateEmbeddings() {
      return { embeddings: [] };
    }
    async listAvailableModels() {
      return [];
    }
    async getModelInfo() {
      return undefined;
    }
    async checkHealth() {
      return { isHealthy: true };
    }
    async shutdown() {}
  }
  return {
    ...(await importOriginal<typeof import('../../../core/llm/providers/implementations/OpenAIProvider.js')>()),
    OpenAIProvider,
  };
});

import { AgentOS } from '../../../api/AgentOS.js';
import type { AgentOSInput } from '../../../api/types/AgentOSInput.js';
import { AgentOSResponseChunkType, type AgentOSToolCallRequestChunk } from '../../../api/types/AgentOSResponse.js';
import { AGENTOS_CONTEXT, AGENTOS_EVENTS, valid, type EventMap } from '../../../core/logging/events.js';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../../core/tools/ITool.js';
import { ToolExecutor, type ToolExecutionRequestDetails } from '../../../core/tools/ToolExecutor.js';
import type {
  ApprovalDecision,
  IHumanInteractionManager,
  PendingAction,
} from '../../../orchestration/hitl/IHumanInteractionManager.js';
import { HumanInteractionManager } from '../../../orchestration/hitl/HumanInteractionManager.js';
import {
  GuardrailAction,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from '../../../safety/guardrails/IGuardrailService.js';
import { GMIOutputChunkType, type ToolCallResult, type UserContext } from '../../substrate/IGMI.js';
import type { IPersonaDefinition } from '../../substrate/personas/IPersonaDefinition.js';
import {
  createScriptedGmi,
  runTurn,
  scriptedProvider,
  textReply,
  textTurn,
  toolCallReply,
} from '../../substrate/__tests__/helpers/scriptedGmi.js';
import type { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { EmergentJudge } from '../EmergentJudge.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { QuickJSExecutor } from '../executor/QuickJSExecutor.js';
import type { ForgedCodeExecutor } from '../executor/types.js';
import {
  ForgeToolMetaTool,
  wrapForgeTool,
  type CapturedForge,
  type ForgeToolInput,
  type WrapForgeToolOptions,
} from '../index.js';
import type { CreationVerdict, ForgeResult, ForgeToolRequest, ForgedCapabilities } from '../types.js';
import {
  FD17F220_SCHEMA,
  PINS,
  PIN_OUTCOMES,
  failNextRegistration,
  judgePromptArgs,
  pinArgs,
  pinJudgeReply,
  richOutputTool,
  withoutThrownStacks,
  type PinOutcome,
} from './fixtures/forge-trace-pins.js';
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
  APPROVED_JSON,
  REJECTED_JSON,
  captureLines,
  composeArgs,
  directEngine,
  freezeClock,
  hookRecorder,
  sandboxArgs,
  traceOf,
  wrapperArgs,
  type TraceShape,
} from './helpers/forge-trace-harness.js';
import { TEXT_IN, TEXT_OUT } from './helpers/seed-rows.js';
import { createSqliteAdapter } from './helpers/sqlite-adapter.js';

type DirectEngineOptions = NonNullable<Parameters<typeof directEngine>[0]>;
type DirectEngine = Awaited<ReturnType<typeof directEngine>>;
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
  /** The forge stopped inside its first test case: that case keeps the run it returned, and no later case ran. */
  stoppedInFirstTest?: boolean;
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
    stoppedInFirstTest: true,
    executor: null,
    toolId: 'minted',
    also: (trace, result) => {
      // The test case's run stopped at the step with no stand-in output, and says so.
      expect(trace.tests[0].result.error).toBe(result.error);
    },
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
    stoppedInFirstTest: true,
    executor: null,
    toolId: 'minted',
    also: (trace) => {
      // The test case's run stopped at the step the stand-in context could not call.
      expect(trace.tests[0].result.error).toMatch(/^Step "send" \(tool: "send_message"\) failed: /);
    },
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

/** A forge_tool a host subclasses to hand forge_tool's own `execute` a copy of the call's context. */
class CopyingForgeTool extends ForgeToolMetaTool {
  override execute(args: ForgeToolInput, context: ToolExecutionContext): Promise<ToolExecutionResult<ForgeResult>> {
    return super.execute(args, { ...context });
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

/** A direct forge of the code forge of `sandboxArgs`, with its fields replaced by `overrides`. */
function forgeDirect(engine: EmergentCapabilityEngine, overrides: Record<string, unknown> = {}): Promise<ForgeResult> {
  return engine.forge(sandboxArgs(overrides) as unknown as ForgeToolRequest, directContext());
}

/** The judge's approval, as a trace keeps it when the forge ends after the judge. */
const JUDGE_APPROVAL = { approved: true, reasoning: 'Tool is safe and correct.' };

/** A composition with one step over the host tool `echo`. */
function echoComposition(): Record<string, unknown> {
  return composeArgs([{ name: 'say', tool: 'echo', inputMapping: { text: '$input.text' } }]);
}

/** A one-step composition named `name` over the tool `tool`, as the composition suite forges its cycles. */
function composeOver(name: string, tool: string): Record<string, unknown> {
  return {
    name,
    description: `Runs ${tool}.`,
    inputSchema: TEXT_IN,
    outputSchema: TEXT_OUT,
    implementation: { mode: 'compose', steps: [{ name: 's', tool, inputMapping: { text: '$input.text' } }] },
    testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
  };
}

/** The captured lines of one event. */
function eventLines(lines: Array<Record<string, unknown>>, event: string): Array<Record<string, unknown>> {
  return lines.filter((line) => line.event === event);
}

/** The captured lines of the forge trace's own events. */
function forgeTraceLines(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.filter((line) => {
    const event = line.event;
    return typeof event === 'string' && event.startsWith('emergent.forge');
  });
}

/** How long a forge waits for a host's hook. */
const HOOK_BOUND_MS = 1_000;
/** A Node timer can fire up to a millisecond before its delay as `performance.now()` reads it. */
const TIMER_SLACK_MS = 5;

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What `work` resolves to, and the milliseconds it took. */
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await work();
  return { value, ms: performance.now() - start };
}

/** The forge's own time: one approved direct forge on an engine with no hook. */
async function ownForgeMs(): Promise<number> {
  const { engine } = await directEngine();
  const { value, ms } = await timed(() => forgeDirect(engine));
  expect(value.success).toBe(true);
  return ms;
}

/** A judge whose review a host replaced: it rejects every forge, and counts its calls. */
class FixedJudge extends EmergentJudge {
  calls = 0;

  override async reviewCreation(): Promise<CreationVerdict> {
    this.calls += 1;
    return {
      approved: false,
      confidence: 1,
      safety: 0,
      correctness: 1,
      determinism: 1,
      bounded: 1,
      reasoning: 'override says no',
    };
  }
}

/** The judge's detail when its call failed or its reply did not parse: no reply field, and empty lists. */
function noReplyDetail(judgeError: 'llm_call_failed' | 'reply_unparsable'): Record<string, unknown> {
  return {
    judgeModel: 'judge-model',
    replyParsed: false,
    judgeError,
    judgeApproved: null,
    safetyPassed: null,
    safetyConcerns: [],
    correctnessPassed: null,
    failedTests: [],
    deterministic: null,
    determinismReasoning: null,
    bounded: null,
    boundedReasoning: null,
  };
}

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
        // No judge was asked. The forge ended before any test case ran, or inside its first one, whose run is kept.
        expect(trace.verdict).toBeNull();
        trace.tests.forEach((test, index) => {
          if (row.stoppedInFirstTest && index === 0) {
            expect(test.ran).toBe(true);
            expect(test.result).toMatchObject({ success: false });
          } else {
            expect(test.ran).toBe(false);
            expect(test.result).toBeUndefined();
          }
        });
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

  // The stages after the judge: the judge approved, and a later check or the host's registration ended the forge.

  /** The one trace of a direct forge that ended after the judge approved it, on both carriers. */
  function afterJudgeTrace(traces: TraceShape[], result: ForgeResult, stage: string, outcome: string): TraceShape {
    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(result)).toBe(trace);
    expectDirectEngineTrace(trace);
    expect(trace.stage).toBe(stage);
    expect(trace.outcome).toBe(outcome);
    expect(trace.reason).toBe(result.error);
    // The trace keeps the judge's verdict, also where the result leaves it out.
    expect(trace.verdict).toMatchObject(JUDGE_APPROVAL);
    return trace;
  }

  it('stage compose_refused_after_judge (engine)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    let late!: DirectEngine;
    late = await directEngine({
      onForgeTrace,
      hostTools: [echoTool('echo')],
      // The step's tool goes while the judge reviews, so the check after the judge refuses.
      judgeReplies: [
        async () => {
          await late.tools.unregisterTool('echo');
          return APPROVED_JSON;
        },
      ],
    });

    const result = await late.engine.forge(echoComposition() as unknown as ForgeToolRequest, directContext());
    expect(result.success).toBe(false);
    expect(result.toolId).toBeUndefined();
    expect(result.error).toMatch(/^step_missing: /);
    expect(result.verdict).toMatchObject(JUDGE_APPROVAL);

    const trace = afterJudgeTrace(traces, result, 'compose_refused_after_judge', 'refused');
    expect(trace.verdict).toEqual(result.verdict);
  });

  /** The two traces of a cycle closed by two forges: loop_a's ended at step_cycle after the judge, loop_b's was approved. */
  function expectCycleTraces(traces: TraceShape[]): void {
    expect(traces).toHaveLength(2);
    const loopA = traces.find((trace) => trace.toolName === 'loop_a');
    const loopB = traces.find((trace) => trace.toolName === 'loop_b');
    expect(loopA).toBeDefined();
    expect(loopB).toBeDefined();
    expect(loopA!.stage).toBe('step_cycle');
    expect(loopA!.outcome).toBe('refused');
    expect(loopA!.recordedBy).toBe('engine');
    expect(loopA!.via).toBe('forge_tool');
    expect(loopA!.reason).toMatch(/^step_cycle: "loop_a" reaches itself through /);
    expect(loopA!.verdict).toMatchObject(JUDGE_APPROVAL);
    expect(loopB!.stage).toBe('approved');
    expect(loopB!.outcome).toBe('approved');
  }

  it('stage step_cycle (engine, while the state is written)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, tools: [echoTool('loop_a'), echoTool('loop_b')], onForgeTrace });

    // loop_a passed its checks and is registered; its state write is held while loop_b is forged in full.
    const gate = db.gateNext('INSERT INTO agentos_emergent_tool_state');
    const forgingA = callTool(host.orchestrator, 'forge_tool', composeOver('loop_a', 'loop_b'), {
      sessionId: 'sess-cycle',
    });
    await gate.entered;
    // The gate opens once forge B has ended, and in a failed run too, so forge A always settles inside the case.
    const forgedB = await callTool(host.orchestrator, 'forge_tool', composeOver('loop_b', 'loop_a'), {
      sessionId: 'sess-cycle',
    }).finally(() => gate.release());
    const forgedA = await forgingA;
    expect(forgedB.isError).toBeFalsy();
    expect(forgedA.isError).toBe(true);
    expect(String(forgedA.errorDetails?.message)).toContain('step_cycle');

    expectCycleTraces(traces);
  });

  it('stage step_cycle (engine, after its executable is registered)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    let enterShutdown!: () => void;
    const shutdownEntered = new Promise<void>((resolve) => {
      enterShutdown = resolve;
    });
    let releaseShutdown!: () => void;
    const shutdownHeld = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    // The executor shuts the host's loop_a down when loop_a's executable takes its name, and holds the name meanwhile.
    const hostLoopA: ITool = {
      ...echoTool('loop_a'),
      shutdown: async () => {
        enterShutdown();
        await shutdownHeld;
      },
    };
    const host = await makeForgeHost({ tools: [hostLoopA, echoTool('loop_b')], onForgeTrace });

    // loop_a passed every check and its executable is being registered when loop_b is forged in full.
    const forgingA = callTool(host.orchestrator, 'forge_tool', composeOver('loop_a', 'loop_b'), {
      sessionId: 'sess-restore',
    });
    await shutdownEntered;
    // The shutdown is let go once forge B has ended, and in a failed run too, so forge A always settles inside the case.
    const forgedB = await callTool(host.orchestrator, 'forge_tool', composeOver('loop_b', 'loop_a'), {
      sessionId: 'sess-restore',
    }).finally(() => releaseShutdown());
    const forgedA = await forgingA;
    expect(forgedB.isError).toBeFalsy();
    expect(forgedA.isError).toBe(true);
    expect(String(forgedA.errorDetails?.message)).toContain('step_cycle');

    expectCycleTraces(traces);
  });

  it('stage removed_while_forging (engine)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    let late!: DirectEngine;
    late = await directEngine({
      onForgeTrace,
      // The host's registration removes the tool it is handed.
      onToolForged: async (tool) => {
        await late.engine.removeTool(tool.id);
      },
    });

    const result = await forgeDirect(late.engine);
    expect(result.success).toBe(false);
    expect(result.error).toBe('the tool was removed while it was being forged');
    expect(result.verdict).toBeUndefined();

    const trace = afterJudgeTrace(traces, result, 'removed_while_forging', 'failed');
    expect(trace.reason).toBe('the tool was removed while it was being forged');
  });

  it('stage activation_failed (engine)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { engine } = await directEngine({
      onForgeTrace,
      onToolForged: async () => {
        throw new Error('host registration refused');
      },
    });

    const result = await forgeDirect(engine);
    expect(result.success).toBe(false);
    expect(result.error).toBe('host registration refused');
    // The result leaves the verdict out; the trace keeps the judge's.
    expect(result.verdict).toBeUndefined();

    const trace = afterJudgeTrace(traces, result, 'activation_failed', 'failed');
    expect(trace.reason).toBe('host registration refused');
  });

  it('stage registration_failed (engine)', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    let registrations = 0;
    let late!: DirectEngine;
    late = await directEngine({
      onForgeTrace,
      // The first registration replaces the tool under its id, and registering the replacement fails.
      onToolForged: async (tool) => {
        registrations += 1;
        if (registrations === 1) {
          late.registry.remove(tool.id);
          late.registry.register({ ...tool }, 'session');
          return;
        }
        throw new Error('second registration failed');
      },
    });

    const result = await forgeDirect(late.engine);
    expect(registrations).toBe(2);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^the executable of /);
    expect(result.verdict).toBeUndefined();

    afterJudgeTrace(traces, result, 'registration_failed', 'failed');
  });

  // One delivery per forge, whatever layers a host puts between its wrapper and forge_tool.

  it('one delivery per forge: a subclass that refuses before super.execute', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { engine } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(new RefusingForgeTool(engine), captures);

    const result = await wrapped.execute(wrapperArgs(), toolContext());
    expect(result.success).toBe(false);
    expect(captures).toHaveLength(1);
    // A second delivery would arrive after the call returns.
    await sleep(20);

    expect(traces).toHaveLength(1);
    expect(traces[0].stage).toBe('host_refused');
    expect(traceOf(captures[0])).toBe(traces[0]);
  });

  it('one delivery per forge: a subclass that hands super.execute a copied context and is judge-rejected', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { engine } = await directEngine({ onForgeTrace, judgeReplies: [REJECTED_JSON] });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(new CopyingForgeTool(engine), captures);

    const result = await wrapped.execute(wrapperArgs(), toolContext());
    expect(result.success).toBe(false);
    expect(result.error).toBe('Tool contains unsafe patterns.');
    expect(captures).toHaveLength(1);
    await sleep(20);

    // The engine's outcome, once: the record travelled with the call, not with the context object.
    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.stage).toBe('judge_rejected');
    expect(trace.recordedBy).toBe('engine');
    expect(traceOf(captures[0])).toBe(trace);
  });

  it('one delivery per forge: two wrapped calls in parallel', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { forgeTool } = await directEngine({ onForgeTrace });
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(forgeTool, captures);

    const results = await Promise.all([
      wrapped.execute(wrapperArgs({ name: 'add_one' }), toolContext()),
      wrapped.execute(wrapperArgs({ name: 'add_two' }), toolContext()),
    ]);
    for (const result of results) {
      expect(result.success).toBe(true);
    }
    expect(captures.map((capture) => capture.name).sort()).toEqual(['add_one', 'add_two']);
    await sleep(20);

    expect(traces).toHaveLength(2);
    expect(traces[0].forgeId).not.toBe(traces[1].forgeId);
    // Each capture holds its own call's trace.
    for (const capture of captures) {
      const trace = traceOf(capture);
      expect(trace).toBeDefined();
      expect(traces).toContain(trace);
      expect(trace!.toolName).toBe(capture.name);
    }
  });

  // The hook's failures and its bound: the forge goes on, and only a content-free line says what happened.

  it('a hook that throws leaves the result unchanged and writes one hook_failed line', async () => {
    const capture = captureLines();
    try {
      const hooks = [
        vi.fn((_trace: unknown): void => {
          throw new TypeError('hook broke');
        }),
        vi.fn(async (_trace: unknown): Promise<void> => {
          throw new RangeError('hook broke later');
        }),
      ];
      const types = ['TypeError', 'RangeError'];
      for (let i = 0; i < hooks.length; i += 1) {
        const { engine } = await directEngine({ onForgeTrace: hooks[i] });
        const result = await forgeDirect(engine);
        expect(result.success).toBe(true);
        expect(result.toolId).toMatch(MINTED_TOOL_ID);
        expect(hooks[i]).toHaveBeenCalledTimes(1);

        const failed = eventLines(capture.lines, 'emergent.forge_trace_hook_failed');
        expect(failed).toHaveLength(i + 1);
        expect(failed[i]).toMatchObject({ type: types[i], code: 'unknown' });
      }
      // The lines name the error's type, never its message.
      expect(capture.printed()).not.toContain('hook broke');
      expect(JSON.stringify(capture.lines)).not.toContain('hook broke');
    } finally {
      capture.restore();
    }
  });

  it('a hook that never settles returns the forge at the bound with one hook_slow line', async () => {
    const capture = captureLines();
    try {
      const ownMs = await ownForgeMs();
      const hook = vi.fn((_trace: unknown) => new Promise<void>(() => undefined));
      const { engine } = await directEngine({ onForgeTrace: hook });

      const { value: result, ms } = await timed(() => forgeDirect(engine));
      expect(hook).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(HOOK_BOUND_MS - TIMER_SLACK_MS);
      expect(ms).toBeLessThan(HOOK_BOUND_MS + ownMs + 500);

      const slow = eventLines(capture.lines, 'emergent.forge_trace_hook_slow');
      expect(slow).toHaveLength(1);
      expect(slow[0]).toMatchObject({ boundMs: 1000 });
    } finally {
      capture.restore();
    }
  });

  it('a hook that sleeps 2 s returns the forge at the bound with one hook_slow line', async () => {
    const capture = captureLines();
    try {
      const ownMs = await ownForgeMs();
      let hookResolved = false;
      const hook = vi.fn(
        (_trace: unknown) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              hookResolved = true;
              resolve();
            }, 2_000);
          }),
      );
      const { engine } = await directEngine({ onForgeTrace: hook });

      const { value: result, ms } = await timed(() => forgeDirect(engine));
      expect(hook).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(HOOK_BOUND_MS - TIMER_SLACK_MS);
      expect(ms).toBeLessThan(HOOK_BOUND_MS + ownMs + 500);
      expect(eventLines(capture.lines, 'emergent.forge_trace_hook_slow')).toHaveLength(1);
      expect(eventLines(capture.lines, 'emergent.forge_trace_hook_failed')).toHaveLength(0);
      const linesAtReturn = forgeTraceLines(capture.lines).length;

      // The hook finishes after the forge returned, and nothing more is written for it.
      await sleep(1_200);
      expect(hookResolved).toBe(true);
      expect(forgeTraceLines(capture.lines)).toHaveLength(linesAtReturn);
    } finally {
      capture.restore();
    }
  });

  it('a hook that rejects after the bound is caught without a line', async () => {
    const capture = captureLines();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ownMs = await ownForgeMs();
      const hook = vi.fn(
        (_trace: unknown) =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('the hook failed late')), 1_500);
          }),
      );
      const { engine } = await directEngine({ onForgeTrace: hook });

      const { value: result, ms } = await timed(() => forgeDirect(engine));
      expect(hook).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(HOOK_BOUND_MS - TIMER_SLACK_MS);
      expect(ms).toBeLessThan(HOOK_BOUND_MS + ownMs + 500);

      // The hook rejects after the forge returned: nothing reaches the process, and no failure line is written.
      await sleep(700);
      expect(unhandled).not.toHaveBeenCalled();
      expect(eventLines(capture.lines, 'emergent.forge_trace_hook_slow')).toHaveLength(1);
      expect(eventLines(capture.lines, 'emergent.forge_trace_hook_failed')).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', unhandled);
      capture.restore();
    }
  });

  it('parallel forges with a slow hook each return at the bound', async () => {
    const capture = captureLines();
    try {
      const ownMs = await ownForgeMs();
      const hook = vi.fn((_trace: unknown) => new Promise<void>((resolve) => setTimeout(resolve, 1_500)));
      const { engine } = await directEngine({ onForgeTrace: hook });

      const runs = await Promise.all(
        [1, 2, 3].map((n) => timed(() => forgeDirect(engine, { name: `add_numbers_${n}` }))),
      );
      expect(hook).toHaveBeenCalledTimes(3);
      // Each forge's trace reached the hook once.
      expect(new Set(hook.mock.calls.map(([trace]) => (trace as TraceShape).forgeId)).size).toBe(3);
      for (const run of runs) {
        expect(run.value.success).toBe(true);
        expect(run.ms).toBeLessThan(HOOK_BOUND_MS + ownMs + 500);
      }
      expect(eventLines(capture.lines, 'emergent.forge_trace_hook_slow')).toHaveLength(3);
    } finally {
      capture.restore();
    }
  });

  // The judge: a host's override is called as it is, and the class's own judge keeps the detail its verdict drops.

  it("a judge subclass's reviewCreation override is called and judgeDetail is null", async () => {
    const judge = new FixedJudge({
      judgeModel: 'judge-model',
      promotionModel: 'judge-model',
      generateText: async () => APPROVED_JSON,
    });
    const { engine } = await directEngine({ judge });

    const result = await forgeDirect(engine);
    expect(judge.calls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe('override says no');

    const trace = traceOf(result);
    expect(trace).toBeDefined();
    expect(trace!.judgeDetail).toBeNull();
    expect(trace!.stage).toBe('judge_rejected');
    expect(trace!.reason).toBe('override says no');
    // AgentOS cannot know what an override asked: the verdict's author names no provider or model.
    expect(trace!.provenance.verdict).toMatchObject({ provider: null, model: null, modelSource: null });
  });

  it("the class's own judge keeps the detail the verdict drops", async () => {
    const reply = JSON.stringify({
      safety: { passed: false, concerns: ['Reads the clock.'] },
      correctness: { passed: true, failedTests: [2] },
      determinism: { likely: false, reasoning: 'Uses Date.' },
      bounded: { likely: true, reasoning: 'One loop.' },
      confidence: 0.4,
      approved: true,
      reasoning: 'Mixed.',
    });
    const { engine } = await directEngine({ judgeReplies: [reply] });

    const result = await forgeDirect(engine);
    expect(result.success).toBe(false);

    const trace = traceOf(result);
    expect(trace).toBeDefined();
    expect(trace!.stage).toBe('judge_rejected');
    // The verdict rejects on safety and scores determinism 0.5; the detail keeps what the reply said.
    expect(trace!.verdict).toMatchObject({ approved: false, determinism: 0.5 });
    expect(trace!.judgeDetail).toEqual({
      judgeModel: 'judge-model',
      replyParsed: true,
      judgeError: null,
      judgeApproved: true,
      safetyPassed: false,
      safetyConcerns: ['Reads the clock.'],
      correctnessPassed: true,
      failedTests: [2],
      deterministic: false,
      determinismReasoning: 'Uses Date.',
      bounded: true,
      boundedReasoning: 'One loop.',
    });
  });

  it('a judge whose call fails or whose reply does not parse names the category', async () => {
    const failing = await directEngine({ judgeReplies: [new Error('provider down')] });
    const failed = traceOf(await forgeDirect(failing.engine));
    expect(failed).toBeDefined();
    expect(failed!.verdict.reasoning).toBe('LLM call failed during creation review.');
    expect(failed!.judgeDetail).toEqual(noReplyDetail('llm_call_failed'));
    // The provider's error text is kept nowhere in the trace.
    expect(JSON.stringify(failed)).not.toContain('provider down');

    const garbled = await directEngine({ judgeReplies: ['not json'] });
    const unparsed = traceOf(await forgeDirect(garbled.engine));
    expect(unparsed).toBeDefined();
    expect(unparsed!.judgeDetail).toEqual(noReplyDetail('reply_unparsable'));
  });

  // The executor record, read from forges on engines with no hook: the trace is built and returned all the same.

  it('the executor record: in-process, quickjs-wasm, and none for a composition', async () => {
    const inProcess = await directEngine();
    const inProcessResult = await forgeDirect(inProcess.engine);
    expect(inProcessResult.success).toBe(true);
    expect(traceOf(inProcessResult)).toBeDefined();
    expect(traceOf(inProcessResult)!.executor).toEqual(IN_PROCESS);

    const quickjs = await directEngine({ config: { executor: await QuickJSExecutor.create() } });
    const quickjsResult = await forgeDirect(quickjs.engine);
    expect(quickjsResult.success).toBe(true);
    expect(traceOf(quickjsResult)).toBeDefined();
    expect(traceOf(quickjsResult)!.executor).toEqual({ name: 'quickjs-wasm', isolates: true });

    const composed = await directEngine({ hostTools: [echoTool('echo')] });
    const composedResult = await composed.engine.forge(echoComposition() as unknown as ForgeToolRequest, directContext());
    expect(composedResult.success).toBe(true);
    expect(traceOf(composedResult)).toBeDefined();
    expect(traceOf(composedResult)!.executor).toBeNull();

    // Refused before an executor was chosen.
    const refused = await directEngine();
    const refusedResult = await forgeDirect(refused.engine, {
      implementation: { mode: 'sandbox', code: 'function execute(input) { return eval("1"); }', allowlist: [] },
    });
    expect(refusedResult.error).toMatch(/^Code validation failed: /);
    expect(traceOf(refusedResult)).toBeDefined();
    expect(traceOf(refusedResult)!.executor).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// What the model reads and what a host streams
// ----------------------------------------------------------------------------

/** The names only a trace carries: none may reach what the model reads, a host's stream or a capture's own fields. */
const TRACE_NAMES = ['traceVersion', 'forgeId', 'provenanceVersion'];

/** What the GMI's tool message begins with when the call failed. */
const TOOL_ERROR_PREFIX = "Error from tool 'forge_tool': ";

/** The details of a failed call, as far as the pins read them. */
type FailedCallDetails = {
  details?: { stack?: unknown; errorDetailsFromGMIError?: { underlyingError?: { stack?: unknown } } };
};

/** A thrown forge's details hold two stack texts; the pins compare the details without them. */
function expectThrownStacks(errorDetails: unknown): void {
  const details = (errorDetails as FailedCallDetails | null)?.details;
  expect(typeof details?.stack).toBe('string');
  expect(typeof details?.errorDetailsFromGMIError?.underlyingError?.stack).toBe('string');
}

/**
 * One GMI turn over a real orchestrator in which the model calls forge_tool with the outcome's arguments and then
 * answers in text. Returns the content of the `tool` message the second model call received and the content of the
 * TOOL_RESULT chunk the turn yielded.
 */
async function forgeTurn(outcome: PinOutcome): Promise<{ toolMessage: unknown; toolResult: unknown }> {
  const host = await makeForgeHost();
  host.judge.mockResolvedValueOnce(pinJudgeReply(outcome));
  if (outcome === 'thrown') {
    failNextRegistration();
  }
  const scripted = scriptedProvider([
    toolCallReply([{ id: 'call_forge', name: 'forge_tool', args: pinArgs(outcome) }]),
    textReply('Done.'),
  ]);
  const { gmi } = await createScriptedGmi({
    provider: scripted.provider,
    config: { toolOrchestrator: host.orchestrator },
  });

  const { chunks } = await runTurn(gmi, textTurn('t1', 'Forge it.'));

  expect(scripted.received).toHaveLength(2);
  const toolMessages = scripted.received[1].filter((message) => message.role === 'tool');
  expect(toolMessages).toHaveLength(1);
  const toolResults = chunks.filter((chunk) => chunk.type === GMIOutputChunkType.TOOL_RESULT);
  expect(toolResults).toHaveLength(1);
  return { toolMessage: toolMessages[0].content, toolResult: toolResults[0].content };
}

/** The tool message as its pin holds it: whole, and for a thrown forge with the two stack texts out of its JSON. */
function comparableToolMessage(content: string, outcome: PinOutcome): string {
  if (outcome !== 'thrown') {
    return content;
  }
  expect(content.startsWith(TOOL_ERROR_PREFIX)).toBe(true);
  const errorDetails: unknown = JSON.parse(content.slice(TOOL_ERROR_PREFIX.length));
  expectThrownStacks(errorDetails);
  return TOOL_ERROR_PREFIX + JSON.stringify(withoutThrownStacks(errorDetails));
}

/** The TOOL_RESULT chunk's content as its pin holds it: as yielded, and for a thrown forge its JSON without the two stack texts. */
function comparableToolResult(content: unknown, outcome: PinOutcome): unknown {
  if (outcome !== 'thrown') {
    return content;
  }
  const copy = JSON.parse(JSON.stringify(content)) as { errorDetails?: unknown };
  expectThrownStacks(copy.errorDetails);
  return { ...copy, errorDetails: withoutThrownStacks(copy.errorDetails) };
}

describe('forge trace: what the model reads and what a host streams are unchanged', () => {
  let releaseClock: () => void = () => undefined;

  beforeEach(() => {
    releaseClock = freezeClock();
  });

  afterEach(() => {
    releaseClock();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each(PIN_OUTCOMES)("pin 1: the GMI's tool message is unchanged (%s)", async (outcome) => {
    const { toolMessage } = await forgeTurn(outcome);

    expect(typeof toolMessage).toBe('string');
    const content = toolMessage as string;
    expect(comparableToolMessage(content, outcome)).toBe(PINS.gmiToolMessage[outcome]);
    for (const name of TRACE_NAMES) {
      expect(content).not.toContain(name);
    }
  });

  it.each(PIN_OUTCOMES)("pin 2: the GMI's TOOL_RESULT chunk is unchanged (%s)", async (outcome) => {
    const { toolResult } = await forgeTurn(outcome);

    expect(comparableToolResult(toolResult, outcome)).toEqual(PINS.gmiToolResultChunk[outcome]);
    const json = JSON.stringify(toolResult);
    for (const name of TRACE_NAMES) {
      expect(json).not.toContain(name);
    }
  });

  it.each(PIN_OUTCOMES)('pin 3: CapturedForge.output is unchanged (%s)', async (outcome) => {
    const h = await directEngine({ judgeReplies: [pinJudgeReply(outcome)] });
    if (outcome === 'thrown') {
      failNextRegistration();
    }
    const captures: CapturedForge[] = [];
    const wrapped = departmentWrapper(h.forgeTool, captures);

    await wrapped.execute(pinArgs(outcome), toolContext());

    expect(captures).toHaveLength(1);
    expect(captures[0].output).toEqual(PINS.captureOutput[outcome]);
    // The capture's own fields, apart from the trace it carries.
    const ownFields: Record<string, unknown> = { ...captures[0] };
    delete ownFields.trace;
    const json = JSON.stringify(ownFields);
    for (const name of TRACE_NAMES) {
      expect(json).not.toContain(name);
    }
  });

  it("pin 4: forge_tool's input schema gains only justification", async () => {
    const { engine } = await directEngine();
    const schema = new ForgeToolMetaTool(engine).inputSchema;

    // The property is its description alone: it names no type, so it takes any JSON value.
    expect(schema).toEqual({
      ...FD17F220_SCHEMA,
      properties: {
        ...FD17F220_SCHEMA.properties,
        justification: {
          description:
            'Optional: What gap this tool fills that no tool you already have covers, in one to three sentences.',
        },
      },
    });
    expect(schema.required).toEqual(FD17F220_SCHEMA.required);
    const names = Object.keys(schema.properties);
    expect(names[names.length - 1]).toBe('justification');
  });

  it("pin 5: the judge's prompt is unchanged for an output JSON can write", async () => {
    const h = await directEngine({ hostTools: [richOutputTool()] });
    // The request carries a justification, which the judge never reads: the prompt is the pinned one all the same.
    const args = { ...judgePromptArgs(), justification: 'JUSTIFICATION-MARKER: no tool reads rich_output yet.' };

    await h.engine.forge(args as unknown as ForgeToolRequest, directContext());

    expect(h.generateText).toHaveBeenCalledTimes(1);
    expect(h.generateText.mock.calls[0]).toEqual(PINS.judgePrompt);
    expect(String(h.generateText.mock.calls[0][1])).not.toContain('JUSTIFICATION-MARKER');
  });
});

/** The persona the full runtime's model answers as. */
const FORGER = {
  id: 'forger',
  name: 'Forger',
  description: 'Forges the tools a task needs.',
  version: '1.0.0',
  baseSystemPrompt: 'You forge the tools a task needs.',
} as unknown as IPersonaDefinition;

/** The full runtime that is running, shut down after each test. */
let runtime: AgentOS | undefined;

/**
 * The full runtime with forging on, its one provider the stubbed OpenAI class, and the host's trace hook, with `extra`
 * merged into its config last.
 */
async function bootRuntime(onForgeTrace: (trace: unknown) => void, extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: {
      providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }],
    },
    turnPlanning: { enabled: false },
    personas: [FORGER],
    emergent: true,
    emergentConfig: { allowSandboxTools: true },
    onForgeTrace,
    ...extra,
  } as any);
}

/** A model step on the full runtime that calls forge_tool with `args`; `final` is merged into its final chunk. */
function forgeToolStep(args: Record<string, unknown>, final: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return [
    {
      ...final,
      isFinal: true,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call-forge', type: 'function', function: { name: 'forge_tool', arguments: JSON.stringify(args) } },
            ],
          },
          finishReason: 'tool_calls',
        },
      ],
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    },
  ];
}

/**
 * One turn on the full runtime whose model calls forge_tool with `args` and then answers text; every chunk it streamed.
 * `final` is merged into the forge step's final chunk.
 */
async function forgeThroughRuntime(
  os: AgentOS,
  args: Record<string, unknown>,
  final: Record<string, unknown> = {},
): Promise<unknown[]> {
  runtimeModel.replies.push(forgeToolStep(args, final));
  const input: AgentOSInput = {
    userId: 'user-1',
    sessionId: 'session-1',
    textInput: 'Forge it.',
    selectedPersonaId: FORGER.id,
  };
  const chunks: unknown[] = [];
  for await (const chunk of os.processRequest(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

/** JSON text of `value` that a cycle or a BigInt cannot stop: a repeated object is written once. */
function serialized(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') {
      return item.toString();
    }
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) {
        return '[seen]';
      }
      seen.add(item);
    }
    return item;
  });
}

/** Shuts down the full runtime a test started, and clears what its model was scripted to answer. */
async function resetRuntime(): Promise<void> {
  if (runtime) {
    await runtime.shutdown();
  }
  runtime = undefined;
  runtimeModel.replies.length = 0;
  runtimeModel.judgeReply = '';
  runtimeModel.judgeCalls = 0;
}

/** A host tool that records the context of every call it is given. */
function contextRecorder(contexts: ToolExecutionContext[]): ITool {
  return {
    id: 'record-context-v1',
    name: 'record_context',
    displayName: 'Record context',
    description: 'Records the context it is called with.',
    inputSchema: { type: 'object', properties: {} },
    hasSideEffects: false,
    execute: async (_args: Record<string, unknown>, context: ToolExecutionContext) => {
      contexts.push(context);
      return { success: true, output: { ok: true } };
    },
  };
}

/** A call of `record_context`, with the request's facts and nothing else. */
function recordContextCall(id: string): ToolExecutionRequestDetails {
  return {
    toolCallRequest: { id, name: 'record_context', arguments: {} },
    gmiId: 'gmi-1',
    personaId: 'persona-1',
    personaCapabilities: [],
    userContext: { userId: 'user-1' } as UserContext,
  };
}

describe('forge trace: the full runtime and the answering model', () => {
  afterEach(async () => {
    await resetRuntime();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('the full runtime: the hook receives the forge with the answering model, and the runtime stream carries no trace', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(onForgeTrace);

    const chunks = await forgeThroughRuntime(runtime, sandboxArgs());
    // The forge reached its judge, which the full runtime calls through its default provider.
    expect(runtimeModel.judgeCalls).toBe(1);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.outcome).toBe('approved');
    expect(trace.recordedBy).toBe('engine');
    expect(trace.via).toBe('forge_tool');
    expect(trace.forgeId).toMatch(FORGE_ID);
    // The request's author is the model that answered the step, as its final chunk names it.
    expect(trace.provenance.request).toMatchObject({
      kind: 'model',
      role: 'forging_agent',
      aiGenerated: true,
      provider: 'openai',
      model: 'stream-model-7',
      modelSource: 'answered',
    });
    // The judge's author is the model the judge asked for, on the provider the runtime calls it through.
    expect(trace.provenance.verdict).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', modelSource: 'requested' });

    const json = serialized(chunks);
    for (const name of TRACE_NAMES) {
      expect(json).not.toContain(name);
    }
  });

  it('the GMI puts the answering model on its tool call', async () => {
    const scripted = scriptedProvider([toolCallReply([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]), textReply('Done.')]);
    const { gmi, processToolCall } = await createScriptedGmi({ provider: scripted.provider });

    await runTurn(gmi, textTurn('t1', 'Look it up.'));

    expect(processToolCall).toHaveBeenCalledTimes(1);
    // The step's final chunk names the model that answered it.
    expect((processToolCall.mock.calls[0][0] as { callerModel?: unknown }).callerModel).toEqual({
      providerId: 'scripted',
      modelId: 'scripted-model',
      modelSource: 'answered',
    });
  });

  it("ToolExecutor copies callerModel into the tool's context", async () => {
    const contexts: ToolExecutionContext[] = [];
    const tools = new ToolExecutor(undefined, undefined, undefined, { builtInTools: false });
    await tools.registerTool(contextRecorder(contexts));

    const withModel = await tools.executeTool({
      ...recordContextCall('c1'),
      callerModel: { providerId: 'p', modelId: 'm' },
    } as ToolExecutionRequestDetails);
    const withoutModel = await tools.executeTool(recordContextCall('c2'));
    expect(withModel.success).toBe(true);
    expect(withoutModel.success).toBe(true);

    expect(contexts).toHaveLength(2);
    expect((contexts[0] as { callerModel?: unknown }).callerModel).toEqual({ providerId: 'p', modelId: 'm' });
    // A call that names no model gives the tool a context without the key.
    expect(Object.prototype.hasOwnProperty.call(contexts[1], 'callerModel')).toBe(false);
  });

  it("an executor pipeline error's tool result names no callerModel", async () => {
    const host = await makeForgeHost();
    vi.spyOn(host.executor, 'executeTool').mockRejectedValueOnce(new Error('pipeline down'));

    const result = await host.orchestrator.processToolCall({
      toolCallRequest: { id: 'c1', name: 'forge_tool', arguments: sandboxArgs() },
      gmiId: 'gmi-1',
      personaId: 'persona-1',
      personaCapabilities: [],
      userContext: { userId: 'user-1' },
      callerModel: { providerId: 'p', modelId: 'm' },
    } as unknown as ToolExecutionRequestDetails);

    expect(host.executor.executeTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.errorDetails.message).toMatch(/internal pipeline/);
    // The details reach the model's tool message, so they carry the request's facts without the answering model.
    expect(JSON.stringify(result.errorDetails)).not.toContain('callerModel');
  });
});

/** A marker string a forge carries in its code, its test values and its reason: no log line may hold it. */
const MARKER = 'MARKER-7d1e';

/** The code forge of `sandboxArgs` with the marker in its code and in its test case's input. */
function markedArgs(): Record<string, unknown> {
  return sandboxArgs({
    implementation: {
      mode: 'sandbox',
      code: `function execute(input) { const m = '${MARKER}'; return { sum: input.a + input.b }; }`,
      allowlist: [],
    },
    testCases: [{ input: { a: 2, b: 3, note: MARKER }, expectedOutput: { sum: 5 } }],
  });
}

/** The judge's rejection, its reasoning and its one concern quoting the marker. */
const MARKED_REJECTION = JSON.stringify({
  ...(JSON.parse(REJECTED_JSON) as Record<string, unknown>),
  safety: { passed: false, concerns: [`The code quotes ${MARKER}.`] },
  reasoning: `Rejected: the code quotes ${MARKER}.`,
});

/** Every printed line and every captured event that holds `text`: a printed line by its text, an event by its name. */
function linesHolding(capture: ReturnType<typeof captureLines>, text: string): string[] {
  const printed = capture
    .printed()
    .split('\n')
    .filter((line) => line.includes(text))
    .map((line) => line.slice(0, 240));
  const events = capture.lines
    .filter((line) => JSON.stringify(line).includes(text))
    .map((line) => `event ${String(line.event)}`);
  return [...printed, ...events];
}

/** The log line's own fields: the line without its level, time, event name and bound context. */
function eventFields(line: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...line };
  for (const key of ['level', 'time', 'event', ...Object.keys(AGENTOS_CONTEXT)]) {
    delete fields[key];
  }
  return fields;
}

/** The stage codes a forge can end at, in the order of the stage table. */
const FORGE_STAGE_CODES = [
  'guardrail_refused',
  'schema_check',
  'refused_before_approval',
  'shape_check',
  'host_refused',
  'orchestrator_refused',
  'permission_check_failed',
  'human_denied',
  'approval_timed_out',
  'approval_failed',
  'self_change_refused',
  'name_refused',
  'description_missing',
  'engine_disabled',
  'compose_refused',
  'compose_needs_step_output',
  'caller_context_required',
  'sandbox_disabled',
  'allowlist_unknown',
  'effects_need_ceiling',
  'capability_not_granted',
  'code_validation',
  'executor_unavailable',
  'test_responses_refused',
  'judge_rejected',
  'test_output_unserializable',
  'compose_refused_after_judge',
  'step_cycle',
  'removed_while_forging',
  'activation_failed',
  'registration_failed',
  'approved',
  'thrown',
];

/** The fields of `emergent.forge_done` and their kinds: an integer, or one of a list of words. */
const FORGE_DONE_KINDS: Record<string, 'int' | readonly string[]> = {
  outcome: ['approved', 'rejected', 'refused', 'failed'],
  stage: FORGE_STAGE_CODES,
  recordedBy: ['engine', 'forge_tool', 'wrapper', 'orchestrator'],
  via: ['forge_tool', 'direct'],
  mode: ['sandbox', 'compose', 'none'],
  tests: 'int',
  testsPassed: 'int',
  testsOmitted: 'int',
  codeBytes: 'int',
  traceBytes: 'int',
  cutFields: 'int',
  justificationChars: 'int',
  judgeRan: ['yes', 'no'],
  executorIsolates: ['yes', 'no', 'none'],
  durationMs: 'int',
};

/** One way an orchestrator ends a call to its own forge_tool with the marker in its reason. */
interface QuietRefusal {
  label: string;
  stage: string;
  /** The host's options beside the hook. */
  host?: () => Omit<ForgeHostOptions, 'onForgeTrace'>;
  /** What the host's managers and executor do before the call. */
  before?: (host: ForgeHost) => void;
}

const QUIET_REFUSALS: QuietRefusal[] = [
  {
    label: 'permission refused',
    stage: 'orchestrator_refused',
    before: (host) => {
      host.permissionManager.isExecutionAllowed.mockResolvedValueOnce({ isAllowed: false, reason: MARKER });
    },
  },
  {
    label: 'permission check threw',
    stage: 'permission_check_failed',
    before: (host) => {
      host.permissionManager.isExecutionAllowed.mockRejectedValueOnce(new Error(MARKER));
    },
  },
  {
    label: 'approval failed',
    stage: 'approval_failed',
    host: () => ({
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: scriptedHitl(async () => {
        throw new Error(MARKER);
      }).manager,
    }),
  },
  {
    label: 'executor pipeline threw',
    stage: 'thrown',
    before: (host) => {
      vi.spyOn(host.executor, 'executeTool').mockRejectedValueOnce(new Error(MARKER));
    },
  },
];

describe('forge trace: no content in any log line', () => {
  afterEach(async () => {
    await resetRuntime();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('no trace content in any log line through ToolExecutor with logToolCalls off', async () => {
    const capture = captureLines();
    try {
      const { onForgeTrace } = hookRecorder();
      const host = await makeForgeHost({ onForgeTrace });
      host.judge.mockResolvedValueOnce(MARKED_REJECTION);

      const result = await callTool(host.orchestrator, 'forge_tool', markedArgs(), CALLER);
      expect(result.isError).toBe(true);
      // The model reads the judge's reason in the tool result, as before.
      expect(result.errorDetails.message).toContain(MARKER);

      expect(linesHolding(capture, MARKER)).toEqual([]);
      const done = eventLines(capture.lines, 'emergent.forge_done');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ outcome: 'rejected', stage: 'judge_rejected' });
    } finally {
      capture.restore();
    }
  });

  it('no trace content in any log line through the full runtime', async () => {
    const capture = captureLines();
    try {
      const { onForgeTrace } = hookRecorder();
      runtimeModel.judgeReply = MARKED_REJECTION;
      runtime = await bootRuntime(onForgeTrace);

      await forgeThroughRuntime(runtime, markedArgs());
      expect(runtimeModel.judgeCalls).toBe(1);

      expect(linesHolding(capture, MARKER)).toEqual([]);
      const done = eventLines(capture.lines, 'emergent.forge_done');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ outcome: 'rejected', stage: 'judge_rejected' });
    } finally {
      capture.restore();
    }
  });

  it('no reason text in the quiet lines of a thrown forge', async () => {
    const capture = captureLines();
    try {
      const { onForgeTrace } = hookRecorder();
      const host = await makeForgeHost({ onForgeTrace });
      vi.spyOn(EmergentToolRegistry.prototype, 'register').mockImplementationOnce(() => {
        throw new Error(MARKER);
      });

      const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
      expect(result.isError).toBe(true);

      expect(linesHolding(capture, MARKER)).toEqual([]);
      const done = eventLines(capture.lines, 'emergent.forge_done');
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ outcome: 'failed', stage: 'thrown' });
    } finally {
      capture.restore();
    }
  });

  it('no reason text in the quiet lines of a human denial', async () => {
    const capture = captureLines();
    try {
      const { onForgeTrace, traces } = hookRecorder();
      const hitl = scriptedHitl(async (action) => decision(action, false, MARKER));
      const host = await makeForgeHost({
        onForgeTrace,
        orchestratorConfig: { hitl: { enabled: true } },
        hitlManager: hitl.manager,
      });

      const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
      expect(result.isError).toBe(true);
      expect(result.errorDetails.message).toBe(MARKER);

      expect(linesHolding(capture, MARKER)).toEqual([]);
      expect(traces).toHaveLength(1);
      expect(traces[0].stage).toBe('human_denied');
      expect(traces[0].reason).toBe(MARKER);
    } finally {
      capture.restore();
    }
  });

  it.each(QUIET_REFUSALS.map((row): [string, QuietRefusal] => [row.label, row]))(
    'no reason text in the quiet lines of an orchestrator refusal (%s)',
    async (_label, row) => {
      const capture = captureLines();
      try {
        const { onForgeTrace, traces } = hookRecorder();
        const host = await makeForgeHost({ ...(row.host?.() ?? {}), onForgeTrace });
        row.before?.(host);

        const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
        expect(result.isError).toBe(true);

        expect(linesHolding(capture, MARKER)).toEqual([]);
        // The reason stays in the trace, which the host reads.
        expect(traces).toHaveLength(1);
        expect(traces[0].stage).toBe(row.stage);
        expect(traces[0].recordedBy).toBe('orchestrator');
        expect(String(traces[0].reason)).toContain(MARKER);
      } finally {
        capture.restore();
      }
    },
  );

  it("every new event's fields pass the catalogue's checks", async () => {
    const capture = captureLines();
    try {
      const { onForgeTrace, traces } = hookRecorder();
      const { engine } = await directEngine({ onForgeTrace });

      const approved = await forgeDirect(engine);
      expect(approved.success).toBe(true);
      // A stage code of 22 characters: a word field takes no run of 20 or more letters, digits and underscores.
      const refused = await forgeDirect(engine, {
        name: 'add_with_answers',
        testCases: [
          { input: { a: 2, b: 3 }, expectedOutput: { sum: 5 }, responses: [{ method: 'POST', url: 'items', status: 201 }] },
        ],
      });
      expect(refused.error).toMatch(/^invalid_test_responses: /);
      expect(valid('word', 'test_responses_refused', 'stage')).toBe(false);

      const done = eventLines(capture.lines, 'emergent.forge_done');
      expect(done).toHaveLength(2);
      expect(traces).toHaveLength(2);

      // The catalogue declares the event with exactly these fields, each of its kind.
      const declared = (AGENTOS_EVENTS as EventMap)['emergent.forge_done'];
      expect(declared).toBeDefined();
      expect(Object.keys(declared).sort()).toEqual(Object.keys(FORGE_DONE_KINDS).sort());
      for (const [key, kind] of Object.entries(FORGE_DONE_KINDS)) {
        if (kind === 'int') {
          expect(declared[key]).toBe('int');
        } else {
          expect([...(declared[key] as { enum: readonly string[] }).enum].sort()).toEqual([...kind].sort());
        }
      }

      for (const line of done) {
        expect(line).toHaveProperty('level');
        expect(line).toHaveProperty('time');
        expect(line.component).toBe('emergent');
        expect(line.event).toBe('emergent.forge_done');
        // Both forges carry a request, so both lines carry codeBytes.
        const fields = eventFields(line);
        expect(Object.keys(fields).sort()).toEqual(Object.keys(FORGE_DONE_KINDS).sort());
        for (const [key, value] of Object.entries(fields)) {
          const kind = FORGE_DONE_KINDS[key];
          if (kind === 'int') {
            expect(Number.isInteger(value)).toBe(true);
          } else {
            expect(kind).toContain(value);
          }
          expect(valid(declared[key], value, key)).toBe(true);
        }
      }

      // Info for an approved forge, warn for the rest; the figures are the trace's own.
      expect(done[0]).toMatchObject({
        level: 30,
        outcome: 'approved',
        stage: 'approved',
        recordedBy: 'engine',
        via: 'direct',
        mode: 'sandbox',
        tests: 1,
        testsPassed: 1,
        testsOmitted: 0,
        codeBytes: Buffer.byteLength(ADD_CODE),
        traceBytes: traces[0].sizes.traceBytes,
        cutFields: 0,
        justificationChars: 0,
        judgeRan: 'yes',
        executorIsolates: 'no',
      });
      expect(done[1]).toMatchObject({
        level: 40,
        outcome: 'refused',
        stage: 'test_responses_refused',
        recordedBy: 'engine',
        via: 'direct',
        mode: 'sandbox',
        tests: 1,
        testsPassed: 0,
        testsOmitted: 0,
        codeBytes: Buffer.byteLength(ADD_CODE),
        traceBytes: traces[1].sizes.traceBytes,
        cutFields: 0,
        justificationChars: 0,
        judgeRan: 'no',
        executorIsolates: 'no',
      });
    } finally {
      capture.restore();
    }
  });
});

// ----------------------------------------------------------------------------
// The caps
// ----------------------------------------------------------------------------

const KIB = 1024;

/** What a trace holds each field to: the bytes of the field's own JSON, or the entries it keeps of a list. */
const CAPS = {
  code: 64 * KIB,
  description: 2 * KIB,
  schema: 8 * KIB,
  testField: 2 * KIB,
  testOutput: 4 * KIB,
  testEffects: 2 * KIB,
  judgeText: KIB,
  judgeConcerns: 16,
  failedTests: 64,
  verdictReasoning: 16 * KIB,
  name: 256,
  allowlistEntries: 64,
  justification: 2 * KIB,
  tests: 16,
  total: 512 * KIB,
};

/** The UTF-8 length of `value`'s JSON text. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * `value` is a cut: the marker that stands for a text or a value over its cap, with the whole length and the start
 * kept, its own JSON within `capBytes`. `wholeBytes`, when given, is the UTF-8 length of the whole text.
 */
function expectCut(value: unknown, capBytes: number, wholeBytes?: number): void {
  expect(value).toMatchObject({ $trace: 'cut' });
  const cut = value as { bytes: unknown; head: unknown };
  expect(typeof cut.head).toBe('string');
  expect(typeof cut.bytes).toBe('number');
  expect(jsonBytes(value)).toBeLessThanOrEqual(capBytes);
  if (wholeBytes !== undefined) {
    expect(cut.bytes).toBe(wholeBytes);
  }
}

/** A host tool with no side effects whose output JSON cannot write: it holds a BigInt and itself. */
function oddOutputTool(): ITool {
  return {
    id: 'odd-output-v1',
    name: 'odd_output',
    displayName: 'Odd output',
    description: 'Returns an output that holds a BigInt and itself.',
    inputSchema: { type: 'object', properties: {} },
    hasSideEffects: false,
    execute: async () => {
      const output: Record<string, unknown> = { big: 10n };
      output.self = output;
      return { success: true, output };
    },
  };
}

describe('forge trace: the caps', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('caps: every field over its cap is cut, its path listed, and the trace stays under 512 KiB', async () => {
    // The code returns 5,000 characters and ends with a comment line of quotes, backslashes and control characters,
    // each of which JSON writes as an escape. The newline after the comment lets the code parse inside the function
    // that runs it.
    const code =
      'function execute(input) { return { v: "' + 'z'.repeat(5000) + '" }; }\n// ' + '"\\\u0001'.repeat(30000) + '\n';
    const f1 = sandboxArgs();
    const args = {
      name: 'big_tool',
      description: 'd'.repeat(5 * KIB),
      inputSchema: { ...(f1.inputSchema as Record<string, unknown>), description: 's'.repeat(20 * KIB) },
      outputSchema: { ...(f1.outputSchema as Record<string, unknown>), description: 's'.repeat(20 * KIB) },
      implementation: { mode: 'sandbox', code, allowlist: Array<string>(200).fill('crypto') },
      justification: 'j'.repeat(5 * KIB),
      testCases: Array.from({ length: 20 }, (_, i) => ({
        input: { a: i, b: 1, pad: 'i'.repeat(3 * KIB) },
        expectedOutput: { v: 'e'.repeat(3 * KIB) },
        responses: [{ method: 'POST', url: 'https://example.com/x', status: 201, body: 'y'.repeat(3000) }],
      })),
    };
    const reasoning = 'x'.repeat(614400);
    const rejection = JSON.stringify({
      safety: { passed: false, concerns: Array.from({ length: 20 }, (_, i) => `concern ${i} ` + 'c'.repeat(2 * KIB)) },
      correctness: { passed: false, failedTests: Array.from({ length: 100 }, (_, i) => i + 1) },
      determinism: { likely: false, reasoning: 'n'.repeat(2 * KIB) },
      bounded: { likely: true, reasoning: 'Bounded.' },
      confidence: 0.2,
      approved: false,
      reasoning,
    });
    const { engine } = await directEngine({ judgeReplies: [rejection] });

    const result = await engine.forge(args as unknown as ForgeToolRequest, directContext());

    // The model's view is unchanged: the result keeps the judge's reasoning whole.
    expect(result.success).toBe(false);
    expect(result.verdict?.reasoning).toHaveLength(614400);
    expect(result.error === reasoning).toBe(true);

    const trace = traceOf(result);
    expect(trace).toBeDefined();
    expect(trace!.stage).toBe('judge_rejected');
    expect(trace!.outcome).toBe('rejected');

    // The first 16 test cases are kept, in order. Each ran (the code parsed and returned), and each of its values is cut.
    expect(trace!.tests).toHaveLength(CAPS.tests);
    expect(trace!.sizes.testsOmitted).toBe(4);
    for (const [index, test] of trace!.tests.entries()) {
      expect(test.index).toBe(index);
      expect(test.ran).toBe(true);
      expect(test.result.success).toBe(true);
      expectCut(test.input, CAPS.testField);
      expectCut(test.expectedOutput, CAPS.testField);
      expectCut(test.responses, CAPS.testField);
      expectCut(test.result.output, CAPS.testOutput);
    }

    // The request: its code, description and schemas are cut, and its allowlist keeps 64 entries.
    expectCut(trace!.request.implementation.code, CAPS.code, Buffer.byteLength(code));
    expectCut(trace!.request.description, CAPS.description, 5 * KIB);
    expectCut(trace!.request.inputSchema, CAPS.schema);
    expectCut(trace!.request.outputSchema, CAPS.schema);
    expect(trace!.request.implementation.allowlist).toEqual(Array<string>(CAPS.allowlistEntries).fill('crypto'));
    expectCut(trace!.justification, CAPS.justification, 5 * KIB);

    // The judge: its reasoning is cut, and its detail keeps the first 16 concerns, each cut, and the first 64 numbers.
    expectCut(trace!.verdict.reasoning, CAPS.verdictReasoning, 614400);
    const concerns = trace!.judgeDetail.safetyConcerns as Array<{ head: string }>;
    expect(concerns).toHaveLength(CAPS.judgeConcerns);
    for (const [index, concern] of concerns.entries()) {
      expectCut(concern, CAPS.judgeText);
      expect(concern.head.startsWith(`concern ${index} `)).toBe(true);
    }
    expect(trace!.judgeDetail.failedTests).toEqual(Array.from({ length: CAPS.failedTests }, (_, i) => i + 1));
    expectCut(trace!.judgeDetail.determinismReasoning, CAPS.judgeText, 2 * KIB);

    expect(trace!.sizes.cut).toEqual(
      expect.arrayContaining([
        'request.implementation.code',
        'request.description',
        'request.inputSchema',
        'request.outputSchema',
        'request.implementation.allowlist',
        'justification',
        'verdict.reasoning',
        'judgeDetail.safetyConcerns',
        'judgeDetail.safetyConcerns[0]',
        'judgeDetail.failedTests',
        'judgeDetail.determinismReasoning',
        'tests[0].input',
        'tests[0].expectedOutput',
        'tests[0].responses',
        'tests[0].result.output',
      ]),
    );

    // The whole trace: its own figure is its JSON's length, under the total.
    const traceBytes = jsonBytes(trace);
    expect(traceBytes).toBe(trace!.sizes.traceBytes);
    expect(traceBytes).toBeLessThan(CAPS.total);
  });

  it('caps: a 1 MiB name is refused by the name rule and cut to 256 bytes', async () => {
    const name = 'a'.repeat(1048576);
    const { engine } = await directEngine();

    const result = await forgeDirect(engine, { name });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ refused: a tool name is at most \d+ bytes in UTF-8$/);

    const trace = traceOf(result);
    expect(trace).toBeDefined();
    expect(trace!.stage).toBe('name_refused');
    expect(trace!.outcome).toBe('refused');
    expectCut(trace!.toolName, CAPS.name, 1048576);
    expectCut(trace!.request.name, CAPS.name, 1048576);
    expect(trace!.sizes.cut).toEqual(expect.arrayContaining(['toolName', 'request.name']));
  });

  it("caps: a composition's effects over 2 KiB are cut", async () => {
    const { engine } = await directEngine({
      hostTools: [sendNoteTool()],
      config: { compose: { sideEffectingTools: ['send_note'] } },
    });
    // The step has side effects, so the test does not execute it: its output is the test case's own, and the step is
    // listed as an effect with the arguments it would have run with, the 3 KiB text among them.
    const args = composeArgs([{ name: 'send', tool: 'send_note', inputMapping: { text: '$input.text' } }], {
      testCases: [
        {
          input: { text: 't'.repeat(3 * KIB) },
          expectedOutput: { text: 'sent' },
          stepOutputs: { send: { text: 'sent' } },
        },
      ],
    });

    const result = await engine.forge(args as unknown as ForgeToolRequest, directContext());
    expect(result.success).toBe(true);

    const trace = traceOf(result);
    expect(trace).toBeDefined();
    expect(trace!.tests).toHaveLength(1);
    expect(trace!.tests[0].ran).toBe(true);
    expectCut(trace!.tests[0].result.effects, CAPS.testEffects);
    expect(trace!.sizes.cut).toContain('tests[0].result.effects');
  });

  it('caps: a BigInt and a cycle in a test output become markers', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const h = await directEngine({ hostTools: [oddOutputTool()], judgeReplies: [REJECTED_JSON], onForgeTrace });
    const args = composeArgs([{ name: 'odd', tool: 'odd_output', inputMapping: {} }]);

    // The forge is judged, so it resolves: the judge's prompt carries the output JSON cannot write as markers.
    const forging = h.engine.forge(args as unknown as ForgeToolRequest, directContext());
    await expect(forging).resolves.toMatchObject({ success: false, error: 'Tool contains unsafe patterns.' });
    const result = await forging;

    expect(h.generateText).toHaveBeenCalledTimes(1);
    const prompt = String(h.generateText.mock.calls[0][1]);
    for (const word of ['unserializable', 'bigint', 'cycle']) {
      expect(prompt).toContain(word);
    }

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(result)).toBe(trace);
    expect(trace.stage).toBe('judge_rejected');
    expect(trace.outcome).toBe('rejected');
    expect(trace.verdict).toMatchObject({ approved: false, reasoning: 'Tool contains unsafe patterns.' });
    expect(trace.tests[0].result.output).toEqual({
      big: { $trace: 'unserializable', kind: 'bigint' },
      self: { $trace: 'unserializable', kind: 'cycle' },
    });
  });
});

// ----------------------------------------------------------------------------
// The measurement
// ----------------------------------------------------------------------------

/**
 * What the measurement records: the sizes each fixed forge's trace states, and the time a hook adds to a forge. A
 * case that failed leaves its key absent.
 */
interface ForgeTraceMeasure {
  forges?: Array<{ id: string; codeBytes: number | null; traceBytes: number; tests: number }>;
  latency?: {
    runs: number;
    p95WithMs: number;
    p95WithoutMs: number;
    addedMs: number;
    byOutcome: { approved: number; judge_rejected: number; code_validation: number };
  };
}

/** A host tool with no side effects that answers every call with `output`. */
function fixedOutputTool(name: string, argument: string, output: Record<string, unknown>): ITool {
  return {
    id: `${name}-v1`,
    name,
    displayName: name,
    description: `Answers every ${argument} with one fixed output.`,
    inputSchema: { type: 'object', properties: { [argument]: { type: 'string' } }, required: [argument] },
    hasSideEffects: false,
    execute: async () => ({ success: true, output }),
  };
}

/** F2: a composition of two steps, a search and a summary of the snippet it finds, with one test case. */
function searchAndSummariseArgs(): Record<string, unknown> {
  return composeArgs(
    [
      { name: 'search', tool: 'web_search', inputMapping: { q: '$input.query' } },
      { name: 'summarise', tool: 'summarise', inputMapping: { text: '$prev.snippet' } },
    ],
    {
      name: 'search_and_summarise',
      description: 'Search the web then summarise results.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      testCases: [{ input: { query: 'quantum computing' }, expectedOutput: { summary: 'A summary.' } }],
    },
  );
}

/**
 * F3's code, as the effects suite (permissions-effects.integration.test.ts) holds it, its line breaks and indentation
 * included: it writes a file, reads it back, deletes it, reads it again and posts what it read.
 */
const ROUND_TRIP = `async function execute(input) {
      await fs.writeFile(input.path, input.text);
      const back = await fs.readFile(input.path);
      await fs.unlink(input.path);
      let gone = false;
      try { await fs.readFile(input.path); } catch (e) { gone = String(e && e.message).startsWith('no_such_file'); }
      const r = await fetch(input.url, { method: 'POST', body: back });
      const answer = await r.json();
      return { back, gone, id: answer.id };
    }`;

/** Code that writes one file and returns: a forge test of it shows whether a dry run's write reaches the host. */
const WRITE_ONCE = `async function execute(input) {
      await fs.writeFile(input.path, input.text);
      return { wrote: true };
    }`;

/** The effects suite's write ceiling: new files only, under `root`, within small bounds. */
const WRITE_CEILING = (root: string): ForgedCapabilities['fs.write'] =>
  ({
    roots: [root],
    mode: 'create-only',
    maxBytesPerFile: 64,
    maxBytesPerCall: 128,
    maxFilesPerCall: 3,
    timeoutMs: 5000,
    approval: 'none',
  }) as ForgedCapabilities['fs.write'];

/**
 * F3: the effects suite's `round_trip` forge, a code forge that asks for four capabilities. Its one test case writes
 * and deletes under `root` and posts to `url`, and answers that request itself.
 */
function roundTripArgs(root: string, url: string): Record<string, unknown> {
  return {
    name: 'round_trip',
    description: 'Forged round_trip.',
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: { type: 'object', additionalProperties: true },
    implementation: { mode: 'sandbox', code: ROUND_TRIP, allowlist: ['fs.read', 'fs.write', 'fs.delete', 'fetch'] },
    testCases: [
      {
        input: { path: path.join(root, 'tmp.txt'), text: 'draft', url },
        responses: [{ method: 'POST', url, status: 201, body: '{"id":"from-test"}' }],
      },
    ],
  };
}

/**
 * G1: the worked example a host's forging guidance gives its agents, with its name, description, schemas, code and
 * three test cases. Copied from framerslab/paracosm at 1d3020d52db65c003df6cc5ccd0297bedb706146,
 * src/runtime/orchestrator/forge-guidance.ts:123-155.
 */
function radiationDoseArgs(): Record<string, unknown> {
  return {
    name: 'radiation_dose_risk_score',
    description: 'Scores cumulative radiation exposure risk on 0..100.',
    inputSchema: {
      type: 'object',
      properties: {
        cumulative_dose_msv: { type: 'number', description: 'mSv lifetime' },
        age_years: { type: 'number' },
        shielding_factor: { type: 'number', description: '0..1 reduction' },
      },
      required: ['cumulative_dose_msv', 'age_years', 'shielding_factor'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        risk_score: { type: 'number', description: '0..100, higher is worse' },
        tier: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      },
      required: ['risk_score', 'tier'],
      additionalProperties: false,
    },
    implementation: {
      mode: 'sandbox',
      code: "function execute(input){try{const d=Number.isFinite(+input.cumulative_dose_msv)?+input.cumulative_dose_msv:0;const a=Number.isFinite(+input.age_years)?+input.age_years:30;const s=Number.isFinite(+input.shielding_factor)?Math.max(0,Math.min(1,+input.shielding_factor)):0;const eff=d*(1-s);let score=Math.max(0,Math.min(100,eff/30*(1+Math.max(0,(60-a))/100)));const tier=score>=80?'critical':score>=50?'high':score>=20?'medium':'low';return{risk_score:Math.round(score),tier};}catch(e){return{risk_score:0,tier:'low'};}}",
      allowlist: [],
    },
    testCases: [
      {
        input: { cumulative_dose_msv: 1200, age_years: 42, shielding_factor: 0.3 },
        expectedOutput: { tier: 'high' },
      },
      {
        input: { cumulative_dose_msv: 0, age_years: 30, shielding_factor: 0 },
        expectedOutput: { risk_score: 0, tier: 'low' },
      },
      {
        input: { cumulative_dose_msv: 4000, age_years: 65, shielding_factor: 0 },
        expectedOutput: { tier: 'critical' },
      },
    ],
  };
}

/**
 * T2: a code forge that sums two numbers through an array method, with two test cases that name no expected output.
 * Copied from framerslab/paracosm at 1d3020d52db65c003df6cc5ccd0297bedb706146,
 * tests/runtime/forged-code-own-context.test.ts:100-112.
 */
function sumTwoArgs(): Record<string, unknown> {
  return {
    name: 'sum_two',
    description: 'Adds two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { const xs = [input.a, input.b]; return { total: xs.reduce((s, x) => s + x, 0) }; }',
      allowlist: [],
    },
    testCases: [{ input: { a: 1, b: 2 } }, { input: { a: 3, b: 4 } }],
  };
}

/** The outcomes the latency runs cycle through: approved, rejected by the judge, and refused before the judge. */
const LATENCY_OUTCOMES = ['approved', 'judge_rejected', 'code_validation'] as const;
type LatencyOutcome = (typeof LATENCY_OUTCOMES)[number];

/** Code the engine's validation refuses before the judge runs: it calls `eval`. */
const EVAL_CODE = 'function execute(input) { return eval("1"); }';

/** The 95th percentile of `samples` by nearest rank: the smallest sample that 95 percent of them do not exceed. */
function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

/** Milliseconds to the thousandth, as the measurement records them. */
function toThousandth(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

describe('forge trace: the measurement', () => {
  /** What the cases of this group measured, printed and written once they have all run. */
  const measure: ForgeTraceMeasure = {};
  const servers: http.Server[] = [];
  const roots: string[] = [];

  /** A local server that records each request and answers JSON. A forge's test never reaches it. */
  async function serve(): Promise<{ port: number; seen: Array<{ method: string; url: string; body: string }> }> {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'created-1', got: body }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  /** A temporary directory, by its real path, removed after the case. */
  function tempRoot(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'forge-trace-')));
    roots.push(root);
    return root;
  }

  /** A host as the effects suite builds its own: a ceiling, the isolating executor and a store for the effect records. */
  async function hostWith(capabilities: ForgedCapabilities): Promise<ForgeHost> {
    return makeForgeHost({
      db: createSqliteAdapter(),
      config: { capabilities, executor: await QuickJSExecutor.create(), audit: { content: 'digest' } },
    });
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      }),
    );
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The figures go to the job's log on one line, and to a file when the job names a directory for it.
  afterAll(() => {
    const report = JSON.stringify(measure);
    console.log(`FORGE_TRACE_MEASURE ${report}`);
    const directory = process.env.FORGE_TRACE_REPORT_DIR;
    if (directory) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'report.json'), report);
    }
  });

  it('measurement: the fixed forge set is cut nowhere', async () => {
    const root = tempRoot();
    const { port, seen } = await serve();

    /** Forges `args` on an engine of its own, whose judge approves. */
    const onFreshEngine = async (args: Record<string, unknown>, hostTools: ITool[] = []): Promise<ForgeResult> => {
      const { engine } = await directEngine({ hostTools });
      return engine.forge(args as unknown as ForgeToolRequest, directContext());
    };

    const fixedSet: Array<{ id: string; forge: () => Promise<ForgeResult> }> = [
      { id: 'F1', forge: () => onFreshEngine(sandboxArgs()) },
      {
        id: 'F2',
        forge: () =>
          onFreshEngine(searchAndSummariseArgs(), [
            fixedOutputTool('web_search', 'q', { snippet: 'Quantum computers use qubits.' }),
            fixedOutputTool('summarise', 'text', { summary: 'A summary.' }),
          ]),
      },
      {
        id: 'F3',
        forge: async () => {
          const host = await hostWith({
            'fs.read': { roots: [root] },
            'fs.write': WRITE_CEILING(root),
            'fs.delete': { roots: [root], maxFilesPerCall: 2, timeoutMs: 5000, approval: 'none' },
            fetch: { domains: ['127.0.0.1'], methods: ['POST'], maxRequestBytes: 64, approval: 'none' },
          });
          const args = roundTripArgs(root, `http://127.0.0.1:${port}/items`);
          return host.engine.forge(args as unknown as ForgeToolRequest, directContext());
        },
      },
      { id: 'G1', forge: () => onFreshEngine(radiationDoseArgs()) },
      { id: 'T2', forge: () => onFreshEngine(sumTwoArgs()) },
    ];

    // Every forge of the set is approved. That holds with or without a trace, so it shows each fixture forges.
    const forged: Array<{ id: string; result: ForgeResult }> = [];
    for (const { id, forge } of fixedSet) {
      const result = await forge();
      expect(result.success, `${id}: ${String(result.error ?? 'approved')}`).toBe(true);
      forged.push({ id, result });
    }
    // F3's test was a dry run: nothing was written under the root and nothing was sent.
    expect(fs.existsSync(path.join(root, 'tmp.txt'))).toBe(false);
    expect(seen).toEqual([]);
    // F3 deletes the file it writes, so the check above cannot see a write that reached the root and was then deleted.
    // A forge that only writes, under the same ceiling, shows it: its test ran, and the file is not under the root.
    const writeOnly = await hostWith({ 'fs.write': WRITE_CEILING(root) });
    const wrote = await writeOnly.engine.forge(
      {
        name: 'write_once',
        description: 'Writes one file.',
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        implementation: { mode: 'sandbox', code: WRITE_ONCE, allowlist: ['fs.write'] },
        testCases: [{ input: { path: path.join(root, 'tmp.txt'), text: 'draft' } }],
      } as unknown as ForgeToolRequest,
      directContext(),
    );
    expect(wrote.success, String(wrote.error ?? 'approved')).toBe(true);
    expect(traceOf(wrote)?.tests[0]?.ran).toBe(true);
    expect(fs.existsSync(path.join(root, 'tmp.txt'))).toBe(false);

    // Each forge has a trace, and no field of it is cut.
    const forges: NonNullable<ForgeTraceMeasure['forges']> = [];
    for (const { id, result } of forged) {
      const trace = traceOf(result);
      expect(trace, `${id} has a trace`).toBeDefined();
      expect(trace!.sizes.cut, `${id} is cut nowhere`).toEqual([]);
      forges.push({
        id,
        codeBytes: trace!.sizes.codeBytes,
        traceBytes: trace!.sizes.traceBytes,
        tests: trace!.tests.length,
      });
    }
    measure.forges = forges;
  });

  it('measurement: the time a no-op hook adds at the 95th percentile, across outcomes, is recorded', async () => {
    // 120 forges, each under its own name and session. Run i ends at outcome i % 3 and runs on the engine with the
    // hook when i is odd, so the two engines take turns and each outcome runs 20 times on each.
    const runs = Array.from({ length: 120 }, (_, i) => ({
      i,
      outcome: LATENCY_OUTCOMES[i % 3],
      hooked: i % 2 === 1,
    }));
    // Each engine's judge answers its judged forges in the order they run.
    const repliesOf = (hooked: boolean): string[] =>
      runs
        .filter((run) => run.hooked === hooked && run.outcome !== 'code_validation')
        .map((run) => (run.outcome === 'approved' ? APPROVED_JSON : REJECTED_JSON));
    let calls = 0;
    const bare = await directEngine({ judgeReplies: repliesOf(false) });
    const withHook = await directEngine({
      judgeReplies: repliesOf(true),
      onForgeTrace: () => {
        calls += 1;
      },
    });

    const samples: Array<{ outcome: LatencyOutcome; hooked: boolean; ms: number }> = [];
    for (const { i, outcome, hooked } of runs) {
      const { engine } = hooked ? withHook : bare;
      const name = `add_numbers_${i}`;
      const args =
        outcome === 'code_validation'
          ? sandboxArgs({ name, implementation: { mode: 'sandbox', code: EVAL_CODE, allowlist: [] } })
          : sandboxArgs({ name });
      const context: ForgeContext = { agentId: 'agent-1', sessionId: `latency-${i}` };
      const { value: result, ms } = await timed(() => engine.forge(args as unknown as ForgeToolRequest, context));
      // Each run ended at its outcome. That holds with or without a trace, so it shows what each figure measured.
      if (outcome === 'approved') {
        expect(result.success, `run ${i}: ${String(result.error ?? 'approved')}`).toBe(true);
      } else if (outcome === 'judge_rejected') {
        expect(result.success, `run ${i}`).toBe(false);
        expect(result.verdict?.approved, `run ${i}: ${String(result.error)}`).toBe(false);
      } else {
        expect(result.error, `run ${i}`).toMatch(/^Code validation failed: /);
      }
      // The session's tool goes once the run is timed: the registry holds ten session tools at most, and every
      // approved forge then registers beside none.
      engine.cleanupSession(context.sessionId);
      samples.push({ outcome, hooked, ms });
    }

    // The hook ran once for each of the 60 forges on its engine.
    expect(calls).toBe(60);

    /** The 95th percentile with the hook, without it, and what the hook added, over the runs of `outcome` or all. */
    const added = (outcome?: LatencyOutcome): { withMs: number; withoutMs: number; addedMs: number } => {
      const msOf = (hooked: boolean): number[] =>
        samples
          .filter((sample) => sample.hooked === hooked && (outcome === undefined || sample.outcome === outcome))
          .map((sample) => sample.ms);
      const withMs = percentile95(msOf(true));
      const withoutMs = percentile95(msOf(false));
      return { withMs, withoutMs, addedMs: withMs - withoutMs };
    };
    const across = added();
    const latency: NonNullable<ForgeTraceMeasure['latency']> = {
      runs: samples.length,
      p95WithMs: toThousandth(across.withMs),
      p95WithoutMs: toThousandth(across.withoutMs),
      addedMs: toThousandth(across.addedMs),
      byOutcome: {
        approved: toThousandth(added('approved').addedMs),
        judge_rejected: toThousandth(added('judge_rejected').addedMs),
        code_validation: toThousandth(added('code_validation').addedMs),
      },
    };
    // The figures go to the job's log and its artifact. No bound is asserted on them: two percentiles sampled on a shared
    // runner move with its load, so a bound here would fail on the runner's noise and not on the hook.
    expect(latency.runs).toBe(120);
    measure.latency = latency;
  });
});

// ----------------------------------------------------------------------------
// Review follow-ups
// ----------------------------------------------------------------------------

/** A host tool with no side effects whose every output holds a BigInt, which JSON cannot write. */
function bigIntOutputTool(): ITool {
  return {
    id: 'big-output-v1',
    name: 'big_output',
    displayName: 'Big output',
    description: 'Returns a count as a BigInt.',
    inputSchema: { type: 'object', properties: {} },
    hasSideEffects: false,
    execute: async () => ({ success: true, output: { count: 10n } }),
  };
}

/** An output guardrail that judges tool calls and blocks every call to forge_tool. */
function noForgingGuard(): IGuardrailService {
  return {
    id: 'no-forging',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) {
        return null;
      }
      const forging = (chunk as AgentOSToolCallRequestChunk).toolCalls.some((call) => call.name === 'forge_tool');
      return forging
        ? { action: GuardrailAction.BLOCK, reason: 'No forging in this workspace.', reasonCode: 'NO_FORGING' }
        : null;
    },
  };
}

/**
 * An output guardrail that blocks a call to forge_tool judged alone: the GMI's tool-call gate judges each call of a step
 * alone, so it refuses each forge_tool call there. The stream's chunk for a step that holds other calls too passes, so
 * the turn is not replaced by the guardrail's reply and its own failure reaches the stream.
 */
function noLoneForgingGuard(): IGuardrailService {
  return {
    id: 'no-lone-forging',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) {
        return null;
      }
      const calls = (chunk as AgentOSToolCallRequestChunk).toolCalls;
      return calls.length === 1 && calls[0].name === 'forge_tool'
        ? { action: GuardrailAction.BLOCK, reason: 'No forging in this workspace.', reasonCode: 'NO_FORGING' }
        : null;
    },
  };
}

/** The context of a direct call whose agentId and sessionId getters throw. */
function throwingIdsContext(): ForgeContext {
  return {
    get agentId(): string {
      throw new Error('agent id unavailable');
    },
    get sessionId(): string {
      throw new Error('session id unavailable');
    },
  } as unknown as ForgeContext;
}

/** A model step on the full runtime that calls each of `calls` in order. */
function toolCallsStep(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): Array<Record<string, unknown>> {
  return [
    {
      isFinal: true,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finishReason: 'tool_calls',
        },
      ],
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    },
  ];
}

/** One turn on the full runtime whose model answers `step` first: what it streamed, and what it threw, if it threw. */
async function turnThroughRuntime(
  os: AgentOS,
  step: Array<Record<string, unknown>>,
): Promise<{ chunks: unknown[]; thrown: unknown }> {
  runtimeModel.replies.push(step);
  const input: AgentOSInput = {
    userId: 'user-1',
    sessionId: 'session-1',
    textInput: 'Forge it.',
    selectedPersonaId: FORGER.id,
  };
  const chunks: unknown[] = [];
  let thrown: unknown;
  try {
    for await (const chunk of os.processRequest(input)) {
      chunks.push(chunk);
    }
  } catch (error) {
    thrown = error;
  }
  return { chunks, thrown };
}

/** The message a turn's stream carries when its first call, missing_tool, failed under fail_closed. */
const FAIL_CLOSED_ON_MISSING_TOOL = expect.stringContaining(
  "Tool 'missing_tool' failed and execution policy is fail_closed.",
);

/** The messages of the error chunks a turn streamed that name a fail_closed stop. */
function failClosedFailures(chunks: unknown[]): string[] {
  return chunks
    .filter((chunk) => (chunk as { type?: unknown }).type === AgentOSResponseChunkType.ERROR)
    .map((chunk) => String((chunk as { message?: unknown }).message))
    .filter((message) => message.includes('fail_closed'));
}

/** A call's answering-model record as a GMI writes it when the step's final chunk names no model. */
const REQUESTED_CALLER_MODEL = { providerId: 'caller-provider', modelId: 'caller-model', modelSource: 'requested' };

describe('forge trace: review follow-ups', () => {
  afterEach(async () => {
    await resetRuntime();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('stage test_output_unserializable: an approving judge on a BigInt output refuses the forge and registers nothing', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const h = await directEngine({ hostTools: [bigIntOutputTool()], onForgeTrace });
    const args = composeArgs([{ name: 'count', tool: 'big_output', inputMapping: {} }]);

    const result = await h.engine.forge(args as unknown as ForgeToolRequest, directContext());

    // The judge read the output through its marker and approved; the engine refused the tool before registering it.
    expect(h.generateText).toHaveBeenCalledTimes(1);
    expect(String(h.generateText.mock.calls[0][1])).toContain('bigint');
    expect(result.success).toBe(false);
    expect(result.toolId).toBeUndefined();
    expect(result.error).toMatch(/^test_output_unserializable: /);
    expect(result.verdict).toMatchObject({ approved: true });
    expect(h.engine.getSessionTools('turn-1')).toEqual([]);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(result)).toBe(trace);
    expect(trace.stage).toBe('test_output_unserializable');
    expect(trace.outcome).toBe('refused');
    expect(trace.reason).toBe(result.error);
    expect(trace.verdict).toMatchObject(JUDGE_APPROVAL);
    expect(trace.toolId).toMatch(MINTED_TOOL_ID);
    expect(h.registry.get(String(trace.toolId))).toBeFalsy();
    expect(trace.tests[0].result.output).toEqual({ count: { $trace: 'unserializable', kind: 'bigint' } });
  });

  it('stage compose_needs_step_output keeps the partial run: the read-only step ran and the stand-in step is an effect', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const h = await directEngine({
      hostTools: [echoTool('echo'), sendNoteTool()],
      config: { compose: { sideEffectingTools: ['send_note'] } },
      onForgeTrace,
    });
    const args = composeArgs(
      [
        { name: 'say', tool: 'echo', inputMapping: { text: '$input.text' } },
        { name: 'send', tool: 'send_note', inputMapping: { text: '$input.text' } },
        { name: 'send_again', tool: 'send_note', inputMapping: { text: '$input.text' } },
      ],
      {
        testCases: [
          { input: { text: 'hi' }, expectedOutput: { text: 'hi' }, stepOutputs: { send: { text: 'sent: hi' } } },
        ],
      },
    );

    const result = await h.engine.forge(args as unknown as ForgeToolRequest, directContext());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^dry_run_needs_output: step "send_again"/);
    expect(h.generateText).not.toHaveBeenCalled();

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.stage).toBe('compose_needs_step_output');
    expect(trace.tests).toHaveLength(1);
    expect(trace.tests[0].ran).toBe(true);
    expect(trace.tests[0].result).toMatchObject({
      success: false,
      error: result.error,
      effects: [{ kind: 'step', step: 'send', tool: 'send_note', wouldRun: true }],
    });
    expect(trace.provenance.testResults).toMatchObject({ kind: 'execution' });
  });

  it('stage caller_context_required keeps the partial run: the read-only step ran before the step that needs a capability', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const sent: Array<Record<string, unknown>> = [];
    const h = await directEngine({ hostTools: [echoTool('echo'), sendMessageTool(sent, false)], onForgeTrace });
    const args = composeArgs([
      { name: 'say', tool: 'echo', inputMapping: { text: '$input.text' } },
      { name: 'send', tool: 'send_message', inputMapping: { text: '$input.text' } },
    ]);

    const result = await h.engine.forge(args as unknown as ForgeToolRequest, directContext());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^caller_context_required: /);
    expect(sent).toEqual([]);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace.stage).toBe('caller_context_required');
    expect(trace.tests[0].ran).toBe(true);
    expect(trace.tests[0].result).toMatchObject({ success: false });
    expect(trace.tests[0].result.error).toMatch(/^Step "send" \(tool: "send_message"\) failed: /);
  });

  it.each<[string, Record<string, unknown>]>([
    ['name_refused', sandboxArgs({ name: '1st tool' })],
    ['code_validation', sandboxWith({ code: 'function execute(input) { return eval("1"); }' })],
  ])('a context whose ids cannot be read keeps its refusal (%s), traced with no ids', async (stage, args) => {
    const { onForgeTrace, traces } = hookRecorder();
    const { engine } = await directEngine({ onForgeTrace });

    const result = await engine.forge(args as unknown as ForgeToolRequest, throwingIdsContext());
    expect(result.success).toBe(false);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(traceOf(result)).toBe(trace);
    expect(trace.stage).toBe(stage);
    expect(trace.reason).toBe(result.error);
    expect(trace.agentId).toBeNull();
    expect(trace.correlationId).toBeNull();
  });

  it('stage approval_timed_out: an approval nobody answered is not a human denial', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const host = await makeForgeHost({
      onForgeTrace,
      orchestratorConfig: { hitl: { enabled: true } },
      hitlManager: new HumanInteractionManager({ autoRejectOnTimeout: true, defaultTimeoutMs: 20 }),
    });

    const result = await callTool(host.orchestrator, 'forge_tool', sandboxArgs(), CALLER);
    expect(result.isError).toBe(true);
    expect(result.errorDetails.message).toBe('Request timed out');
    expect(result.errorDetails.details).toMatchObject({ approved: false, decidedBy: 'system' });
    expect(host.judge).not.toHaveBeenCalled();

    const trace = orchestratorTrace(traces, 'approval_timed_out', 'refused');
    expect(trace.reason).toBe('Request timed out');
  });

  it('stage guardrail_refused: an output guardrail that refuses forge_tool on the full runtime reaches the hook', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(onForgeTrace, { guardrailService: noForgingGuard() });

    await forgeThroughRuntime(runtime, sandboxArgs());
    // The guardrail refused the call before it ran: no judge was asked.
    expect(runtimeModel.judgeCalls).toBe(0);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expectTraceBy(trace, 'orchestrator', 'forge_tool');
    expect(trace.stage).toBe('guardrail_refused');
    expect(trace.outcome).toBe('refused');
    expect(trace.reason).toBe('No forging in this workspace.');
    expect(trace.verdict).toBeNull();
    expect(trace.request).toMatchObject({ name: 'add_numbers', description: 'Add two numbers.' });
    expect(trace.provenance.request).toMatchObject({
      kind: 'model',
      role: 'forging_agent',
      provider: 'openai',
      model: 'stream-model-7',
      modelSource: 'answered',
    });
  });

  it('stage guardrail_refused: a refused forge_tool call after a failed call under fail_closed reaches the hook', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(onForgeTrace, {
      guardrailService: noLoneForgingGuard(),
      turnPlanning: {
        enabled: true,
        defaultToolFailureMode: 'fail_closed',
        discovery: { enabled: false, defaultToolSelectionMode: 'all' },
      },
    });

    // One step of two calls: a tool the runtime does not have, which fails and ends the round under fail_closed, then a
    // forge_tool call the guardrail refused, which the round never reaches.
    const turn = await turnThroughRuntime(
      runtime,
      toolCallsStep([
        { id: 'call-missing', name: 'missing_tool', args: {} },
        { id: 'call-forge', name: 'forge_tool', args: sandboxArgs() },
      ]),
    );
    expect(runtimeModel.judgeCalls).toBe(0);
    // The turn failed on the first call under fail_closed: the forge_tool call's trace came from the recovery of a
    // round that stopped, not from a round that went on to it.
    expect(failClosedFailures(turn.chunks)).toEqual([FAIL_CLOSED_ON_MISSING_TOOL]);

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expectTraceBy(trace, 'orchestrator', 'forge_tool');
    expect(trace.stage).toBe('guardrail_refused');
    expect(trace.outcome).toBe('refused');
    expect(trace.reason).toBe('No forging in this workspace.');
    expect(trace.request).toMatchObject({ name: 'add_numbers', description: 'Add two numbers.' });
  });

  it('under fail_closed, the forge calls a failed call skipped share one wait for a stalled hook', async () => {
    // A hook that never settles: each delivery waits for it up to the bound.
    const hookStarts: number[] = [];
    const stalledHook = (): Promise<void> => {
      hookStarts.push(performance.now());
      return new Promise<void>(() => undefined);
    };
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(stalledHook, {
      guardrailService: noLoneForgingGuard(),
      turnPlanning: {
        enabled: true,
        defaultToolFailureMode: 'fail_closed',
        discovery: { enabled: false, defaultToolSelectionMode: 'all' },
      },
    });
    const os = runtime;

    // A failed call, then three forge_tool calls the guardrail refused, which the round never reaches.
    const { value: turn, ms } = await timed(() =>
      turnThroughRuntime(
        os,
        toolCallsStep([
          { id: 'call-missing', name: 'missing_tool', args: {} },
          { id: 'call-forge-1', name: 'forge_tool', args: sandboxArgs() },
          { id: 'call-forge-2', name: 'forge_tool', args: sandboxArgs() },
          { id: 'call-forge-3', name: 'forge_tool', args: sandboxArgs() },
        ]),
      ),
    );

    expect(failClosedFailures(turn.chunks)).toEqual([FAIL_CLOSED_ON_MISSING_TOOL]);
    expect(runtimeModel.judgeCalls).toBe(0);
    expect(hookStarts).toHaveLength(3);
    // Every skipped call's hook is called before the bound of the one before it ends: one wait for the round, where a
    // wait a call would start each hook a bound after the last.
    expect(Math.max(...hookStarts) - Math.min(...hookStarts)).toBeLessThan(HOOK_BOUND_MS);
    // The failure reaches the caller after about one bound, where a wait a call would take three.
    expect(ms).toBeLessThan(2.5 * HOOK_BOUND_MS);
  }, 20_000);

  it("a forge whose step's model its adapter marked as the request's is authored by that model, labelled requested", async () => {
    const { onForgeTrace, traces } = hookRecorder();
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(onForgeTrace);

    // The adapter names a model on the final chunk and marks it as the request's, filled in where the answer named none.
    await forgeThroughRuntime(runtime, sandboxArgs(), { modelId: 'filled-in-model', modelIdSource: 'requested' });

    expect(traces).toHaveLength(1);
    const author = traces[0].provenance.request as Record<string, unknown>;
    // The adapter's id is the model its request named, which a request option can set apart from the model the step
    // asked for: it is kept, labelled requested.
    expect(author).toMatchObject({
      kind: 'model',
      role: 'forging_agent',
      provider: 'openai',
      model: 'filled-in-model',
      modelSource: 'requested',
    });
  });

  it('the GMI labels the model it asked for requested when the step names no model', async () => {
    const step = toolCallReply([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]);
    delete (step[step.length - 1] as { modelId?: string }).modelId;
    const scripted = scriptedProvider([step, textReply('Done.')]);
    const { gmi, processToolCall } = await createScriptedGmi({ provider: scripted.provider });

    await runTurn(gmi, textTurn('t1', 'Look it up.'));

    expect(processToolCall).toHaveBeenCalledTimes(1);
    expect((processToolCall.mock.calls[0][0] as { callerModel?: unknown }).callerModel).toEqual({
      providerId: 'scripted',
      modelId: 'scripted-model',
      modelSource: 'requested',
    });
  });

  it('a forge whose step names no model is authored by the requested model on the full runtime', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(onForgeTrace);

    // The step's final chunk names no model, so the GMI names the model the step asked for.
    await forgeThroughRuntime(runtime, sandboxArgs(), { modelId: '' });

    expect(traces).toHaveLength(1);
    expect(traces[0].provenance.request).toMatchObject({
      kind: 'model',
      role: 'forging_agent',
      provider: 'openai',
      model: expect.any(String),
      modelSource: 'requested',
    });
  });

  it('forge_tool, the wrapper and the orchestrator keep a requested callerModel requested', async () => {
    const { onForgeTrace, traces } = hookRecorder();
    const { forgeTool } = await directEngine({ onForgeTrace });
    const context = { ...toolContext(), callerModel: REQUESTED_CALLER_MODEL } as unknown as ToolExecutionContext;

    // forge_tool refuses a call with no description itself.
    await forgeTool.execute(sandboxArgs({ description: '' }) as unknown as ForgeToolInput, context);
    // The wrapper's shape check refuses a call with no declared properties and one test case.
    const captures: CapturedForge[] = [];
    await departmentWrapper(forgeTool, captures).execute(
      sandboxArgs({ inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, testCases: [{ input: {} }] }),
      context,
    );
    // The orchestrator refuses a call to its own forge_tool that its config disables.
    const host = await makeForgeHost({ onForgeTrace, orchestratorConfig: { globalDisabledTools: ['forge_tool'] } });
    await processForgeCall(host, sandboxArgs(), {
      callerModel: REQUESTED_CALLER_MODEL,
    } as unknown as Partial<ToolExecutionRequestDetails>);

    expect(traces.map((trace) => [trace.recordedBy, trace.stage])).toEqual([
      ['forge_tool', 'description_missing'],
      ['wrapper', 'shape_check'],
      ['orchestrator', 'orchestrator_refused'],
    ]);
    for (const trace of traces) {
      expect(trace.provenance.request, trace.recordedBy).toMatchObject({
        kind: 'model',
        role: 'forging_agent',
        provider: 'caller-provider',
        model: 'caller-model',
        modelSource: 'requested',
      });
    }
  });

  it("the judge's provider is the one its review request went to, read as the request is sent", async () => {
    const { onForgeTrace, traces } = hookRecorder();
    runtimeModel.judgeReply = APPROVED_JSON;
    runtime = await bootRuntime(onForgeTrace);
    const manager = runtime.getModelProviderManager();
    const started = manager.getDefaultProvider();
    expect(started?.providerId).toBe('openai');
    // The host makes another provider the default after the runtime started; it answers through the same stub.
    const later = Object.create(started!, { providerId: { value: 'later-provider' } }) as NonNullable<typeof started>;
    const getProvider = manager.getProvider.bind(manager);
    vi.spyOn(manager, 'getDefaultProvider').mockReturnValue(later);
    vi.spyOn(manager, 'getProvider').mockImplementation((id: string) => (id === 'later-provider' ? later : getProvider(id)));

    await forgeThroughRuntime(runtime, sandboxArgs());

    expect(runtimeModel.judgeCalls).toBe(1);
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe('approved');
    expect(traces[0].provenance.verdict).toMatchObject({
      provider: 'later-provider',
      model: 'gpt-4o-mini',
      modelSource: 'requested',
    });
  });

  it("the wrapper's refusal before approval reaches the hook after the call returns and after its capture", async () => {
    const order: string[] = [];
    const { forgeTool } = await directEngine({
      onForgeTrace: () => {
        order.push('hook');
      },
    });
    const captures: CapturedForge[] = [];
    const wrapped = wrapForgeTool({
      raw: forgeTool,
      agentId: 'dept-agent',
      sessionId: 'dept-session',
      capture: (record: CapturedForge) => {
        order.push('capture');
        captures.push(record);
      },
    });
    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');

    const refusal = wrapped.refusalBeforeApproval!(sandboxArgs(), toolContext());
    order.push('returned');
    expect(refusal?.success).toBe(false);
    // The capture holds the trace at once; the hook runs once the call has returned.
    expect(traceOf(captures[0])).toBeDefined();
    expect(order).toEqual(['capture', 'returned']);

    await vi.waitFor(() => expect(order).toEqual(['capture', 'returned', 'hook']));
    expect(captures).toHaveLength(1);
  });
});
