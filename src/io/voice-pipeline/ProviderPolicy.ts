/**
 * @module voice-pipeline/ProviderPolicy
 *
 * Explicit provider selection for the STT and TTS chains. A {@link ProviderPolicy} names its mode (`local`, `hosted`
 * or `provider`), the providers a call may open, in the order they are tried, the purposes each may serve with its
 * tariff version, and whether a fallback is allowed (`none` or `allowlisted`). A chain built with a policy keeps the
 * providers it permits, in its order, and awaits its `authorize` hook before every opening: the first, an opening
 * after an earlier one failed or a provider was unavailable, and a switch after the open session failed. A refused
 * authorization opens nothing. `local` mode never opens a remote provider, whatever keys the process holds. An
 * authorized switch to another provider calls `onFallback` with the same content-free data `authorize` received.
 * Reopening the same provider after a dropped connection is `ReconnectingSTT`'s, and widens no policy.
 *
 * {@link legacyProviderPolicy} keeps a chain built without a policy on its priority order; the call boundary,
 * {@link assertCallProviderPolicy}, refuses it. A policy carries no credential and reads no environment, and the
 * module imports only the pipeline's types, so it loads in a browser.
 *
 * @example
 * ```typescript
 * const policy = assertCallProviderPolicy({
 *   mode: 'local',
 *   fallback: 'none',
 *   identity: { scopeId: 'scope-a', callId: 'call-a', turnId: 'turn-1', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } },
 *   purposes: ['stt'],
 *   providers: [{ providerId: 'local-stt', locality: 'local', purposes: ['stt'], priceVersion: 'local-v1' }],
 *   authorize: async (opening) => { await reservations.check(opening); },
 *   onFallback: (event) => metrics.record(event.reason, event.to),
 * });
 * const stt = new StreamingSTTChain([localStt], { policy });
 * ```
 */
import { copyAudioIdentity, type AudioIdentity } from './types.js';

/** A purpose must be independently permitted, even if a provider supports several. */
export type VoiceProviderPurpose = 'stt' | 'tts' | 'vad' | 'endpoint' | 'reasoning';

/** Host-registered provider identity, locality and immutable tariff reference. */
export interface ProviderPermission {
  /** The configured provider's `providerId`: 1 to 128 letters, digits, `.`, `_`, `:` or `-`, starting with a letter or digit. */
  providerId: string;
  /** `local` runs on the host; `remote` is a supplier's service, which `local` mode never opens. */
  locality: 'local' | 'remote';
  /** The purposes this provider may be opened for. */
  purposes: readonly VoiceProviderPurpose[];
  /** The tariff version an opening of this provider is charged at, 1 to 128 characters. */
  priceVersion: string;
}

/** Content-free authorization/event data; it never contains an endpoint URL or a credential. */
export interface ProviderOpening extends AudioIdentity {
  /** What the provider is opened for. */
  purpose: VoiceProviderPurpose;
  /** The provider the call moves from; absent on the first choice's opening. */
  from?: string;
  /** The provider being opened. */
  to: string;
  /** The first choice, the first choice unavailable, an earlier opening failed, or the open session failed. */
  reason: 'primary' | 'unavailable' | 'initialization_failed' | 'mid_session_failure';
  /** The tariff version of `to`, from its permission. */
  priceVersion: string;
}

/** Explicit call selection. The authorizer validates existing reserved liability before each opening. */
export interface ProviderPolicy {
  /** `local` opens only providers whose locality is `local`; `hosted` and `provider` open any permitted provider. */
  mode: 'local' | 'hosted' | 'provider';
  /** `none` opens only the first permitted provider of a purpose, even when a later one is healthy; `allowlisted` may open the next permitted one. */
  fallback: 'none' | 'allowlisted';
  /** The scope, call and fences the call was admitted with. An opening for another scope or call, another worker generation, or an earlier inference generation or transport epoch is refused. */
  identity: AudioIdentity;
  /** The purposes the call may open providers for. */
  purposes: readonly VoiceProviderPurpose[];
  /** The providers the call may open, in the order they are tried; each id once. */
  providers: readonly ProviderPermission[];
  /**
   * Awaited before each opening; it rechecks the call's current authority and that enough customer and supplier
   * liability is reserved for the request. A rejection opens nothing.
   */
  authorize(request: ProviderOpening): Promise<void>;
  /** Called after an authorized opening of another provider than `from`, with the data `authorize` received. */
  onFallback(event: ProviderOpening): void;
}

