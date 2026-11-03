/**
 * @module io/segmentation/errors
 * Typed error classes for the segmentation surface. Callers can catch by class
 * to branch on the failure cause.
 */
import type { SegmentationMode } from './types.js';

/**
 * Thrown before any network call when the resolved provider does not support
 * the requested prompt mode.
 */
export class SegmentationModeNotSupportedError extends Error {
  /** The provider that was asked to segment. */
  public readonly providerId: string;
  /** The unsupported mode. */
  public readonly mode: SegmentationMode;

  constructor(providerId: string, mode: SegmentationMode) {
    super(`Segmentation mode "${mode}" is not supported by provider "${providerId}".`);
    this.name = 'SegmentationModeNotSupportedError';
    this.providerId = providerId;
    this.mode = mode;
  }
}

/** Thrown when zero or more than one prompt mode is supplied. */
export class InvalidSegmentationPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSegmentationPromptError';
  }
}

/** Discriminates the kind of provider-level failure. */
export type SegmentationErrorCode = 'provider_failed' | 'timeout' | 'invalid_request';

/**
 * Wraps provider/network failures, timeouts and requests refused before or by
 * the provider. Thrown by `segment()` and `removeBackground()`.
 */
export class SegmentationProviderError extends Error {
  /** Failure category. */
  public readonly code: SegmentationErrorCode;
  /** Underlying cause, when one exists. */
  public readonly cause?: unknown;
  /** The provider's HTTP status, when the failure is an HTTP answer. */
  public readonly status?: number;

  constructor(message: string, code: SegmentationErrorCode, cause?: unknown, status?: number) {
    super(message);
    this.name = 'SegmentationProviderError';
    this.code = code;
    this.cause = cause;
    if (status !== undefined) this.status = status;
  }
}
