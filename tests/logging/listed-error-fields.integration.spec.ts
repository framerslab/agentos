/**
 * @file listed-error-fields.integration.spec.ts
 * An error whose name, code and message are a person's words reaches each line the library wrote before it had a
 * closed list of error types and codes: a server handler, a language detector, an optional soul that fails to load,
 * a captured console call and an unhandled rejection. No line keeps the words; a library error keeps its type and
 * its code, a name the library sets where it throws the error included.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pino from 'pino';
import { AgentOSServer } from '../../src/api/server/AgentOSServer.js';
import { createAgentOSConfig } from '../../src/api/server/config/ServerConfig.js';
import type { AgentOS } from '../../src/api/AgentOS.js';
import { LanguageService } from '../../src/cognition/nlp/language/LanguageService.js';
import { DeepLTranslationProvider } from '../../src/cognition/nlp/language/providers/DeepLTranslationProvider.js';
import { warnSoulLoadFailed } from '../../src/api/runtime/soulLoadWarning.js';
import { createAllowListLogger } from '../../src/core/logging/kit/allowList.js';
import { captureConsole } from '../../src/core/logging/kit/consoleCapture.js';
import { installProcessHandlers } from '../../src/core/logging/kit/processHandlers.js';
import { AGENTOS_CONTEXT, AGENTOS_EVENTS } from '../../src/core/logging/events.js';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory.js';

type Line = Record<string, unknown>;
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
/** A person's message as an error's message, name and code at once. */
const planted = (): Error => Object.assign(new Error('PERSONAL_DATA'), { name: 'MeetMeAtBakerStreetError', code: 'PERSONAL_DATA' });
const cleanup: Array<() => void> = [];

function capture(): Line[] {
  const lines: Line[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}
function clean(lines: Line[]): void {
  const text = JSON.stringify(lines).toLowerCase();
  expect(text).not.toContain('personal_data');
  expect(text).not.toContain('meetmeat');
}
async function throughServer(handler: Handler): Promise<void> {
  const server = new AgentOSServer({ skipDefaultInitialization: true } as never, createAgentOSConfig({ port: 0, host: '127.0.0.1' }));
  server.setAgentOSForTesting({
    getHttpHandlers: () => [handler], listAvailablePersonas: async () => [], processRequest: async function* () {},
    initialize: async () => undefined, shutdown: async () => undefined,
  } as unknown as AgentOS);
  await server.start();
  const { port } = server.getServer().address() as { port: number };
  try { await (await fetch(`http://127.0.0.1:${port}/hooks/x`, { method: 'POST' })).text(); } finally { await server.stop(); }
}
function kitOver(lines: Line[]) {
  const logger = pino({ base: undefined, level: 'debug' }, { write(line: string) { lines.push(JSON.parse(line)); } });
  const kit = createAllowListLogger({ logger, events: AGENTOS_EVENTS, context: AGENTOS_CONTEXT, burst: 30 });
  cleanup.push(() => kit.close());
  return kit;
}

afterEach(() => { for (const undo of cleanup.splice(0).reverse()) undo(); resetLoggerFactory(); vi.restoreAllMocks(); });

describe('older lines write a planted error as unknown', () => {
  it('(a) a server handler that throws it', async () => {
    const lines = capture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await throughServer(() => { throw planted(); });
    await vi.waitFor(() => expect(lines.filter((line) => line.event === 'http.handler_failed')).toHaveLength(1));
    expect(lines.find((line) => line.event === 'http.handler_failed')).toMatchObject({ type: 'unknown', code: 'unknown' });
    clean(lines);
  });

  it('(b) a language detector that throws it', async () => {
    const lines = capture();
    const service = new LanguageService({ autoDetect: true, defaultLanguage: 'en' } as never);
    await service.initialize();
    (service as unknown as { detectionProviders: unknown[] }).detectionProviders.push({ id: 'fixture', isInitialized: true, initialize: async () => undefined, detect: async () => { throw planted(); } });
    await service.detectLanguages('the text');
    expect(lines.filter((line) => line.event === 'language.detection_failed')).toEqual([expect.objectContaining({ detector: 'fixture', type: 'unknown', code: 'unknown' })]);
    clean(lines);
  });

  it('(d) a captured console call and an unhandled rejection', () => {
    const lines: Line[] = [];
    const kit = kitOver(lines);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cleanup.push(captureConsole(kit));
    console.error(planted());
    expect(lines.filter((line) => line.event === 'console_line')).toEqual([expect.objectContaining({ method: 'error', type: 'unknown', code: 'unknown' })]);

    const onFatal = vi.fn();
    const before = new Set(process.listeners('unhandledRejection'));
    cleanup.push(installProcessHandlers(kit, { onShutdown: vi.fn(), onFatal }));
    const added = process.listeners('unhandledRejection').filter((listener) => !before.has(listener));
    expect(added).toHaveLength(1);
    // The handler is called as the process would call it; emitting the event would reach the test runner's own listener.
    (added[0] as (reason: unknown, promise: Promise<unknown>) => void)(planted(), Promise.resolve());
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.event === 'process.uncaught')).toEqual([expect.objectContaining({ type: 'unknown', code: 'unknown' })]);
    clean(lines);
  });

  it('(f) an optional soul that fails to load with it', () => {
    const lines = capture();
    warnSoulLoadFailed('inline soul', planted());
    expect(lines.filter((line) => line.event === 'soul.load_failed')).toEqual([expect.objectContaining({ optional: 'yes', type: 'unknown', code: 'unknown' })]);
    clean(lines);
  });
});

describe('a library error keeps its type and code', () => {
  it('(e) through the server handler', async () => {
    const lines = capture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await throughServer(() => { throw Object.assign(new Error('x'), { name: 'OpenRouterProviderError', code: 'STREAM_PARSING_ERROR' }); });
    await throughServer(() => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); });
    await vi.waitFor(() => expect(lines.filter((line) => line.event === 'http.handler_failed')).toHaveLength(2));
    expect(lines.filter((line) => line.event === 'http.handler_failed').map((line) => [line.type, line.code])).toEqual([
      ['OpenRouterProviderError', 'STREAM_PARSING_ERROR'], ['Error', 'ECONNRESET'],
    ]);
  });

  it('(g) a translation provider\'s own error, named where it is thrown, on language.translation_failed', async () => {
    const lines = capture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 456 })));
    try {
      const provider = new DeepLTranslationProvider('deepl', { apiKey: 'fixture-key' });
      await provider.initialize();
      await expect(provider.translate('the text', 'en', 'de')).rejects.toMatchObject({ code: 'TRANSLATION_REQUEST_FAILED' });
    } finally { vi.unstubAllGlobals(); }
    expect(lines.filter((line) => line.event === 'language.translation_failed')).toEqual([
      expect.objectContaining({ provider: 'deepl', reason: 'request_failed', status: 456, type: 'DeepLHttpError', code: 'unknown' }),
    ]);
  });
});
