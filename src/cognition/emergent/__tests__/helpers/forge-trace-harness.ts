/**
 * @fileoverview The shared harness of the forge trace's tests: a real engine
 * over a real tool executor, a scripted judge, a recorder for the trace hook,
 * the fixed forge requests, and the capture of log lines and console output.
 */

import { format } from 'node:util';
import pino from 'pino';
import { vi } from 'vitest';
import { resetLoggerFactory, setLogger } from '../../../../core/logging/loggerFactory.js';
import type { ITool } from '../../../../core/tools/ITool.js';
import { ToolExecutor } from '../../../../core/tools/ToolExecutor.js';
import { ComposableToolBuilder } from '../../ComposableToolBuilder.js';
import { EmergentCapabilityEngine, type EmergentCapabilityEngineDeps } from '../../EmergentCapabilityEngine.js';
import { EmergentJudge, type EmergentJudgeConfig } from '../../EmergentJudge.js';
import { EmergentToolRegistry } from '../../EmergentToolRegistry.js';
import { ForgeToolMetaTool } from '../../ForgeToolMetaTool.js';
import type { StepGate } from '../../StepGate.js';
import type { EmergentConfig } from '../../types.js';

/** The judge's reply that approves a forge. */
export const APPROVED_JSON = JSON.stringify({
  safety: { passed: true, concerns: [] },
  correctness: { passed: true, failedTests: [] },
  determinism: { likely: true, reasoning: 'Deterministic.' },
  bounded: { likely: true, reasoning: 'Bounded.' },
  confidence: 0.95,
  approved: true,
  reasoning: 'Tool is safe and correct.',
});

/** The judge's reply that rejects a forge on safety. */
export const REJECTED_JSON = JSON.stringify({
  safety: { passed: false, concerns: ['Unsafe pattern detected.'] },
  correctness: { passed: true, failedTests: [] },
  determinism: { likely: true, reasoning: 'Deterministic.' },
  bounded: { likely: true, reasoning: 'Bounded.' },
  confidence: 0.3,
  approved: false,
  reasoning: 'Tool contains unsafe patterns.',
});

/** A trace's fields as the tests read them. Loose on purpose: the tests read a trace through this shape alone. */
export type TraceShape = {
  traceVersion: number;
  forgeId: string;
  recordedBy: string;
  via: string;
  agentId: string | null;
  sessionId: string | null;
  correlationId: string | null;
  toolName: unknown;
  mode: string | null;
  outcome: string;
  stage: string;
  reason: unknown;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  request: any;
  rawArguments?: unknown;
  justification: unknown;
  tests: any[];
  executor: { name: string; isolates: boolean } | null;
  verdict: any;
  judgeDetail: any;
  toolId: string | null;
  provenance: any;
  sizes: { traceBytes: number; codeBytes: number | null; cut: string[]; testsOmitted: number };
};

/** A trace hook that keeps every trace it is handed, in order. */
export function hookRecorder(): { onForgeTrace: (trace: unknown) => void; traces: TraceShape[] } {
  const traces: TraceShape[] = [];
  return {
    onForgeTrace: (trace: unknown) => {
      traces.push(trace as TraceShape);
    },
    traces,
  };
}

/** The `trace` of a forge result or of a wrapper's capture, when it holds one. */
export function traceOf(value: unknown): TraceShape | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return (value as { trace?: TraceShape }).trace;
}

/** A code forge that adds two numbers, with one test case. */
export function sandboxArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'add_numbers',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
    },
    implementation: {
      mode: 'sandbox',
      code: 'function execute(input) { return { sum: input.a + input.b }; }',
      allowlist: [],
    },
    testCases: [{ input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } }],
    ...overrides,
  };
}

/** The same code forge with a second test case: the wrapper's shape check asks for two. */
export function wrapperArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return sandboxArgs({
    testCases: [
      { input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } },
      { input: { a: 1, b: 1 }, expectedOutput: { sum: 2 } },
    ],
    ...overrides,
  });
}

/** A composition over `steps` that takes a `text` and returns one, with one test case. */
export function composeArgs(
  steps: Array<{ name: string; tool: string; inputMapping: Record<string, unknown> }>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'say_text',
    description: 'Returns the text it is given, through its steps.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    implementation: { mode: 'compose', steps },
    testCases: [{ input: { text: 'hi' }, expectedOutput: { text: 'hi' } }],
    ...overrides,
  };
}

