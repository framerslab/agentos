/**
 * @file untrustedImageFetch.deadline.test.ts
 * The deadline of an untrusted fetch ends a decoder that is still working
 * after the response has ended. A response that has ended ignores `destroy`,
 * so ending the response alone left the decoder running and the fetch
 * returned after its deadline.
 *
 * zlib's gunzip is replaced by one that holds its output for a while after
 * its input has ended: the real one finishes within milliseconds, too short a
 * window to aim a test at.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** How long the replaced gunzip holds its output after its input has ended. */
const slow = vi.hoisted(() => ({ heldMs: 600 }));

vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  const { Transform } = await import('node:stream');
  return {
    ...zlib,
    createGunzip: () => {
      const chunks: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      return new Transform({
        transform(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
        flush(done) {
          timer = setTimeout(() => done(null, zlib.gunzipSync(Buffer.concat(chunks))), slow.heldMs);
        },
        destroy(error, done) {
          clearTimeout(timer);
          done(error);
        },
      });
    },
  };
});

import { fetchUntrustedImage } from '../untrustedImageFetch.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    // The whole body at once: the response ends long before the decoder does.
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
    res.end(gzipSync(PNG));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/image.png`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('the deadline of an untrusted fetch, with a decoder that outlasts the response', () => {
  it('reads the body when the decoder finishes in time', async () => {
    expect(await fetchUntrustedImage(url, { allowAddress: () => true, timeoutMs: 5_000 })).toEqual(PNG);
  });

  it('gives up at the deadline, not when the decoder is done', async () => {
    const started = Date.now();

    await expect(fetchUntrustedImage(url, { allowAddress: () => true, timeoutMs: 150 })).rejects.toThrow(
      'took longer than 150 ms',
    );
    // The decoder would have held the body until 600 ms.
    expect(Date.now() - started).toBeLessThan(450);
  });
});
