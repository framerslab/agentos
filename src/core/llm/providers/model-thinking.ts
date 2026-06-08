/**
 * @fileoverview Extended-thinking (reasoning budget) helpers for the
 * Anthropic reasoning-default Claude models.
 *
 * The Opus 4.7 / 4.8 family reasons by default and accepts an explicit
 * `thinking: { type: 'enabled', budget_tokens }` block on the Messages
 * API to control how many tokens the model may spend reasoning before it
 * answers. {@link AnthropicProvider} sends this block through
 * {@link resolveThinkingPayload} when a caller passes a thinking budget
 * AND the model supports it.
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
 * line (and their dated variants like `claude-opus-4-8-20260501`) accept
 * it; every other Claude model ignores or rejects it. Future
 * reasoning-first siblings (5.x) get added to the regex as Anthropic
 * releases them, in lockstep with `modelSupportsTemperature`.
 *
 * @param modelId Anthropic-side model id.
 * @returns `true` when Anthropic accepts a `thinking` block for this model.
 */
export function modelSupportsThinking(modelId: string): boolean {
  return /^claude-opus-4-(7|8)\b/i.test(modelId);
}

/** The resolved extended-thinking payload plus the max_tokens to send. */
export interface ResolvedThinkingPayload {
  thinking: { type: 'enabled'; budget_tokens: number };
  maxTokens: number;
}

/**
 * Compute the Anthropic `thinking` block plus the `max_tokens` value to
 * send for an extended-thinking request.
 *
 * Anthropic requires `max_tokens` to exceed `budget_tokens` (the model
 * needs room to answer after it finishes reasoning), so the output
 * budget is floored at `budget + 8192`. A caller `maxTokens` already
 * above that floor is preserved. The thinking budget itself is clamped
 * to Anthropic's documented 1024-token minimum and floored to an integer.
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
  const budget = Math.max(1024, Math.floor(thinking.budgetTokens));
  const maxTokens = Math.max(requestedMaxTokens ?? 0, budget + 8192);
  return { thinking: { type: 'enabled', budget_tokens: budget }, maxTokens };
}
