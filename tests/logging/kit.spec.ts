/**
 * @file kit.spec.ts
 * @description The allow-list kit: credential-shaped and oversized words are refused, a refusal line carries a fixed
 * reason and never the key or the value, an undeclared event through the adapter becomes `agentos.untyped` with no
 * text, one burst budget is shared by every kit, child, adapter and lazy handle in the process, `terminal()` writes
 * while the budget is spent, console text is reduced to its method with an error's frames on standard error, and the
 * process handlers install once and come off cleanly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createAllowListLogger, captureConsole, installProcessHandlers } from '../../src/core/logging/kit/index.js';
import { AGENTOS_CONTEXT, AGENTOS_EVENTS } from '../../src/core/logging/events.js';
import { LogValidationError } from '../../src/core/logging/forward.js';
import { lazyLogger, setLogger, setLoggerFactory, resetLoggerFactory } from '../../src/core/logging/loggerFactory.js';

const cleanup: Array<() => void> = [];
function make(burst = 30) {
  const lines: Array<Record<string, any>> = [];
  const logger = pino({ base: undefined, level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } });
  const kit = createAllowListLogger({ logger, events: { ...AGENTOS_EVENTS, 'sample.word': { value: 'word' }, 'sample.path': { value: 'path' } } as const, context: AGENTOS_CONTEXT, burst });
  cleanup.push(() => kit.close());
  return { kit, lines };
}
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); resetLoggerFactory(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the allow-list kit', () => {
  it.each(['sk-secret', 'sk_secret', 'pk_secret', 'rk_secret', 'Bearer', 'eyJhbGciOiJIUzI1NiJ9.e30.signature', 'abcdef0123456789abcdef', 'ABCDEFGHIJKLMNOPQRSTUV', 'a'.repeat(65)])('refuses credential or oversized word %s', value => {
    const { kit } = make();
    expect(() => kit.info('sample.word', { value })).toThrow(LogValidationError);
  });
  it('writes only fixed refusal reasons in production, with names only for declared events', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { kit, lines } = make();
    (kit.info as Function)('secret event', { secretKey: 'secret value' });
    (kit.info as Function)('sample.word', { secretKey: 'secret value' });
    kit.info('sample.word', { value: 'has spaces' });
    kit.child({ requestId: 'bad id' }).info('sample.word', { value: 'safe' });
    expect(lines.map(line => line.reason)).toEqual(['unknown_event', 'unknown_key', 'bad_value', 'bad_context']);
    expect(lines[0]).not.toHaveProperty('name');
    expect(lines[1].name).toBe('sample.word');
    expect(JSON.stringify(lines)).not.toMatch(/secret|has spaces|bad id/);
    expect(lines.every(line => line.level === 40 && line.event === 'log_refused')).toBe(true);
  });
  it('treats only adapter unknown events as untyped and drops text and arbitrary fields', () => {
    const { kit, lines } = make();
    kit.asLogger().child({ component: 'legacy' }).warn({ event: 'a secret sentence', password: 'marker' });
    expect(lines[0]).toMatchObject({ event: 'agentos.untyped', component: 'legacy', level: 40, sourceLevel: 'warn' });
    expect(JSON.stringify(lines)).not.toMatch(/secret|password|marker/);
    expect(() => (kit.info as Function)('unknown', {})).toThrow(LogValidationError);
  });
  it('shares one minute across kits, children, adapters and lazy handles, then flushes an idle minute once', () => {
    vi.useFakeTimers();
    const a = make(); const b = make();
    const child = a.kit.child({ component: 'child' });
    const adapter = b.kit.asLogger();
    setLogger(adapter);
    for (let n = 0; n < 100; n++) {
      if (n % 4 === 0) child.info('llm.provider_ready', { provider: 'openai', count: n });
      else if (n % 4 === 1) b.kit.info('llm.provider_ready', { provider: 'openai', count: n });
      else if (n % 4 === 2) adapter.info({ event: 'llm.provider_ready', provider: 'openai', count: n });
      else lazyLogger('lazy').info('llm.provider_ready', { provider: 'openai', count: n });
    }
    expect([...a.lines, ...b.lines].filter(line => line.event === 'llm.provider_ready')).toHaveLength(30);
    vi.advanceTimersByTime(60_000);
    expect([...a.lines, ...b.lines].filter(line => line.event === 'log_held')).toEqual([expect.objectContaining({ name: 'llm.provider_ready', n: 70 })]);
    vi.advanceTimersByTime(120_000);
    expect([...a.lines, ...b.lines].filter(line => line.event === 'log_held')).toHaveLength(1);
    a.kit.close(); b.kit.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps a shared budget when its first owner closes', () => {
    vi.useFakeTimers(); const a = make(1); const b = make(1);
    a.kit.info('sample.word', { value: 'one' });
    b.kit.info('sample.word', { value: 'two' });
    a.kit.close();
    b.kit.info('sample.word', { value: 'three' });
    vi.advanceTimersByTime(60_000);
    expect(b.lines).toEqual([expect.objectContaining({ event: 'log_held', n: 2 })]);
  });
  it('throws validation failures through all adapters and validates merged bindings before making a child', () => {
    const { kit } = make();
    expect(() => kit.child({ requestId: 'bad id' })).toThrow(LogValidationError);
    expect(() => kit.asLogger().child({ password: 'marker' })).toThrow(LogValidationError);
    expect(() => kit.asLogger().warn({ event: 'llm.retry', secret: 'marker' })).toThrow(LogValidationError);
    setLogger(kit.asLogger());
    expect(() => lazyLogger('test').warn('llm.retry', { secret: 'marker' } as never)).toThrow(LogValidationError);
    setLoggerFactory(() => kit as never);
    expect(() => lazyLogger('test').warn('llm.retry', { secret: 'marker' } as never)).toThrow(LogValidationError);
    const child = kit.child({ component: 'parent' }).child({ component: 'child' });
    child.info('sample.word', { value: 'safe' });
  });
  it('terminal bypasses the exhausted bound and uses fatal', () => {
    const { kit, lines } = make(1);
    kit.fatal('process.uncaught', { type: 'Error', code: 'unknown' });
    kit.fatal('process.uncaught', { type: 'Error', code: 'unknown' });
    kit.terminal('process.uncaught', { type: 'Error', code: 'unknown' });
    expect(lines.filter(line => line.event === 'process.uncaught')).toHaveLength(2);
    expect(lines.every(line => line.level === 60)).toBe(true);
  });
  it('captures console text as a method and frames after the exact error message', () => {
    const { kit, lines } = make();
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
    const restore = captureConsole(kit); cleanup.push(restore);
    const error = Object.assign(new Error('query marker\n    at fake-marker (/private/marker:1:1)'), { params: ['marker'], code: '23505' });
    error.stack = `${error.name}: ${error.message}\n    at real (/srv/query.ts:2:3)`;
    console.error('marker', error);
    expect(lines[0]).toMatchObject({ event: 'console_line', method: 'error', type: 'Error', code: '23505' });
    expect(stderr.join('')).toBe('    at real (/srv/query.ts:2:3)\n');
    expect(JSON.stringify(lines)).not.toContain('marker');
    error.stack = 'an untrusted opening\n    at marker';
    console.error(error);
    expect(stderr).toHaveLength(1);
  });
  it('installs once and removes every listener', () => {
    const { kit } = make(); const before = process.listenerCount('SIGTERM');
    const options = { onShutdown: vi.fn(), onFatal: vi.fn() };
    const a = installProcessHandlers(kit, options); const b = installProcessHandlers(kit, options);
    cleanup.push(a);
    expect(a).toBe(b); expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    a(); expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('keeps only a safe incoming component on an untyped lazy line', () => {
    const { kit, lines } = make();
    kit.asLogger().warn({ event: 'legacy sentence', component: 'provider', text: 'marker' });
    expect(lines[0]).toMatchObject({ event: 'agentos.untyped', component: 'provider', sourceLevel: 'warn' });
    expect(JSON.stringify(lines)).not.toContain('marker');
  });
  it('keeps production lazy validation on the refusal path and bounds refusals across instances', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.useFakeTimers();
    const a = make(1); const b = make(1);
    setLogger(a.kit.asLogger());
    lazyLogger('test').warn('llm.retry', { secret: 'marker' } as never);
    setLogger(b.kit.asLogger());
    lazyLogger('test').warn('llm.retry', { secret: 'marker' } as never);
    expect([...a.lines, ...b.lines].filter(line => line.event === 'log_refused')).toHaveLength(1);
    expect([...a.lines, ...b.lines].some(line => line.event === 'agentos.untyped')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect([...a.lines, ...b.lines].find(line => line.event === 'log_held')).toMatchObject({ name: 'unknown_key', n: 1 });
  });
  it('refuses invalid production lazy bindings without throwing', () => {
    vi.stubEnv('NODE_ENV', 'production'); const { kit, lines } = make(); setLogger(kit.asLogger());
    expect(() => lazyLogger('test').child({ requestId: 'bad id' })).not.toThrow();
    expect(lines).toEqual([expect.objectContaining({ event: 'log_refused', reason: 'bad_context' })]);
  });
});
