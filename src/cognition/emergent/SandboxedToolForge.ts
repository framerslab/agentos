/**
 * @fileoverview SandboxedToolForge validates agent-generated JavaScript and
 * runs it on an executor; by default in an in-process node:vm context with a
 * wall-clock timeout and the granted functions.
 *
 * @module @framers/agentos/emergent/SandboxedToolForge
 *
 * Overview:
 * - Validates the source (`validateCode()`, a regex blocklist) and pre-parses
 *   it, builds the functions the request's list grants, and hands the run to a
 *   {@link ForgedCodeExecutor}.
 * - The contract with forged code: it defines `function execute(input)` or
 *   `function run(input)`, and the value it resolves to comes back after a
 *   JSON round trip.
 * - The default executor, {@link InProcessExecutor}, runs the code through
 *   CodeSandbox: a node:vm context inside the host's process, with
 *   `codeGeneration: { strings: false, wasm: false }` on the context's own
 *   intrinsics, a frozen console, and `process`/`globalThis`/`require` and
 *   others set to undefined. A host may pass another executor (`executor`).
 *
 * Security model:
 * 1. **Static validation** (`validateCode()`) rejects dangerous patterns (regex
 *    scan) before any code reaches an executor.
 * 2. **The executor** runs the validated code. The in-process executor declares
 *    `isolates: false`: node:vm is not a security mechanism (Node's
 *    documentation), and the context is handed the host's own constructors.
 *    Another executor's `isolates` is its author's claim.
 * 3. **Resource bounding**: the in-process executor enforces a wall-clock
 *    timeout. Memory is NOT preemptively enforced (node:vm shares the host
 *    heap); `memoryUsedBytes` is a best-effort `process.memoryUsage().heapUsed`
 *    delta around the call.
 *
 * Allowlisted APIs (each requires explicit opt-in; a list may name `fs.read`,
 * the catalogue name, or `fs.readFile`, the function it injects):
 * - `fetch` — HTTP requests; {@link SandboxedToolForgeConfig.fetchDomainAllowlist} checks the first URL's host when set.
 * - `fs.readFile` — Read-only file access, max 1 MB, restricted to the
 *   configured roots after symlink resolution (a link inside a root cannot
 *   be used to reach a file outside one).
 * - `crypto` — Hashing and HMAC only (`createHash`, `createHmac`).
 *
 * Under a ceiling (`EmergentConfig.capabilities`) the engine attaches a
 * `CapabilityBroker`: the injected functions are then the broker's, scoped
 * by the ceiling and checked per call, and this forge's own
 * `fetchDomainAllowlist` and `fsReadRoots` are not used.
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { AllowlistName, CapabilityName, SandboxExecutionRequest, SandboxExecutionResult } from './types.js';
import { normalizeAllowlist } from './capabilities.js';
import type { CapabilityBroker } from './broker/CapabilityBroker.js';
import { ReadRoots, withinRoots } from './broker/fs-read.js';
import { InProcessExecutor } from './executor/InProcessExecutor.js';
import type { ExecutorRunResult, ForgedCodeExecutor } from './executor/types.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Configuration options for the {@link SandboxedToolForge}.
 *
 * All fields are optional and fall back to sensible defaults.
 */
export interface SandboxedToolForgeConfig {
  /**
   * Memory budget in megabytes, handed to the executor with each call. The
   * in-process executor reports the memory used and does not limit it; an
   * executor that can limit memory uses it as the limit.
   * @default 128
   */
  memoryMB?: number;

  /**
   * What runs forged code. Defaults to an {@link InProcessExecutor} (node:vm
   * inside this process; `isolates: false`).
   */
  executor?: ForgedCodeExecutor;

  /**
   * Maximum wall-clock execution time in milliseconds.
   * @default 5000
   */
  timeoutMs?: number;

  /**
   * When `fetch` is in the allowlist, only requests to these domains are
   * permitted. An empty array means all domains are allowed.
   * Domain matching is case-insensitive and checks exact host equality.
   * @default []
   */
  fetchDomainAllowlist?: string[];

  /**
   * Filesystem roots sandboxed `fs.readFile` calls may access.
   * Relative paths are resolved from the current working directory.
   * Defaults to the current working directory only.
   */
  fsReadRoots?: string[];
}

// ============================================================================
// BANNED PATTERN DEFINITIONS
// ============================================================================

/**
 * Patterns that are ALWAYS banned regardless of the allowlist.
 * Each entry is a tuple of `[regex, human-readable description]`.
 */
