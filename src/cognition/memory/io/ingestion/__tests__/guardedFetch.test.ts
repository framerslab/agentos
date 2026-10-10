/**
 * @fileoverview Tests for {@link guardedFetch}. A loopback server stands in
 * for the web. Every case names it by a made-up host whose addresses a
 * stand-in resolver answers, and allows only that server's address and port,
 * so no case reaches past this machine.
 *
 * @module memory/ingestion/__tests__/guardedFetch.test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { guardedFetch, GuardedFetchError, isPublicAddress, type GuardedFetchOptions } from '../guardedFetch.js';

/** The page the stand-in serves: about 2 KB of HTML. */
const PAGE = `<html><head><title>Review</title></head><body>${'<p>The quarterly review moved to Thursday.</p>\n'.repeat(44)}</body></html>`;

/** The cap a read is held to. */
const CAP = 2_097_152;

/** What `/big` sends before it stops sending. */
const BIG_BYTES = 3 * 1024 * 1024;

let server: Server;
let port = 0;
let connections = 0;

/** The stand-in web, one route per case. */
function answer(request: IncomingMessage, response: ServerResponse): void {
  const path = request.url ?? '/';
  const redirect = /^\/redirect\/(\d+)$/.exec(path);
  if (path === '/page') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  } else if (path === '/big') {
    // 3 MB of text, then the connection held open: a read that waited for
    // the end would meet its deadline, so only a read that stops at the cap
    // answers 'size'.
    response.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = Buffer.alloc(64 * 1024, 'a');
    for (let sent = 0; sent < BIG_BYTES; sent += chunk.length) response.write(chunk);
  } else if (path === '/slow') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.flushHeaders();
  } else if (redirect) {
    const next = Number(redirect[1]) - 1;
    response.writeHead(302, { location: next > 0 ? `/redirect/${next}` : '/page' });
    response.end();
  } else if (path === '/to-private') {
    response.writeHead(302, { location: `http://metadata.test:${port}/latest` });
    response.end();
  } else if (path === '/image') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } else if (path === '/gzip') {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(gzipSync(PAGE));
  } else if (path === '/upgrade') {
    // A protocol switch, written by hand: Node's own response cannot send a 101.
    request.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  } else if (path === '/zstd') {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'zstd' });
    response.end(Buffer.from('not decoded'));
  } else {
    response.writeHead(404);
    response.end();
  }
}

/** The address of `path` on the stand-in, by its made-up host. */
function at(path: string): string {
  return `http://pages.test:${port}${path}`;
}

/** Options that reach the stand-in alone: its host answers 127.0.0.1, the one address and port allowed. */
function reach(overrides: Partial<GuardedFetchOptions> = {}): GuardedFetchOptions {
  return {
    maxBytes: CAP,
    deadlineMs: 5_000,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    allowAddresses: ['127.0.0.1'],
    allowPorts: [port],
    ...overrides,
  };
}

