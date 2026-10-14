/**
 * @fileoverview Content-safe server telemetry: a process-wide mode in which AgentOS's log records become fixed
 * events for a host sink, carrying a level and a count and nothing taken from the record.
 * @module agentos/logging/contentSafeTelemetry
 */

/** Enumerated library diagnostics; no input-derived string is accepted. */
export type ContentSafeLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The only thing a host sink receives for one AgentOS log record while content-safe telemetry is on: the record's
 * level and a count of one. It never carries the record's message, metadata, logger bindings, ids, provider
 * strings, status text or error. Each event is frozen.
 */
export interface ContentSafeLogEvent {
  readonly kind: 'library_event';
  readonly state: ContentSafeLogLevel;
  readonly n: 1;
}

/**
 * The host's receiver of {@link ContentSafeLogEvent}s, set once with {@link enableContentSafeTelemetry}. It is called
 * synchronously for each record. An error it throws is swallowed, and a record that AgentOS writes while the sink
 * is running is dropped, so a sink that logs through AgentOS cannot recurse.
 */
export type ContentSafeLogSink = (event: ContentSafeLogEvent) => void;

let sink: ContentSafeLogSink | undefined;
let emitting = false;

/**
 * Enable once before creating providers or accepting work; never disable in-process.
 *
 * From this call on, every record that an AgentOS `PinoLogger` or a logger from `createLogger` (made before or after
 * this call) writes, and every console diagnostic of the LLM providers, the provider manager, the model router, the
 * provider health registry, `EmbeddingManager`, and `generateText` and `streamText` with their model resolution,
 * spend budget, tool-emulation loop and tool-approval gate, becomes one {@link ContentSafeLogEvent} passed to
 * `value`. The original message, metadata, bindings and errors are dropped without being read. AgentOS spans,
 * metrics, trace ids in logs and streamed responses, OpenTelemetry log records and the global usage observer stay
 * off, whatever the observability configuration or environment asks for. Console output from other AgentOS modules,
 * the host's own loggers and third-party instrumentation are outside this mode.
 *
 * The mode is process-wide, so pooled providers, retries and shared loggers cannot escape it. There is no way to turn
 * it off or to change the sink: a second call with the same sink does nothing. The state belongs to the loaded copy
 * of this package.
 *
 * @param value - The host's sink.
 * @throws {Error} `invalid_content_safe_sink` when `value` is not a function.
 * @throws {Error} `content_safe_sink_already_set` when a different sink is already set.
 * @example
 * ```ts
 * import pino from 'pino';
 * import { enableContentSafeTelemetry } from '@framers/agentos/logging';
 *
 * const log = pino();
 * enableContentSafeTelemetry((event) => log.info({ state: event.state, n: event.n }, 'agentos_library_event'));
 * ```
 */
export function enableContentSafeTelemetry(value: ContentSafeLogSink): void {
  if (typeof value !== 'function') throw new Error('invalid_content_safe_sink');
  if (sink && sink !== value) throw new Error('content_safe_sink_already_set');
  sink = value;
}

/**
 * Whether {@link enableContentSafeTelemetry} has set a sink in this process.
 *
 * @returns `true` once the mode is on; it stays on for the life of the process.
 */
export function isContentSafeTelemetryEnabled(): boolean { return sink !== undefined; }

/**
 * Internal interception point. True means the original record must be discarded.
 *
 * While the mode is off this returns `false` and the caller writes its record as before. While it is on, it passes
 * one fixed event for `level` to the sink (none while the sink itself is running) and returns `true`; the caller
 * then drops its record without reading it.
 *
 * @param level - The level of the record being intercepted.
 * @returns Whether the caller must drop its record.
 * @internal
 */
export function emitContentSafeLog(level: ContentSafeLogLevel): boolean {
  const target = sink;
  if (!target) return false;
  if (emitting) return true;
  emitting = true;
  try {
    const state: ContentSafeLogLevel = level === 'debug' || level === 'info' || level === 'warn'
      ? level : 'error';
    target(Object.freeze({ kind: 'library_event', state, n: 1 }));
  } catch {
    // A failing host sink must neither expose the original data nor fail provider work.
  } finally {
    emitting = false;
  }
  return true;
}
