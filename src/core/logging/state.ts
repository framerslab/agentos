/**
 * @fileoverview The one logging state every copy of AgentOS in a process shares.
 *
 * The state lives on `globalThis` under `Symbol.for('agentos.logging.state.v1')`, so a
 * product and a pack's nested install of AgentOS obey one hand-over. The `v1` in the key
 * changes only when the state's shape does.
 *
 * @module agentos/core/logging/state
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ILogger } from './ILogger.js';
import type { Logger } from './Logger.js';
import type { PinoLogger } from './PinoLogger.js';

/** A host's factory: called with a component's name and its bindings, it returns that component's logger. */
export type LoggerFactory = (name: string, bindings?: Record<string, any>) => ILogger;

/**
 * Where AgentOS's lines go: the lazy default root, a logger from `setLogger`, a factory from
 * `setLoggerFactory`, or nowhere after `setLogger(null)`.
 */
export type Target = { mode: 'default' } | { mode: 'silent' } | { mode: 'logger'; logger: Logger } | { mode: 'factory'; factory: LoggerFactory };

/**
 * One burst budget for the current minute, kept for an event or a refusal reason and shared by
 * every kit instance in the process.
 */
export interface Minute {
  /** When the minute began, in milliseconds since the epoch. */
  start: number;
  /** Lines written in this minute. */
  written: number;
  /** Lines held back in this minute, reported in one line when the minute ends. */
  held: number;
  /** The smallest bound any kit asked for in this minute. */
  limit: number;
  /** The kit that opened the budget, whose writer reports the held lines. */
  owner: symbol;
  /** The event or the refusal reason the held-lines report names. */
  name: string;
}

/** The process-wide logging state. */
export interface LoggingState {
  /** Where lines go now. The last setter wins. */
  target: Target;
  /** The default pino root, built on its first use and dropped by `resetLoggerFactory`. */
  root?: PinoLogger;
  /** Whether the line about an unknown `AGENTOS_LOG_LEVEL` has been written; it is written once. */
  levelWarned: boolean;
  /** The current request's id, which the forwarding layer adds to each line's context. */
  requests: AsyncLocalStorage<{ requestId: string }>;
  /** The burst budgets of the current minute, by key. */
  minutes: Map<string, Minute>;
  /** Each open kit's writer for its held-lines reports. */
  owners: Map<symbol, (name: string, n: number) => void>;
  /** The unreferenced timer that reports held lines when a minute ends. */
  timer?: ReturnType<typeof setTimeout>;
  /** Removes the installed process handlers, when a kit has installed them. */
  removeProcessHandlers?: () => void;
}
const KEY = Symbol.for('agentos.logging.state.v1');

/**
 * The process's logging state, created on the first call. Every copy of AgentOS in the
 * process reads the same object.
 *
 * @returns The shared state.
 */
export function getLoggingState(): LoggingState {
  const holder = globalThis as unknown as Record<symbol, LoggingState | undefined>;
  return holder[KEY] ??= {
    target: { mode: 'default' }, levelWarned: false,
    requests: new AsyncLocalStorage(), minutes: new Map(), owners: new Map(),
  };
}
