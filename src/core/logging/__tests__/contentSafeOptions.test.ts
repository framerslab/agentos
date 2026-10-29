/**
 * Source filtering and immutable content-safe installation.
 *
 * @module
 */
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContentSafeLogEvent } from '../contentSafeTelemetry.js';

/** All diagnostic inputs are disposable negative controls. */
const PRIVATE = 'spoken private words person@example.invalid 203.0.113.7 sk_private_key';
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

it.each(['debug', 'info', 'warn', 'error'] as const)('filters below %s before the sink and never falls through', async (minimum) => {
  const api = await import('../contentSafeTelemetry.js');
  const levels = ['debug', 'info', 'warn', 'error'] as const;
  const output: ContentSafeLogEvent[] = [];
  const receive = (event: ContentSafeLogEvent): void => { output.push(event); };
  Reflect.apply(api.enableContentSafeTelemetry, undefined, [receive, { minLevel: minimum }]);
  for (const level of levels) {
    expect(Reflect.apply(api.emitContentSafeLog, undefined, [level, 'listen_session'])).toBe(true);
  }
  expect(output.map((event) => event.state)).toEqual(levels.slice(levels.indexOf(minimum)));
  for (const event of output) {
    expect(event).toEqual({ kind: 'library_event', state: event.state, n: 1, component: 'listen_session' });
    expect(Object.isFrozen(event)).toBe(true);
  }
  Reflect.apply(api.enableContentSafeTelemetry, undefined, [receive, { minLevel: minimum }]);
  const different = minimum === 'error' ? 'debug' : 'error';
  expect(() => Reflect.apply(api.enableContentSafeTelemetry, undefined, [receive, { minLevel: different }])).toThrow('content_safe_options_already_set');
  expect(() => api.enableContentSafeTelemetry(() => undefined)).toThrow('content_safe_sink_already_set');
  output.length = 0;
  for (const level of levels) api.emitContentSafeLog(level);
  expect(output.map((event) => event.state)).toEqual(levels.slice(levels.indexOf(minimum)));
});

it('keeps one-argument installation at debug and validates options before installing', async () => {
  const api = await import('../contentSafeTelemetry.js');
  const output: ContentSafeLogEvent[] = [];
  const receive = (event: ContentSafeLogEvent): void => { output.push(event); };
  for (const minimum of [null, false, 5, 'fatal', 'constructor', PRIVATE]) {
    expect(() => Reflect.apply(api.enableContentSafeTelemetry, undefined, [receive, { minLevel: minimum }])).toThrow('invalid_content_safe_min_level');
    expect(api.isContentSafeTelemetryEnabled()).toBe(false);
  }
  api.enableContentSafeTelemetry(receive);
  api.enableContentSafeTelemetry(receive);
  for (const level of ['debug', 'info', 'warn', 'error'] as const) api.emitContentSafeLog(level);
  expect(output.map((event) => event.state)).toEqual(['debug', 'info', 'warn', 'error']);
  expect(output.every((event) => Reflect.get(event, 'component') === 'library')).toBe(true);
});

it('keeps runtime components finite, suppresses recursion and survives a throwing sink', async () => {
  const api = await import('../contentSafeTelemetry.js');
  const output: ContentSafeLogEvent[] = [];
  api.enableContentSafeTelemetry((event) => {
    output.push(event);
    api.emitContentSafeLog('error');
    throw new Error(PRIVATE);
  });
  const getter = vi.fn(() => { throw new Error(PRIVATE); });
  const hostile = Object.defineProperty({}, 'toString', { get: getter });
  for (const component of [PRIVATE, '__proto__', null, hostile]) {
    expect(Reflect.apply(api.emitContentSafeLog, undefined, ['warn', component])).toBe(true);
  }
  expect(output).toHaveLength(4);
  expect(output.every((event) => Reflect.get(event, 'component') === 'library')).toBe(true);
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.stringify(output).includes(PRIVATE)).toBe(false);
});

it('intercepts pre-created factory and pino loggers without reading names, bindings or lazy record data', async () => {
  const api = await import('../contentSafeTelemetry.js');
  const factory = await import('../loggerFactory.js');
  const { PinoLogger } = await import('../PinoLogger.js');
  const { contentSafeConsole } = await import('../contentSafeConsole.js');
  const calls = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  factory.setLoggerFactory(() => calls);
  const before = factory.createLogger(PRIVATE);
  const raw = { ...calls, child: vi.fn(), bindings: vi.fn() };
  const pino = new PinoLogger(undefined, raw as unknown as import('pino').Logger);
  const output: ContentSafeLogEvent[] = [];
  Reflect.apply(api.enableContentSafeTelemetry, undefined, [(event: ContentSafeLogEvent) => { output.push(event); }, { minLevel: 'warn' }]);
  const getter = vi.fn(() => { throw new Error(PRIVATE); });
  const hostile = Object.defineProperty({}, 'err', { enumerable: true, get: getter });
  const native = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);
  before.info(PRIVATE, hostile);
  before.warn(PRIVATE, hostile);
  pino.debug(PRIVATE, hostile);
  pino.error(PRIVATE, hostile);
  factory.createLogger(PRIVATE, hostile).warn(PRIVATE, hostile);
  contentSafeConsole.warn(PRIVATE, hostile);
  expect(output.map((event) => [event.state, Reflect.get(event, 'component')])).toEqual([
    ['warn', 'logger_factory'], ['error', 'pino_logger'], ['warn', 'logger_factory'], ['warn', 'library_console'],
  ]);
  expect(getter).not.toHaveBeenCalled();
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  expect(raw.bindings).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
  expect(JSON.stringify(output).includes(PRIVATE)).toBe(false);
});

