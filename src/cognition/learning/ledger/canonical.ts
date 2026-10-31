/**
 * @module learning/ledger/canonical
 *
 * The text a ledger row's hash is taken over, and the hashes. Canonical JSON sorts every object's keys by UTF-16 code
 * unit, drops `undefined`, keeps array order, writes a value with a `toJSON` method as what that method returns (a date
 * as its ISO string), and writes numbers as `JSON.stringify` does, so one entry has one text in every process.
 * SHA-256 and HMAC-SHA-256 run on Node's `crypto`, or on Web Crypto where there is no `process`.
 */
import { sha256 } from '../../memory/core/util/crossPlatformCrypto.js';

/** The `prevHash` of a chain's first row. */
export const GENESIS_HASH = '0'.repeat(64);

/** Whether `JSON.stringify` leaves a value out of an object, and writes `null` for it in an array. */
const omitted = (value: unknown): boolean => value === undefined || typeof value === 'function' || typeof value === 'symbol';

/** What `JSON.stringify` writes for a value, every object's keys sorted: `toJSON` is applied once, as it applies it. */
function sortValue(value: unknown): unknown {
  const json =
    value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (Array.isArray(json)) return json.map((item) => (omitted(item) ? null : sortValue(item)));
  if (json !== null && typeof json === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(json).sort()) {
      const item = (json as Record<string, unknown>)[key];
      if (!omitted(item)) out[key] = sortValue(item);
    }
    return out;
  }
  return json;
}

/** The canonical JSON of a value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** SHA-256 of a text, as lowercase hexadecimal. */
export function sha256Hex(text: string): Promise<string> {
  return sha256(text);
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/** HMAC-SHA-256 of a text under a key, as lowercase hexadecimal. */
export async function hmacSha256Hex(key: string, text: string): Promise<string> {
  if (isNode) {
    const { createHmac } = await import('node:crypto');
    return createHmac('sha256', key).update(text, 'utf8').digest('hex');
  }
  const encoder = new TextEncoder();
  const cryptoKey = await globalThis.crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(text));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

let agentosVersionRead: Promise<string> | undefined;

/**
 * The version of the `@framers/agentos` package this code runs from, read once from its `package.json` (the nearest
 * one above this module named `@framers/agentos`, as the forged-tool broker finds the package's own directory);
 * `'unknown'` where there is no file system.
 */
export function agentosVersion(): Promise<string> {
  agentosVersionRead ??= (async () => {
    if (!isNode) return 'unknown';
    try {
      const [{ readFile }, { fileURLToPath }, path] = await Promise.all([
        import('node:fs/promises'),
        import('node:url'),
        import('node:path'),
      ]);
      let dir = path.dirname(fileURLToPath(import.meta.url));
      for (let depth = 0; depth < 8; depth += 1) {
        try {
          const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
          if (manifest.name === '@framers/agentos' && typeof manifest.version === 'string') return manifest.version;
        } catch {
          // No manifest at this level.
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // A bundle with no file URL.
    }
    return 'unknown';
  })();
  return agentosVersionRead;
}
