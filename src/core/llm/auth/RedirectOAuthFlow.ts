/**
 * @fileoverview OAuth 2.0's authorization code grant with PKCE for a web server: `begin` makes the address and answers
 * the state and the verifier for the caller to keep (a row keyed by a cookie, for example); `complete` checks the state
 * in constant time and exchanges the code; refreshes run one at a time per stored grant, the access token held in this
 * process's memory alone (the store is handed a grant's refresh token and metadata, never its access token or id
 * token); `revoke` where the provider has an endpoint. The token endpoint's calls are the standard ones by default
 * (RFC 6749 sections 4.1.3 and 6, a form body, a JSON answer); a provider overrides them.
 *
 * @module agentos/core/llm/auth/RedirectOAuthFlow
 */

import { timingSafeEqual } from 'node:crypto';
import type { BrowserOAuthConfig } from './BrowserOAuthFlow.js';
import { generateCodeChallenge, generateCodeVerifier, generateState } from './pkce.js';
import type { IOAuthTokenStore, OAuthTokenSet } from './types.js';

/** A provider's endpoints and client. */
export interface RedirectOAuthConfig extends Pick<BrowserOAuthConfig, 'authorizationEndpoint' | 'tokenEndpoint' | 'scopes' | 'clientId' | 'clientSecret' | 'refreshBufferMs'> {
  /** The provider's token revocation endpoint (RFC 7009), when it has one. */
  revocationEndpoint?: string;
}

/** What `begin` answers: the address to send the person to, and what the caller keeps until `complete`. */
export interface RedirectBegin {
  /** The authorization endpoint's address with the request's parameters. */
  url: string;
  /** The `state` sent in the address; `complete` takes it back as `expectedState`. */
  state: string;
  /** The PKCE verifier whose S256 challenge the address carries; `complete` sends it with the code. */
  codeVerifier: string;
}

/** What `complete` takes. */
export interface RedirectCompleteInput {
  /** The `code` the provider returned. */
  code: string;
  /** The `state` the provider returned. */
  state: string;
  /** The state `begin` answered, kept by the caller. */
  expectedState: string;
  /** The verifier `begin` answered, kept by the caller. */
  codeVerifier: string;
  /** The redirect address given to `begin`. */
  redirectUri: string;
}

/** A grant the provider or the check refused; its message holds no code, verifier or token. */
export class OAuthGrantRefused extends Error {
  /**
   * @param reason `state` when the returned state is not the one kept, `exchange` or `refresh` when the token
   * endpoint refused, `revoke` when the revocation endpoint refused, `missing` when no grant with a refresh token is
   * kept under the key asked for.
   * @param status The HTTP status the provider answered, when it answered.
   * @param providerError The `error` code of the provider's answer, when it gave one.
   */
  constructor(readonly reason: 'state' | 'exchange' | 'refresh' | 'revoke' | 'missing', readonly status?: number, readonly providerError?: string) {
    super(`the grant was refused (${reason}${status === undefined ? '' : `, ${status}`}${providerError ? `, ${providerError}` : ''})`);
    this.name = 'OAuthGrantRefused';
  }
}

/**
 * What a store is handed for a grant: its refresh token and metadata, which are all the flow reads back, with
 * `accessToken: ''` and `expiresAt: 0` in place of the access token. The access token and the id token stay in the
 * flow's memory, so a store is never given them to write.
 */
function storedGrant(tokens: OAuthTokenSet): OAuthTokenSet {
  return { accessToken: '', expiresAt: 0, refreshToken: tokens.refreshToken, metadata: tokens.metadata };
}

/**
 * The authorization code grant with PKCE split across a web server's two requests: `begin` in the request that sends
 * the person to the provider, `complete` in the request the provider redirects back to. A provider's flow extends it
 * with `providerId` and `getConfig`, and overrides the token calls where its endpoints differ from the standard ones.
 * Within one flow, `keep`, a refresh and `forget` of the same key run one after another. Flows that share a store do
 * not take turns with each other: an `IOAuthTokenStore` has no way to claim a key.
 */
export abstract class RedirectOAuthFlow {
  /** The provider's id. */
  abstract readonly providerId: string;
  private readonly refreshing = new Map<string, Promise<OAuthTokenSet>>();
  private readonly held = new Map<string, OAuthTokenSet>();
  /** The last change queued for each key; it settles, never rejects, when that change ends. */
  private readonly turns = new Map<string, Promise<void>>();