it('leaves the global console object and arguments unchanged while the mode is off', async () => {
  const { contentSafeConsole } = await import('../contentSafeConsole.js');
  const api = await import('../contentSafeTelemetry.js');
  const object = { text: PRIVATE };
  const native = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => undefined);
  expect(api.emitContentSafeLog('warn')).toBe(false);
  contentSafeConsole.warn(PRIVATE, object);
  expect(native.mock.calls).toEqual([[PRIVATE, object]]);
  expect(globalThis.console.warn).toBe(native);
});

it('consumes the rejection of an asynchronous sink, so a failing receiver cannot end the process', async () => {
  const api = await import('../contentSafeTelemetry.js');
  const escaped = vi.fn();
  process.on('unhandledRejection', escaped);
  try {
    const states: string[] = [];
    api.enableContentSafeTelemetry(async (event: ContentSafeLogEvent): Promise<void> => {
      states.push(event.state);
      throw new Error(PRIVATE);
    });
    expect(api.emitContentSafeLog('warn', 'listen_session')).toBe(true);
    expect(api.emitContentSafeLog('error')).toBe(true);
    // Node reports a rejection nothing handles once the microtasks of the turn have run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(states).toEqual(['warn', 'error']);
    expect(escaped).not.toHaveBeenCalled();
  } finally { process.off('unhandledRejection', escaped); }
});

/** A rejected promise from another realm, which `instanceof Promise` does not recognize here. */
const foreignRejection = (): unknown => runInNewContext('Promise.reject(new Error(text))', { text: PRIVATE });
/** A thenable that is no native promise: its then settles through the rejected native promise it wraps. */
const thenableRejection = (): unknown => {
  const wrapped = Promise.reject(new Error(PRIVATE));
  return { then: (onFulfilled?: any, onRejected?: any) => wrapped.then(onFulfilled, onRejected) };
};
/** What a sink can return besides a promise of this realm, each settling as a rejection. */
const rejections: ReadonlyArray<[string, () => unknown]> = [
  ['a promise from another realm', foreignRejection],
  ['a thenable that is no native promise', thenableRejection],
];

it.each(rejections)('consumes the rejection of %s that the sink returns', async (_kind, rejection) => {
  const api = await import('../contentSafeTelemetry.js');
  const escaped = vi.fn();
  process.on('unhandledRejection', escaped);
  try {
    const states: string[] = [];
    api.enableContentSafeTelemetry((event: ContentSafeLogEvent): unknown => { states.push(event.state); return rejection(); });
    expect(api.emitContentSafeLog('warn', 'listen_session')).toBe(true);
    expect(api.emitContentSafeLog('error')).toBe(true);
    // Node reports a rejection nothing handles once the microtasks of the turn have run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(states).toEqual(['warn', 'error']);
    expect(escaped).not.toHaveBeenCalled();
  } finally { process.off('unhandledRejection', escaped); }
});

it('refuses an installation whose minLevel getter installs another sink, and keeps that sink', async () => {
  const api = await import('../contentSafeTelemetry.js');
  const outer: ContentSafeLogEvent[] = [];
  const inner: ContentSafeLogEvent[] = [];
  const first = (event: ContentSafeLogEvent): void => { outer.push(event); };
  const second = (event: ContentSafeLogEvent): void => { inner.push(event); };
  /** Reading the option installs the second sink while the call that installs the first one runs. */
  const options = { get minLevel(): 'debug' { api.enableContentSafeTelemetry(second); return 'debug'; } };
  expect(() => api.enableContentSafeTelemetry(first, options)).toThrow('content_safe_sink_already_set');
  expect(api.emitContentSafeLog('warn', 'listen_session')).toBe(true);
  expect(outer).toEqual([]);
  expect(inner.map((event) => event.state)).toEqual(['warn']);
  api.enableContentSafeTelemetry(second);
  expect(() => api.enableContentSafeTelemetry(first)).toThrow('content_safe_sink_already_set');
});
