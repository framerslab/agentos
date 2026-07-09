/**
 * @file CodeSandbox.ts
 * @description Implementation of the Code Execution Sandbox.
 *
 * Provides isolated code execution with security controls:
 * - JavaScript: runs in-process via node:vm with context isolation,
 *   codeGeneration restrictions (eval/Function/WASM blocked), and
 *   frozen safe globals.
 * - Python: spawns a `python3` subprocess via execa with optional
 *   security preambles that monkey-patch filesystem and network access.
 * - Shell: spawns bash (or cmd on Windows) via execa with configurable
 *   network/filesystem restrictions.
 *
 * @module AgentOS/Sandbox
 * @version 2.0.0
 */

import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
/**
 * Lazily load execa on first use.
 *
 * execa@9 pulls import-only ESM dependencies (npm-run-path →
 * unicorn-magic) that require-based CJS interop pipelines (for example
 * tsx transpiling this module for a CommonJS consumer) cannot resolve at
 * require time — a static import crashed such consumers with
 * ERR_PACKAGE_PATH_NOT_EXPORTED before any sandbox code ran. A dynamic
 * import keeps loading this module side-effect-free and resolves execa
 * through the native ESM resolver, which handles those exports.
 * Memoized so the import cost is paid once per process.
 */
let execaModulePromise: Promise<typeof import('execa')> | undefined;
function loadExeca(): Promise<typeof import('execa')> {
  execaModulePromise ??= import('execa');
  return execaModulePromise;
}
import { v4 as uuidv4 } from 'uuid';
import type { ILogger } from '../../../core/logging/ILogger';
import {
  ICodeSandbox,
  SandboxLanguage,
  SandboxConfig,
  ExecutionRequest,
  ExecutionResult,
  SecurityEvent,
  SandboxStats,
  SandboxError,
} from './ICodeSandbox';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000, // 30 seconds
  maxMemoryBytes: 128 * 1024 * 1024, // Nominal budget; JS node:vm reports heap delta only.
  maxOutputBytes: 1024 * 1024, // 1MB
  allowNetwork: false,
  allowFilesystem: false,
  blockedModules: ['fs', 'child_process', 'cluster', 'dgram', 'dns', 'http', 'https', 'net', 'tls', 'vm'],
  maxCpuTimeMs: 10000, // 10 seconds
};

/**
 * Keys that callers MUST NOT be able to override via SandboxConfig.extraGlobals.
 * The hardened context explicitly nulls these to prevent host-state leaks; if
 * we let extraGlobals re-bind them the entire isolation guarantee evaporates.
 * Filtered silently at merge time so a forge-style consumer that includes one
 * of these by accident still gets a working sandbox without a noisy error.
 *
 * Categorized:
 *   - Host-state escape: process, global, globalThis, require
 *   - Code-generation reflection: eval, Function
 *   - Realm-reflection / introspection: Reflect, Proxy
 *   - Memory side-channels (Spectre family): SharedArrayBuffer, Atomics
 *   - Native compilation surface: WebAssembly
 */
const DANGEROUS_GLOBAL_KEYS: ReadonlySet<string> = new Set([
  'process',
  'global',
  'globalThis',
  'require',
  'eval',
  'Function',
  'Reflect',
  'Proxy',
  'WebAssembly',
  'SharedArrayBuffer',
  'Atomics',
]);

