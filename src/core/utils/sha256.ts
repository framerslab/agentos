/**
 * @fileoverview Synchronous SHA-256 (FIPS 180-4) in plain JavaScript.
 *
 * For digests that must be computed without awaiting and without Node's
 * crypto module: it gives the same result in Node.js, browsers, workers and
 * WebViews, including pages outside a secure context, where Web Crypto's
 * `subtle` API does not exist. Node's `crypto.createHash` is faster; use it
 * where Node-only code can import it.
 *
 * @module agentos/core/utils/sha256
 */

/** Round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash: the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/**
 * Folds one 64-byte block into the running state.
 *
 * @param state - The eight working hash words, updated in place.
 * @param block - A view over the message bytes.
 * @param offset - Byte offset of the block within `block`.
 * @param w - Scratch space for the 64-word message schedule.
 */
function compress(state: Int32Array, block: DataView, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i++) w[i] = block.getUint32(offset + i * 4);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }

  let a = state[0], b = state[1], c = state[2], d = state[3];
  let e = state[4], f = state[5], g = state[6], h = state[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

/**
 * The SHA-256 digest of a string (as UTF-8) or of raw bytes.
 *
 * @param input - A string, encoded as UTF-8 before hashing, or bytes.
 * @returns The 64-character lowercase hex digest.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const state = Int32Array.from(INITIAL_STATE);
  const w = new Uint32Array(64);

  // Whole blocks are read in place; only the tail is copied for padding.
  const fullBlocks = Math.floor(bytes.length / 64);
  const message = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let block = 0; block < fullBlocks; block++) compress(state, message, block * 64, w);

  // The tail: remaining bytes, a 1 bit, zero fill, then the message length in
  // bits as a 64-bit big-endian integer, ending on a block boundary.
  const rest = bytes.length - fullBlocks * 64;
  const tail = new Uint8Array(rest + 9 <= 64 ? 64 : 128);
  tail.set(bytes.subarray(fullBlocks * 64));
  tail[rest] = 0x80;
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(tail.length - 8, Math.floor(bytes.length / 0x20000000));
  tailView.setUint32(tail.length - 4, (bytes.length * 8) >>> 0);
  for (let offset = 0; offset < tail.length; offset += 64) compress(state, tailView, offset, w);

  let hex = '';
  for (const word of state) hex += (word >>> 0).toString(16).padStart(8, '0');
  return hex;
}
