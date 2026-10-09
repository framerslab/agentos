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
