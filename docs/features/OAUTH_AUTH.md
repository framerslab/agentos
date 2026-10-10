# OAuth Authentication Module

The `@framers/agentos/auth` subpath export provides OAuth primitives: a browser-based OAuth 2.0 authorization-code flow with PKCE for OpenAI (obtaining API access from a ChatGPT subscription, as the Codex CLI does), the same flow for Twitter, Instagram, LinkedIn and Facebook, and the token store, callback server and PKCE helpers they share. For a web server it provides the same grant split across two requests ([`RedirectOAuthFlow`](#web-server-flow)), secrets sealed at rest with AES-256-GCM (`sealSecret`, `openSecret`) and a token store that keeps each grant sealed (`SealedTokenStore`).

## Architecture

```
@framers/agentos/auth
├── types.ts              # Core interfaces: IOAuthFlow, IOAuthTokenStore, OAuthTokenSet
├── FileTokenStore.ts     # File-based token persistence (~/.wunderland/auth/)
├── OpenAIOAuthFlow.ts    # OpenAI browser PKCE flow (Codex CLI client)
├── BrowserOAuthFlow.ts   # Abstract base for browser authorization-code + PKCE flows
├── TwitterOAuthFlow.ts, InstagramOAuthFlow.ts, LinkedInOAuthFlow.ts, FacebookOAuthFlow.ts
├── RedirectOAuthFlow.ts  # A web server's authorization-code + PKCE flow, split across two requests
├── sealing.ts            # sealSecret, openSecret: AES-256-GCM with key ids and a bound context
├── SealedTokenStore.ts   # IOAuthTokenStore that keeps a grant's refresh token sealed
├── callback-server.ts    # Local callback server (startCallbackServer)
├── pkce.ts               # generateCodeVerifier, generateCodeChallenge, generateState
├── utils.ts              # openBrowser, isTokenValid
└── index.ts              # Barrel export
```

### Core Interfaces

```typescript
type AuthMethod = 'api-key' | 'oauth';

interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix epoch ms
  idToken?: string;
  metadata?: Record<string, string>;
}

interface IOAuthFlow {
  readonly providerId: string;
  authenticate(): Promise<OAuthTokenSet>;
  refresh(tokens: OAuthTokenSet): Promise<OAuthTokenSet>;
  isValid(tokens: OAuthTokenSet): boolean;
  getAccessToken(): Promise<string>;
}

interface IOAuthTokenStore {
  load(providerId: string): Promise<OAuthTokenSet | null>;
  save(providerId: string, tokens: OAuthTokenSet): Promise<void>;
  clear(providerId: string): Promise<void>;
}
```

These interfaces are provider-agnostic. [`IOAuthFlow`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/types.ts) defines the contract for any OAuth-based LLM provider authentication, and [`IOAuthTokenStore`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/types.ts) abstracts token persistence.

## OpenAI Implementation

[`OpenAIOAuthFlow`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/OpenAIOAuthFlow.ts) implements [`IOAuthFlow`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/types.ts) with the browser-based authorization-code flow and PKCE, using the Codex CLI's public client ID (`app_EMoamEEZ73f0CkXaXp7hrann`).

### Flow

1. Generate a PKCE code verifier and challenge, and a `state` value.
2. Start a callback server on `localhost:1455`.
3. Open the system browser at `https://auth.openai.com/oauth/authorize`; the user logs in and OpenAI redirects to `http://localhost:1455/auth/callback`.
4. Exchange the authorization code and verifier at `https://auth.openai.com/oauth/token`.
5. Exchange the returned `id_token` for an OpenAI API key at the same endpoint (token exchange, `requested_token: openai-api-key`); when that exchange fails, the OAuth access token is kept instead.
6. Save the token set to the token store.

The callback is awaited for up to 10 minutes. A refresh posts the refresh token to `https://auth.openai.com/oauth/token`.

### Usage

```typescript
import { OpenAIOAuthFlow, FileTokenStore } from '@framers/agentos/auth';

const flow = new OpenAIOAuthFlow({
  tokenStore: new FileTokenStore(),
  onBrowserOpen: (authUrl) => {
    console.log(`Opening ${authUrl}`);
  },
});

// Interactive login: opens the browser and waits for the callback
const tokens = await flow.authenticate();

// Get a usable token (refreshes it when it is within 5 minutes of expiry)
const apiKey = await flow.getAccessToken();

// Check validity
flow.isValid(tokens); // true if not expired (with 5-min buffer)
```

`getAccessToken()` throws when the store holds no tokens for `openai`; run `authenticate()` first.

### Options

```typescript
interface OpenAIOAuthFlowOptions {
  tokenStore?: IOAuthTokenStore;              // Default: FileTokenStore
  clientId?: string;                          // Default: Codex CLI public client ID
  onBrowserOpen?: (authUrl: string) => void;  // Called before the browser opens
}
```

## FileTokenStore

Stores tokens as JSON files at `~/.wunderland/auth/{providerId}.json` with `0o600` permissions.

```typescript
import { FileTokenStore } from '@framers/agentos/auth';

const store = new FileTokenStore();            // Default: ~/.wunderland/auth/
const store2 = new FileTokenStore('/custom');   // Custom directory

await store.save('openai', tokens);
const loaded = await store.load('openai');      // OAuthTokenSet | null
await store.clear('openai');                    // Deletes the file
```

Features:
- Creates directories recursively if they don't exist
- Sanitizes provider IDs to prevent path traversal
- Returns `null` for corrupted or invalid JSON
- Works with any `providerId` string

## Web Server Flow

A web server runs the grant across two requests: the one that sends the person to the provider, and the provider's redirect back. [`RedirectOAuthFlow`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/RedirectOAuthFlow.ts) splits the authorization-code flow with PKCE at that redirect. `begin` answers the address with its `state` and PKCE `codeVerifier`; the server keeps both (in a short-lived row found by a cookie, for example) and hands them back to `complete`. The store keeps the refresh token; the access token stays in the process's memory and is never stored.

```typescript
import { RedirectOAuthFlow, SealedTokenStore, type RedirectOAuthConfig } from '@framers/agentos/auth';

class ExampleOAuthFlow extends RedirectOAuthFlow {
  readonly providerId = 'example';

  protected getConfig(): RedirectOAuthConfig {
    return {
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      revocationEndpoint: 'https://auth.example.com/revoke',
      scopes: ['files.read'],
      clientId: process.env.EXAMPLE_CLIENT_ID ?? '',
      clientSecret: process.env.EXAMPLE_CLIENT_SECRET,
    };
  }
}

// Sealed grants live in the server's own table, one row per key.
const store = new SealedTokenStore(
  {
    get: (key) => grants.sealedText(key), // the row's sealed text, or null
    set: (key, sealed) => grants.write(key, sealed),
    delete: (key) => grants.remove(key),
  },
  { current: { id: 'k2', key: currentKey }, previous: [{ id: 'k1', key: previousKey }] },
);
const flow = new ExampleOAuthFlow(store);

// Request 1: send the person to `url`; keep `state` and `codeVerifier` on the server.
const { url, state, codeVerifier } = flow.begin({ redirectUri: 'https://app.example.com/oauth/callback' });

// Request 2: the provider redirects back with `code` and `state`.
const tokens = await flow.complete({
  code,
  state: returnedState,
  expectedState: state,
  codeVerifier,
  redirectUri: 'https://app.example.com/oauth/callback',
});
await flow.keep('connection-42', tokens);

// Any later request, in any process that reads the same table:
const accessToken = await flow.accessToken('connection-42');

// Disconnecting: revoke at the provider, then clear the grant whatever the provider answered.
const { revoked } = await flow.forget('connection-42');
```

- `begin({ redirectUri, extraParams?, scopes? })` builds the authorization address with `response_type=code`, `client_id`, `redirect_uri`, `scope` (the configured scopes, or `scopes`, joined by spaces), a fresh `state`, `code_challenge` (the S256 challenge of a fresh verifier) and `code_challenge_method=S256`, plus any `extraParams`, such as `access_type: 'offline'`.
- `complete(input)` compares `state` with `expectedState` in constant time and throws `OAuthGrantRefused` with reason `state`, calling no endpoint, when they differ or `expectedState` is empty. It then posts `grant_type=authorization_code`, the code, the redirect address, the verifier and the client's credentials to the token endpoint as a form, with `Accept: application/json`, and answers the token set: `expiresAt` from `expires_in` (an hour when the answer has none), `metadata.scope` from `scope`.
- A token endpoint answer that is not a success, or that carries no `access_token`, throws `OAuthGrantRefused` with its reason (`exchange` or `refresh`), the HTTP `status` and the answer's `error` as `providerError`. Its message holds no code, verifier or token.
- `keep(key, tokens)` saves the grant in the store and holds the token set in memory. `accessToken(key)` answers the held access token until `refreshBufferMs` (five minutes by default) before it expires; past that, or in a process that holds nothing for `key`, it refreshes from the stored refresh token, one refresh at a time for each key, and holds the result. A refresh token in the refresh's answer replaces the stored one; an answer without one leaves the stored one in place. With no stored refresh token it throws `OAuthGrantRefused` with reason `missing`.
- `revoke(token)` posts the token alone as a form to `revocationEndpoint` (RFC 7009) and throws when the flow has none. `forget(key)` revokes the stored refresh token, then clears the store and the memory for `key` whatever the provider answered, and answers `{ revoked }`.

The default token calls send the client id, and the client secret when one is configured, in the form body, which RFC 6749 section 2.3.1 lets a server accept as well as HTTP Basic. A provider whose endpoints differ overrides `exchangeCode`, `refreshTokens`, `postExchange` or `revoke`.

### Sealed Secrets

[`sealSecret(plain, key, keyId, context?)`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/sealing.ts) seals a string or bytes with AES-256-GCM under a 32-byte key, with a random 96-bit nonce for each seal, into `v1.<keyId>.<base64url(nonce | ciphertext | tag)>`. The context, for example the id of the row the value belongs to, is bound as additional authenticated data, so a sealed value copied to another row does not open there. `openSecret(sealed, keys, context?)` opens it with the key whose id the text names and answers the bytes, or throws `SealedSecretError` with reason `format` (not a version 1 sealed text), `key` (no key with that id was given) or `tampered` (the key, the bytes or the context differ from the seal's). A key id is 1 to 32 letters, digits, `-` or `_`, and `sealSecret` refuses a key that is not 32 bytes.

To turn a key over, seal with the new key and keep the old one among the keys that open.

### SealedTokenStore

[`SealedTokenStore`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/SealedTokenStore.ts) is an `IOAuthTokenStore` over three functions the server gives: `get`, `set` and `delete` of a sealed text by key. `save(key, tokens)` seals the refresh token and the metadata with the `current` key, bound to `key`; the access token and the id token are never kept. `load(key)` answers the refresh token and the metadata with `accessToken: ''` and `expiresAt: 0`, so a flow treats the grant as expired and refreshes it, or `null` when nothing is kept; a value that does not open throws `SealedSecretError`. A grant sealed with one of the `previous` keys loads, and its next `save` seals it with `current`.

## Integration with LLM Providers

The [`OpenAIProvider`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/implementations/OpenAIProvider.ts) in AgentOS core accepts an optional `oauthFlow` config:

```typescript
import { OpenAIProvider } from '@framers/agentos/core/llm/providers/implementations/OpenAIProvider';

const provider = new OpenAIProvider();
await provider.initialize({
  apiKey: '',              // not needed when oauthFlow is set
  defaultModelId: 'gpt-4o',
  oauthFlow: flow,         // { getAccessToken(): Promise<string> }
});
```

When `oauthFlow` is set, the provider calls `getAccessToken()` before each API request instead of using the static `apiKey`.

## Adding New Providers

To add OAuth support for a new LLM provider:

1. Create a new class implementing [`IOAuthFlow`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/types.ts)
2. Set `providerId` to the provider's registry ID (e.g., `'anthropic'`)
3. Implement the provider's OAuth flow in `authenticate()`
4. Implement token refresh in `refresh()`
5. Use [`FileTokenStore`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/FileTokenStore.ts) or a custom [`IOAuthTokenStore`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/types.ts) for persistence

```typescript
export class ExampleOAuthFlow implements IOAuthFlow {
  readonly providerId = 'example-provider';
  // ... implement authenticate(), refresh(), isValid(), getAccessToken()
}
```

The [`FileTokenStore`](https://github.com/framerslab/agentos/blob/master/src/core/llm/auth/FileTokenStore.ts) automatically namespaces by `providerId`, so multiple providers can coexist.

### LLM Provider Support

| Provider | OAuth Status | CLI Provider Alternative |
|----------|-------------|------------------------|
| OpenAI | **Supported**: the Codex CLI's browser PKCE flow with public client ID `app_EMoamEEZ73f0CkXaXp7hrann`. OpenAI maintainers have [confirmed](https://github.com/openai/codex/discussions/8338) permissive terms for third-party usage. | N/A (OAuth works directly) |
| Anthropic | Not available — no consumer OAuth API | **`claude-code-cli`** — use Claude Code CLI with Max subscription. Anthropic [explicitly supports](https://code.claude.com/docs/en/headless) programmatic `claude -p` calls. See [CLI Providers](../getting-started/CLI_PROVIDERS.md). |
| Google Gemini | Not available — API keys only | **`gemini-cli`** — use Gemini CLI with Google account. **WARNING**: Google's ToS may prohibit third-party CLI invocation with OAuth auth. Use at your own risk. See [CLI Providers](../getting-started/CLI_PROVIDERS.md). |

### Authentication Strategy by Use Case

| Use Case | Recommended Auth | Provider |
|----------|-----------------|----------|
| Production deployment | API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) | `anthropic`, `openai` |
| Personal development (Claude) | Claude Code CLI login | `claude-code-cli` |
| Personal development (Gemini) | API key from AI Studio (free) | `gemini` |
| ChatGPT subscription users | OpenAI OAuth (Codex flow) | `openai` with OAuth |
| Multi-provider fallback | OpenRouter API key | `openrouter` |

Only providers with legitimate, Terms of Service-compliant authentication flows should be implemented. Session token extraction from consumer web products is not supported.

## Subpath Export

Import from `@framers/agentos/auth`:

```typescript
import {
  OpenAIOAuthFlow,
  FileTokenStore,
  RedirectOAuthFlow,
  OAuthGrantRefused,
  SealedTokenStore,
  sealSecret,
  openSecret,
  SealedSecretError,
  type IOAuthFlow,
  type IOAuthTokenStore,
  type OAuthTokenSet,
  type AuthMethod,
  type OAuthProviderConfig,
  type OpenAIOAuthFlowOptions,
} from '@framers/agentos/auth';
```

The export is configured in `package.json`:

```json
{
  "exports": {
    "./auth": {
      "import": "./dist/core/llm/auth/index.js",
      "types": "./dist/core/llm/auth/index.d.ts"
    }
  }
}
```
