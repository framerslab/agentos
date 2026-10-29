/**
 * @fileoverview How a host hands AgentOS its logger, the handles AgentOS writes through, and the
 * guard that keeps every logger `createLogger` hands out inside content-safe telemetry.
 *
 * `setLogger` takes a pino-shaped logger, `setLoggerFactory` takes a factory of `ILogger`s,
 * `setLogger(null)` silences AgentOS, and `resetLoggerFactory` returns to the default pino
 * root, which is built on its first use. The last setter wins. `createLogger` calls the
 * current factory at once and returns a guard over that factory's object: its calls reach the
 * object until content-safe telemetry is enabled, and from then on each becomes one fixed
 * event, even on a logger made earlier. `lazyLogger` returns a typed handle that reads the
 * current target at each write, and so do its children; while content-safe telemetry is on,
 * each of their lines is one fixed event as well.
 *
 * @module agentos/core/logging/loggerFactory
 */

import type { ILogger } from './ILogger.js';
import type { Logger, Level, EventLogger } from './Logger.js';
import type { AgentOSEvents, AgentOSContext } from './events.js';
import { AGENTOS_CONTEXT } from './events.js';
import { getLoggingState, type LoggerFactory, type Target } from './state.js';
import { checkContext, defaultRoot, forward, isValidationError } from './forward.js';
import { emitContentSafeLog, isContentSafeTelemetryEnabled } from './contentSafeTelemetry.js';
export type { LoggerFactory } from './state.js';

/**
 * Hands AgentOS a pino-shaped logger, or silences it with `null`. Lazy handles, whenever they
 * were made, write to it from their next line; an object `createLogger` returned earlier keeps
 * its target.
 *
 * @param logger - A logger with `debug`, `info`, `warn`, `error`, `fatal` and `child`, such as a pino logger or a pino child, or `null` to write nothing.
 * @throws {TypeError} When one of those methods is missing, naming it.
 *
 * @example
 * ```ts
 * import pino from 'pino';
 * setLogger(pino());
 * ```
 */
export function setLogger(logger: Logger | null): void {
  if (logger !== null) {
    for (const name of ['debug', 'info', 'warn', 'error', 'fatal', 'child'] as const) {
      if (typeof logger?.[name] !== 'function') throw new TypeError(`Logger.${name} must be a function`);
    }
  }
  getLoggingState().target = logger === null ? { mode: 'silent' } : { mode: 'logger', logger };
}

/**
 * Wraps `raw` so each call is checked against content-safe telemetry when it is made. While the mode is off, a call
 * goes to `raw` with the caller's own arguments, a `fatal` call to `raw.error` when `raw` has no `fatal`; while it is
 * on, it becomes one fixed event and `raw` is not called.
 */
function guarded(raw?: ILogger): ILogger {
  const logger: ILogger = {
    info(...args: Parameters<ILogger['info']>) {
      if (!emitContentSafeLog('info')) raw?.info(...args);
    },
    warn(...args: Parameters<ILogger['warn']>) {
      if (!emitContentSafeLog('warn')) raw?.warn(...args);
    },
    error(...args: Parameters<ILogger['error']>) {
      if (!emitContentSafeLog('error')) raw?.error(...args);
    },
    debug(...args: Parameters<NonNullable<ILogger['debug']>>) {
      if (!emitContentSafeLog('debug')) raw?.debug?.(...args);
    },
    fatal(...args: Parameters<NonNullable<ILogger['fatal']>>) {
      if (emitContentSafeLog('error')) return;
      if (raw?.fatal) raw.fatal(...args);
      else raw?.error(...args);
    },
    child(bindings) {
      if (isContentSafeTelemetryEnabled()) return logger;
      return guarded(raw?.child ? raw.child(bindings) : raw);
    },
  };
  return logger;
}

/**
 * Hands AgentOS a factory of `ILogger`s. `createLogger` calls it at once. A lazy handle calls
 * it at each write with its component and context, and writes `(event, fields)` to the logger
 * it returns.
 *
 * @param factory - The factory.
 */
export function setLoggerFactory(factory: LoggerFactory): void { getLoggingState().target = { mode: 'factory', factory }; }

/** Returns AgentOS to its default pino root, which is built again on its next use. */
export function resetLoggerFactory(): void {
  const state = getLoggingState(); state.target = { mode: 'default' }; state.root = undefined;
}

// An ILogger over the target `target()` returns at each write. A child merges its bindings onto its parent's. With
// `strict` they are checked against AgentOS's context schema before the child is made: a child whose bindings fail
// writes one `log_refused` line and then nothing, and under NODE_ENV=test the failure is thrown instead.
function adapter(target: () => Target, bindings: Record<string, any>, strict: boolean, disabled = false): ILogger {
  const write = (level: Level) => (event: string, fields: Record<string, unknown> = {}) => {
    if (!disabled) forward(target(), level, event, fields, bindings, strict);
  };
  return {
    debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error'), fatal: write('fatal'),
    child(child) {
      const merged = { ...bindings, ...child };
      if (strict) {
        try { checkContext(AGENTOS_CONTEXT, merged); }
        catch (error) {
          if (!isValidationError(error)) throw error;
          if (process.env.NODE_ENV === 'test') throw error;
          forward(target(), 'warn', 'log_refused', { reason: 'bad_context' }, {}, false);
          return adapter(target, {}, strict, true);
        }
      }
      return adapter(target, merged, strict, disabled);
    },
  };
}

/**
 * Returns a component's logger: a guard over the logger the current target gives. With a factory
 * set, it calls the factory at once; otherwise it takes a child of the default root, or an
 * adapter over the logger or the silence set now, and that logger keeps its target after a later
 * setter. The guard's calls reach that logger, with the caller's arguments, until content-safe
 * telemetry is enabled; from then on each call becomes one fixed event for the host's sink, even
 * on a logger made earlier, and `child` returns the same logger. While the mode is on, the
 * factory is not called and nothing is made.
 *
 * @param name - The component's name.
 * @param bindings - Bindings for every line the logger writes.
 * @returns The component's logger.
 */
export function createLogger(name: string, bindings?: Record<string, any>): ILogger {
  if (isContentSafeTelemetryEnabled()) return guarded();
  const target = getLoggingState().target;
  if (target.mode === 'factory') return guarded(target.factory(name, bindings));
  if (target.mode === 'default') return guarded(defaultRoot().child({ component: name, ...bindings }));
  return guarded(adapter(() => target, { component: name, ...bindings }, false));
}

/**
 * Returns a typed handle that reads the current target at each write, so a handle made at
 * import follows a later `setLogger` or `setLoggerFactory`; its children do the same. Its
 * methods take only an event `AGENTOS_EVENTS` declares, with that event's fields.
 *
 * @param component - The component the lines come from.
 * @param context - More context keys to bind, such as `extension`.
 * @returns The handle.
 * @throws {LogValidationError} Under `NODE_ENV=test`, when the component or the context breaks AgentOS's context schema; otherwise such a handle writes one `log_refused` line and then nothing.
 *
 * @example
 * ```ts
 * const log = lazyLogger('OpenAIProvider');
 * log.warn('llm.retry', { provider: 'openai', status: 429, attempt: 1, waitMs: 2000 });
 * ```
 */
export function lazyLogger(component: string, context: AgentOSContext = {}): EventLogger<AgentOSEvents> {
  return adapter(() => getLoggingState().target, {}, true).child!({ component, ...context }) as EventLogger<AgentOSEvents>;
}
