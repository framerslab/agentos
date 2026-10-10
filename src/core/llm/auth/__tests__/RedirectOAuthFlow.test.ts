import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTokenStore } from '../FileTokenStore.js';
import { OAuthGrantRefused, RedirectOAuthFlow, type RedirectOAuthConfig } from '../RedirectOAuthFlow.js';
import { SealedTokenStore, type SealedBytesStore } from '../SealedTokenStore.js';
import type { IOAuthTokenStore } from '../types.js';

const REDIRECT = 'https://app.example.test/oauth/callback';

/** A provider's flow as a subclass writes one: its endpoints and client, and the standard token calls. */
class ExampleFlow extends RedirectOAuthFlow {
  readonly providerId = 'example';

  constructor(store: IOAuthTokenStore | null, fetchImpl: typeof fetch, private readonly revocation?: string) {
    super(store, fetchImpl);
  }

  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: 'https://auth.example.test/authorize',
      tokenEndpoint: 'https://auth.example.test/token',
      revocationEndpoint: this.revocation,
      scopes: ['files.read', 'profile'],
      clientId: 'client-1',
      clientSecret: 'client-secret-1',
    };
  }
}

/** One request the flow sent: where it went, its form and its headers. */
interface Sent {
  url: string;
  form: URLSearchParams;
  headers: Headers;
}

/** A fetch stand-in that keeps every request and answers each with `answer`. */
function endpoint(answer: (sent: Sent) => Response | Promise<Response>): { sent: Sent[]; fetchImpl: typeof fetch } {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const request: Sent = {
      url,
      form: new URLSearchParams(String(init?.body ?? '')),
      headers: new Headers(init?.headers),
    };
    sent.push(request);
    return answer(request);
  });
  return { sent, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** A JSON answer with `status`. */
function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A sealed store over a Map, as a web server keeps its grants. */
function sealedStore(): { rows: Map<string, string>; store: SealedTokenStore } {
  const rows = new Map<string, string>();
  const values: SealedBytesStore = {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, sealed) => {
      rows.set(key, sealed);
    },
    delete: async (key) => {
      rows.delete(key);
    },
  };
  return { rows, store: new SealedTokenStore(values, { current: { id: 'k1', key: randomBytes(32) } }) };
}

/** What `promise` rejected with; fails when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Tests for {@link RedirectOAuthFlow}: the authorization code grant with PKCE split across a web server's two
 * requests, the flow's own parameters kept whatever extraParams name, an authorization endpoint's own query kept, the
 * state checked before any call, the standard token calls with an empty access token refused, one refresh at a time
 * per kept grant with the access token held in memory and never handed to the store, revocation, and keep, refresh
 * and forget of one key taking turns.
 */
