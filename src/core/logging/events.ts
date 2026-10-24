/**
 * @fileoverview AgentOS's events and context keys, declared once as data, and the checks a
 * value passes before it reaches a line.
 *
 * Each event maps its fields to one of four kinds: `int` (an integer), `word` (letters,
 * digits and `_ . : -`, at most 64 characters), `path` (a word that may also hold `/`, at
 * most 128 characters) or an `enum` (one of a declared list). A word or a path with the shape
 * of a credential is refused. Nothing a person wrote, a model answered or a tool was given is
 * ever a field; a length or a count may be.
 *
 * @module agentos/core/logging/events
 */

/** The kind of one field: an integer, a word, a path, or one of a declared list. */
export type FieldKind = 'int' | 'word' | 'path' | { readonly enum: readonly string[] };

/** A map from each event name to its fields and their kinds. */
export type EventMap = Readonly<Record<string, Readonly<Record<string, FieldKind>>>>;

/** The context keys a child may bind, and their kinds. */
export type ContextSchema = Readonly<Record<string, FieldKind>>;

/** The value type of one kind: a number for `int`, the listed strings for an `enum`, a string otherwise. */
type Value<K extends FieldKind> = K extends 'int' ? number : K extends { readonly enum: readonly (infer V)[] } ? V : string;

/**
 * The fields of one event, typed from its declaration. A declared field may be left out; a
 * field that is not declared does not compile.
 */
export type Fields<S extends Readonly<Record<string, FieldKind>>> = { [K in keyof S]?: Value<S[K]> };

/** The values a child may bind, typed from a context schema. */
export type ContextValues<C extends ContextSchema> = Fields<C>;

/** The provider names a line may carry. Any other provider is written as `unknown`. */
export const PROVIDERS = ['openai', 'openrouter', 'anthropic', 'gemini', 'ollama', 'requesty', 'groq', 'mistral', 'together', 'xai', 'litellm', 'unknown'] as const;
const provider = { enum: PROVIDERS };
const api = { enum: ['generateText', 'streamText'] as const };
// The fields every fallback event of generateText and streamText shares.
const fallback = { api, primaryProvider: provider, fallbackProvider: provider, attempt: 'int' } as const;

/**
 * The context keys a child may bind: `component` and `extension` as words, and `requestId`,
 * which takes only letters, digits and dashes, at most 64 characters.
 */
export const AGENTOS_CONTEXT = { component: 'word', extension: 'word', requestId: 'word' } as const;

/**
 * Every event AgentOS writes, with its fields. A field that names a provider, a state or a
 * reason is an `enum`, never a free word, and an error is written as its `type` and `code`.
 */
