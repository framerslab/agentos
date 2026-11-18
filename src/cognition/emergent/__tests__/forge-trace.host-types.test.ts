/**
 * @fileoverview Host code written against the emergent types as they stood at
 * commit fd17f220, before the forge trace. Type check is this file's real
 * check: it has to compile unchanged at every later commit, so a new field,
 * option or hook that is not optional fails here first.
 */

import { describe, expect, it } from 'vitest';
import type { ITool, ToolExecutionResult } from '../../../core/tools/ITool.js';
import { ComposableToolBuilder } from '../ComposableToolBuilder.js';
import type { EmergentCapabilityEngineDeps } from '../EmergentCapabilityEngine.js';
import { EmergentJudge, type ToolCandidate } from '../EmergentJudge.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import type { ExecutorRunRequest, ExecutorRunResult, ForgedCodeExecutor } from '../executor/types.js';
import { DEFAULT_EMERGENT_CONFIG } from '../types.js';
import type { EmergentTool, ForgeResult, ForgeToolRequest } from '../types.js';
import type { CapturedForge } from '../wrapForgeTool.js';

/** What a host keeps of a wrapper's capture: the fields the wrapper has always written. */
function summarizeCapture(capture: CapturedForge): string {
  const outcome = capture.approved
    ? `approved at ${capture.confidence}`
    : `refused: ${capture.errorReason ?? 'no reason given'}`;
  const hasOutput = capture.output !== null && capture.output !== undefined;
  return `${capture.name}: ${outcome}${hasOutput ? ', with output' : ''}`;
}

/** What a host reads from the tool forge's own result. */
function describeResult(result: ForgeResult): string {
  if (result.success) {
    return `forged ${result.toolId ?? 'a tool'}`;
  }
  return result.verdict ? `rejected: ${result.verdict.reasoning}` : `failed: ${result.error ?? 'unknown'}`;
}

/** A host's own executor: it hands the input back. */
class EchoExecutor implements ForgedCodeExecutor {
  readonly name = 'echo';
  readonly isolates = false;

  async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
    return { status: 'ok', output: request.input, memoryUsedBytes: 0 };
  }
}

describe('forge trace: host code written before it', () => {
  it('a host written against the fd17f220 types compiles', async () => {
    const request: ForgeToolRequest = {
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
    };

    const forged: string[] = [];
    const deps: EmergentCapabilityEngineDeps = {
      config: { ...DEFAULT_EMERGENT_CONFIG, enabled: true },
      composableBuilder: new ComposableToolBuilder({
        resolve: () => undefined,
        run: async (): Promise<ToolExecutionResult> => ({ success: true, output: null }),
      }),
      judge: new EmergentJudge({
        judgeModel: 'judge-model',
        promotionModel: 'judge-model',
        generateText: async () => '{}',
      }),
      registry: new EmergentToolRegistry(),
      onToolForged: async (tool: EmergentTool, executable: ITool) => {
        forged.push(`${tool.name} as ${executable.name}`);
      },
    };

    const candidate: ToolCandidate = {
      name: request.name,
      description: request.description,
      inputSchema: request.inputSchema,
      outputSchema: request.outputSchema,
      source: 'function execute(input) { return { sum: input.a }; }',
      implementationMode: 'sandbox',
      allowlist: [],
      testResults: [{ input: { a: 2 }, output: { sum: 2 }, success: true }],
    };

    const capture: CapturedForge = {
      name: request.name,
      description: request.description,
      mode: 'sandbox',
      inputSchema: request.inputSchema,
      outputSchema: request.outputSchema,
      approved: true,
      confidence: 0.95,
      output: { success: true },
      timestamp: 0,
    };

    const ran = await new EchoExecutor().run({
      code: candidate.source,
      input: candidate.testResults[0].input,
      globals: {},
      timeoutMs: 1000,
      memoryMB: 16,
    });

    expect({
      capture: summarizeCapture(capture),
      refusedCapture: summarizeCapture({ ...capture, approved: false, confidence: 0, output: null, errorReason: 'too wide' }),
      result: describeResult({ success: false, error: 'Emergent capabilities are disabled.' }),
      hostEnabled: deps.config.enabled,
      hostActivates: typeof deps.onToolForged,
      forgedSoFar: forged.length,
      candidateRuns: candidate.testResults.length,
      executorStatus: ran.status,
    }).toEqual({
      capture: 'add_numbers: approved at 0.95, with output',
      refusedCapture: 'add_numbers: refused: too wide',
      result: 'failed: Emergent capabilities are disabled.',
      hostEnabled: true,
      hostActivates: 'function',
      forgedSoFar: 0,
      candidateRuns: 1,
      executorStatus: 'ok',
    });
  });
});
