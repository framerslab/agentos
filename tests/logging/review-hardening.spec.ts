/**
 * @file review-hardening.spec.ts
 * @description An error's class name and constant code survive onto a line while a credential shape still does not,
 * reading an error never throws, every provider the manager starts is named, a kit refuses a product map that
 * redeclares one of AgentOS's events with other fields, console capture prints only bounded stack frames, and an event
 * handle refuses an event AgentOS does not declare.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { createAllowListLogger, captureConsole } from '../../src/core/logging/kit/index.js';
import { AGENTOS_EVENTS, errorFields, providerName } from '../../src/core/logging/events.js';
import { lazyLogger, resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory.js';
import { LogValidationError } from '../../src/core/logging/forward.js';

/** An error whose name is set as AgentOS's provider errors set theirs. */
function named(name: string, code?: unknown): Error {
  const error = new Error('private-words-5520');
  error.name = name;
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); vi.restoreAllMocks(); });

describe('error fields', () => {
  it('keeps a class name and a constant code of 20 characters or more', () => {
    expect(errorFields(named('OpenRouterProviderError', 'STREAM_PARSING_ERROR'))).toEqual({ type: 'OpenRouterProviderError', code: 'STREAM_PARSING_ERROR' });
    expect(errorFields(named('ContextWindowExceededError', 'CONTEXT_WINDOW_EXCEEDED'))).toEqual({ type: 'ContextWindowExceededError', code: 'CONTEXT_WINDOW_EXCEEDED' });
    expect(errorFields(named('AnthropicProviderError', 'ECONNRESET'))).toEqual({ type: 'AnthropicProviderError', code: 'ECONNRESET' });
  });

  it('still writes a credential shape as unknown', () => {
    for (const value of ['sk_fixture_not_a_key_value', 'abcdef0123456789abcdef0123', 'ABCDEFGHIJKLMNOPQRSTUV', 'eyJhbGciOiJIUzI1NiJ9.e30.signature', 'SK_FIXTURE_NOT_A_KEY']) {
      expect(errorFields(named(value, value)), value).toEqual({ type: 'unknown', code: 'unknown' });
    }
  });

  it('never throws on an error whose properties throw when read', () => {
    const hostile = new Error('private-words-5520');
    for (const key of ['name', 'code', 'message', 'stack']) {
      Object.defineProperty(hostile, key, { get() { throw new Error('private-words-5520'); } });
    }
    expect(errorFields(hostile)).toEqual({ type: 'unknown', code: 'unknown' });
    const proxy = new Proxy({}, { get() { throw new Error('private-words-5520'); }, getPrototypeOf() { throw new Error('private-words-5520'); } });
    expect(errorFields(proxy)).toEqual({ type: 'unknown', code: 'unknown' });
  });
});

describe('provider names', () => {
  it('names every provider the manager starts', () => {
    for (const provider of ['openai', 'openrouter', 'anthropic', 'gemini', 'ollama', 'requesty', 'groq', 'mistral', 'together', 'xai', 'litellm', 'minimax', 'claude-code-cli', 'gemini-cli']) {
      expect(providerName(provider)).toBe(provider);
    }
    expect(providerName('private-words-5520')).toBe('unknown');
  });
});

describe('the kit', () => {
  function make(events: Record<string, Record<string, unknown>>) {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino({ base: undefined, level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } });
    const kit = createAllowListLogger({ logger, events: events as never });
    cleanup.push(() => kit.close());
    return { kit, lines };
  }

  it('refuses a product map that redeclares an AgentOS event with other fields, and takes the same declaration', () => {
    expect(() => make({ 'llm.retry': { attempt: 'word' } })).toThrow(TypeError);
    expect(() => make({ 'http.request': {} })).toThrow(TypeError);
    expect(() => make({ ...AGENTOS_EVENTS, 'job.done': { ms: 'int' } })).not.toThrow();
    expect(() => make({ 'llm.retry': { waitMs: 'int', attempt: 'int', status: 'int', provider: AGENTOS_EVENTS['llm.retry'].provider } })).not.toThrow();
  });

  it('prints only frame lines of a stack, bounded, and none a forged or controlled line', () => {
    const { kit } = make({});
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
    const restore = captureConsole(kit); cleanup.push(restore);
    const forged = new Error('x');
    forged.stack = 'Error: x\nprivate-words-5520\n    at real (/srv/query.ts:2:3)\n    at \u001b[31mcolored (/srv/a.ts:1:1)\n    at next (/srv/b.ts:4:5)';
    console.error(forged);
    expect(stderr.join('')).toBe('    at real (/srv/query.ts:2:3)\n    at next (/srv/b.ts:4:5)\n');
    stderr.length = 0;
    const deep = new Error('y');
    deep.stack = `Error: y\n${Array.from({ length: 80 }, (_, i) => `    at f${i} (/srv/c.ts:${i}:1)`).join('\n')}`;
    console.error(deep);
    expect(stderr.join('').trimEnd().split('\n')).toHaveLength(50);
    stderr.length = 0;
    const long = new Error('z');
    long.stack = `Error: z\n    at ${'a'.repeat(600)} (/srv/d.ts:1:1)`;
    console.error(long);
    expect(stderr.join('')).toBe('');
  });

  it('keeps a console call from throwing when its error throws on read', () => {
    const { kit, lines } = make({});
    const restore = captureConsole(kit); cleanup.push(restore);
    const hostile = new Error('private-words-5520');
    for (const key of ['name', 'code', 'message', 'stack']) {
      Object.defineProperty(hostile, key, { get() { throw new Error('private-words-5520'); } });
    }
    expect(() => console.warn(hostile)).not.toThrow();
    expect(lines.at(-1)).toMatchObject({ event: 'console_line', method: 'warn', type: 'unknown', code: 'unknown' });
    expect(JSON.stringify(lines).includes('private-words-5520')).toBe(false);
  });
});

