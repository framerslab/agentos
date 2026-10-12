/**
 * @module channels/meetings/signing
 *
 * Three ways the channel authenticates, kept apart: the envelope a host signs
 * its outbound deliveries with, the per-run bearer token a worker presents on
 * its reports, and the box that seals a run's meeting url at rest. A
 * provider's own scheme (a platform's webhook signature) lives in that
 * provider.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { openSecret, sealSecret, type SealingKey } from '../../../core/llm/auth/sealing.js';

/** The three header names of the envelope. A host passes its own (a product's branded names are the product's policy, never the library's). */
export interface EnvelopeHeaderNames {
  /** The header that carries the delivery's id. */
  id: string;
  /** The header that carries the time the delivery was signed, in milliseconds since the epoch. */
  timestamp: string;
  /** The header that carries the signature. */
  signature: string;
}
/** The header names the envelope uses when a host passes none. */
export const DEFAULT_ENVELOPE_HEADERS: Readonly<EnvelopeHeaderNames> = { id: 'x-webhook-id', timestamp: 'x-webhook-timestamp', signature: 'x-webhook-signature' };
/** How far a delivery's timestamp may be from the receiver's clock. */
export const ENVELOPE_WINDOW_MS = 300_000;

/**
 * `v1,` then the base64 HMAC-SHA256 of `<id>.<timestamp>.<payload>` under the destination's secret.
 *
 * @param secret - The destination's nonempty secret, used as UTF-8 bytes without base64 decoding.
 * @param id - The delivery's id.
 * @param timestampMs - The time the delivery is signed, in milliseconds since the epoch.
 * @param payload - The body exactly as it is sent.
 * @throws Error when the secret is empty.
 */
export function signEnvelope(secret: string, id: string, timestampMs: number, payload: string): string {
  if (secret.length === 0) throw new Error('empty envelope secret');
  const mac = createHmac('sha256', secret).update(`${id}.${timestampMs}.${payload}`).digest('base64');
  return `v1,${mac}`;
}

/**
 * The three headers of one delivery: its id, its time and its {@link signEnvelope} signature.
 *
 * @param secret - The destination's secret.
 * @param id - The delivery's id.
 * @param timestampMs - The time the delivery is signed, in milliseconds since the epoch.
 * @param payload - The body exactly as it is sent.
 * @param names - The header names; {@link DEFAULT_ENVELOPE_HEADERS} when absent.
 */
export function envelopeHeaders(secret: string, id: string, timestampMs: number, payload: string, names: EnvelopeHeaderNames = DEFAULT_ENVELOPE_HEADERS): Record<string, string> {
  return {
    [names.id]: id,
    [names.timestamp]: String(timestampMs),
    [names.signature]: signEnvelope(secret, id, timestampMs, payload),
  };
}

// A header by its name, or by its name in lower case (Node's form for incoming headers); the first of a repeated header.
function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The receiving side: the three headers, the raw payload and the receiver's clock.
 *
 * @param secret - The destination's nonempty secret, used as UTF-8 bytes without base64 decoding.
 * @param headers - The delivery's headers; the timestamp must contain only ASCII digits and is authenticated literally.
 * @param payload - The body exactly as it arrived, before any parse.
 * @param nowMs - The receiver's clock, in milliseconds since the epoch.
 * @param options - `windowMs`, how far the delivery's time may be from `nowMs` ({@link ENVELOPE_WINDOW_MS} when absent); `names`, the header names ({@link DEFAULT_ENVELOPE_HEADERS} when absent).
 * @returns `{ valid: true }`, or `valid: false` with why: an empty secret, a header missing, a bad timestamp, a timestamp outside the window (including a NaN clock or window), or a signature that does not match.
 */
export function verifyEnvelope(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  payload: string,
  nowMs: number,
  options: { windowMs?: number; names?: EnvelopeHeaderNames } = {}
): { valid: boolean; error?: string } {
  if (secret.length === 0) return { valid: false, error: 'empty envelope secret' };
  const names = options.names ?? DEFAULT_ENVELOPE_HEADERS;
  const windowMs = options.windowMs ?? ENVELOPE_WINDOW_MS;
  const id = header(headers, names.id);
  const ts = header(headers, names.timestamp);
  const sig = header(headers, names.signature);
  if (!id || !ts || !sig) return { valid: false, error: 'missing envelope header' };
  if (/[^0-9]/.test(ts)) return { valid: false, error: 'bad timestamp' };
  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp)) return { valid: false, error: 'bad timestamp' };
  if (!(Math.abs(nowMs - timestamp) <= windowMs)) return { valid: false, error: 'outside the window' };
  const mac = createHmac('sha256', secret).update(`${id}.${ts}.${payload}`).digest('base64');
  const expected = Buffer.from(`v1,${mac}`);
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { valid: false, error: 'signature mismatch' };
  return { valid: true };
}

/** 32 random bytes, base64url: the bearer a worker presents on every report of one run. */
export function mintWorkerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The SHA-256 of a worker token, in hex: what the run's dispatch record keeps, never the token itself. */
export function hashWorkerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Whether `token` is the one whose hash is `hash`, compared in constant time.
 *
 * @param token - The bearer a report presented.
 * @param hash - The {@link hashWorkerToken} hash the run's dispatch record keeps.
 * @returns false as well when `hash` is not 64 hex digits.
 */
export function workerTokenMatches(token: string, hash: string): boolean {
  // hex decoding stops at the first character that is not a hex digit, so a longer value that starts with the hash would decode to it
  if (!/^[0-9a-f]{64}$/i.test(hash)) return false;
  const a = Buffer.from(hashWorkerToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// The key id the box writes into each sealed text. It is part of the stored form: a text sealed under one id opens only under that id.
const SECRET_BOX_KEY_ID = 'box';

/**
 * Seals a run's meeting url at rest under one 32-byte key the host holds, with
 * the library's AES-256-GCM sealing ({@link sealSecret}, {@link openSecret}): a
 * fresh nonce per seal, so one value seals to a different text each time, and
 * the text `v1.box.<base64url(nonce | ciphertext | tag)>`. A context given to
 * `seal` (the run's id) is bound into the text, so a text moved to another
 * run's row does not open there.
 */
export class SecretBox {
  private readonly key: SealingKey;

  /**
   * @param key - The host's key: 32 bytes. The box keeps a copy, so a host that wipes or reuses its buffer afterwards does not change the box's key.
   * @throws RangeError when `key` is not 32 bytes.
   */
  constructor(key: Buffer) {
    if (key.length !== 32) throw new RangeError('SecretBox needs a 32-byte key');
    this.key = { id: SECRET_BOX_KEY_ID, key: Buffer.from(key) };
  }

  /** Serialises only a redacted marker, never key bytes. */
  toJSON(): string {
    return '[SecretBox redacted]';
  }

  /**
   * Seals `plain`; the sealed text differs on every call.
   *
   * @param plain - The text to seal.
   * @param context - What the text belongs to (the run's id), bound into the text as additional authenticated data; `open` must be given the same. Empty when absent.
   */
  seal(plain: string, context = ''): string {
    return sealSecret(plain, this.key.key, this.key.id, context);
  }

  /**
   * Opens a text this box's key sealed.
   *
   * @param sealed - The sealed text.
   * @param context - The context the text was sealed with; empty when absent.
   * @throws SealedSecretError when the text is not a sealed text, was sealed under another key or with another context, or was changed.
   */
  open(sealed: string, context = ''): string {
    return Buffer.from(openSecret(sealed, [this.key], context)).toString('utf8');
  }
}
