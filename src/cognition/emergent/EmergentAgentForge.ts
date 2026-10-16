/**
 * @fileoverview EmergentAgentForge — synthesizes a BaseAgentConfig from a
 * manager-supplied spec at runtime. Parallel to EmergentToolForge but for
 * agents instead of tools.
 *
 * Used by the hierarchical strategy when emergent.enabled is true: the
 * manager calls `spawn_specialist({ role, instructions, ... })` and the
 * forge produces (or rejects) the config that becomes a new sub-agent
 * in the running roster.
 *
 * @module agentos/emergent/EmergentAgentForge
 */

import type { BaseAgentConfig } from '../../api/types.js';
import { IDENTIFIER_PATTERN } from './ToolName.js';

/** Minimum spec the manager must supply when calling `spawn_specialist`. */
export interface AgentSpec {
  /** Identifier for the new agent — becomes part of `delegate_to_<role>`. */
  role: string;
  /** System instructions for the new agent. */
  instructions: string;
  /** Optional override of the agency-level model. */
  model?: string;
  /** Optional override of the agency-level provider. */
  provider?: string;
  /** Optional justification (required when `EmergentPlannerConfig.requireJustification` is true). */
  justification?: string;
}

/** Defaults the forge inherits from agency-level config when the spec omits them. */
export interface ForgeDefaults {
  /** Default model for synthesised agents (typically the agency's model). */
  defaultModel: string;
  /** Default provider for synthesised agents (typically the agency's provider). */
  defaultProvider: string;
  /** Hard cap on synthesised instructions length to bound token cost. Default: 8192. */
  maxInstructionsLength?: number;
}

/** Result of a forge call — discriminated success/failure. */
export type ForgeResult =
  | { ok: true; config: BaseAgentConfig }
  | { ok: false; reason: string; spec: AgentSpec };

/**
 * Tool names the manager already exposes — synthesised role names that would
 * collide with these are rejected at forge time so we never emit two tools
 * with the same name into the manager's tool table.
 */
const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set([
  'spawn_specialist',
  'delegate_to_self',
  'final_answer',
  'plan',
]);

/**
 * Synthesizes BaseAgentConfig instances from manager-supplied specs.
 *
 * Stateless — safe to share one instance across many agency runs. Validation
 * happens entirely client-side (no LLM call) so a `forge()` invocation is
 * cheap and deterministic given the same spec + defaults.
 */
export class EmergentAgentForge {
  private readonly defaults: Required<ForgeDefaults>;

  constructor(defaults: ForgeDefaults) {
    this.defaults = {
      maxInstructionsLength: 8192,
      ...defaults,
    };
  }

  /**
   * Forge a new BaseAgentConfig from the supplied spec.
   *
   * @param spec - The manager's request: role, instructions, optional model overrides.
   * @param inheritedConfig - Subset of agency-level config the new agent inherits
   *   (memory, guardrails, security, etc). Pass through whatever the agency
   *   wants its synthesised children to share.
   * @returns A `{ ok: true, config }` or `{ ok: false, reason }` result.
   *   Never throws — all rejection paths return structured failures so the
   *   caller can surface them back to the manager as tool errors.
   */
  async forge(
    spec: AgentSpec,
    inheritedConfig: Partial<BaseAgentConfig> = {},
  ): Promise<ForgeResult> {
    if (!spec.instructions || spec.instructions.trim().length === 0) {
      return {
        ok: false,
        reason: 'spec.instructions must be a non-empty string',
        spec,
      };
    }

    if (RESERVED_ROLE_NAMES.has(spec.role)) {
      return {
        ok: false,
        reason: `spec.role "${spec.role}" is reserved and cannot be used as a synthesised agent name`,
        spec,
      };
    }

    // A role names the synthesised agent's delegate_to_<role> tool, so it is held to the identifier pattern a
    // forged tool's name is held to.
    if (!IDENTIFIER_PATTERN.test(spec.role)) {
      return {
        ok: false,
        reason: `spec.role "${spec.role}" is not a valid identifier (must match ${IDENTIFIER_PATTERN})`,
        spec,
      };
    }

    const instructions =
      spec.instructions.length > this.defaults.maxInstructionsLength
        ? spec.instructions.slice(0, this.defaults.maxInstructionsLength)
        : spec.instructions;

    const config: BaseAgentConfig = {
      ...inheritedConfig,
      instructions,
      model: spec.model ?? this.defaults.defaultModel,
      provider: spec.provider ?? this.defaults.defaultProvider,
      name: spec.role,
    };

    return { ok: true, config };
  }
}
