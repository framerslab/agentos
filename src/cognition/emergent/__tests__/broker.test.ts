import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { brokeredFetch, type FetchScope } from '../broker/fetch.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { brokeredRead, ReadRoots, type ReadTooLarge } from '../broker/fs-read.js';
import { CapabilityBroker } from '../broker/CapabilityBroker.js';
import { resolveCeiling } from '../ceiling.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { createSqliteAdapter } from './helpers/sqlite-adapter.js';

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  body: string;
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

/**
 * A server on every interface, so `127.0.0.1` and `localhost` both reach it:
 * two origins, one server. `seen` records each request as it arrives.
 */
async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      handler(req, res, port);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
  return { port, seen };
}

function scope(overrides: Partial<FetchScope> = {}): FetchScope {
  return {
    domains: ['127.0.0.1'],
    methods: ['GET', 'HEAD'],
    maxResponseBytes: 1024,
    maxRedirects: 2,
    timeoutMs: 5_000,
    ...overrides,
  };
}

const live = (): AbortSignal => new AbortController().signal;

describe('brokeredFetch', () => {
  it('fetches a listed host and returns a response forged code can read', async () => {
    const { port } = await serve((_req, res) => res.end(JSON.stringify({ ok: 1 })));
    const response = await brokeredFetch(`http://127.0.0.1:${port}/x`, undefined, scope(), live());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: 1 });
  });

  it('refuses a redirect to an unlisted host at the hop, before the request is sent', async () => {
    const { port, seen } = await serve((_req, res, p) => {
      res.statusCode = 302;
      res.setHeader('location', `http://localhost:${p}/elsewhere`);
      res.end();
    });
    await expect(brokeredFetch(`http://127.0.0.1:${port}/start`, undefined, scope(), live())).rejects.toThrow(
      'host_not_allowed: localhost',
    );
    expect(seen.map((s) => s.url)).toEqual(['/start']);
  });

  it('follows redirects within the list, stops past maxRedirects, and drops credentials when the origin changes', async () => {
    let hops = 0;
    const { port, seen } = await serve((req, res, p) => {
      if (req.url === '/cross') {
        res.statusCode = 302;
        res.setHeader('location', `http://localhost:${p}/landed`);
        res.end();
        return;
      }
      if (req.url === '/landed') {
        res.end('landed');
        return;
      }
      hops += 1;
      res.statusCode = 302;
      res.setHeader('location', `/hop-${hops}`);
      res.end();
    });
    await expect(
      brokeredFetch(`http://127.0.0.1:${port}/`, undefined, scope({ maxRedirects: 2 }), live()),
    ).rejects.toThrow('too_many_redirects');
    expect(hops).toBe(3);

    const landed = await brokeredFetch(
      `http://127.0.0.1:${port}/cross`,
      { headers: { authorization: 'Bearer t' } },
      scope({ domains: ['127.0.0.1', 'localhost'] }),
      live(),
    );
    expect(await landed.text()).toBe('landed');
    expect(seen.filter((s) => s.url === '/cross').map((s) => s.authorization)).toEqual(['Bearer t']);
    expect(seen.filter((s) => s.url === '/landed').map((s) => s.authorization)).toEqual([undefined]);
  });

  it('refuses a method outside the scope before any request, and sends only the method and headers it was given', async () => {
    const { port, seen } = await serve((_req, res) => res.end('ok'));
    await expect(
      brokeredFetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x' }, scope(), live()),
    ).rejects.toThrow('method_not_allowed: POST');
    expect(seen).toHaveLength(0);

    await brokeredFetch(
      `http://127.0.0.1:${port}/`,
      { method: 'get', body: 'dropped', headers: { 'x-a': '1' }, redirect: 'follow' },
      scope(),
      live(),
    );
    expect(seen).toMatchObject([{ method: 'GET', url: '/', body: '' }]);
  });

  it('refuses a body over maxResponseBytes while it streams', async () => {
    const { port } = await serve((_req, res) => res.end('x'.repeat(4096)));
    await expect(
      brokeredFetch(`http://127.0.0.1:${port}/big`, undefined, scope({ maxResponseBytes: 1024 }), live()),
    ).rejects.toThrow('response_too_large');
  });

  it("the call's signal aborts a request in flight, and the scope's time bound ends one", async () => {
    const { port } = await serve(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = brokeredFetch(`http://127.0.0.1:${port}/hang`, undefined, scope(), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow('aborted');
    await expect(
      brokeredFetch(`http://127.0.0.1:${port}/hang`, undefined, scope({ timeoutMs: 100 }), live()),
    ).rejects.toThrow('timed_out');
  });

  it("reaches every host with '*', and only over http and https", async () => {
    const { port } = await serve((_req, res) => res.end('ok'));
    expect(
      (await brokeredFetch(`http://localhost:${port}/`, undefined, scope({ domains: '*' }), live())).ok,
    ).toBe(true);
    await expect(brokeredFetch('file:///etc/hosts', undefined, scope({ domains: '*' }), live())).rejects.toThrow(
      'scheme_not_allowed',
    );
  });
});

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'broker-')));
}

