# OAuth Authentication Module

The `@framers/agentos/auth` subpath export provides OAuth primitives: a browser-based OAuth 2.0 authorization-code flow with PKCE for OpenAI (obtaining API access from a ChatGPT subscription, as the Codex CLI does), the same flow for Twitter, Instagram, LinkedIn and Facebook, and the token store, callback server and PKCE helpers they share.

## Architecture

```
@framers/agentos/auth
├── types.ts              # Core interfaces: IOAuthFlow, IOAuthTokenStore, OAuthTokenSet
├── FileTokenStore.ts     # File-based token persistence (~/.wunderland/auth/)
├── OpenAIOAuthFlow.ts    # OpenAI browser PKCE flow (Codex CLI client)
├── BrowserOAuthFlow.ts   # Abstract base for browser authorization-code + PKCE flows
├── TwitterOAuthFlow.ts, InstagramOAuthFlow.ts, LinkedInOAuthFlow.ts, FacebookOAuthFlow.ts
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
