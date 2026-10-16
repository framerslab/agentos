import { createHash } from 'node:crypto';
import { InitiatingPrincipalSchema, type InitiatingPrincipal } from './contracts/index.js';
import { assertCallProviderPolicy, type ProviderPolicy, type VoiceProviderPurpose } from '../voice-pipeline/ProviderPolicy.js';
/** Required original identity at every memory, credential and adapter boundary. */
export interface VoiceScopeIdentity { readonly scopeId: string; readonly callId: string }
/** Secret resolution has explicit scope, purpose and cancellation; it never consults ambient environment. */
export interface VoiceCredentialRequest extends VoiceScopeIdentity {
  providerId: string; purpose: VoiceProviderPurpose; credentialRef: string; signal: AbortSignal;
}
/** Host binding to its authorized, revisioned credential store. */
export interface VoiceCredentialResolver { resolve(request: VoiceCredentialRequest): Promise<string | undefined> }
/** Captured authority for one call. Only non-secret identities are copied into events. */
export interface VoiceScopeContext extends VoiceScopeIdentity {
  readonly principal: InitiatingPrincipal;
  readonly credentials: VoiceCredentialResolver;
  readonly signal: AbortSignal;
  readonly policy: ProviderPolicy;
  readonly allowedToolRefs: readonly string[];
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
/** Checks authority before any side effect, including a disabled-memory read. */
export function requireVoiceScope(value: VoiceScopeContext | undefined, scopeId: string, callId: string): asserts value is VoiceScopeContext {
  if (!value || !validId(scopeId) || !validId(callId) || value.scopeId !== scopeId || value.callId !== callId) throw new Error('voice scope refused');
  value.signal.throwIfAborted();
}
/** Captures mutable input and wraps credential access with scope and allowlist checks. */
export function captureVoiceScope(input: VoiceScopeContext): VoiceScopeContext {
  if (!input || !validId(input.scopeId) || !validId(input.callId) || !input.signal || typeof input.credentials?.resolve !== 'function') throw new Error('voice scope required');
  const principal = Object.freeze(InitiatingPrincipalSchema.parse(input.principal));
  const policy = assertCallProviderPolicy(input.policy);
  if (policy.identity.scopeId !== input.scopeId || policy.identity.callId !== input.callId) throw new Error('voice policy scope refused');
  if (input.allowedToolRefs.length > 32 || input.allowedToolRefs.some((id) => !validId(id)) || new Set(input.allowedToolRefs).size !== input.allowedToolRefs.length) throw new Error('tool policy refused');
  const resolver = input.credentials; const scopeId = input.scopeId; const callId = input.callId; const signal = input.signal;
  const captured: VoiceScopeContext = Object.freeze({ scopeId, callId, principal, policy, signal,
    allowedToolRefs: Object.freeze([...input.allowedToolRefs]),
    credentials: Object.freeze({ resolve: async (request: VoiceCredentialRequest) => {
      requireVoiceScope(captured, request.scopeId, request.callId); request.signal.throwIfAborted();
      if (!validId(request.credentialRef) || !policy.purposes.includes(request.purpose) || !policy.providers.some((p) => p.providerId === request.providerId && p.purposes.includes(request.purpose) && (policy.mode !== 'local' || p.locality === 'local'))) throw new Error('credential policy refused');
      const value = await resolver.resolve({ scopeId, callId, providerId: request.providerId, purpose: request.purpose, credentialRef: request.credentialRef, signal: AbortSignal.any([signal, request.signal]) });
      requireVoiceScope(captured, scopeId, callId); request.signal.throwIfAborted(); return value;
    } }),
    toJSON: () => ({ scopeId, callId, principal }),
  });
  requireVoiceScope(captured, scopeId, callId); return captured;
}
/** Stable namespace without tuple ambiguity or a global fallback. It is an identifier, not an authorization token. */
export function voiceNamespace(scope: VoiceScopeContext): string {
  requireVoiceScope(scope, scope.scopeId, scope.callId);
  return `voice_${createHash('sha256').update(JSON.stringify([scope.scopeId, scope.callId])).digest('hex')}`;
}
