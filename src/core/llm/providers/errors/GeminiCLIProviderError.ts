/**
 * @fileoverview Custom error class for Gemini CLI provider errors.
 * Extends {@link CLISubprocessError} with Gemini-specific error codes.
 *
 * @module agentos/core/llm/providers/errors/GeminiCLIProviderError
 * @see {@link CLISubprocessError}
 */

import { CLISubprocessError } from '../../../../safety/sandbox/subprocess/errors';

/**
 * All recognized error codes for the Gemini CLI provider.
 * Combines generic CLI error codes with Gemini-specific ones.
 *
 * The code the HTTP providers give a caller's abort:
 * - `REQUEST_ABORTED` — the call was cancelled through its abort signal;
 *   `isRetryableError()` never counts it as retryable
 *
 * Gemini-specific:
 * - `TOOL_PARSE_FAILED` — XML tool_call regex didn't match expected format
 * - `EMBEDDINGS_NOT_SUPPORTED` — Gemini CLI does not support embeddings
 */
export type GeminiCLIErrorCode =
  | 'BINARY_NOT_FOUND'
  | 'NOT_AUTHENTICATED'
  | 'VERSION_OUTDATED'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'CRASHED'
  | 'RATE_LIMITED'
  | 'CONTEXT_TOO_LONG'
  | 'REQUEST_ABORTED'
  | 'TOOL_PARSE_FAILED'
  | 'EMBEDDINGS_NOT_SUPPORTED'
  | 'UNKNOWN';

/**
 * Error specific to the Gemini CLI provider.
 *
 * @example
 * throw new GeminiCLIProviderError(
 *   'Gemini CLI is not installed.',
 *   'BINARY_NOT_FOUND',
 *   'Install it: npm install -g @google/gemini-cli',
 *   false,
 * );
 */
export class GeminiCLIProviderError extends CLISubprocessError {
  constructor(
    message: string,
    code: GeminiCLIErrorCode,
    guidance: string,
    recoverable: boolean = false,
    details?: unknown,
  ) {
    super(message, code, 'gemini', guidance, recoverable, details);
    this.name = 'GeminiCLIProviderError';

    Object.setPrototypeOf(this, GeminiCLIProviderError.prototype);
  }
}
