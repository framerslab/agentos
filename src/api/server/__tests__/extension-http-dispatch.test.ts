import { describe, it, expect } from 'vitest';
import { AgentOSServer } from '../AgentOSServer.js';
import { createAgentOSConfig } from '../config/ServerConfig.js';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AgentOS } from '../../AgentOS.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;

function makeServer(handlers: Handler[], overrides: Record<string, unknown> = {}) {
  const server = new AgentOSServer(
    { skipDefaultInitialization: true } as never,
    createAgentOSConfig({ port: 0, host: '127.0.0.1', ...overrides })
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

async function request(server: AgentOSServer, path: string): Promise<{ status: number; body: string }> {
  await server.start();
  const addr = server.getServer().address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { method: 'POST' });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    await server.stop();
  }
}

describe('AgentOSServer extension http dispatch', () => {
  it('serves a pack handler that claims the request', async () => {
    const handler: Handler = (req, res) => {
      if (!(req.url ?? '').startsWith('/hooks/ping')) return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pong: true }));
      return true;
    };
    const { status, body } = await request(makeServer([handler]), '/hooks/ping');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ pong: true });
  });

  it('falls through to 404 when no handler claims', async () => {
    const { status } = await request(makeServer([() => false]), '/nope');
    expect(status).toBe(404);
  });

  it('chains handlers in order until one claims', async () => {
    const calls: string[] = [];
    const first: Handler = () => {
      calls.push('first');
      return false;
    };
    const second: Handler = (_req, res) => {
      calls.push('second');
      res.writeHead(204);
      res.end();
      return true;
    };
    const { status } = await request(makeServer([first, second]), '/x');
    expect(status).toBe(204);
    expect(calls).toEqual(['first', 'second']);
  });

  it('a throwing handler yields a generic 500 without leaking the error text', async () => {
    const boom: Handler = () => {
      throw new Error('boom-internal-secret');
    };
    const { status, body } = await request(makeServer([boom]), '/x');
    expect(status).toBe(500);
    expect(body).not.toContain('boom-internal-secret');
    expect(JSON.parse(body)).toEqual({ error: 'Extension HTTP handler error' });
  });

  it('flag off: handlers are not consulted', async () => {
    const never: Handler = () => {
      throw new Error('should not run');
    };
    const { status } = await request(makeServer([never], { dispatchExtensionHandlers: false }), '/x');
    expect(status).toBe(404);
  });
});
