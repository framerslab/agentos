/**
 * @fileoverview Abstract base class for CLI subprocess bridges.
 * Uses the template method pattern: owns subprocess lifecycle (spawn, pipe,
 * parse NDJSON, timeout/abort) while subclasses implement CLI-specific
 * flag assembly, error classification, and stream event parsing.
 *
 * This is a first-class AgentOS core capability — any provider, extension,
 * tool, or skill can extend this to manage external CLI binaries.
 *
 * @module agentos/sandbox/subprocess/CLISubprocessBridge
 * @see ClaudeCodeCLIBridge
 */

import type { ResultPromise } from 'execa';

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
  // Do NOT let a rejection stick. Node re-attempts a failed module
  // *resolution* on the next import(), so memoizing the rejected promise
  // would be stricter than the platform: one transient failure (a partial
  // install, a racing package manager) would poison every later sandbox and
  // CLI call for the lifetime of the process. Drop the cache on failure and
  // rethrow, so the next caller retries exactly as a bare import() would.
  execaModulePromise ??= import('execa').catch((err) => {
    execaModulePromise = undefined;
    throw err;
  });
  return execaModulePromise;
}
import { CLISubprocessError } from './errors';
import type {
  BridgeOptions,
  BridgeResult,
  StreamEvent,
  OutputFormat,
  InstallCheckResult,
} from './types';

/** Default subprocess timeout (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Abstract base class for managing CLI subprocesses via execa.
 *
 * Subclasses implement four methods:
 * - {@link binaryName} — the CLI binary on PATH
 * - {@link buildArgs} — CLI-specific flag assembly
 * - {@link classifyError} — error classification with guidance
 * - {@link parseStreamEvent} — stream-json event parsing
 *
 * The base class handles:
 * - Binary installation detection (`which` + version parsing)
 * - Authentication health checks
 * - Non-streaming execution with JSON result parsing
 * - Streaming execution with NDJSON line splitting
 * - Timeout and abort signal management
 *
 * @example
 * class MyToolBridge extends CLISubprocessBridge {
 *   protected readonly binaryName = 'mytool';
 *   protected buildArgs(opts, fmt) { return ['-p', '--format', fmt]; }
 *   protected classifyError(err) { return new CLISubprocessError(...); }
 *   protected parseStreamEvent(raw) { return { type: 'text_delta', text: raw.text }; }
 * }
 */
export abstract class CLISubprocessBridge {

  /* ---- Abstract: each CLI must implement ---- */

  /** The CLI binary name on PATH (e.g. 'claude', 'gemini', 'ffmpeg'). */
  protected abstract readonly binaryName: string;

  /**
   * Build the CLI argument array for a given call.
   * Called by {@link execute} and {@link stream} with the appropriate output format.
   *
   * @param options — caller-provided bridge options
   * @param format — 'json' for execute(), 'stream-json' for stream()
   * @returns array of CLI arguments
   */
  protected abstract buildArgs(options: BridgeOptions, format: OutputFormat): string[];

  /**
   * Classify a subprocess error into a typed {@link CLISubprocessError}.
   * Examines stderr, exit code, error.code to produce actionable guidance.
   *
   * @param error — the raw error from execa
   * @returns a CLISubprocessError (or subclass) with guidance and recoverability
   */
  protected abstract classifyError(error: any): CLISubprocessError;

  /**
   * Parse a raw JSON object from stream-json output into a typed {@link StreamEvent}.
   * Returns null for events that should be skipped (progress spinners, etc.).
   *
   * @param raw — a parsed JSON object from one line of NDJSON stdout
   * @returns a typed StreamEvent, or null to skip
   */
  protected abstract parseStreamEvent(raw: any): StreamEvent | null;

  /* ---- Virtual: override if your CLI differs ---- */

  /**
   * Parse the JSON stdout from `--output-format json`.
   * Default implementation: JSON.parse with graceful fallback to raw text.
   * Override if your CLI's JSON output has a different shape.
   */
  protected parseJsonResult(stdout: string, durationMs: number): BridgeResult {
    try {
      const parsed = JSON.parse(stdout.trim());
      return {
        result: parsed.result ?? parsed.message ?? parsed.response ?? stdout.trim(),
        sessionId: parsed.session_id,
        usage: parsed.usage
          ? { input_tokens: parsed.usage.input_tokens ?? 0, output_tokens: parsed.usage.output_tokens ?? 0 }
          : undefined,
        isError: parsed.is_error === true,
        durationMs,
      };
    } catch {
      return { result: stdout.trim(), isError: false, durationMs };
    }
  }

