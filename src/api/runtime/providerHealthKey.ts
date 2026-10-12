/**
 * @file providerHealthKey.ts
 * The id the provider health registry keeps a call's record under. In a
 * module of its own: it imports only `node:crypto`, so the callers that
 * mock the model module keep it.
 */
import { createHash } from 'node:crypto';

/**
 * The id the provider health registry keeps a call's record under: the
 * provider's id, or for a call that brings its own key or base URL, that id
 * with a digest of them (`openai@3f2a9c1e5b7d`). A revoked key, or an
 * endpoint that is down, then opens the breaker for the calls that use it,
 * not for every caller of the provider. The digest holds no part of the key.
 *
 * @param providerId - The provider that serves the call.
 * @param inline - The call's own `apiKey` and `baseUrl`, when it has them.
 */
export function providerHealthKey(providerId: string, inline?: { apiKey?: unknown; baseUrl?: unknown }): string {
  const apiKey = typeof inline?.apiKey === 'string' ? inline.apiKey : '';
  const baseUrl = typeof inline?.baseUrl === 'string' ? inline.baseUrl : '';
  if (!apiKey && !baseUrl) return providerId;
  return `${providerId}@${createHash('sha256').update(`${apiKey}\n${baseUrl}`).digest('hex').slice(0, 12)}`;
}