describe('RedirectOAuthFlow', () => {
  it('begins with an address on the authorization endpoint, answering a new state and verifier to keep', () => {
    const { sent, fetchImpl } = endpoint(() => json(500, {}));
    const flow = new ExampleFlow(null, fetchImpl);

    const first = flow.begin({ redirectUri: REDIRECT, extraParams: { access_type: 'offline', prompt: 'consent' } });

    const address = new URL(first.url);
    expect(`${address.origin}${address.pathname}`).toBe('https://auth.example.test/authorize');
    const params = address.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('client-1');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('scope')).toBe('files.read profile');
    expect(params.get('state')).toBe(first.state);
    expect(params.get('code_challenge')).toBe(createHash('sha256').update(first.codeVerifier).digest('base64url'));
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toBe('consent');
    // RFC 7636 section 4.1: 43 to 128 unreserved characters. The verifier and the secret stay with the caller.
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(params.has('code_verifier')).toBe(false);
    expect(params.has('client_secret')).toBe(false);

    const second = flow.begin({ redirectUri: REDIRECT, scopes: ['files.read'] });
    expect(second.state).not.toBe(first.state);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
    expect(new URL(second.url).searchParams.get('scope')).toBe('files.read');
    expect(new URL(second.url).searchParams.has('prompt')).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('sets its own parameters whatever extraParams name, so the address carries the state and the challenge of the verifier it answers', () => {
    const { fetchImpl } = endpoint(() => json(500, {}));
    const flow = new ExampleFlow(null, fetchImpl);

    // Every name the flow sets, each with another value, and one name it does not set.
    const begun = flow.begin({
      redirectUri: REDIRECT,
      extraParams: {
        response_type: 'token',
        client_id: 'client-2',
        redirect_uri: 'https://elsewhere.example.test/callback',
        scope: 'admin',
        state: 'chosen-state',
        code_challenge: 'chosen-challenge',
        code_challenge_method: 'plain',
        prompt: 'consent',
      },
    });

    const params = [...new URL(begun.url).searchParams];
    expect(Object.fromEntries(params)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      scope: 'files.read profile',
      state: begun.state,
      code_challenge: createHash('sha256').update(begun.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
    // Each parameter once (RFC 6749 section 3.1).
    expect(params).toHaveLength(8);
  });

  it('keeps the query an authorization endpoint already has, and sends no parameter twice', () => {
    /** A provider whose authorization endpoint carries a query of its own, as one that names a tenant does. */
    class TenantFlow extends ExampleFlow {
      protected getConfig(): RedirectOAuthConfig {
        return {
          ...super.getConfig(),
          authorizationEndpoint: 'https://auth.example.test/authorize?tenant=acme&prompt=login',
        };
      }
    }
    const { fetchImpl } = endpoint(() => json(500, {}));
    const flow = new TenantFlow(null, fetchImpl);

    const begun = flow.begin({ redirectUri: REDIRECT, extraParams: { prompt: 'consent' } });

    const address = new URL(begun.url);
    expect(`${address.origin}${address.pathname}`).toBe('https://auth.example.test/authorize');
    // RFC 6749 section 3.1: the endpoint's query is retained, and no parameter is included more than once. The
    // endpoint's `tenant` stays; its `prompt` gives way to the one asked for here.
    const params = [...address.searchParams];
    expect(Object.fromEntries(params)).toEqual({
      tenant: 'acme',
      prompt: 'consent',
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      scope: 'files.read profile',
      state: begun.state,
      code_challenge: createHash('sha256').update(begun.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    expect(params).toHaveLength(9);
  });

  it('refuses a state that differs before any call, and exchanges the code with the verifier as a form', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const { sent, fetchImpl } = endpoint(() =>
      json(200, {
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3599,
        refresh_token: 'refresh-1',
        scope: 'files.read profile',
      }),
    );
    const flow = new ExampleFlow(null, fetchImpl);
    const begun = flow.begin({ redirectUri: REDIRECT });
    const input = {
      code: 'code-1',
      state: begun.state,
      expectedState: begun.state,
      codeVerifier: begun.codeVerifier,
      redirectUri: REDIRECT,
    };

    for (const state of ['0'.repeat(begun.state.length), 'short', '']) {
      const refused = await rejection(flow.complete({ ...input, state }));
      expect(refused).toBeInstanceOf(OAuthGrantRefused);
      expect(refused).toMatchObject({ reason: 'state' });
    }
    // An empty expected state matches nothing, an empty state included.
    await expect(flow.complete({ ...input, state: '', expectedState: '' })).rejects.toMatchObject({ reason: 'state' });
    expect(sent).toHaveLength(0);

    const tokens = await flow.complete(input);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://auth.example.test/token');
    expect(sent[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(sent[0].headers.get('accept')).toBe('application/json');
    expect(Object.fromEntries(sent[0].form)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
      code_verifier: begun.codeVerifier,
      client_id: 'client-1',
      client_secret: 'client-secret-1',
    });
    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_700_000_000_000 + 3_599_000,
      idToken: undefined,
      metadata: { scope: 'files.read profile' },
    });
  });

  it('reads a refused exchange as OAuthGrantRefused whose message holds no code, verifier or secret', async () => {
    const { fetchImpl } = endpoint((request) => {
      switch (request.form.get('code')) {
        case 'code-answered-200':
          return json(200, { error: 'bad_verification_code' });
        case 'code-answered-empty':
          return json(200, { access_token: '', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
        default:
          return json(400, { error: 'invalid_grant', error_description: 'The code was already used.' });
      }
    });
    const flow = new ExampleFlow(null, fetchImpl);
    const begun = flow.begin({ redirectUri: REDIRECT });
    const input = {
      code: 'code-secret-1',
      state: begun.state,
      expectedState: begun.state,
      codeVerifier: begun.codeVerifier,
      redirectUri: REDIRECT,
    };

    const refused = await rejection(flow.complete(input));

    expect(refused).toBeInstanceOf(OAuthGrantRefused);
    expect(refused).toMatchObject({ reason: 'exchange', status: 400, providerError: 'invalid_grant' });
    const message = refused instanceof Error ? refused.message : '';
    expect(message).toContain('invalid_grant');
    for (const secret of ['code-secret-1', begun.codeVerifier, begun.state, 'client-secret-1']) {
      expect(message).not.toContain(secret);
    }

    // An answer without an access token is refused even when its status is 200.
    await expect(flow.complete({ ...input, code: 'code-answered-200' })).rejects.toMatchObject({
      reason: 'exchange',
      status: 200,
      providerError: 'bad_verification_code',
    });
    // So is an answer whose access token is empty: RFC 6749 appendix A.12 gives a token one character at least.
    await expect(flow.complete({ ...input, code: 'code-answered-empty' })).rejects.toMatchObject({
      reason: 'exchange',
      status: 200,
    });
  });

  it('refreshes a kept grant once at a time, holds the access token in memory, and keeps a refresh token the answer leaves out', async () => {
    let issued = 0;
    const { sent, fetchImpl } = endpoint((request) => {
      const refreshToken = request.form.get('refresh_token');
      if (refreshToken === 'refresh-revoked') return json(400, { error: 'invalid_grant' });
      if (refreshToken === 'refresh-answered-empty') {
        return json(200, { access_token: '', token_type: 'Bearer', expires_in: 3600 });
      }
      issued += 1;
      return json(200, {
        access_token: `access-${issued}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'files.read',
        ...(refreshToken === 'refresh-turned' ? { refresh_token: 'refresh-new' } : {}),
      });
    });
    const { store } = sealedStore();

    // The process that kept the grant answers its access token from memory, with no call.
    const keeper = new ExampleFlow(store, fetchImpl);
    await keeper.keep('grant-1', {
      accessToken: 'access-0',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
      metadata: { scope: 'files.read' },
    });
    expect(await keeper.accessToken('grant-1')).toBe('access-0');
    expect(sent).toHaveLength(0);

    // Another process holds nothing in memory: two calls at once make one refresh.
    const flow = new ExampleFlow(store, fetchImpl);
    const [first, second] = await Promise.all([flow.accessToken('grant-1'), flow.accessToken('grant-1')]);
    expect([first, second]).toEqual(['access-1', 'access-1']);
    expect(sent).toHaveLength(1);
    expect(Object.fromEntries(sent[0].form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-1',
      client_secret: 'client-secret-1',
    });

    // Within the token's life a third call is answered from memory.
    expect(await flow.accessToken('grant-1')).toBe('access-1');
    expect(sent).toHaveLength(1);

    // The refresh answered no refresh token, so the kept one stays.
    expect((await store.load('grant-1'))?.refreshToken).toBe('refresh-1');

    // A refresh token the answer does carry replaces the kept one (RFC 6749 section 6).
    await store.save('grant-2', { accessToken: '', refreshToken: 'refresh-turned', expiresAt: 0 });
    expect(await flow.accessToken('grant-2')).toBe('access-2');
    expect((await store.load('grant-2'))?.refreshToken).toBe('refresh-new');

    await store.save('grant-3', { accessToken: '', refreshToken: 'refresh-revoked', expiresAt: 0 });
    const refused = await rejection(flow.accessToken('grant-3'));
    expect(refused).toBeInstanceOf(OAuthGrantRefused);
    expect(refused).toMatchObject({ reason: 'refresh', status: 400, providerError: 'invalid_grant' });

    // A refresh answered with an empty access token is refused, so accessToken never answers an empty token.
    await store.save('grant-4', { accessToken: '', refreshToken: 'refresh-answered-empty', expiresAt: 0 });
    await expect(flow.accessToken('grant-4')).rejects.toMatchObject({ reason: 'refresh', status: 200 });

    await expect(flow.accessToken('grant-unknown')).rejects.toMatchObject({ reason: 'missing' });
  });

  it('hands its store the refresh token and the metadata alone, so a FileTokenStore writes no access token or id token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'redirect-oauth-flow-'));
    try {
      const { sent, fetchImpl } = endpoint(() =>
        json(200, {
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-2',
          id_token: 'id-2',
        }),
      );
      const store = new FileTokenStore(dir);
      /** What the store wrote for the grant. */
      const written = async (): Promise<unknown> => JSON.parse(await readFile(join(dir, 'grant-1.json'), 'utf8'));

      const keeper = new ExampleFlow(store, fetchImpl);
      await keeper.keep('grant-1', {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 3_600_000,
        idToken: 'id-1',
        metadata: { scope: 'files.read' },
      });

      expect(await written()).toEqual({
        accessToken: '',
        expiresAt: 0,
        refreshToken: 'refresh-1',
        metadata: { scope: 'files.read' },
      });
      // The flow that kept the grant answers its access token from memory.
      expect(await keeper.accessToken('grant-1')).toBe('access-1');
      expect(sent).toHaveLength(0);

      // A flow that holds nothing refreshes from the file. The refresh token the answer turns over is written; the
      // access token and the id token of the answer are not.
      expect(await new ExampleFlow(store, fetchImpl).accessToken('grant-1')).toBe('access-2');
      expect(sent).toHaveLength(1);
      expect(await written()).toEqual({
        accessToken: '',
        expiresAt: 0,
        refreshToken: 'refresh-2',
        metadata: { scope: 'files.read' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('revokes at the revocation endpoint, and forgets a kept grant whether or not the provider revoked it', async () => {
    const { sent, fetchImpl } = endpoint(
      (request) => new Response(null, { status: request.form.get('token') === 'refresh-unavailable' ? 503 : 200 }),
    );
    const { rows, store } = sealedStore();
    const flow = new ExampleFlow(store, fetchImpl, 'https://auth.example.test/revoke');

    await flow.revoke('token-1');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://auth.example.test/revoke');
    expect(sent[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(sent[0].form)).toEqual({ token: 'token-1' });

    await expect(new ExampleFlow(store, fetchImpl).revoke('token-1')).rejects.toThrow(/no revocation endpoint/);
    expect(sent).toHaveLength(1);

    await flow.keep('grant-1', { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 });
    expect(await flow.forget('grant-1')).toEqual({ revoked: true });
    expect(Object.fromEntries(sent[1].form)).toEqual({ token: 'refresh-1' });
    expect(rows.has('grant-1')).toBe(false);
    // The access token held in memory went with it.
    await expect(flow.accessToken('grant-1')).rejects.toMatchObject({ reason: 'missing' });

    await store.save('grant-2', { accessToken: '', refreshToken: 'refresh-unavailable', expiresAt: 0 });
    expect(await flow.forget('grant-2')).toEqual({ revoked: false });
    expect(Object.fromEntries(sent[2].form)).toEqual({ token: 'refresh-unavailable' });
    expect(rows.has('grant-2')).toBe(false);
  });

  it('runs keep, a refresh and forget of one key in turn, so a refresh in flight neither outlives forget nor overwrites keep', async () => {
    let answerToken!: () => void;
    let tokenAnswered = Promise.resolve();
    /** Holds the token endpoint's next answers until `answerToken` is called. */
    const holdTokenAnswers = (): void => {
      tokenAnswered = new Promise<void>((resolve) => {
        answerToken = resolve;
      });
    };
    const { sent, fetchImpl } = endpoint(async (request) => {
      if (request.url !== 'https://auth.example.test/token') return new Response(null, { status: 200 });
      await tokenAnswered;
      return json(200, { access_token: 'access-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2', scope: 'files.read' });
    });
    const { rows, store } = sealedStore();
    const flow = new ExampleFlow(store, fetchImpl, 'https://auth.example.test/revoke');
    /** Lets every step that is not waiting on the held answer run. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    // A grant forgotten while its refresh is in flight: forget revokes the refresh token that refresh leaves.
    await store.save('grant-1', { accessToken: '', refreshToken: 'refresh-1', expiresAt: 0 });
    holdTokenAnswers();
    const refreshed = flow.accessToken('grant-1');
    const forgotten = flow.forget('grant-1');
    await settle();
    answerToken();

    expect(await refreshed).toBe('access-2');
    expect(await forgotten).toEqual({ revoked: true });
    expect(sent.map((request) => request.url)).toEqual(['https://auth.example.test/token', 'https://auth.example.test/revoke']);
    expect(Object.fromEntries(sent[1].form)).toEqual({ token: 'refresh-2' });
    // Nothing comes back once forgotten: not in the store, not in memory.
    expect(rows.has('grant-1')).toBe(false);
    await expect(flow.accessToken('grant-1')).rejects.toMatchObject({ reason: 'missing' });

    // A grant kept while a refresh of the one before it is in flight: the kept grant is the one that stays.
    await store.save('grant-2', { accessToken: '', refreshToken: 'refresh-1', expiresAt: 0 });
    holdTokenAnswers();
    const refreshedBefore = flow.accessToken('grant-2');
    const kept = flow.keep('grant-2', { accessToken: 'access-9', refreshToken: 'refresh-9', expiresAt: Date.now() + 3_600_000 });
    await settle();
    answerToken();

    expect(await refreshedBefore).toBe('access-2');
    await kept;
    expect((await store.load('grant-2'))?.refreshToken).toBe('refresh-9');
    expect(await flow.accessToken('grant-2')).toBe('access-9');
    expect(sent).toHaveLength(3);
  });

  it('keeps the grant that keep saves while forget of the same key waits on the revocation endpoint', async () => {
    let answerRevocation!: () => void;
    const revocationAnswered = new Promise<void>((resolve) => {
      answerRevocation = resolve;
    });
    const { sent, fetchImpl } = endpoint(async () => {
      await revocationAnswered;
      return new Response(null, { status: 200 });
    });
    const { store } = sealedStore();
    const flow = new ExampleFlow(store, fetchImpl, 'https://auth.example.test/revoke');
    await store.save('grant-1', { accessToken: '', refreshToken: 'refresh-1', expiresAt: 0 });

    // Disconnecting, then connecting again before the provider has answered the revocation.
    const forgotten = flow.forget('grant-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    const kept = flow.keep('grant-1', {
      accessToken: 'access-9',
      refreshToken: 'refresh-9',
      expiresAt: Date.now() + 3_600_000,
    });
    answerRevocation();

    expect(await forgotten).toEqual({ revoked: true });
    await kept;
    expect(Object.fromEntries(sent[0].form)).toEqual({ token: 'refresh-1' });
    // forget cleared the grant it revoked; the grant kept after it stays, in the store and in memory.
    expect((await store.load('grant-1'))?.refreshToken).toBe('refresh-9');
    expect(await flow.accessToken('grant-1')).toBe('access-9');
    expect(sent).toHaveLength(1);
  });
});
