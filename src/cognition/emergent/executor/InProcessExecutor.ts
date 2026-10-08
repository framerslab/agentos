/**
 * @fileoverview The library's default executor: forged code runs in a node:vm
 * context inside the host's process, through CodeSandbox.
 *
 * `node:vm` is not a security mechanism (Node's documentation), and the
 * context is handed the host's own constructors and functions, so this
 * executor declares `isolates: false`. It enforces a wall-clock timeout;
 * memory is reported as a heap delta around the call, not limited.
 *
 * @module @framers/agentos/emergent/executor/InProcessExecutor
 */

import { CodeSandbox } from '../../../safety/sandbox/executor/CodeSandbox.js';
import type { ExecutorRunRequest, ExecutorRunResult, ForgedCodeExecutor } from './types.js';

/**
 * Prefixed onto the JSON-serialized result inside the sandbox's stdout, so the
 * result can be told apart from console output the code produced. Bracketed by
 * NUL characters so it cannot collide with normal text.
 */
const FORGE_RESULT_MARKER = '\u0000__SANDBOX_FORGE_RESULT__\u0000';

/**
 * Runs forged code in-process. One CodeSandbox serves every call; each call
 * gets a fresh context holding the minimal globals and the granted functions.
 */
export class InProcessExecutor implements ForgedCodeExecutor {
  readonly name = 'in-process';
  readonly isolates = false;

  /** Owns the context's codeGeneration restriction, the frozen console and the globals set to undefined. */
  private readonly codeSandbox = new CodeSandbox();

  async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
    // The code defines execute(input) or run(input); the value it resolves to
    // comes back as marker-prefixed JSON on stdout, after any console output.
    const wrappedCode = `
      ${request.code};
      const __entry =
        typeof execute === 'function'
          ? execute
          : (typeof run === 'function' ? run : null);
      if (!__entry) {
        throw new Error('Sandboxed tool must define execute(input) or run(input).');
      }
      const __out = await __entry(${JSON.stringify(request.input)});
      return ${JSON.stringify(FORGE_RESULT_MARKER)} + (__out === undefined ? 'undefined' : JSON.stringify(__out));
    `;

    // Observed, not limited: other event-loop activity allocates too, and
    // node:vm shares the host heap.
    const heapBefore = process.memoryUsage().heapUsed;
    const codeResult = await this.codeSandbox.execute({
      language: 'javascript',
      code: wrappedCode,
      config: { timeoutMs: request.timeoutMs, extraGlobals: request.globals },
    });
    const memoryUsedBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

    if (codeResult.status !== 'success') {
      if (codeResult.status === 'timeout') {
        return { status: 'timeout', memoryUsedBytes };
      }
      const stderr = codeResult.output?.stderr ?? '';
      const baseError = codeResult.error ?? stderr ?? 'Sandbox execution failed';
      return { status: 'error', error: `Execution error: ${baseError}`, memoryUsedBytes };
    }

    // The result rides at the end of stdout, after any console output, so a
    // stdout CodeSandbox cut at its output limit holds a cut result or none.
    if (codeResult.truncated?.stdout) {
      return {
        status: 'error',
        error: "Execution error: the result and console output passed the in-process executor's output limit of 1 MB",
        memoryUsedBytes,
      };
    }

    const stdout = codeResult.output?.stdout ?? '';
    const idx = stdout.lastIndexOf(FORGE_RESULT_MARKER);
    if (idx < 0) {
      return { status: 'error', error: 'Sandbox returned no recognizable forge result', memoryUsedBytes };
    }
    const json = stdout.slice(idx + FORGE_RESULT_MARKER.length);
    let output: unknown;
    if (json === 'undefined' || json === '') {
      output = undefined;
    } else {
      try {
        output = JSON.parse(json);
      } catch {
        output = json;
      }
    }
    return { status: 'ok', output, memoryUsedBytes };
  }
}
