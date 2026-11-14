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

import { LISTED_ERROR_CODES, LISTED_ERROR_TYPES } from './listedErrors.js';

export { LISTED_ERROR_CODES, LISTED_ERROR_TYPES };

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
export const PROVIDERS = ['openai', 'openrouter', 'anthropic', 'gemini', 'ollama', 'requesty', 'groq', 'mistral', 'together', 'xai', 'litellm', 'minimax', 'claude-code-cli', 'gemini-cli', 'unknown'] as const;
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
  // A GMI turn's sentiment analysis failed (a provider error, or a reply that did not parse after its repair): the
  // error's listed type and code, never its message. The turn goes on without the analysis.
  'gmi.sentiment_failed': { type: 'word', code: 'word' },
  // A GMI turn's sentiment analysis had not answered by the turn's post-turn metaprompt check, or its store writes
  // outlasted the shutdown bound there, and was dropped; `waitedMs` counts from the analysis start.
  'gmi.sentiment_late': { waitedMs: 'int' },
  // A dropped GMI sentiment analysis' store write landed, or one landed after a forget it did not see, and putting
  // the store back failed: the error's listed type and code, never its message.
  'gmi.sentiment_take_back_failed': { type: 'word', code: 'word' },
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
  // Every key of a pool of several is out of rotation at start: the provider starts without its model listing.
  'llm.key_pool_out': { provider, count: 'int' },
  'llm.option_ignored': { provider, reason: { enum: ['provider_sort', 'cache_retention', 'embedding_capability'] } },
  'llm.output_mismatch': { provider, reason: { enum: ['tool_arguments', 'text'] } },
  'llm.output_empty': { provider, count: 'int' },
  'llm.format_fallback': { provider, reason: { enum: ['json_schema'] } },
  'llm.response_format_failed': { provider, type: 'word', code: 'word' },
  // `fallbackProvider` and `fallbackModel` name the provider and model the passed-over entry would be sent as.
  'llm.fallback_skipped': { ...fallback, fallbackModel: 'path', reason: { enum: ['duplicate', 'excluded', 'capability', 'refusal', 'refill', 'unknown'] } },
  'llm.fallback_circuit_open': fallback,
  // `fallbackModel` is the model id the leg is sent as, `unknown` when it is not a valid path.
  'llm.fallback_fired': { ...fallback, fallbackModel: 'path', type: 'word', code: 'word' },
  'llm.fallback_succeeded': fallback,
  'llm.fallback_failed_after_output': fallback,
  'llm.fallback_exhausted': { api, primaryProvider: provider, attempts: 'int', type: 'word', code: 'word' },
  // At start, a soul's memory/ folder holds page files that are not the operator's: pages a compile of an earlier version wrote, or pages whose front matter cannot be read. They stay on disk and are in no index, no prompt and no recall.
  'memory.legacy_pages': { count: 'int' },
  // At open, a souled agent's store holds traces an earlier version filed under the agent's plain id. They stay in the store and no turn reads them.
  'memory.legacy_traces': { count: 'int' },
  // A one-shot generate() or stream() on a souled agent names no user: nothing is filed for it and it recalls the operator's pages alone. Written once an agent.
  'memory.one_shot_unfiled': {},
  // A scope's wiki compile did not run in a compile call: a spend budget refused its model call, the account's memory policy keeps raw traces only, the screen hook failed or had no turn of the scope to run for, the agent compiles no wiki at all, or the scope's subject is forgotten (its traces are not compiled, and a page a compile made after the tombstone is taken back). The scope's traces wait for a later compile, a forgotten subject's for its deletion. Written once a reason a call, and once for each page taken back, with no scope.
  'memory.compile_skipped': { reason: { enum: ['budget', 'policy_raw', 'compile_off', 'screen_failed', 'forgotten'] } },
  // A souled agent did not file a turn's text, or left a trace out of a compile: the account's memory policy keeps no memory (said once a session), the policy hook failed, the screen hook dropped the text, the screen hook failed, or the turn's subject is forgotten (a write that landed after the tombstone is taken back); or a correction named a trace that is not one of the person's own live traces, and changed nothing.
  'memory.write_refused': { reason: { enum: ['policy_off', 'policy_failed', 'screened', 'screen_failed', 'forgotten', 'foreign_trace'] } },
  // read_memory_page answered a page as not found, or a call as invalid, for a page the asker may not read: another subject's page, a user's page asked with no user, a page an earlier version compiled asked by a user, a call that named a scope or a user, or any page or listing asked by a forgotten subject.
  'memory.page_read_refused': { reason: { enum: ['other_user', 'no_user', 'legacy', 'caller_filter', 'forgotten'] } },
  // A subject's memory was deleted for good, or a deletion was run again for a subject already forgotten: how many stores the call reached and did not reach, the pages deleted and the pages that could not be, the subject's pending writes it waited for and those still running at its deadline, and whether the deletion is complete. Never the subject's id.
  'memory.forget_done': { stores: 'int', unreached: 'int', pages: 'int', pagesFailed: 'int', drained: 'int', pendingAtDeadline: 'int', complete: { enum: ['yes', 'no'] } },
  // The tombstones were applied again, at an open or on demand: how many forgotten subjects the store still held something of (each deleted again, with a memory.forget_done line of its own), and how many tombstones came back from the ledger's copy into the store, as after a restore from an older backup. Written only when either is above 0.
  'memory.tombstone_reapplied': { subjects: 'int', reconciled: 'int' },
  // A forgotten-user ledger refused to open, or refused a call on an open handle: its tombstone copy is missing or is another store's, a key it needs was not given, its identity or state rows are damaged, or the adapter has no transactions or the runtime no secure random source. Written once, where the refusal is thrown, with the error's listed type and code.
  'memory.ledger_refused': { type: 'word', code: 'word' },
  // A retention sweep ran over at least one subject with a period: the traces it deleted for good, the pages compiled from them that it deleted, and the subjects it removed from the registry because nothing of them was left.
  'memory.retention_swept': { traces: 'int', pages: 'int', scopes: 'int' },
  // A rewrite of the vector index, or a checkpoint of the store's write-ahead log, that deletes for good left owed failed where no report names it: in a correction, in a re-application of the tombstones, or at an open whose check of the index file found a trace that is gone. The deleted vectors or bytes stay in the files until the next deletion, sweep or re-application of the tombstones runs it. Written once a failure, with the error's listed type and code.
  'memory.erasure_unfinished': { type: 'word', code: 'word' },
  // A single person's install attributed the memory a store held from before per-user scope to its one user (the legacyMemory option): the legacy traces and the legacy compiled pages it counted. Written once, when the attribution is made.
  'memory.legacy_attributed': { traces: 'int', pages: 'int' },
  // A translation failed, answered with no text, ran past the transcript translator's own timeout, stopped at its output cap or stopped for another reason (a content filter); it throws TranslationProviderError, and status is 0 when no HTTP status came back.
  'language.translation_failed': { provider: { enum: ['openai', 'deepl'] }, reason: { enum: ['request_failed', 'empty_output', 'timeout', 'truncated', 'incomplete'] }, status: 'int', type: 'word', code: 'word' },
  // A configured detection provider id LanguageService does not build (whisper_stub, or an id it does not know).
  'language.detector_unsupported': { detector: 'word' },
  // A detection provider threw; LanguageService goes on with the others.
  'language.detection_failed': { detector: 'word', type: 'word', code: 'word' },
  // A guard threw, timed out or answered no recognised action. No guard text and no error message is ever a field.
  'guardrail.failed': { guardrailId: 'word', stage: { enum: ['input', 'output', 'tool_call'] }, posture: { enum: ['open', 'closed'] }, cause: { enum: ['error', 'timeout', 'malformed'] }, type: 'word', code: 'word' },
  // A SANITIZE the dispatcher could not apply: a phase 2 answer became a FLAG, a tool call's a BLOCK.
  'guardrail.sanitize_downgraded': { guardrailId: 'word', stage: { enum: ['input', 'output', 'tool_call'] } },
  // A hold came with an action other than BLOCK and was ignored; written once per guard.
  'guardrail.hold_ignored': { guardrailId: 'word', stage: { enum: ['input', 'output', 'tool_call'] } },
  // An onVerdict callback threw; the verdict stands.
  'guardrail.verdict_callback_failed': { type: 'word', code: 'word' },
  // A moderation entry point decided something other than allow. The code is written only when the deciding guard
  // lists it in config.reasonCodes or the library made it for a closed guard's failure; never for an allow.
  'guardrail.verdict': { guardrailId: 'word', stage: { enum: ['input', 'output', 'tool_call'] }, action: { enum: ['flag', 'sanitize', 'hold', 'block'] }, code: 'word', surface: 'word', mode: { enum: ['enforce', 'dry_run'] }, unavailable: { enum: ['yes', 'no'] } },
  // An image check threw, or an image could not be captured (checkId: load). Never the image, its URL or an error's message.
  'image_guard.check_failed': { guardrailId: 'word', checkId: 'word', posture: { enum: ['refuse', 'skip'] }, type: 'word', code: 'word' },
  // A governed tool call ended. The code is one the wrapper built: an evidence failure, a fixed code, or the id of one
  // of the tool's own limit rules. Absent when the end has none.
  'action.ended': { action: 'word', outcome: { enum: ['executed', 'failed', 'would_execute', 'refused_arguments', 'voided_evidence', 'limit_reached', 'duplicate', 'limiter_unavailable', 'audit_unavailable'] }, code: 'word', mode: { enum: ['enforce', 'dry_run'] } },
  // A half of a governed call's audit record could not be written: the host's sink threw. Never its message.
  'action.audit_failed': { action: 'word', half: { enum: ['begin', 'finish'] }, type: 'word', code: 'word' },
  // A callback of agency() threw or rejected: its name, and the error's listed type and code. Never its message.
  'agency.callback_failed': { callback: { enum: ['agentStart', 'agentEnd', 'handoff', 'toolCall', 'error', 'emergentForge', 'guardrailResult', 'limitReached', 'approvalRequested', 'approvalDecided', 'guardrailHitlOverride'] }, type: 'word', code: 'word' },
  // A soul given `optional: true` failed to load; the agent runs without it.
  'soul.load_failed': { optional: { enum: ['yes'] }, type: 'word', code: 'word' },
  // gmi() left out a front matter field that path cannot apply.
  'soul.field_ignored': { field: { enum: ['voice', 'avatar'] } },
  // A gmi() agent's learners stay under the slug of its name: the learning store holds learner rows under it and none under the soul's id.
  'soul.id_fallback': { reason: { enum: ['old_slug_learner'] } },
  // A session was opened with an anonymous id as its user id; the session is the memory subject.
  'memory.anonymous_user': { path: { enum: ['plain', 'gmi'] } },
  // A host's memory hook threw, rejected or timed out; the turn went on without it.
  'memory.hook_failed': { hook: { enum: ['getContext', 'observe', 'memoryPolicy', 'screen'] }, type: 'word', code: 'word' },
  // Cognitive memory's recall (src/cognition/memory/retrieval/recall). No memory text, query text or id is ever a field.
  'memory.recall.leg_absent': { leg: { enum: ['dense', 'exact_words', 'recency'] }, reason: { enum: ['no_store', 'no_embedder', 'no_index', 'no_scope_filter', 'no_scopes', 'query_error', 'disabled'] } },
  'memory.recall.rerank_skipped': { provider: { enum: ['local', 'llm'] }, reason: { enum: ['loading', 'timeout', 'error', 'backoff'] } },
  'memory.recall.rerank_unavailable': { provider: { enum: ['local'] }, reason: { enum: ['missing_dependency', 'load_failed'] } },
  'memory.recall.budget_clamped': { requested: 'int', effective: 'int', hop: 'int', reason: { enum: ['prompt_share', 'zero_remaining', 'invalid'] } },
  'memory.recall.allocation_exhausted': { requested: 'int', candidates: 'int' },
  // A recall-related option that was set and is applied nowhere (`token_budget`: memoryProviderOptions.tokenBudget on a GMI agent whose cognitive memory supplies the block; `recall_budget`: memory.recall.budget.totalTokens with neither cognitive memory nor a memoryProvider.getContext; `memory_recall`: the agent's memory.recall beside a cognition.memory of its own).
  'memory.recall.option_ignored': { option: { enum: ['token_budget', 'recall_budget', 'memory_recall', 'remote_provider'] } },
  // A `memory.recall` setting refused at construction, before the throw; `option` is the field under `memory.recall`.
  'memory.recall.option_rejected': { option: 'word', reason: { enum: ['conflict', 'unsupported_provider', 'unsupported_runtime', 'invalid_value'] } },
  'memory.recall.reserve_fired': { added: 'int' },
  'memory.recall.supplied_rejected': { out_of_scope: 'int', ineligible: 'int' },
  'memory.recall.rerank_failed_scoring': { provider: { enum: ['local', 'llm'] }, failures: 'int' },
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
  return keyShape(value) || /(?:^|[./:\s-])[A-Za-z0-9_]{20,}(?:$|[./:\s-])/.test(value);
}

