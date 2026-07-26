# AgentOS Observability (OpenTelemetry)

You can't operate an agent runtime in production without observability, and the cost of bolting it on after the fact is paid in incidents you can't reproduce. AgentOS treats spans, metrics, and log correlation as first-class concerns — but it does not own the OpenTelemetry SDK lifecycle. The SDK is an application-level concern: your host owns exporters, sampling, and context propagation, because the right answer for a CLI process is different from the right answer for a long-running server is different from the right answer for an edge worker.

What AgentOS owns is the *emit side*: opt-in spans around turns and tool-result handling, opt-in counters and histograms for the operations worth measuring, optional trace-correlation in logs and streamed response metadata, and an optional path to export application logs as OTEL `LogRecord`s. All defaults are off. Turning them on is a single config change, and the runtime will surface to whatever exporter your host has wired (OTLP to Honeycomb, Tempo, Jaeger, Grafana Cloud — the runtime doesn't care, because your host SDK is what does the export).

The implementation lives in [`src/evaluation/observability/`](https://github.com/framerslab/agentos/tree/master/src/evaluation/observability) and uses [`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api) directly — never bundled, always peer-dep-style imported, so your host SDK is the one and only OTEL provider in the process.

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
10. [SOTA Techniques (TypeScript Agentic AI)](#sota-techniques-typescript-agentic-ai)

---

## Overview

Defaults (all OFF):

- Manual AgentOS spans
- AgentOS metrics
- Trace IDs in streamed responses
- Log correlation (`trace_id`, `span_id`)
- OTEL LogRecord export

When enabled, AgentOS emits:

- **Spans** around turns and tool-result handling
- **Metrics** for turn/tool counters + histograms
- Optional: **trace correlation** in logs and streamed response metadata
- Optional: **OTEL LogRecords** (exported by your host, via OTLP)

---

## Opt-In Policy

There are two layers:

1. **Host OTEL SDK (required for export)**
   - In Node: `@opentelemetry/sdk-node` + exporters/instrumentations.
   - In browsers: the web OTEL SDK (if you choose to export from the client).

2. **AgentOS instrumentation toggles (controls what AgentOS *emits*)**
   - Env flags (global defaults)
   - `AgentOSConfig.observability` (per-agent control)

Precedence:

- `AgentOSConfig.observability.enabled = false` hard-disables all AgentOS observability helpers (even if env is set).
- Otherwise, config fields override env fields, and env provides defaults.

---

## Enable via AgentOS Config (Recommended)

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  observability: {
    // Master switch: when true, defaults to enabling tracing/metrics + log correlation.
    // Keep explicit per-signal toggles if you want a tighter blast radius.
    // enabled: true,

    tracing: {
      enabled: true,
      includeTraceInResponses: true, // adds metadata.trace to select streamed chunks
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
# Master switch: enables tracing + metrics + log trace_id/span_id injection defaults
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

In this monorepo, the backend bootstrap lives at `backend/src/observability/otel.ts`.

---

## What AgentOS Emits

### Spans

When tracing is enabled, AgentOS emits spans such as:

- `agentos.turn`
- `agentos.gmi.get_or_create`
- `agentos.gmi.process_turn_stream`
- `agentos.tool_result`
- `agentos.gmi.handle_tool_result`
- `agentos.conversation.save` (stage-tagged)

### Metrics

When metrics are enabled, AgentOS records:

- `agentos.turns` (counter)
- `agentos.turn.duration_ms` (histogram)
- `agentos.turn.tokens.total|prompt|completion` (histograms; only when usage is available)
- `agentos.turn.cost.usd` (histogram; only when cost is available)
- `agentos.tool_results` (counter)
- `agentos.tool_result.duration_ms` (histogram)

### Trace IDs in Streamed Responses

When enabled, AgentOS attaches trace metadata to select streamed chunks:

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

AgentOS uses `pino` for structured logs. When `includeTraceIds` is enabled and an active span exists, AgentOS adds:

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

Defaults are conservative:

- Prompts, model outputs, and tool arguments are **not** recorded by default.
- Prefer safe metadata only (durations, status, tool names, model/provider ids, token usage, cost).

Cardinality guidance:

- Avoid labeling metrics/spans with high-cardinality values (user ids, conversation ids, raw URLs, prompt text).
- Keep attributes stable and low-cardinality (e.g. `status`, `tool_name`, `persona_id`).

---

## Performance Notes

- AgentOS observability helpers are a safe no-op when disabled.
- Traces/metrics are typically low overhead when sampling is enabled.
- OTEL log export can add noticeable CPU/network overhead at `debug` volume; use it intentionally.

---

## SOTA Techniques (TypeScript Agentic AI)

Patterns that work well in practice:

- **Structured event stream**: emit agent lifecycle events (turn started, tool called, tool returned, policy decision, final output) as strongly-typed records (AgentOS already streams chunks; persist them if you need audits).
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

- W3C. (2021). *Trace Context Level 1.* W3C Recommendation. — The W3C standard for distributed-trace context propagation across process boundaries; AgentOS uses it to correlate spans across microservices. [w3.org/TR/trace-context-1](https://www.w3.org/TR/trace-context-1/)
- OpenTelemetry Specification (current). *OpenTelemetry signal specifications: traces, metrics, and logs.* — The protocol contract AgentOS emits against. [opentelemetry.io/docs/specs/otel](https://opentelemetry.io/docs/specs/otel/)
- OpenTelemetry. (current). *Semantic conventions.* — Naming and attribute schema for spans/metrics/logs; AgentOS follows the GenAI semantic conventions for LLM-call attributes. [opentelemetry.io/docs/specs/semconv](https://opentelemetry.io/docs/specs/semconv/)
- OpenTelemetry GenAI working group. *Generative AI semantic conventions.* — The schema for `gen_ai.*` attributes (provider.name, request.model, usage.input_tokens, usage.cache_read.input_tokens, etc.) AgentOS sets on LLM-call spans. **Pinned revision:** the semantic-conventions-genai repository has no release tags; AgentOS emits the attribute set as of commit [`c26a2c21d1ee70d5231bd440c7b48d3c94ee506a`](https://github.com/open-telemetry/semantic-conventions-genai/commit/c26a2c21d1ee70d5231bd440c7b48d3c94ee506a) (no schema URL is referenced — upstream's is still TODO). Attribute tests assert the names enumerated in `src/api/observability.ts`, not a moving upstream. [opentelemetry.io/docs/specs/semconv/gen-ai](https://opentelemetry.io/docs/specs/semconv/gen-ai/)

### Distributed tracing foundations

- Sigelman, B. H., Barroso, L. A., Burrows, M., Stephenson, P., Plakal, M., Beaver, D., Jaspan, S., & Shanbhag, C. (2010). *Dapper, a large-scale distributed systems tracing infrastructure.* Google Technical Report. — The original distributed-tracing paper that defined the span/trace abstractions used today. [Google Research](https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/)
- Mace, J., Roelke, R., & Fonseca, R. (2015). *Pivot tracing: Dynamic causal monitoring for distributed systems.* SOSP 2015. — Causal monitoring methodology informing the trace-id propagation through [`AgentOSResponse`](https://github.com/framerslab/agentos/blob/master/src/api/types/AgentOSResponse.ts) metadata. [DOI](https://doi.org/10.1145/2815400.2815415)

### Logging

- OpenTelemetry. (current). *OpenTelemetry logging specification.* — The bridge spec connecting `LogRecord` events to span context; AgentOS's optional `exportToOtel` log path follows it. [opentelemetry.io/docs/specs/otel/logs](https://opentelemetry.io/docs/specs/otel/logs/)
- Pino contributors. (current). *Pino: Very low overhead Node.js logger.* — The logger AgentOS wraps via [`PinoLogger`](https://github.com/framerslab/agentos/blob/master/src/core/logging/PinoLogger.ts); chosen for its sub-microsecond per-line cost in hot paths. [GitHub](https://github.com/pinojs/pino)

### Implementation references

- `packages/agentos/src/evaluation/observability/Tracer.ts` — span creation around turn / tool / guardrail / LLM-call boundaries
- `packages/agentos/src/evaluation/observability/otel.ts` — OpenTelemetry API peer-dep wiring
- `packages/agentos/src/logging/PinoLogger.ts` — structured logger with trace-id / span-id field injection
- `packages/agentos/src/evaluation/SqlTaskOutcomeTelemetryStore.ts` — persisted per-turn outcome KPIs for rolling-quality dashboards