const readScope = { maxBytesPerRead: 1024, timeoutMs: 5_000 };

describe('brokeredRead', () => {
  it('reads a file under a root and refuses one outside, through a link too', async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(root, 'in.txt'), 'inside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const roots = new ReadRoots([root]);

    expect(await brokeredRead(path.join(root, 'in.txt'), roots, readScope, live())).toBe('inside');
    await expect(brokeredRead(path.join(outside, 'secret.txt'), roots, readScope, live())).rejects.toThrow(
      'path_not_allowed',
    );
    await expect(brokeredRead(path.join(root, 'link.txt'), roots, readScope, live())).rejects.toThrow(
      'path_not_allowed',
    );
  });

  it('refuses a file over maxBytesPerRead without reading it whole', async () => {
    const root = tempDir();
    const big = path.join(root, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 1));
    const refused = (await brokeredRead(big, new ReadRoots([root]), readScope, live()).catch(
      (error: unknown) => error,
    )) as ReadTooLarge;
    expect(refused.code).toBe('file_too_large');
    // Stopped at the first stream chunk past the limit (64 KiB chunks), far short of 8 MiB.
    expect(refused.bytesRead).toBeLessThanOrEqual(1024 + 65_536);
  });
});

describe('CapabilityBroker.functionsFor', () => {
  it('hands a call only the functions its grant names, and refuses once the call has ended', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    const ceiling = resolveCeiling(
      { 'fs.read': { roots: [root] }, crypto: {} },
      { store: 'none' },
      { hasStorage: false },
    );
    const broker = new CapabilityBroker(ceiling);
    const controller = new AbortController();
    const fns = broker.functionsFor(['fs.read'], {
      id: 'call-1',
      toolId: 'reader',
      agentId: 'agent-1',
      signal: controller.signal,
    });

    expect(Object.keys(fns)).toEqual(['fs']);
    const readFile = (fns.fs as { readFile(p: string): Promise<string> }).readFile;
    expect(await readFile(path.join(root, 'a.txt'))).toBe('A');
    controller.abort();
    await expect(readFile(path.join(root, 'a.txt'))).rejects.toThrow('call_ended');
  });

  it('never hands out a capability the ceiling does not hold, whatever the grant says', () => {
    const broker = new CapabilityBroker(resolveCeiling({ crypto: {} }, { store: 'none' }, { hasStorage: false }));
    const fns = broker.functionsFor(['fetch', 'crypto'], {
      id: 'call-2',
      toolId: 'hasher',
      agentId: 'agent-1',
      signal: live(),
    });
    expect(Object.keys(fns)).toEqual(['crypto']);
  });
});

