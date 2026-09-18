/**
 * @fileoverview SandboxedToolForge runs agent-generated JavaScript code in a
 * hardened node:vm sandbox with wall-clock timeouts and API allowlisting.
 *
 * @module @framers/agentos/emergent/SandboxedToolForge
 *
 * Overview:
 * - Delegates the actual VM execution to {@link CodeSandbox}, which provides
 *   the hardened node:vm context (`codeGeneration: { strings: false, wasm: false }`,
 *   frozen console, explicit `process`/`globalThis`/`require`/etc. set to undefined).
 * - Adds the forge-specific contract: code must define `function execute(input)`
 *   or `function run(input)`, and the resolved value is JSON-serialized back to
 *   the caller via a marker-prefixed stdout convention.
 * - Allowlisted APIs (`fetch`, `fs.readFile`, `crypto`) are injected via
 *   `CodeSandbox`'s `extraGlobals` config so the hardened defaults stay intact.
 *
 * Security model:
 * 1. **Static validation** (`validateCode()`) rejects dangerous patterns (regex
 *    scan) before any code reaches the runtime.
 * 2. **Runtime isolation** executes validated code inside `CodeSandbox`'s
 *    hardened minimal context, which exposes only JSON/Math/Date/etc. plus the
 *    explicitly opted-in APIs from this forge's allowlist.
 * 3. **Resource bounding** enforces a wall-clock timeout via node:vm. Memory is
 *    NOT preemptively enforced (node:vm shares the host heap); `memoryUsedBytes`
 *    is reported as a best-effort `process.memoryUsage().heapUsed` delta around
 *    the sandbox call. For real per-isolate memory limits, an isolated-vm soft
 *    dependency would be required (deferred until hosted multi-tenant ships).
 *
 * Allowlisted APIs (each requires explicit opt-in via {@link SandboxAPI}):
 * - `fetch` — HTTP requests, domain-restricted via {@link SandboxedToolForgeConfig.fetchDomainAllowlist}.
 * - `fs.readFile` — Read-only file access, max 1 MB, restricted to the
 *   configured roots after symlink resolution (a link inside a root cannot
 *   be used to reach a file outside one).
 * - `crypto` — Hashing and HMAC only (`createHash`, `createHmac`).
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import type { SandboxExecutionRequest, SandboxExecutionResult, SandboxAPI } from './types.js';
import { CodeSandbox } from '../../safety/sandbox/executor/CodeSandbox.js';

/**
 * Sentinel marker prefixed onto the JSON-serialized forge result inside the
 * sandbox's stdout. Lets the caller separate the forge result from any
 * incidental `console.log` output the user code may produce. Multi-byte
 * NUL-bracketed marker so it cannot collide with normal text content.
 */
