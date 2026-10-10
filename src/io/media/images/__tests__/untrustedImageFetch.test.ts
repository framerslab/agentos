import * as http from 'node:http';
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, type AddressInfo, type LookupFunction } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { imageToBuffer } from '../imageToBuffer.js';
import { fetchUntrustedImage } from '../untrustedImageFetch.js';

// The first bytes of a PNG and of a JPEG (SOI and the JFIF APP0 header).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

/** The paths the test server was asked for, in order, and the last request's headers. */
const received: string[] = [];
let lastHeaders: http.IncomingHttpHeaders = {};
let server: http.Server;
let port: number;

/** A resolver that answers every name with `address`, as a DNS server under an attacker's control can. */
function resolvesTo(address: string): LookupFunction {
  return (_hostname, options, callback) => {
    const family = address.includes(':') ? 6 : 4;
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** A resolver that answers every name with all of `addresses`, in that order, and counts its calls. */
function resolvesToAll(addresses: string[]): LookupFunction & { calls: number } {
  const lookup = ((_hostname, options, callback) => {
    lookup.calls += 1;
    const entries = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (options.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  }) as LookupFunction & { calls: number };
  lookup.calls = 0;
  return lookup;
}

/** Stands in for a public host: the test server's loopback address is allowed, nothing else. */
const serverOnly = (address: string) => address === '127.0.0.1';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.url ?? '');
    lastHeaders = req.headers;
    const redirect = (location: string) => {
      res.writeHead(302, { location });
      res.end();
    };
    switch (req.url) {
      case '/image.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
        return;
      case '/to-image':
        return redirect('/image.png');
      case '/to-private':
        return redirect('http://10.0.0.1/image.png');
      case '/to-name':
        return redirect(`http://metadata.example.test:${port}/image.png`);
      case '/to-file':
        return redirect('file:///etc/passwd');
      case '/loop':
        return redirect('/loop');
      case '/large':
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': 4096 });
        res.end(Buffer.alloc(4096));
        return;
      case '/large-chunked':
        // No content-length, so the body arrives chunked and its size is known only by reading it.
        res.writeHead(200, { 'content-type': 'image/png' });
        res.write(Buffer.alloc(2048));
        res.end(Buffer.alloc(2048));
        return;
      case '/gzip':
        // Sent gzip-encoded although the request asked for identity.
        res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
        res.end(gzipSync(PNG));
        return;
      case '/bomb':
        // About a kilobyte on the wire, a megabyte decoded.
        res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
        res.end(gzipSync(Buffer.alloc(1_000_000)));
        return;
      case '/zstd':
        res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'zstd' });
        res.end(PNG);
        return;
      case '/deflate':
        res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'deflate' });
        res.end(deflateSync(PNG));
        return;
      case '/br':
        res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'br' });
        res.end(brotliCompressSync(PNG));
        return;
      case '/silent':
        // Accepts the request and never answers it.
        return;
      case '/upgrade':
        // A protocol switch, written by hand: Node's own response cannot send a 101.
        req.socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        return;
      case '/slow-1':
      case '/slow-2':
      case '/slow-3':
        // Each hop answers within the deadline; the chain does not.
        setTimeout(() => redirect(`/slow-${Number((req.url ?? '').slice(-1)) + 1}`), 150);
        return;
      case '/stall':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.write(PNG.subarray(0, 4));
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
});

