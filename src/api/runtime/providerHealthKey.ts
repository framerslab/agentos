/**
 * @file providerHealthKey.ts
 * The id the provider health registry keeps a call's record under. In a
 * module of its own: it imports only `node:crypto`, so the callers that
 * mock the model module keep it.
 */
import { createHash } from 'node:crypto';

/** A provider and the key and base URL a request to it carries, as `resolveProvider` returns them. */
export interface ProviderCredentials {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * The id the provider health registry keeps a call's record under.
 *
 * A call that reaches the provider with the credentials the provider has
 * without the call (its environment variable or the global default) shares
 * the provider's record, its plain id. A call whose key or base URL differs
 * has a record of its own: the provider id with a digest of the key and base
 * URL the request carries (`openai@3f2a9c1e5b7d`). A tenant's revoked key, or
 * a gateway that is down, then opens the breaker for the calls that use it,
 * and not for the provider's other callers; a call that passes the key the
 * environment holds shares the environment's record. The digest holds no
 * part of the key.
 *
 * @param resolved - The provider and credentials the call's request carries.
 * @param shared - Only for a call that passes its own key or base URL: how
 *   to resolve the provider's credentials without them (`resolveProvider`
 *   with no overrides). A resolver that throws means there are none.
 */
export function providerHealthKey(resolved: ProviderCredentials, shared?: () => ProviderCredentials): string {
  if (!shared || (!resolved.apiKey && !resolved.baseUrl)) return resolved.providerId;
  let base: ProviderCredentials | undefined;
  try {
    base = shared();
  } catch {
    base = undefined;
  }
  if (
    base &&
    base.providerId === resolved.providerId &&
    (base.apiKey ?? '') === (resolved.apiKey ?? '') &&
    (base.baseUrl ?? '') === (resolved.baseUrl ?? '')
  ) {
    return resolved.providerId;
  }
  const digest = createHash('sha256').update(`${resolved.apiKey ?? ''}\n${resolved.baseUrl ?? ''}`).digest('hex');
  return `${resolved.providerId}@${digest.slice(0, 12)}`;
}
