/**
 * @fileoverview Opt-in process handlers: the shutdown line and the process's last line.
 *
 * AgentOS never installs these. A host with handlers of its own calls the kit's `terminal()`
 * from them instead.
 *
 * @module agentos/core/logging/kit/processHandlers
 */

import { errorFields } from '../events.js';
import { getLoggingState } from '../state.js';

/** What the process handlers write through: an allow-list kit whose map declares AgentOS's process events. */
export interface ProcessKit {
  info(event: 'process.shutdown', fields: { signal: 'SIGTERM' | 'SIGINT' }): void;
  terminal(event: 'process.uncaught', fields: { type: string; code: string }): void;
}

/**
 * Installs handlers for SIGTERM, SIGINT, uncaught exceptions and unhandled rejections.
 *
 * - On SIGTERM or SIGINT, the first signal writes `process.shutdown` with the signal, then
 *   calls `onShutdown`, which owns closing the host's servers and pools and ending the
 *   process. A later signal is ignored.
 * - On an uncaught exception or an unhandled rejection, or when `onShutdown` fails, it writes
 *   `process.uncaught` with the error's type and code through `terminal()`, which bypasses the
 *   burst budget at `fatal`, then calls `onFatal`, which exits with status 1 unless the host
 *   gives its own.
 *
 * Installing is idempotent across every copy of AgentOS in the process: while the handlers are
 * installed, a second call returns the first call's remover and installs nothing.
 *
 * @param kit - The kit the lines are written through.
 * @param options - The host's callbacks.
 * @param options.onShutdown - Called once, after the shutdown line, with the signal.
 * @param options.onFatal - Called after the last line with the error; `process.exit(1)` unless given.
 * @returns A function that removes every handler it installed.
 *
 * @example
 * ```ts
 * installProcessHandlers(kit, { onShutdown: async () => { await server.close(); process.exit(0); } });
 * ```
 */
export function installProcessHandlers(kit: ProcessKit, options: {
  onShutdown: (signal: 'SIGTERM' | 'SIGINT') => void | Promise<void>;
  onFatal?: (error: unknown) => void;
}): () => void {
  const state = getLoggingState();
  if (state.removeProcessHandlers) return state.removeProcessHandlers;
  let ending = false;
  const fatal = (error: unknown) => {
    try { kit.terminal('process.uncaught', errorFields(error)); }
    finally { (options.onFatal ?? (() => process.exit(1)))(error); }
  };
  const shutdown = (signal: 'SIGTERM' | 'SIGINT') => {
    if (ending) return;
    ending = true;
    try { kit.info('process.shutdown', { signal }); }
    finally { Promise.resolve().then(() => options.onShutdown(signal)).catch(fatal); }
  };
  const term = () => shutdown('SIGTERM'); const interrupt = () => shutdown('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  process.on('uncaughtException', fatal); process.on('unhandledRejection', fatal);
  const remove = () => {
    process.off('SIGTERM', term); process.off('SIGINT', interrupt);
    process.off('uncaughtException', fatal); process.off('unhandledRejection', fatal);
    if (state.removeProcessHandlers === remove) state.removeProcessHandlers = undefined;
  };
  state.removeProcessHandlers = remove; return remove;
}
