/**
 * @fileoverview The engine on QuickJSExecutor: `emergentConfig.executor`
 * reaches the forge the engine builds, so a code tool forged through
 * forge_tool and called through processToolCall runs on it, at forge time and
 * at call time; a host-built forge on another executor beside it fails
 * construction; a forge on an executor that cannot run is refused before its
 * tests and its review.
 */
import { describe, expect, it, vi } from 'vitest';
import { ComposableToolBuilder } from '../ComposableToolBuilder.js';
import { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { EmergentJudge } from '../EmergentJudge.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import { QuickJSExecutor } from '../executor/QuickJSExecutor.js';
import type { ForgedCodeExecutor } from '../executor/types.js';
import { DEFAULT_EMERGENT_CONFIG, type EmergentConfig } from '../types.js';
import { APPROVED_VERDICT, callTool, makeForgeHost } from './helpers/forge-host.js';

const ADD_UP = {
  name: 'add_up',
  description: 'Adds two numbers.',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  outputSchema: { type: 'object', additionalProperties: true },
  implementation: {
    mode: 'sandbox',
    code: 'function execute(input) { return { sum: input.a + input.b }; }',
    allowlist: [],
  },
  testCases: [{ input: { a: 1, b: 2 } }],
};

describe('the engine on QuickJSExecutor', () => {
  it('runs a forged code tool on emergentConfig.executor, at forge time and at call time', async () => {
    const executor = await QuickJSExecutor.create();
    const run = vi.spyOn(executor, 'run');
    const host = await makeForgeHost({ config: { executor } });

    const forged = await callTool(host.orchestrator, 'forge_tool', ADD_UP);
    expect(forged.isError).toBeFalsy();
    const atForge = run.mock.calls.length;
    expect(atForge).toBeGreaterThan(0);

    const called = await callTool(host.orchestrator, 'add_up', { a: 2, b: 3 });
    expect(called.output).toEqual({ sum: 5 });
    expect(run.mock.calls.length).toBe(atForge + 1);
  });

  it('fails construction when a host-built forge on another executor is passed beside emergentConfig.executor', async () => {
    const executor = await QuickJSExecutor.create();
    const config: EmergentConfig = { ...DEFAULT_EMERGENT_CONFIG, enabled: true, allowSandboxTools: true, executor };
    const build = (sandboxForge: SandboxedToolForge) =>
      new EmergentCapabilityEngine({
        config,
        composableBuilder: new ComposableToolBuilder(async () => ({ success: true, output: {} })),
        sandboxForge,
        judge: new EmergentJudge({
          judgeModel: 'judge',
          promotionModel: 'judge',
          generateText: async () => APPROVED_VERDICT,
        }),
        registry: new EmergentToolRegistry(config),
      });

    expect(() => build(new SandboxedToolForge())).toThrow(
      'executor_conflict: emergentConfig.executor (quickjs-wasm) is not the executor of the sandboxForge passed beside it (in-process)',
    );
    expect(build(new SandboxedToolForge({ executor }))).toBeInstanceOf(EmergentCapabilityEngine);
  });

  it('refuses a forge before its tests and its review when the executor cannot run', async () => {
    const run = vi.fn();
    const executor: ForgedCodeExecutor = {
      name: 'never-ready',
      isolates: true,
      ready: () => Promise.reject(new Error('quickjs_unavailable: the engine is not installed')),
      run,
    };
    const host = await makeForgeHost({ config: { executor } });

    const forged = await callTool(host.orchestrator, 'forge_tool', ADD_UP);
    expect(forged.isError).toBe(true);
    expect(String(forged.errorDetails?.message)).toContain('quickjs_unavailable: the engine is not installed');
    expect(run).not.toHaveBeenCalled();
    expect(host.judge).not.toHaveBeenCalled();
  });
});