describe('CapabilityBroker records and ends runs', () => {
  it('records an allowed call before it runs and its outcome after, and lists the run when it ends', async () => {
    const { port } = await serve((_req, res) => res.end('ok'));
    const db = createSqliteAdapter();
    const store = new EmergentToolRegistry({}, db).effectsStore({ content: 'full' });
    const broker = new CapabilityBroker(
      resolveCeiling({ fetch: { domains: ['127.0.0.1'] }, crypto: {} }, { content: 'full' }, { hasStorage: true }),
      store,
    );
    const controller = new AbortController();
    const call = { id: 'run-1', toolId: 'tool-1', agentId: 'agent-1', signal: controller.signal };
    const fns = broker.functionsFor(['fetch', 'crypto'], call);
    const response = await (fns.fetch as (url: string) => Promise<Response>)(`http://127.0.0.1:${port}/x`);
    expect(await response.text()).toBe('ok');
    (fns.crypto as { randomUUID(): string }).randomUUID();
    (fns.crypto as { randomUUID(): string }).randomUUID();

    controller.abort();
    const effects = await broker.endCall('run-1');
    expect(effects).toEqual([
      expect.objectContaining({
        kind: 'capability',
        capability: 'fetch',
        target: `http://127.0.0.1:${port}/x`,
        decision: 'allowed',
        decidedBy: 'ceiling',
        outcome: 'ok',
        bytes: 2,
        record: 'written',
      }),
      expect.objectContaining({ capability: 'crypto', uses: 2, record: 'written' }),
    ]);
    expect(
      db.raw.prepare('SELECT capability, outcome, uses FROM agentos_emergent_effects ORDER BY capability DESC').all(),
    ).toEqual([
      { capability: 'fetch', outcome: 'ok', uses: null },
      { capability: 'crypto', outcome: 'ok', uses: 2 },
    ]);
  });

  it('records a refusal with what decided it, and refuses a call whose intent cannot be written', async () => {
    const { port, seen } = await serve((_req, res) => res.end('ok'));
    const db = createSqliteAdapter();
    const store = new EmergentToolRegistry({}, db).effectsStore({ content: 'digest' });
    const broker = new CapabilityBroker(
      resolveCeiling({ fetch: { domains: ['127.0.0.1'] } }, undefined, { hasStorage: true }),
      store,
    );
    const call = { id: 'run-2', toolId: 'tool-1', agentId: 'agent-1', signal: live() };
    const fetchFn = broker.functionsFor(['fetch'], call).fetch as (url: string) => Promise<Response>;

    await expect(fetchFn(`http://localhost:${port}/x`)).rejects.toThrow('host_not_allowed');
    db.failNext('INSERT INTO agentos_emergent_effects');
    await expect(fetchFn(`http://127.0.0.1:${port}/y`)).rejects.toThrow('audit_unavailable');
    expect(seen).toEqual([]);

    expect(await broker.endCall('run-2')).toEqual([
      expect.objectContaining({ decision: 'refused', decidedBy: 'host_not_allowed', record: 'written' }),
      expect.objectContaining({ decision: 'refused', decidedBy: 'audit_unavailable', record: 'none' }),
    ]);
  });

  it('ending a run aborts its request in flight and leaves a concurrent run alone', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port } = await serve((req, res) => {
      if (req.url === '/hang') {
        return;
      }
      void released.then(() => res.end('late'));
    });
    const broker = new CapabilityBroker(
      resolveCeiling({ fetch: { domains: ['127.0.0.1'] } }, { store: 'none' }, { hasStorage: false }),
    );
    const a = new AbortController();
    const b = new AbortController();
    const fetchA = broker.functionsFor(['fetch'], { id: 'a', toolId: 't', agentId: 'x', signal: a.signal })
      .fetch as (url: string) => Promise<Response>;
    const fetchB = broker.functionsFor(['fetch'], { id: 'b', toolId: 't', agentId: 'x', signal: b.signal })
      .fetch as (url: string) => Promise<Response>;

    const hanging = fetchA(`http://127.0.0.1:${port}/hang`).catch((error: Error) => error.message);
    const late = fetchB(`http://127.0.0.1:${port}/late`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.abort();
    const ended = await broker.endCall('a');
    expect(await hanging).toContain('aborted');
    expect(ended).toEqual([expect.objectContaining({ outcome: 'aborted', record: 'none' })]);

    release();
    expect(await (await late).text()).toBe('late');
    b.abort();
    expect(await broker.endCall('b')).toEqual([expect.objectContaining({ outcome: 'ok' })]);
  });
});
