import type { BaseAgentConfig } from '../types.js';

import {
  BASE_AGENT_CONFIG_CAPABILITY_CONTRACT,
  CAPABILITY_KEYS,
  type CapabilityKey,
  type CapabilitySurface,
} from './capabilityContract.js';

/**
 * Whether a config value sets anything. `undefined`, `null`, `false`, a blank
 * string, an empty Map or Set and an array of unset entries are unset; an
 * object is set when an entry other than `enabled` is set, or when its only
 * entry is `enabled: true`, so `{ enabled: false }` is unset.
 */
export function isMeaningfullyConfigured(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => isMeaningfullyConfigured(entry));
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
    if (entries.length === 0) return false;
    return entries.some(([key, entryValue]) => key !== 'enabled' && isMeaningfullyConfigured(entryValue))
      || (entries.length === 1 && entries[0]?.[0] === 'enabled' && entries[0][1] === true);
  }
  return true;
}

/**
 * The config fields that are set but that `surface` accepts without enforcing
 * (`accepted_but_deferred` in {@link BASE_AGENT_CONFIG_CAPABILITY_CONTRACT}).
 */
export function getDeferredCapabilities(
  config: Partial<BaseAgentConfig>,
  surface: CapabilitySurface,
): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((key) =>
    BASE_AGENT_CONFIG_CAPABILITY_CONTRACT[key][surface] === 'accepted_but_deferred'
    && isMeaningfullyConfigured(config[key]),
  );
}

export function getDeferredLightweightAgentCapabilities(
  config: Partial<BaseAgentConfig>,
): CapabilityKey[] {
  return getDeferredCapabilities(config, 'agent');
}

export function warnOnDeferredLightweightAgentCapabilities(
  config: Partial<BaseAgentConfig>,
  warn: (message: string) => void = console.warn,
): CapabilityKey[] {
  const deferredCapabilities = getDeferredLightweightAgentCapabilities(config);
  if (deferredCapabilities.length === 0) {
    return deferredCapabilities;
  }

  const parts: string[] = [];
  const others = deferredCapabilities.filter((key) => key !== 'memory');
  if (others.length > 0) {
    parts.push(
      `agent() accepted config that requires the full AgentOS runtime or agency(): ${others.join(', ')}. `
        + 'The lightweight helper preserves these fields for compatibility but does not actively enforce them.',
    );
  }
  // agency() does not apply `memory` either: only the GMI path reads it.
  if (deferredCapabilities.includes('memory')) {
    parts.push("agent() applies memory only with runtime: 'gmi' (cognitive memory for its sessions); this agent does not apply it.");
  }
  warn(`[AgentOS] ${parts.join(' ')}`);

  return deferredCapabilities;
}
