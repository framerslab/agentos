/**
 * @fileoverview The catalogue of capabilities a code-forged tool can be
 * granted, and the one alias table that maps the names injected into forged
 * code onto it.
 * @module @framers/agentos/emergent/capabilities
 */

import type { CapabilityName, SandboxAPI } from './types.js';

/** Every catalogue name, in the order requests are reported. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = ['fetch', 'fs.read', 'crypto'];

/** Names accepted in a request that are not catalogue names. */
export const CAPABILITY_ALIASES: Readonly<Record<string, CapabilityName>> = {
  'fs.readFile': 'fs.read',
};

/**
 * Maps a request's names onto catalogue names and drops duplicates.
 * Names outside the catalogue are returned in `unknown`, never dropped.
 */
export function normalizeAllowlist(names: readonly string[]): {
  capabilities: CapabilityName[];
  unknown: string[];
} {
  const capabilities: CapabilityName[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = CAPABILITY_ALIASES[raw] ?? raw;
    if ((CAPABILITY_NAMES as readonly string[]).includes(name)) {
      if (!capabilities.includes(name as CapabilityName)) {
        capabilities.push(name as CapabilityName);
      }
    } else if (!unknown.includes(raw)) {
      unknown.push(raw);
    }
  }
  return { capabilities, unknown };
}

/** The names `SandboxedToolForge` injects for a set of catalogue names. */
export function toSandboxApis(capabilities: readonly CapabilityName[]): SandboxAPI[] {
  return capabilities.map((name) => (name === 'fs.read' ? 'fs.readFile' : name));
}