/** The reason the guard refused `attempt`; fails the case when it was read or failed another way. */
async function reasonOf(attempt: Promise<unknown>): Promise<string> {
  const outcome = await attempt.then(
    () => 'read',
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(GuardedFetchError);
  return (outcome as GuardedFetchError).reason;
}

beforeAll(async () => {
  server = createServer(answer);
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('guardedFetch', () => {
  it('isPublicAddress takes public unicast addresses alone', () => {
    const vectors: Array<[string, boolean]> = [
      ['8.8.8.8', true],
      ['1.1.1.1', true],
      ['2606:4700:4700::1111', true],
      ['127.0.0.1', false],
      ['10.0.0.1', false],
      ['100.64.0.1', false],
      ['169.254.169.254', false],
      ['172.16.5.4', false],
      ['192.168.1.1', false],
      ['0.0.0.0', false],
      ['224.0.0.1', false],
      ['255.255.255.255', false],
      ['::', false],
      ['::1', false],
      ['fd00::1', false],
      ['fe80::1', false],
      ['ff02::1', false],
      ['::ffff:10.0.0.1', false],
      ['::ffff:7f00:1', false],
      ['64:ff9b::a00:1', false],
      ['2001:db8::1', false],
      ['not-an-address', false],
    ];
    for (const [address, expected] of vectors) expect(isPublicAddress(address), address).toBe(expected);
  });

  it('refuses a host when any of its addresses is not public, before any connection', async () => {
    const before = connections;
    const answerSets = [
      [{ address: '10.0.0.1', family: 4 }],
      [
        { address: '93.184.215.14', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      // The first answer is the stand-in itself: a check of the first answer
      // alone would connect to it, and the count below would show it.
      [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    ];
    for (const answers of answerSets) {
      expect(await reasonOf(guardedFetch(at('/page'), reach({ resolve: async () => answers })))).toBe('address');
    }
    expect(connections).toBe(before);
  });

  it('connects to the address it checked, resolving once a hop', async () => {
    const answers = [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }]];
    let calls = 0;
    const resolve = async () => answers[Math.min(calls++, 1)]!;
    const read = await guardedFetch(at('/page'), reach({ resolve, deadlineMs: 2_000 }));
    expect(calls).toBe(1);
    expect(read).toMatchObject({ url: at('/page'), status: 200, contentType: 'text/html' });
    expect(read.body.toString('utf8')).toBe(PAGE);
  });

  it('follows three redirects, each checked, and refuses a fourth or one to a private address', async () => {
    let hops = 0;
    const counted = async () => {
      hops += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const followed = await guardedFetch(at('/redirect/3'), reach({ resolve: counted }));
    expect(hops).toBe(4);
    expect(followed.url).toBe(at('/page'));
    expect(followed.body.toString('utf8')).toBe(PAGE);

    expect(await reasonOf(guardedFetch(at('/redirect/4'), reach()))).toBe('redirects');

    const resolve = async (host: string) => [{ address: host === 'metadata.test' ? '169.254.169.254' : '127.0.0.1', family: 4 }];
    expect(await reasonOf(guardedFetch(at('/to-private'), reach({ resolve })))).toBe('address');
  });

  it('refuses past the size cap, the deadline or the accepted types, and counts decoded bytes', async () => {
    expect(await reasonOf(guardedFetch(at('/big'), reach({ maxBytes: CAP, deadlineMs: 10_000 })))).toBe('size');
    expect(await reasonOf(guardedFetch(at('/slow'), reach({ deadlineMs: 500 })))).toBe('deadline');
    expect(await reasonOf(guardedFetch(at('/image'), reach()))).toBe('type');

    const decoded = await guardedFetch(at('/gzip'), reach());
    expect(decoded.contentType).toBe('text/html');
    expect(decoded.body.toString('utf8')).toBe(PAGE);
    // A cap one byte under the page and well over its gzipped size: only a
    // count of decoded bytes passes it.
    const underThePage = Buffer.byteLength(PAGE) - 1;
    expect(gzipSync(PAGE).length).toBeLessThan(underThePage);
    expect(await reasonOf(guardedFetch(at('/gzip'), reach({ maxBytes: underThePage })))).toBe('size');
  });

  it('reads http and https on the allowed ports alone, https to the checked address by its name', async () => {
    for (const address of ['ftp://pages.test/notes', 'file:///etc/passwd', 'not an address', `http://reader:secret@pages.test:${port}/page`]) {
      expect(await reasonOf(guardedFetch(address, reach())), address).toBe('scheme');
    }
    expect(await reasonOf(guardedFetch('http://pages.test:8080/', reach()))).toBe('port');
    expect(await reasonOf(guardedFetch('https://pages.test/', reach()))).toBe('port');

    // A listener that answers no TLS: the read fails, and its TLS hello,
    // which carries the host's name, shows where the connection went.
    const hellos: Buffer[] = [];
    const listener = createTcpServer((socket) => {
      socket.once('data', (data: Buffer) => {
        hellos.push(data);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const tlsPort = (listener.address() as AddressInfo).port;
    try {
      expect(await reasonOf(guardedFetch(`https://pages.test:${tlsPort}/page`, reach({ allowPorts: [tlsPort] })))).toBe('network');
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    expect(hellos).toHaveLength(1);
    expect(hellos[0]!.includes('pages.test')).toBe(true);
  });

  // Node closes a connection answered with a 101 without an error when
  // nothing listens for the upgrade, and then ignores the deadline's abort:
  // only a fetch that settles on the upgrade itself ends before this case's
  // five seconds.
  it('refuses a protocol upgrade and a body in a coding it did not ask for, at once', async () => {
    expect(await reasonOf(guardedFetch(at('/upgrade'), reach({ deadlineMs: 10_000 })))).toBe('status');
    expect(await reasonOf(guardedFetch(at('/zstd'), reach()))).toBe('type');
  }, 5_000);

  it("ends on the caller's own abort with its reason, and refuses options out of range before any lookup", async () => {
    const controller = new AbortController();
    const reason = new Error('the caller moved on');
    const pending = guardedFetch(at('/slow'), reach({ signal: controller.signal, deadlineMs: 10_000 }));
    setTimeout(() => controller.abort(reason), 100);
    await expect(pending).rejects.toBe(reason);

    let lookups = 0;
    const counted = async () => {
      lookups += 1;
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const outOfRange: Array<Partial<GuardedFetchOptions>> = [{ maxBytes: Number.NaN }, { deadlineMs: 2 ** 31 }, { maxRedirects: -1 }];
    for (const options of outOfRange) {
      await expect(guardedFetch(at('/page'), reach({ ...options, resolve: counted }))).rejects.toBeInstanceOf(RangeError);
    }
    expect(lookups).toBe(0);
  });
});
