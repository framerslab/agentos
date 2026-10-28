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
  'agencies',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const BASE_AGENT_CONFIG_CAPABILITY_CONTRACT = {
  tools: { agent: 'enforced', generation: 'enforced', runtime: 'enforced', gmi: 'enforced' },
  // The default runtime reads the working callback; store settings remain deferred.
  memory: { agent: 'partially_enforced', generation: 'runtime_only', runtime: 'enforced', gmi: 'enforced' },
  rag: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  discovery: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  guardrails: { agent: 'accepted_but_deferred', generation: 'partially_enforced', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  // Nothing in AgentOS reads `security` or `permissions` (see SecurityTier and
  // PermissionsConfig in types.ts), so no surface enforces them, and both rows
  // are deferred on every surface. GenerateTextOptions and AgentOSConfig do not
  // declare either field: the full runtime's own tool permission checks are
  // configured through `toolPermissionManagerConfig`.
  security: { agent: 'accepted_but_deferred', generation: 'accepted_but_deferred', runtime: 'accepted_but_deferred', gmi: 'accepted_but_deferred' },
  permissions: { agent: 'accepted_but_deferred', generation: 'accepted_but_deferred', runtime: 'accepted_but_deferred', gmi: 'accepted_but_deferred' },
  hitl: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  emergent: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  // Only agent({ voice: { enabled: true, session } }).voiceSession constructs the configured runtime.
  voice: { agent: 'partially_enforced', generation: 'runtime_only', runtime: 'accepted_but_deferred', gmi: 'runtime_only' },
  channels: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'runtime_only' },
  output: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  provenance: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'accepted_but_deferred' },
  observability: { agent: 'partially_enforced', generation: 'partially_enforced', runtime: 'enforced', gmi: 'partially_enforced' },
  controls: { agent: 'partially_enforced', generation: 'runtime_only', runtime: 'enforced', gmi: 'partially_enforced' },
  // A GMI launches teams through launch_agency: on gmi() and agent({ runtime: 'gmi' }), and on the full runtime for a
  // persona granted agency:launch. agent() on its legacy runtime throws on `launch` and applies none of the other
  // fields; generateText and streamText launch nothing.
  agencies: { agent: 'accepted_but_deferred', generation: 'runtime_only', runtime: 'enforced', gmi: 'enforced' },
} as const satisfies Record<CapabilityKey, Record<CapabilitySurface, CapabilitySupport>>;

export function getCapabilitySupport(
  surface: CapabilitySurface,
  key: CapabilityKey,
): CapabilitySupport {
  return BASE_AGENT_CONFIG_CAPABILITY_CONTRACT[key][surface];
}
