/**
 * @fileoverview Claude Code CLI bridge — extends the generalized
 * {@link CLISubprocessBridge} with Claude-specific flag assembly,
 * error classification, and stream event parsing.
 *
 * This class only contains what's specific to the `claude` binary.
 * All subprocess lifecycle (spawn, pipe, NDJSON parse, timeout) is
 * handled by the base class.
 *
 * @module agentos/core/llm/providers/implementations/ClaudeCodeCLIBridge
 * @see CLISubprocessBridge
 * @see ClaudeCodeProvider
 */

import { CLISubprocessBridge } from '../../../../safety/sandbox/subprocess/CLISubprocessBridge';
import { ClaudeCodeProviderError } from '../errors/ClaudeCodeProviderError';
import type { BridgeOptions, BridgeResult, StreamEvent, OutputFormat } from '../../../../safety/sandbox/subprocess/types';

/* Re-export shared types for backwards compatibility with ClaudeCodeProvider imports */
export type { BridgeOptions as CLIBridgeOptions, BridgeResult as CLIBridgeResult, StreamEvent } from '../../../../safety/sandbox/subprocess/types';
export type { InstallCheckResult } from '../../../../safety/sandbox/subprocess/types';

/**
 * Claude Code CLI subprocess bridge.
 *
 * Extends {@link CLISubprocessBridge} to implement:
 * - Flag assembly: `--bare`, `-p`, `--system-prompt`, `--json-schema`, `--max-turns`
 * - Error classification: caller abort, timeout, auth, rate-limit, context length, ENOENT, EACCES
 * - Stream event parsing: `content_block_delta` (nested under `stream_event` or at the top level), `result`, `error`, `system` events
 * - JSON result: an error result's message in `error`, `structured_output` in `structuredOutput`, and a run that exits non-zero after an error result reported as that result
 * - Auth check: uses `--bare --max-turns 1` for lightweight health ping
 */
export class ClaudeCodeCLIBridge extends CLISubprocessBridge {
  protected readonly binaryName = 'claude';

  /* ---- Flag assembly -------------------------------------------- */

  protected buildArgs(options: BridgeOptions, format: OutputFormat): string[] {
    const args: string[] = [
      '--bare',
      '-p',
      '--output-format', format,
      '--max-turns', String(options.maxTurns ?? 1),
    ];

    if (format === 'stream-json') {
      args.push('--verbose', '--include-partial-messages');
    }

    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.jsonSchema) {
      args.push('--json-schema', JSON.stringify(options.jsonSchema));
    }

    if (options.extraArgs) {
      args.push(...options.extraArgs);
    }

