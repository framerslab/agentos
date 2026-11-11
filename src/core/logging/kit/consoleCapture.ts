/**
 * @fileoverview Console capture: each console call becomes one content-free `console_line`
 * event.
 *
 * The event carries the console method and, when one of the values is an error, its type and
 * code. The text is never written. For an error, the frames of its stack after the exact
 * opening (its name, `: ` and its message) go to standard error through the terminal writer,
 * so an operator sees where it was thrown; a stack that opens any other way gives no frames,
 * since a value inside a message could be shaped like a frame. Only lines with a frame's form
 * (`at ` after the indent) are written, at most 50, and a line over 512 characters or holding
 * a control or direction character is left out, so a stack set by hand cannot put text or
 * terminal sequences on standard error. An error whose properties throw when read gives the
 * event with `unknown` fields and no frames, and the console call does not throw.
 *
 * @module agentos/core/logging/kit/consoleCapture
 */

import { listedErrorFields } from '../events.js';
import { terminal } from '../../utils/terminal.js';

/**
 * What console capture writes through: the `warn` method of an allow-list kit whose map
 * declares AgentOS's `console_line` event.
 */
export interface ConsoleKit { warn(event: 'console_line', fields: { method: (typeof METHODS)[number]; type?: string; code?: string }): void }
const METHODS = ['debug', 'info', 'log', 'warn', 'error', 'trace', 'dir', 'table', 'assert', 'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'group', 'groupCollapsed', 'groupEnd', 'clear', 'dirxml', 'profile', 'profileEnd', 'timeStamp'] as const;
// The restore function of the capture in place, shared by every copy of AgentOS in the process.
const KEY = Symbol.for('agentos.logging.console.v1');
// A frame line, and the bounds on the frames written.
const FRAME = /^ +at \S/;
const MAX_FRAMES = 50;
const MAX_FRAME_LENGTH = 512;

// Whether a line holds a C0 or C1 control, DEL, or a direction mark or override. A loop, not a regular
// expression, since eslint's no-control-regex refuses control characters in one.
function unsafe(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x200e || code === 0x200f
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

// The first value that is an error; a value whose prototype throws when read is passed over.
function firstError(values: unknown[]): Error | undefined {
  for (const value of values) {
    try { if (value instanceof Error) return value; } catch { /* Not an error that can be read. */ }
  }
  return undefined;
}

// The frame lines of an error's stack after its exact opening, bounded, or '' when there are none or reading fails.
function framesOf(error: Error): string {
  try {
    const stack = error.stack;
    if (typeof stack !== 'string') return '';
    const message = error.message;
    for (const name of [error.name, 'Error']) {
      const opening = `${name}: ${message}\n`;
      if (!stack.startsWith(opening)) continue;
      const lines = stack.slice(opening.length).split('\n')
        .filter(line => line.length <= MAX_FRAME_LENGTH && FRAME.test(line) && !unsafe(line))
        .slice(0, MAX_FRAMES);
      return lines.length ? `${lines.join('\n')}\n` : '';
    }
    return '';
  } catch { return ''; }
}

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
        const error = firstError(values);
        kit.warn('console_line', { method, ...(error ? listedErrorFields(error) : {}) });
        const frames = error ? framesOf(error) : '';
        if (frames) terminal(frames, 'stderr');
      } finally { writing = false; }
    };
  }
  const restore = () => {
    for (const [method, original] of originals) target[method] = original;
    delete holder[KEY];
  };
  holder[KEY] = restore; return restore;
}