const ALWAYS_BANNED: ReadonlyArray<[RegExp, string]> = [
  [/\beval\s*\(/, 'eval() is forbidden'],
  [/\bFunction\s*\(/, 'Function() is forbidden'],
  [/\bnew\s+Function\s*\(/, 'new Function() is forbidden'],
  [/\brequire\s*\(/, 'require() is forbidden'],
  [/\bimport\s+/, 'import statements are forbidden'],
  [/\bimport\s*\(/, 'dynamic import() is forbidden'],
  [/\bprocess\s*\./, 'process access is forbidden'],
  [/\bchild_process\b/, 'child_process access is forbidden'],
  [/\bfs\s*\.\s*write/, 'fs.write* is forbidden'],
  [/\bfs\s*\.\s*unlink/, 'fs.unlink is forbidden'],
  [/\bfs\s*\.\s*rm\b/, 'fs.rm is forbidden'],
  [/\bfs\s*\.\s*rmdir/, 'fs.rmdir is forbidden'],
  [/\bfs\s*\.\s*appendFile/, 'fs.appendFile is forbidden'],
  [/\bfs\s*\.\s*truncate/, 'fs.truncate is forbidden'],
];

// ============================================================================
// SANDBOXED TOOL FORGE
// ============================================================================

/**
 * Validates agent-generated code and runs it on an executor, by default in an in-process
 * node:vm context ({@link InProcessExecutor}). `node:vm` is not a security mechanism
 * (Node's documentation): the checks here hold for
 * code that acts through the injected functions, and memory is reported, not limited.
 *
 * Runtime bounds:
 * - Memory: observed as a heap delta, not preemptively capped
 * - Execution time: configurable wall-clock timeout, default 5000 ms
 * - Blocked APIs: eval, Function, process, require, import, child_process, fs.write*
 *
 * Allowlisted APIs (each requires explicit opt-in):
 * - `fetch`: HTTP requests (the first URL's host is checked when `fetchDomainAllowlist` is set)
 * - `fs.readFile`: Read-only file access (path-restricted, max 1 MB)
 * - `crypto`: Hashing and HMAC only
 *
 * @example
 * ```ts
 * const forge = new SandboxedToolForge({ timeoutMs: 3000 });
 *
 * const result = await forge.execute({
 *   code: 'function execute(input) { return input.a + input.b; }',
 *   input: { a: 2, b: 3 },
 *   allowlist: [],
 *   memoryMB: 128,
 *   timeoutMs: 3000,
 * });
 *
 * console.log(result.output); // 5
 * ```
 */
export class SandboxedToolForge {
  /** Resolved memory limit in MB. */
  private readonly memoryMB: number;

  /** Resolved timeout in milliseconds. */
  private readonly timeoutMs: number;

  /** Domain allowlist for sandboxed `fetch` calls. */
  private readonly fetchDomainAllowlist: string[];

  /** Filesystem roots sandboxed reads may access. */
  private readonly fsReadRoots: string[];

  /** The roots' real paths, pinned per root on first success (see `ReadRoots`). */
  private readonly readRoots: ReadRoots;

  /** The engine's broker under a ceiling; absent on the legacy path. */
  private broker: CapabilityBroker | undefined;

  /** What runs forged code: the in-process executor unless the host passed one. */
  readonly executor: ForgedCodeExecutor;

  /**
   * Create a new SandboxedToolForge instance.
   *
   * @param config - Optional configuration overrides. All fields have sensible
   *   defaults (128 MB memory, 5000 ms timeout, no domain restrictions).
   */
  constructor(config?: SandboxedToolForgeConfig) {
    this.memoryMB = config?.memoryMB ?? 128;
    this.timeoutMs = config?.timeoutMs ?? 5000;
    this.fetchDomainAllowlist = (config?.fetchDomainAllowlist ?? []).map((d) => d.toLowerCase());
    this.fsReadRoots = (config?.fsReadRoots ?? [process.cwd()]).map((root) => path.resolve(root));
    this.readRoots = new ReadRoots(this.fsReadRoots);
    this.executor = config?.executor ?? new InProcessExecutor();
  }

  /**
   * The options this forge runs with, defaults applied. The engine reads them
   * to check a host-built forge against a ceiling.
   */
  effectiveOptions(): { memoryMB: number; timeoutMs: number; fetchDomainAllowlist: string[]; fsReadRoots: string[] } {
    return {
      memoryMB: this.memoryMB,
      timeoutMs: this.timeoutMs,
      fetchDomainAllowlist: [...this.fetchDomainAllowlist],
      fsReadRoots: [...this.fsReadRoots],
    };
  }

  /**
   * Under a ceiling the engine attaches its broker: from then on the
   * functions injected into forged code are the broker's, and every
   * execution needs a call handle. A forge serves one broker.
   *
   * @throws Error when a different broker is already attached.
   */
  attachBroker(broker: CapabilityBroker): void {
    if (this.broker && this.broker !== broker) {
      throw new Error('broker_already_attached: a forge under a ceiling serves one engine');
    }
    this.broker = broker;
  }

  // --------------------------------------------------------------------------
  // PRIVATE: describeSyntaxError
  // --------------------------------------------------------------------------

  /**
   * Translate a raw V8 SyntaxError message into a concrete hint that
   * points the LLM (or the retry loop) at the likely cause. Returns
   * empty string when no known pattern matches — callers still surface
   * the raw message in that case. The hints map to the 4 most common
   * LLM forge mistakes observed in production.
   */
  private describeSyntaxError(message: string): string {
    const m = message || '';
    if (/Unexpected token 'const'/.test(m) || /Unexpected token 'let'/.test(m)) {
      return (
        'A `const` or `let` appeared in a position JavaScript does not allow. ' +
        'Common causes: arrow function without braces (`() => const x = 1` — wrap in `{}` and add `return`), ' +
        '`if (x) const y = 1` without a block, or a declaration used as an expression. ' +
        'Every `if`/`for`/`while` body must use block braces; every arrow fn that declares variables must use `{ ... }` and `return`.'
      );
    }
    if (/Unexpected token '?:'?/.test(m)) {
      return (
        'Unexpected `:` — most likely a TypeScript type annotation leaked into the output. ' +
        'Output must be pure JavaScript. Remove all `: type` annotations, `interface` blocks, and generic brackets `<T>`.'
      );
    }
    if (/Unexpected reserved word/.test(m) && /interface|type/.test(m)) {
      return (
        'TypeScript-only keyword leaked into the output. Remove `interface`, `type`, `enum`, and `implements` — emit pure JavaScript only.'
      );
    }
    if (/Unexpected identifier/.test(m)) {
      return (
        'Two identifiers appeared adjacent without a binding keyword. ' +
        'Commonly caused by missing commas in objects or missing semicolons between statements.'
      );
    }
    if (/Unexpected end of input/.test(m)) {
      return 'Code is missing a closing `}`, `)`, or `]` somewhere. Check all brace/paren pairs.';
    }
    return '';
  }

  // --------------------------------------------------------------------------
  // PUBLIC: validateCode
  // --------------------------------------------------------------------------

  /**
   * Static analysis of code — reject dangerous patterns before execution.
   *
   * Scans the source string for banned API usage patterns using regex
   * matching. The list is read in catalogue names first (`fs.readFile`
   * stands for `fs.read`), so a list naming either one allows `fs.` access.
   *
   * Checked patterns (always banned):
   * - `eval()`, `new Function()`, `require()`, `import`, `process.*`
   * - `child_process`, `fs.write*`, `fs.unlink`, `fs.rm`, `fs.rmdir`
   *
   * Conditionally banned (when the list does not grant them):
   * - `fetch(` — without `fetch`
   * - `fs.*` — without `fs.read` (or its alias `fs.readFile`)
   * - `crypto.*` — without `crypto`
   *
   * @param code - The raw source code string to validate.
   * @param allowlist - The capabilities the code may use, in either name.
   * @returns `valid: true` with no violations, or `valid: false` with a
   *   `violations` array describing each flagged pattern.
   *
   * @example
   * ```ts
   * const forge = new SandboxedToolForge();
   * const result = forge.validateCode('eval("exploit")', []);
   * // result.valid === false
   * // result.violations === ['eval() is forbidden']
   * ```
   */
  validateCode(code: string, allowlist: readonly AllowlistName[]): { valid: boolean; violations: string[] } {
    const violations: string[] = [];
    const granted = normalizeAllowlist(allowlist).capabilities;

    // Check always-banned patterns.
    for (const [pattern, message] of ALWAYS_BANNED) {
      if (pattern.test(code)) {
        violations.push(message);
      }
    }

    // Conditionally ban `fetch(` when not granted.
    if (!granted.includes('fetch') && /\bfetch\s*\(/.test(code)) {
      violations.push('fetch() is not in the allowlist');
    }

    // Without fs.read, ban any fs reference (writes, unlinks and removals
    // were caught above).
    if (!granted.includes('fs.read') && /\bfs\s*\./.test(code)) {
      // Only add if we haven't already flagged a more specific fs violation.
      const hasFsViolation = violations.some((v) => v.startsWith('fs.'));
      if (!hasFsViolation) {
        violations.push('fs access is not in the allowlist');
      }
    }

    // Conditionally ban `crypto` when not granted.
    if (!granted.includes('crypto') && /\bcrypto\s*\./.test(code)) {
      violations.push('crypto access is not in the allowlist');
    }

    return violations.length === 0 ? { valid: true, violations: [] } : { valid: false, violations };
  }

  // --------------------------------------------------------------------------
  // PUBLIC: execute
  // --------------------------------------------------------------------------

  /**
   * Execute agent-generated code in the sandbox.
   *
   * The code must define a function named `execute` that accepts a single
   * argument and returns the output:
   *
   * ```js
   * function execute(input) { return input.a + input.b; }
   * ```
   *
   * Execution flow:
   * 1. Run `validateCode()` — reject immediately if violations are found.
   * 2. Pre-parse the source; a syntax error comes back with a hint.
   * 3. Build the functions the list grants (the broker's under a ceiling).
   * 4. Hand the run to the executor and turn its answer into the result.
   *
   * @param request - The execution request containing code, input, allowlist,
   *   and resource limits.
   * @returns A {@link SandboxExecutionResult} with the output (on success) or
   *   error description (on failure), plus execution time telemetry.
   *
   * @example
   * ```ts
   * const result = await forge.execute({
   *   code: 'function execute(input) { return { sum: input.a + input.b }; }',
   *   input: { a: 10, b: 20 },
   *   allowlist: [],
   *   memoryMB: 128,
   *   timeoutMs: 5000,
   * });
   * // result.success === true
   * // result.output === { sum: 30 }
   * ```
   */
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const timeout = request.timeoutMs ?? this.timeoutMs;
    const startTime = performance.now();

    // Under a ceiling every run carries its call handle: the broker keys what
    // is in flight by it and refuses capability calls once it has ended.
    if (this.broker && !request.call) {
      return {
        success: false,
        error: 'call_handle_required: under a ceiling every execution carries a call handle (request.call)',
        executionTimeMs: Math.round(performance.now() - startTime),
        memoryUsedBytes: 0,
      };
    }

    // Step 1: Static validation (regex blocklist).
    const validation = this.validateCode(request.code, request.allowlist);
    if (!validation.valid) {
      return {
        success: false,
        error: `Code validation failed: ${validation.violations.join('; ')}`,
        executionTimeMs: Math.round(performance.now() - startTime),
        memoryUsedBytes: 0,
      };
    }

    // Step 2: Pre-parse via AsyncFunction in the host realm. Parse-only
    // probe (never executes) that surfaces SyntaxError early with hints.
    // Without this, LLM-generated code with a leaked TypeScript annotation
    // or arrow-function-without-block error would surface as the same
    // opaque message every retry, starving the judge of actionable signal.
    try {
      const AsyncFunctionCtor = Object.getPrototypeOf(async function () {
        /* pre-parse probe */
      }).constructor as typeof Function;
      new AsyncFunctionCtor('return (async () => {' + request.code + '})();');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = this.describeSyntaxError(msg);
      return {
        success: false,
        error: `SyntaxError before execution: ${msg}${hint ? ` | Hint: ${hint}` : ''}`,
        executionTimeMs: Math.round(performance.now() - startTime),
        memoryUsedBytes: 0,
      };
    }

    // Step 3: The injected functions, for the list read in catalogue names.
    // Under a ceiling they are the broker's, scoped and checked per call;
    // otherwise this forge's own.
    const granted = normalizeAllowlist(request.allowlist).capabilities;
    const globals =
      this.broker && request.call
        ? this.broker.functionsFor(granted, request.call)
        : this.buildExtraGlobals(granted);

    // Step 4: The executor runs the code and calls its entry point; by
    // default in-process, through CodeSandbox. A rejection is a fault in the
    // executor and reads as an execution error.
    const memoryMB = request.memoryMB ?? this.memoryMB;
    let ran: ExecutorRunResult;
    try {
      ran = await this.executor.run({
        code: request.code,
        input: request.input,
        globals,
        timeoutMs: timeout,
        memoryMB,
        signal: request.call?.signal,
      });
    } catch (err: unknown) {
      ran = {
        status: 'error',
        error: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        memoryUsedBytes: 0,
      };
    }
    const executionTimeMs = Math.round(performance.now() - startTime);

    switch (ran.status) {
      case 'ok':
        return { success: true, output: ran.output, executionTimeMs, memoryUsedBytes: ran.memoryUsedBytes };
      case 'timeout':
        return {
          success: false,
          error: `Execution timed out after ${timeout}ms`,
          executionTimeMs,
          memoryUsedBytes: ran.memoryUsedBytes,
        };
      case 'memory_exceeded':
        return {
          success: false,
          error: `Execution exceeded its memory limit of ${memoryMB} MB`,
          executionTimeMs,
          memoryUsedBytes: ran.memoryUsedBytes,
        };
      case 'error':
        return { success: false, error: ran.error, executionTimeMs, memoryUsedBytes: ran.memoryUsedBytes };
    }
  }

  // --------------------------------------------------------------------------
  // PRIVATE: buildExtraGlobals
  // --------------------------------------------------------------------------

  /**
   * The legacy path's injected functions (no ceiling), for a list in
   * catalogue names: `fetch` checks only the first URL's host against
   * `fetchDomainAllowlist` and follows redirects; `fs.readFile` reads under
   * `fsReadRoots` with a 1 MB limit; `crypto` is unscoped. The in-process
   * executor's CodeSandbox provides JSON/Math/Date/etc. and the removed
   * process/globalThis/require.
   */
  private buildExtraGlobals(granted: readonly CapabilityName[]): Record<string, unknown> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const extras: Record<string, unknown> = {};

    if (granted.includes('fetch')) {
      const domainAllowlist = this.fetchDomainAllowlist;
      extras.fetch = async (
        urlOrRequest: string | { url: string },
        init?: Record<string, unknown>,
      ) => {
        const urlStr = typeof urlOrRequest === 'string' ? urlOrRequest : urlOrRequest.url;
        const url = new URL(urlStr);
        const host = url.hostname.toLowerCase();
        if (domainAllowlist.length > 0 && !domainAllowlist.includes(host)) {
          throw new Error(`fetch blocked: domain "${host}" is not in the allowlist`);
        }
        return globalThis.fetch(urlStr, init as any);
      };
    }

    if (granted.includes('fs.read')) {
      extras.fs = {
        readFile: async (filePath: string) => {
          const resolvedPath = path.resolve(filePath);

          // Lexical pass: rejects the obvious `../../etc/passwd` shape before
          // the sandbox pays for any filesystem call.
          if (!withinRoots(resolvedPath, this.fsReadRoots)) {
            throw new Error(
              `fs.readFile blocked: path "${resolvedPath}" is outside the allowed roots`,
            );
          }

          // Lexical containment is NOT containment. A symlink sitting inside
          // an allowed root resolves to an in-root string while pointing at
          // any file on the machine, so string-prefix checking alone reads
          // whatever the link targets (CWE-22). Follow the link chain and
          // re-check against the roots' own real paths.
          //
          // The path has already cleared the lexical check, so a resolution
          // failure here names something inside an allowed root: surface the
          // filesystem's own error (ENOENT and friends) rather than masking
          // a missing file as a containment failure.
          const realPath = await realpath(resolvedPath);
          if (!withinRoots(realPath, await this.readRoots.real())) {
            throw new Error(
              `fs.readFile blocked: path "${resolvedPath}" resolves outside the allowed roots`,
            );
          }

          // Read the RESOLVED path, not the caller's string: re-resolving the
          // original would walk the link a second time, and the link can be
          // repointed between the two walks. (A component of the resolved
          // path could still be swapped for a link in that window — closing
          // that needs an O_NOFOLLOW handle, which node's fs/promises does
          // not expose; it requires local write access inside an allowed
          // root, which is already outside this sandbox's threat model.)
          const data = await readFile(realPath);
          if (data.byteLength > 1_048_576) {
            throw new Error(
              `fs.readFile blocked: file exceeds 1 MB limit (${data.byteLength} bytes)`,
            );
          }
          return data.toString('utf-8');
        },
      };
    }

    if (granted.includes('crypto')) {
      extras.crypto = {
        randomUUID: () => randomUUID(),
        createHash: (algorithm: string) => createHash(algorithm),
        createHmac: (algorithm: string, key: string) => createHmac(algorithm, key),
      };
    }

    return extras;
  }
}
