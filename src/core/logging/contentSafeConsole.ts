/**
 * Module-local console bindings; the global console object is never replaced.
 *
 * @module
 */
import { emitContentSafeLog, type ContentSafeLogComponent, type ContentSafeLogLevel } from './contentSafeTelemetry.js';

/** Console operations used by the covered library modules. */
type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error' | 'log';
/** All methods accept opaque arguments and read none while interception is enabled. */
export type ContentSafeConsole = Readonly<Record<ConsoleMethod, (...args: unknown[]) => void>>;

/** Intercept first, otherwise delegate unchanged arguments to the current global method. */
function write(component: ContentSafeLogComponent, method: ConsoleMethod, args: unknown[]): void {
  const level: ContentSafeLogLevel = method === 'log' ? 'info' : method;
  if (emitContentSafeLog(level, component)) return;
  globalThis.console[method](...args);
}

/**
 * Bind a library-authored origin at module initialization. Arguments at call sites still evaluate normally, so
 * voice error projections explicitly check the mode before accessing a message or error description.
 * @param component - Fixed module word, never the caller's name or a provider id.
 * @internal
 */
export function createContentSafeConsole(component: ContentSafeLogComponent): ContentSafeConsole {
  return Object.freeze({
    /** Debug records retain their source level. */
    debug: (...args: unknown[]): void => write(component, 'debug', args),
    /** Info records retain their source level. */
    info: (...args: unknown[]): void => write(component, 'info', args),
    /** Warning records retain their source level. */
    warn: (...args: unknown[]): void => write(component, 'warn', args),
    /** Error records retain their source level. */
    error: (...args: unknown[]): void => write(component, 'error', args),
    /** Console log is an info source record. */
    log: (...args: unknown[]): void => write(component, 'log', args),
  });
}

/** Compatibility binding for existing internal callers; its origin is the console adapter. @internal */
export const contentSafeConsole = createContentSafeConsole('library_console');
