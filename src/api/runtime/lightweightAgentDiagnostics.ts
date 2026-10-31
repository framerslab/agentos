import type { BaseAgentConfig } from '../types.js';

import {
  BASE_AGENT_CONFIG_CAPABILITY_CONTRACT,
  CAPABILITY_KEYS,
  type CapabilityKey,
  type CapabilitySurface,
} from './capabilityContract.js';

/**
 * A config the capability contract is read against: the fields of {@link BaseAgentConfig}, and `agencies`, which
 * `agent()` and `gmi()` declare on their own options.
 */
export type CapabilityConfig = Partial<BaseAgentConfig> & { agencies?: unknown };

/**
 * Whether a config value sets anything. `undefined`, `null`, `false`, a blank
 * string, an empty Map or Set and an array of unset entries are unset; an
 * object is set when its `enabled` is true, whatever its other entries are, or
 * when an entry other than `enabled` is set, so `{ enabled: false }` is unset.
 */
export function isMeaningfullyConfigured(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => isMeaningfullyConfigured(entry));
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
    return entries.some(([key, entryValue]) => (key === 'enabled' ? entryValue === true : isMeaningfullyConfigured(entryValue)));
  }
  return true;
}

/**
 * The config fields that are set but that `surface` accepts without enforcing
 * (`accepted_but_deferred` in {@link BASE_AGENT_CONFIG_CAPABILITY_CONTRACT}),
 * plus, on the `agent` surface, memory settings beyond the default runtime's
 * working callback and a set `voice` (`agent()` passes its config without a
 * configured `voice.session`, the one voice binding it applies).
 */
export function getDeferredCapabilities(
  config: CapabilityConfig,
  surface: CapabilitySurface,
): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((key) => {
    // agent() applies voice only through a configured voice.session, which it removes before
    // this check; every other voice field it receives is accepted and not applied.
    if (key === 'voice' && surface === 'agent') return isMeaningfullyConfigured(config.voice);
    if (key === 'memory' && surface === 'agent') {
      const memory = config.memory;
      if (typeof memory === 'object' && memory !== null && typeof memory.working === 'function') {
        const { working: _working, ...deferred } = memory;
        return isMeaningfullyConfigured(deferred);
      }
      return isMeaningfullyConfigured(memory);
    }
    return BASE_AGENT_CONFIG_CAPABILITY_CONTRACT[key][surface] === 'accepted_but_deferred'
      && isMeaningfullyConfigured(config[key]);
  });
}

/**
 * The fields set on an `agent()` config that the agent without `runtime: 'gmi'`
 * accepts and does not apply: {@link getDeferredCapabilities} for the `agent`
 * surface.
 */
export function getDeferredLightweightAgentCapabilities(
  config: CapabilityConfig,
): CapabilityKey[] {
  return getDeferredCapabilities(config, 'agent');
}

/**
 * The fields no surface enforces (see the capability contract), so the
 * warning names neither the full runtime nor `agency()` for them.
 */
const ENFORCED_ON_NO_SURFACE: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>(['security', 'permissions']);

/**
 * The deferred fields `agency()` applies: its approval gates (`hitl`), the
 * specialists the hierarchical strategy spawns (`emergent`), structured output
 * (`output`) and its provenance trail (`provenance`). The warning points the
 * other deferred fields to the full runtime alone: `agency()` reports its
 * guardrails as not evaluated, retrieves no RAG context, reads no `discovery`,
 * serves `voice` as text with no speech, and wires no channels.
 */
const APPLIED_BY_AGENCY: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>(['hitl', 'emergent', 'output', 'provenance']);

/**
 * Logs one warning through `warn` when `config` sets a field that
 * {@link getDeferredLightweightAgentCapabilities} returns, and returns those
 * fields. The message has one part per group: the legacy voice fields, which
 * it points to `voice.session` with `voiceSession()` or to
 * `VoiceSessionFactory`, the fields it points to the full runtime or
 * `agency()`, those it points to the full runtime alone, the memory settings
 * other than the working callback, `agencies`, which only `runtime: 'gmi'`
 * applies on `agent()`, and `security` and `permissions`, which no surface
 * enforces. `agent()` without `runtime: 'gmi'` calls it once at construction,
 * after the check that refuses `agencies.launch`.
 */
export function warnOnDeferredLightweightAgentCapabilities(
  config: CapabilityConfig,
  warn: (message: string) => void = console.warn,
): CapabilityKey[] {
  const deferredCapabilities = getDeferredLightweightAgentCapabilities(config);
  if (deferredCapabilities.length === 0) {
    return deferredCapabilities;
  }

  const parts: string[] = [];
  const enforcedNowhere = deferredCapabilities.filter((key) => ENFORCED_ON_NO_SURFACE.has(key));
  const others = deferredCapabilities.filter(
    (key) => key !== 'memory' && key !== 'voice' && key !== 'agencies' && !ENFORCED_ON_NO_SURFACE.has(key),
  );
  if (deferredCapabilities.includes('voice')) {
    parts.push('agent() accepts legacy voice fields without starting audio. Configure voice.session and call voiceSession(), or construct VoiceSessionFactory directly.');
  }
  const runtimeOrAgency = others.filter((key) => APPLIED_BY_AGENCY.has(key));
  const runtimeAlone = others.filter((key) => !APPLIED_BY_AGENCY.has(key));
  if (runtimeOrAgency.length > 0) {
    parts.push(`agent() accepted config that requires the full AgentOS runtime or agency(): ${runtimeOrAgency.join(', ')}.`);
  }
  if (runtimeAlone.length > 0) {
    parts.push(`agent() accepted config that requires the full AgentOS runtime: ${runtimeAlone.join(', ')}.`);
  }
  if (others.length > 0) {
    parts.push('The lightweight helper preserves these fields for compatibility but does not actively enforce them.');
  }
  // The default runtime consumes only the working callback, filtered above.
  if (deferredCapabilities.includes('memory')) {
    parts.push("agent() applies memory settings other than the working callback only with runtime: 'gmi'; these settings are not applied here.");
  }
  // Only a GMI that gmi() or agent({ runtime: 'gmi' }) builds launches teams, so the parts above, which name the full
  // runtime or agency(), leave agencies out.
  if (deferredCapabilities.includes('agencies')) {
    parts.push("agent() launches teams only with runtime: 'gmi' (agencies.launch); this agent does not apply agencies.");
  }
  if (enforcedNowhere.length > 0) {
    parts.push(
      `agent() accepted ${enforcedNowhere.join(' and ')}, which no AgentOS surface enforces; `
        + 'gate tools with hitl.approvals.beforeTool on agency() or an onBeforeToolExecution hook.',
    );
  }
  warn(`[AgentOS] ${parts.join(' ')}`);

  return deferredCapabilities;
}
