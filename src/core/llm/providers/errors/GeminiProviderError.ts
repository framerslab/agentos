// File: backend/agentos/core/llm/providers/errors/GeminiProviderError.ts

/**
 * @fileoverview Custom error class for Google Gemini provider errors.
 * Extends the base {@link ProviderError} with Gemini-specific fields
 * such as HTTP status codes and Gemini API error details.
 *
 * @module backend/agentos/core/llm/providers/errors/GeminiProviderError
 * @see {@link ProviderError}
 */

import { ProviderError } from './ProviderError';

/**
 * Represents an error originating from the Google Gemini provider.
 *
 * Includes additional context specific to the Gemini REST API, such as
 * HTTP status codes and the `error.status` field from the Gemini error
 * envelope (e.g., `"INVALID_ARGUMENT"`, `"PERMISSION_DENIED"`).
 *
 * @example
 * try {
 *   // Gemini API call
 * } catch (error) {
 *   if (error instanceof GeminiProviderError) {
 *     console.error(`Gemini Error (HTTP ${error.httpStatus}): ${error.message}`);
 *   }
 * }
 */
export class GeminiProviderError extends ProviderError {
  /** HTTP status code from the Gemini API response (e.g., 400, 403, 429, 500). */
  public readonly httpStatus?: number;

  /**
   * Gemini-specific error status string from the API response.
   * Examples: `"INVALID_ARGUMENT"`, `"PERMISSION_DENIED"`, `"RESOURCE_EXHAUSTED"`.
   */
  public readonly geminiErrorStatus?: string;

  /**
   * Usage already billed when a request made of several API calls fails
   * partway: the calls that succeeded before this error. Set by
   * `GeminiProvider.generateEmbeddings` when a later batch fails, so a caller
   * can still record that spend; absent otherwise.
   */
  public partialUsage?: { prompt_tokens: number; total_tokens: number; costUSD?: number };

  /**
   * Creates an instance of GeminiProviderError.
   *
   * @param {string} message - Human-readable description of the error.
   * @param {string} code - Internal AgentOS error code (e.g., 'API_REQUEST_FAILED').
   * @param {number} [httpStatus] - HTTP status code from the API response.
   * @param {string} [geminiErrorStatus] - Gemini-specific error status string.
   * @param {unknown} [details] - Additional context or the original error object.
   */
  constructor(
    message: string,
    code: string,
    httpStatus?: number,
    geminiErrorStatus?: string,
    details?: unknown
  ) {
    super(message, code, 'gemini', details);
    this.name = 'GeminiProviderError';
    this.httpStatus = httpStatus;
    this.geminiErrorStatus = geminiErrorStatus;

    // Preserve correct prototype chain for instanceof checks
    Object.setPrototypeOf(this, GeminiProviderError.prototype);
  }
}
