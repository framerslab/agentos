import * as http from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { gzipSync } from 'node:zlib';

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
    ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED', message: expect.stringContaining('127.0.0.1') });
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
    ).rejects.toMatchObject({ code: 'IMAGE_URL_REFUSED', message: expect.stringContaining('169.254.169.254') });
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