describe('a kit with its own context keys', () => {
  it('takes AgentOS lines with their component and request id beside the host keys', () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino({ base: undefined, level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } });
    const kit = createAllowListLogger({ logger, events: {}, context: { tenant: 'word' } as const });
    cleanup.push(() => kit.close());
    setLogger(kit.asLogger());
    cleanup.push(() => resetLoggerFactory());
    lazyLogger('fixture').child({ requestId: 'abc-1' }).info('llm.models_refresh', { provider: 'openai' });
    expect(lines.at(-1)).toMatchObject({ event: 'llm.models_refresh', component: 'fixture', requestId: 'abc-1', provider: 'openai' });
    kit.child({ tenant: 'acme', component: 'jobs' }).info('llm.models_empty', { provider: 'openai' });
    expect(lines.at(-1)).toMatchObject({ event: 'llm.models_empty', component: 'jobs', tenant: 'acme', provider: 'openai' });
  });

  it('refuses a context map that gives an AgentOS key another kind, and takes the same kind', () => {
    const logger = pino({ base: undefined, level: 'debug' }, { write: () => undefined });
    expect(() => createAllowListLogger({ logger, events: {}, context: { component: { enum: ['jobs'] } } as const })).toThrow(TypeError);
    const same = createAllowListLogger({ logger, events: {}, context: { component: 'word' } as const });
    same.close();
  });

  it.each(['event', 'level', 'time'])("refuses a context map that declares %s, a key every line carries of its own", (key) => {
    const logger = pino({ base: undefined, level: 'debug' }, { write: () => undefined });
    // Bound on a child, such a key would be written beside pino's own and overwrite the line's severity or time.
    expect(() => createAllowListLogger({ logger, events: {}, context: { [key]: 'int' as const } })).toThrow(TypeError);
  });
});

describe('event handles', () => {
  it('write the fields errorFields gives for a long class name and constant code, as a failover line does', () => {
    const lines: Array<Record<string, unknown>> = [];
    setLogger(pino({ base: undefined, level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } }));
    cleanup.push(() => resetLoggerFactory());
    lazyLogger('fixture').warn('llm.fallback_fired', { api: 'generateText', primaryProvider: 'openrouter', fallbackProvider: 'openai', attempt: 1, ...errorFields(named('OpenRouterProviderError', 'STREAM_PARSING_ERROR')) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'llm.fallback_fired', type: 'OpenRouterProviderError', code: 'STREAM_PARSING_ERROR' });
  });

  it('refuse a long value in a type or code field that is not a class name or a constant code', () => {
    setLogger(pino({ base: undefined, level: 'debug' }, { write: () => undefined }));
    cleanup.push(() => resetLoggerFactory());
    const handle = lazyLogger('fixture');
    for (const fields of [{ type: 'abcdef0123456789abcdef0123' }, { code: 'abcdef0123456789abcdef0123' }, { type: 'STREAM_PARSING_ERROR_CODES', code: 'OpenRouterProviderError' }, { code: 'SK_FIXTURE_NOT_A_KEY' }, { type: 'SkBearerTokenExceptionError' }]) {
      expect(() => handle.warn('llm.stream_failed', { provider: 'openai', ...fields }), JSON.stringify(fields)).toThrow(LogValidationError);
    }
  });

  it('refuse an event AgentOS does not declare, as a JavaScript caller could write one', () => {
    const lines: Array<Record<string, unknown>> = [];
    setLogger(pino({ base: undefined, level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } }));
    cleanup.push(() => resetLoggerFactory());
    const handle = lazyLogger('fixture') as unknown as { info(event: string, fields: Record<string, unknown>): void };
    expect(() => handle.info('pack.custom', { text: 'private-words-5520' })).toThrow(LogValidationError);
    expect(lines).toEqual([]);
    vi.stubEnv('NODE_ENV', 'production');
    cleanup.push(() => vi.unstubAllEnvs());
    handle.info('pack.custom', { text: 'private-words-5520' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'log_refused', reason: 'unknown_event', level: 40 });
    expect(lines[0]).not.toHaveProperty('name');
    expect(JSON.stringify(lines).includes('private-words-5520')).toBe(false);
  });
});
