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
 * Field-wise caller-wins resolution with the uniform cross-provider rule:
 * a pinned non-default provider without an explicit model is a config error
 * (never a silent substitution).
 */
export function resolveJudgeLlm(config: JudgeLlmConfig | undefined): ResolvedJudgeLlm {
  const def = resolveDefaultJudgeModel();
  const provider = config?.provider ?? def.provider;
  const pinnedModel = config?.model?.trim() || undefined;
  if (!pinnedModel && provider !== def.provider) {
    throw new Error(
      `judge config pins provider '${provider}' without a model; an explicit model is required for non-default judge providers`,
    );
  }
  const model = pinnedModel ?? def.model;
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
