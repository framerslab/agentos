/**
 * @fileoverview Effort-capability helper for the reasoning Claude models.
 *
 * `output_config.effort` (low|medium|high|xhigh|max) controls reasoning depth
 * and overall token spend. Supported on Fable 5 / Mythos 5, Opus 4.5/4.6/4.7/4.8,
 * and Sonnet 4.6; Sonnet 4.5, Haiku 4.5, and older models 400 on it. It is
 * INDEPENDENT of the extended-thinking block and of tool_choice — it rides on
 * `output_config` and is emitted whenever the caller passes an effort level and
 * the model supports it. Kept pure (no provider/SDK import) like
 * `model-thinking.ts` so the unit test imports no provider code.
 */

/** The effort levels Anthropic accepts (Claude Code default for coding is `xhigh`). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Whether the given Claude model id accepts `output_config.effort`.
 *
 * Allow-by-explicit-family: Opus 4.5/4.6/4.7/4.8, Sonnet 4.6, and Fable/Mythos 5.
 * Matches both the bare (`claude-opus-4-8`) and provider-prefixed
 * (`anthropic/claude-opus-4-8`) forms — no `^` anchor.
 *
 * @param modelId Anthropic-side model id.
 */
export function modelSupportsEffort(modelId: string): boolean {
  return /claude-(opus-4-(5|6|7|8)|sonnet-4-6|fable-5|mythos-5)/i.test(modelId);
}

/** Whether a value is a valid effort level. */
export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}