/** Compatibility policy for pre-existing injected/environment constructors. Never admissible to a call factory. */
export interface LegacyProviderPolicy {
  /** Providers are tried in priority order, with no authorization and no permission check. */
  readonly mode: 'legacy';
}

/** The explicit compatibility selection used when an old chain caller supplies no policy. */
export const legacyProviderPolicy: LegacyProviderPolicy = Object.freeze({ mode: 'legacy' });

/** Only legacy constructors accept this wider union. */
export type ProviderSelectionPolicy = ProviderPolicy | LegacyProviderPolicy;

const purposes: readonly VoiceProviderPurpose[] = ['stt', 'tts', 'vad', 'endpoint', 'reasoning'];

/**
 * Validates and copies configuration before a call can observe mutable host objects.
 *
 * The copy holds the policy's own properties, with copies of its identity, purposes and permissions, all frozen.
 *
 * @param value - The policy a chain or a call is built with.
 * @returns {@link legacyProviderPolicy} for a legacy policy, otherwise the frozen copy.
 * @throws {Error} When the mode, the fallback, a purpose, a permission or the identity is invalid, the providers or
 *   the purposes are empty, a provider id is permitted twice, or `authorize` or `onFallback` is not a function.
 */
export function freezeProviderPolicy(value: ProviderSelectionPolicy): ProviderSelectionPolicy {
  if (value.mode === 'legacy') return legacyProviderPolicy;
  if (!['local', 'hosted', 'provider'].includes(value.mode) || !['none', 'allowlisted'].includes(value.fallback) || !value.providers.length || !value.purposes.length || typeof value.authorize !== 'function' || typeof value.onFallback !== 'function') throw new Error('invalid provider policy');
  if (new Set(value.providers.map((p) => p.providerId)).size !== value.providers.length) throw new Error('duplicate provider permission');
  const providers = value.providers.map((p) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(p.providerId) || !p.priceVersion || p.priceVersion.length > 128 || !['local', 'remote'].includes(p.locality) || !p.purposes.length || p.purposes.some((x) => !purposes.includes(x))) throw new Error('invalid provider permission');
    return Object.freeze({ ...p, purposes: Object.freeze([...p.purposes]) });
  });
  if (value.purposes.some((x) => !purposes.includes(x))) throw new Error('invalid provider purpose');
  return Object.freeze({ ...value, identity: copyAudioIdentity(value.identity), purposes: Object.freeze([...value.purposes]), providers: Object.freeze(providers) });
}

/**
 * Required at the hosted/local call factory boundary. Environment compatibility cannot satisfy this contract.
 *
 * @param value - The policy a call is built with.
 * @returns The frozen copy of `value`.
 * @throws {Error} For the legacy policy, or for a policy {@link freezeProviderPolicy} refuses.
 */
export function assertCallProviderPolicy(value: ProviderSelectionPolicy): ProviderPolicy {
  const policy = freezeProviderPolicy(value);
  if (policy.mode === 'legacy') throw new Error('legacy provider policy is unavailable to calls');
  return policy;
}

