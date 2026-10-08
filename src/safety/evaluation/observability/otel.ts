import type { Attributes, Span, SpanContext, SpanKind } from '@opentelemetry/api';
import { context, metrics, trace, SpanStatusCode } from '@opentelemetry/api';

export interface AgentOSObservabilityConfig {
  /**
   * Master switch. When explicitly `false`, all AgentOS observability helpers are disabled
   * regardless of environment variables.
   */
  enabled?: boolean;

  tracing?: {
    /**
     * Enables manual AgentOS spans (agent turn, tool-result handling, etc).
     * Default: false.
     */
    enabled?: boolean;

    /**
     * OpenTelemetry tracer name used for AgentOS spans.
     * Default: "@framers/agentos".
     */
    tracerName?: string;

    /**
     * When enabled, AgentOS attaches `metadata.trace` (traceId/spanId/traceparent)
     * to select streamed chunks (e.g. metadata updates, final responses, errors).
     * Default: false.
     */
    includeTraceInResponses?: boolean;
  };

  logging?: {
    /**
     * When enabled, `PinoLogger` will add `trace_id` and `span_id` fields to log meta
     * when an active span exists.
     *
     * Note: This does not start OpenTelemetry by itself; it only correlates logs with
     * whatever tracing provider your host app installed.
     *
     * Default: false.
     */
    includeTraceIds?: boolean;

    /**
     * When enabled, AgentOS will emit OpenTelemetry LogRecords using `@opentelemetry/api-logs`.
     *
     * This is still opt-in because it can increase CPU/network usage and may result in double-ingestion
     * if you already ship stdout logs separately.
     *
     * Note: This does not start OpenTelemetry. Your host app must install/start an OTEL SDK and
     * configure a logs exporter (e.g. `OTEL_LOGS_EXPORTER=otlp` in NodeSDK).
     *
     * Default: false.
     */
    exportToOtel?: boolean;

    /**
     * OpenTelemetry logger name used for AgentOS LogRecords.
     * Default: "@framers/agentos".
     */
    otelLoggerName?: string;
  };

  metrics?: {
    /**
     * Enables AgentOS metrics (counters/histograms).
     * Default: false.
     */
    enabled?: boolean;

    /**
     * OpenTelemetry meter name used for AgentOS metrics.
     * Default: "@framers/agentos".
     */
    meterName?: string;
  };
}

export type AgentOSObservabilityState = Readonly<{
  tracingEnabled: boolean;
  tracerName: string;
  includeTraceInResponses: boolean;
  includeTraceIdsInLogs: boolean;
  metricsEnabled: boolean;
  meterName: string;
  exportOtelLogs: boolean;
  otelLoggerName: string;
}>;

