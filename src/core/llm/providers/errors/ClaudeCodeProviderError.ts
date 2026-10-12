/**
 * @fileoverview Custom error class for Claude Code CLI provider errors.
 * Extends {@link CLISubprocessError} with Claude-specific error codes.
 *
 * @module agentos/core/llm/providers/errors/ClaudeCodeProviderError
 * @see {@link CLISubprocessError}
 */

import { CLISubprocessError } from '../../../../safety/sandbox/subprocess/errors';

/**
 * All recognized error codes for the Claude Code CLI provider.
 * Combines generic CLI error codes with Claude-specific ones.
 *
 * Generic (from CLISubprocessError):
 * - `BINARY_NOT_FOUND` — `claude` binary not on PATH
 * - `NOT_AUTHENTICATED` — installed but not logged in
 * - `VERSION_OUTDATED` — missing required flags (e.g. --bare)
 * - `SPAWN_FAILED` — process failed to start (permissions, etc.)
 * - `TIMEOUT` — exceeded timeout waiting for response
 * - `CRASHED` — non-zero exit code during execution
 * - `RATE_LIMITED` — subscription rate limit hit
 * - `CONTEXT_TOO_LONG` — conversation exceeds model context window
 *
 * The code the OpenAI, Anthropic and Gemini providers throw from
 * generateCompletion() for a caller's abort:
 * - `REQUEST_ABORTED` — the call was cancelled through its abort signal;
 *   `isRetryableError()` never counts it as retryable
 *
 * Claude-specific:
 * - `SCHEMA_PARSE_FAILED` — `--json-schema` response did not parse
 * - `EMBEDDINGS_NOT_SUPPORTED` — Claude Code CLI does not support embeddings
 * - `UNKNOWN` — catch-all for unexpected failures
 */
export type ClaudeCodeErrorCode =
  | 'BINARY_NOT_FOUND'
  | 'NOT_AUTHENTICATED'
  | 'VERSION_OUTDATED'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'CRASHED'
  | 'RATE_LIMITED'
  | 'CONTEXT_TOO_LONG'
  | 'REQUEST_ABORTED'
  | 'SCHEMA_PARSE_FAILED'
  | 'EMBEDDINGS_NOT_SUPPORTED'
  | 'UNKNOWN';

/**
 * Error specific to the Claude Code CLI provider.
 * Extends the generic {@link CLISubprocessError} with the `claude` binary name
 * and Claude-specific error codes.
 *
 * @example
 * throw new ClaudeCodeProviderError(
 *   'Claude Code CLI is not installed.',
 *   'BINARY_NOT_FOUND',
 *   'Install it: npm install -g @anthropic-ai/claude-code',
 *   false,
 * );
 */
export class ClaudeCodeProviderError extends CLISubprocessError {
  /**
   * @param message — human-readable error description
   * @param code — one of {@link ClaudeCodeErrorCode}
   * @param guidance — actionable fix instructions shown to the user
   * @param recoverable — true if AgentOS should attempt fallback (default false)
   * @param details — optional underlying error or extra context
   */
  constructor(
    message: string,
    code: ClaudeCodeErrorCode,
    guidance: string,
    recoverable: boolean = false,
    details?: unknown,
  ) {
    super(message, code, 'claude', guidance, recoverable, details);
    this.name = 'ClaudeCodeProviderError';

    Object.setPrototypeOf(this, ClaudeCodeProviderError.prototype);
  }

  /**
   * The error a result Claude Code flags as an error stands for, `CRASHED`
   * with the failure's message. ClaudeCodeProvider throws it from
   * generateCompletion() and ends a stream with it, and ClaudeCodeCLIBridge
   * throws it from execute() when the CLI exits non-zero after such a result.
   *
   * @param message — the failure's message, as the bridge reads it from the result
   * @param details — optional context, such as the run's exit code and stderr
   */
  static fromErrorResult(message: string, details?: unknown): ClaudeCodeProviderError {
    return new ClaudeCodeProviderError(
      `Claude Code returned an error: ${message}`,
      'CRASHED',
      'Try running "claude --bare -p test" manually to diagnose.',
      true,
      details,
    );
  }

  /**
   * The error of a call the caller cancelled through its abort signal,
   * `REQUEST_ABORTED`. ClaudeCodeCLIBridge classifies a run execa marks
   * `isCanceled` as it, and ClaudeCodeProvider ends a stream with it when the
   * caller aborts after the run has ended but before the stream's final chunk.
   *
   * @param details — optional context, such as the run's exit code and stderr
   */
  static requestAborted(details?: unknown): ClaudeCodeProviderError {
    return new ClaudeCodeProviderError(
      'Claude Code CLI call aborted by the caller.',
      'REQUEST_ABORTED',
      'The call was cancelled through its abort signal. Send it again if it is still needed.',
      false,
      details,
    );
  }
}
