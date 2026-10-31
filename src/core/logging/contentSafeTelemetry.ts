/**
 * Process-local content-safe interception with fixed origins and a source threshold.
 *
 * @module
 */

/** Levels supported by the existing logger contract, in increasing severity. */
export type ContentSafeLogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Every component is authored by the library; host logger names and bindings are never origins. */
export const CONTENT_SAFE_COMPONENTS = Object.freeze([
  'library', 'library_console', 'logger_factory', 'pino_logger',
  'generate_text', 'stream_text', 'model', 'observers', 'approval_gate', 'spend_budget', 'tool_loop',
  'embedding_manager', 'provider_health', 'provider_manager', 'model_router',
  'anthropic_provider', 'gemini_provider', 'groq_provider', 'litellm_provider', 'mistral_provider',
  'ollama_provider', 'openai_provider', 'openrouter_provider', 'requesty_provider', 'together_provider',
  'xai_provider', 'cache_leak_detector', 'listen_session', 'reconnecting_stt', 'streaming_stt_chain', 'livekit_transport',
  'gmi_launch_tool',
] as const);
/** Closed source module vocabulary available to host budget declarations. */
export type ContentSafeLogComponent = (typeof CONTENT_SAFE_COMPONENTS)[number];
/** Only these four fields reach a sink, and the event is frozen before delivery. */
export interface ContentSafeLogEvent {
  /** Fixed diagnostic family. */
  readonly kind: 'library_event';
  /** Source severity, independent of the host's output severity. */
  readonly state: ContentSafeLogLevel;
  /** One intercepted source record. */
  readonly n: 1;
  /** Library-authored module origin, never a name from a record. */
  readonly component: ContentSafeLogComponent;
}
/**
 * Called synchronously; reentrant library logs are dropped. A receiver throw is swallowed. When it returns an object or
 * function with a `then` method, that method is called at once with handlers that do nothing, so the rejection of an
 * async receiver's promise, a promise from another realm or a thenable is swallowed too, and a library log the method
 * writes while it runs is dropped as a reentrant one. A `then` that throws when read or called is swallowed.
 */
export type ContentSafeLogSink = (event: ContentSafeLogEvent) => void;
/** Installation settings are copied once, with no runtime disable or replacement. */
export interface ContentSafeTelemetryOptions {
  /** Drop lower source levels without calling the sink. Default debug preserves existing calls. */
  readonly minLevel?: ContentSafeLogLevel;
}
/** The state belongs to this loaded package copy in this process. */
let sink: ContentSafeLogSink | undefined;
/** Effective source threshold, never a retained host options object. */
let minimum: ContentSafeLogLevel = 'debug';
/** Prevent recursive logging through a host sink. */
let emitting = false;

/** Reject unknown runtime threshold inputs without string conversion or input in the error. */
function checkedMinimum(value: unknown): ContentSafeLogLevel {
  if (value === undefined) return 'debug';
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  throw new Error('invalid_content_safe_min_level');
}
/** Numeric ordering without a caller-indexed prototype lookup. */
function rank(level: ContentSafeLogLevel): number {
  if (level === 'debug') return 0;
  if (level === 'info') return 1;
  if (level === 'warn') return 2;
  return 3;
}
/** Runtime callers cannot introduce arbitrary components or invoke conversion hooks. */
function componentOf(value: unknown): ContentSafeLogComponent {
  if (typeof value === 'string' && (CONTENT_SAFE_COMPONENTS as readonly string[]).includes(value)) return value as ContentSafeLogComponent;
  return 'library';
}
/** Both handlers a returned value's then receives: a settlement, or a later call by a thenable, does nothing. */
function ignore(): undefined { return undefined; }

/**
 * Consumes the rejection of what a diagnostic receiver returned, at once and in the caller's frame. An object or
 * function has its `then` read once and, when that is a function, called with handlers that do nothing, so a native
 * promise from any realm and a thenable both have their rejection handled. Whatever that `then` does synchronously, such
 * as writing a library log, happens while the caller's reentrancy guard is still set; nothing is awaited, so no guard is
 * held while an asynchronous receiver runs. A `then` that throws when read or called is swallowed, and any other value
 * is left alone.
 *
 * @param value - Whatever the receiver returned.
 * @internal
 */
export function consumeReturnedRejection(value: unknown): void {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    try {
      const then: unknown = (value as { readonly then?: unknown }).then;
      if (typeof then === 'function') Reflect.apply(then, value, [ignore, ignore]);
    }
    catch { /* What a diagnostic receiver returned cannot fail its caller. */ }
  }
}

/**
 * Enable once before provider work. Existing and future factory/pino loggers and covered console modules discard
 * their messages, metadata and bindings. Tracing, metrics, log exports and the usage observer remain disabled by
 * their existing guards. The host's own outputs, third-party loggers and uncovered modules are outside this mode.
 * A repeated call must have the same sink and effective minimum; the options are read once, before the installed
 * settings are compared. No original record is replayed on sink failure.
 *
 * @param value - The synchronous receiver of frozen events.
 * @param options - Optional source threshold; omission preserves all four levels.
 * @throws Error with a fixed word for invalid input or attempted replacement.
 */
export function enableContentSafeTelemetry(value: ContentSafeLogSink, options: ContentSafeTelemetryOptions = {}): void {
  if ((typeof value === 'function') === false) throw new Error('invalid_content_safe_sink');
  // Every option is read and checked before the installed state: a getter that installs a sink itself is then refused
  // below like any other replacement, instead of being overwritten.
  let requested: ContentSafeLogLevel;
  try { requested = checkedMinimum(options.minLevel); }
  catch { throw new Error('invalid_content_safe_min_level'); }
  if (sink && (sink === value) === false) throw new Error('content_safe_sink_already_set');
  if (sink && (minimum === requested) === false) throw new Error('content_safe_options_already_set');
  sink = value;
  minimum = requested;
}

/** Whether this loaded package copy has an installed sink. Never changes back to false. */
export function isContentSafeTelemetryEnabled(): boolean { return (sink === undefined) === false; }

/**
 * Internal interception: true means drop the original, including a filtered record or a recursive call.
 * No message, error, logger name or binding is an argument. Off mode returns false without changing normal output.
 * @param level - Source level. Unknown runtime values retain the previous error-level fallback.
 * @param component - A fixed module constant; unknown runtime values become library.
 * @internal
 */
export function emitContentSafeLog(level: ContentSafeLogLevel, component: ContentSafeLogComponent = 'library'): boolean {
  const target = sink;
  if (target === undefined) return false;
  if (emitting) return true;
  const state: ContentSafeLogLevel = level === 'debug' || level === 'info' || level === 'warn' ? level : 'error';
  if (rank(state) < rank(minimum)) return true;
  emitting = true;
  try {
    const returned: unknown = target(Object.freeze({ kind: 'library_event', state, n: 1, component: componentOf(component) }));
    // An async receiver fails by rejecting instead of throwing. The then of what it returns runs here, while a library
    // log it writes is still dropped; Promise.resolve would run it in a later job, after the guard is cleared, and a
    // receiver that returned another such thenable would then be called again without end.
    consumeReturnedRejection(returned);
  }
  catch { /* A diagnostic receiver cannot expose content or fail provider work. */ }
  finally { emitting = false; }
  return true;
}
