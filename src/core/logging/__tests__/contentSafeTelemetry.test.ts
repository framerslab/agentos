import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { ILogger } from '../ILogger.js';
import { PinoLogger } from '../PinoLogger.js';
import { createLogger, setLoggerFactory, resetLoggerFactory } from '../loggerFactory.js';
import {
  enableContentSafeTelemetry, isContentSafeTelemetryEnabled,
  type ContentSafeLogEvent,
} from '../contentSafeTelemetry.js';
import { contentSafeConsole } from '../contentSafeConsole.js';
import {
  configureAgentOSObservability, startAgentOSSpan, withAgentOSSpan,
  recordExceptionOnActiveSpan, getActiveTraceMetadata, recordAgentOSTurnMetrics,
  shouldExportAgentOSLogsToOtel, shouldIncludeTraceIdsInAgentOSLogs,
  isAgentOSTracingEnabled, isAgentOSMetricsEnabled, shouldIncludeTraceInAgentOSResponses,
} from '../../../safety/evaluation/observability/otel.js';
import { fireLlmUsageObserver, setGlobalLlmObserver } from '../../../api/observers.js';

const otel = vi.hoisted(() => ({
  tracer: vi.fn(), active: vi.fn(), meter: vi.fn(), log: vi.fn(),
}));
vi.mock('@opentelemetry/api', async (original) => {
  const api = await original<typeof import('@opentelemetry/api')>();
  return {
    ...api,
    trace: { ...api.trace, getTracer: otel.tracer, getSpan: otel.active },
    metrics: { ...api.metrics, getMeter: otel.meter },
  };
});
vi.mock('@opentelemetry/api-logs', async (original) => {
  const api = await original<typeof import('@opentelemetry/api-logs')>();
  return { ...api, logs: { ...api.logs, getLogger: otel.log } };
});

afterEach(() => { vi.restoreAllMocks(); });

describe('content-safe server telemetry', () => {
  it('intercepts existing and new loggers without reading their data or exporting traces', async () => {
    const raw = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn(), bindings: vi.fn(),
    };
    raw.child.mockReturnValue(raw);
    const logger = new PinoLogger(undefined, raw as unknown as Logger);
    const before = logger.child({ secret: 'fixture-secret-binding' });
    const custom: ILogger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
    };
    setLoggerFactory(() => custom);
    const factoryLogger = createLogger('fixture-secret-component');
    const native = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = native.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const output: ContentSafeLogEvent[] = [];
    const sink = (event: ContentSafeLogEvent) => { output.push(event); };
    expect(isContentSafeTelemetryEnabled()).toBe(false);
    enableContentSafeTelemetry(sink);
    enableContentSafeTelemetry(sink);
    expect(isContentSafeTelemetryEnabled()).toBe(true);
    expect(() => enableContentSafeTelemetry(() => {})).toThrow('content_safe_sink_already_set');
    const hostile = Object.defineProperty({}, 'err', {
      enumerable: true, get: () => { throw new Error('fixture-secret-getter'); },
    });
    raw.child.mockClear();
    before.error('fixture-secret-message', hostile);
    logger.child(hostile).warn('fixture-secret-child', hostile);
    factoryLogger.info('fixture-secret-factory', hostile);
    factoryLogger.child?.(hostile).error('fixture-secret-nested', hostile);
    resetLoggerFactory();
    createLogger('fixture-secret-new', hostile).debug?.('fixture-secret-debug', hostile);
    for (const level of native) contentSafeConsole[level]('fixture-secret-console', hostile);
    expect(output.length).toBe(10);
    for (const event of output) {
      expect(Object.keys(event).sort()).toEqual(['kind', 'n', 'state']);
      expect(event.kind).toBe('library_event');
      expect(event.n).toBe(1);
      expect(Object.isFrozen(event)).toBe(true);
    }
    expect(JSON.stringify(output)).not.toContain('fixture-secret');
    expect(raw.child).not.toHaveBeenCalled();
    expect(raw.bindings).not.toHaveBeenCalled();
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      expect(raw[level]).not.toHaveBeenCalled();
      expect(custom[level]).not.toHaveBeenCalled();
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Every setting asks for its signal, and every guard still answers no.
    expect(configureAgentOSObservability({
      enabled: true, tracing: { enabled: true, includeTraceInResponses: true },
      logging: { includeTraceIds: true, exportToOtel: true }, metrics: { enabled: true },
    })).toMatchObject({
      tracingEnabled: true, includeTraceInResponses: true, includeTraceIdsInLogs: true,
      exportOtelLogs: true, metricsEnabled: true,
    });
    expect(shouldExportAgentOSLogsToOtel()).toBe(false);
    expect(shouldIncludeTraceIdsInAgentOSLogs()).toBe(false);
    expect(isAgentOSTracingEnabled()).toBe(false);
    expect(isAgentOSMetricsEnabled()).toBe(false);
    expect(shouldIncludeTraceInAgentOSResponses()).toBe(false);
    expect(startAgentOSSpan('fixture-secret-span')).toBeNull();
    expect(getActiveTraceMetadata()).toBeNull();
    const error = new Error('fixture-secret-exception');
    await expect(withAgentOSSpan('fixture-secret-span', async (span) => {
      expect(span).toBeNull(); throw error;
    })).rejects.toBe(error);
    recordExceptionOnActiveSpan(error, 'fixture-secret-status');
    recordAgentOSTurnMetrics({ durationMs: 1, status: 'error', personaId: 'fixture-secret-id' });
    const observer = vi.fn();
    setGlobalLlmObserver(observer);
    fireLlmUsageObserver({
      provider: 'fixture-secret-provider', model: 'fixture-secret-model', surface: 'generateText',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    expect(observer).not.toHaveBeenCalled();
    for (const fn of Object.values(otel)) expect(fn).not.toHaveBeenCalled();
  });
});