const FORGE_RESULT_MARKER = '\u0000__SANDBOX_FORGE_RESULT__\u0000';

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
   * Nominal heap budget in megabytes for telemetry and future isolate-backed
   * execution. The current node:vm implementation cannot preemptively enforce
   * memory limits.
   * @default 128
   */
  memoryMB?: number;

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
 * Runs agent-generated code in a hardened node:vm sandbox via {@link CodeSandbox}.
 *
 * Runtime bounds:
 * - Memory: observed as a heap delta, not preemptively capped
 * - Execution time: configurable wall-clock timeout, default 5000 ms
 * - Blocked APIs: eval, Function, process, require, import, child_process, fs.write*
 *
 * Allowlisted APIs (each requires explicit opt-in):
 * - `fetch`: HTTP requests (domain-restricted)
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

  /**
   * {@link fsReadRoots} with their own symlinks resolved, computed lazily on
   * the first sandboxed read and cached for the life of the forge.
   *
   * Both sides of a containment check have to be real paths: a configured
   * root is frequently itself a link (on macOS `/tmp` is a link to
   * `/private/tmp`), so comparing a resolved file against an unresolved root
   * would deny perfectly legitimate reads.
   */
  private realFsReadRootsPromise: Promise<string[]> | null = null;

  /**
   * Hardened node:vm sandbox shared across all execute() calls. Owns the
   * codeGeneration restriction, frozen console, and explicit-undefined
   * dangerous globals. Reused per forge instance to amortize stats bookkeeping.
   */
  private readonly codeSandbox: CodeSandbox;

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
    this.codeSandbox = new CodeSandbox({ timeoutMs: this.timeoutMs });
  }

  // --------------------------------------------------------------------------
  // PUBLIC: validateCode
  // --------------------------------------------------------------------------

  /**
   * Static analysis of code — reject dangerous patterns before execution.
   *
   * Scans the source string for banned API usage patterns using regex matching.
   * If an API is not present in the allowlist, references to it are also flagged.
   *
   * Checked patterns (always banned):
   * - `eval()`, `new Function()`, `require()`, `import`, `process.*`
   * - `child_process`, `fs.write*`, `fs.unlink`, `fs.rm`, `fs.rmdir`
   *
   * Conditionally banned (when not in allowlist):
   * - `fetch(` — when `'fetch'` is not in the allowlist
   * - `fs.*` — when `'fs.readFile'` is not in the allowlist
   * - `crypto.*` — when `'crypto'` is not in the allowlist
   *
   * @param code - The raw source code string to validate.
   * @param allowlist - The set of APIs the code is permitted to use.
   * @returns An object with `valid: true` if no violations were found, or
   *   `valid: false` with a `violations` array describing each flagged pattern.
   *
   * @example
   * ```ts
   * const forge = new SandboxedToolForge();
   * const result = forge.validateCode('eval("exploit")', []);
   * // result.valid === false
   * // result.violations === ['eval() is forbidden']
   * ```
   */
  /**
   * Translate a raw V8 SyntaxError message into a concrete hint that
   * points the LLM (or the retry loop) at the likely cause. Returns
   * empty string when no known pattern matches — callers still surface
   * the raw message in that case. The hints map to the 4 most common
   * LLM forge mistakes observed in production.
   */
  private resolveReadRoots(): Promise<string[]> {
    const pending = this.realFsReadRootsPromise ?? this.readRootsRealPaths();
    this.realFsReadRootsPromise = pending;
    return pending;
  }

  /**
   * Resolve every configured root once.
   *
   * A fully resolved set is cached for the life of the forge, deliberately:
   * re-resolving per read would let a root symlink be repointed underneath a
   * running sandbox, which is the move this containment check exists to
   * stop. A caller that needs to follow a retargeted root builds a new forge.
   * A set containing an unresolvable root is NOT cached, so a root that
   * becomes readable later is picked up instead of being stranded.
   */
  private async readRootsRealPaths(): Promise<string[]> {
    let allResolved = true;
    const resolved = await Promise.all(
      this.fsReadRoots.map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          // An unresolvable root keeps its lexical form, which simply never
          // matches a real path — an absent root must not widen the sandbox.
          allResolved = false;
          return root;
        }
      }),
    );
    if (!allResolved) this.realFsReadRootsPromise = null;
    return resolved;
  }

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

  validateCode(code: string, allowlist: SandboxAPI[]): { valid: boolean; violations: string[] } {
    const violations: string[] = [];

    // Check always-banned patterns.
    for (const [pattern, message] of ALWAYS_BANNED) {
      if (pattern.test(code)) {
        violations.push(message);
      }
    }

    // Conditionally ban `fetch(` when not allowed.
    if (!allowlist.includes('fetch') && /\bfetch\s*\(/.test(code)) {
      violations.push('fetch() is not in the allowlist');
    }

    // Conditionally ban all `fs.*` when fs.readFile is not allowed.
    // We already caught write/unlink/rm above, but if fs.readFile is not in
    // the allowlist, ban any fs reference.
    if (!allowlist.includes('fs.readFile') && /\bfs\s*\./.test(code)) {
      // Only add if we haven't already flagged a more specific fs violation.
      const hasFsViolation = violations.some((v) => v.startsWith('fs.'));
      if (!hasFsViolation) {
        violations.push('fs access is not in the allowlist');
      }
    }

    // Conditionally ban `crypto` when not allowed.
    if (!allowlist.includes('crypto') && /\bcrypto\s*\./.test(code)) {
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
   * 2. Wrap the agent's code into a self-contained expression that calls `execute`.
   * 3. Run in a Node.js `vm` sandbox with a restricted global context.
   * 4. Parse the output, measure execution time, and return the result.
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

    // Step 3: Wrap the code so it supports `execute(input)` or `run(input)`
    // and emits the JSON-serialized result with a sentinel marker so the
    // caller can pluck it out of stdout (which may also contain incidental
    // user console output).
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

    // Step 4: Build allowlisted-API extras. CodeSandbox provides the safe
    // builtins + hardened-undefined dangerous globals; this only adds the
    // explicit forge allowlist (fetch / fs.readFile / crypto).
    const extraGlobals = this.buildExtraGlobals(request.allowlist);

    // Step 5: Heap snapshot before delegation. Best-effort observability
    // (over-approximates because other event-loop activity allocates too).
    // Not preemptive enforcement; node:vm cannot enforce memory limits.
    const heapBefore = process.memoryUsage().heapUsed;

    // Step 6: Delegate to the hardened CodeSandbox for the actual VM call.
    const codeResult = await this.codeSandbox.execute({
      language: 'javascript',
      code: wrappedCode,
      config: { timeoutMs: timeout, extraGlobals },
    });

    const heapAfter = process.memoryUsage().heapUsed;
    const memoryUsedBytes = Math.max(0, heapAfter - heapBefore);
    const executionTimeMs = Math.round(performance.now() - startTime);

    if (codeResult.status !== 'success') {
      const stderr = codeResult.output?.stderr ?? '';
      const baseError = codeResult.error ?? stderr ?? 'Sandbox execution failed';
      const errorMessage =
        codeResult.status === 'timeout'
          ? `Execution timed out after ${timeout}ms`
          : `Execution error: ${baseError}`;
      return {
        success: false,
        error: errorMessage,
        executionTimeMs,
        memoryUsedBytes,
      };
    }

    // Step 7: Pluck the marker-prefixed JSON result out of stdout.
    const stdout = codeResult.output?.stdout ?? '';
    const idx = stdout.lastIndexOf(FORGE_RESULT_MARKER);
    if (idx < 0) {
      return {
        success: false,
        error: 'Sandbox returned no recognizable forge result',
        executionTimeMs,
        memoryUsedBytes,
      };
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

    return {
      success: true,
      output,
      executionTimeMs,
      memoryUsedBytes,
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE: buildExtraGlobals
  // --------------------------------------------------------------------------

  /**
   * Build the allowlist-injected globals to layer on top of CodeSandbox's
   * hardened defaults. Only the three forge allowlist APIs (fetch, fs,
   * crypto) are injected here; CodeSandbox provides JSON/Math/Date/etc.
   * and the hardened-undefined process/globalThis/require/etc.
   */
  private buildExtraGlobals(allowlist: SandboxAPI[]): Record<string, unknown> {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const extras: Record<string, unknown> = {};

    if (allowlist.includes('fetch')) {
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

    if (allowlist.includes('fs.readFile')) {
      extras.fs = {
        readFile: async (filePath: string) => {
          const resolvedPath = path.resolve(filePath);
          // Containment via path.relative, not a string prefix: a root that
          // already ends in a separator (the filesystem root `/`, a Windows
          // drive root `C:\`) would otherwise be compared against a doubled
          // separator and deny every file beneath it. path.relative also
          // applies the platform's own case rules.
          const withinRoots = (candidate: string, roots: readonly string[]): boolean =>
            roots.some((root) => {
              const relative = path.relative(root, candidate);
              // '' means the candidate IS the root. A relative path that
              // climbs out ('..' or '../x') or stays absolute (a different
              // Windows drive) is outside it. Checking for the '..' segment
              // rather than the '..' prefix keeps a sibling named '..foo'
              // from reading as an escape.
              return (
                relative === '' ||
                (relative !== '..' &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative))
              );
            });

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
          if (!withinRoots(realPath, await this.resolveReadRoots())) {
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

    if (allowlist.includes('crypto')) {
      extras.crypto = {
        randomUUID: () => randomUUID(),
        createHash: (algorithm: string) => createHash(algorithm),
        createHmac: (algorithm: string, key: string) => createHmac(algorithm, key),
      };
    }

    return extras;
  }
}
