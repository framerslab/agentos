// Shared error helpers used across AgentOS and embedding applications.

export class AppError extends Error {
  constructor(
    public override message: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, true);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, true);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, true);
  }
}

export enum GMIErrorCode {
  INTERNAL_SERVER_ERROR = 'SYS_INTERNAL_SERVER_ERROR',
  INTERNAL_ERROR = 'SYS_INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SYS_SERVICE_UNAVAILABLE',
  NOT_INITIALIZED = 'SYS_NOT_INITIALIZED',
  INITIALIZATION_FAILED = 'SYS_INITIALIZATION_FAILED',
  CONFIGURATION_ERROR = 'SYS_CONFIGURATION_ERROR',
  CONFIG_ERROR = 'SYS_CONFIG_ERROR',
  VALIDATION_ERROR = 'SYS_VALIDATION_ERROR',
  INVALID_ARGUMENT = 'SYS_INVALID_ARGUMENT',
  INVALID_STATE = 'SYS_INVALID_STATE',
  PARSING_ERROR = 'SYS_PARSING_ERROR',
  DEPENDENCY_ERROR = 'SYS_DEPENDENCY_ERROR',
  MISSING_DEPENDENCY = 'SYS_MISSING_DEPENDENCY',
  MISSING_DATA = 'SYS_MISSING_DATA',
  NOT_IMPLEMENTED = 'SYS_NOT_IMPLEMENTED',
  NOT_SUPPORTED = 'SYS_NOT_SUPPORTED',
  METHOD_NOT_SUPPORTED = 'SYS_METHOD_NOT_SUPPORTED',
  PROCESSING_ERROR = 'SYS_PROCESSING_ERROR',
  STREAM_ERROR = 'SYS_STREAM_ERROR',
  DATABASE_ERROR = 'SYS_DATABASE_ERROR',
  RATE_LIMIT_EXCEEDED = 'SYS_RATE_LIMIT_EXCEEDED',
  TIMEOUT = 'SYS_TIMEOUT',
  NOT_FOUND = 'SYS_NOT_FOUND',
  RESOURCE_NOT_FOUND = 'SYS_RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS = 'SYS_RESOURCE_ALREADY_EXISTS',
  ALREADY_EXISTS = 'SYS_ALREADY_EXISTS',

  AUTHENTICATION_REQUIRED = 'AUTH_AUTHENTICATION_REQUIRED',
  PERMISSION_DENIED = 'AUTH_PERMISSION_DENIED',
  ACCESS_DENIED = 'AUTH_ACCESS_DENIED',
  SUBSCRIPTION_ERROR = 'AUTH_SUBSCRIPTION_ERROR',

  /** A guardrail the deployment requires is not active, so the request was not run. */
  GUARDRAIL_REQUIRED_MISSING = 'SYS_GUARDRAIL_REQUIRED_MISSING',
  /** The account's allowance for the period has no room for the request (the spend meter). */
  ALLOWANCE_EXHAUSTED = 'BILLING_ALLOWANCE_EXHAUSTED',
  /** The spend meter's store could not answer, so the request was not run. */
  SPEND_METER_UNAVAILABLE = 'SYS_SPEND_METER_UNAVAILABLE',

  PERSONA_NOT_FOUND = 'GMI_PERSONA_NOT_FOUND',
  PERSONA_LOAD_ERROR = 'GMI_PERSONA_LOAD_ERROR',
  GMI_INITIALIZATION_ERROR = 'GMI_INITIALIZATION_ERROR',
  GMI_PROCESSING_ERROR = 'GMI_PROCESSING_ERROR',
  GMI_CONTEXT_ERROR = 'GMI_CONTEXT_ERROR',
  GMI_FEEDBACK_ERROR = 'GMI_FEEDBACK_ERROR',
  GMI_SHUTDOWN_ERROR = 'GMI_SHUTDOWN_ERROR',

  TOOL_ERROR = 'TOOL_ERROR',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',