/** Dangerous patterns by language */
const DANGEROUS_PATTERNS: Record<SandboxLanguage, RegExp[]> = {
  javascript: [
    /require\s*\(\s*['"`](fs|child_process|cluster|net|dgram|dns|http|https|tls|os|process)['"`]\s*\)/gi,
    /import\s+.*\s+from\s+['"`](fs|child_process|cluster|net|dgram|dns|http|https|tls)['"`]/gi,
    /process\.(exit|kill|env|binding|dlopen)/gi,
    /eval\s*\(/gi,
    /Function\s*\(/gi,
    /new\s+Function/gi,
    /__proto__|__defineGetter__|__defineSetter__/gi,
    /constructor\s*\[\s*['"`]constructor['"`]\s*\]/gi,
  ],
  typescript: [
    /require\s*\(\s*['"`](fs|child_process|cluster|net|dgram|dns|http|https|tls|os|process)['"`]\s*\)/gi,
    /import\s+.*\s+from\s+['"`](fs|child_process|cluster|net|dgram|dns|http|https|tls)['"`]/gi,
    /process\.(exit|kill|env|binding|dlopen)/gi,
    /eval\s*\(/gi,
  ],
  python: [
    /import\s+(os|subprocess|sys|socket|shutil|glob|pathlib|ctypes)/gi,
    /from\s+(os|subprocess|sys|socket|shutil|glob|pathlib|ctypes)\s+import/gi,
    /__import__\s*\(/gi,
    /exec\s*\(/gi,
    /eval\s*\(/gi,
    /open\s*\(/gi,
    /compile\s*\(/gi,
  ],
  shell: [
    /rm\s+-rf?\s+\//gi,
    /dd\s+if=/gi,
    /mkfs/gi,
    /:(){ :|:& };:/gi, // Fork bomb
    />\s*\/dev\/sd[a-z]/gi,
    /curl|wget.*\|.*sh/gi,
  ],
  sql: [
    /DROP\s+(TABLE|DATABASE|SCHEMA)/gi,
    /TRUNCATE\s+TABLE/gi,
    /DELETE\s+FROM\s+\w+\s*;/gi, // DELETE without WHERE
    /UPDATE\s+\w+\s+SET.*;\s*$/gi, // UPDATE without WHERE
    /--\s*$|\/\*|\*\//gi, // SQL comments that could be injection
    /;\s*DROP|;\s*DELETE|;\s*UPDATE|;\s*INSERT/gi, // Chained statements
  ],
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * Code Execution Sandbox implementation.
 *
 * Provides isolated code execution with security controls.
 */
export class CodeSandbox implements ICodeSandbox {
  private logger?: ILogger;
  private defaultConfig: SandboxConfig;
  private executions = new Map<string, ExecutionResult>();
  private runningExecutions = new Map<string, AbortController>();
  private stats: SandboxStats;

  constructor(defaultConfig?: Partial<SandboxConfig>) {
    this.defaultConfig = { ...DEFAULT_CONFIG, ...defaultConfig };
    this.stats = this.createEmptyStats();
  }

  /**
   * Initializes the sandbox.
   */
  public async initialize(logger?: ILogger, defaultConfig?: SandboxConfig): Promise<void> {
    this.logger = logger;
    if (defaultConfig) {
      this.defaultConfig = { ...this.defaultConfig, ...defaultConfig };
    }
    this.logger?.info?.('CodeSandbox initialized');
  }

  /**
   * Executes code in the sandbox.
   */
  public async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const executionId = request.executionId || uuidv4();
    const config = { ...this.defaultConfig, ...request.config };
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    this.stats.totalExecutions++;
    this.stats.byLanguage[request.language] = (this.stats.byLanguage[request.language] || 0) + 1;

    // Validate code for security issues
    const securityEvents = this.validateCode(request.language, request.code);
    const criticalEvents = securityEvents.filter(e => e.severity === 'critical' || e.severity === 'high');

    if (criticalEvents.length > 0) {
      this.stats.failedExecutions++;
      this.stats.securityEventsCount += criticalEvents.length;

      const result: ExecutionResult = {
        executionId,
        status: 'error',
        error: `Security violations detected: ${criticalEvents.map(e => e.description).join('; ')}`,
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
        securityEvents: criticalEvents,
      };
      this.executions.set(executionId, result);
      return result;
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    this.runningExecutions.set(executionId, abortController);

    // Set timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, config.timeoutMs || DEFAULT_CONFIG.timeoutMs!);

    try {
      let result: ExecutionResult;

      switch (request.language) {
        case 'javascript':
          result = await this.executeJavaScript(executionId, request, config, startedAt, startTime);
          break;
        case 'python':
          result = await this.executePython(executionId, request, config, startedAt, startTime);
          break;
        case 'shell':
          result = await this.executeShell(executionId, request, config, startedAt, startTime);
          break;
        default:
          throw new SandboxError(
            `Language "${request.language}" is not currently supported`,
            'error',
            executionId,
          );
      }

      // Update stats
      if (result.status === 'success') {
        this.stats.successfulExecutions++;
      } else if (result.status === 'timeout') {
        this.stats.timedOutExecutions++;
      } else if (result.status === 'killed') {
        this.stats.killedExecutions++;
      } else {
        this.stats.failedExecutions++;
      }

      // Update averages
      this.updateAverages(result);

      // Add any non-critical security events
      if (securityEvents.length > 0) {
        result.securityEvents = [...(result.securityEvents || []), ...securityEvents];
        this.stats.securityEventsCount += securityEvents.length;
      }

      this.executions.set(executionId, result);
      return result;
    } catch (error) {
      this.stats.failedExecutions++;
      const result: ExecutionResult = {
        executionId,
        status: abortController.signal.aborted ? 'timeout' : 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
      };
      this.executions.set(executionId, result);
      return result;
    } finally {
      clearTimeout(timeoutId);
      this.runningExecutions.delete(executionId);
    }
  }

  /**
   * Executes JavaScript code in a hardened VM sandbox using node:vm.
   *
   * Security guarantees:
   * - Isolated context prevents access to host globals (process, require, etc.)
   * - `codeGeneration.strings = false` blocks eval() and new Function() inside the sandbox
   * - `codeGeneration.wasm = false` blocks WebAssembly compilation
   * - Frozen console object prevents prototype chain manipulation
   * - Explicit undefined assignments for dangerous globals (process, global, globalThis)
   */
  private async executeJavaScript(
    executionId: string,
    request: ExecutionRequest,
    config: SandboxConfig,
    startedAt: string,
    startTime: number,
  ): Promise<ExecutionResult> {
    let stdout = '';
    let stderr = '';

    /** Sandboxed console that captures output to local buffers */
    const sandboxConsole = Object.freeze({
      log: (...args: unknown[]) => {
        stdout += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
      },
      error: (...args: unknown[]) => {
        stderr += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
      },
      warn: (...args: unknown[]) => {
        stderr += '[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
      },
      info: (...args: unknown[]) => {
        stdout += '[INFO] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
      },
    });

    /**
     * Context object exposed inside the VM. Only safe built-ins are provided.
     * Dangerous globals are explicitly set to undefined so any reference
     * inside sandbox code throws a clear error rather than leaking host state.
     */
    const contextObj: Record<string, unknown> = {
      console: sandboxConsole,
      JSON, Math, Date, Array, Object, String, Number, Boolean,
      RegExp, Error, Map, Set, WeakMap, WeakSet, Promise,
      parseInt, parseFloat, isNaN, isFinite,
      encodeURI, decodeURI, encodeURIComponent, decodeURIComponent,
      TextEncoder, TextDecoder, URL, URLSearchParams,
      structuredClone,
      atob: globalThis.atob,
      btoa: globalThis.btoa,
      // Explicitly blocked — undefined so references yield clear errors
      process: undefined,
      global: undefined,
      globalThis: undefined,
      require: undefined,
      fetch: undefined,
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      clearTimeout: undefined,
      clearInterval: undefined,
      clearImmediate: undefined,
      queueMicrotask: undefined,
      // Realm intrinsics that node:vm exposes by default but untrusted
      // sandbox code has no legitimate need for. Explicitly nulling them
      // blocks runtime reflection paths (Reflect.construct(Function,...)),
      // Proxy-based prototype-chain attacks, and the SharedArrayBuffer/
      // Atomics Spectre side-channel surface. WebAssembly is already
      // blocked via codeGeneration: { wasm: false } but nulled here for
      // belt-and-suspenders.
      Reflect: undefined,
      Proxy: undefined,
      WebAssembly: undefined,
      SharedArrayBuffer: undefined,
      Atomics: undefined,
    };

    // Merge caller-supplied extras AFTER the hardened defaults so an explicit
    // override (e.g., SandboxedToolForge injecting an allowlisted fetch wrapper)
    // can replace the hardened-undefined values where it makes sense. Keys in
    // DANGEROUS_GLOBAL_KEYS are dropped silently to keep the hardening intact.
    if (config.extraGlobals) {
      for (const [key, value] of Object.entries(config.extraGlobals)) {
        if (!DANGEROUS_GLOBAL_KEYS.has(key)) {
          contextObj[key] = value;
        }
      }
    }

    const context = vm.createContext(contextObj, {
      name: `sandbox-${executionId}`,
      codeGeneration: { strings: false, wasm: false },
    });

    /** Wrap user code in an async IIFE so top-level await works */
    const wrappedCode = `(async () => {\n${request.code}\n})()`;

    const script = new vm.Script(wrappedCode, {
      filename: `sandbox-${executionId}.js`,
    });

    const timeoutMs = config.timeoutMs || DEFAULT_CONFIG.timeoutMs!;

    try {
      // Race the VM execution against a timeout promise.
      // vm.Script.runInContext also accepts a timeout but it only covers
      // synchronous CPU time; the Promise.race covers async code too.
      const result = await Promise.race([
        script.runInContext(context, { timeout: timeoutMs }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Execution timeout')), timeoutMs),
        ),
      ]);

      // Append return value to stdout if one was produced
      if (result !== undefined) {
        stdout += typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      }

      // Truncate oversized output
      const truncated: ExecutionResult['truncated'] = {};
      if (stdout.length > (config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes!)) {
        stdout = stdout.slice(0, config.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
        truncated.stdout = true;
      }
      if (stderr.length > (config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes!)) {
        stderr = stderr.slice(0, config.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
        truncated.stderr = true;
      }

      return {
        executionId,
        status: 'success',
        output: { stdout, stderr, exitCode: 0 },
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
        truncated: Object.keys(truncated).length > 0 ? truncated : undefined,
      };
    } catch (error) {
      stderr += error instanceof Error ? error.message : String(error);
      return {
        executionId,
        status: 'error',
        output: { stdout, stderr, exitCode: 1 },
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Executes Python code by spawning a `python3` subprocess via execa.
   *
   * Security:
   * - When `config.allowNetwork` is false, a preamble is prepended that
   *   poisons network-related modules (socket, urllib, requests, aiohttp, etc.)
   *   so imports raise an error.
   * - When `config.allowFilesystem` is false, a preamble monkey-patches
   *   builtins.open to raise PermissionError and blocks os/shutil/pathlib.
   * - Code is written to a temp file, executed, and the temp file is
   *   unconditionally cleaned up in a finally block.
   */
  private async executePython(
    executionId: string,
    request: ExecutionRequest,
    config: SandboxConfig,
    startedAt: string,
    startTime: number,
  ): Promise<ExecutionResult> {
    const tmpFile = path.join(os.tmpdir(), `agentos-sandbox-${executionId}.py`);

    // Build security preamble that restricts dangerous Python capabilities
    let preamble = '';
    if (!config.allowNetwork) {
      preamble += 'import sys as _sys\n';
      preamble += 'for _mod in ["socket","urllib","urllib2","http","httplib","requests","aiohttp","httpx"]:\n';
      preamble += '    _sys.modules[_mod] = None\n';
    }
    if (!config.allowFilesystem) {
      preamble += 'import builtins as _builtins\n';
      preamble += 'def _restricted_open(*a, **kw): raise PermissionError("Filesystem access disabled in sandbox")\n';
      preamble += '_builtins.open = _restricted_open\n';
      preamble += 'import sys as _sys2\n';
      preamble += 'for _mod in ["os","shutil","pathlib","glob"]:\n';
      preamble += '    _sys2.modules[_mod] = None\n';
    }

    const fullCode = preamble + request.code;
    fs.writeFileSync(tmpFile, fullCode, 'utf-8');

    try {
      const { execa } = await loadExeca();
      const proc = await execa('python3', [tmpFile], {
        timeout: config.timeoutMs || DEFAULT_CONFIG.timeoutMs!,
        cwd: config.workingDir,
        env: { ...process.env, ...(config.envVars || {}) } as Record<string, string>,
        input: request.stdin,
        reject: false, // Don't throw on non-zero exit
      });

      let stdout = proc.stdout || '';
      let stderr = proc.stderr || '';

      // Truncate oversized output
      const truncated: ExecutionResult['truncated'] = {};
      if (stdout.length > (config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes!)) {
        stdout = stdout.slice(0, config.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
        truncated.stdout = true;
      }
      if (stderr.length > (config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes!)) {
        stderr = stderr.slice(0, config.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
        truncated.stderr = true;
      }

      return {
        executionId,
        status: proc.exitCode === 0 ? 'success' : 'error',
        output: { stdout, stderr, exitCode: proc.exitCode ?? 1 },
        error: proc.exitCode !== 0 ? (stderr || `Process exited with code ${proc.exitCode}`) : undefined,
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
        truncated: Object.keys(truncated).length > 0 ? truncated : undefined,
      };
    } catch (error: unknown) {
      // execa throws on timeout with a .timedOut property
      const isTimeout = typeof error === 'object' && error !== null && 'timedOut' in error && (error as { timedOut: boolean }).timedOut;
      return {
        executionId,
        status: isTimeout ? 'timeout' : 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* temp file may not exist if writeFileSync failed */ }
    }
  }

  /**
   * Executes shell commands by spawning bash (or cmd on Windows) via execa.
   *
   * Security:
   * - When `config.allowNetwork` is false, http_proxy and https_proxy
   *   environment variables are set to invalid addresses to block most
   *   HTTP-based network access.
   * - Timeout, cwd, and envVars from config are forwarded to the subprocess.
   * - Dangerous pattern validation (rm -rf /, fork bombs, etc.) is handled
   *   by `validateCode` before this method is called.
   */
  private async executeShell(
    executionId: string,
    request: ExecutionRequest,
    config: SandboxConfig,
    startedAt: string,
    startTime: number,
  ): Promise<ExecutionResult> {
    const shell = process.platform === 'win32' ? 'cmd' : 'bash';
    const shellArgs = process.platform === 'win32'
      ? ['/c', request.code]
      : ['-c', request.code];

    // Build subprocess environment
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(config.envVars || {}),
    };
    if (!config.allowNetwork) {
      env.http_proxy = 'http://0.0.0.0:0';
      env.https_proxy = 'http://0.0.0.0:0';
      env.no_proxy = '';
    }

    try {
      const { execa } = await loadExeca();
      const proc = await execa(shell, shellArgs, {
        timeout: config.timeoutMs || DEFAULT_CONFIG.timeoutMs!,
        cwd: config.workingDir,
        env,
        input: request.stdin,
        reject: false, // Don't throw on non-zero exit
      });

      let stdout = proc.stdout || '';
      let stderr = proc.stderr || '';

      // Truncate oversized output
      const truncated: ExecutionResult['truncated'] = {};
      if (stdout.length > (config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes!)) {
        stdout = stdout.slice(0, config.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
        truncated.stdout = true;
      }
      if (stderr.length > (config.maxOutputBytes || DEFAULT_CONFIG.maxOutputBytes!)) {
        stderr = stderr.slice(0, config.maxOutputBytes) + '\n[OUTPUT TRUNCATED]';
        truncated.stderr = true;
      }

      return {
        executionId,
        status: proc.exitCode === 0 ? 'success' : 'error',
        output: { stdout, stderr, exitCode: proc.exitCode ?? 1 },
        error: proc.exitCode !== 0 ? (stderr || `Process exited with code ${proc.exitCode}`) : undefined,
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
        truncated: Object.keys(truncated).length > 0 ? truncated : undefined,
      };
    } catch (error: unknown) {
      const isTimeout = typeof error === 'object' && error !== null && 'timedOut' in error && (error as { timedOut: boolean }).timedOut;
      return {
        executionId,
        status: isTimeout ? 'timeout' : 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Kills a running execution.
   */
  public async kill(executionId: string): Promise<boolean> {
    const controller = this.runningExecutions.get(executionId);
    if (controller) {
      controller.abort();
      const execution = this.executions.get(executionId);
      if (execution) {
        execution.status = 'killed';
        execution.completedAt = new Date().toISOString();
      }
      return true;
    }
    return false;
  }

  /**
   * Gets the status of an execution.
   */
  public async getExecution(executionId: string): Promise<ExecutionResult | undefined> {
    return this.executions.get(executionId);
  }

  /**
   * Lists recent executions.
   */
  public async listExecutions(limit = 50): Promise<ExecutionResult[]> {
    return Array.from(this.executions.values())
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
  }

  /**
   * Checks if a language is supported.
   */
  public isLanguageSupported(language: string): boolean {
    return ['javascript', 'typescript', 'python', 'shell', 'sql'].includes(language.toLowerCase());
  }

  /**
   * Gets supported languages.
   */
  public getSupportedLanguages(): SandboxLanguage[] {
    return ['javascript', 'python', 'shell', 'sql'];
  }

  /**
   * Gets sandbox statistics.
   */
  public getStats(): SandboxStats {
    return { ...this.stats };
  }

  /**
   * Resets statistics.
   */
  public resetStats(): void {
    this.stats = this.createEmptyStats();
  }

  /**
   * Validates code for security issues.
   */
  public validateCode(language: SandboxLanguage, code: string): SecurityEvent[] {
    const events: SecurityEvent[] = [];
    const patterns = DANGEROUS_PATTERNS[language] || [];

    for (const pattern of patterns) {
      const matches = code.match(pattern);
      if (matches) {
        events.push({
          type: 'blocked_import',
          description: `Potentially dangerous pattern detected: ${matches[0]}`,
          timestamp: new Date().toISOString(),
          severity: this.getSeverityForPattern(pattern, language),
        });
      }
    }

    return events;
  }

  /**
   * Disposes of the sandbox.
   */
  public async dispose(): Promise<void> {
    // Kill all running executions
    for (const [id, controller] of this.runningExecutions) {
      controller.abort();
      this.logger?.info?.(`Killed execution ${id} during disposal`);
    }
    this.runningExecutions.clear();
    this.executions.clear();
    this.logger?.info?.('CodeSandbox disposed');
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private createEmptyStats(): SandboxStats {
    return {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      timedOutExecutions: 0,
      killedExecutions: 0,
      avgDurationMs: 0,
      avgMemoryBytes: 0,
      byLanguage: {} as Record<SandboxLanguage, number>,
      securityEventsCount: 0,
    };
  }

  private updateAverages(result: ExecutionResult): void {
    const total = this.stats.totalExecutions;
    this.stats.avgDurationMs =
      (this.stats.avgDurationMs * (total - 1) + result.durationMs) / total;

    if (result.memoryUsedBytes) {
      this.stats.avgMemoryBytes =
        (this.stats.avgMemoryBytes * (total - 1) + result.memoryUsedBytes) / total;
    }
  }

  private getSeverityForPattern(pattern: RegExp, _language: SandboxLanguage): SecurityEvent['severity'] {
    const source = pattern.source.toLowerCase();

    // Critical patterns - check first as they're most dangerous
    if (
      source.includes('rm\\s+-rf') ||
      source.includes('dd\\s+if=') ||
      source.includes('mkfs') ||
      source.includes('fork bomb') ||
      source.includes(':\\(\\)') ||
      source.includes('/dev/sd')
    ) {
      return 'critical';
    }

    // High severity patterns
    if (
      source.includes('child_process') ||
      source.includes('subprocess') ||
      source.includes('exec\\s*\\(') ||
      source.includes('eval\\s*\\(') ||
      source.includes('drop\\s+') ||
      source.includes('delete\\s+from') ||
      source.includes('truncate')
    ) {
      return 'high';
    }

    // Medium severity patterns
    if (
      source.includes('fs') ||
      source.includes('net') ||
      source.includes('http') ||
      source.includes('os') ||
      source.includes('process') ||
      source.includes('socket') ||
      source.includes('import\\s+os')
    ) {
      return 'medium';
    }

    return 'low';
  }
}