  /**
   * @param store Where grants are kept by key, a `SealedTokenStore` on a server; null for a flow that only
   * begins, completes and revokes. It is handed a grant's refresh token and metadata alone.
   * @param fetchImpl The fetch the endpoints are called with.
   */
  constructor(protected readonly store: IOAuthTokenStore | null, protected readonly fetchImpl: typeof fetch = fetch) {}

  /** The provider's endpoints and client. */
  protected abstract getConfig(): RedirectOAuthConfig;

  /**
   * Exchanges a code; the standard form post by default, with the client id and, when configured, the client secret
   * in the form (RFC 6749 section 2.3.1's request-body credentials). A provider that takes HTTP Basic alone overrides
   * this and `refreshTokens`.
   */
  protected async exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<OAuthTokenSet> {
    const config = this.getConfig();
    return this.tokenRequest('exchange', { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier, client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) });
  }

  /** Refreshes; the standard form post by default, the client's credentials in the form as `exchangeCode` sends them. */
  protected async refreshTokens(refreshToken: string): Promise<OAuthTokenSet> {
    const config = this.getConfig();
    return this.tokenRequest('refresh', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) });
  }

  /** A provider's extra step after an exchange. */
  protected async postExchange(tokens: OAuthTokenSet): Promise<OAuthTokenSet> {
    return tokens;
  }

  /**
   * The token endpoint's call, read as JSON. An answer that is not a success, or whose `access_token` is missing or
   * empty, throws {@link OAuthGrantRefused} with the status and the answer's `error`; an answer without `expires_in`
   * is taken to last an hour.
   */
  protected async tokenRequest(reason: 'exchange' | 'refresh', form: Record<string, string>): Promise<OAuthTokenSet> {
    const response = await this.fetchImpl(this.getConfig().tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // An empty `access_token` is refused like a missing one: in this flow `''` stands for no access token in hand.
    if (!response.ok || typeof answer.access_token !== 'string' || answer.access_token === '') {
      throw new OAuthGrantRefused(reason, response.status, typeof answer.error === 'string' ? answer.error : undefined);
    }
    const expiresIn = typeof answer.expires_in === 'number' ? answer.expires_in : 3600;
    return {
      accessToken: answer.access_token,
      refreshToken: typeof answer.refresh_token === 'string' ? answer.refresh_token : undefined,
      expiresAt: Date.now() + expiresIn * 1000,
      idToken: typeof answer.id_token === 'string' ? answer.id_token : undefined,
      metadata: typeof answer.scope === 'string' ? { scope: answer.scope } : undefined,
    };
  }

  /**
   * The address to send the person to, with the state and the verifier to keep. `scopes` replaces the configured
   * scopes for this request; `extraParams` are added to the address (for example `access_type` and `prompt`). An
   * extra parameter with the name of one the flow sets (`response_type`, `client_id`, `redirect_uri`, `scope`,
   * `state`, `code_challenge` or `code_challenge_method`) is left out, so the address always carries the state
   * answered and the challenge of the verifier answered. A query the configured authorization endpoint already has is
   * kept (RFC 6749 section 3.1), except that a parameter in it with the name of one added here is replaced, so no
   * parameter is sent twice. Throws a `TypeError` when the authorization endpoint is not an absolute address.
   */
  begin(input: { redirectUri: string; extraParams?: Record<string, string>; scopes?: readonly string[] }): RedirectBegin {
    const config = this.getConfig();
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const params = new URLSearchParams({
      // First, so that none of them replaces a parameter set below.
      ...input.extraParams,
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: input.redirectUri,
      scope: (input.scopes ?? config.scopes).join(' '),
      state,
      code_challenge: generateCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    const address = new URL(config.authorizationEndpoint);
    // `set`, not a second `?`: the endpoint's own query stays, and a parameter of the same name in it is replaced.
    for (const [name, value] of params) address.searchParams.set(name, value);
    return { url: address.toString(), state, codeVerifier };
  }

  /**
   * Checks the state and exchanges the code; answers the token set. A state that is not the one kept, or an empty
   * kept state, throws {@link OAuthGrantRefused} with reason `state` before any call.
   */
  async complete(input: RedirectCompleteInput): Promise<OAuthTokenSet> {
    const given = Buffer.from(input.state, 'utf8');
    const expected = Buffer.from(input.expectedState, 'utf8');
    if (expected.length === 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OAuthGrantRefused('state');
    return this.postExchange(await this.exchangeCode(input.code, input.redirectUri, input.codeVerifier));
  }

  /**
   * Keeps a grant under `key` in the store and holds it in this process's memory, once a refresh or `forget` of `key`
   * already under way has ended. The store is handed the grant's refresh token and metadata alone, with
   * `accessToken: ''` and `expiresAt: 0`; the access token and the id token stay in memory.
   */
  async keep(key: string, tokens: OAuthTokenSet): Promise<void> {
    const store = this.store;
    if (store === null) throw new Error('this flow has no store');
    await this.inTurn(key, async () => {
      await store.save(key, storedGrant(tokens));
      this.held.set(key, tokens);
    });
  }

  /**
   * A usable access token for the grant kept under `key`, refreshed once at a time when needed, after a `keep` or
   * `forget` of `key` already under way. Throws {@link OAuthGrantRefused} with reason `missing` when no grant with a
   * refresh token is kept under `key`, and with reason `refresh` when the provider refuses the refresh.
   */
  async accessToken(key: string): Promise<string> {
    const held = this.held.get(key);
    const buffer = this.getConfig().refreshBufferMs ?? 300_000;
    if (held !== undefined && held.accessToken !== '' && Date.now() < held.expiresAt - buffer) return held.accessToken;
    let pending = this.refreshing.get(key);
    if (pending === undefined) {
      pending = this.inTurn(key, () => this.refreshKept(key)).finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, pending);
    }
    return (await pending).accessToken;
  }

  /**
   * Runs `change` once every change of `key` queued before it has ended, so a refresh in flight cannot write a grant
   * back after `forget` cleared it, or over one that `keep` saved meanwhile.
   */
  private async inTurn<T>(key: string, change: () => Promise<T>): Promise<T> {
    const before = this.turns.get(key);
    let end!: () => void;
    const turn = new Promise<void>((resolve) => {
      end = resolve;
    });
    // Set before the first await, so changes queue in the order they were asked for.
    this.turns.set(key, turn);
    try {
      if (before !== undefined) await before;
      return await change();
    } finally {
      if (this.turns.get(key) === turn) this.turns.delete(key);
      end();
    }
  }

  private async refreshKept(key: string): Promise<OAuthTokenSet> {
    if (this.store === null) throw new Error('this flow has no store');
    const kept = await this.store.load(key);
    if (kept === null || kept.refreshToken === undefined) throw new OAuthGrantRefused('missing');
    const fresh = await this.refreshTokens(kept.refreshToken);
    const merged: OAuthTokenSet = { ...fresh, refreshToken: fresh.refreshToken ?? kept.refreshToken, metadata: fresh.metadata ?? kept.metadata };
    if (merged.refreshToken !== kept.refreshToken || merged.metadata !== kept.metadata) {
      await this.store.save(key, storedGrant(merged));
    }
    this.held.set(key, merged);
    return merged;
  }

  /**
   * Revokes a token at the provider's revocation endpoint, posting the token alone as a form (RFC 7009 section 2.1).
   * A provider that asks the client to authenticate there overrides this. Throws when no revocation endpoint is
   * configured, and {@link OAuthGrantRefused} with reason `revoke` when the endpoint does not answer a success.
   */
  async revoke(token: string): Promise<void> {
    const endpoint = this.getConfig().revocationEndpoint;
    if (endpoint === undefined) throw new Error(`${this.providerId} has no revocation endpoint`);
    const response = await this.fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
    if (!response.ok) throw new OAuthGrantRefused('revoke', response.status);
  }

  /**
   * Revokes the kept grant where possible and clears it whatever the provider answered; answers whether it revoked.
   * It runs once a refresh or `keep` of `key` already under way has ended, so it revokes the refresh token that
   * refresh left.
   */
  async forget(key: string): Promise<{ revoked: boolean }> {
    const store = this.store;
    if (store === null) throw new Error('this flow has no store');
    return this.inTurn(key, async () => {
      let revoked = false;
      try {
        const kept = await store.load(key);
        if (kept?.refreshToken) {
          await this.revoke(kept.refreshToken);
          revoked = true;
        }
      } catch {
        revoked = false;
      } finally {
        this.held.delete(key);
        await store.clear(key);
      }
      return { revoked };
    });
  }
}
