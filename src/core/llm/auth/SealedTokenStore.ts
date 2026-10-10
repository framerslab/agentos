/**
 * @fileoverview An IOAuthTokenStore that keeps a grant's refresh token and metadata sealed, through three functions
 * the caller gives, and never keeps an access token: a loaded grant answers `accessToken: ''` and `expiresAt: 0`, so
 * the flow refreshes it and holds the access token in memory.
 *
 * @module agentos/core/llm/auth/SealedTokenStore
 */

import { openSecret, sealSecret, type SealingKey } from './sealing.js';
import type { IOAuthTokenStore, OAuthTokenSet } from './types.js';

/** Where sealed values live, by key: a row of the caller's database, for example. */
export interface SealedBytesStore {
  /** The sealed text kept under `key`, or null when there is none. */
  get(key: string): Promise<string | null>;
  /** Keeps `sealed` under `key`, replacing what was there. */
  set(key: string, sealed: string): Promise<void>;
  /** Removes what is kept under `key`. */
  delete(key: string): Promise<void>;
}

/** The keys: the current one seals, every one listed opens. */
export interface SealingKeys {
  /** The key every save seals with. */
  current: SealingKey;
  /** Keys turned over: what they sealed still opens, and is sealed with `current` at its next save. */
  previous?: readonly SealingKey[];
}

/**
 * Keeps each grant under its key as one sealed text holding the refresh token and the metadata, bound to that key
 * (a sealed grant copied to another key does not open there). The access token and the id token are never kept.
 * A value that does not open makes `load` throw `SealedSecretError`.
 */
export class SealedTokenStore implements IOAuthTokenStore {
  /**
   * @param values Where the sealed texts live.
   * @param keys The current key and any previous ones.
   */
  constructor(private readonly values: SealedBytesStore, private readonly keys: SealingKeys) {}

  /**
   * The grant kept under `key`: its refresh token and metadata, with `accessToken: ''` and `expiresAt: 0` so a flow
   * refreshes it; null when nothing is kept.
   *
   * @throws SealedSecretError when the kept value does not open with the keys given.
   */
  async load(key: string): Promise<OAuthTokenSet | null> {
    const sealed = await this.values.get(key);
    if (sealed === null) return null;
    const kept = JSON.parse(Buffer.from(openSecret(sealed, [this.keys.current, ...(this.keys.previous ?? [])], key)).toString('utf8')) as Pick<OAuthTokenSet, 'refreshToken' | 'metadata'>;
    return { accessToken: '', expiresAt: 0, refreshToken: kept.refreshToken, metadata: kept.metadata };
  }

  /** Seals the refresh token and the metadata of `tokens` with the current key, bound to `key`, and keeps them. */
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    const kept = JSON.stringify({ refreshToken: tokens.refreshToken, metadata: tokens.metadata });
    await this.values.set(key, sealSecret(kept, this.keys.current.key, this.keys.current.id, key));
  }

  /** Removes the grant kept under `key`. */
  async clear(key: string): Promise<void> {
    await this.values.delete(key);
  }
}