describe('fetchUntrustedImage', () => {
  it('reads an image from an allowed address', async () => {
    const image = await fetchUntrustedImage(`http://127.0.0.1:${port}/image.png`, { allowAddress: serverOnly });

    expect(image).toEqual(PNG);
  });

  it('follows a redirect to an allowed address', async () => {
    const image = await fetchUntrustedImage(`http://127.0.0.1:${port}/to-image`, { allowAddress: serverOnly });

    expect(image).toEqual(PNG);
    expect(received).toEqual(['/to-image', '/image.png']);
  });

  it('refuses a host name that resolves to this machine, and sends nothing', async () => {
    // A public-looking name whose DNS answers 127.0.0.1 is refused when the connection is made.
    await expect(
      fetchUntrustedImage(`http://images.example.test:${port}/image.png`, { lookup: resolvesTo('127.0.0.1') }),
    ).rejects.toMatchObject({
      code: 'IMAGE_URL_REFUSED',
      message: 'imageToBuffer: images.example.test does not resolve to a public network address.',
      resolvedAddress: '127.0.0.1',
    });
    expect(received).toEqual([]);
  });

  it('refuses a name when any one of its addresses is refused, in either order, and sends nothing', async () => {
    for (const addresses of [['127.0.0.1', '10.0.0.1'], ['10.0.0.1', '127.0.0.1']]) {
      await expect(
        fetchUntrustedImage(`http://images.example.test:${port}/image.png`, {
          allowAddress: serverOnly,
          lookup: resolvesToAll(addresses),
        }),
        addresses.join(', '),
      ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED' });
    }
    expect(received).toEqual([]);
  });

  it('fetches a host name from the address its own check passed, after one lookup', async () => {
    // A second lookup through the resolver would count twice, and a
    // connection through the system resolver, which does not know the name,
    // would never reach the test server.
    const lookup = resolvesToAll(['127.0.0.1']);
    const image = await fetchUntrustedImage(`http://images.example.test:${port}/image.png`, {
      allowAddress: serverOnly,
      lookup,
    });

    expect(image).toEqual(PNG);
    expect(lookup.calls).toBe(1);
    expect(received).toEqual(['/image.png']);
  });

  it('checks the address when Node asks the lookup for one address', async () => {
    // With automatic family selection off, Node calls the lookup without
    // options.all and connects to the one address it returns.
    const autoSelectFamily = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(false);
    try {
      expect(
        await fetchUntrustedImage(`http://images.example.test:${port}/image.png`, {
          allowAddress: serverOnly,
          lookup: resolvesToAll(['127.0.0.1']),
        }),
      ).toEqual(PNG);
      await expect(
        fetchUntrustedImage(`http://images.example.test:${port}/image.png`, { lookup: resolvesTo('127.0.0.1') }),
      ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED' });
    } finally {
      setDefaultAutoSelectFamily(autoSelectFamily);
    }
    expect(received).toEqual(['/image.png']);
  });

  it('opens a connection of its own, so it reuses no kept-alive socket another lookup opened', async () => {
    // Other code fetches the same URL through Node's global agent, which
    // keeps the socket alive, with a lookup that checks nothing.
    try {
      await new Promise<void>((resolve, reject) => {
        http
          .get(`http://images.example.test:${port}/image.png`, { lookup: resolvesTo('127.0.0.1') }, (response) => {
            response.resume();
            response.on('end', resolve);
          })
          .on('error', reject);
      });

      await expect(
        fetchUntrustedImage(`http://images.example.test:${port}/image.png`, { lookup: resolvesTo('127.0.0.1') }),
      ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED' });
      expect(received).toEqual(['/image.png']);
    } finally {
      http.globalAgent.destroy();
    }
  });

  it('gives a name that does not resolve the message a refused name gets, so neither tells which names exist', async () => {
    const notFound: LookupFunction = (hostname, _options, callback) => {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
    };
    const refused = await fetchUntrustedImage(`http://db.corp.example.test:${port}/x.png`, {
      lookup: resolvesTo('10.1.2.3'),
    }).catch((error: unknown) => error);
    const missing = await fetchUntrustedImage(`http://nosuch.corp.example.test:${port}/x.png`, {
      lookup: notFound,
    }).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: 'IMAGE_URL_REFUSED',
      message: 'imageToBuffer: db.corp.example.test does not resolve to a public network address.',
    });
    expect(missing).toMatchObject({
      code: 'IMAGE_URL_REFUSED',
      message: 'imageToBuffer: nosuch.corp.example.test does not resolve to a public network address.',
    });
    // The resolver's error stays on the error for logs, out of its message.
    expect((missing as { cause?: unknown }).cause).toMatchObject({ code: 'ENOTFOUND' });
    expect(received).toEqual([]);
  });

  it('connects to the address its own check passed, and to no other', async () => {
    // The checked answer is a documentation address no host serves, so the
    // request can only fail; the resolver ran once, and the server saw nothing.
    const lookup = resolvesToAll(['203.0.113.7']);
    await expect(
      fetchUntrustedImage(`http://images.example.test:${port}/image.png`, {
        allowAddress: (address) => address === '203.0.113.7',
        lookup,
        timeoutMs: 500,
      }),
    ).rejects.toThrow();
    expect(lookup.calls).toBe(1);
    expect(received).toEqual([]);
  });

  it('refuses an IPv6 literal of this machine, in brackets, before connecting', async () => {
    for (const host of ['[::1]', '[::ffff:127.0.0.1]']) {
      await expect(fetchUntrustedImage(`http://${host}:${port}/image.png`), host).rejects.toMatchObject({
        code: 'IMAGE_URL_REFUSED',
      });
    }
    expect(received).toEqual([]);
  });

  it('refuses a redirect to a private address', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/to-private`, { allowAddress: serverOnly }),
    ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED', message: expect.stringContaining('10.0.0.1') });
  });

  it('refuses a redirect to a name that resolves to the cloud metadata address', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/to-name`, {
        allowAddress: serverOnly,
        lookup: resolvesTo('169.254.169.254'),
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED', resolvedAddress: '169.254.169.254' });
    expect(received).toEqual(['/to-name']);
  });

  it('refuses a redirect to a file URL', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/to-file`, { allowAddress: serverOnly }),
    ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED', message: expect.stringContaining('file:') });
  });

  it('stops after five redirects', async () => {
    await expect(fetchUntrustedImage(`http://127.0.0.1:${port}/loop`, { allowAddress: serverOnly })).rejects.toThrow(
      'redirected more than 5 times',
    );
    expect(received).toHaveLength(6);
  });

  it('refuses a response whose declared length is over the limit', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/large`, { allowAddress: serverOnly, maxBytes: 1024 }),
    ).rejects.toThrow('larger than 1024 bytes');
  });

  it('stops reading a response without a length once it passes the limit', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/large-chunked`, { allowAddress: serverOnly, maxBytes: 3000 }),
    ).rejects.toThrow('larger than 3000 bytes');
  });

  it('gives up on a response that stalls', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/stall`, { allowAddress: serverOnly, timeoutMs: 300 }),
    ).rejects.toThrow('took longer than 300 ms');
  });

  it('asks for identity, and decodes a gzip body a server sends anyway', async () => {
    const image = await fetchUntrustedImage(`http://127.0.0.1:${port}/gzip`, { allowAddress: serverOnly });

    expect(image).toEqual(PNG);
    expect(lastHeaders['accept-encoding']).toBe('identity');
  });

  it('decodes a deflate or br body a server sends anyway', async () => {
    for (const route of ['/deflate', '/br']) {
      expect(await fetchUntrustedImage(`http://127.0.0.1:${port}${route}`, { allowAddress: serverOnly }), route).toEqual(PNG);
    }
  });

  it('gives up on a server that never sends its headers', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/silent`, { allowAddress: serverOnly, timeoutMs: 300 }),
    ).rejects.toThrow('took longer than 300 ms');
  });

  it('gives up on a redirect chain whose hops each answer in time but not all of them together', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/slow-1`, { allowAddress: serverOnly, timeoutMs: 400 }),
    ).rejects.toThrow('took longer than 400 ms');
  });

  it('refuses a protocol upgrade at once, instead of waiting past the deadline', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/upgrade`, { allowAddress: serverOnly, timeoutMs: 10_000 }),
    ).rejects.toThrow('answered with a protocol upgrade');
  }, 5_000);

  it('stops decoding a compressed body once it passes the limit', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/bomb`, { allowAddress: serverOnly, maxBytes: 10_000 }),
    ).rejects.toThrow('larger than 10000 bytes');
  });

  it('refuses a content coding it does not decode', async () => {
    await expect(fetchUntrustedImage(`http://127.0.0.1:${port}/zstd`, { allowAddress: serverOnly })).rejects.toThrow(
      'content coding the fetch does not decode (zstd)',
    );
  });

  it.each<['maxBytes' | 'timeoutMs', number]>([
    ['maxBytes', Number.NaN],
    ['maxBytes', Number.POSITIVE_INFINITY],
    ['maxBytes', 0],
    ['maxBytes', -1],
    ['timeoutMs', Number.NaN],
    ['timeoutMs', Number.POSITIVE_INFINITY],
    ['timeoutMs', 2 ** 31],
  ])('refuses %s %s before connecting', async (name, value) => {
    const limits = name === 'maxBytes' ? { maxBytes: value } : { timeoutMs: value };
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/image.png`, { allowAddress: serverOnly, ...limits }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(received).toEqual([]);
  });

  it('reports a status other than 2xx with the URL but not its query', async () => {
    await expect(
      fetchUntrustedImage(`http://127.0.0.1:${port}/missing.png?token=secret`, { allowAddress: serverOnly }),
    ).rejects.toThrow(`failed to fetch image from http://127.0.0.1:${port}/missing.png (404 Not Found).`);
  });
});