/**
 * A real engine over a real ToolExecutor that holds `hostTools`. Its step gate
 * resolves and runs through that executor, so capability and side-effect
 * checks are the real ones. The judge answers `judgeReplies` in order and
 * approves after them.
 */
export async function directEngine(
  options: {
    config?: Partial<EmergentConfig>;
    judgeReplies?: Array<string | Error | (() => Promise<string>)>;
    judge?: EmergentJudge;
    onForgeTrace?: (trace: unknown) => void | Promise<void>;
    onToolForged?: EmergentCapabilityEngineDeps['onToolForged'];
    onToolRestored?: EmergentCapabilityEngineDeps['onToolRestored'];
    hostTools?: ITool[];
  } = {},
): Promise<{
  engine: EmergentCapabilityEngine;
  forgeTool: ForgeToolMetaTool;
  registry: EmergentToolRegistry;
  tools: ToolExecutor;
  generateText: ReturnType<typeof vi.fn>;
}> {
  const tools = new ToolExecutor(undefined, undefined, undefined, { builtInTools: false });
  for (const tool of options.hostTools ?? []) {
    await tools.registerTool(tool);
  }
  const gate: StepGate = {
    resolve: (name) => tools.getTool(name),
    run: (tool, args, context) =>
      tools.executeTool({
        toolCallRequest: { id: 'step', name: tool.name, arguments: args },
        gmiId: context.gmiId,
        personaId: context.personaId,
        personaCapabilities: context.personaCapabilities ?? [],
        userContext: context.userContext,
        correlationId: context.correlationId,
        sessionData: context.sessionData,
      }),
  };

  const replies = [...(options.judgeReplies ?? [])];
  const generateText = vi.fn(async (_model: string, _prompt: string): Promise<string> => {
    const reply = replies.shift();
    if (reply === undefined) {
      return APPROVED_JSON;
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return typeof reply === 'function' ? reply() : reply;
  });

  const config: EmergentConfig = {
    enabled: true,
    maxSessionTools: 10,
    maxAgentTools: 50,
    allowSandboxTools: true,
    persistSandboxSource: false,
    sandboxMemoryMB: 128,
    sandboxTimeoutMs: 5000,
    promotionThreshold: { uses: 5, confidence: 0.8 },
    judgeModel: 'gpt-4o-mini',
    promotionJudgeModel: 'gpt-4o',
    ...(options.config ?? {}),
  };
  const judge =
    options.judge ??
    new EmergentJudge({
      judgeModel: 'judge-model',
      promotionModel: 'judge-model',
      generateText,
      providerId: 'judge-provider',
    } as EmergentJudgeConfig);
  const registry = new EmergentToolRegistry({ enabled: true, maxSessionTools: 10, maxAgentTools: 50 });
  const engine = new EmergentCapabilityEngine({
    config,
    composableBuilder: new ComposableToolBuilder(gate),
    judge,
    registry,
    onForgeTrace: options.onForgeTrace,
    onToolForged: options.onToolForged,
    onToolRestored: options.onToolRestored,
  } as EmergentCapabilityEngineDeps);

  return { engine, forgeTool: new ForgeToolMetaTool(engine), registry, tools, generateText };
}

/**
 * Captures what a test would write: every logging event as its parsed JSON
 * line, and every console call as the text the console would print.
 * `restore()` puts the logger and the console back.
 */
export function captureLines(): { lines: Array<Record<string, unknown>>; printed(): string; restore(): void } {
  const lines: Array<Record<string, unknown>> = [];
  setLogger(
    pino(
      { level: 'debug', base: undefined },
      {
        write(line: string) {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ),
  );
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
  ];
  return {
    lines,
    printed: () =>
      spies
        .flatMap((spy) => spy.mock.calls as unknown[][])
        .map((call) => format(...call))
        .join('\n'),
    restore: () => {
      resetLoggerFactory();
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

/** Holds `Date` at 18 Nov 2026 00:00 UTC and `Math.random` at 0.5. Returns the function that lets both go. */
export function freezeClock(): () => void {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 18) });
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  return () => {
    random.mockRestore();
    vi.useRealTimers();
  };
}
