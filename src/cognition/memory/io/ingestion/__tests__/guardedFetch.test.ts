/**
 * @fileoverview Tests for {@link guardedFetch}. A loopback server stands in
 * for the web. Reads name it by a made-up host whose addresses a stand-in
 * resolver answers, and allow only that server's address and port. Literal
 * refusal cases block connection attempts, so no case reaches past this machine.
 *
 * @module memory/ingestion/__tests__/guardedFetch.test
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as diagnosticsChannel from 'node:diagnostics_channel';
import { createServer as createTcpServer, Socket, type AddressInfo } from 'node:net';
import { createGunzip, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { guardedFetch, GuardedFetchError, isPublicAddress, type GuardedFetchOptions } from '../guardedFetch.js';

// Keep real decompression while allowing a case to hold one decoder's completion.
vi.mock('node:zlib', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:zlib')>();
  return { ...original, createGunzip: vi.fn(original.createGunzip) };
});

/** The page the stand-in serves: about 2 KB of HTML. */
const PAGE = `<html><head><title>Review</title></head><body>${'<p>The quarterly review moved to Thursday.</p>\n'.repeat(44)}</body></html>`;

/** The cap a read is held to. */
const CAP = 2_097_152;

/**
 * `data` gzipped with a file name of `nameBytes` bytes in the header: as long
 * as that on the wire, and no longer once decoded.
 */
function gzipWithFileName(data: string, nameBytes: number): Buffer {
  const plain = gzipSync(data);
  const header = Buffer.from(plain.subarray(0, 10));
  header[3] |= 0x08;
  return Buffer.concat([header, Buffer.alloc(nameBytes, 0x61), Buffer.from([0]), plain.subarray(10)]);
}

/** What `/big` sends before it stops sending. */
const BIG_BYTES = 3 * 1024 * 1024;

let server: Server;
let port = 0;
let connections = 0;

/** The Host header of each request the stand-in answered, in order. */
const hosts: string[] = [];

