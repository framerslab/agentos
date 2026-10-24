/**
 * @fileoverview The level of AgentOS's default logger, read from the environment.
 *
 * @module agentos/core/logging/level
 */

/** The level names pino takes, from the most verbose to the least, then `silent`. */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

/**
 * Reads the default logger's level from the environment.
 *
 * `AGENTOS_LOG_LEVEL` names the level, in any case. A value that is not a level name gives
 * `info` with `unknown` set, and the caller writes one `logging.level_unknown` line, which
 * never repeats the value. When `AGENTOS_LOG_LEVEL` is unset or names a level,
 * `AGENTOS_DEBUG=1` or `AGENTOS_DEBUG=true` gives `debug`, as the providers' start-up checks
 * read them. With neither set the level is `info`.
 *
 * @param env - The environment to read, usually `process.env`.
 * @returns The level, and whether `AGENTOS_LOG_LEVEL` held a value that is not a level name.
 *
 * @example
 * ```ts
 * parseLogLevel({ AGENTOS_LOG_LEVEL: 'warn' }); // { level: 'warn', unknown: false }
 * parseLogLevel({ AGENTOS_LOG_LEVEL: 'DEBUG' }); // { level: 'debug', unknown: false }
 * parseLogLevel({ AGENTOS_LOG_LEVEL: 'loud' }); // { level: 'info', unknown: true }
 * parseLogLevel({ AGENTOS_DEBUG: 'true' }); // { level: 'debug', unknown: false }
 * ```
 */
export function parseLogLevel(env: Record<string, string | undefined>): {
  level: (typeof LEVELS)[number]; unknown: boolean;
} {
  const value = env.AGENTOS_LOG_LEVEL?.toLowerCase();
  if (value && !LEVELS.includes(value as (typeof LEVELS)[number])) return { level: 'info', unknown: true };
  if (env.AGENTOS_DEBUG === '1' || env.AGENTOS_DEBUG === 'true') return { level: 'debug', unknown: false };
  return { level: (value || 'info') as (typeof LEVELS)[number], unknown: false };
}
