/**
 * @file reasoningTraceLimits.ts
 * Resolves the limits of a GMI's reasoning trace (the ring buffer of decision
 * entries the turn loop writes and the self-reflection metaprompt reads):
 * the persona's `reasoningTraceConfig`, then the runtime's `GMIBaseConfig`
 * defaults, then the constants below. A value that is not a positive integer
 * is ignored and reported in the result's `ignored` list (PersonaValidation
 * also reports persona values); a value above a ceiling is clamped and
 * reported the same way, so a misconfigured persona cannot grow a trace
 * without bound.
 */
import type { IPersonaDefinition } from './personas/IPersonaDefinition';
import type { GMIBaseConfig } from './IGMI';

/** Entries kept when neither the persona nor the runtime sets a limit. */
export const DEFAULT_REASONING_TRACE_MAX_ENTRIES = 500;
/** Characters kept per entry message when neither the persona nor the runtime sets a limit. */
export const DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH = 1000;
/** Largest entry cap accepted; higher settings are clamped to it. */
export const REASONING_TRACE_MAX_ENTRIES_CEILING = 10_000;
/** Largest message cap accepted; higher settings are clamped to it. */
export const REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING = 100_000;

/** A setting the resolver did not use as given. */
export interface ReasoningTraceLimitIssue {
  /** Where the setting came from. */
  source: 'persona' | 'config';
  key: 'maxEntries' | 'maxMessageLength';
  /** The value as given, made safe for JSON: numbers, strings, booleans and null pass through, anything else becomes its `String()` form. */
  value: unknown;
  /** Why it was not used as given. */
  reason: 'not_a_positive_integer' | 'above_ceiling';
}

/** The resolved limits a GMI applies, with the settings it ignored or clamped. */
export interface ReasoningTraceLimits {
  /** Entries kept; the oldest is dropped when the next arrives. */
  maxEntries: number;
  /** Characters kept per entry message. */
  maxMessageLength: number;
  /** Settings that were not positive integers (ignored) or exceeded a ceiling (clamped). */
  ignored: ReasoningTraceLimitIssue[];
}

/** True for an integer greater than zero. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const CEILINGS = {
  maxEntries: REASONING_TRACE_MAX_ENTRIES_CEILING,
  maxMessageLength: REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING,
} as const;
const DEFAULTS = {
  maxEntries: DEFAULT_REASONING_TRACE_MAX_ENTRIES,
  maxMessageLength: DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH,
} as const;

/**
 * Picks each limit from the persona, then the runtime config, then the
 * defaults: the first positive integer wins, clamped to its ceiling. Every
 * setting that was defined but not used as given is listed in `ignored`.
 */
export function resolveReasoningTraceLimits(
  persona?: Pick<IPersonaDefinition, 'reasoningTraceConfig'>,
  config?: Pick<GMIBaseConfig, 'defaultReasoningTraceMaxEntries' | 'defaultReasoningTraceMaxMessageLength'>,
): ReasoningTraceLimits {
  const ignored: ReasoningTraceLimitIssue[] = [];
  const safe = (value: unknown): unknown =>
    value === null || ['number', 'string', 'boolean'].includes(typeof value) ? value : String(value);
  const pick = (key: 'maxEntries' | 'maxMessageLength'): number => {
    const candidates: Array<[ReasoningTraceLimitIssue['source'], unknown]> = [
      ['persona', persona?.reasoningTraceConfig?.[key]],
      ['config', key === 'maxEntries' ? config?.defaultReasoningTraceMaxEntries : config?.defaultReasoningTraceMaxMessageLength],
    ];
    let chosen: number | undefined;
    for (const [source, value] of candidates) {
      if (value === undefined) continue;
      if (!isPositiveInteger(value)) {
        ignored.push({ source, key, value: safe(value), reason: 'not_a_positive_integer' });
        continue;
      }
      if (chosen !== undefined) continue;
      if (value > CEILINGS[key]) {
        ignored.push({ source, key, value: safe(value), reason: 'above_ceiling' });
        chosen = CEILINGS[key];
      } else {
        chosen = value;
      }
    }
    return chosen ?? DEFAULTS[key];
  };
  return { maxEntries: pick('maxEntries'), maxMessageLength: pick('maxMessageLength'), ignored };
}
