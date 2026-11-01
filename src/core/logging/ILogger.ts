/**
 * @fileoverview The logger interface AgentOS's components take and a host's factory returns.
 *
 * @module agentos/core/logging/ILogger
 */

/**
 * A component's logger: a message, which is an event's name on AgentOS's own lines, and
 * optional metadata per call. `debug`, `fatal` and `child` are optional. When AgentOS writes
 * to a factory's logger, a `fatal` line goes to `error` if the logger has no `fatal`, and a
 * `debug` line is dropped if it has no `debug`.
 */
export interface ILogger {
  info(message: string, meta?: Record<string, any>): void;
  warn(message: string, meta?: Record<string, any>): void;
  error(message: string, meta?: Record<string, any>): void;
  debug?(message: string, meta?: Record<string, any>): void;
  fatal?(message: string, meta?: Record<string, any>): void;
  child?(bindings: Record<string, any>): ILogger;
}