describe('imageToBuffer with untrusted input', () => {
  it('refuses this machine, by address and by name, before sending anything', async () => {
    await expect(imageToBuffer(`http://127.0.0.1:${port}/image.png`, { untrusted: true })).rejects.toMatchObject({
      code: 'IMAGE_URL_REFUSED',
    });
    await expect(imageToBuffer(`http://localhost:${port}/image.png`, { untrusted: true })).rejects.toMatchObject({
      code: 'IMAGE_URL_REFUSED',
    });
    expect(received).toEqual([]);
  });

  it('reads the URL scheme in any case', async () => {
    // HTTP:// and HTTPS:// are fetched under the untrusted rules (refused
    // here), not read as paths, which would give IMAGE_LOCAL_FILE_REFUSED.
    for (const scheme of ['HTTP', 'HTTPS']) {
      await expect(
        imageToBuffer(`${scheme}://127.0.0.1:${port}/image.png`, { untrusted: true }),
        scheme,
      ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED' });
    }
  });

  it('reads no local file', async () => {
    for (const input of ['/etc/hosts', 'file:///etc/hosts', '../photo.png', 'C:\\photos\\cat.png']) {
      await expect(imageToBuffer(input, { untrusted: true }), input).rejects.toMatchObject({
        code: 'IMAGE_LOCAL_FILE_REFUSED',
      });
    }
  });

  it('still decodes raw base64 of an image that contains "/"', async () => {
    expect(await imageToBuffer(JPEG_START.toString('base64'), { untrusted: true })).toEqual(JPEG_START);
  });
});
