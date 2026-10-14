/**
 * @fileoverview How a host hands AgentOS its logger, and the handles AgentOS writes through.
 *
 * `setLogger` takes a pino-shaped logger, `setLoggerFactory` takes a factory of `ILogger`s,
 * `setLogger(null)` silences AgentOS, and `resetLoggerFactory` returns to the default pino
 * root, which is built on its first use. The last setter wins. `createLogger` keeps its
 * contract: it calls the current factory at once and returns that factory's object.
 * `lazyLogger` returns a typed handle that reads the current target at each write, and so do
 * its children.
 *
 * @module agentos/core/logging/loggerFactory
 */

import type { ILogger } from './ILogger.js';
import type { Logger, Level, EventLogger } from './Logger.js';
import type { AgentOSEvents, AgentOSContext } from './events.js';
import { AGENTOS_CONTEXT } from './events.js';
import { getLoggingState, type LoggerFactory, type Target } from './state.js';
import { checkContext, defaultRoot, forward, isValidationError } from './forward.js';
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
 * Returns a component's logger. With a factory set, it calls the factory at once and returns
 * that factory's object. Otherwise it returns a child of the default root, or an adapter over
 * the logger or the silence set now; an object it returned keeps that target after a later
 * setter.
 *
 * @param name - The component's name.
 * @param bindings - Bindings for every line the logger writes.
 * @returns The component's logger.
 */
export function createLogger(name: string, bindings?: Record<string, any>): ILogger {
  const target = getLoggingState().target;
  if (target.mode === 'factory') return target.factory(name, bindings);
  if (target.mode === 'default') return defaultRoot().child({ component: name, ...bindings });
  return adapter(() => target, { component: name, ...bindings }, false);
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
