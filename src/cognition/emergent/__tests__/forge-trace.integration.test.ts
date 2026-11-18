/**
 * @fileoverview The forge trace on the real path: a real engine over a real
 * tool executor, with a scripted judge. One forge per stage a forge can end
 * at, each asserting that every carrier that applies (the forge's result and
 * the host's hook here) holds the same trace, with that stage's outcome,
 * reason, verdict, executor and tool id.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ITool } from '../../../core/tools/ITool.js';
import type { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import type { ForgedCodeExecutor } from '../executor/types.js';
import type { ForgeResult, ForgeToolRequest } from '../types.js';
import { echoTool, sendMessageTool } from './helpers/forge-host.js';
import {
  REJECTED_JSON,
  composeArgs,
  directEngine,
  hookRecorder,
  sandboxArgs,
  traceOf,
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
});
