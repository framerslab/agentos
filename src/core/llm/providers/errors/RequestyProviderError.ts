// File: backend/agentos/core/llm/providers/errors/RequestyProviderError.ts
/**
 * @fileoverview Defines a custom error class for Requesty-specific provider errors.
 * This extends the base {@link ProviderError} to include details specific to Requesty API interactions.
 * @module backend/agentos/core/llm/providers/errors/RequestyProviderError
 * @see {@link ProviderError}
 */

import { ProviderError } from './ProviderError';

/**
 * Represents an error specific to the Requesty provider.
 * It can include additional context like HTTP status codes or specific Requesty error messages.
 *
 * @example
 * try {
 * // Requesty API call
 * } catch (error) {
 * if (error instanceof RequestyProviderError) {
 * console.error(`Requesty Error (Status: ${error.httpStatus || 'N/A'}, Type: ${error.requestyErrorType || 'N/A'}): ${error.message}`);
 * // Handle Requesty-specific error properties
 * } else {
 * // Handle other errors
 * }
 * }
 */
export class RequestyProviderError extends ProviderError {
  /** HTTP status code from the API response (e.g., 400, 401, 429, 500). */
  public readonly httpStatus?: number;

  /** Requesty specific error type, if available from the response. */
  public readonly requestyErrorType?: string;

  /**
   * Creates an instance of RequestyProviderError.
   * @param {string} message - A human-readable description of the error.
   * @param {string} code - A unique AgentOS internal code identifying the type of error (e.g., 'API_REQUEST_FAILED', 'INVALID_ROUTE').
   * @param {number} [httpStatus] - HTTP status code from the API response.
   * @param {string} [requestyErrorType] - Requesty specific error type.
   * @param {unknown} [details] - Optional underlying error object or additional context from Requesty.
   */
  constructor(
    message: string,
    code: string,
    httpStatus?: number,
    requestyErrorType?: string,
    details?: unknown
  ) {
    super(message, code, 'requesty', details); // ProviderId is 'requesty'
    this.name = 'RequestyProviderError';
    this.httpStatus = httpStatus;
    this.requestyErrorType = requestyErrorType;

    Object.setPrototypeOf(this, RequestyProviderError.prototype);
  }
}
