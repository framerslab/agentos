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
 * An {@link ILogger} over pino, writing JSON lines, with trace ids and an OpenTelemetry mirror
 * when observability turns them on. A logger built without a pino instance takes its level
 * from the environment (`AGENTOS_LOG_LEVEL`, `AGENTOS_DEBUG=1`) unless `options.level` sets one.
 */
export class PinoLogger implements ILogger {
  private readonly base: Logger;

  constructor(options?: LoggerOptions, existing?: Logger) {
    this.base = existing ?? pino({ level: parseLogLevel(process.env).level, ...options });
  }

  info(message: string, meta?: Record<string, any>): void {
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.info(metaWithTrace, message);
    maybeEmitOtelLog('info', message, metaWithTrace, this.base.bindings());
  }

  warn(message: string, meta?: Record<string, any>): void {
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.warn(metaWithTrace, message);
    maybeEmitOtelLog('warn', message, metaWithTrace, this.base.bindings());
  }

  error(message: string, meta?: Record<string, any>): void {
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.error(metaWithTrace, message);
    maybeEmitOtelLog('error', message, metaWithTrace, this.base.bindings());
  }

  debug(message: string, meta?: Record<string, any>): void {
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.debug(metaWithTrace, message);
    maybeEmitOtelLog('debug', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes the process's last line. pino flushes its destination synchronously at `fatal`
   * when the destination supports it.
   *
   * @param message - The line's message.
   * @param meta - Fields for the line.
   */
  fatal(message: string, meta?: Record<string, any>): void {
    const metaWithTrace = maybeAttachTraceMeta(meta);
    this.base.fatal(metaWithTrace, message);
    maybeEmitOtelLog('fatal', message, metaWithTrace, this.base.bindings());
  }

  /**
   * Writes one event object first, with no message: `{ ...fields, event }`, plus trace ids
   * when they are on. The OpenTelemetry mirror, when it is on, takes the event's name as the
   * record's body.
   *
   * @param level - The line's level.
   * @param event - The event's name.
   * @param fields - The event's fields and context.
   */
  writeEvent(level: Level, event: string, fields: Record<string, unknown>): void {
    const meta = maybeAttachTraceMeta({ ...fields, event });
    this.base[level](meta);
    maybeEmitOtelLog(level, event, meta, this.base.bindings());
  }

  child(bindings: Record<string, any>): ILogger {
    return new PinoLogger(undefined, this.base.child(bindings));
  }
}
