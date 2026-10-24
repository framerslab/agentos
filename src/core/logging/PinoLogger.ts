import pino, { Logger, LoggerOptions } from 'pino';
import { ILogger } from './ILogger';
import { parseLogLevel } from './level.js';
import type { Level } from './Logger.js';
import { context } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  getActiveTraceMetadata,
  getAgentOSOtelLoggerName,
  shouldExportAgentOSLogsToOtel,
  shouldIncludeTraceIdsInAgentOSLogs,
} from '../../safety/evaluation/observability/otel.js';
import { emitContentSafeLog, isContentSafeTelemetryEnabled } from './contentSafeTelemetry.js';

function maybeAttachTraceMeta(meta?: Record<string, any>): Record<string, any> {
  if (!shouldIncludeTraceIdsInAgentOSLogs()) return meta ?? {};
  const traceMeta = getActiveTraceMetadata();
  if (!traceMeta) return meta ?? {};
  return { ...(meta ?? {}), trace_id: traceMeta.traceId, span_id: traceMeta.spanId };
}

function sanitizeAttributes(attributes?: Record<string, any>): Record<string, any> | undefined {
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
  return Object.keys(out).length > 0 ? out : undefined;
}

function severityForLevel(level: Level): {
  severityNumber: SeverityNumber;
  severityText: string;
} {
  if (level === 'debug') return { severityNumber: SeverityNumber.DEBUG, severityText: 'DEBUG' };
  if (level === 'info') return { severityNumber: SeverityNumber.INFO, severityText: 'INFO' };
  if (level === 'warn') return { severityNumber: SeverityNumber.WARN, severityText: 'WARN' };
  if (level === 'fatal') return { severityNumber: SeverityNumber.FATAL, severityText: 'FATAL' };
  return { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' };
}

function pickError(meta?: Record<string, any>): Error | null {
  if (!meta) return null;
  const err = meta.err instanceof Error ? (meta.err as Error) : null;
  if (err) return err;
  const error = meta.error instanceof Error ? (meta.error as Error) : null;
  if (error) return error;
  return null;
}

function maybeEmitOtelLog(
  level: Level,
  message: string,
  meta?: Record<string, any>,
  bindings?: Record<string, any>,
): void {
  if (!shouldExportAgentOSLogsToOtel()) return;

  const { severityNumber, severityText } = severityForLevel(level);
  const err = pickError(meta);

  const attributes: Record<string, any> = {
    ...(bindings ?? {}),
    ...(meta ?? {}),
  };

  if (err) {
    attributes['exception.type'] = err.name;
    attributes['exception.message'] = err.message;
    attributes['exception.stacktrace'] = err.stack;
  }

  try {
    const loggerName = getAgentOSOtelLoggerName();
    logs.getLogger(loggerName).emit({
      timestamp: Date.now(),
      severityNumber,
      severityText,
      body: message,
      attributes: sanitizeAttributes(attributes),
      context: context.active(),
    });
  } catch {
    // never throw from logging paths
  }
}

/**
 * An {@link ILogger} on pino: structured JSON records, trace ids in their fields when configured, and an optional
 * OpenTelemetry copy of each record. A logger built without a pino instance takes its level from the environment
 * (`AGENTOS_LOG_LEVEL`, `AGENTOS_DEBUG=1`) unless `options.level` sets one. While content-safe telemetry is on
 * (`enableContentSafeTelemetry`), each record, `fatal` lines and events included, becomes one fixed event for the
 * host's sink instead and nothing of it is read, and `child` returns the same logger.
 */
export class PinoLogger implements ILogger {
  private readonly base: Logger;

  /**
   * @param options - pino options for a new logger; ignored when `existing` is given.
   * @param existing - A pino logger to wrap instead of creating one.
   */
  constructor(options?: LoggerOptions, existing?: Logger) {
    this.base = existing ?? pino({ level: parseLogLevel(process.env).level, ...options });
  }

  /**
   * Writes an info record, or passes one fixed event to the content-safe sink while that mode is on.
   *
   * @param message - The record's message.
   * @param meta - Fields of the record.
   */
  info(message: string, meta?: Record<string, any>): void {
    if (emitContentSafeLog('info')) return;
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.info(metaWithTrace, message);
    maybeEmitOtelLog('info', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes a warn record, or passes one fixed event to the content-safe sink while that mode is on.
   *
   * @param message - The record's message.
   * @param meta - Fields of the record.
   */
  warn(message: string, meta?: Record<string, any>): void {
    if (emitContentSafeLog('warn')) return;
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.warn(metaWithTrace, message);
    maybeEmitOtelLog('warn', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes an error record, or passes one fixed event to the content-safe sink while that mode is on.
   *
   * @param message - The record's message.
   * @param meta - Fields of the record; an `err` or `error` field holding an Error also fills the OpenTelemetry
   *   record's exception attributes.
   */
  error(message: string, meta?: Record<string, any>): void {
    if (emitContentSafeLog('error')) return;
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.error(metaWithTrace, message);
    maybeEmitOtelLog('error', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes a debug record, or passes one fixed event to the content-safe sink while that mode is on.
   *
   * @param message - The record's message.
   * @param meta - Fields of the record.
   */
  debug(message: string, meta?: Record<string, any>): void {
    if (emitContentSafeLog('debug')) return;
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.debug(metaWithTrace, message);
    maybeEmitOtelLog('debug', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes the process's last line, or passes one fixed event at `error` to the content-safe sink while that mode is
   * on. pino flushes its destination synchronously at `fatal` when the destination supports it.
   *
   * @param message - The line's message.
   * @param meta - Fields for the line.
   */
  fatal(message: string, meta?: Record<string, any>): void {
    if (emitContentSafeLog('error')) return;
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.fatal(metaWithTrace, message);
    maybeEmitOtelLog('fatal', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes one event object first, with no message: `{ ...fields, event }`, plus trace ids
   * when they are on. The OpenTelemetry mirror, when it is on, takes the event's name as the
   * record's body. While content-safe telemetry is on, it passes one fixed event to the sink
   * instead (a `fatal` line at `error`) and reads nothing of the event.
   *
   * @param level - The line's level.
   * @param event - The event's name.
   * @param fields - The event's fields and context.
   */
  writeEvent(level: Level, event: string, fields: Record<string, unknown>): void {
    if (emitContentSafeLog(level === 'fatal' ? 'error' : level)) return;
    const meta = maybeAttachTraceMeta({ ...fields, event });
    this.base[level](meta);
    maybeEmitOtelLog(level, event, meta, this.base.bindings());
  }

  /**
   * A logger whose records also carry `bindings`. While content-safe telemetry is on, this returns the same logger
   * and does not read `bindings`.
   *
   * @param bindings - Fields every record of the child carries.
   * @returns The child logger.
   */
  child(bindings: Record<string, any>): ILogger {
    if (isContentSafeTelemetryEnabled()) return this;
    return new PinoLogger(undefined, this.base.child(bindings));
  }
}
