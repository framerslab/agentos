/**
 * @fileoverview A component logger whose every line goes to the logger the
 * current factory makes. `createLogger` asks the factory once, when it is
 * called; a module that keeps its logger from import time would write past a
 * factory the host sets with `setLoggerFactory` after importing the package,
 * which an ESM import always runs first.
 */
import type { ILogger } from '../../core/logging/ILogger.js';
import { createLogger } from '../../core/logging/loggerFactory.js';

/**
 * A logger for `name` that asks {@link createLogger} for the component's
 * logger at every line, so the host's factory receives it whenever the host
 * set it. For a module-level logger whose lines are rare (failover, a failed
 * seat, a run no seat answered).
 *
 * @param name - The component name.
 * @returns A logger that resolves the component's logger at each line.
 */
export function lazyLogger(name: string): ILogger {
  // Each line is handed on with the caller's own arguments.
  return {
    info: (...args: Parameters<ILogger['info']>) => createLogger(name).info(...args),
    warn: (...args: Parameters<ILogger['warn']>) => createLogger(name).warn(...args),
    error: (...args: Parameters<ILogger['error']>) => createLogger(name).error(...args),
    debug: (...args: Parameters<NonNullable<ILogger['debug']>>) => createLogger(name).debug?.(...args),
  };
}