// The credential shapes other than a long segment: a key prefix, the word bearer, or a JWT.
function keyShape(value: string): boolean {
  return /(?:^|[./:\s-])(?:sk[-_]|pk_|rk_)/i.test(value) || /bearer/i.test(value)
    || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

// A class name ending in Error or Exception, and an upper-case constant code of two or more parts joined by
// underscores, each part at most 16 characters. Either may be 20 characters or more, which the long-segment
// credential rule alone would refuse; the other credential shapes still refuse them.
const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,54}(?:Error|Exception)$/;
const CONSTANT_CODE = /^[A-Z][A-Z0-9]{0,15}(?:_[A-Z0-9]{1,16})+$/;

/**
 * Whether a value fits a field kind. A word or a path also fails when it has the shape of a
 * credential, and the `requestId` context key takes only letters, digits and dashes. A word
 * field named `type` also takes a class name ending in `Error` or `Exception`, and one named
 * `code` an upper-case constant code such as `STREAM_PARSING_ERROR`, up to 64 characters and
 * free of the other credential shapes, so that what {@link errorFields} writes passes.
 *
 * @param kind - The field's kind.
 * @param value - The value, of any type, since JavaScript callers are checked too.
 * @param key - The field's or the context key's name, which selects the `requestId`, `type` and `code` forms.
 * @returns `true` when the value may be written.
 */
