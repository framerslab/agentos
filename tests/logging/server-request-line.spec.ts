/**
 * @file server-request-line.spec.ts
 * @description `AgentOSServer` gives each request an id, returns it in `x-request-id`, and writes one `http.request`
 * line when the request ends: its method, its route as the server names it, its status, its duration in
 * milliseconds and its outcome. Every AgentOS event line written while the request runs carries the same id. No
 * path, query, header, body or error text reaches a line.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import pino from 'pino';
import { AgentOSServer } from '../../src/api/server/AgentOSServer.js';
import { createAgentOSConfig } from '../../src/api/server/config/ServerConfig.js';
import type { AgentOS } from '../../src/api/AgentOS.js';
import { lazyLogger, resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory.js';

const MARKER = 'private-words-4417';
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
type Line = Record<string, unknown>;

/** A pino logger handed to AgentOS, and the lines it received. */
function capture(): Line[] {
  const lines: Line[] = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
  return lines;
}

/** A server over a stub AgentOS whose extension handlers are `handlers`. */
function makeServer(handlers: Handler[], options: { enableCors?: boolean } = {}): AgentOSServer {
  const server = new AgentOSServer(
    { skipDefaultInitialization: true } as never,
    createAgentOSConfig({ port: 0, host: '127.0.0.1', ...options }),
  );
  server.setAgentOSForTesting({
    getHttpHandlers: () => handlers,
    listAvailablePersonas: async () => [],
    processRequest: async function* () {},
    initialize: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as AgentOS);
  return server;
}

/** Starts the server, runs `run` against its base URL, and stops it. */
async function serve(server: AgentOSServer, run: (base: string, port: number) => Promise<void>): Promise<void> {
  await server.start();
  const { port } = server.getServer().address() as { port: number };
  try { await run(`http://127.0.0.1:${port}`, port); } finally { await server.stop(); }
}

/** The completion lines, once `n` of them are written; a response can close a tick after the client has read it. */
async function completions(lines: Line[], n: number): Promise<Line[]> {
  await vi.waitFor(() => expect(lines.filter((line) => line.event === 'http.request')).toHaveLength(n));
  return lines.filter((line) => line.event === 'http.request');
}

afterEach(() => { resetLoggerFactory(); vi.restoreAllMocks(); });

describe('AgentOSServer request lines', () => {
  it('writes one line per request with its method, route, status, duration and outcome, under a fresh id', async () => {
    const lines = capture();
    const hook: Handler = (req, res) => {
      if (!(req.url ?? '').startsWith('/hooks/')) return false;
      res.writeHead(202); res.end(); return true;
    };
    const ids: string[] = [];
    await serve(makeServer([hook]), async (base) => {
      const calls: Array<[string, RequestInit]> = [
        [`${base}/health`, { method: 'GET' }],
        [`${base}/api/agentos/personas?userId=${MARKER}`, { method: 'GET' }],
        [`${base}/api/agentos/chat`, { method: 'POST', body: JSON.stringify({ text: MARKER, userId: MARKER }) }],
        [`${base}/hooks/${MARKER}?q=${MARKER}`, { method: 'PUT', headers: { 'x-private': MARKER } }],
        [`${base}/${MARKER}`, { method: 'POST' }],
        [`${base}/api/agentos/chat`, { method: 'POST', body: `{"text": "${MARKER}"` }],
      ];
      for (const [url, init] of calls) {
        const response = await fetch(url, init);
        await response.text();
        ids.push(response.headers.get('x-request-id') ?? '');
      }
    });
    const written = await completions(lines, 6);
    expect(written.map(({ method, route, status, outcome }) => [method, route, status, outcome])).toEqual([
      ['GET', '/health', 200, 'ok'],
      ['GET', '/api/agentos/personas', 200, 'ok'],
      ['POST', '/api/agentos/chat', 200, 'ok'],
      ['PUT', 'extension', 202, 'ok'],
      ['POST', 'unmatched', 404, 'ok'],
      ['POST', '/api/agentos/chat', 400, 'ok'],
    ]);
    for (const [index, line] of written.entries()) {
      expect(line.level).toBe(30);
      expect(line.component).toBe('http');
      expect(line.requestId).toMatch(/^[A-Za-z0-9-]{1,64}$/);
      expect(line.requestId).toBe(ids[index]);
      expect(Number.isInteger(line.ms) && (line.ms as number) >= 0).toBe(true);
      expect(Object.keys(line).sort()).toEqual(['component', 'event', 'level', 'method', 'ms', 'outcome', 'requestId', 'route', 'status', 'time']);
    }
    expect(new Set(ids).size).toBe(6);
    expect(JSON.stringify(lines).includes(MARKER)).toBe(false);
  });

  it('lets a cross-origin browser read the request id when CORS is on', async () => {
    capture();
    let exposed: string | null = null;
    await serve(makeServer([], { enableCors: true }), async (base) => {
      const response = await fetch(`${base}/health`);
      await response.text();
      exposed = response.headers.get('access-control-expose-headers');
    });
    expect(exposed).toBe('x-request-id');
  });

  it('tags each AgentOS event line written during the request with its id', async () => {
    const lines = capture();
    const inner = lazyLogger('fixture');
    const hook: Handler = async (_req, res) => {
      inner.info('llm.models_refresh', { provider: 'openai' });
      await new Promise((resolve) => setImmediate(resolve));
      inner.warn('llm.models_empty', { provider: 'openai' });
      res.writeHead(200); res.end(); return true;
    };
    let header = '';
    await serve(makeServer([hook]), async (base) => {
      const response = await fetch(`${base}/hooks/x`);
      await response.text();
      header = response.headers.get('x-request-id') ?? '';
    });
    const [done] = await completions(lines, 1);
    const during = lines.filter((line) => line.component === 'fixture');
    expect(during.map((line) => line.event)).toEqual(['llm.models_refresh', 'llm.models_empty']);
    expect(during.every((line) => line.requestId === done.requestId)).toBe(true);
    expect(done.requestId).toBe(header);
    inner.info('llm.models_refresh', { provider: 'openai' });
    expect(lines.at(-1)).not.toHaveProperty('requestId');
  });

  it('writes a failed extension handler as its type and code, then the request at error', async () => {
    const lines = capture();
    const printed = vi.spyOn(console, 'error');
    const boom: Handler = () => { throw Object.assign(new Error(MARKER), { code: 'E_FIXTURE' }); };
    await serve(makeServer([boom]), async (base) => {
      const response = await fetch(`${base}/hooks/${MARKER}`, { method: 'POST' });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(MARKER);
    });
    const [done] = await completions(lines, 1);
    const failed = lines.filter((line) => line.event === 'http.handler_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 50, type: 'Error', code: 'unknown', requestId: done.requestId });
    expect(done).toMatchObject({ level: 50, method: 'POST', route: 'extension', status: 500, outcome: 'error' });
    // The stub server's embedded AgentOS may report its own configuration on the console; no call carries the error.
    expect(printed.mock.calls.flat().map(String).join('\n')).not.toContain(MARKER);
    expect(JSON.stringify(lines).includes(MARKER)).toBe(false);
  });

  it('writes a handler that throws after its response began as one failure and an error line', async () => {
    const lines = capture();
    const late: Handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial');
      throw Object.assign(new Error(MARKER), { code: 'E_LATE' });
    };
    await serve(makeServer([late]), async (base) => {
      await fetch(`${base}/hooks/late`).then((response) => response.text()).catch(() => undefined);
      await completions(lines, 1);
    });
    const [done] = await completions(lines, 1);
    expect(lines.filter((line) => line.event === 'http.handler_failed')).toHaveLength(1);
    expect(done).toMatchObject({ level: 50, route: 'extension', status: 200, outcome: 'error' });
    expect(JSON.stringify(lines).includes(MARKER)).toBe(false);
  });

  it('names a known route for a request the client gave up on while AgentOS was starting', async () => {
    const lines = capture();
    const server = makeServer([]);
    let ready: () => void = () => undefined;
    Reflect.set(server, 'agentReady', new Promise<void>((resolve) => { ready = resolve; }));
    const listening = server.getServer();
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', () => resolve()));
    const { port } = listening.address() as { port: number };
    try {
      const client = httpRequest({ host: '127.0.0.1', port, path: `/health?q=${MARKER}`, method: 'GET' });
      client.on('error', () => undefined);
      const sent = new Promise<void>((resolve) => listening.once('request', () => resolve()));
      client.end();
      await sent;
      client.destroy();
      const [done] = await completions(lines, 1);
      expect(done).toMatchObject({ level: 40, method: 'GET', route: '/health', status: 0, outcome: 'aborted' });
    } finally {
      ready();
      await server.stop();
    }
    expect(JSON.stringify(lines).includes(MARKER)).toBe(false);
  });

  it('writes a request the client gave up on as aborted, once', async () => {
    const lines = capture();
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const slow: Handler = async (_req, res) => {
      entered();
      await new Promise((resolve) => res.once('close', resolve));
      return true;
    };
    await serve(makeServer([slow]), async (_base, port) => {
      const client = httpRequest({ host: '127.0.0.1', port, path: `/hooks/${MARKER}`, method: 'GET' });
      client.on('error', () => undefined);
      client.end();
      await reached;
      client.destroy();
      await completions(lines, 1);
    });
    const written = await completions(lines, 1);
    expect(written[0]).toMatchObject({ level: 40, method: 'GET', route: 'extension', status: 0, outcome: 'aborted' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lines.filter((line) => line.event === 'http.request')).toHaveLength(1);
    expect(JSON.stringify(lines).includes(MARKER)).toBe(false);
  });
});