function readEnv(name: string): string | undefined {
  try {
    if (typeof process === 'undefined') return undefined;
    if (!process.env) return undefined;
    const value = process.env[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return undefined;
}

function resolveState(config?: AgentOSObservabilityConfig): AgentOSObservabilityState {
  const envEnabled = parseEnvBoolean(readEnv('AGENTOS_OBSERVABILITY_ENABLED'));
  const envTracingEnabled = parseEnvBoolean(readEnv('AGENTOS_TRACING_ENABLED'));
  const envTraceInResponses = parseEnvBoolean(readEnv('AGENTOS_TRACE_IDS_IN_RESPONSES'));
  const envIncludeTraceIdsInLogs = parseEnvBoolean(readEnv('AGENTOS_LOG_TRACE_IDS'));
  const envMetricsEnabled = parseEnvBoolean(readEnv('AGENTOS_METRICS_ENABLED'));
  const envExportOtelLogs = parseEnvBoolean(readEnv('AGENTOS_OTEL_LOGS_ENABLED'));

  const tracerNameRaw = config?.tracing?.tracerName ?? readEnv('AGENTOS_OTEL_TRACER_NAME');
  const tracerName =
    typeof tracerNameRaw === 'string' && tracerNameRaw.trim() ? tracerNameRaw.trim() : '@framers/agentos';

  const meterNameRaw = config?.metrics?.meterName ?? readEnv('AGENTOS_OTEL_METER_NAME');
  const meterName =
    typeof meterNameRaw === 'string' && meterNameRaw.trim() ? meterNameRaw.trim() : '@framers/agentos';

  const otelLoggerNameRaw = config?.logging?.otelLoggerName ?? readEnv('AGENTOS_OTEL_LOGGER_NAME');
  const otelLoggerName =
    typeof otelLoggerNameRaw === 'string' && otelLoggerNameRaw.trim()
      ? otelLoggerNameRaw.trim()
      : '@framers/agentos';

  // Config wins over env. If config.enabled is explicitly false, hard-disable all.
  if (config?.enabled === false) {
    return {
      tracingEnabled: false,
      tracerName,
      includeTraceInResponses: false,
      includeTraceIdsInLogs: false,
      metricsEnabled: false,
      meterName,
      exportOtelLogs: false,
      otelLoggerName,
    };
  }

  const tracingEnabled =
    typeof config?.tracing?.enabled === 'boolean'
      ? config.tracing.enabled
      : typeof config?.enabled === 'boolean'
        ? config.enabled
        : typeof envTracingEnabled === 'boolean'
          ? envTracingEnabled
          : typeof envEnabled === 'boolean'
            ? envEnabled
            : false;

  const includeTraceIdsInLogs =
    typeof config?.logging?.includeTraceIds === 'boolean'
      ? config.logging.includeTraceIds
      : typeof config?.enabled === 'boolean'
        ? config.enabled
        : typeof envIncludeTraceIdsInLogs === 'boolean'
          ? envIncludeTraceIdsInLogs
          : typeof envEnabled === 'boolean'
            ? envEnabled
            : false;

  const includeTraceInResponses =
    typeof config?.tracing?.includeTraceInResponses === 'boolean'
      ? config.tracing.includeTraceInResponses
      : typeof envTraceInResponses === 'boolean'
        ? envTraceInResponses
        : false;

  const metricsEnabled =
    typeof config?.metrics?.enabled === 'boolean'
      ? config.metrics.enabled
      : typeof config?.enabled === 'boolean'
        ? config.enabled
        : typeof envMetricsEnabled === 'boolean'
          ? envMetricsEnabled
          : typeof envEnabled === 'boolean'
            ? envEnabled
            : false;

  const exportOtelLogs =
    typeof config?.logging?.exportToOtel === 'boolean'
      ? config.logging.exportToOtel
      : typeof envExportOtelLogs === 'boolean'
        ? envExportOtelLogs
        : false;

  return {
    tracingEnabled,
    tracerName,
    includeTraceInResponses,
    includeTraceIdsInLogs,
    metricsEnabled,
    meterName,
    exportOtelLogs,
    otelLoggerName,
  };
}

let state: AgentOSObservabilityState = resolveState(undefined);

export function configureAgentOSObservability(config?: AgentOSObservabilityConfig): AgentOSObservabilityState {
  state = resolveState(config);
  return state;
}

export function getAgentOSObservabilityState(): AgentOSObservabilityState {
  return state;
}

export function isAgentOSTracingEnabled(): boolean {
  return state.tracingEnabled;
}

export function isAgentOSMetricsEnabled(): boolean {
  return state.metricsEnabled;
}

export function shouldIncludeTraceIdsInAgentOSLogs(): boolean {
  return state.includeTraceIdsInLogs;
}

export function shouldExportAgentOSLogsToOtel(): boolean {
  return state.exportOtelLogs;
}

export function getAgentOSOtelLoggerName(): string {
  return state.otelLoggerName;
}

export function shouldIncludeTraceInAgentOSResponses(): boolean {
  return state.includeTraceInResponses;
}

function sanitizeAttributes(attributes?: Attributes): Attributes | undefined {
  if (!attributes) return undefined;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const allPrimitive = value.every(
        (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      );
      if (allPrimitive) out[key] = value;
    }
  }
  return out as Attributes;
}

type AgentOSMetricsInstruments = Readonly<{
  turns: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  turnDurationMs: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnTokensTotal: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnTokensPrompt: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnTokensCompletion: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnCostUsd: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnTokensCacheRead: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnTokensCacheCreation: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnFirstPartMs: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  turnTaskSuccessScore: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  toolResults: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  toolResultDurationMs: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
}>;

let instruments: AgentOSMetricsInstruments | null = null;
let instrumentsMeterName: string | null = null;

function getMetricInstruments(): AgentOSMetricsInstruments | null {
  if (!state.metricsEnabled) return null;

  if (instruments && instrumentsMeterName === state.meterName) return instruments;

  const meter = metrics.getMeter(state.meterName);
  instruments = {
    turns: meter.createCounter('agentos.turns', {
      description: 'Number of AgentOS turns completed.',
      unit: '1',
    }),
    turnDurationMs: meter.createHistogram('agentos.turn.duration_ms', {
      description: 'AgentOS turn duration.',
      unit: 'ms',
    }),
    turnTokensTotal: meter.createHistogram('agentos.turn.tokens.total', {
      description: 'Total tokens used per turn.',
      unit: '1',
    }),
    turnTokensPrompt: meter.createHistogram('agentos.turn.tokens.prompt', {
      description: 'Prompt/input tokens used per turn.',
      unit: '1',
    }),
    turnTokensCompletion: meter.createHistogram('agentos.turn.tokens.completion', {
      description: 'Completion/output tokens used per turn.',
      unit: '1',
    }),
    turnTokensCacheRead: meter.createHistogram('agentos.turn.tokens.cache_read', {
      description: 'Cache-read input tokens per turn.',
      unit: '1',
    }),
    turnTokensCacheCreation: meter.createHistogram('agentos.turn.tokens.cache_creation', {
      description: 'Cache-creation input tokens per turn.',
      unit: '1',
    }),
    turnFirstPartMs: meter.createHistogram('agentos.turn.first_part_ms', {
      description: 'AgentOS-surface first-part latency: surface entry to the first StreamPart (streaming surfaces only; NOT the provider-boundary time-to-first-chunk).',
      unit: 'ms',
    }),
    turnCostUsd: meter.createHistogram('agentos.turn.cost.usd', {
      description: 'Total cost (USD) per turn (when available).',
      unit: 'USD',
    }),
    turnTaskSuccessScore: meter.createHistogram('agentos.turn.task_success_score', {
      description:
        'Heuristic or caller-provided task outcome score in [0, 1] for each turn.',
      unit: '1',
    }),
    toolResults: meter.createCounter('agentos.tool_results', {
      description: 'Number of tool-result handoffs processed by AgentOS.',
      unit: '1',
    }),
    toolResultDurationMs: meter.createHistogram('agentos.tool_result.duration_ms', {
      description: 'AgentOS tool-result processing duration.',
      unit: 'ms',
    }),
  };
  instrumentsMeterName = state.meterName;
  return instruments;
}

export type AgentOSTurnMetricInput = Readonly<{
  durationMs: number;
  status: 'ok' | 'error';
  personaId?: string;
  taskOutcomeStatus?: 'success' | 'partial' | 'failed';
  taskOutcomeScore?: number;
  /**
   * AgentOS-surface first-part latency in ms (surface entry to the first
   * StreamPart, text or tool-call alike). Streaming surfaces only.
   */
  ttfbMs?: number;
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalCostUSD?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}>;

export function recordAgentOSTurnMetrics(input: AgentOSTurnMetricInput): void {
  const inst = getMetricInstruments();
  if (!inst) return;

  const baseAttributes = sanitizeAttributes({
    status: input.status,
    persona_id: input.personaId ?? '',
    task_outcome: input.taskOutcomeStatus ?? '',
  });

  try {
    inst.turns.add(1, baseAttributes);
  } catch {
    // ignore
  }
  try {
    inst.turnDurationMs.record(Math.max(0, input.durationMs), baseAttributes);
  } catch {
    // ignore
  }
  try {
    if (typeof input.taskOutcomeScore === 'number' && Number.isFinite(input.taskOutcomeScore)) {
      const normalized = Math.max(0, Math.min(1, input.taskOutcomeScore));
      inst.turnTaskSuccessScore.record(normalized, baseAttributes);
    }
  } catch {
    // ignore
  }
  try {
    if (typeof input.ttfbMs === 'number' && Number.isFinite(input.ttfbMs)) {
      inst.turnFirstPartMs.record(Math.max(0, input.ttfbMs), baseAttributes);
    }
  } catch {
    // ignore
  }

  const usage = input.usage;
  if (!usage) return;

  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined;
  const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : undefined;
  const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : undefined;
  const totalCostUSD = typeof usage.totalCostUSD === 'number' ? usage.totalCostUSD : undefined;

  try {
    if (typeof totalTokens === 'number') inst.turnTokensTotal.record(Math.max(0, totalTokens), baseAttributes);
  } catch {
    // ignore
  }
  try {
    if (typeof promptTokens === 'number') inst.turnTokensPrompt.record(Math.max(0, promptTokens), baseAttributes);
  } catch {
    // ignore
  }
  try {
    if (typeof completionTokens === 'number')
      inst.turnTokensCompletion.record(Math.max(0, completionTokens), baseAttributes);
  } catch {
    // ignore
  }
  try {
    if (typeof totalCostUSD === 'number') inst.turnCostUsd.record(Math.max(0, totalCostUSD), baseAttributes);
  } catch {
    // ignore
  }
  try {
    if (typeof usage.cacheReadTokens === 'number')
      inst.turnTokensCacheRead.record(Math.max(0, usage.cacheReadTokens), baseAttributes);
  } catch {
    // ignore
  }
  try {
    if (typeof usage.cacheCreationTokens === 'number')
      inst.turnTokensCacheCreation.record(Math.max(0, usage.cacheCreationTokens), baseAttributes);
  } catch {
    // ignore
  }
}

export type AgentOSToolResultMetricInput = Readonly<{
  durationMs: number;
  status: 'ok' | 'error';
  toolName?: string;
  toolSuccess?: boolean;
}>;

export function recordAgentOSToolResultMetrics(input: AgentOSToolResultMetricInput): void {
  const inst = getMetricInstruments();
  if (!inst) return;

  const attrs = sanitizeAttributes({
    status: input.status,
    tool_name: input.toolName ?? '',
    tool_success: typeof input.toolSuccess === 'boolean' ? input.toolSuccess : undefined,
  });

  try {
    inst.toolResults.add(1, attrs);
  } catch {
    // ignore
  }
  try {
    inst.toolResultDurationMs.record(Math.max(0, input.durationMs), attrs);
  } catch {
    // ignore
  }
}

export function startAgentOSSpan(
  name: string,
  options?: { kind?: SpanKind; attributes?: Attributes },
): Span | null {
  if (!state.tracingEnabled) return null;
  const tracer = trace.getTracer(state.tracerName);
  const span = tracer.startSpan(name, {
    kind: options?.kind,
    attributes: sanitizeAttributes(options?.attributes),
  });
  return span;
}

export function runWithSpanContext<T>(span: Span, fn: () => Promise<T>): Promise<T> {
  return context.with(trace.setSpan(context.active(), span), fn);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function withAgentOSSpan<T>(
  name: string,
  fn: (span: Span | null) => Promise<T>,
  options?: { kind?: SpanKind; attributes?: Attributes },
): Promise<T> {
  const span = startAgentOSSpan(name, options);
  if (!span) {
    return fn(null);
  }

  return runWithSpanContext(span, async () => {
    try {
      return await fn(span);
    } catch (error) {
      try {
        span.recordException(error as any);
      } catch {
        // ignore
      }
      try {
        span.setStatus({ code: SpanStatusCode.ERROR, message: getErrorMessage(error) });
      } catch {
        // ignore
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export function recordExceptionOnActiveSpan(error: unknown, message?: string): void {
  const span = trace.getSpan(context.active());
  if (!span) return;
  try {
    span.recordException(error as any);
  } catch {
    // ignore
  }
  try {
    span.setStatus({ code: SpanStatusCode.ERROR, message: message ?? getErrorMessage(error) });
  } catch {
    // ignore
  }
}

export function getActiveSpanContext(): SpanContext | null {
  const span = trace.getSpan(context.active());
  if (!span) return null;
  try {
    return span.spanContext();
  } catch {
    return null;
  }
}

export type ActiveTraceMetadata = Readonly<{
  traceId: string;
  spanId: string;
  traceparent: string;
}>;

export function getActiveTraceMetadata(): ActiveTraceMetadata | null {
  const spanContext = getActiveSpanContext();
  if (!spanContext) return null;
  const flags = Number(spanContext.traceFlags ?? 0).toString(16).padStart(2, '0');
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
  };
}
