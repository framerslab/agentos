import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret, SealedSecretError, type SealingKey } from '../sealing.js';

const k1: SealingKey = { id: 'k1', key: randomBytes(32) };
const k2: SealingKey = { id: 'k2', key: randomBytes(32) };

/** Why `sealed` did not open with `keys` under `context`, or `'opened'` when it did. */
function openReason(sealed: string, keys: readonly SealingKey[], context?: string): string {
  try {
    openSecret(sealed, keys, context);
    return 'opened';
  } catch (error) {
    if (error instanceof SealedSecretError) return error.reason;
    throw error;
  }
}

/** The text a sealed value opens to. */
function opened(sealed: string, keys: readonly SealingKey[], context?: string): string {
  return Buffer.from(openSecret(sealed, keys, context)).toString('utf8');
}

/**
 * Tests for {@link sealSecret} and {@link openSecret}: AES-256-GCM with a fresh nonce per seal, the key id in the
 * sealed text so keys turn over, and the caller's context bound as additional authenticated data.
 */
describe('sealSecret and openSecret', () => {
  it('opens a value with the key it names, alone or among turned-over keys, and names that key in the text', () => {
    const sealed = sealSecret('refresh-token-1', k1.key, k1.id, 'grant:1');

    expect(sealed.startsWith('v1.k1.')).toBe(true);
    expect(sealed).not.toContain('refresh-token-1');
    expect(opened(sealed, [k1], 'grant:1')).toBe('refresh-token-1');
    expect(opened(sealed, [k2, k1], 'grant:1')).toBe('refresh-token-1');
  });

  it('refuses a value whose key is not among the keys given', () => {
    const sealed = sealSecret('refresh-token-1', k1.key, k1.id, 'grant:1');

    expect(openReason(sealed, [k2], 'grant:1')).toBe('key');
    expect(openReason(sealed, [], 'grant:1')).toBe('key');
  });

  it('refuses a value with one byte of its ciphertext changed, or opened under another context', () => {
    const sealed = sealSecret('refresh-token-1', k1.key, k1.id, 'grant:1');
    const [version, keyId, payload] = sealed.split('.');
    const bytes = Buffer.from(payload, 'base64url');
    // The ciphertext starts after the 12-byte nonce.
    bytes[12] ^= 0x01;
    const changed = `${version}.${keyId}.${bytes.toString('base64url')}`;

    expect(openReason(changed, [k1], 'grant:1')).toBe('tampered');
    // A sealed grant moved to another row does not open there.
    expect(openReason(sealed, [k1], 'grant:2')).toBe('tampered');
    expect(openReason(sealed, [k1])).toBe('tampered');
    expect(openReason(sealed, [k1], 'grant:1')).toBe('opened');
  });

  it('seals one value differently each time, with a fresh nonce', () => {
    const first = sealSecret('same value', k1.key, k1.id);
    const second = sealSecret('same value', k1.key, k1.id);

    expect(first).not.toBe(second);
    // The first 16 base64url characters of the payload are the 12-byte nonce.
    expect(first.split('.')[2].slice(0, 16)).not.toBe(second.split('.')[2].slice(0, 16));
    expect(opened(first, [k1])).toBe('same value');
    expect(opened(second, [k1])).toBe('same value');
  });

  it('refuses at seal time a key that is not 32 bytes and a key id outside letters, digits, - and _', () => {
    expect(() => sealSecret('value', randomBytes(16), 'k1')).toThrow(/32 bytes/);
    expect(() => sealSecret('value', randomBytes(33), 'k1')).toThrow(/32 bytes/);
    expect(() => sealSecret('value', k1.key, '')).toThrow(/key id/);
    expect(() => sealSecret('value', k1.key, 'k.1')).toThrow(/key id/);
    expect(() => sealSecret('value', k1.key, 'k'.repeat(33))).toThrow(/key id/);
    expect(sealSecret('value', k1.key, `${'k'.repeat(30)}-_`).startsWith(`v1.${'k'.repeat(30)}-_.`)).toBe(true);
  });

  it('refuses a sealed text of another version or another shape', () => {
    const sealed = sealSecret('value', k1.key, k1.id);

    expect(openReason(`v2.${sealed.slice('v1.'.length)}`, [k1])).toBe('format');
    expect(openReason('v1.k1', [k1])).toBe('format');
    expect(openReason(`${sealed}.more`, [k1])).toBe('format');
    // Shorter than a nonce and a tag.
    expect(openReason('v1.k1.AAAA', [k1])).toBe('format');
  });
});
