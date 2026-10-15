/**
 * @fileoverview Secrets sealed at rest with AES-256-GCM: a random 96-bit nonce per seal, the key's id in the sealed
 * text so keys can turn over, and the caller's context (for example the row a grant belongs to) bound as additional
 * authenticated data, so a sealed value moved to another context does not open.
 *
 * Sealed text: `v1.<keyId>.<base64url(nonce | ciphertext | tag)>`.
 *
 * @module agentos/core/llm/auth/sealing
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A key with its id. */
export interface SealingKey {
  /** The id written into each sealed text: 1 to 32 letters, digits, `-` or `_`. */
  id: string;
  /** 32 bytes. */
  key: Uint8Array;
}

/** Why a sealed value did not open. */
export class SealedSecretError extends Error {
  /**
   * @param reason `format` for a text that is not a version 1 sealed text, `key` when none of the keys given has its
   * id, `tampered` when the key, the bytes or the context do not match what was sealed.
   */
  constructor(readonly reason: 'format' | 'key' | 'tampered') {
    super(`the sealed value did not open (${reason})`);
    this.name = 'SealedSecretError';
  }
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Seals `plain` under `key`, naming `keyId`, bound to `context`.
 *
 * @throws Error when `key` is not 32 bytes or `keyId` is not 1 to 32 letters, digits, `-` or `_`.
 */
export function sealSecret(plain: string | Uint8Array, key: Uint8Array, keyId: string, context = ''): string {
  if (key.length !== 32) throw new Error('sealSecret: the key must be 32 bytes');
  if (!KEY_ID.test(keyId)) throw new Error('sealSecret: a key id is 1 to 32 letters, digits, - or _');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), cipher.final(), cipher.getAuthTag()]);
  return `v1.${keyId}.${Buffer.concat([nonce, body]).toString('base64url')}`;
}

/**
 * Opens a sealed value with whichever of `keys` it names; answers the bytes.
 *
 * @throws SealedSecretError when the value does not open.
 */
export function openSecret(sealed: string, keys: readonly SealingKey[], context = ''): Uint8Array {
  const [version, keyId, payload] = sealed.split('.');
  if (version !== 'v1' || keyId === undefined || payload === undefined || sealed.split('.').length !== 3) throw new SealedSecretError('format');
  const key = keys.find((candidate) => candidate.id === keyId);
  if (key === undefined) throw new SealedSecretError('key');
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length < 12 + 16) throw new SealedSecretError('format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]));
  } catch {
    throw new SealedSecretError('tampered');
  }
}
