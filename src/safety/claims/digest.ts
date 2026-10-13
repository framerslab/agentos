/**
 * @module safety/claims/digest
 *
 * Canonical JSON and SHA-256 digests for evidence: object keys sorted at every depth, `undefined` members dropped,
 * arrays kept in order, and anything JSON cannot hold refused rather than coerced, so two writers of the same value get
 * the same digest.
 */
import { createHash } from 'node:crypto';

/**
 * The canonical JSON text of a value.
 *
 * @param value - Plain objects, arrays, strings, finite numbers, booleans and null.
 * @returns The text, with no whitespace.
 * @throws TypeError on a number that is not finite, a function, a symbol, a bigint, a cycle or an object that is not plain.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: a number that is not finite has no JSON form');
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new TypeError('canonicalJson: a cycle has no JSON form');
      seen.add(value);
      try {
        if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : encode(item, seen))).join(',')}]`;
        const proto = Object.getPrototypeOf(value) as unknown;
        if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only a plain object has a JSON form');
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record)
          .filter((key) => record[key] !== undefined)
          .sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], seen)}`).join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
  }
}

/**
 * SHA-256 in lower-case hex.
 *
 * @param data - Text, hashed as UTF-8, or bytes.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The digest of a value: `sha256Hex(canonicalJson(value))`. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
