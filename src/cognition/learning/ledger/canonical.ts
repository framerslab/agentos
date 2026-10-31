/**
 * @module learning/ledger/canonical
 *
 * The text a ledger row's hash is taken over, and the hashes. Canonical JSON writes every object's members in the order
 * of their keys by UTF-16 code unit at every depth, keys that are array indexes among them (the order RFC 8785 sorts
 * keys in, https://www.rfc-editor.org/rfc/rfc8785#section-3.2.3), where `JSON.stringify` writes an array-index key
 * before every other key. It leaves out what `JSON.stringify` leaves out of an object (`undefined`, a function, a
 * symbol) and writes `null` for it in an array, keeps array order, writes a value with a `toJSON` method as what that
 * method returns (a date as its ISO string), and writes strings, numbers, booleans and `null` as `JSON.stringify`
 * does, so one entry has one text in every process. SHA-256 and HMAC-SHA-256 run on Node's `crypto`, or on Web Crypto
 * where there is no `process`.
 */
import { sha256 } from '../../memory/core/util/crossPlatformCrypto.js';

/** The `prevHash` of a chain's first row. */
export const GENESIS_HASH = '0'.repeat(64);

/** Whether `JSON.stringify` leaves a value out of an object, and writes `null` for it in an array. */
const omitted = (value: unknown): boolean => value === undefined || typeof value === 'function' || typeof value === 'symbol';

/**
 * A value's canonical text; `undefined` for a value JSON leaves out. `toJSON` is applied once, as `JSON.stringify`
 * applies it, and each member is read once. `ancestors` holds the objects being written around this one.
 */
function write(value: unknown, ancestors: Set<object>): string | undefined {
  const json =
    value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (omitted(json)) return undefined;
  if (json === null || typeof json !== 'object') return JSON.stringify(json);
  if (ancestors.has(json)) throw new TypeError('canonicalJson: a value that contains itself has no JSON form');
  ancestors.add(json);
  try {
    // Array.from visits a hole as `undefined`, which is written `null`, as JSON.stringify writes it.
    if (Array.isArray(json)) return `[${Array.from(json, (item) => write(item, ancestors) ?? 'null').join(',')}]`;
    const members: string[] = [];
    for (const key of Object.keys(json).sort()) {
      const text = write((json as Record<string, unknown>)[key], ancestors);
      if (text !== undefined) members.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(json);
  }
}

/**
 * The canonical JSON of a value; `null` for a value JSON leaves out.
 * @throws {TypeError} Where `JSON.stringify` throws: a value that contains itself, a bigint.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set<object>()) ?? 'null';
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
