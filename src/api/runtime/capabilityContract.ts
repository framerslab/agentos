/**
 * Where a config field is read: `agent` (the lightweight `agent()` helper on its
 * legacy runtime), `generation` (generateText and streamText), `runtime` (the full
 * AgentOS runtime) and `gmi` (`agent({ runtime: 'gmi' })` and `gmi()`).
 */
export type CapabilitySurface = 'agent' | 'generation' | 'runtime' | 'gmi';

export type CapabilitySupport =
  | 'enforced'
  | 'partially_enforced'
  | 'accepted_but_deferred'
  | 'runtime_only';

export const CAPABILITY_KEYS = [
  'tools',
  'memory',
  'rag',
  'discovery',
  'guardrails',
  'security',
  'permissions',
  'hitl',
  'emergent',
  'voice',
  'channels',
  'output',
  'provenance',
  'observability',
  'controls',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const BASE_AGENT_CONFIG_CAPABILITY_CONTRACT = {
  tools: { agent: 'enforced', generation: 'enforced', runtime: 'enforced', gmi: 'enforced' },
  // agent() reads `memory` only with runtime: 'gmi', which is the `gmi` surface.
  memory: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'enforced' },
  rag: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  discovery: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  guardrails: { agent: 'accepted_but_deferred', generation: 'partially_enforced', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  security: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  permissions: { agent: 'accepted_but_deferred', generation: 'partially_enforced', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  hitl: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  emergent: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  voice: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'runtime_only' },
  channels: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'runtime_only' },
  output: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  provenance: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  observability: { agent: 'partially_enforced', generation: 'partially_enforced', runtime: 'enforced', gmi: 'partially_enforced' },
  controls: { agent: 'partially_enforced', generation: 'runtime_only', runtime: 'enforced', gmi: 'partially_enforced' },
} as const satisfies Record<CapabilityKey, Record<CapabilitySurface, CapabilitySupport>>;

export function getCapabilitySupport(
  surface: CapabilitySurface,
  key: CapabilityKey,
): CapabilitySupport {
  return BASE_AGENT_CONFIG_CAPABILITY_CONTRACT[key][surface];
}
