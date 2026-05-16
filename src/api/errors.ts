/**
 * @fileoverview Custom error class for AgentOS service facade errors.
 */

import { GMIError, GMIErrorCode } from '../core/utils/errors.js';

/**
 * Custom error class for errors specifically originating from the AgentOS service facade.
 * Provides a standardized way to represent errors encountered within the `AgentOS` class.
 */
export class AgentOSServiceError extends GMIError {
  public override readonly name: string = 'AgentOSServiceError';

  constructor(message: string, code: GMIErrorCode | string, details?: any, componentOrigin?: string) {
    super(message, code as GMIErrorCode, details, componentOrigin);
    Object.setPrototypeOf(this, AgentOSServiceError.prototype);
  }

  /**
   * Wraps an existing error within a new AgentOSServiceError instance.
   */
  public static override wrap(error: any, code: GMIErrorCode | string, message: string, componentOrigin?: string): AgentOSServiceError {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const originalComponent = error instanceof GMIError ? error.component : undefined;
    const originalDetails = error instanceof GMIError ? error.details : { underlyingError: error };

    return new AgentOSServiceError(
      `${message}: ${baseMessage}`,
      code,
      originalDetails,
      componentOrigin || originalComponent
    );
  }
}