  /**
   * Build args and stdin for the lightweight authentication check.
   * Override for CLI-specific flags (e.g. Claude needs --bare --max-turns 1).
   */
  protected buildAuthCheckArgs(): { args: string[]; stdin: string } {
    return {
      args: ['-p', '--output-format', 'json'],
      stdin: 'Reply with exactly: pong',
    };
  }

  /**
   * Parse a version string from the CLI's --version output.
   * Default: extracts first semver-like pattern (/\d+\.\d+\.\d+/).
   */
  protected parseVersion(stdout: string): string {
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }

  /* ---- Concrete: shared lifecycle ---- */

  /**
   * Check if the binary is installed and on PATH.
   * Returns the resolved path and parsed version string if found.
   */
  async checkBinaryInstalled(): Promise<InstallCheckResult> {
    try {
      const { execa } = await loadExeca();
      const whichResult = await execa('which', [this.binaryName]);
      const binaryPath = whichResult.stdout.trim();

      const versionResult = await execa(this.binaryName, ['--version']);
      const version = this.parseVersion(versionResult.stdout);

      return { installed: true, binaryPath, version };
    } catch {
      return { installed: false };
    }
  }

  /**
   * Check if the CLI is authenticated via a lightweight ping.
   * Uses {@link buildAuthCheckArgs} for CLI-specific flags.
   */
  async checkAuthenticated(): Promise<boolean> {
    try {
      const { args, stdin } = this.buildAuthCheckArgs();
      const { execa } = await loadExeca();
      await execa(this.binaryName, args, { input: stdin, timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Non-streaming execution.
   * Spawns the binary with `--output-format json`, pipes prompt via stdin,
   * and returns the parsed result.
   *
   * @param options — bridge options (prompt, system prompt, model, etc.)
   * @returns parsed result with text, session ID, usage, and timing
   * @throws {CLISubprocessError} on subprocess failure (via {@link classifyError})
   */
  async execute(options: BridgeOptions): Promise<BridgeResult> {
    const args = this.buildArgs(options, 'json');
    const startMs = Date.now();

    try {
      const { execa } = await loadExeca();
      const result = await execa(this.binaryName, args, {
        input: options.prompt,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        cancelSignal: options.abortSignal,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      });

      const durationMs = Date.now() - startMs;
      return this.parseJsonResult(result.stdout, durationMs);
    } catch (error: any) {
      throw this.classifyError(error);
    }
  }

  /**
   * Streaming execution.
   * Spawns the binary with `--output-format stream-json` and yields
   * {@link StreamEvent}s parsed from newline-delimited JSON on stdout.
   *
   * @param options — bridge options
   * @yields typed stream events (text_delta, result, error, system)
   * @throws {CLISubprocessError} on subprocess failure (via {@link classifyError})
   */
  async *stream(options: BridgeOptions): AsyncGenerator<StreamEvent, void, undefined> {
    const args = this.buildArgs(options, 'stream-json');

    let subprocess: ResultPromise;
    try {
      const { execa } = await loadExeca();
      subprocess = execa(this.binaryName, args, {
        input: options.prompt,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        cancelSignal: options.abortSignal,
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      });
    } catch (error: any) {
      throw this.classifyError(error);
    }

    let buffer = '';

    try {
      for await (const chunk of subprocess.stdout as AsyncIterable<Buffer | string>) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = this.parseStreamEvent(JSON.parse(trimmed));
            if (event) yield event;
          } catch {
            /* skip unparseable lines (progress spinners, etc.) */
          }
        }
      }

      /* flush remaining buffer */
      if (buffer.trim()) {
        try {
          const event = this.parseStreamEvent(JSON.parse(buffer.trim()));
          if (event) yield event;
        } catch { /* ignore */ }
      }

      /* Ensure non-zero exits after stdout drains still surface as errors. */
      await subprocess;
    } catch (error: any) {
      throw this.classifyError(error);
    }
  }
}
