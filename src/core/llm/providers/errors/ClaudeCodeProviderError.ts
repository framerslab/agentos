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
 * The code the HTTP providers give a caller's abort:
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
}
