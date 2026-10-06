/**
 * @fileoverview The catalogue of capabilities a code-forged tool can be
 * granted, and the one alias table that maps the names injected into forged
 * code onto it.
 * @module @framers/agentos/emergent/capabilities
 */

import type { CapabilityName, SandboxAPI } from './types.js';

/**
 * Every catalogue name, in catalogue order. {@link normalizeAllowlist} reports
 * its names in this order whatever order a request wrote them in, so one grant
 * has one stored form.
 */
export const CAPABILITY_NAMES: readonly CapabilityName[] = ['fetch', 'fs.read', 'crypto'];

/** Names accepted in a request that are not catalogue names. */
export const CAPABILITY_ALIASES: Readonly<Record<string, CapabilityName>> = {
  'fs.readFile': 'fs.read',
};

/** The catalogue name a request's name stands for, or `undefined` for a name outside the catalogue. */
function catalogueNameOf(raw: string): CapabilityName | undefined {
  // Own properties only: a plain lookup reads `constructor`, `toString` and
  // `__proto__` from Object.prototype.
  const alias = Object.prototype.hasOwnProperty.call(CAPABILITY_ALIASES, raw)
    ? CAPABILITY_ALIASES[raw]
    : undefined;
  const name = alias ?? raw;
  return (CAPABILITY_NAMES as readonly string[]).includes(name) ? (name as CapabilityName) : undefined;
}

/**
 * Maps a request's names onto catalogue names, drops duplicates and returns
 * them in catalogue order. Names outside the catalogue are returned in
 * `unknown`, in the order given, never dropped.
 */
export function normalizeAllowlist(names: readonly string[]): {
  capabilities: CapabilityName[];
  unknown: string[];
} {
  const granted = new Set<CapabilityName>();
  const unknown: string[] = [];
  for (const raw of names) {
    const name = catalogueNameOf(raw);
    if (name) {
      granted.add(name);
    } else if (!unknown.includes(raw)) {
      unknown.push(raw);
    }
  }
  return { capabilities: CAPABILITY_NAMES.filter((name) => granted.has(name)), unknown };
}

/** The names `SandboxedToolForge` injects for a set of catalogue names. */
export function toSandboxApis(capabilities: readonly CapabilityName[]): SandboxAPI[] {
  return capabilities.map((name) => (name === 'fs.read' ? 'fs.readFile' : name));
}
