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
  log.info({ state: event.state, n: event.n }, 'agentos_library_event');
});
```

From that call on, for the life of the process:

- Every record of a `PinoLogger` or of a logger from `createLogger`, including one created before the call, reaches the sink as `{ kind: 'library_event', state, n: 1 }`, where `state` is the record's level. Its message, metadata, bindings and error are dropped without being read.
- The console diagnostics of the LLM providers, the provider manager, the model router, the provider health registry, `EmbeddingManager`, and `generateText` with its model resolution, spend budget and tool-emulation loop become the same events.
- AgentOS spans, metrics, trace ids in logs and streamed responses, OTEL LogRecords and the usage observer set with `setGlobalLlmObserver` stay off, whatever the `observability` config or the `AGENTOS_*` environment variables say. Each call's result still carries its usage.

The mode has no off switch and keeps its first sink: a second call with the same sink does nothing, and a different sink throws `content_safe_sink_already_set`. An error the sink throws is swallowed, and a record AgentOS writes while the sink runs is dropped. `isContentSafeTelemetryEnabled()` reports whether the mode is on.

The mode leaves alone console output from other AgentOS modules (`streamText`, `RetrievalAugmentor` and `VectorStoreManager` among them), the host's own loggers, automatic HTTP and database instrumentation, and error reporting. Errors that AgentOS returns or throws keep their messages, so the host keeps them out of its responses and logs.
