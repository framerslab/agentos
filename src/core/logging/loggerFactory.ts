/**
 * @fileoverview The process-wide logger factory behind `createLogger`, and the guard that keeps every logger it
 * hands out, including one made before content-safe telemetry was enabled, inside that mode.
 * @module agentos/logging/loggerFactory
 */
import type { ILogger } from './ILogger.js';
import { PinoLogger } from './PinoLogger.js';
import { emitContentSafeLog, isContentSafeTelemetryEnabled } from './contentSafeTelemetry.js';

/**
 * Makes the logger `createLogger` delegates to, from a component name and optional bindings.
 */
export type LoggerFactory = (name: string, bindings?: Record<string, any>) => ILogger;
let rootLogger = new PinoLogger({ name: 'agentos' });
let currentFactory: LoggerFactory = (name, bindings) =>
  rootLogger.child({ component: name, ...(bindings || {}) });

/**
 * Wraps `raw` so each call is checked against content-safe telemetry when it is made. While the mode is off, a call
 * goes to `raw` with the caller's own arguments; while it is on, it becomes one fixed event and `raw` is not called.
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
    child(bindings) {
      if (isContentSafeTelemetryEnabled()) return logger;
      return guarded(raw?.child ? raw.child(bindings) : raw);
    },
  };
  return logger;
}

/**
 * Sets the factory that later `createLogger` calls delegate to.
 *
 * @param factory - Makes the logger for a component name and optional bindings.
 */
export function setLoggerFactory(factory: LoggerFactory): void { currentFactory = factory; }

/**
 * Restores the default factory: children of a new root `PinoLogger` named `agentos`.
 */
export function resetLoggerFactory(): void {
  rootLogger = new PinoLogger({ name: 'agentos' });
  currentFactory = (name, bindings) => rootLogger.child({ component: name, ...(bindings || {}) });
}

/**
 * A logger for one component. Its calls go to the logger the current factory makes, with the caller's arguments,
 * until content-safe telemetry is enabled; from then on each call becomes one fixed event for the host's sink, even
 * on a logger created earlier. While the mode is on, the factory is not called and `child` returns the same logger.
 *
 * @param name - The component name.
 * @param bindings - Fields every record of the logger carries.
 * @returns The component's logger.
 */
export function createLogger(name: string, bindings?: Record<string, any>): ILogger {
  if (isContentSafeTelemetryEnabled()) return guarded();
  return guarded(currentFactory(name, bindings));
}
