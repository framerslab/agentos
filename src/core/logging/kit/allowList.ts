/**
 * @fileoverview The allow-list logger: a typed logger over a product's event map that writes
 * only declared events with fields of their declared kinds.
 *
 * A line the product writes through the kit is refused when its event is undeclared, or when a
 * field or the context breaks its kind. A refusal is written as `log_refused` at `warn` with a
 * fixed reason (`unknown_event`, `unknown_key`, `bad_value` or `bad_context`), plus the
 * event's name only when the event is declared, and never the key or the value; under
 * `NODE_ENV=test` it is thrown as a `LogValidationError` instead. A line that reaches the
 * kit's pino-shaped form, `asLogger()`, with an undeclared event is written as
 * `agentos.untyped` with only its component and its level, so a sentence from code that has
 * not moved to events never reaches the log. Every line counts against the burst budgets the
 * process shares.
 *
 * @module agentos/core/logging/kit/allowList
 */

import type { EventLogger, Level, Logger, LogMethod } from '../Logger.js';
import { AGENTOS_CONTEXT, AGENTOS_EVENTS, errorFields, safeWord, valid, type ContextSchema, type EventMap, type Fields } from '../events.js';
import { checkContext, checkFields, isValidationError, LogValidationError, sinkCall, type RefusalReason } from '../forward.js';
import { admit, burstOwner, closeOwner } from './burst.js';

/**
 * The logger {@link createAllowListLogger} returns: an `EventLogger` over the product's event
 * map, plus three methods.
 *
 * - `asLogger()` returns the pino-shaped form that `setLogger` takes.
 * - `terminal(event, fields)` writes the process's last line at `fatal`. It bypasses the burst
 *   budget and never refuses: a field that breaks its kind is left out, and an undeclared
 *   event is written as `process.uncaught`.
 * - `close()` stops the kit writing. Closing a child closes the kit it came from; closing the
 *   last open kit in the process clears the shared counters and their timer.
 *
 * @typeParam E - The product's event map.
 * @typeParam C - The context schema.
 */
export type AllowListLogger<E extends EventMap, C extends ContextSchema> = EventLogger<E, C> & {
  asLogger(): Logger;
  terminal<K extends keyof E & string>(event: K, fields?: Fields<E[K]>): void;
  close(): void;
};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Creates an allow-list logger over a product's event map. AgentOS's own events are always
 * declared; the product's map adds its own and those of the packs it uses. No process
 * listener is installed by importing or creating a kit.
 *
 * @param options - The kit's settings.
 * @param options.logger - The pino logger, or pino child, the kit writes through.
 * @param options.events - The product's event map.
 * @param options.context - The context keys a child may bind, AgentOS's own unless given.
 * @param options.burst - Lines a minute for each event and each refusal reason, 30 unless set. Every kit in the process shares the budgets, at the smallest bound asked for.
 * @returns The kit.
 * @throws {TypeError} When `burst` is not a positive integer, an event's name is not a word of at most 64 characters or is `log_refused` or `log_held`, or an event declares a context key, `event`, `level` or `time` as a field.
 *
 * @example
 * ```ts
 * import pino from 'pino';
 * const kit = createAllowListLogger({ logger: pino(), events: { 'job.done': { ms: 'int' } } });
 * kit.info('job.done', { ms: 120 });
 * setLogger(kit.asLogger());
 * ```
 */
