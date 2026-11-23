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
  // The full runtime finished initializing: whether a prompt profile is configured, whether conversational persistence
  // is on and where that setting came from (the host's orchestrator config, the factory's ENABLE_PERSISTENCE, or the
  // default), and whether the date tool is registered. Written once a runtime.
  'runtime.defaults': {
    promptProfile: { enum: ['none', 'host'] },
    persistence: { enum: ['on', 'off'] },
    persistenceFrom: { enum: ['host', 'environment', 'default'] },
    dateTool: { enum: ['on', 'off'] },
  },
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
  'llm.option_ignored': { provider, reason: { enum: ['provider_sort', 'cache_retention', 'embedding_capability', 'stop_sequences', 'penalties', 'message_name', 'chat_only_param'] } },
  'llm.output_mismatch': { provider, reason: { enum: ['tool_arguments', 'text'] } },
  'llm.output_empty': { provider, count: 'int' },
  'llm.format_fallback': { provider, reason: { enum: ['json_schema'] } },
  // The JSON output format (Anthropic's, or a Claude model's through OpenRouter) refused a schema; the request went
  // once more without it. `model` is the model on the wire, `schema` the schema's name (`unknown` when it is not a word).
  'llm.schema_format_refused': { provider, model: 'path', schema: 'word', reason: { enum: ['grammar_too_large'] } },
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
  // A scope's wiki compile did not run in a compile call: a spend budget refused its model call, the account's memory policy keeps raw traces only, the screen hook failed or had no turn of the scope to run for, the agent compiles no wiki at all, the scope's subject is forgotten (its traces are not compiled, and a page a compile made after the tombstone is taken back), or the account is a minor's and no compile target is named for minors. The scope's traces wait for a later compile, a forgotten subject's for its deletion. Written once a reason a call, and once for each page taken back, with no scope.
  'memory.compile_skipped': { reason: { enum: ['budget', 'policy_raw', 'compile_off', 'screen_failed', 'forgotten', 'minor_no_compile'] } },
  // A souled agent did not file a turn's text, or left a trace out of a compile: the account's memory policy keeps no memory (said once a session), the account is a minor's on a store that would keep their memory until deletion (said once a session), the policy hook failed, the screen hook dropped the text, the screen hook failed, the turn's subject is forgotten (a write that landed after the tombstone is taken back), or a correction or a deletion of named traces changed the subject's memory while the turn ran (its reply is not filed; what the person said is); or a correction or such a deletion named a trace that is not one of the person's own live traces, and changed nothing.
  'memory.write_refused': { reason: { enum: ['policy_off', 'minor_no_retention', 'policy_failed', 'screened', 'screen_failed', 'forgotten', 'corrected', 'foreign_trace'] } },
  // read_memory_page answered a page as not found, or a call as invalid, for a page the asker may not read: another subject's page, a user's page asked with no user, a page an earlier version compiled asked by a user, a call that named a scope or a user, or any page or listing asked by a forgotten subject.
  'memory.page_read_refused': { reason: { enum: ['other_user', 'no_user', 'legacy', 'caller_filter', 'forgotten'] } },
  // A subject's memory was deleted for good, or a deletion was run again for a subject already forgotten: how many stores the call reached and did not reach, the pages deleted and the pages that could not be, the subject's pending writes it waited for and those still running at its deadline, and whether the deletion is complete. Never the subject's id.
  'memory.forget_done': { stores: 'int', unreached: 'int', pages: 'int', pagesFailed: 'int', drained: 'int', pendingAtDeadline: 'int', complete: { enum: ['yes', 'no'] } },
  // A deletion of one subject ended incomplete: each of its four parts (the tombstone, the mind's copies, the store's own pass, the open sessions) reached or missed, how many of the subject's writes were still running at its deadline, and how many pages it could not delete. Written once a deletion whose report says complete: false, after its memory.forget_done line; a complete deletion writes none. Never the subject's id or any text. The next open, applyTombstones() or the deletion made again resumes it.
  'memory.forget_incomplete': { tombstone: { enum: ['reached', 'missed'] }, mind: { enum: ['reached', 'missed'] }, store: { enum: ['reached', 'missed'] }, sessions: { enum: ['reached', 'missed'] }, pendingAtDeadline: 'int', pagesFailed: 'int' },
  // A session of a souled agent on the GMI runtime was still running a turn when a deletion of its person reached its deadline, and emptying the session once that turn ended failed: the session's GMI may still hold its history, its sentiment trend and its working-memory slots of the person. The deletion's report already names its sessions part as missed; the deletion made again empties the session, or names the failure in that part. Also written when a correction, a deletion of named traces or a retention sweep could not drop the traces it deleted from an open session's working memory, where a slot holds a trace's id and no words. Written once a failure, with the error's listed type and code, never the session's id or any text.
  'memory.session_evict_failed': { type: 'word', code: 'word' },
  // A souled agent's deletion could not read the routes its store recorded (the routes calls took that its options do not name): the deletion goes on, and its report lists the routes the options name and those this process's calls took, and names the recorded ones as not reached. Read after the deletions' waits, so it comes after their memory.forget_done lines, which do not count that entry. A correction, or a deletion of named traces, that could not read them goes on too, and its result lists the same routes. Written once a forgetUser call, a re-application of the tombstones or a correctUserMemory call, with the error's listed type and code.
  'memory.recipients_unread': { type: 'word', code: 'word' },
  // The tombstones were applied again, at an open or on demand: how many forgotten subjects the store still held something of (each deleted again, with a memory.forget_done line of its own), how many tombstones came back from the ledger's copy into the store, as after a restore from an older backup, how many traces a correction or a single deletion had deleted were found in the store again and deleted again (traces) or could not be, a page built from one or the delete having failed (tracesMissed; the next re-application tries again), how many corrections the ledger's copy keeps were filed again because the store lacked them (correctionsRefiled), and how many the store refused to file again, a write or an embedding having failed (correctionsMissed; they stay kept and the next re-application tries again, and the open goes on). Written only when one of them is above 0. Never an id or any text.
  'memory.tombstone_reapplied': { subjects: 'int', reconciled: 'int', traces: 'int', tracesMissed: 'int', correctionsRefiled: 'int', correctionsMissed: 'int' },
  // A souled agent with no tombstoneKey opened, or opened a session of, a store that keeps the memory of more than one person or session, and let it in because the ledger already holds unkeyed tombstones (each can be matched by hashing a guessed id). Written once an open of the agent. On a ledger that holds none, the same open is refused.
  'memory.tombstones_unkeyed': {},
  // A forgotten-user ledger refused to open, or refused a call on an open handle: its tombstone copy is missing or is another store's, a key it needs was not given, its identity or state rows are damaged, or the adapter has no transactions or the runtime no secure random source. Written once, where the refusal is thrown, with the error's listed type and code.
  'memory.ledger_refused': { type: 'word', code: 'word' },
  // A retention sweep ran over at least one subject with a period: the traces it deleted for good, the pages compiled from them that it deleted, and the subjects it removed from the registry because nothing of them was left.
  'memory.retention_swept': { traces: 'int', pages: 'int', scopes: 'int' },
  // A rewrite of the vector index, or a checkpoint of the store's write-ahead log, that deletes for good left owed failed where no report names it: in a correction, in a re-application of the tombstones, or at an open whose check of the index file found a trace that is gone. The deleted vectors or bytes stay in the files until the next deletion, sweep or re-application of the tombstones runs it. Written once a failure, with the error's listed type and code.
  'memory.erasure_unfinished': { type: 'word', code: 'word' },
  // A souled agent's close() waited its deadline (pendingWritesTimeoutMs) for its turns still running and the memory writes and memory calls they started, and these were still pending: the wiki compile on close takes what is stored, and a write that reaches the store once it is closed is not stored. Written once a close.
  'memory.close_pending': { pending: 'int' },
  // A souled agent's close() ran its retention sweep and the sweep failed: the close goes on, and the expired memory the sweep did not delete stays in the store until the next sweep (agent.sweepRetention() or the next close). Written once a close, with the error's listed type and code, never its text.
  'memory.close_sweep_failed': { type: 'word', code: 'word' },
  // A souled agent's close() compiled the wiki and the compile failed: the close goes on, and the conversation traces stay in the store for the next compile, since a subject's watermark moves only past what was compiled. Written once a close, with the error's listed type and code, never its text.
  'memory.close_compile_failed': { type: 'word', code: 'word' },
  // A single person's install attributed the memory a store held from before per-user scope to its one user (the legacyMemory option): the legacy traces and the legacy compiled pages it counted. Written once, when the attribution is made.
  'memory.legacy_attributed': { traces: 'int', pages: 'int' },
  // A souled agent could not record in its store the route a call took that its options do not name (a call's own provider or model): the route stays in recipients() for this process, and the next call on it tries again. Written once a failure, with the error's listed type and code.
  'memory.recipient_unrecorded': { type: 'word', code: 'word' },
  // An export of one person's memory could not read one of its stores: that store's part of the export is left empty and named in the export's unread list, and the export still returns. Written once a store a call, with the store and the error's listed type and code, never its text or the person's id.
  'memory.export_unread': { store: { enum: ['recipients', 'tombstone ledger', 'tombstone copy', 'older traces', 'conversation traces', 'memory graph', 'archived originals', 'older compiled pages', 'compiled pages', 'learning store'] }, type: 'word', code: 'word' },
  // A store of a souled agent's mind left out of its index rows whose stored vector is not the size of its embedding model's, as after the host moved memory.embedding to a model of another size: the rows stay in the store, are recalled by their words (recall.retrieval 'hybrid') and never by meaning, and their text is not embedded again. Never an id or any text. Written once a load that left any out, with their count.
  'memory.vectors_unfit': { rows: 'int' },
  // A gmi() agent with cognitive memory on was given a memoryProvider with getContext: cognitive memory supplies the turn's memory context, so getContext is not called (observe still runs). Not written for a souled agent, whose provider recalls beside its mind. Written once, when the agent is built.
  'memory.provider_context_skipped': {},
  // A souled agent on the GMI runtime with cognitive memory on was built with a mechanism turned on (enabled: true) that nothing runs on it: temporal gist and persona drift run only inside a consolidation cycle, which a souled agent refuses, and involuntary recall only where the prompt assembler is handed the mechanisms engine and every trace, which the agent's memory manager does not do. The setting has no effect. Written once for each such mechanism, as the agent is built.
  'memory.mechanism_inactive': { mechanism: { enum: ['temporalGist', 'involuntaryRecall', 'personaDrift'] } },
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
  // souledAgent() was given an inline { content } soul, which has no workspace folder: it built a plain agent with no wiki memory, no memory index, no read_memory_page tool and no compile on close.
  'soul.inline_no_wiki': {},
  // A session was opened with an anonymous id as its user id; the session is the memory subject.
  'memory.anonymous_user': { path: { enum: ['plain', 'gmi'] } },
  // A host's memory hook threw, rejected or timed out; the turn went on without it. `soulMemory`: on a souled agent's GMI runtime, a session turn whose subject's id no memory key can be built from, whose tombstone read did not answer within the memory hooks' timeout, whose answer the GMI could not read from the soul's view (the load of the person's rows failed among them), or a write of the soul's mind that threw, the key's registry row or compile mark it writes once its trace is stored among them (on its 1st failure, then its 10th, 100th and so on, as an observe failure is written); the turn went on, its message was not scored for sentiment when its answer was not read, a write that threw before its trace was stored is a failed entry of the turn's write record, and one that threw after is a written one.
  'memory.hook_failed': { hook: { enum: ['getContext', 'observe', 'memoryPolicy', 'screen', 'soulMemory'] }, type: 'word', code: 'word' },
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
  // One forge ended: how, where, its sizes and counts. No name, code, text, reason or id. `stage` lists the stage codes
  // of the forge trace (FORGE_TRACE_STAGES, in its order): an enum, since a word field refuses a run of 20 or more
  // letters, digits and underscores, which 12 of the codes are.
  'emergent.forge_done': {
    outcome: { enum: ['approved', 'rejected', 'refused', 'failed'] },
    stage: {
      enum: [
        'guardrail_refused', 'schema_check', 'refused_before_approval', 'shape_check', 'host_refused',
        'orchestrator_refused', 'permission_check_failed', 'human_denied', 'approval_timed_out', 'approval_failed',
        'self_change_refused', 'name_refused', 'description_missing', 'engine_disabled', 'compose_refused',
        'compose_needs_step_output', 'caller_context_required', 'sandbox_disabled', 'allowlist_unknown',
        'effects_need_ceiling', 'capability_not_granted', 'code_validation', 'executor_unavailable',
        'test_responses_refused', 'judge_rejected', 'test_output_unserializable', 'compose_refused_after_judge',
        'step_cycle', 'removed_while_forging', 'activation_failed', 'registration_failed', 'approved', 'thrown',
      ],
    },
    recordedBy: { enum: ['engine', 'forge_tool', 'wrapper', 'orchestrator'] },
    via: { enum: ['forge_tool', 'direct'] },
    mode: { enum: ['sandbox', 'compose', 'none'] },
    tests: 'int',
    testsPassed: 'int',
    testsOmitted: 'int',
    codeBytes: 'int',
    traceBytes: 'int',
    cutFields: 'int',
    justificationChars: 'int',
    judgeRan: { enum: ['yes', 'no'] },
    executorIsolates: { enum: ['yes', 'no', 'none'] },
    durationMs: 'int',
  },
  // A host's onForgeTrace threw or rejected: the error's listed type and code, never its message.
  'emergent.forge_trace_hook_failed': { type: 'word', code: 'word' },
  // A host's onForgeTrace was running at its bound; the forge went on.
  'emergent.forge_trace_hook_slow': { boundMs: 'int' },
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