/**
 * Orders only configured instances. Locality and purpose filtering precede any credential or provider I/O.
 *
 * Under the legacy policy every provider is kept, sorted by priority (lower first). Otherwise the result holds, in
 * the policy's order, the configured instance of each permission that serves `purpose` (only `local` ones in `local`
 * mode), or of the first such permission alone under `fallback: 'none'`.
 *
 * @typeParam T - The configured provider type.
 * @param providers - The configured instances, one per permitted provider id.
 * @param policy - A policy returned by {@link freezeProviderPolicy}.
 * @param purpose - What the providers are opened for.
 * @returns The providers to try, in order.
 * @throws {Error} When the policy does not permit `purpose`, or a selected permission has no configured instance or
 *   more than one.
 */
export function selectPolicyProviders<T extends { providerId: string; priority: number }>(providers: readonly T[], policy: ProviderSelectionPolicy, purpose: VoiceProviderPurpose): T[] {
  if (policy.mode === 'legacy') return [...providers].sort((a, b) => a.priority - b.priority);
  if (!policy.purposes.includes(purpose)) throw new Error('provider purpose refused');
  const permissions = policy.providers.filter((p) => p.purposes.includes(purpose) && (policy.mode !== 'local' || p.locality === 'local'));
  const allowed = policy.fallback === 'none' ? permissions.slice(0, 1) : permissions;
  return allowed.map((p) => {
    const matches = providers.filter((x) => x.providerId === p.providerId);
    if (matches.length !== 1) throw new Error('configured provider missing or ambiguous');
    return matches[0]!;
  });
}

/**
 * One authorization below the routing loop, before even a provider session is opened.
 *
 * Under the legacy policy it resolves at once. Otherwise the opening must name a permitted provider of a permitted
 * purpose, a move from another provider needs `fallback: 'allowlisted'`, and `fallback: 'none'` admits only the first
 * permitted provider. The identity must keep the policy's scope, call and worker generation, with an inference
 * generation and a transport epoch no earlier than the policy's. The policy's `authorize` is then awaited with the
 * opening; after it resolves, a move from another provider calls `onFallback` with the same data.
 *
 * @param policy - A policy returned by {@link freezeProviderPolicy}.
 * @param purpose - What the provider is opened for.
 * @param from - The provider the call moves from, if any.
 * @param to - The provider to open.
 * @param reason - Why it is opened.
 * @param identity - The identity of the request; the policy's own when absent.
 * @throws {Error} `provider selection refused` or `provider identity refused` when a check fails, `invalid audio
 *   identity` or `invalid audio generation` for a malformed identity, or `provider authorization refused` when
 *   `authorize` rejects; a caller opens no provider then. An error `onFallback` throws propagates.
 */
export async function authorizeProviderOpening(policy: ProviderSelectionPolicy, purpose: VoiceProviderPurpose, from: string | undefined, to: string, reason: ProviderOpening['reason'], identity?: AudioIdentity): Promise<void> {
  if (policy.mode === 'legacy') return;
  identity ??= policy.identity;
  const permitted = policy.providers.filter((p) => p.purposes.includes(purpose) && (policy.mode !== 'local' || p.locality === 'local'));
  const permission = permitted.find((p) => p.providerId === to);
  if (!policy.purposes.includes(purpose) || !permission || (from !== undefined && from !== to && policy.fallback !== 'allowlisted') || (policy.fallback === 'none' && permitted[0]?.providerId !== to)) throw new Error('provider selection refused');
  if (identity.scopeId !== policy.identity.scopeId || identity.callId !== policy.identity.callId || identity.generation.workerGeneration !== policy.identity.generation.workerGeneration || identity.generation.inferenceGeneration < policy.identity.generation.inferenceGeneration || identity.generation.transportEpoch < policy.identity.generation.transportEpoch) throw new Error('provider identity refused');
  const request: ProviderOpening = { ...copyAudioIdentity(identity), purpose, from, to, reason, priceVersion: permission.priceVersion };
  try {
    await policy.authorize(request);
  } catch {
    // One fixed refusal, whatever the authorizer threw.
    throw new Error('provider authorization refused');
  }
  if (from !== undefined && from !== to) policy.onFallback(request);
}
