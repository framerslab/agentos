/**
 * @fileoverview The seam between the forge and whatever runs forged code.
 *
 * The forge validates a forged tool's source, pre-parses it, and builds the
 * functions its grant allows; an executor runs the source in a realm of its
 * own, calls `execute(input)` or `run(input)`, and returns the value the call
 * resolved to. Nothing here names a backend.
 *
 * @module @framers/agentos/emergent/executor/types
 */

/**
 * Runs forged JavaScript for {@link SandboxedToolForge}.
 *
 * `isolates` is the executor's own claim that forged code reaches nothing of
 * the host (its memory, globals or modules) except through the functions it is
 * handed. The library's in-process executor declares `false`. The library does
 * not check another executor's claim; it is what that executor's author says.
 */
export interface ForgedCodeExecutor {
  /** A short name for logs and reports, such as `in-process`. */
  readonly name: string;
  /** Whether forged code reaches the host only through the functions it is handed. */
  readonly isolates: boolean;
  /**
   * Runs one call. Resolves in every case, a timeout included; the forge
   * reports a rejection as an execution error.
   */
  run(request: ExecutorRunRequest): Promise<ExecutorRunResult>;
}

/** One call of a forged tool, as the forge hands it to an executor. */
export interface ExecutorRunRequest {
  /** The forged source, already validated; it defines `execute(input)` or `run(input)`. */
  readonly code: string;
  /** The call's argument. The forge passes it on as JSON. */
  readonly input: unknown;
  /**
   * The functions the grant allows, under the global names forged code calls
   * them by (`fetch`, `fs`, `crypto`). Under a ceiling they are the broker's.
   */
  readonly globals: Readonly<Record<string, unknown>>;
  /** The call's wall-clock limit, in milliseconds. */
  readonly timeoutMs: number;
  /** The call's memory budget, in megabytes. An executor that cannot enforce it reports usage only. */
  readonly memoryMB: number;
  /**
   * Under a ceiling, aborted when the call's handle ends (its deadline or its
   * end). An executor may stop the guest on it; the broker refuses capability
   * calls after it either way.
   */
  readonly signal?: AbortSignal;
}

/**
 * How a call ended. `output` is the value the call resolved to after a JSON
 * round trip (`undefined` stays `undefined`). `error` is the whole message the
 * forge returns. `memoryUsedBytes` is what the executor measured, or 0.
 */
export type ExecutorRunResult =
  | { readonly status: 'ok'; readonly output: unknown; readonly memoryUsedBytes: number }
  | { readonly status: 'error'; readonly error: string; readonly memoryUsedBytes: number }
  | { readonly status: 'timeout'; readonly memoryUsedBytes: number }
  | { readonly status: 'memory_exceeded'; readonly memoryUsedBytes: number };
