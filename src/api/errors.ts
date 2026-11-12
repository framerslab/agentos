/**
 * @fileoverview Custom error class for AgentOS service facade errors.
 */

import { GMIError, GMIErrorCode } from '../core/utils/errors.js';
import type { GuardrailHold } from '../safety/guardrails/IGuardrailService.js';
import type { TextGuardrailReport } from './runtime/textGuardrails.js';
import type { TokenUsage } from './generateText.js';

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

/**
 * A call that carried `guards` was stopped: by a rule (`GUARDRAIL_BLOCKED`), for a person's review
 * (`GUARDRAIL_HELD`), or because a guard that runs closed could not judge (`GUARDRAIL_UNAVAILABLE`). Its message is
 * one fixed sentence; it never holds a guard's reason, the prompt or the reply.
 */
export class GuardrailStopError extends Error {
  override readonly name = 'GuardrailStopError';
  readonly code: 'GUARDRAIL_BLOCKED' | 'GUARDRAIL_HELD' | 'GUARDRAIL_UNAVAILABLE';
  /** Where the call stopped: before the first provider request, or before the reply reached the caller. */
  readonly stage: 'input' | 'output';
  readonly reasonCode?: string;
  readonly guardrailId?: string;
  readonly hold?: GuardrailHold;
  /** What each stage's guards answered, as codes and ids. */
  readonly report: TextGuardrailReport;
  /** What the call had spent when it stopped; set on the output stage. */
  readonly usage?: TokenUsage;

  constructor(init: {
    code: GuardrailStopError['code'];
    stage: GuardrailStopError['stage'];
    report: TextGuardrailReport;
    reasonCode?: string;
    guardrailId?: string;
    hold?: GuardrailHold;
    usage?: TokenUsage;
  }) {
    super('The call was stopped by a guardrail.');
    this.code = init.code;
    this.stage = init.stage;
    this.report = init.report;
    if (init.reasonCode !== undefined) this.reasonCode = init.reasonCode;
    if (init.guardrailId !== undefined) this.guardrailId = init.guardrailId;
    if (init.hold !== undefined) this.hold = init.hold;
    if (init.usage !== undefined) this.usage = init.usage;
    Object.setPrototypeOf(this, GuardrailStopError.prototype);
  }
}
