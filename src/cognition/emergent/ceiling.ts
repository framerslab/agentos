/**
 * @fileoverview The host's ceiling for code-forged tools: validation into a
 * resolved ceiling, the check of a forging agent's request against it, and
 * the check of a host-built forge's options against it.
 * @module @framers/agentos/emergent/ceiling
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { CAPABILITY_NAMES } from './capabilities.js';
import type { CapabilityName, EmergentAuditConfig, ForgedCapabilities } from './types.js';

/** A ceiling with every default applied and every list normalised. */
export interface ResolvedCeiling {
  fetch?: {
    domains: string[] | '*';
    methods: Array<'GET' | 'HEAD'>;
    maxResponseBytes: number;
    maxRedirects: number;
    timeoutMs: number;
  };
  'fs.read'?: { roots: string[]; maxBytesPerRead: number; timeoutMs: number };
  crypto?: true;
  audit: { store: 'storage' | 'none'; content: 'digest' | 'full'; retainDays?: number };
}

export type CeilingErrorCode =
  | 'unknown_capability'
  | 'root_not_absolute'
  | 'method_not_allowed'
  | 'invalid_domain'
  | 'invalid_bound'
  | 'invalid_audit'
  | 'audit_needs_storage'
  | 'forge_wider_than_ceiling';

/** A ceiling the engine cannot build; the message starts with the code and the key. */
export class CeilingError extends Error {
  constructor(
    readonly code: CeilingErrorCode,
    readonly key: string,
    detail: string,
  ) {
    super(`${code}: ${key}: ${detail}`);
    this.name = 'CeilingError';
  }
}

export const CEILING_DEFAULTS = {
  methods: ['GET', 'HEAD'] as Array<'GET' | 'HEAD'>,
  maxResponseBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  maxBytesPerRead: 1024 * 1024,
  timeoutMs: 30_000,
} as const;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The longest delay Node's timers keep (2^31 - 1 ms). Above it `setTimeout`
 * and `AbortSignal.timeout` fire at once, and from 2^32 `AbortSignal.timeout`
 * throws, so a time bound above it would end or fail every call.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** A value as an error message shows it. */
function shown(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'object' && value !== null) {
    return 'an object';
  }
  return typeof value === 'function' ? 'a function' : String(value);
}

/**
 * An integer bound from `min` to `max`, or the fallback when it is not set.
 * Byte bounds and counts stop at `Number.MAX_SAFE_INTEGER`, and time bounds
 * at {@link MAX_TIMER_MS}.
 */
function bound(
  value: number | undefined,
  fallback: number,
  key: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CeilingError('invalid_bound', key, `expected an integer from ${min} to ${max}, got ${shown(value)}`);
  }
  return value;
}

/** An audit setting: one of the values allowed, or the fallback when it is not set. */
function auditValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, key: string): T {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new CeilingError(
      'invalid_audit',
      key,
      `expected ${allowed.map((option) => `'${option}'`).join(' or ')}, got ${shown(value)}`,
    );
  }
  return value as T;
}

/**
 * Validates a host's ceiling and applies its defaults. An empty `domains` or
 * `roots` list removes its capability (an empty list grants nothing); the
 * capability's other settings are validated all the same. A configuration
 * read from JSON gets no type check, so each value's kind is checked here:
 * a mistyped audit setting, a list of the wrong shape or a bound out of its
 * range fails here, naming its key, never later at a call.
 *
 * @throws CeilingError naming the code and the key of the first failure.
 */
