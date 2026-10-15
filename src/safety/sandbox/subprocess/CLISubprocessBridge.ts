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

import { StringDecoder } from 'node:string_decoder';
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
  StreamParseContext,
  OutputFormat,
  InstallCheckResult,
} from './types';

/** Default subprocess timeout (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The error of a run the caller cancelled after it had settled, as execa
 * 10.0.1 reports a run whose `cancelSignal` aborts before it settles: the
 * run's own fields with `failed` and `isCanceled` set, execa's message for a
 * cancelled run, and the signal's reason as `cause` (getErrorProperties in
 * lib/return/result.js, getErrorPrefix in lib/return/message.js). The process
 * had exited by itself, so no signal ended it and `isTerminated` stays false.
 *
 * @param result — the run's result, as execa resolved it
 * @param signal — the caller's signal, which has aborted
 * @returns an error shaped as execa's for a cancelled run
 */
function cancelledRunError(result: unknown, signal: AbortSignal): Error {
  const run: Record<string, unknown> =
    result !== null && typeof result === 'object' ? { ...(result as Record<string, unknown>) } : {};
  const command = typeof run.escapedCommand === 'string' ? `: ${run.escapedCommand}` : '';
  return Object.assign(new Error(`Command was canceled${command}`), run, {
    failed: true,
    isCanceled: true,
    cause: signal.reason,
  });
}

/**
 * A process's stdout as {@link CLISubprocessBridge.stream} reads it: execa's
 * Readable, which can be destroyed, or any async iterable of output.
 */
type StdoutSource = AsyncIterable<Buffer | string> & { destroy?: () => void };

/**
 * What {@link CLISubprocessBridge.stream} has read from a process's stdout
 * and not yet yielded.
 */