export function createAllowListLogger<E extends EventMap, C extends ContextSchema = typeof AGENTOS_CONTEXT>(options: {
  logger: Logger; events: E; context?: C; burst?: number;
}): AllowListLogger<E, C> {
  const events: EventMap = { ...AGENTOS_EVENTS, ...options.events };
  const schema = (options.context ?? AGENTOS_CONTEXT) as C;
  const limit = options.burst ?? 30;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('burst must be a positive integer');
  // The refusal and held-lines records are the kit's own, so a product map can neither declare nor overwrite them.
  for (const [name, fields] of Object.entries(events)) {
    if (name === 'log_refused' || name === 'log_held' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) throw new TypeError('invalid event declaration');
    for (const key of Object.keys(fields)) if (own(schema, key) || key === 'event' || key === 'level' || key === 'time') throw new TypeError('reserved field declaration');
  }
  let closed = false;
  const raw = (level: Level, fields: Record<string, unknown>) => { if (!closed) sinkCall(() => options.logger[level](fields)); };
  const owner = burstOwner((name, n) => raw('info', { event: 'log_held', name, n }));
  function refuse(reason: RefusalReason, event?: string): void {
    if (process.env.NODE_ENV === 'test') throw new LogValidationError(reason);
    if (admit(owner, `reason:${reason}`, reason, limit)) raw('warn', { event: 'log_refused', reason, ...(event && own(events, event) ? { name: event } : {}) });
  }
  // One logger over `bindings`. A child whose bindings fail the context schema writes one refusal and is then
  // disabled, so it writes nothing.
  function make(bindings: Record<string, unknown>, disabled = false): AllowListLogger<E, C> {
    function write(level: Level, event: string, fields: Record<string, unknown> = {}, adapter = false): void {
      if (closed || disabled) return;
      if (adapter && !own(events, event)) {
        if (admit(owner, 'event:agentos.untyped', 'agentos.untyped', limit)) raw(level, { event: 'agentos.untyped', ...(bindings.component ? { component: bindings.component } : {}), sourceLevel: level });
        return;
      }
      try { checkContext(schema, bindings); checkFields(events, schema, event, fields); }
      catch (error) { if (isValidationError(error)) { refuse(error.reason, event); return; } throw error; }
      if (admit(owner, `event:${event}`, event, limit)) raw(level, { ...bindings, ...fields, event });
    }
    function child(next: Record<string, unknown>): AllowListLogger<E, C> {
      const merged = { ...bindings, ...next };
      try { checkContext(schema, merged); }
      catch (error) { if (isValidationError(error)) { refuse('bad_context'); return make({}, true); } throw error; }
      return make(merged, disabled);
    }
    const api = {
      debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
      info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
      warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
      error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
      fatal: (event: string, fields?: Record<string, unknown>) => write('fatal', event, fields),
      child,
      terminal(event: string, fields: Record<string, unknown> = {}) {
        if (closed || disabled) return;
        // Terminal never routes an unsafe value into a refusal or echoes it.
        const safe: Record<string, unknown> = {};
        const shape = events[event];
        if (shape) {
          for (const [key, value] of Object.entries(fields)) {
            try { checkFields(events, schema, event, { [key]: value }); safe[key] = value; } catch { /* Omit an invalid terminal field. */ }
          }
          raw('fatal', { ...bindings, ...safe, event });
        } else raw('fatal', { event: 'process.uncaught', ...errorFields(undefined) });
      },
      close() { if (!closed) { closeOwner(owner); closed = true; } },
      // The pino-shaped form. A host's line arrives as one object holding its event, its context and its fields;
      // a message alone has no event, so it is written as agentos.untyped. A refusal another layer forwards is
      // written again as this kit's own, from its reason and declared name alone.
      asLogger(): Logger {
        const method = (level: Level): LogMethod => ((obj: object | string) => {
          if (closed || disabled) return;
          if (typeof obj === 'string') { write(level, '', {}, true); return; }
          if (obj === null) { write(level, '', {}, true); return; }
          const input = obj as Record<string, unknown>;
          const event = typeof input.event === 'string' ? input.event : '';
          if (event === 'log_refused') {
            const reasons: RefusalReason[] = ['unknown_event', 'unknown_key', 'bad_value', 'bad_context'];
            const reason = reasons.includes(input.reason as RefusalReason) ? input.reason as RefusalReason : 'bad_value';
            refuse(reason, typeof input.name === 'string' && own(events, input.name) ? input.name : undefined);
            return;
          }
          if (!own(events, event)) {
            const component = valid('word', input.component) ? input.component as string : bindings.component;
            if (admit(owner, 'event:agentos.untyped', 'agentos.untyped', limit)) {
              raw(level, { event: 'agentos.untyped', ...(component ? { component } : {}), sourceLevel: level });
            }
            return;
          }
          const context = { ...bindings }; const fields: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(input)) {
            if (key === 'event') continue;
            if (own(schema, key)) context[key] = value; else fields[key] = value;
          }
          try { checkContext(schema, context); }
          catch (error) { if (isValidationError(error)) { refuse('bad_context', event); return; } throw error; }
          make(context)[level](event as keyof E & string, fields as never);
        }) as LogMethod;
        return { debug: method('debug'), info: method('info'), warn: method('warn'), error: method('error'), fatal: method('fatal'), child: next => child(next).asLogger() };
      },
    };
    return api as AllowListLogger<E, C>;
  }
  return make({});
}
export { safeWord };
