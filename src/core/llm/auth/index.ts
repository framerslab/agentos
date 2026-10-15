/**
 * @fileoverview OAuth authentication primitives for LLM providers.
 * @module agentos/core/llm/auth
 */

export type {
  AuthMethod,
  OAuthTokenSet,
  OAuthProviderConfig,
  IOAuthTokenStore,
  IOAuthFlow,
} from './types.js';

export { FileTokenStore } from './FileTokenStore.js';
export { OpenAIOAuthFlow } from './OpenAIOAuthFlow.js';
export type { OpenAIOAuthFlowOptions } from './OpenAIOAuthFlow.js';

// Browser-based OAuth 2.0 flows
export { BrowserOAuthFlow } from './BrowserOAuthFlow.js';
export type { BrowserOAuthConfig, BrowserOAuthFlowOptions } from './BrowserOAuthFlow.js';
export { TwitterOAuthFlow } from './TwitterOAuthFlow.js';
export type { TwitterOAuthFlowOptions } from './TwitterOAuthFlow.js';
export { InstagramOAuthFlow } from './InstagramOAuthFlow.js';
export type { InstagramOAuthFlowOptions } from './InstagramOAuthFlow.js';
export { LinkedInOAuthFlow } from './LinkedInOAuthFlow.js';
export type { LinkedInOAuthFlowOptions } from './LinkedInOAuthFlow.js';
export { FacebookOAuthFlow } from './FacebookOAuthFlow.js';
export type { FacebookOAuthFlowOptions } from './FacebookOAuthFlow.js';

// A web server's OAuth 2.0 flow, and secrets sealed at rest
export { RedirectOAuthFlow, OAuthGrantRefused, type RedirectOAuthConfig, type RedirectBegin, type RedirectCompleteInput } from './RedirectOAuthFlow.js';
export { sealSecret, openSecret, SealedSecretError, type SealingKey } from './sealing.js';
export { SealedTokenStore, type SealedBytesStore, type SealingKeys } from './SealedTokenStore.js';

// Utilities
export { isTokenValid, openBrowser } from './utils.js';
export { startCallbackServer } from './callback-server.js';
export type { CallbackResult, CallbackServerOptions } from './callback-server.js';
export { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';