interface StdoutReader {
  /** The events parsed since the last call, in order; the reader keeps none of them. */
  take(): StreamEvent[];
  /** Resolves once more events have been parsed, or stdout has ended. */
  arrival(): Promise<void>;
  /** Set once stdout has ended, or reading it failed. */
  readonly ended: boolean;
  /** Set when reading stdout failed, with the error. */
  readonly failure: { error: unknown } | undefined;
  /** Stops reading: drops what is queued, and destroys stdout when it can be destroyed. */
  stop(): void;
}

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
   * @param context — what the bridge keeps across the lines of this stream
   *   ({@link StreamParseContext}): {@link stream} passes the same object for
   *   every line of one stream, and a new one for each stream. An
   *   implementation that needs no state leaves the parameter out.
   * @returns a typed StreamEvent, or null to skip
   */
  protected abstract parseStreamEvent(raw: any, context?: StreamParseContext): StreamEvent | null;

  /* ---- Virtual: override if your CLI differs ---- */

  /**
   * Parse the JSON stdout from `--output-format json`.
   * Default implementation: JSON.parse with graceful fallback to raw text.
   * Override if your CLI's JSON output has a different shape.
   *
   * {@link execute} reads a failed run's stdout with it too, for a result the
   * CLI flagged as a failure. An override may throw on stdout it cannot read
   * there, such as a failure the CLI writes as text: execute() catches the
   * throw and classifies the run with {@link classifyError}.
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
   * Classify a failed run whose JSON result on stdout the CLI flagged as a
   * failure ({@link parseJsonResult} returned `isError`). Default: the run is
   * classified as any failed run is, by {@link classifyError}. Override to
   * report the failure the result names; ClaudeCodeCLIBridge does.
   *
   * @param _result — the run's JSON result, as {@link parseJsonResult} read it
   * @param error — the raw error from execa
   * @returns a CLISubprocessError (or subclass) for the failed run
   */
  protected classifyErrorResult(_result: BridgeResult, error: any): CLISubprocessError {
    return this.classifyError(error);
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
   * A failed run whose stdout holds a JSON result the CLI flagged as a
   * failure is classified by {@link classifyErrorResult}, unless the caller
   * cancelled it; any other failed run by {@link classifyError}. That
   * includes a failed run whose stdout {@link parseJsonResult} throws on: the
   * throw is caught, and the run has no JSON result to report.
   *
   * @param options — bridge options (prompt, system prompt, model, etc.)
   * @returns parsed result with text, session ID, usage, and timing
   * @throws {CLISubprocessError} on subprocess failure (via {@link classifyErrorResult} or {@link classifyError})
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
      /* A CLI can write its JSON result, flag it as a failure and then exit
       * non-zero. The result says what failed, which the exit code and stderr
       * need not: Claude Code's own SDK replaces the process's exit error
       * with the error result's text unless the run was aborted
       * (Query.readMessages in @anthropic-ai/claude-agent-sdk 0.3.296). A
       * call the caller cancelled stays an abort. */
      if (!error?.isCanceled && typeof error?.stdout === 'string' && error.stdout.trim() !== '') {
        /* An override of parseJsonResult() can throw on stdout that is not
         * JSON, such as a failure the CLI writes as text: the run then has no
         * JSON result to report, and is classified below like any other. */
        let reported: BridgeResult | undefined;
        try {
          reported = this.parseJsonResult(error.stdout, Date.now() - startMs);
        } catch { /* no JSON result to report */ }
        if (reported?.isError) throw this.classifyErrorResult(reported, error);
      }
      throw this.classifyError(error);
    }
  }

  /**
   * Streaming execution.
   * Spawns the binary with `--output-format stream-json` and yields
   * {@link StreamEvent}s parsed from newline-delimited JSON on stdout.
   *
   * stdout is read as the CLI writes it, whatever the consumer's pace, and
   * its events wait in a queue until the consumer takes them. The run thus
   * settles when the CLI exits, and the timeout measures the CLI, not the
   * consumer. Read to its end, the stream awaits the process's exit and
   * throws on a failed one. It throws as well on a call the caller aborted
   * before the consumer had read the stream to its end, though the CLI may
   * have exited first: the run is classified as execa's cancelled run. A
   * consumer that stops reading before the end (a `break` in its
   * `for await`, or `return()`) ends the process instead: it is killed, and
   * its stdout is no longer read. The run's outcome is handled from the
   * moment the process starts, so a failure while the consumer is busy
   * between two events, or after it has stopped reading, is no unhandled
   * rejection in the host.
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
    /* execa settles the run once the process has exited and its stdout has
     * ended, which can happen while this generator waits at a yield for a
     * consumer still busy with an earlier event, or after the consumer has
     * stopped reading. A rejection nothing handles then is raised by Node as
     * an uncaught exception by default, so the outcome is handled from the
     * start; the await below still throws a failure. Promise.resolve returns
     * execa's run itself (a native Promise) and takes any other value as the
     * await below does. */
    Promise.resolve(subprocess).catch(() => undefined);

    const stdout = this.readStdout(subprocess.stdout as StdoutSource);
    /* Set once stdout has been read to its end and the run is awaited below.
     * A consumer that stops reading early (a break in its for await, or
     * return()) closes this generator at a yield, before that point. */
    let readToEnd = false;

    try {
      for (;;) {
        const events = stdout.take();
        for (const event of events) yield event;
        if (events.length > 0) continue;
        if (stdout.ended) break;
        await stdout.arrival();
      }
      if (stdout.failure) throw stdout.failure.error;

      readToEnd = true;
      /* Ensure non-zero exits after stdout drains still surface as errors. */
      const result = await subprocess;
      /* execa fails a run for the caller's abort only until the run settles
       * (lib/terminate/cancel.js and handlePromise in
       * lib/methods/main-async.js, execa 10.0.1), and the run settles when the
       * CLI exits, which can be well before the consumer reads the stream to
       * its end, here. An abort until then ends the stream as a cancelled run
       * still, as it did when the run settled at the consumer's pace: a
       * consumer that has taken the last event has not yet seen the stream
       * end, and a provider yields its final chunk only after it. */
      if (options.abortSignal?.aborted) throw cancelledRunError(result, options.abortSignal);
    } catch (error: any) {
      throw this.classifyError(error);
    } finally {
      /* Left before the run was awaited: nothing reads the process any more.
       * Stop reading its stdout and end it (execa's kill: SIGTERM, then
       * SIGKILL if it outlives the force delay). Its outcome is handled from
       * the start, above. */
      if (!readToEnd) {
        stdout.stop();
        subprocess.kill();
      }
    }
  }

  /**
   * Read a process's stdout as the CLI writes it, and parse each line of its
   * NDJSON into events, whatever the pace of the consumer of {@link stream}.
   *
   * execa settles a run, and so stops its timeout, once the process has
   * exited and its stdout has ended (lib/resolve/wait-subprocess.js and
   * lib/terminate/timeout.js in execa 10.0.1), and Node ends a stream only
   * once its buffered data has been read. Read at the consumer's pace, a
   * consumer slower than the timeout turned a run that had exited 0 into a
   * timeout, and a reply larger than the pipe and the stream's buffer hold
   * could not leave the CLI until the consumer caught up. The queue holds the
   * events the consumer has not taken yet: at most the run's whole output,
   * which execa keeps in memory as well for `result.stdout`, up to its
   * `maxBuffer`, past which it destroys stdout and the reading ends.
   *
   * @param stdout — the process's stdout
   * @returns the reader, which has started reading
   */
  private readStdout(stdout: StdoutSource): StdoutReader {
    let pending: StreamEvent[] = [];
    let ended = false;
    let stopped = false;
    let failure: { error: unknown } | undefined;
    let notify: (() => void) | undefined;
    const wake = (): void => {
      notify?.();
      notify = undefined;
    };

    /* stdout gives Buffers (execa sets no encoding on it), and a read ends
     * wherever the CLI's write did, so a multi-byte UTF-8 character can be
     * split between two reads. One decoder for the stream holds the start of
     * such a character until the rest arrives, as execa's own decoding of
     * result.stdout does (lib/transform/encoding-transform.js in execa
     * 10.0.1). */
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    /* State the subclass keeps across the lines of this stream. */
    const context: StreamParseContext = {};
    const parseLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || stopped) return;
      try {
        const event = this.parseStreamEvent(JSON.parse(trimmed), context);
        if (event) pending.push(event);
      } catch {
        /* skip unparseable lines (progress spinners, etc.) */
      }
    };

    void (async () => {
      try {
        for await (const chunk of stdout) {
          buffer += decoder.write(chunk);
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) parseLine(line);
          wake();
        }
        /* the last line, with what the decoder still holds */
        parseLine(buffer + decoder.end());
      } catch (error) {
        failure = { error };
      } finally {
        ended = true;
        wake();
      }
    })();

    return {
      take: () => {
        const taken = pending;
        pending = [];
        return taken;
      },
      arrival: () =>
        new Promise<void>((resolve) => {
          notify = resolve;
        }),
      get ended() {
        return ended;
      },
      get failure() {
        return failure;
      },
      stop: () => {
        stopped = true;
        pending = [];
        if (typeof stdout.destroy === 'function') stdout.destroy();
      },
    };
  }
}
