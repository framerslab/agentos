/**
 * @fileoverview Shared judge LLM selection config + resolution
 * (spec batch-1 C3) — the single source for the orchestration IR judge
 * node type, the public builder, and runtime consumers (previously three
 * independently drifting shapes).
 */
import type { EffortLevel } from './model-effort.js';
import { resolveDefaultJudgeModel } from './default-judge.js';

/** Shared judge LLM selection fields. */
export interface JudgeLlmConfig {
  /** Judge model id. Default: the central resolver (`gpt-5.6`). */
  model?: string;
  /** Provider id. Pinning a non-openai provider REQUIRES an explicit model. */
  provider?: string;
  /**
   * Reasoning effort. When omitted, the resolver's default effort is applied
   * ONLY when the resolver's model was also selected — a caller-pinned model
   * gets no injected effort (zero request-shape change for pinned callers).
   */
  effort?: EffortLevel;
}

/** Resolved judge selection: model/provider always concrete, effort optional. */
export interface ResolvedJudgeLlm {
  provider: string;
  model: string;
  effort?: EffortLevel;
}

/**
 * Field-wise caller-wins resolution with the uniform cross-provider rule,
 * resolved in three separate layers (code default → validated env valves →
 * caller fields) so the env valves can never leak into the caller rule:
 *
 * - A CALLER-pinned provider other than the code default (`openai`) without
 *   a CALLER-pinned model is a config error (never a silent substitution) —
 *   judged against the caller's own fields, not the env-effective default.
 * - A caller pinning only `provider: 'openai'` gets the code-default model
 *   (gpt-5.6), NOT an env-valve model that was set alongside a different
 *   env provider (that pair travels together or not at all).
 * - Env valves apply only when the caller pinned nothing that contradicts
 *   them.
 */
export function resolveJudgeLlm(config: JudgeLlmConfig | undefined): ResolvedJudgeLlm {
  const CODE_DEFAULT_PROVIDER = 'openai';
  const CODE_DEFAULT_MODEL = 'gpt-5.6';
  const def = resolveDefaultJudgeModel();

  const callerProvider = config?.provider?.trim().toLowerCase() || undefined;
  const pinnedModel = config?.model?.trim() || undefined;

  // Cross-provider rule against the CALLER's fields and the CODE default.
  if (callerProvider && callerProvider !== CODE_DEFAULT_PROVIDER && !pinnedModel) {
    throw new Error(
      `judge config pins provider '${callerProvider}' without a model; an explicit model is required for non-default judge providers`,
    );
  }

  let provider: string;
  let model: string;
  if (pinnedModel) {
    // Caller pinned a model: caller's provider (or code default) carries it;
    // env valves are fully out of the picture.
    provider = callerProvider ?? CODE_DEFAULT_PROVIDER;
    model = pinnedModel;
  } else if (callerProvider) {
    // Caller pinned openai without a model (non-openai throws above): the
    // env model valve belongs to ITS OWN provider pair — never misrouted
    // onto the caller's explicit provider choice.
    provider = callerProvider;
    model = def.provider === callerProvider ? def.model : CODE_DEFAULT_MODEL;
  } else {
    // Nothing pinned: the env-resolved (or code) default pair applies whole.
    provider = def.provider;
    model = def.model;
  }

  const effort = config?.effort ?? (pinnedModel ? undefined : def.effort);
  return { provider, model, ...(effort !== undefined ? { effort } : {}) };
}

/**
 * Judge configuration for orchestration human-node delegation — the shared
 * shape for the IR node type, the public builder, and the NodeExecutor
 * runtime (previously three drifting inline copies).
 */
export interface JudgeNodeConfig extends JudgeLlmConfig {
  /** Custom evaluation criteria/rubric. */
  criteria?: string;
  /** Confidence threshold (0–1). Below this, fall through to the human interrupt. Defaults to `0.7`. */
  confidenceThreshold?: number;
}
