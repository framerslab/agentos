/**
 * @fileoverview The delivery policy of results derived from private sources: a result keeps every source version it
 * was made from, and goes only to its owner's private use while each of those sources is unchanged and unexpired.
 * @module agentos/cognition/library/SourceDerivations
 */

/**
 * One restricted source version that contributed to a result. Identifiers are opaque application keys, never
 * display text; `generation` is a nonnegative safe integer and `expiresAt` is integer UTC epoch milliseconds.
 */
export interface SourceDependency {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly sourceId: string;
  readonly messageIds: readonly string[];
  readonly version: string;
  readonly expiresAt: number;
}

/** Authoritative source state read under the consumer's transaction fence. */
export interface SourceDependencyState extends SourceDependency {
  readonly connected: boolean;
  readonly paused: boolean;
  readonly searchAskEnabled: boolean;
  readonly liveEnabled: boolean;
}

/** A whole result's private provenance; public inputs do not remove these dependencies. */
export interface SourceDerivation {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly visibility: 'personal';
  readonly expiresAt: number;
  readonly dependencies: readonly SourceDependency[];
}

/** Delivery destinations are explicit so sharing cannot fall through to private use. */
export type SourceDeliverySurface =
  | 'search' | 'ask' | 'live' | 'team' | 'guest' | 'share' | 'export' | 'outbound';

/** Authenticated delivery scope and the personal session's saved live choice. */
export interface SourceDeliveryContext {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly surface: SourceDeliverySurface;
  readonly liveOptIn: boolean;
}

const nonempty = (value: string): boolean => typeof value === 'string' && value.length > 0;
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function valid(dependency: SourceDependency): boolean {
  return nonempty(dependency.tenantId) && nonempty(dependency.ownerId)
    && nonempty(dependency.connectionId) && nonempty(dependency.sourceId)
    && nonempty(dependency.version) && integer(dependency.generation)
    && integer(dependency.expiresAt) && Array.isArray(dependency.messageIds)
    && dependency.messageIds.length > 0 && dependency.messageIds.every(nonempty);
}

function key(dependency: SourceDependency): string {
  return JSON.stringify([
    dependency.tenantId, dependency.ownerId, dependency.connectionId, dependency.sourceId,
  ]);
}

function invalid(): never {
  throw new RangeError('invalid_source_dependency');
}

/**
 * Copies and freezes all contributing private dependencies, unions message ids and
 * takes the earliest expiry. Conflicting owner, generation or version is refused.
 * Pass dependencies from every private input, including ones without displayed quotes.
 *
 * @throws {RangeError} `invalid_source_dependency` for an empty list, an invalid dependency or a refused conflict.
 */
export function createSourceDerivation(dependencies: readonly SourceDependency[]): SourceDerivation {
  const first = dependencies[0];
  if (!first || !valid(first)) return invalid();
  const merged = new Map<string, SourceDependency>();
  for (const dependency of dependencies) {
    if (!valid(dependency) || dependency.tenantId !== first.tenantId || dependency.ownerId !== first.ownerId) {
      return invalid();
    }
    const id = key(dependency);
    const previous = merged.get(id);
    if (previous && (previous.generation !== dependency.generation || previous.version !== dependency.version)) {
      return invalid();
    }
    const messages = [...new Set([...(previous?.messageIds ?? []), ...dependency.messageIds])].sort();
    merged.set(id, Object.freeze({
      tenantId: dependency.tenantId,
      ownerId: dependency.ownerId,
      connectionId: dependency.connectionId,
      generation: dependency.generation,
      sourceId: dependency.sourceId,
      messageIds: Object.freeze(messages),
      version: dependency.version,
      expiresAt: Math.min(previous?.expiresAt ?? dependency.expiresAt, dependency.expiresAt),
    }));
  }
  const normalized = [...merged.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, dependency]) => dependency);
  const expiresAt = normalized.reduce((expiry, dependency) => Math.min(expiry, dependency.expiresAt), first.expiresAt);
  return Object.freeze({
    tenantId: first.tenantId,
    ownerId: first.ownerId,
    visibility: 'personal' as const,
    expiresAt,
    dependencies: Object.freeze(normalized),
  });
}

/**
 * Checks final delivery against fresh authoritative source state. This function does
 * not read a database or acquire locks; the caller must serialize it with revocation,
 * expiry, exclusion and policy changes at the commit/delivery boundary. `now` is integer
 * UTC epoch milliseconds, like every `expiresAt`.
 */
export function canDeliverSourceDerivation(
  derivation: SourceDerivation,
  context: SourceDeliveryContext,
  current: readonly SourceDependencyState[],
  now: number,
): boolean {
  if (!integer(now) || !integer(derivation.expiresAt) || derivation.expiresAt <= now
    || derivation.visibility !== 'personal' || derivation.tenantId !== context.tenantId
    || derivation.ownerId !== context.ownerId || derivation.dependencies.length === 0) return false;
  if (context.surface !== 'search' && context.surface !== 'ask' && context.surface !== 'live') return false;
  if (context.surface === 'live' && context.liveOptIn !== true) return false;

  const states = new Map<string, SourceDependencyState>();
  for (const state of current) {
    if (!valid(state)) return false;
    const id = key(state);
    if (states.has(id)) return false;
    states.set(id, state);
  }
  const seen = new Set<string>();
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const dependency of derivation.dependencies) {
    if (!valid(dependency) || dependency.tenantId !== derivation.tenantId
      || dependency.ownerId !== derivation.ownerId || dependency.expiresAt <= now) return false;
    const id = key(dependency);
    if (seen.has(id)) return false;
    seen.add(id);
    earliest = Math.min(earliest, dependency.expiresAt);
    const state = states.get(id);
    if (!state || state.connected !== true || state.paused !== false || state.expiresAt <= now
      || state.generation !== dependency.generation || state.version !== dependency.version) return false;
    if (context.surface === 'live' ? state.liveEnabled !== true : state.searchAskEnabled !== true) return false;
    const heldMessages = new Set(state.messageIds);
    if (!dependency.messageIds.every((messageId) => heldMessages.has(messageId))) return false;
  }
  return derivation.expiresAt === earliest;
}