export const AGENTOS_EVENTS = {
  'logging.level_unknown': {},
  'agentos.untyped': { sourceLevel: { enum: ['debug', 'info', 'warn', 'error', 'fatal'] } },
  'console_line': { method: { enum: ['debug', 'info', 'log', 'warn', 'error', 'trace', 'dir', 'table', 'assert', 'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'group', 'groupCollapsed', 'groupEnd', 'clear', 'dirxml', 'profile', 'profileEnd', 'timeStamp'] }, type: 'word', code: 'word' },
  'process.uncaught': { type: 'word', code: 'word' },
  'process.shutdown': { signal: { enum: ['SIGTERM', 'SIGINT'] } },
  'http.request': { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'OTHER'] }, route: 'path', status: 'int', ms: 'int', outcome: { enum: ['ok', 'aborted', 'error'] } },
  'http.handler_failed': { type: 'word', code: 'word' },
  'llm.provider_ready': { provider, count: 'int' },
  'llm.provider_stopped': { provider },
  'llm.provider_start_failed': { provider, type: 'word', code: 'word' },
  'llm.default_changed': { provider },
  'llm.manager_state': { state: { enum: ['reinitializing', 'empty', 'ready', 'stopping', 'stopped'] }, count: 'int' },
  'llm.retry': { provider, status: 'int', attempt: 'int', waitMs: 'int' },
  'llm.stream_invalid': { provider, bytes: 'int', reason: { enum: ['json', 'shape', 'framing', 'mapping'] } },
  'llm.stream_failed': { provider, type: 'word', code: 'word' },
  'llm.stream_cancel_failed': { provider, type: 'word', code: 'word' },
  'llm.models_refresh': { provider },
  'llm.models_failed': { provider, type: 'word', code: 'word' },
  'llm.models_empty': { provider },
  'llm.option_ignored': { provider, reason: { enum: ['provider_sort', 'cache_retention', 'embedding_capability'] } },
  'llm.output_mismatch': { provider, reason: { enum: ['tool_arguments', 'text'] } },
  'llm.output_empty': { provider, count: 'int' },
  'llm.format_fallback': { provider, reason: { enum: ['json_schema'] } },
  'llm.response_format_failed': { provider, type: 'word', code: 'word' },
  'llm.fallback_skipped': { ...fallback, reason: { enum: ['duplicate', 'excluded', 'capability', 'refusal', 'refill', 'unknown'] } },
  'llm.fallback_circuit_open': fallback,
  'llm.fallback_fired': { ...fallback, type: 'word', code: 'word' },
  'llm.fallback_succeeded': fallback,
  'llm.fallback_failed_after_output': fallback,
  'llm.fallback_exhausted': { api, primaryProvider: provider, attempts: 'int', type: 'word', code: 'word' },
} as const satisfies EventMap;

/** The type of {@link AGENTOS_EVENTS}, which `lazyLogger`'s handles are typed over. */
export type AgentOSEvents = typeof AGENTOS_EVENTS;

/** The values a child of an AgentOS handle may bind. */
export type AgentOSContext = ContextValues<typeof AGENTOS_CONTEXT>;

/**
 * Whether a string has the shape of a credential. Segments are split at the start and end,
 * `.`, `/`, `:`, `-` and whitespace, and the shapes are:
 *
 * - a key prefix (`sk-`, `sk_`, `pk_` or `rk_`) opening a segment;
 * - the word `bearer`, in any case;
 * - three base64url parts joined by dots (a JWT);
 * - a whole segment of 20 or more letters, digits and underscores.
 *
 * @param value - The string to test.
 * @returns `true` when the string must not reach a line.
 */
export function credential(value: string): boolean {
  return /(?:^|[./:\s-])(?:sk[-_]|pk_|rk_)/i.test(value) || /bearer/i.test(value)
    || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
    || /(?:^|[./:\s-])[A-Za-z0-9_]{20,}(?:$|[./:\s-])/.test(value);
}

/**
 * Whether a value fits a field kind. A word or a path also fails when it has the shape of a
 * credential, and the `requestId` context key takes only letters, digits and dashes.
 *
 * @param kind - The field's kind.
 * @param value - The value, of any type, since JavaScript callers are checked too.
 * @param key - The field's or the context key's name, which selects the `requestId` form.
 * @returns `true` when the value may be written.
 */
export function valid(kind: FieldKind, value: unknown, key = ''): boolean {
  if (kind === 'int') return typeof value === 'number' && Number.isInteger(value);
  if (typeof value !== 'string') return false;
  if (typeof kind === 'object') return kind.enum.includes(value);
  if (credential(value)) return false;
  if (key === 'requestId') return /^[A-Za-z0-9-]{1,64}$/.test(value);
  return kind === 'path' ? /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) : /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
}

/**
 * A value as a word, or `unknown` when it is not a valid word.
 *
 * @param value - The value to write.
 * @returns The value when it is a valid word, otherwise `'unknown'`.
 */
export function safeWord(value: unknown): string { return valid('word', value) ? value as string : 'unknown'; }

/**
 * The fields an error is written as: its type and its code, never its message or its stack.
 * Either is `unknown` when it is not a valid word.
 *
 * @param error - The caught value.
 * @returns `type`, the error's name (or the value's `typeof` when it is not an `Error`), and `code`, its `code` property.
 *
 * @example
 * ```ts
 * errorFields(Object.assign(new Error('text that is never written'), { code: 'ECONNRESET' }));
 * // { type: 'Error', code: 'ECONNRESET' }
 * ```
 */
export function errorFields(error: unknown): { type: string; code: string } {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  return { type: safeWord(error instanceof Error ? error.name : typeof error), code: safeWord(record.code) };
}

/**
 * A provider's name as one of {@link PROVIDERS}, or `unknown`.
 *
 * @param value - The provider name to write.
 * @returns The name when it is listed, otherwise `'unknown'`.
 */
export function providerName(value: unknown): (typeof PROVIDERS)[number] {
  return PROVIDERS.includes(value as (typeof PROVIDERS)[number]) ? value as (typeof PROVIDERS)[number] : 'unknown';
}
