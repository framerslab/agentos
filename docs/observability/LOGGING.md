# AgentOS Logging (Pino + OpenTelemetry)

AgentOS uses **structured JSON logs** via `pino` and supports **opt-in** OpenTelemetry (OTEL) correlation and export.

Defaults:

- Logs: stdout (pino JSON)
- `trace_id` / `span_id` injection: OFF
- OTEL LogRecord emission: OFF

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
- Each event's `component` is the fixed name of the AgentOS module that wrote the record, one of the words in the exported `CONTENT_SAFE_COMPONENTS` (type `ContentSafeLogComponent`). A logger's name, its bindings, a provider id or a path never become a component.
- AgentOS spans, metrics, trace ids in logs and streamed responses, OTEL LogRecords and the usage observer set with `setGlobalLlmObserver` stay off, whatever the `observability` config or the `AGENTOS_*` environment variables say. Each call's result still carries its usage.

The mode has no off switch and keeps its first settings. A second argument, `{ minLevel }`, drops records below that level without calling the sink and without writing them anywhere else; the default, `debug`, passes all four levels. A second call with the same sink and the same minimum does nothing. A second call with a different sink throws `content_safe_sink_already_set`, one with a different minimum throws `content_safe_options_already_set`, and a level other than `debug`, `info`, `warn` or `error` throws `invalid_content_safe_min_level`; each leaves the first settings in place. An error the sink throws is swallowed. When the sink returns an object or function with a `then` method, AgentOS calls that method at once with handlers that do nothing, so its rejection is swallowed too, whether it is an async sink's promise, a promise from another realm such as a `node:vm` context, or a thenable; a `then` that throws when read or called is swallowed as well. A record AgentOS writes while the sink runs, or while that `then` runs, is dropped. A record written later, such as after an async sink's `await`, reaches the sink as any other record does. `isContentSafeTelemetryEnabled()` reports whether the mode is on.

The mode leaves alone console output from other AgentOS modules (`RetrievalAugmentor`, `VectorStoreManager`, the vector stores and `PromptEngine` among them), the host's own loggers, automatic HTTP and database instrumentation, and error reporting. Errors that AgentOS returns or throws keep their messages, so the host keeps them out of its responses and logs.
