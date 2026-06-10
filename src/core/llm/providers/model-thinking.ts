/**
 * @fileoverview Extended-thinking helpers for the Anthropic
 * reasoning-default Claude models.
 *
 * The Opus 4.7 / 4.8 family and Fable 5 reason by default and accept ONLY
 * the adaptive thinking form on the Messages API: `thinking: { type:
 * 'adaptive' }`. The older manual form `thinking: { type: 'enabled',
 * budget_tokens }` is removed on this family and returns a 400
 * ('"thinking.type.enabled" is not supported for this model'). Fable 5 adds
 * one more constraint — an explicit `thinking: { type: 'disabled' }` also
 * 400s — but the provider only ever emits the adaptive form (or nothing),
 * never `disabled`, so that path is never hit. Depth is
 * controlled by `output_config.effort`, not a token budget, so the
 * caller-facing `{ budgetTokens }` option acts as the on-switch and the
 * number itself is not sent. {@link AnthropicProvider} sends the block
 * through {@link resolveThinkingPayload} when a caller passes a thinking
 * budget AND the model supports it.
 *
 * This is the thinking-capability sibling of `modelSupportsTemperature`
 * in AnthropicProvider.ts — the same reasoning-default family that
 * REJECTS `temperature` is the family that ACCEPTS `thinking`. Kept in
 * its own pure module (mirroring `model-output-limits.ts`) so the unit
 * test imports no provider/SDK code.
 */

/**
 * Whether the given Claude model id accepts the extended-thinking
 * `thinking` parameter.
 *
 * Allow-by-explicit-family: only the reasoning-default Opus 4.7 / 4.8
 * line and Fable 5 (and their dated variants like
 * `claude-opus-4-8-20260501`) accept it; every other Claude model ignores
 * or rejects it. Future reasoning-first siblings get added to the regex as
 * Anthropic releases them, in lockstep with `modelSupportsTemperature`.
 *
 * @param modelId Anthropic-side model id.
 * @returns `true` when Anthropic accepts a `thinking` block for this model.
 */
export function modelSupportsThinking(modelId: string): boolean {
  return /^claude-(opus-4-(7|8)|fable-5)\b/i.test(modelId);
}

/** The resolved extended-thinking payload plus the max_tokens to send. */
export interface ResolvedThinkingPayload {
  thinking: { type: 'adaptive' };
  maxTokens: number;
}

/**
 * Compute the Anthropic `thinking` block plus the `max_tokens` value to
 * send for an extended-thinking request.
 *
 * Emits the adaptive form — the only thinking shape the gated Opus
 * 4.7/4.8 family accepts. Adaptive thinking carries no token budget, so
 * the caller's `budgetTokens` is treated purely as the on-switch
 * (any positive value enables thinking) and `max_tokens` passes through
 * unchanged — there is no budget for it to clear.
 *
 * Returns `null` when no budget is requested or the model can't think,
 * so the caller leaves the request untouched (no thinking block, no
 * max_tokens change).
 *
 * @param modelId Anthropic-side model id.
 * @param thinking Caller-supplied `{ budgetTokens }`, or `undefined`.
 * @param requestedMaxTokens The max_tokens already resolved for the request.
 */
export function resolveThinkingPayload(
  modelId: string,
  thinking: { budgetTokens: number } | undefined,
  requestedMaxTokens: number | undefined,
): ResolvedThinkingPayload | null {
  if (!thinking || !modelSupportsThinking(modelId)) return null;
  return { thinking: { type: 'adaptive' }, maxTokens: requestedMaxTokens ?? 0 };
}