export function resolveCeiling(
  capabilities: ForgedCapabilities,
  audit: EmergentAuditConfig | undefined,
  options: { hasStorage: boolean },
): ResolvedCeiling {
  for (const key of Object.keys(capabilities)) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(key)) {
      throw new CeilingError(
        'unknown_capability',
        `capabilities.${key}`,
        `not in the catalogue (${CAPABILITY_NAMES.join(', ')})`,
      );
    }
  }
  const resolved: ResolvedCeiling = {
    audit: {
      store: auditValue(audit?.store, ['storage', 'none'] as const, 'storage', 'audit.store'),
      content: auditValue(audit?.content, ['digest', 'full'] as const, 'digest', 'audit.content'),
      ...(audit?.retainDays !== undefined
        ? { retainDays: bound(audit.retainDays, 0, 'audit.retainDays', 1) }
        : {}),
    },
  };

  const fetch = capabilities.fetch;
  if (fetch) {
    const givenMethods: unknown = fetch.methods ?? [...CEILING_DEFAULTS.methods];
    if (!Array.isArray(givenMethods)) {
      throw new CeilingError(
        'method_not_allowed',
        'capabilities.fetch.methods',
        `expected a list of methods, got ${shown(givenMethods)}`,
      );
    }
    for (const method of givenMethods) {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new CeilingError('method_not_allowed', 'capabilities.fetch.methods', `${String(method)}: stage 1 allows GET and HEAD`);
      }
    }
    const methods = givenMethods as Array<'GET' | 'HEAD'>;
    const givenDomains: unknown = fetch.domains;
    let domains: string[] | '*' = '*';
    if (givenDomains !== '*') {
      if (!Array.isArray(givenDomains)) {
        throw new CeilingError(
          'invalid_domain',
          'capabilities.fetch.domains',
          `expected '*' or a list of host names, got ${shown(givenDomains)}`,
        );
      }
      const odd = givenDomains.findIndex((domain) => typeof domain !== 'string');
      if (odd >= 0) {
        throw new CeilingError(
          'invalid_domain',
          'capabilities.fetch.domains',
          `entry ${odd} is ${shown(givenDomains[odd])}, not a host name`,
        );
      }
      domains = (givenDomains as string[]).map((domain) => domain.toLowerCase());
      for (const domain of domains) {
        if (!HOSTNAME.test(domain)) {
          throw new CeilingError('invalid_domain', 'capabilities.fetch.domains', `"${domain}" is not a host name (no scheme, port or path)`);
        }
      }
    }
    const scope = {
      domains,
      methods,
      maxResponseBytes: bound(fetch.maxResponseBytes, CEILING_DEFAULTS.maxResponseBytes, 'capabilities.fetch.maxResponseBytes', 1),
      maxRedirects: bound(fetch.maxRedirects, CEILING_DEFAULTS.maxRedirects, 'capabilities.fetch.maxRedirects', 0),
      timeoutMs: bound(fetch.timeoutMs, CEILING_DEFAULTS.timeoutMs, 'capabilities.fetch.timeoutMs', 1, MAX_TIMER_MS),
    };
    if (domains === '*' || domains.length > 0) {
      resolved.fetch = scope;
    }
  }

  const read = capabilities['fs.read'];
  if (read) {
    const givenRoots: unknown = read.roots;
    if (!Array.isArray(givenRoots)) {
      throw new CeilingError(
        'root_not_absolute',
        'capabilities.fs.read.roots',
        `expected a list of absolute paths, got ${shown(givenRoots)}`,
      );
    }
    for (const root of givenRoots) {
      if (typeof root !== 'string' || !path.isAbsolute(root)) {
        throw new CeilingError('root_not_absolute', 'capabilities.fs.read.roots', `${shown(root)} is not an absolute path`);
      }
    }
    const roots = givenRoots as string[];
    const maxBytesPerRead = bound(read.maxBytesPerRead, CEILING_DEFAULTS.maxBytesPerRead, 'capabilities.fs.read.maxBytesPerRead', 1);
    const timeoutMs = bound(read.timeoutMs, CEILING_DEFAULTS.timeoutMs, 'capabilities.fs.read.timeoutMs', 1, MAX_TIMER_MS);
    if (roots.length > 0) {
      resolved['fs.read'] = { roots: roots.map((root) => path.resolve(root)), maxBytesPerRead, timeoutMs };
    }
  }

  if (capabilities.crypto) {
    resolved.crypto = true;
  }

  if (resolved.audit.store === 'storage' && !options.hasStorage) {
    throw new CeilingError(
      'audit_needs_storage',
      'audit.store',
      "a ceiling records every capability call; pass a storage adapter, or set audit.store: 'none' (then no effect records are kept)",
    );
  }
  return resolved;
}