export function valid(kind: FieldKind, value: unknown, key = ''): boolean {
  if (kind === 'int') return typeof value === 'number' && Number.isInteger(value);
  if (typeof value !== 'string') return false;
  if (typeof kind === 'object') return kind.enum.includes(value);
  if (kind === 'word' && value.length <= 64 && ((key === 'type' && CLASS_NAME.test(value)) || (key === 'code' && CONSTANT_CODE.test(value)))) return !keyShape(value);
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
 * A value as a path, or `unknown` when it is not a valid path.
 *
 * @param value - The value to write, such as a model id (`anthropic/claude-sonnet-4.5`).
 * @returns The value when it is a valid path, otherwise `'unknown'`.
 */
export function safePath(value: unknown): string { return valid('path', value) ? value as string : 'unknown'; }

// A value read from a caught error, or undefined when reading it throws.
function read(get: () => unknown): unknown {
  try { return get(); } catch { return undefined; }
}

// A value as the word field named `key`, or `unknown` when it does not fit.
function fieldWord(value: unknown, key: 'type' | 'code'): string {
  return valid('word', value, key) ? value as string : 'unknown';
}

const TYPEOF_WORDS: ReadonlySet<string> = new Set(['undefined', 'object', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function']);

/**
 * The fields an error is written as: `type`, its `name` when it is in {@link LISTED_ERROR_TYPES} (or the value's
 * `typeof` when it is not an `Error`), and `code`, its `code` when it is in {@link LISTED_ERROR_CODES}. Anything
 * else, and an error with no code, is `unknown`: a name or a code is set by whoever threw the error, so one that only
 * has the right shape is never written. Never the message or the stack. Reading never throws.
 *
 * @param error - The caught value.
 * @returns The listed type and code, or `unknown` for each.
 */
export function listedErrorFields(error: unknown): { type: string; code: string } {
  const named = read(() => (error instanceof Error ? { name: error.name as unknown, isError: true } : { name: typeof error as unknown, isError: false })) as { name: unknown; isError: boolean } | undefined;
  const code = read(() => (typeof error === 'object' && error !== null ? (error as Record<string, unknown>).code : undefined));
  const type = named !== undefined && typeof named.name === 'string' && (named.isError ? LISTED_ERROR_TYPES.has(named.name) : TYPEOF_WORDS.has(named.name)) ? named.name : 'unknown';
  return {
    type: fieldWord(type, 'type'),
    code: typeof code === 'string' && LISTED_ERROR_CODES.has(code) ? fieldWord(code, 'code') : 'unknown',
  };
}

/**
 * Kept as a name for deep imports (`@framers/agentos/core/logging/events`). It returns {@link listedErrorFields}'s
 * answer.
 *
 * @param error - The caught value.
 * @returns The listed type and code, or `unknown` for each.
 */
export function errorFields(error: unknown): { type: string; code: string } {
  return listedErrorFields(error);
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
