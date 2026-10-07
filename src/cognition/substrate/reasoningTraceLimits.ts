/**
 * @file reasoningTraceLimits.ts
 * Resolves the limits of a GMI's reasoning trace (the ring buffer of decision
 * entries the turn loop writes and the self-reflection metaprompt reads):
 * the persona's `reasoningTraceConfig`, then the runtime's `GMIBaseConfig`
 * defaults, then the constants below. A value that is not a positive integer
 * is ignored here and reported by PersonaValidation.
 */
import type { IPersonaDefinition } from './personas/IPersonaDefinition';
import type { GMIBaseConfig } from './IGMI';

export const DEFAULT_REASONING_TRACE_MAX_ENTRIES = 500;
export const DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH = 1000;

export interface ReasoningTraceLimits {
  /** Entries kept; the oldest is dropped when the next arrives. */
  maxEntries: number;
  /** Characters kept per entry message. */
  maxMessageLength: number;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function resolveReasoningTraceLimits(
  persona?: Pick<IPersonaDefinition, 'reasoningTraceConfig'>,
  config?: Pick<GMIBaseConfig, 'defaultReasoningTraceMaxEntries' | 'defaultReasoningTraceMaxMessageLength'>,
): ReasoningTraceLimits {
  const first = (...candidates: unknown[]): number | undefined =>
    candidates.find((candidate) => isPositiveInteger(candidate)) as number | undefined;
  return {
    maxEntries:
      first(persona?.reasoningTraceConfig?.maxEntries, config?.defaultReasoningTraceMaxEntries) ??
      DEFAULT_REASONING_TRACE_MAX_ENTRIES,
    maxMessageLength:
      first(persona?.reasoningTraceConfig?.maxMessageLength, config?.defaultReasoningTraceMaxMessageLength) ??
      DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH,
  };
}
