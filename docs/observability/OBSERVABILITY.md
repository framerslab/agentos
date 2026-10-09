# AgentOS Observability (OpenTelemetry)

AgentOS emits OpenTelemetry signals and leaves the SDK to the host. The host installs and starts the SDK and owns exporters, sampling and context propagation; AgentOS creates spans, records metrics, adds trace ids to logs and streamed chunks, and can emit log records, all through [`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api), so whatever exporter the host wires (OTLP to Honeycomb, Tempo, Jaeger, Grafana Cloud) receives them. Every signal is off by default.

The implementation lives in [`src/safety/evaluation/observability/otel.ts`](https://github.com/framerslab/agentos/blob/master/src/safety/evaluation/observability/otel.ts) and [`src/api/observability.ts`](https://github.com/framerslab/agentos/blob/master/src/api/observability.ts).

---

## Table of Contents

1. [Overview](#overview)
2. [Opt-In Policy](#opt-in-policy)
3. [Enable via AgentOS Config (Recommended)](#enable-via-agentos-config-recommended)
4. [Enable via Environment Variables](#enable-via-environment-variables)
5. [Host Setup (Node.js Example)](#host-setup-nodejs-example)
6. [What AgentOS Emits](#what-agentos-emits)
7. [Logging (Pino + OTEL Logs)](#logging-pino--otel-logs)
8. [Privacy & Cardinality](#privacy--cardinality)
9. [Performance Notes](#performance-notes)
10. [Practices](#practices)

---

## Overview

Defaults (all OFF):

- Manual AgentOS spans
- AgentOS metrics
- Trace IDs in streamed responses
- Log correlation (`trace_id`, `span_id`)
- OTEL LogRecord export

When enabled, AgentOS emits:

- **Spans** around turns, tool-result handling, conversation saves and the high-level API calls
- **Metrics** for turn and tool-result counters and histograms
- Optional: **trace correlation** in logs and streamed response metadata
- Optional: **OTEL LogRecords** (exported by your host, via OTLP)

---

## Opt-In Policy

There are two layers:

1. **Host OTEL SDK (required for export)**
   - In Node: `@opentelemetry/sdk-node` + exporters/instrumentations.
   - In browsers: the web OTEL SDK (if you choose to export from the client).

2. **AgentOS instrumentation toggles (what AgentOS emits)**
   - Environment variables
   - `AgentOSConfig.observability`

The toggles are process-wide: `AgentOS.initialize()` (and so `AgentOS.create()`) applies its `observability` config to the whole process, and the last runtime initialized wins. `generateText()` and the other high-level calls read the same state.

Precedence:

- `observability.enabled: false` turns every signal off, whatever the environment says.
- Otherwise a specific config field wins, then `observability.enabled` (for tracing, metrics and log trace ids), then the specific environment variable, then `AGENTOS_OBSERVABILITY_ENABLED`.
- `includeTraceInResponses` and `exportToOtel` follow only their own config field and environment variable; neither master switch turns them on.

---

## Enable via AgentOS Config (Recommended)

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  observability: {
    // Master switch: true turns on tracing, metrics and log trace ids
    // (not includeTraceInResponses or exportToOtel); false turns everything off.
    // enabled: true,

    tracing: {
      enabled: true,
      includeTraceInResponses: true, // adds metadata.trace to METADATA_UPDATE, FINAL_RESPONSE and ERROR chunks
    },
    metrics: {
      enabled: true,
    },
    logging: {
      includeTraceIds: true, // adds trace_id/span_id to pino log meta
      exportToOtel: false,   // keep OFF unless you want OTLP log export
      // otelLoggerName: '@framers/agentos',
    },
  },
});
```

---

## Enable via Environment Variables

```bash
# Master switch: tracing, metrics and log trace_id/span_id, unless config says otherwise
AGENTOS_OBSERVABILITY_ENABLED=true

# Optional fine-grained toggles
AGENTOS_TRACING_ENABLED=true
AGENTOS_METRICS_ENABLED=true
AGENTOS_TRACE_IDS_IN_RESPONSES=true
AGENTOS_LOG_TRACE_IDS=true

# Optional: emit OTEL LogRecords (still requires a host SDK + logs exporter)
AGENTOS_OTEL_LOGS_ENABLED=true

# Names (advanced; usually keep defaults)
AGENTOS_OTEL_TRACER_NAME=@framers/agentos
AGENTOS_OTEL_METER_NAME=@framers/agentos
AGENTOS_OTEL_LOGGER_NAME=@framers/agentos
```

---

## Host Setup (Node.js Example)

AgentOS only uses OTEL APIs; your host must install/start an OTEL SDK to export anything.

Typical Node setup:

1. Install dependencies:

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
```

2. Configure env (OTLP/HTTP collector example):

```bash
OTEL_SERVICE_NAME=my-agent-host
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
# OTEL_LOGS_EXPORTER=otlp  # keep explicit opt-in for log export
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# Optional sampling
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

3. Start the SDK early (before most imports) so auto-instrumentation can patch libraries:

```ts
// otel.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
});

export async function startOtel(): Promise<void> {
  await sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  await sdk.shutdown();
}
```

---

## What AgentOS Emits

### Spans

When tracing is enabled, the runtime emits:

- `agentos.turn` (root of `processRequest()`), with `agentos.gmi.get_or_create` and `agentos.gmi.process_turn_stream`
- `agentos.tool_result`, with `agentos.gmi.handle_tool_result`; `agentos.resume_external_tool_request` and `agentos.gmi.resume_get_or_create` for resumed external tool calls
- `agentos.conversation.save`, tagged with `agentos.stage`

and the high-level API emits `agentos.api.generate_text` (with `agentos.api.generate_text.step` per step), `agentos.api.stream_text` (with `.step`), `agentos.api.embed_text`, `agentos.api.generate_image`, `agentos.api.edit_image`, `agentos.api.upscale_image`, `agentos.api.variate_image`, `agentos.api.transfer_style`, `agentos.api.generate_video`, `agentos.api.analyze_video`, `agentos.api.generate_music` and `agentos.api.generate_sfx`.

The turn span carries `agentos.stream_id`, `agentos.user_id`, `agentos.session_id`, `agentos.conversation_id` and `agentos.persona_id`. The `generateText()` and `streamText()` spans also carry the GenAI attributes (`gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.*`) beside the older `llm.*` ones.

### Metrics

When metrics are enabled, AgentOS records:

- `agentos.turns` (counter) and `agentos.turn.duration_ms` (histogram)
- `agentos.turn.tokens.total`, `.prompt`, `.completion`, `.cache_read` and `.cache_creation` (histograms, when usage is known)
- `agentos.turn.cost.usd` (histogram, when cost is known)
- `agentos.turn.first_part_ms` (histogram: from the call to the first stream part, streaming calls only)
- `agentos.turn.task_success_score` (histogram, when a task outcome score is known)
- `agentos.tool_results` (counter) and `agentos.tool_result.duration_ms` (histogram)

Turn metrics carry `status`, `persona_id` and `task_outcome`; tool-result metrics carry `status`, `tool_name` and `tool_success`.

### Trace IDs in Streamed Responses

When enabled, AgentOS adds the active span's ids to `METADATA_UPDATE`, `FINAL_RESPONSE` and `ERROR` chunks:

```json
{
  "metadata": {
    "trace": {
      "traceId": "...",
      "spanId": "...",
      "traceparent": "00-...-...-01"
    }
  }
}
```

---

## Logging (Pino + OTEL Logs)

### Stdout Logs (Default)

AgentOS's `PinoLogger` writes structured logs with `pino`. When `includeTraceIds` is enabled and a span is active, it adds:

- `trace_id`
- `span_id`

to log metadata to make correlation easy in any log backend.

### OTEL LogRecord Export (Optional)

If you want logs to flow through the OTLP pipeline (instead of, or in addition to, stdout shipping):

1. Enable AgentOS OTEL log emission:
   - `AGENTOS_OTEL_LOGS_ENABLED=true`, or
   - `observability.logging.exportToOtel = true`

2. Enable a **host** logs exporter (Node example):

```bash
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Recommendation:

- Keep OTEL log export OFF by default.
- Use stdout logs + trace correlation for most deployments.
- Turn on OTEL log export when you explicitly want one unified OTLP pipeline for traces/metrics/logs.

---

## Privacy & Cardinality

- AgentOS records no prompt text, model output or tool arguments on spans or metrics. Spans carry ids (stream, user, session, conversation, persona, tool call), names, counts, durations, models and usage.
- Metric attributes are low-cardinality (`status`, `persona_id`, `task_outcome`, `tool_name`, `tool_success`). When you add your own, keep user ids, conversation ids, URLs and prompt text out of metric attributes.

---

## Performance Notes

- With a signal off, its helpers return without creating spans or recording values.
- Without a host SDK, the OpenTelemetry API hands out no-op tracers and meters.
- OTEL log export sends every log record through the host's pipeline; at `debug` volume that is a large stream.

---

## Practices

- **Structured event stream**: AgentOS streams typed chunks for each turn (text, tool calls, tool results, guardrail decisions, the final response); persist them if you need an audit trail.
- **W3C context propagation**: propagate `traceparent` across inbound HTTP, SSE/WebSocket streaming, and tool calls; use OTEL context managers (`AsyncLocalStorage`) in Node.
- **GenAI semantic conventions**: add `gen_ai.*` attributes/events to spans when instrumenting model calls, tool calls, and token usage; keep raw content behind explicit opt-in and redaction.
- **Redaction and data classification**: treat prompt/tool args/output as sensitive by default; add allowlists + hashing for debugging without content exfiltration.

Common library choices:

- Telemetry: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
- Logging: `pino` (+ `@opentelemetry/instrumentation-pino` if you want automatic injection everywhere)
- Agent/LLM observability layers: Langfuse, Helicone, Sentry AI monitoring, OpenLIT, OpenLLMetry-js

---

## References

### OpenTelemetry

- W3C. (2021). *Trace Context Level 1.* W3C Recommendation. — The `traceparent` format AgentOS writes into `metadata.trace`. [w3.org/TR/trace-context-1](https://www.w3.org/TR/trace-context-1/)
- OpenTelemetry Specification (current). *OpenTelemetry signal specifications: traces, metrics, and logs.* — The protocol contract AgentOS emits against. [opentelemetry.io/docs/specs/otel](https://opentelemetry.io/docs/specs/otel/)
- OpenTelemetry. *Semantic conventions.* — Naming and attribute schema for spans, metrics and logs. [opentelemetry.io/docs/specs/semconv](https://opentelemetry.io/docs/specs/semconv/)
- OpenTelemetry GenAI working group. *Generative AI semantic conventions.* — The schema for the `gen_ai.*` attributes (provider.name, request.model, usage.input_tokens, usage.cache_read.input_tokens and the rest) AgentOS sets on the `generateText()` and `streamText()` spans. **Pinned revision:** the semantic-conventions-genai repository has no release tags; AgentOS emits the attribute set as of commit [`c26a2c21d1ee70d5231bd440c7b48d3c94ee506a`](https://github.com/open-telemetry/semantic-conventions-genai/commit/c26a2c21d1ee70d5231bd440c7b48d3c94ee506a) (no schema URL is referenced — upstream's is still TODO). Attribute tests assert the names enumerated in `src/api/observability.ts`, not a moving upstream. [opentelemetry.io/docs/specs/semconv/gen-ai](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

### Distributed tracing foundations

- Sigelman, B. H., Barroso, L. A., Burrows, M., Stephenson, P., Plakal, M., Beaver, D., Jaspan, S., & Shanbhag, C. (2010). *Dapper, a large-scale distributed systems tracing infrastructure.* Google Technical Report. — The original distributed-tracing paper that defined the span/trace abstractions used today. [Google Research](https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/)
- Mace, J., Roelke, R., & Fonseca, R. (2015). *Pivot tracing: Dynamic causal monitoring for distributed systems.* SOSP 2015. — Causal monitoring across components. [DOI](https://doi.org/10.1145/2815400.2815415)

### Logging

- OpenTelemetry. *OpenTelemetry logging specification.* — `LogRecord`s and their link to span context; the `exportToOtel` path emits them through `@opentelemetry/api-logs`. [opentelemetry.io/docs/specs/otel/logs](https://opentelemetry.io/docs/specs/otel/logs/)
- Pino contributors. *Pino: Very low overhead Node.js logger.* — The logger [`PinoLogger`](https://github.com/framerslab/agentos/blob/master/src/core/logging/PinoLogger.ts) wraps. [GitHub](https://github.com/pinojs/pino)

### Implementation references

- `src/safety/evaluation/observability/otel.ts` — the toggles, span helpers, metric instruments and trace metadata
- `src/api/observability.ts` — usage and GenAI attributes on the high-level API spans
- `src/api/runtime/StreamChunkEmitter.ts` — `metadata.trace` on streamed chunks
- `src/core/logging/PinoLogger.ts` — log trace ids and the OTEL log path
- `src/safety/evaluation/observability/Tracer.ts` — a standalone in-process tracer class (`ITracer`); the runtime's spans do not use it
