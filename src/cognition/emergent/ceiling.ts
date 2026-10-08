/**
 * @fileoverview The host's ceiling for code-forged tools: validation into a
 * resolved ceiling, the check of a forging agent's request against it, and
 * the check of a host-built forge's options against it.
 * @module @framers/agentos/emergent/ceiling
 */

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

function bound(value: number | undefined, fallback: number, key: string, min: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min) {
    throw new CeilingError('invalid_bound', key, `expected an integer of at least ${min}, got ${String(value)}`);
  }
  return value;
}

/**
 * Validates a host's ceiling and applies its defaults. An empty `domains` or
 * `roots` list removes its capability (an empty list grants nothing).
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
      store: audit?.store ?? 'storage',
      content: audit?.content ?? 'digest',
      ...(audit?.retainDays !== undefined
        ? { retainDays: bound(audit.retainDays, 0, 'audit.retainDays', 1) }
        : {}),
    },
  };

  const fetch = capabilities.fetch;
  if (fetch) {
    const methods = fetch.methods ?? [...CEILING_DEFAULTS.methods];
    for (const method of methods) {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new CeilingError('method_not_allowed', 'capabilities.fetch.methods', `${String(method)}: stage 1 allows GET and HEAD`);
      }
    }
    let domains: string[] | '*' = '*';
    if (fetch.domains !== '*') {
      domains = fetch.domains.map((domain) => domain.toLowerCase());
      for (const domain of domains) {
        if (!HOSTNAME.test(domain)) {
          throw new CeilingError('invalid_domain', 'capabilities.fetch.domains', `"${domain}" is not a host name (no scheme, port or path)`);
        }
      }
    }
    if (domains === '*' || domains.length > 0) {
      resolved.fetch = {
        domains,
        methods,
        maxResponseBytes: bound(fetch.maxResponseBytes, CEILING_DEFAULTS.maxResponseBytes, 'capabilities.fetch.maxResponseBytes', 1),
        maxRedirects: bound(fetch.maxRedirects, CEILING_DEFAULTS.maxRedirects, 'capabilities.fetch.maxRedirects', 0),
        timeoutMs: bound(fetch.timeoutMs, CEILING_DEFAULTS.timeoutMs, 'capabilities.fetch.timeoutMs', 1),
      };
    }
  }

  const read = capabilities['fs.read'];
  if (read) {
    for (const root of read.roots) {
      if (!path.isAbsolute(root)) {
        throw new CeilingError('root_not_absolute', 'capabilities.fs.read.roots', `"${root}" is not an absolute path`);
      }
    }
    if (read.roots.length > 0) {
      resolved['fs.read'] = {
        roots: read.roots.map((root) => path.resolve(root)),
        maxBytesPerRead: bound(read.maxBytesPerRead, CEILING_DEFAULTS.maxBytesPerRead, 'capabilities.fs.read.maxBytesPerRead', 1),
        timeoutMs: bound(read.timeoutMs, CEILING_DEFAULTS.timeoutMs, 'capabilities.fs.read.timeoutMs', 1),
      };
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
 * A host-built forge under a ceiling: its options may be narrower than the
 * ceiling, and then they narrow it; they may never be wider. Only the
 * capabilities the ceiling grants are compared, since the broker injects no
 * other. An intersection is taken in the ceiling's terms and never widens:
 * disjoint lists are wider, not empty.
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
    const ceilingRoots = ceiling['fs.read'].roots;
    const forgeRoots = forge.fsReadRoots.map((root) => path.resolve(root));
    const wider = forgeRoots.filter((root) => !ceilingRoots.some((ceilingRoot) => within(root, ceilingRoot)));
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
