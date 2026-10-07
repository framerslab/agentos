/**
 * @file reasoningTraceLimits.ts
 * Resolves the limits of a GMI's reasoning trace (the ring buffer of decision
 * entries the turn loop writes and the self-reflection metaprompt reads):
 * the persona's `reasoningTraceConfig`, then the runtime's `GMIBaseConfig`
 * defaults, then the constants below. A value that is not a positive integer
 * is ignored; an entry cap below the floor is raised to it (the self-reflection
 * metaprompt reads the last 20 entries and error detection the last 10); a
 * value above a ceiling is clamped. Every such setting is reported in the
 * result's `ignored` list (PersonaValidation also reports persona values), so a
 * misconfigured persona can neither starve the metaprompts nor grow the trace
 * past the ceilings.
 */
import type { IPersonaDefinition } from './personas/IPersonaDefinition';
import type { GMIBaseConfig } from './IGMI';

/** Entries kept when neither the persona nor the runtime sets a limit. */
export const DEFAULT_REASONING_TRACE_MAX_ENTRIES = 500;
/** Characters kept per entry message when neither the persona nor the runtime sets a limit. */
export const DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH = 1000;
/**
 * Smallest entry cap applied. The self-reflection metaprompt reads the last 20
 * entries and error detection the last 10, so a lower setting is raised to it.
 */
export const REASONING_TRACE_MIN_ENTRIES = 20;
/** Largest entry cap accepted; higher settings are clamped to it. */
export const REASONING_TRACE_MAX_ENTRIES_CEILING = 5_000;
/** Largest message cap accepted; higher settings are clamped to it. */
export const REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING = 20_000;

/** The two limits a persona or the runtime can set. */
export type ReasoningTraceLimitKey = 'maxEntries' | 'maxMessageLength';

/** A setting the resolver did not use as given. */
export interface ReasoningTraceLimitIssue {
  /** Where the setting came from. */
  source: 'persona' | 'config';
  /**
   * The limit's key; `reasoningTraceConfig` when the persona's whole field was
   * not an object; the offending name for an unknown key.
   */
  key: ReasoningTraceLimitKey | 'reasoningTraceConfig' | string;
  /** The value as given, made JSON-safe by {@link toJsonSafe}. */
  value: unknown;
  /** Why it was not used as given. */
  reason: 'not_a_positive_integer' | 'below_floor' | 'above_ceiling' | 'not_an_object' | 'unknown_key';
}

/** The resolved limits a GMI applies, with the settings it ignored or adjusted. */
export interface ReasoningTraceLimits {
  /** Entries kept; the oldest is dropped when the next arrives. */
  maxEntries: number;
  /** Characters kept per entry message. */
  maxMessageLength: number;
  /** Settings that were ignored, raised to the floor or clamped to a ceiling. */
  ignored: ReasoningTraceLimitIssue[];
}

/** True for an integer greater than zero. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Makes a setting's value safe to record in a trace entry, which is cloned
 * through JSON: finite numbers, strings, booleans and null pass through;
 * `NaN`, `Infinity`, bigints, symbols, functions and objects become their
 * `String()` form, or `[unserializable]` when even that throws.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

const KEYS: readonly ReasoningTraceLimitKey[] = ['maxEntries', 'maxMessageLength'];
const FLOORS = { maxEntries: REASONING_TRACE_MIN_ENTRIES, maxMessageLength: 1 } as const;
const CEILINGS = {
  maxEntries: REASONING_TRACE_MAX_ENTRIES_CEILING,
  maxMessageLength: REASONING_TRACE_MAX_MESSAGE_LENGTH_CEILING,
} as const;
const DEFAULTS = {
  maxEntries: DEFAULT_REASONING_TRACE_MAX_ENTRIES,
  maxMessageLength: DEFAULT_REASONING_TRACE_MAX_MESSAGE_LENGTH,
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Picks each limit from the persona, then the runtime config, then the
 * defaults: the first positive integer wins, raised to its floor or clamped to
 * its ceiling. Every setting that was defined but not usable as given is listed
 * in `ignored`, whether or not a higher-precedence setting won: a persona field
 * that is not an object, an unknown key, a value that is not a positive
 * integer, and a value below the floor or above the ceiling.
 */
export function resolveReasoningTraceLimits(
  persona?: Pick<IPersonaDefinition, 'reasoningTraceConfig'>,
  config?: Pick<GMIBaseConfig, 'defaultReasoningTraceMaxEntries' | 'defaultReasoningTraceMaxMessageLength'>,
): ReasoningTraceLimits {
  const ignored: ReasoningTraceLimitIssue[] = [];
  const personaField: unknown = persona?.reasoningTraceConfig;
  let personaValues: Record<string, unknown> = {};
  if (personaField !== undefined) {
    if (isPlainObject(personaField)) {
      personaValues = personaField;
      for (const name of Object.keys(personaField)) {
        if (!(KEYS as readonly string[]).includes(name)) {
          ignored.push({ source: 'persona', key: name, value: toJsonSafe(personaField[name]), reason: 'unknown_key' });
        }
      }
    } else {
      ignored.push({ source: 'persona', key: 'reasoningTraceConfig', value: toJsonSafe(personaField), reason: 'not_an_object' });
    }
  }

  const pick = (key: ReasoningTraceLimitKey): number => {
    const candidates: Array<[ReasoningTraceLimitIssue['source'], unknown]> = [
      ['persona', personaValues[key]],
      ['config', key === 'maxEntries' ? config?.defaultReasoningTraceMaxEntries : config?.defaultReasoningTraceMaxMessageLength],
    ];
    let chosen: number | undefined;
    for (const [source, value] of candidates) {
      if (value === undefined) continue;
      let usable: number | undefined;
      if (!isPositiveInteger(value)) {
        ignored.push({ source, key, value: toJsonSafe(value), reason: 'not_a_positive_integer' });
      } else if (value < FLOORS[key]) {
        ignored.push({ source, key, value, reason: 'below_floor' });
        usable = FLOORS[key];
      } else if (value > CEILINGS[key]) {
        ignored.push({ source, key, value, reason: 'above_ceiling' });
        usable = CEILINGS[key];
      } else {
        usable = value;
      }
      if (chosen === undefined && usable !== undefined) chosen = usable;
    }
    return chosen ?? DEFAULTS[key];
  };

  return { maxEntries: pick('maxEntries'), maxMessageLength: pick('maxMessageLength'), ignored };
}
