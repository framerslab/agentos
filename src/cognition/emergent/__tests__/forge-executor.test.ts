/**
 * The forge hands each validated run to its executor and turns the executor's
 * answer into the result: what the executor receives, and what each way a run
 * can end comes back as.
 */
import { describe, expect, it } from 'vitest';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import { CapabilityBroker } from '../broker/CapabilityBroker.js';
import { resolveCeiling } from '../ceiling.js';
import { InProcessExecutor } from '../executor/InProcessExecutor.js';
import type { ExecutorRunRequest, ExecutorRunResult, ForgedCodeExecutor } from '../executor/types.js';
import type { AllowlistName, SandboxExecutionRequest } from '../types.js';

/** Records each request and answers with the next result given. */
function recordingExecutor(...answers: ExecutorRunResult[]): { executor: ForgedCodeExecutor; seen: ExecutorRunRequest[] } {
  const seen: ExecutorRunRequest[] = [];
  const executor: ForgedCodeExecutor = {
    name: 'recording',
    isolates: true,
    run: async (request) => {
      seen.push(request);
      const answer = answers.shift();
      if (!answer) {
        throw new Error('no answer left');
      }
      return answer;
    },
  };
  return { executor, seen };
}

function request(code: string, allowlist: AllowlistName[] = []): SandboxExecutionRequest {
  return { code, input: { a: 1 }, allowlist, memoryMB: 64, timeoutMs: 1500 };
}

const cryptoOnlyBroker = (): CapabilityBroker =>
  new CapabilityBroker(resolveCeiling({ crypto: {} }, { store: 'none' }, { hasStorage: false }));

describe('the forge and its executor', () => {
  it('runs on the in-process executor unless it is given another', () => {
    const forge = new SandboxedToolForge();
    expect(forge.executor).toBeInstanceOf(InProcessExecutor);
    expect(forge.executor.name).toBe('in-process');
    expect(forge.executor.isolates).toBe(false);
  });

  it('hands the executor the code, the input, the granted functions and the limits', async () => {
    const { executor, seen } = recordingExecutor({ status: 'ok', output: { b: 2 }, memoryUsedBytes: 7 });
    const forge = new SandboxedToolForge({ executor });

    const result = await forge.execute(request('function execute(input) { return input; }', ['crypto']));

    expect(result).toMatchObject({ success: true, output: { b: 2 }, memoryUsedBytes: 7 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      code: 'function execute(input) { return input; }',
      input: { a: 1 },
      timeoutMs: 1500,
      memoryMB: 64,
    });
    expect(Object.keys(seen[0].globals)).toEqual(['crypto']);
    expect(seen[0].signal).toBeUndefined();
  });

  it("under a ceiling, hands it the broker's functions and the call's signal", async () => {
    const { executor, seen } = recordingExecutor({ status: 'ok', output: null, memoryUsedBytes: 0 });
    const forge = new SandboxedToolForge({ executor });
    const broker = cryptoOnlyBroker();
    forge.attachBroker(broker);
    const controller = new AbortController();
    const call = { id: 'call-1', toolId: 'tool-1', agentId: 'agent-1', signal: controller.signal };

    await forge.execute({ ...request('function execute() { return null; }', ['crypto', 'fetch']), call });
    await broker.endCall(call.id);

    // The ceiling holds no fetch, so the run is handed crypto alone.
    expect(Object.keys(seen[0].globals)).toEqual(['crypto']);
    expect(seen[0].signal).toBe(controller.signal);
  });

  it('turns each way a run ends into the result', async () => {
    const { executor } = recordingExecutor(
      { status: 'error', error: 'Execution error: boom', memoryUsedBytes: 1 },
      { status: 'timeout', memoryUsedBytes: 2 },
      { status: 'memory_exceeded', memoryUsedBytes: 3 },
    );
    const forge = new SandboxedToolForge({ executor });
    const code = 'function execute() { return 1; }';

    expect(await forge.execute(request(code))).toMatchObject({
      success: false,
      error: 'Execution error: boom',
      memoryUsedBytes: 1,
    });
    expect(await forge.execute(request(code))).toMatchObject({
      success: false,
      error: 'Execution timed out after 1500ms',
      memoryUsedBytes: 2,
    });
    expect(await forge.execute(request(code))).toMatchObject({
      success: false,
      error: 'Execution exceeded its memory limit of 64 MB',
      memoryUsedBytes: 3,
    });
  });

  it('reports an executor that rejects as an execution error', async () => {
    const executor: ForgedCodeExecutor = {
      name: 'faulty',
      isolates: false,
      run: async () => {
        throw new Error('executor fault');
      },
    };

    const result = await new SandboxedToolForge({ executor }).execute(request('function execute() { return 1; }'));

    expect(result).toMatchObject({ success: false, error: 'Execution error: executor fault', memoryUsedBytes: 0 });
  });

  it('never hands the executor code that fails validation or the pre-parse, or a run with no call handle under a ceiling', async () => {
    const { executor, seen } = recordingExecutor();
    const forge = new SandboxedToolForge({ executor });

    expect((await forge.execute(request('function execute() { return eval("1"); }'))).error).toContain(
      'Code validation failed',
    );
    expect(
      (await forge.execute(request('interface X { n: number }\nfunction execute() { return 1; }'))).error,
    ).toContain('SyntaxError before execution');

    const ceilinged = new SandboxedToolForge({ executor });
    ceilinged.attachBroker(cryptoOnlyBroker());
    expect((await ceilinged.execute(request('function execute() { return 1; }'))).error).toContain(
      'call_handle_required',
    );

    expect(seen).toHaveLength(0);
  });
});