    return args;
  }

  /* ---- JSON result ---------------------------------------------- */

  /**
   * Claude Code's JSON result, read as the base class reads it, with two
   * fields of Claude Code's own: the failure's message
   * ({@link errorResultMessage}) in `error` when the CLI flags the result as
   * an error, and in `structuredOutput` the reply that matches --json-schema
   * when the CLI returns one (`structured_output`, SDKResultSuccess in
   * @anthropic-ai/claude-agent-sdk 0.3.296). `result` keeps what the base
   * reading gives.
   */
  protected parseJsonResult(stdout: string, durationMs: number): BridgeResult {
    const result = super.parseJsonResult(stdout, durationMs);
    let raw: any;
    try {
      raw = JSON.parse(stdout.trim());
    } catch {
      return result;
    }
    if (!raw || typeof raw !== 'object') return result;
    return {
      ...result,
      ...(result.isError ? { error: this.errorResultMessage(raw) } : {}),
      ...(raw.structured_output !== undefined ? { structuredOutput: raw.structured_output } : {}),
    };
  }

  /**
   * A run that exits non-zero after a result Claude Code flags as an error
   * ends with the error that result stands for, as a result flagged at exit
   * 0 does in the provider: `CRASHED` with the failure's message, and the
   * exit code and stderr in `details`. The SDK reads a run the same way: its
   * Query.readMessages replaces the process's exit error with the error
   * result's text (@anthropic-ai/claude-agent-sdk 0.3.296, sdk.mjs).
   */
  protected classifyErrorResult(result: BridgeResult, error: any): ClaudeCodeProviderError {
    return ClaudeCodeProviderError.fromErrorResult(result.error ?? result.result, {
      exitCode: error.exitCode,
      stderr: error.stderr ?? '',
    });
  }

  /* ---- Auth check override -------------------------------------- */

  protected buildAuthCheckArgs(): { args: string[]; stdin: string } {
    return {
      args: ['--bare', '-p', '--output-format', 'json', '--max-turns', '1'],
      stdin: 'Reply with exactly: pong',
    };
  }

  /* ---- Stream event parsing ------------------------------------- */

  protected parseStreamEvent(raw: any): StreamEvent | null {
    if (!raw || typeof raw !== 'object') return null;

    /* Text delta from content block. With --include-partial-messages, which
     * buildArgs passes, Claude Code wraps each Messages API stream event as
     * { type: 'stream_event', event } (SDKPartialAssistantMessage in
     * @anthropic-ai/claude-agent-sdk 0.3.296); a top-level delta is read too. */
    const streamed = raw.type === 'stream_event' ? raw.event : raw;
    if (streamed?.type === 'content_block_delta' && streamed.delta?.type === 'text_delta') {
      return { type: 'text_delta', text: streamed.delta.text };
    }

    /* Assistant message with text content */
    if (raw.type === 'assistant' && typeof raw.message?.content === 'string') {
      return { type: 'text_delta', text: raw.message.content };
    }

    /* Final result. Claude Code flags a failed turn (an API error, the turn
     * limit) with is_error. `result` is the CLI's own result text, '' when it
     * wrote none, as the bridge read it before 0.13.41; the failure's message
     * ({@link errorResultMessage}) goes in `error`. With --json-schema, the
     * reply that matches the schema comes in structured_output
     * (SDKResultSuccess in @anthropic-ai/claude-agent-sdk 0.3.296), which goes
     * in `structuredOutput`. */
    if (raw.type === 'result') {
      const isError = raw.is_error === true;
      return {
        type: 'result',
        result: raw.result ?? '',
        sessionId: raw.session_id,
        usage: raw.usage
          ? { input_tokens: raw.usage.input_tokens ?? 0, output_tokens: raw.usage.output_tokens ?? 0 }
          : undefined,
        ...(isError ? { isError: true, error: this.errorResultMessage(raw) } : {}),
        ...(raw.structured_output !== undefined ? { structuredOutput: raw.structured_output } : {}),
      };
    }

    /* Error event */
    if (raw.type === 'error') {
      return { type: 'error', error: raw.error?.message ?? raw.message ?? 'Unknown error' };
    }

    /* System events (api_retry, progress, etc.) */
    if (raw.type === 'system' || raw.type === 'system/api_retry') {
      return { type: 'system', message: raw.message ?? JSON.stringify(raw) };
    }

    return null;
  }

  /**
   * The message of a result Claude Code flags as an error. A turn that ended
   * on an API error carries the error's text in `result`. The error subtypes
   * (error_during_execution, error_max_turns, error_max_budget_usd,
   * error_max_structured_output_retries) carry no result and list their
   * detail in `errors` (SDKResultError in @anthropic-ai/claude-agent-sdk
   * 0.3.296), which follows the subtype: `error_max_turns: <errors>`. Each
   * entry is trimmed and a blank one left out before the join, as the SDK's
   * own reader of the result does (Query.readMessages in its sdk.mjs): an
   * entry can carry the CLI's stderr text, line break included.
   */
  private errorResultMessage(raw: any): string {
    if (raw.result) return raw.result;
    const errors: string[] = Array.isArray(raw.errors)
      ? raw.errors
          .filter((error: unknown): error is string => typeof error === 'string')
          .map((error: string) => error.trim())
          .filter((error: string) => error !== '')
      : [];
    return [raw.subtype, errors.join('; ')].filter(Boolean).join(': ') || 'Unknown error';
  }

  /* ---- Error classification ------------------------------------- */

  protected classifyError(error: any): ClaudeCodeProviderError {
    const stderr: string = error.stderr ?? '';
    /* The CLI's wording varies in case ("Authentication failed"), so stderr is matched lowercased. */
    const text = String(stderr).toLowerCase();
    const exitCode = error.exitCode;

    /* Cancelled by the caller. execa sets isCanceled when the abortSignal it
     * was given as cancelSignal fires; the signal that then ends the process
     * sets isTerminated too, so this is checked before the timeout. */
    if (error.isCanceled) {
      return ClaudeCodeProviderError.requestAborted({ exitCode, stderr });
    }

    /* Timeout */
    if (error.timedOut || error.isTerminated) {
      return new ClaudeCodeProviderError(
        `Claude Code CLI timed out.`,
        'TIMEOUT',
        'Claude Code did not respond in time. Try again or use a smaller model (claude-haiku-4-5-20251001).',
        true,
        { exitCode, stderr },
      );
    }

    /* Auth errors */
    if (text.includes('not logged in') || text.includes('authentication') || text.includes('unauthorized')) {
      return new ClaudeCodeProviderError(
        'Claude Code is installed but not logged in.',
        'NOT_AUTHENTICATED',
        'Run "claude" in your terminal and complete the login flow, then try again.',
        false,
        { exitCode, stderr },
      );
    }

    /* Rate limit */
    if (text.includes('rate limit') || text.includes('too many requests') || text.includes('429')) {
      return new ClaudeCodeProviderError(
        'Claude Code subscription rate limit reached.',
        'RATE_LIMITED',
        'Wait a few minutes and try again. Check your Max plan limits at https://claude.ai/pricing',
        true,
        { exitCode, stderr },
      );
    }

    /* Context too long */
    if (text.includes('context') && (text.includes('too long') || text.includes('token limit'))) {
      return new ClaudeCodeProviderError(
        'Conversation exceeds model context window.',
        'CONTEXT_TOO_LONG',
        'Start a new conversation or switch to a model with a larger context window.',
        false,
        { exitCode, stderr },
      );
    }

    /* Spawn failure (ENOENT = binary not found in this context) */
    if (error.code === 'ENOENT') {
      return new ClaudeCodeProviderError(
        'Claude Code CLI not found.',
        'BINARY_NOT_FOUND',
        'Install Claude Code: npm install -g @anthropic-ai/claude-code — or download from https://claude.ai/download',
        false,
        { exitCode, stderr },
      );
    }

    /* Permission error */
    if (error.code === 'EACCES') {
      return new ClaudeCodeProviderError(
        'Failed to start Claude Code process due to permissions.',
        'SPAWN_FAILED',
        `Check file permissions on the claude binary.`,
        false,
        { exitCode, stderr },
      );
    }

    /* Generic crash */
    const stderrSnippet = stderr.length > 500 ? stderr.slice(-500) : stderr;
    return new ClaudeCodeProviderError(
      `Claude Code CLI exited unexpectedly (code ${exitCode ?? 'unknown'}).`,
      'CRASHED',
      `Try running "claude --bare -p test" manually to diagnose. stderr: ${stderrSnippet}`,
      true,
      { exitCode, stderr },
    );
  }
}
