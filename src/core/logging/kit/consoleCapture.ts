/**
 * @fileoverview Console capture: each console call becomes one content-free `console_line`
 * event.
 *
 * The event carries the console method and, when one of the values is an error, its type and
 * code. The text is never written. For an error, the frames of its stack after the exact
 * opening (its name, `: ` and its message) go to standard error through the terminal writer,
 * so an operator sees where it was thrown; a stack that opens any other way gives no frames,
 * since a value inside a message could be shaped like a frame.
 *
 * @module agentos/core/logging/kit/consoleCapture
 */

import { errorFields } from '../events.js';
import { terminal } from '../../utils/terminal.js';

/**
 * What console capture writes through: the `warn` method of an allow-list kit whose map
 * declares AgentOS's `console_line` event.
 */
export interface ConsoleKit { warn(event: 'console_line', fields: { method: (typeof METHODS)[number]; type?: string; code?: string }): void }
const METHODS = ['debug', 'info', 'log', 'warn', 'error', 'trace', 'dir', 'table', 'assert', 'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'group', 'groupCollapsed', 'groupEnd', 'clear', 'dirxml', 'profile', 'profileEnd', 'timeStamp'] as const;
// The restore function of the capture in place, shared by every copy of AgentOS in the process.
const KEY = Symbol.for('agentos.logging.console.v1');

/**
 * Replaces each console method with one that writes a `console_line` event through the kit.
 * Capturing is idempotent across every copy of AgentOS in the process: a second call returns
 * the first call's restore function and changes nothing. A console call made while a captured
 * call is being written is dropped.
 *
 * @param kit - The kit the events are written through.
 * @returns A function that puts the original console methods back.
 *
 * @example
 * ```ts
 * const restore = captureConsole(kit);
 * console.error(new Error('text that is never written')); // one console_line line: method, type, code
 * restore();
 * ```
 */
export function captureConsole(kit: ConsoleKit): () => void {
  const holder = globalThis as unknown as Record<symbol, (() => void) | undefined>;
  if (holder[KEY]) return holder[KEY];
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals = new Map<string, (...args: unknown[]) => void>();
  let writing = false;
  for (const method of METHODS) {
    if (typeof target[method] !== 'function') continue;
    originals.set(method, target[method]);
    target[method] = (...values) => {
      if (writing) return;
      writing = true;
      try {
        const error = values.find(value => value instanceof Error) as Error | undefined;
        kit.warn('console_line', { method, ...(error ? errorFields(error) : {}) });
        if (!error || typeof error.stack !== 'string') return;
        for (const name of [error.name, 'Error']) {
          const opening = `${name}: ${error.message}\n`;
          if (!error.stack.startsWith(opening)) continue;
          const frames = error.stack.slice(opening.length);
          if (frames) terminal(`${frames.replace(/\n$/, '')}\n`, 'stderr');
          break;
        }
      } finally { writing = false; }
    };
  }
  const restore = () => {
    for (const [method, original] of originals) target[method] = original;
    delete holder[KEY];
  };
  holder[KEY] = restore; return restore;
}