  LLM_PROVIDER_ERROR = 'LLM_PROVIDER_ERROR',
  LLM_PROVIDER_UNAVAILABLE = 'LLM_PROVIDER_UNAVAILABLE',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  PROVIDER_NOT_FOUND = 'PROVIDER_NOT_FOUND',

  RAG_INGESTION_FAILED = 'RAG_INGESTION_FAILED',
}

const DEFAULT_HTTP_STATUS = 500;
const DEFAULT_FRIENDLY_MESSAGE = 'An unexpected error occurred.';

const statusCodeMap: Partial<Record<GMIErrorCode, number>> = {
  [GMIErrorCode.INTERNAL_SERVER_ERROR]: 500,
  [GMIErrorCode.INTERNAL_ERROR]: 500,
  [GMIErrorCode.SERVICE_UNAVAILABLE]: 503,
  [GMIErrorCode.NOT_INITIALIZED]: 500,
  [GMIErrorCode.INITIALIZATION_FAILED]: 500,
  [GMIErrorCode.CONFIGURATION_ERROR]: 500,
  [GMIErrorCode.CONFIG_ERROR]: 500,
  [GMIErrorCode.VALIDATION_ERROR]: 400,
  [GMIErrorCode.INVALID_ARGUMENT]: 400,
  [GMIErrorCode.INVALID_STATE]: 409,
  [GMIErrorCode.PARSING_ERROR]: 400,
  [GMIErrorCode.DEPENDENCY_ERROR]: 500,
  [GMIErrorCode.MISSING_DEPENDENCY]: 500,
  [GMIErrorCode.MISSING_DATA]: 400,
  [GMIErrorCode.NOT_IMPLEMENTED]: 501,
  [GMIErrorCode.NOT_SUPPORTED]: 501,
  [GMIErrorCode.METHOD_NOT_SUPPORTED]: 405,
  [GMIErrorCode.PROCESSING_ERROR]: 500,
  [GMIErrorCode.GMI_PROCESSING_ERROR]: 500,
  [GMIErrorCode.STREAM_ERROR]: 500,
  [GMIErrorCode.DATABASE_ERROR]: 500,
  [GMIErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [GMIErrorCode.TIMEOUT]: 504,
  [GMIErrorCode.NOT_FOUND]: 404,
  [GMIErrorCode.RESOURCE_NOT_FOUND]: 404,
  [GMIErrorCode.PERSONA_NOT_FOUND]: 404,
  [GMIErrorCode.TOOL_NOT_FOUND]: 404,
  [GMIErrorCode.PROVIDER_NOT_FOUND]: 404,
  [GMIErrorCode.RESOURCE_ALREADY_EXISTS]: 409,
  [GMIErrorCode.ALREADY_EXISTS]: 409,
  [GMIErrorCode.AUTHENTICATION_REQUIRED]: 401,
  [GMIErrorCode.PERMISSION_DENIED]: 403,
  [GMIErrorCode.ACCESS_DENIED]: 403,
  [GMIErrorCode.SUBSCRIPTION_ERROR]: 402,
  [GMIErrorCode.GUARDRAIL_REQUIRED_MISSING]: 503,
  [GMIErrorCode.ALLOWANCE_EXHAUSTED]: 402,
  [GMIErrorCode.SPEND_METER_UNAVAILABLE]: 503,
  [GMIErrorCode.LLM_PROVIDER_UNAVAILABLE]: 503,
};

const userFriendlyMessageMap: Partial<Record<GMIErrorCode, string>> = {
  [GMIErrorCode.INTERNAL_SERVER_ERROR]: DEFAULT_FRIENDLY_MESSAGE,
  [GMIErrorCode.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable. Please try again shortly.',
  [GMIErrorCode.AUTHENTICATION_REQUIRED]: 'Please log in to continue.',
  [GMIErrorCode.PERMISSION_DENIED]: "You do not have permission to perform that action.",
  [GMIErrorCode.ACCESS_DENIED]: "You don't have access to this resource.",
  [GMIErrorCode.NOT_FOUND]: 'We could not find what you were looking for.',
  [GMIErrorCode.RESOURCE_NOT_FOUND]: 'We could not find what you were looking for.',
  [GMIErrorCode.PERSONA_NOT_FOUND]: 'That persona is not available.',
  [GMIErrorCode.SUBSCRIPTION_ERROR]: 'Please upgrade your plan to access this feature.',
  [GMIErrorCode.RATE_LIMIT_EXCEEDED]: 'You are sending requests too quickly. Please slow down.',
  [GMIErrorCode.ALLOWANCE_EXHAUSTED]: 'This account has used its allowance for the period.',
  [GMIErrorCode.SPEND_METER_UNAVAILABLE]: 'The request could not be counted just now, so it was not run. Please try again shortly.',
};

export type GMIErrorDetails = Record<string, any> | undefined;

export class GMIError extends Error {
  public readonly code: GMIErrorCode | string;
  public readonly details?: any;
  public readonly component?: string;
  public readonly timestamp: string;
  public readonly httpStatusCode?: number;
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: GMIErrorCode | string,
    details?: any,
    component?: string,
    httpStatusCode?: number,
    cause?: unknown
  ) {
    super(message);
    this.name = 'GMIError';
    this.code = code;
    this.details = details;
    this.component = component;
    this.httpStatusCode = httpStatusCode;
    this.cause = cause;
    this.timestamp = new Date().toISOString();
    Object.setPrototypeOf(this, GMIError.prototype);
  }

  public getHttpStatusCode(): number {
    if (typeof this.httpStatusCode === 'number') {
      return this.httpStatusCode;
    }
    const mapped = statusCodeMap[this.code as GMIErrorCode];
    return mapped ?? DEFAULT_HTTP_STATUS;
  }

  public getUserFriendlyMessage(): string {
    return userFriendlyMessageMap[this.code as GMIErrorCode] ?? this.message ?? DEFAULT_FRIENDLY_MESSAGE;
  }

  public toPlainObject(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      component: this.component,
      httpStatusCode: this.getHttpStatusCode(),
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }

  public toJSON(): Record<string, any> {
    return this.toPlainObject();
  }

  public static isGMIError(error: unknown): error is GMIError {
    return error instanceof GMIError;
  }

  public static wrap(error: unknown, code: GMIErrorCode | string, message?: string, componentOrigin?: string): GMIError {
    return createGMIErrorFromError(error, code, undefined, message, componentOrigin);
  }
}

export function createGMIErrorFromError(
  error: unknown,
  code: GMIErrorCode | string,
  contextDetails?: any,
  overrideMessage?: string,
  componentOrigin?: string
): GMIError {
  if (error instanceof GMIError) {
    return new GMIError(
      overrideMessage ? `${overrideMessage}: ${error.message}` : error.message,
      code ?? error.code,
      mergeDetails(error.details, contextDetails),
      componentOrigin ?? error.component,
      error.httpStatusCode,
      error
    );
  }

  const baseMessage = error instanceof Error ? error.message : String(error);
  const mergedDetails = mergeDetails(normalizeUnknownError(error), contextDetails);

  return new GMIError(
    overrideMessage ? `${overrideMessage}: ${baseMessage}` : baseMessage,
    code,
    mergedDetails,
    componentOrigin,
    undefined,
    error
  );
}

function mergeDetails(...details: Array<any>): Record<string, any> | undefined {
  const merged: Record<string, any> = {};
  for (const detail of details) {
    if (detail && typeof detail === 'object') {
      Object.assign(merged, detail);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeUnknownError(error: unknown): Record<string, any> | undefined {
  if (error instanceof Error) {
    return {
      underlyingError: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    };
  }

  if (error && typeof error === 'object') {
    return { underlyingError: error };
  }

  return error === undefined ? undefined : { underlyingError: { value: error } };
}