/** The stand-in web, one route per case. */
function answer(request: IncomingMessage, response: ServerResponse): void {
  hosts.push(request.headers.host ?? '');
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
  } else if (path === '/to-provider') {
    // A page that sends its reader on to a provider's own site.
    response.writeHead(302, { location: 'https://docs.google.com/document/d/x/edit' });
    response.end();
  } else if (path === '/untyped') {
    // No Content-Type at all, as some file servers answer.
    response.writeHead(200);
    response.end(Buffer.from([1, 2, 3, 4]));
  } else if (path === '/image') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } else if (path === '/gzip') {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(gzipSync(PAGE));
  } else if (path === '/declared-held') {
    // A length past the cap in the head, and a body that never comes: only a
    // read that refuses the declared length answers before the deadline.
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(64 * 1024) });
    response.flushHeaders();
  } else if (path === '/gzip-padded') {
    // A short page that is five kilobytes on the wire, sent in two writes
    // with no content-length to give the size away.
    const body = gzipWithFileName('<p>short</p>', 5000);
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.write(body.subarray(0, 2500));
    response.end(body.subarray(2500));
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

  it.each(['127.0.0.1', '169.254.169.254', '[::ffff:127.0.0.1]', '0x7f000001'])(
    'refuses the literal %s before any connection or resolver call',
    async (host) => {
      const before = connections;
      let lookups = 0;
      /** Counts resolver calls that a literal address must bypass. */
      const resolve = async () => {
        lookups += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      };
      // Block even an attempted connection if the address check regresses.
      const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
        throw new Error('unexpected connection');
      });
      try {
        const address = `http://${host}:${port}/page`;
        if (host === '0x7f000001') expect(new URL(address).hostname).toBe('127.0.0.1');
        expect(await reasonOf(guardedFetch(address, reach({ resolve, allowAddresses: [] })))).toBe('address');
        expect(lookups).toBe(0);
        expect(connect).not.toHaveBeenCalled();
        expect(connections).toBe(before);
      } finally {
        connect.mockRestore();
      }
    },
  );

  it('keeps resolver error details out of a network refusal', async () => {
    const before = connections;
    /** Supplies a resolver failure containing details that must stay private. */
    const resolve = async (): Promise<never> => {
      throw new Error('lookup failed at 10.0.0.53 for private-service.test');
    };
    await expect(guardedFetch(at('/page'), reach({ resolve }))).rejects.toMatchObject({
      name: 'GuardedFetchError',
      reason: 'network',
      message: 'The network read failed.',
    });
    expect(connections).toBe(before);
  });

  it('connects to the address it checked, resolving once a hop', async () => {
    const answers = [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }]];
    let calls = 0;
    const resolve = async () => answers[Math.min(calls++, 1)]!;
    const asked = hosts.length;
    const read = await guardedFetch(at('/page'), reach({ resolve, deadlineMs: 2_000 }));
    expect(calls).toBe(1);
    // The request went to the checked address and still names the host: a
    // server that holds several sites answers by this header.
    expect(hosts.slice(asked)).toEqual([`pages.test:${port}`]);
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

  describe('allowHost', () => {
    /** A caller's host rule that refuses one provider's host and records every host it is asked about. */
    function refusing(seen: string[] = []): (host: string) => boolean {
      return (host) => {
        seen.push(host);
        return host !== 'docs.google.com';
      };
    }

    /** A resolver that answers the stand-in's address for any host and counts the lookups. */
    function counting(): { resolve: NonNullable<GuardedFetchOptions['resolve']>; lookups: () => number } {
      let lookups = 0;
      return {
        resolve: async () => {
          lookups += 1;
          return [{ address: '127.0.0.1', family: 4 }];
        },
        lookups: () => lookups,
      };
    }

    it('refuses a host the caller does not allow before any lookup or connection, whatever its port or spelling', async () => {
      const before = connections;
      const lookup = counting();
      const seen: string[] = [];
      const addresses = ['https://docs.google.com/document/d/x', 'http://docs.google.com:8080/x', 'http://DOCS.GOOGLE.COM./document/d/x'];
      for (const address of addresses) {
        expect(await reasonOf(guardedFetch(address, reach({ resolve: lookup.resolve, allowHost: refusing(seen) }))), address).toBe('host');
      }
      // The rule sees the host alone: in lower case, without the port and without a trailing dot.
      expect(seen).toEqual(['docs.google.com', 'docs.google.com', 'docs.google.com']);
      expect(lookup.lookups()).toBe(0);
      expect(connections).toBe(before);
    });

    it('refuses a redirect to such a host at the redirect: the first request made, the second not', async () => {
      const asked = hosts.length;
      const before = connections;
      const lookup = counting();
      const seen: string[] = [];
      expect(await reasonOf(guardedFetch(at('/to-provider'), reach({ resolve: lookup.resolve, allowHost: refusing(seen) })))).toBe('host');
      expect(hosts.slice(asked)).toEqual([`pages.test:${port}`]);
      expect(seen).toEqual(['pages.test', 'docs.google.com']);
      // The first hop's host was resolved; the redirect's target never was.
      expect(lookup.lookups()).toBe(1);
      expect(connections).toBe(before + 1);

      // Without the rule the same redirect is checked as before: its port is not one this read allows.
      expect(await reasonOf(guardedFetch(at('/to-provider'), reach()))).toBe('port');
    });

    it('reads a redirect to a host the caller allows as before', async () => {
      const seen: string[] = [];
      const followed = await guardedFetch(at('/redirect/1'), reach({ allowHost: refusing(seen) }));
      expect(followed.url).toBe(at('/page'));
      expect(followed.body.toString('utf8')).toBe(PAGE);
      expect(seen).toEqual(['pages.test', 'pages.test']);
    });

    it('narrows only: a host the caller allows still passes every other check', async () => {
      const everything = () => true;
      const before = connections;
      // A name that resolves to a private address.
      const privateName = async () => [{ address: '10.0.0.1', family: 4 }];
      expect(await reasonOf(guardedFetch(at('/page'), reach({ allowHost: everything, resolve: privateName })))).toBe('address');
      // Literal addresses that are not public: IPv4, IPv4 inside IPv6, unique-local IPv6.
      for (const host of ['169.254.169.254', '[::ffff:169.254.169.254]', '[fd00::1]']) {
        const address = `http://${host}:${port}/page`;
        expect(await reasonOf(guardedFetch(address, reach({ allowHost: everything, allowAddresses: [] }))), address).toBe('address');
      }
      // An IPv6 literal reaches the rule without its brackets, and is still refused by its address.
      const seen: string[] = [];
      const recording = (host: string) => {
        seen.push(host);
        return true;
      };
      expect(await reasonOf(guardedFetch(`http://[::ffff:7f00:1]:${port}/page`, reach({ allowHost: recording, allowAddresses: [] })))).toBe('address');
      expect(seen).toEqual(['::ffff:7f00:1']);
      // The scheme and the port hold too.
      expect(await reasonOf(guardedFetch('ftp://pages.test/notes', reach({ allowHost: everything })))).toBe('scheme');
      expect(await reasonOf(guardedFetch('http://pages.test:8080/', reach({ allowHost: everything })))).toBe('port');
      expect(connections).toBe(before);
      // A redirect to a name that resolves to a private address, and the redirect count.
      const resolve = async (host: string) => [{ address: host === 'metadata.test' ? '169.254.169.254' : '127.0.0.1', family: 4 }];
      expect(await reasonOf(guardedFetch(at('/to-private'), reach({ allowHost: everything, resolve })))).toBe('address');
      expect(await reasonOf(guardedFetch(at('/redirect/4'), reach({ allowHost: everything })))).toBe('redirects');
    });

    it('refuses on any answer but true, on a rule that throws, and a rule that is not a function before any lookup', async () => {
      const lookup = counting();
      const truthy = (() => 1) as unknown as GuardedFetchOptions['allowHost'];
      expect(await reasonOf(guardedFetch(at('/page'), reach({ resolve: lookup.resolve, allowHost: truthy })))).toBe('host');
      // A rule that fails is a rule that did not say yes. What it threw is the
      // refusal's cause, for whoever reads the rule's own logs; the message
      // keeps its details out.
      const trouble = new Error('the list could not be read from 10.0.0.53');
      const failing = (): boolean => {
        throw trouble;
      };
      const refused = await guardedFetch(at('/page'), reach({ resolve: lookup.resolve, allowHost: failing })).then(
        () => 'read',
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(GuardedFetchError);
      expect(refused).toMatchObject({ reason: 'host', message: 'pages.test is not read: the host rule failed' });
      expect(refused).toHaveProperty('cause', trouble);
      const notARule = 'docs.google.com' as unknown as GuardedFetchOptions['allowHost'];
      await expect(guardedFetch(at('/page'), reach({ resolve: lookup.resolve, allowHost: notARule }))).rejects.toBeInstanceOf(TypeError);
      expect(lookup.lookups()).toBe(0);
    });

    it('is asked under the deadline: a rule that outlasts it leaves the read refused for the deadline, not read with a fresh one', async () => {
      const before = connections;
      let lookups = 0;
      /**
       * Answers with the next turn's timers, where a deadline already due fires
       * first. A lookup can answer no sooner: its answer comes with the I/O
       * after the timers. (`setImmediate` would run in the check phase, before
       * the next timers, when the case begins from an I/O callback.)
       */
      const nextTurn = async () => {
        lookups += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return [{ address: '127.0.0.1', family: 4 }];
      };
      const deadlineMs = 100;
      /** A rule that takes three times the deadline to say yes. */
      const slow = (): boolean => {
        const until = Date.now() + 3 * deadlineMs;
        while (Date.now() < until) {
          // The rule is at work.
        }
        return true;
      };
      expect(await reasonOf(guardedFetch(at('/page'), reach({ resolve: nextTurn, allowHost: slow, deadlineMs })))).toBe('deadline');
      // The lookup was asked for, since the deadline's timer fires only once
      // the rule has returned; its answer came too late for anything to be
      // connected to.
      expect(lookups).toBe(1);
      expect(connections).toBe(before);
    });

    it("ends on the caller's abort from inside the rule with the signal's reason and no lookup, at the first address as at a redirect", async () => {
      const reason = new Error('the caller moved on');
      // A rule that refuses, having told the fetch to stop: the signal's reason wins over the refusal.
      const refusing = counting();
      const stopper = new AbortController();
      const refusesAndStops = (): boolean => {
        stopper.abort(reason);
        return false;
      };
      await expect(
        guardedFetch(at('/page'), reach({ resolve: refusing.resolve, allowHost: refusesAndStops, signal: stopper.signal })),
      ).rejects.toBe(reason);
      expect(refusing.lookups()).toBe(0);

      // A rule that allows, having told the fetch to stop: no lookup is started for a read that has ended.
      const allowing = counting();
      const stopperToo = new AbortController();
      const allowsAndStops = (): boolean => {
        stopperToo.abort(reason);
        return true;
      };
      await expect(
        guardedFetch(at('/page'), reach({ resolve: allowing.resolve, allowHost: allowsAndStops, signal: stopperToo.signal })),
      ).rejects.toBe(reason);
      expect(allowing.lookups()).toBe(0);

      // The same at a redirect: the first hop's host was resolved, the redirect's target never.
      const atTheRedirect = counting();
      const seen: string[] = [];
      const stopperAtTheRedirect = new AbortController();
      const stopsAtTheSecond = (host: string): boolean => {
        seen.push(host);
        if (seen.length === 2) stopperAtTheRedirect.abort(reason);
        return true;
      };
      await expect(
        guardedFetch(at('/redirect/1'), reach({ resolve: atTheRedirect.resolve, allowHost: stopsAtTheSecond, signal: stopperAtTheRedirect.signal })),
      ).rejects.toBe(reason);
      expect(seen).toEqual(['pages.test', 'pages.test']);
      expect(atTheRedirect.lookups()).toBe(1);
    });

    it('begins no connection for a read the rule ended at a literal address, which needs no lookup', async () => {
      const reason = new Error('the caller moved on');
      // A public address written as a literal reaches the connection step with
      // no lookup to end the read at. Blocked here, so no case reaches past
      // this machine if the step regresses.
      const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
        throw new Error('unexpected connection');
      });
      try {
        const stopper = new AbortController();
        const allowsAndStops = (): boolean => {
          stopper.abort(reason);
          return true;
        };
        await expect(
          guardedFetch('http://93.184.215.14/page', reach({ allowHost: allowsAndStops, allowPorts: [80], signal: stopper.signal })),
        ).rejects.toBe(reason);
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });
  });

  /** The addresses each new client socket tries to connect to, in order, while `run` runs. */
  async function attemptsDuring<T>(run: () => Promise<T>): Promise<{ result: T; attempts: string[] }> {
    const attempts: string[] = [];
    const onSocket = (message: unknown) => {
      (message as { socket: Socket }).socket.on('connectionAttempt', (address: string) => attempts.push(address));
    };
    diagnosticsChannel.subscribe('net.client.socket', onSocket);
    try {
      return { result: await run(), attempts };
    } finally {
      diagnosticsChannel.unsubscribe('net.client.socket', onSocket);
    }
  }

  it('tries the checked addresses in order, and reads at the next when the first cannot be reached', async () => {
    // The stand-in listens on 127.0.0.1 alone, so a connection to 127.0.0.2
    // on its port is refused, as an address unreachable from this network
    // (often a host's IPv6 one) would be.
    const both = ['127.0.0.2', '127.0.0.1'];
    const answers = (order: string[]) => async () => order.map((address) => ({ address, family: 4 }));

    const fallback = await attemptsDuring(() => guardedFetch(at('/page'), reach({ resolve: answers(both), allowAddresses: both })));
    expect(fallback.result.body.toString('utf8')).toBe(PAGE);
    expect(fallback.attempts).toEqual(['127.0.0.2', '127.0.0.1']);

    // The first address that answers is the one read: nothing after it is tried.
    const first = await attemptsDuring(() =>
      guardedFetch(at('/page'), reach({ resolve: answers(['127.0.0.1', '127.0.0.2']), allowAddresses: both })),
    );
    expect(first.result.status).toBe(200);
    expect(first.attempts).toEqual(['127.0.0.1']);
  });

  it('reads an answer with no Content-Type as application/octet-stream, for a caller that accepts that', async () => {
    const untyped = await guardedFetch(at('/untyped'), reach({ accept: ['audio/mpeg', 'application/octet-stream'] }));
    expect(untyped.contentType).toBe('application/octet-stream');
    expect(untyped.body).toEqual(Buffer.from([1, 2, 3, 4]));

    // The default types hold no application/octet-stream, so it is refused as before.
    expect(await reasonOf(guardedFetch(at('/untyped'), reach()))).toBe('type');
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

  it('refuses a declared length past the cap before the body is read', async () => {
    expect(await reasonOf(guardedFetch(at('/declared-held'), reach({ maxBytes: 1000, deadlineMs: 3_000 })))).toBe('size');
  });

  it('counts the bytes on the wire too: a body that decodes to little is refused once it arrives past the cap', async () => {
    expect(await reasonOf(guardedFetch(at('/gzip-padded'), reach({ maxBytes: 3000 })))).toBe('size');
    const read = await guardedFetch(at('/gzip-padded'), reach({ maxBytes: 6000 }));
    expect(read.body.toString('utf8')).toBe('<p>short</p>');
  });

  describe('an IPv6 address under a NAT64 prefix of this network', () => {
    /** A DNS64 network with the prefix 2600:1f14:abcd::/96: its resolver writes IPv4 addresses into IPv6 ones. */
    const dns64 = (address: string) => async (host: string) =>
      host === 'ipv4only.arpa'
        ? [
            { address: '192.0.0.170', family: 4 },
            { address: '2600:1f14:abcd::c000:aa', family: 6 },
          ]
        : [{ address, family: 6 }];

    it('is refused when it carries a private IPv4 address, though it looks public', async () => {
      const before = connections;
      // 10.0.0.1 under the prefix: public by its own range, private by what it carries.
      expect(isPublicAddress('2600:1f14:abcd::a00:1')).toBe(true);
      expect(await reasonOf(guardedFetch(at('/page'), reach({ resolve: dns64('2600:1f14:abcd::a00:1') })))).toBe('address');
      expect(connections).toBe(before);
    });

    it('passes the address check when it carries a public IPv4 address', async () => {
      const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
        throw new Error('unexpected connection');
      });
      try {
        // 8.8.8.8 under the prefix: the check passes, and the connection is the next step.
        expect(await reasonOf(guardedFetch(at('/page'), reach({ resolve: dns64('2600:1f14:abcd::808:808') })))).toBe('network');
        expect(connect).toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });

    it.each(['EAI_AGAIN', 'ENOTFOUND'])('is refused when the lookup of the prefixes fails with %s', async (code) => {
      // The lookup asks for every family, so a network without DNS64 still
      // answers ipv4only.arpa with its IPv4 addresses: a name that does not
      // resolve at all was filtered, and says nothing of NAT64.
      const before = connections;
      const resolve = async (host: string) => {
        if (host === 'ipv4only.arpa') throw Object.assign(new Error('the lookup failed'), { code });
        return [{ address: '2606:4700:4700::1111', family: 6 }];
      };
      await expect(guardedFetch(at('/page'), reach({ resolve }))).rejects.toMatchObject({
        reason: 'network',
        message: expect.stringContaining("NAT64 prefixes could not be read"),
      });
      expect(connections).toBe(before);
    });

    it('reads a network without DNS64 from its IPv4 answer, and clears a public IPv6 address', async () => {
      const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
        throw new Error('unexpected connection');
      });
      try {
        const resolve = async (host: string) =>
          host === 'ipv4only.arpa' ? [{ address: '192.0.0.170', family: 4 }] : [{ address: '2606:4700:4700::1111', family: 6 }];
        // The address check passes; the connection, blocked here, is the next step.
        expect(await reasonOf(guardedFetch(at('/page'), reach({ resolve })))).toBe('network');
        expect(connect).toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });
  });

  it.each(['deadline', 'caller'] as const)('ends held decoding on %s abort after the connection closes', async (source) => {
    const decoder = createGunzip();
    vi.mocked(createGunzip).mockReturnValueOnce(decoder);
    // The compressed bytes use the real decoder; only its final flush is held.
    const flush = vi.spyOn(decoder, '_flush');
    const held = new Promise<void>((resolve) => flush.mockImplementation(() => resolve()));
    const closed = new Promise<IncomingMessage>((resolve) => {
      decoder.once('pipe', (response: IncomingMessage) => {
        response.socket.once('close', () => resolve(response));
      });
    });
    const deadline = new AbortController();
    const caller = new AbortController();
    // Trigger the deadline only after the wire has closed, without a timing race.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const pending = guardedFetch(at('/gzip'), reach({ signal: caller.signal })).then(
      () => 'read',
      (error: unknown) => error,
    );
    try {
      const [response] = await Promise.all([closed, held]);
      expect(response.complete).toBe(true);
      expect(response.readableEnded).toBe(true);
      expect(decoder.destroyed).toBe(false);
      const reason = new Error('the caller moved on');
      if (source === 'deadline') deadline.abort();
      else caller.abort(reason);
      expect(response.destroyed).toBe(true);
      expect(decoder.destroyed).toBe(true);
      const outcome = await pending;
      if (source === 'deadline') {
        expect(outcome).toBeInstanceOf(GuardedFetchError);
        expect(outcome).toMatchObject({ reason: 'deadline' });
      } else {
        expect(outcome).toBe(reason);
      }
    } finally {
      decoder.destroy();
      await pending;
      flush.mockRestore();
      timeout.mockRestore();
      vi.mocked(createGunzip).mockReset();
    }
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
