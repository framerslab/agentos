/**
 * @file sha256.test.ts
 * sha256Hex against the FIPS 180-4 example digests and against Node's
 * crypto on inputs around every padding boundary, multi-byte text and
 * byte views that start inside a larger buffer.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../sha256';

const nodeSha256 = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 example digests', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches Node for every length across the padding boundaries', () => {
    for (let length = 0; length <= 200; length++) {
      const text = Array.from({ length }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('');
      expect(sha256Hex(text), `length ${length}`).toBe(nodeSha256(text));
    }
  });

  it('hashes multi-byte text as UTF-8', () => {
    const text = 'naïve café 日本語 🚀 '.repeat(40);
    expect(sha256Hex(text)).toBe(nodeSha256(text));
  });

  it('hashes a byte view in place, from its own offset and length', () => {
    const buffer = new Uint8Array(300).map((_, i) => (i * 31) & 0xff);
    const view = buffer.subarray(7, 7 + 150);
    expect(sha256Hex(view)).toBe(nodeSha256(Buffer.from(view)));
  });

  it('matches Node on a megabyte input', () => {
    const text = 'x'.repeat(1_000_003);
    expect(sha256Hex(text)).toBe(nodeSha256(text));
  });
});
