/**
 * @fileoverview The logger shapes AgentOS writes its lines through.
 *
 * `Logger` is the pino-shaped logger a host hands over with `setLogger`: a pino logger and a
 * pino child each fit it with no wrapper. `EventLogger` is the typed handle AgentOS writes
 * through, whose methods take only a declared event with its declared fields.
 *
 * @module agentos/core/logging/Logger
 */

import type { ContextSchema, EventMap, Fields, ContextValues } from './events.js';

/** The levels AgentOS writes at: per-turn detail at `debug` up to the process's last line at `fatal`. */
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** One level method of a pino-shaped logger: an object first with an optional message, or a message alone. */
export interface LogMethod {
  (obj: object, msg?: string): void;
  (msg: string): void;
}

/**
 * The logger a host hands over with `setLogger`. AgentOS writes each of its lines object
 * first, as `logger.warn({ event, ...context, ...fields })`, with no message.
 */
export interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
  child(bindings: Record<string, string | number>): Logger;
}

/**
 * One level method of an {@link EventLogger}: a declared event and its declared fields, any
 * of which may be left out. A context key is never a field.
 *
 * @typeParam E - The event map the method accepts.
 * @typeParam C - The context schema whose keys a field cannot set.
 */
export type EventMethod<E extends EventMap, C extends ContextSchema> =
  <K extends keyof E & string>(event: K, fields?: Fields<E[K]> & { [P in keyof C]?: never }) => void;

/**
 * A typed handle over an event map: an {@link EventMethod} per level, and `child` to bind
 * context keys onto the lines it writes.
 *
 * @typeParam E - The event map.
 * @typeParam C - The context schema, AgentOS's own unless given.
 */
export type EventLogger<E extends EventMap, C extends ContextSchema = typeof import('./events.js').AGENTOS_CONTEXT> = {
  [L in Level]: EventMethod<E, C>;
} & { child(bindings: ContextValues<C>): EventLogger<E, C> };
