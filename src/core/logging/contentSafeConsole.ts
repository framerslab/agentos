/**
 * @fileoverview The console binding of AgentOS's provider, generation and embedding modules, which honours
 * content-safe telemetry. A module imports it as `console` in place of the global one; the global console object is
 * never replaced.
 * @module agentos/logging/contentSafeConsole
 */
import { emitContentSafeLog, type ContentSafeLogLevel } from './contentSafeTelemetry.js';

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error' | 'log';
function write(method: ConsoleMethod, args: unknown[]): void {
  const level: ContentSafeLogLevel = method === 'log' ? 'info' : method;
  if (emitContentSafeLog(level)) return;
  globalThis.console[method](...args);
}

/**
 * The five console methods AgentOS's provider, generation and embedding modules use, imported there with
 * `import { contentSafeConsole as console }`.
 *
 * While content-safe telemetry is off, each method calls the global console's method of the same name, looked up at
 * call time, with the same arguments. While it is on, a call becomes one fixed event (`log` counts as `info`) and none
 * of its arguments is enumerated, serialized or forwarded. The calling expression still evaluates its arguments.
 *
 * @internal
 */
export const contentSafeConsole = Object.freeze({
  debug: (...args: unknown[]): void => write('debug', args),
  info: (...args: unknown[]): void => write('info', args),
  warn: (...args: unknown[]): void => write('warn', args),
  error: (...args: unknown[]): void => write('error', args),
  log: (...args: unknown[]): void => write('log', args),
});
