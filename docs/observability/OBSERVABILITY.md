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
7. [The Usage Observer](#the-usage-observer)
8. [Logging (Pino + OTEL Logs)](#logging-pino--otel-logs)
9. [Privacy & Cardinality](#privacy--cardinality)
10. [Performance Notes](#performance-notes)
11. [Practices](#practices)

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

- Content-safe telemetry, once a host enables it with `enableContentSafeTelemetry` from `@framers/agentos/logging` ([LOGGING.md](https://github.com/framerslab/agentos/blob/master/docs/observability/LOGGING.md)), keeps every signal off for the rest of the process, whatever the config or environment says, and the global usage observer is not called.
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

## The Usage Observer

`setGlobalLlmObserver()` registers one process-wide callback that hears each finished model call of `generateText()`, `streamText()`, `generateObject()`, `streamObject()`, `agent()` and `gmi()`, with no wrapper at any call site. A host tags its rows from the event:

```ts
import { generateText, setGlobalLlmObserver } from '@framers/agentos';

setGlobalLlmObserver((event) =>
  usageRows.insert({
    account: event.accountId,
    meter: event.source ?? 'llm.call',
    provider: event.provider,
    model: event.model,
    costUSD: event.usage.costUSD ?? 0,
  }),
);

await generateText({
  provider: 'anthropic',
  prompt: 'Summarize QUIC in one sentence.',
  source: 'digest',
  budget: { maxCostUSD: 1, accountId: 'acct-1' },
});
```

`event.accountId` is the account the call ran for:

| The call has | `accountId` |
|---|---|
| A budget that names an account | The budget's `accountId`, or the nearest one up its `parent` chain. A call held to two budgets (a seat's turn on `gmi()`) reads the one its team's call carries, then the agent's own |
| No such budget, and `accountIdOf` | What `accountIdOf({ provider, model, source, surface })` answers |
| Neither | Absent |

`accountIdOf` is an option of `generateText()`, `streamText()`, `generateObject()`, `streamObject()`, `agent()` and `gmi()`, and an agent's `generate()` and `stream()` calls take their own in its place. It suits a host that holds the account in its own request context and puts no budget on the call. It runs on the call path and returns a string at once; an answer that is not a non-empty string leaves the field absent. One that throws does too, logs one warning naming the error's built-in type (`TypeError`, `RangeError` and the rest, otherwise `Error`; never the error's message or a `name` the host set), and the model call goes on. A promise is not an account: the field is absent, and a promise that rejects logs the same warning and is never left unhandled. It is asked only for an event an observer will hear, and never when the budget already names the account.

### A refused call

When the model refused the request with a refusal message ([A refusal from the model](../getting-started/HIGH_LEVEL_API.md#a-refusal-from-the-model)), the event `generateText()` or `streamText()` fires carries `refused: true`. Its `finishReason` is the reason the call reported: `'stop'`, or `'length'` when the output cap cut the message off. The call's root span carries the attribute `agentos.api.refused`. An event with no `refused` field is a call the model did not refuse, a `streamText()` call whose model stream ended on an error or an abort, or a call whose `abortSignal` fired while the output guards judged the refusal message (on `generateText()` too). A `streamText()` event names the reason the model's stream resolved to. With `guards` set, the output guards judge the refusal message before the event fires. When they block it, `generateText()` rejects and `streamText()` ends on an `error` part, and the event says `refused: true` beside `finishReason` `'error'` (no other event has both), and the root span has `agentos.api.finish_reason` `'error'`, `agentos.api.refused` and `agentos.api.guard_blocked`. When the caller's `abortSignal` fires while they judge it, the event says `finishReason` `'error'` with no `refused` (a `streamText()` event says `aborted: true`). A reply that is not a refusal is reported as the model gave it, whatever the guards then decide.

### An aborted call

A `streamText()` call ended through its `abortSignal` fires an event when it used anything, with `aborted: true` and `finishReason: 'error'`. A stream aborted after the provider read the request reports what it billed:

| Provider reported before the abort | `event.usage` |
|---|---|
| Its final counts (Anthropic's `message_delta`, OpenRouter's usage line) | Those counts, once. `usageEstimated` is absent |
| Input only (Anthropic's `message_start`, then the abort) | The input and cache counts exactly, and `completionTokens` estimated from the characters streamed so far (text, tool input and thinking) at four characters a token. `event.usageEstimated` and `event.usage.completionTokensEstimated` are `true`, and `costUSD` prices the estimate |
| Nothing (an abort before the first event) | No event |

Anthropic sends no per-delta usage: its output count arrives only on the final `message_delta`, so an Anthropic stream aborted between `message_start` and `message_delta` always reports an estimated output count. A host that writes its own estimate for an aborted call can drop it and read the event.

```ts
setGlobalLlmObserver((event) =>
  usageRows.insert({
    provider: event.provider,
    model: event.model,
    costUSD: event.usage.costUSD ?? 0,
    aborted: event.aborted === true,
    estimated: event.usageEstimated === true,
  }),
);
```

The observer is not called while content-safe telemetry is on; read usage from the call's result instead.

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
