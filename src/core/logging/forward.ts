/**
 * @fileoverview Turns an event, its context and the current request's id into the call the
 * current target takes, and keeps a failing sink away from the caller.
 *
 * A sink that throws never reaches the caller. A failed check is a `LogValidationError`:
 * under `NODE_ENV=test` it is thrown, so a test that writes a bad field fails, and otherwise
 * it becomes one `log_refused` line with a fixed reason and no key or value.
 *
 * @module agentos/core/logging/forward
 */

import type { Level } from './Logger.js';
import type { Target } from './state.js';
import { getLoggingState } from './state.js';
import { AGENTOS_CONTEXT, AGENTOS_EVENTS, valid, type ContextSchema, type EventMap } from './events.js';
import { PinoLogger } from './PinoLogger.js';
import { parseLogLevel } from './level.js';
import { emitContentSafeLog } from './contentSafeTelemetry.js';

/** Why a line was refused. A refusal line carries the reason, never the key or the value. */
export type RefusalReason = 'unknown_event' | 'unknown_key' | 'bad_value' | 'bad_context';
// Marks a validation error so that another copy of the package recognises it, where instanceof fails.
const ERROR = Symbol.for('agentos.logging.validation.v1');

/** A line that failed its event, field or context check. */
export class LogValidationError extends Error {
  readonly [ERROR] = true;
  /** @param reason - Why the line was refused. */
  constructor(readonly reason: RefusalReason) { super(reason); this.name = 'LogValidationError'; }
}

/**
 * Whether a value is a {@link LogValidationError}, including one thrown by another copy of
 * AgentOS in the process.
 *
 * @param error - The caught value.
 * @returns `true` for a validation error from any copy of the package.
 */
export function isValidationError(error: unknown): error is LogValidationError {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[ERROR] === true;
}

/**
 * Runs one write to a sink and swallows what it throws, except a validation error under
 * `NODE_ENV=test`, which reaches the test.
 *
 * @param write - The write to run.
 */
export function sinkCall(write: () => void): void {
  try { write(); } catch (error) { if (process.env.NODE_ENV === 'test' && isValidationError(error)) throw error; }
}

/**
 * Checks bindings against a context schema.
 *
 * @param schema - The keys a child may bind, and their kinds.
 * @param bindings - The bindings to check.
 * @throws {LogValidationError} With `bad_context` when a key is not in the schema or its value breaks its kind.
 */
export function checkContext(schema: ContextSchema, bindings: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(bindings)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key) || !valid(schema[key], value, key)) throw new LogValidationError('bad_context');
  }
}

/**
 * Checks an event and its fields against an event map.
 *
 * @param events - The declared events.
 * @param context - The context schema, whose keys a field cannot set.
 * @param event - The event's name.
 * @param fields - The event's fields.
 * @throws {LogValidationError} With `unknown_event` for an undeclared event, `unknown_key` for an undeclared field or a context key, and `bad_value` for a value that breaks its kind.
 */
export function checkFields(events: EventMap, context: ContextSchema, event: string, fields: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(events, event)) throw new LogValidationError('unknown_event');
  for (const [key, value] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(context, key) || !Object.prototype.hasOwnProperty.call(events[event], key)) throw new LogValidationError('unknown_key');
    if (!valid(events[event][key], value)) throw new LogValidationError('bad_value');
  }
}

/**
 * The default pino root, built on its first use at the level the environment names. When
 * `AGENTOS_LOG_LEVEL` holds a value that is not a level name, the first build in the process
 * writes one `logging.level_unknown` line, which never repeats the value.
 *
 * @returns The shared root.
 */
export function defaultRoot(): PinoLogger {
  const state = getLoggingState();
  if (!state.root) {
    const parsed = parseLogLevel(process.env);
    state.root = new PinoLogger({ name: 'agentos', level: parsed.level });
    if (parsed.unknown && !state.levelWarned) {
      state.levelWarned = true;
      sinkCall(() => state.root!.writeEvent('warn', 'logging.level_unknown', {}));
    }
  }
  return state.root;
}

/**
 * Writes one line to a target.
 *
 * The line's context is the handle's bindings plus the current request's id. With `strict`
 * the context is checked, and so are the fields of an event `AGENTOS_EVENTS` declares; a
 * pack's events are declared in the pack's own map, so they pass on to the host's checks. A
 * failed check is thrown under `NODE_ENV=test` and otherwise written as `log_refused`.
 *
 * A logger gets `logger[level]({ ...context, ...fields, event })`, with no message, and the
 * default root writes the same object. A factory's logger gets `(event, fields)`: at `error`
 * when it has no `fatal`, and not at all at `debug` when it has no `debug`. A silent target
 * gets nothing. While content-safe telemetry is on, any other target gets nothing either: the
 * line becomes one fixed event for the host's sink (a `fatal` line at `error`), before any
 * check, and nothing of it is read.
 *
 * @param target - Where the line goes.
 * @param level - The line's level.
 * @param event - The event's name.
 * @param fields - The event's fields.
 * @param context - The handle's bindings.
 * @param strict - Whether to check the context and the fields; `createLogger`'s adapters pass `false`.
 */
export function forward(target: Target, level: Level, event: string, fields: Record<string, unknown>, context: Record<string, any>, strict = true): void {
  if (target.mode === 'silent') return;
  if (emitContentSafeLog(level === 'fatal' ? 'error' : level)) return;
  const requestId = getLoggingState().requests.getStore()?.requestId;
  // Annotated: a spread keeps an index signature only when every part has one, so the inferred type would lose
  // the context's keys (component among them).
  const merged: Record<string, any> = { ...context, ...(requestId ? { requestId } : {}) };
  if (strict) {
    try {
      checkContext(AGENTOS_CONTEXT, merged);
      if (Object.prototype.hasOwnProperty.call(AGENTOS_EVENTS, event)) checkFields(AGENTOS_EVENTS, AGENTOS_CONTEXT, event, fields);
    } catch (error) {
      if (!isValidationError(error)) return;
      if (process.env.NODE_ENV === 'test') throw error;
      forward(target, 'warn', 'log_refused', { reason: error.reason, ...(Object.prototype.hasOwnProperty.call(AGENTOS_EVENTS, event) ? { name: event } : {}) }, {}, false);
      return;
    }
  }
  sinkCall(() => {
    if (target.mode === 'logger') { target.logger[level]({ ...merged, ...fields, event }); return; }
    if (target.mode === 'default') { defaultRoot().writeEvent(level, event, { ...merged, ...fields }); return; }
    const log = target.factory(String(merged.component ?? 'agentos'), merged);
    const method = level === 'fatal' ? log.fatal ?? log.error : log[level];
    method?.call(log, event, fields);
  });
}