/** The capabilities a resolved ceiling grants, in catalogue order. */
export function grantedCapabilities(ceiling: ResolvedCeiling): CapabilityName[] {
  return CAPABILITY_NAMES.filter((name) => ceiling[name] !== undefined);
}

/** Whether a request (catalogue names) fits the ceiling; a refusal names the rest and what is allowed. */
export function checkRequest(
  request: readonly CapabilityName[],
  ceiling: ResolvedCeiling,
): { ok: true } | { ok: false; refused: CapabilityName[]; allowed: CapabilityName[] } {
  const allowed = grantedCapabilities(ceiling);
  const refused = request.filter((name) => !allowed.includes(name));
  return refused.length === 0 ? { ok: true } : { ok: false, refused, allowed };
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * A path with its symlinks resolved, as the broker resolves read roots (the
 * native realpath, as `fs/promises` uses), or the path as given when it does
 * not resolve: a path that does not exist reads nothing.
 */
function realOrGiven(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

/**
 * A host-built forge under a ceiling: its options may be narrower than the
 * ceiling, and then they narrow it; they may never be wider. Only the
 * capabilities the ceiling grants are compared, since the broker injects no
 * other. An intersection is taken in the ceiling's terms and never widens:
 * disjoint lists are wider, not empty. Read roots are compared after their
 * symlinks are resolved, the forge's and the ceiling's alike, since the
 * broker reads by real path: a forge root that is a link inside a ceiling
 * root to a directory outside it is wider. The narrowed roots are the
 * forge's, as it names them.
 *
 * @throws CeilingError (`forge_wider_than_ceiling`) naming the forge option.
 */
export function narrowToForge(
  ceiling: ResolvedCeiling,
  forge: { fetchDomainAllowlist: string[]; fsReadRoots: string[] },
): ResolvedCeiling {
  const narrowed: ResolvedCeiling = { ...ceiling };
  if (ceiling.fetch) {
    const forgeDomains = forge.fetchDomainAllowlist.map((domain) => domain.toLowerCase());
    if (forgeDomains.length === 0) {
      // The forge's empty list means every domain.
      if (ceiling.fetch.domains !== '*') {
        throw new CeilingError('forge_wider_than_ceiling', 'sandboxForge.fetchDomainAllowlist', 'the forge allows every domain');
      }
    } else {
      const ceilingDomains = ceiling.fetch.domains;
      const wider = ceilingDomains === '*' ? [] : forgeDomains.filter((domain) => !ceilingDomains.includes(domain));
      if (wider.length > 0) {
        throw new CeilingError('forge_wider_than_ceiling', 'sandboxForge.fetchDomainAllowlist', `outside the ceiling: ${wider.join(', ')}`);
      }
      narrowed.fetch = { ...ceiling.fetch, domains: forgeDomains };
    }
  }
  if (ceiling['fs.read']) {
    const ceilingRoots = ceiling['fs.read'].roots.map(realOrGiven);
    const forgeRoots = forge.fsReadRoots.map((root) => path.resolve(root));
    const wider: string[] = [];
    for (const root of forgeRoots) {
      const real = realOrGiven(root);
      if (!ceilingRoots.some((ceilingRoot) => within(real, ceilingRoot))) {
        wider.push(real === root ? root : `${root} (resolves to ${real})`);
      }
    }
    if (wider.length > 0) {
      throw new CeilingError('forge_wider_than_ceiling', 'sandboxForge.fsReadRoots', `outside the ceiling: ${wider.join(', ')}`);
    }
    if (forgeRoots.length === 0) {
      // A forge that reads nowhere: the intersection is empty, and an empty
      // intersection removes the capability rather than granting an empty list.
      delete narrowed['fs.read'];
    } else {
      narrowed['fs.read'] = { ...ceiling['fs.read'], roots: forgeRoots };
    }
  }
  return narrowed;
}
