/**
 * @file surface.spec.ts
 * @description The logging hand-over: `createLogger` calls the factory at once and delegates to its object, lazy handles follow
 * every setter at their next write, a sink's fault never reaches the caller while a validation fault does under
 * test, two evaluations of the module share one state, and the level comes from the environment.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createLogger, lazyLogger, resetLoggerFactory, setLogger, setLoggerFactory } from '../../src/core/logging/loggerFactory.js';
import { getLoggingState } from '../../src/core/logging/state.js';
import { LogValidationError } from '../../src/core/logging/forward.js';
import { parseLogLevel } from '../../src/core/logging/level.js';

function sink() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino({ level: 'debug', base: undefined }, {
    write(line: string) { lines.push(JSON.parse(line)); },
  });
  return { logger, lines };
}
afterEach(() => { resetLoggerFactory(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the logging hand-over', () => {
  it('calls the factory at once and keeps its object while lazy children follow every setter', () => {
    const first = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const factory = vi.fn(() => first);
    setLoggerFactory(factory);
    const old = createLogger('old', { arbitrary: 1 });
    expect(factory).toHaveBeenCalledExactlyOnceWith('old', { arbitrary: 1 });
    // A guard for content-safe telemetry wraps the factory's object; its calls reach that object.
    old.warn('legacy warning');
    expect(first.warn).toHaveBeenCalledExactlyOnceWith('legacy warning');
    const handle = lazyLogger('test').child({ component: 'child' });
    const next = sink();
    setLogger(next.logger);
    handle.info('llm.provider_ready', { provider: 'openai', count: 1 });
    old.info('legacy sentence');
    expect(first.info).toHaveBeenCalledWith('legacy sentence');
    expect(next.lines[0]).toMatchObject({ event: 'llm.provider_ready', component: 'child' });
    expect(next.lines[0]).not.toHaveProperty('msg');
    setLogger(null);
    handle.info('llm.provider_ready', { provider: 'openai', count: 1 });
    expect(next.lines).toHaveLength(1);
    setLoggerFactory(factory);
    handle.fatal('process.uncaught', { type: 'Error', code: 'unknown' });
    handle.debug('llm.provider_ready', { provider: 'openai', count: 1 });
    expect(first.error).toHaveBeenCalledWith('process.uncaught', { type: 'Error', code: 'unknown' });
    resetLoggerFactory();
    expect(getLoggingState().target.mode).toBe('default');
    expect(getLoggingState().root).toBeUndefined();
  });
  it('validates all required pino methods at the setter', () => {
    for (const method of ['debug', 'info', 'warn', 'error', 'fatal', 'child']) {
      const candidate = {
        debug() {}, info() {}, warn() {}, error() {}, fatal() {},
        child() { return this; },
        [method]: undefined,
      };
      expect(() => setLogger(candidate as never)).toThrow(TypeError);
      expect(() => setLogger(candidate as never)).toThrow(method);
    }
  });
  it('swallows sink faults but preserves validation faults through lazy and factory dispatch', () => {
    const logger = sink().logger;
    logger.warn = (() => { throw new Error('broken sink'); }) as typeof logger.warn;
    setLogger(logger);
    expect(() => lazyLogger('test').warn('llm.retry', { provider: 'openai', status: 500, attempt: 1, waitMs: 0 })).not.toThrow();
    expect(() => lazyLogger('test').warn('llm.retry', { secret: 'marker' } as never)).toThrow(LogValidationError);
    setLoggerFactory(() => ({ info() {}, warn() { throw new LogValidationError('bad_value'); }, error() {} }));
    expect(() => lazyLogger('test').warn('llm.retry', { provider: 'openai', status: 500, attempt: 1, waitMs: 0 })).toThrow(LogValidationError);
  });
  it('shares targets across separately evaluated module graphs', async () => {
    const first = await import('../../src/core/logging/loggerFactory.js');
    const early = first.lazyLogger('copy-one');
    vi.resetModules();
    const second = await import('../../src/core/logging/loggerFactory.js');
    const out = sink();
    second.setLogger(out.logger);
    early.info('llm.provider_ready', { provider: 'openai', count: 2 });
    expect(out.lines).toHaveLength(1);
  });
  it('parses levels and reports unknown input once without echoing it', () => {
    expect(parseLogLevel({})).toEqual({ level: 'info', unknown: false });
    expect(parseLogLevel({ AGENTOS_DEBUG: '1' }).level).toBe('debug');
    expect(parseLogLevel({ AGENTOS_LOG_LEVEL: 'silent' }).level).toBe('silent');
    // The providers' start-up lines are debug events filtered at the root's level, so the root reads AGENTOS_DEBUG=true
    // and a level name in any case, as the checks those lines carried did.
    expect(parseLogLevel({ AGENTOS_DEBUG: 'true' }).level).toBe('debug');
    expect(parseLogLevel({ AGENTOS_LOG_LEVEL: 'DEBUG' })).toEqual({ level: 'debug', unknown: false });
    vi.stubEnv('AGENTOS_LOG_LEVEL', 'sk-marker');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // pino writes to process.stdout itself once its write has been replaced, so the spy receives the root's lines.
    const warnings = () => out.mock.calls.filter(([chunk]) => String(chunk).includes('"event":"logging.level_unknown"'));
    createLogger('one'); createLogger('two');
    expect(getLoggingState().levelWarned).toBe(true);
    expect(warnings()).toHaveLength(1);
    // A root built again after a reset does not repeat the line: it is written once per process.
    resetLoggerFactory(); createLogger('three');
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(out.mock.calls)).not.toContain('sk-marker');
  });
});
