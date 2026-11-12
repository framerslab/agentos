# AgentOS Logging (Pino + OpenTelemetry)

AgentOS uses **structured JSON logs** via `pino` and supports **opt-in** OpenTelemetry (OTEL) correlation and export.

Defaults:

- Logs: stdout (pino JSON)
- `trace_id` / `span_id` injection: OFF
- OTEL LogRecord emission: OFF

## Hand AgentOS your logger

```ts
import pino from 'pino';
import { setLogger } from '@framers/agentos/logging';

setLogger(pino());
```

`setLogger` takes a pino logger or a pino child as it is, and `setLogger(null)` silences every event handle; a `createLogger` logger made before keeps the target it was made with. An event handle writes each line object first and with no message: `{ ...context, ...fields, event }`. The event names and their fields are data, exported as `AGENTOS_EVENTS`; each field is an integer, a word, a path or one of a declared list, and a word or a path shaped like a credential is refused. The context keys, exported as `AGENTOS_CONTEXT`, are `component`, `extension` and `requestId`. Nothing a person wrote, a model answered or a tool was given is a field, and an error is written as its `type` and `code`, never its message, each kept only when the library lists it (see [Errors in a line](#errors-in-a-line)). A class name ending in `Error` or `Exception` (`OpenRouterProviderError`) and an upper-case constant code (`STREAM_PARSING_ERROR`) are kept at any length up to 64 characters, and a word field named `type` or `code` takes them on an event handle and in the kit; any other value shaped like a credential, and a property that throws when read, is written as `unknown`.

The OpenAI and OpenRouter providers, the provider manager, the fallbacks of `generateText` and `streamText`, `AgentOSServer`, the language module (`LanguageService` and its translation providers), the guardrail dispatchers (component `guardrails`, see [Guardrail events](#guardrail-events)), governed tools (component `action_governance`), `agency()`'s callback guard (component `agency`, see [Governed action events](#governed-action-events)) and cognitive memory's recall (component `memory.recall`; `AGENTOS_EVENTS` declares its ten events, `memory.recall.leg_absent`, `memory.recall.rerank_skipped`, `memory.recall.rerank_unavailable`, `memory.recall.budget_clamped`, `memory.recall.allocation_exhausted`, `memory.recall.option_ignored`, `memory.recall.option_rejected`, `memory.recall.reserve_fired`, `memory.recall.supplied_rejected` and `memory.recall.rerank_failed_scoring`, of which `agent()`, `gmi()` and `CognitiveMemoryManager.initialize()` write `option_rejected` before a refusal and `agent()` and `gmi()` write `option_ignored`; the others are declared for the recall stages) write through event handles that read the current target at each line, so a logger handed over after AgentOS was imported still receives their lines. `lazyLogger(component)` returns such a handle, typed over `AGENTOS_EVENTS`: it accepts only a declared event with its declared fields, and at run time it refuses an undeclared event as `unknown_event`, so a JavaScript caller cannot write one either. A line that fails its check is written as `log_refused` with a fixed `reason` (`unknown_event`, `unknown_key`, `bad_value` or `bad_context`) and never the key or the value; under `NODE_ENV=test` it is thrown as a `LogValidationError` instead. A logger that throws never reaches the caller.

`setLoggerFactory`, `createLogger`, `resetLoggerFactory` and `ILogger` keep working: with a factory set, a handle calls it with its component and context at each line and writes `(event, fields)` to the logger it returns. A `createLogger` logger is the older surface and is not checked: its message and its metadata reach the handed-over logger as the caller gave them. A host that must keep every line free of content hands AgentOS the kit's `asLogger()` below, which writes such a line as `agentos.untyped` with only its component and its level, or turns on content-safe telemetry. The last setter wins, and `resetLoggerFactory()` returns to the default pino root. Every copy of AgentOS in a process shares one hand-over.

Without a hand-over, AgentOS writes to a pino root on standard output that it builds at its first line. `AGENTOS_LOG_LEVEL` sets its level in any case (`info` when unset), `AGENTOS_DEBUG=1` or `AGENTOS_DEBUG=true` sets `debug`, and an unknown level gives `info` and one `logging.level_unknown` line that does not repeat the value.

### Errors in a line

An error's `name` and `code` are set by whoever threw it: a tool, a vendor's SDK, a host's store, sink, callback or handler. A value that only has the shape of a class name or a constant code can be a person's words (`PERSONAL_DATA` has a code's shape, `MeetMeAtBakerStreetError` a class name's), so no value a model, a vendor or a tool supplies is written to a line as it came. Every typed event line AgentOS writes an error into takes its fields from `listedErrorFields(error)` (a line of the older `createLogger` surface is not checked, as above):

- `type` is the error's `name` when it is in `LISTED_ERROR_TYPES` (JavaScript's built-in error classes, `AbortError`, `TimeoutError`, `DataCloneError`, the library's own error classes and the names the library sets on an error where it throws it, such as `DeepLHttpError`), or the value's `typeof` when it is not an `Error`; otherwise `unknown`.
- `code` is the error's `code` when it is in `LISTED_ERROR_CODES` (every literal code the library's own source gives an error, in upper or lower case, such as `STREAM_PARSING_ERROR`, `CONTEXT_WINDOW_EXCEEDED`, `REQUEST_ABORTED`, `IMAGE_URL_REFUSED`, `call_ended` and the `GMIErrorCode` values, and Node.js's network codes `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE` and `ABORT_ERR`); otherwise `unknown`, as is an error with no code.
- Never the message or the stack, and reading never throws: a property whose getter throws is `unknown`.

Both lists are read-only views with no `add`, `delete` or `clear`, so a host cannot add to them. A host's own error class or a store driver's code (`23505`) reads `unknown`; the line, its level and its other fields stay. This covers the events declared before the lists as well: `llm.response_format_failed`, `llm.fallback_fired`, `llm.fallback_exhausted`, `llm.provider_start_failed`, `llm.models_failed`, `llm.stream_failed`, `llm.stream_cancel_failed`, `http.handler_failed`, `language.detection_failed`, `language.translation_failed`, `memory.hook_failed`, `soul.load_failed`, `process.uncaught` and `console_line`. `errorFields()` keeps its name for a deep import of `@framers/agentos/core/logging/events` and returns the same answer.

### Guardrail events

The guardrail dispatchers, `moderateContent()` and the image guard write six events through the `guardrails` component. None carries a guard's reason, the content it judged or an error's message.

| Event | Level | Fields | Written when |
|---|---|---|---|
| `guardrail.failed` | warn | `guardrailId`, `stage` (`input`, `output`, `tool_call`), `posture` (`open`, `closed`), `cause` (`error`, `timeout`, `malformed`), `type`, `code` | A guard threw or timed out, or a guard run under the required or the moderation posture answered no recognised action, `undefined` included (`malformed`). `posture` says whether it was skipped (`open`) or blocked (`closed`); a timeout and a malformed answer have no `type` or `code` |
| `guardrail.sanitize_downgraded` | warn | `guardrailId`, `stage` | A phase 2 SANITIZE became a FLAG, or a tool call's SANITIZE a BLOCK |
| `guardrail.hold_ignored` | warn | `guardrailId`, `stage` | A guard answered `hold` with an action other than BLOCK; written once per guard |
| `guardrail.verdict_callback_failed` | warn | `type`, `code` | An `onVerdict` callback threw; the verdict stands |
| `guardrail.verdict` | info | `guardrailId`, `stage` (`input`, `output`, `tool_call`), `action` (`flag`, `sanitize`, `hold`, `block`), `code`, `surface`, `mode` (`enforce`, `dry_run`), `unavailable` (`yes`, `no`) | `moderateContent()` decided something other than an allow, or a guard rewrote the text of an allow (`action: sanitize`). `guardrailId` is the deciding guard; `unavailable` is `yes` when only a closed guard's failure, or an image the image guard could not have checked, kept the content back |
| `image_guard.check_failed` | warn | `guardrailId`, `checkId`, `posture` (`refuse`, `skip`), `type`, `code` | A check of an `ImageGuardrail` threw or answered no verdict, or an image could not be captured (`checkId: load`: an `image_url` input with no `loadImage`, a `loadImage` that threw or returned no bytes, base64 that did not decode, no mime type). `posture` says whether the image was refused as unavailable (`refuse`) or the check was skipped as a signal (`skip`). Never the image, its URL, its description or an error's message |

`type` and `code` come from `listedErrorFields()`. A guard's id that is not a valid word is written `unknown`.

The `code` of `guardrail.verdict` is the deciding evaluation's reason code, or a hold's review code. It is written only when the deciding guard lists it in `config.reasonCodes` or the library made the evaluation for a closed guard's failure (`GUARDRAIL_ERROR`, `GUARDRAIL_MALFORMED`; a guard that answers one of those codes itself does not count); any other code, a model's answer or a vendor's label included, is written `unknown`. `surface` is the word from `context.moderation.surface`. A plain allow writes no line, and no line carries the content. The `guards` option of `generateText()` and `streamText()` writes the same line for each stage decision, with `stage` `input`, `output` or `tool_call`.

### Governed action events

A [governed tool](../safety/SAFETY_PRIMITIVES.md#governed-tools) writes two events through the `action_governance` component, and `agency()` writes one through the `agency` component. None carries an argument, a quote, an id a model supplied or an error's message.

| Event | Level | Fields | Written when |
|---|---|---|---|
| `action.ended` | info for `executed` and `would_execute`, warn for the rest | `action`, `outcome` (`executed`, `failed`, `would_execute`, `refused_arguments`, `voided_evidence`, `limit_reached`, `duplicate`, `limiter_unavailable`, `audit_unavailable`), `code`, `mode` (`enforce`, `dry_run`) | A governed call ended. `action` is the policy's action name. `code` is one the wrapper built: an evidence failure, a fixed code (`ARGUMENT_SHAPE`, `POLICY_ERROR`, `TARGET_MISMATCH`, `LIMIT_SCOPE_MISSING`, `RETRIES_EXHAUSTED`, `LEASE_EXPIRED`, `REVERSAL_DROPPED`) or the id of one of the tool's own limit rules, and absent when the end has none |
| `action.audit_failed` | error | `action`, `half` (`begin`, `finish`), `type`, `code` | The host's audit sink threw on one half of a record. A `begin` that throws refuses the action; a `finish` that throws leaves its outcome as it was |
| `agency.callback_failed` | warn | `callback` (`agentStart`, `agentEnd`, `handoff`, `toolCall`, `error`, `emergentForge`, `guardrailResult`, `limitReached`, `approvalRequested`, `approvalDecided`, `guardrailHitlOverride`), `type`, `code` | A callback of `agency()` threw, or its promise rejected, whichever part of a run fired it: the agency, its strategy, a panel, a tool approval or the post-approval check. The call goes on. A callback is handed what the call sent, a tool call's arguments among it, and can throw it back, so the line never holds the error's message |

`type` and `code` come from `listedErrorFields()`: a type or a code the library does not list is written `unknown`.

### One line per server request

`AgentOSServer` runs each request under a fresh id, returns it in the `x-request-id` header (exposed to cross-origin browser clients when `enableCors` is on), and adds it as `requestId` to every event line AgentOS writes while the request runs. When the response closes it writes one `http.request` line:

```json
{ "level": 30, "component": "http", "requestId": "3f0c1d9e-6c1b-4f6e-9a57-2b8e0c4d7a11", "method": "POST", "route": "/api/agentos/chat", "status": 200, "ms": 412, "outcome": "ok", "event": "http.request" }
```

`route` is one of the server's own paths (`/health`, `/api/agentos/personas`, `/api/agentos/chat`), `extension` for a request an extension's HTTP handler took, `preflight` for `OPTIONS`, `unready` when AgentOS failed to initialize, and `unmatched` for the rest, so no path a client sent, its query or a parameter in it reaches a line. A request the client gives up on while AgentOS is still starting keeps the route its method and path name. `status` is 0 when no status was sent. `outcome` is `error` at `error` for a 5xx status or a handler that threw, even when the connection then closed early; otherwise `aborted` at `warn` when the connection closed before the response finished; otherwise `ok` at `info`. An extension handler that throws is written once, as `http.handler_failed` with the error's `type` and `code`; when it had already begun its response, its connection is closed.

### The allow-list kit

A host that checks AgentOS's lines and its own against one map uses the kit, `@framers/agentos/logging/kit`:

```ts
import pino from 'pino';
import { setLogger } from '@framers/agentos/logging';
import { createAllowListLogger, captureConsole, installProcessHandlers } from '@framers/agentos/logging/kit';

const kit = createAllowListLogger({ logger: pino(), events: { 'job.done': { ms: 'int' } } });
kit.info('job.done', { ms: 120 });
setLogger(kit.asLogger());
const restoreConsole = captureConsole(kit);
installProcessHandlers(kit, { onShutdown: () => process.exit(0) });
```

- The kit's map always holds AgentOS's own events, and its type does too. The product's map may name one of them again only with the same fields; another declaration throws a `TypeError`, so AgentOS's own lines are never refused. A `context` map adds keys a child may bind to AgentOS's `component`, `extension` and `requestId`, and may name one of those again only with its kind; it may not declare `event`, `level` or `time`, which every line carries of its own, and one that does throws a `TypeError`. A refused line is `log_refused` at `warn` with its reason and, for a declared event, its name. A line that reaches `asLogger()` with an undeclared event is written as `agentos.untyped` with only its component and its level.
- Each event and each refusal reason writes its first lines of a minute up to `burst` (30 unless set), then one `log_held` line with the count held. Every kit in the process shares the budgets. `http.request` counts like any other event, so a server over a kit writes one line per request up to `burst` a minute, and the `log_held` count stands for the rest, with no request ids; a host that needs every request's line sets `burst` above its request rate.
- `terminal(event, fields)` writes the process's last line at `fatal`, past the budget. `close()` stops the kit.
- `captureConsole(kit)` turns each console call into one `console_line` event with the method and, for an error, its type and code, and returns a function that restores the console. For an error whose stack opens with its own name and message, the frame lines (`at ...`) also go to standard error, outside the kit's checks, so they name the files and functions on the stack: at most 50, leaving out any line over 512 characters or holding a control or direction character. A console call never throws on an error whose properties throw when read.
- `installProcessHandlers(kit, { onShutdown, onFatal })` writes `process.shutdown` on SIGTERM or SIGINT and then calls `onShutdown`; an uncaught exception or an unhandled rejection writes `process.uncaught` through `terminal()` and then calls `onFatal`, which exits with status 1 unless given. Importing or creating a kit installs no listener.

## Enable Trace Correlation (Recommended)

When enabled, AgentOS adds `trace_id` and `span_id` fields to log metadata **when an active span exists**.

### Via AgentOS Config (per instance)

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  observability: {
    tracing: { enabled: true },
    logging: { includeTraceIds: true },
  },
});
```

### Via `.env` (process-wide default)

```bash
AGENTOS_OBSERVABILITY_ENABLED=true
AGENTOS_LOG_TRACE_IDS=true
```

## Export Logs via OpenTelemetry (Optional)

If you want AgentOS logs to be exported over OTLP as **OTEL LogRecords** (instead of, or in addition to, stdout log shipping):

1. Enable AgentOS OTEL log emission:

- Config: `observability.logging.exportToOtel = true`
- Or env: `AGENTOS_OTEL_LOGS_ENABLED=true`

2. Enable a **host** OTEL logs exporter (Node example):

```bash
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Notes:

- AgentOS does **not** start an OTEL SDK. Your host application must install/start an OTEL SDK (for Node: `@opentelemetry/sdk-node`) and configure exporters.
- OTEL log export is intentionally opt-in: it can increase CPU/network usage and can cause **double ingestion** if you also ship stdout logs to a log backend.

## Recommended Defaults

- Keep OTEL log export OFF by default.
- Use stdout structured logs (`pino`) everywhere.
- Enable trace correlation (`trace_id`/`span_id`) when you enable tracing.
- Enable OTEL log export only when you explicitly want one unified OTLP pipeline for traces/metrics/logs.

## Correlating every pino log (Node)

If you want trace/span correlation injected automatically across *all* pino logs in a service (not only AgentOS logs), consider using `@opentelemetry/instrumentation-pino` in your host app, and keep AgentOS correlation enabled for consistency.

## Content Safety

Treat prompts, model outputs, and tool arguments as sensitive:

- Keep them out of logs by default.
- If you must log any content for debugging, put it behind explicit opt-in and apply redaction/allowlists.

### Content-safe server telemetry

A server that sends private material through model calls can turn AgentOS's own log records into fixed events for the whole process:

```ts
import pino from 'pino';
import { enableContentSafeTelemetry } from '@framers/agentos/logging';

const log = pino();

// Once, at startup, before any provider is created or any request is accepted.
enableContentSafeTelemetry((event) => {
  log.info({ state: event.state, n: event.n, component: event.component }, 'agentos_library_event');
});
```

From that call on, for the life of the process:

- Every record of a `PinoLogger` or of a logger from `createLogger`, including one created before the call, reaches the sink as `{ kind: 'library_event', state, n: 1, component }`, where `state` is the record's level and `component` is `pino_logger` or `logger_factory`. Its message, metadata, bindings, logger name and error are dropped without being read.
- The console diagnostics of the LLM providers, the provider manager, the model router, the provider health registry, `EmbeddingManager`, `generateText` and `streamText` with their model resolution, spend budget, tool-emulation loop and tool-approval gate, and the `launch_agency` tool a `gmi()` agent registers become the same events. So do the console fallbacks of the voice pipeline's `startListenSession`, `ReconnectingSTT`, `StreamingSTTChain` and `LiveKitStreamTransport`, which then read no provider warning or error text. A transport given a `logger` keeps writing its warnings to that logger, and a `'warning'` or `'error'` listener keeps receiving the event. A listen session's host that wants to count warnings passes `onWarning` to `startListenSession`, which receives only `stt_warning` or `speaker_failed`.
- Each event's `component` is the fixed name of the AgentOS module that wrote the record, one of the words in the exported `CONTENT_SAFE_COMPONENTS` (type `ContentSafeLogComponent`). A logger's name, its bindings, a provider id or a path never become a component. The event lines of the OpenAI and OpenRouter providers, the provider manager, the fallbacks of `generateText` and `streamText`, `AgentOSServer`'s request lines, the language module's lines (`language_service`), the guardrail dispatchers' lines (`guardrails`), the governed tools' lines (`action_governance`), `agency()`'s callback lines (`agency`) and cognitive memory's recall lines (`cognitive_memory`) name their module the same way; a handle from `lazyLogger` names `library`.
- AgentOS spans, metrics, trace ids in logs and streamed responses, OTEL LogRecords and the usage observer set with `setGlobalLlmObserver` stay off, whatever the `observability` config or the `AGENTOS_*` environment variables say. Each call's result still carries its usage.

The mode has no off switch and keeps its first settings. A second argument, `{ minLevel }`, drops records below that level without calling the sink and without writing them anywhere else; the default, `debug`, passes all four levels. A second call with the same sink and the same minimum does nothing. A second call with a different sink throws `content_safe_sink_already_set`, one with a different minimum throws `content_safe_options_already_set`, and a level other than `debug`, `info`, `warn` or `error` throws `invalid_content_safe_min_level`; each leaves the first settings in place. An error the sink throws is swallowed. When the sink returns an object or function with a `then` method, AgentOS calls that method at once with handlers that do nothing, so its rejection is swallowed too, whether it is an async sink's promise, a promise from another realm such as a `node:vm` context, or a thenable; a `then` that throws when read or called is swallowed as well. A record AgentOS writes while the sink runs, or while that `then` runs, is dropped. A record written later, such as after an async sink's `await`, reaches the sink as any other record does. `isContentSafeTelemetryEnabled()` reports whether the mode is on.

The mode leaves alone console output from other AgentOS modules (`RetrievalAugmentor`, `VectorStoreManager`, the vector stores and `PromptEngine` among them), the host's own loggers, automatic HTTP and database instrumentation, and error reporting. Errors that AgentOS returns or throws keep their messages, so the host keeps them out of its responses and logs.

[Content-Safe Voice Diagnostics](../CONTENT_SAFE_VOICE.md) has the voice pipeline's side of the mode: the listen session's `onWarning` callback, the console fallbacks the mode covers and the transport loggers and listeners it leaves to the host.
