/**
 * @fileoverview Extended-thinking helpers for the Anthropic
 * reasoning-default Claude models.
 *
 * Turning thinking on: the Opus 4.7 / 4.8 family, Opus 5.x, Sonnet 5.x and
 * Fable 5.x take ONLY the adaptive form as the on-switch on the Messages API:
 * `thinking: { type: 'adaptive' }`. The older manual form `thinking: { type:
 * 'enabled', budget_tokens }` is removed on this family and returns a 400
 * ('"thinking.type.enabled" is not supported for this model'). Depth is
 * controlled by `output_config.effort`, not a token budget, so the
 * caller-facing `{ budgetTokens }` option acts as the on-switch and the
 * number itself is not sent. {@link AnthropicProvider} sends the block
 * through {@link resolveThinkingPayload} when a caller passes a thinking
 * budget AND the model supports it.
 *
 * Turning thinking off (`thinking: false`): leaving the field out keeps the
 * model's default, which is thinking ON for Opus 5, Sonnet 5 and Sonnet 5.5,
 * and always on for Opus 5.5, Fable and Mythos. The models that can turn it
 * off each take their own shape, and some only at a capped effort;
 * {@link resolveThinkingOff} maps a model id to it.
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
 * line, Opus 5, Sonnet 5, and Fable 5 (and their dated variants like
 * `claude-opus-4-8-20260501`) accept it; every other Claude model ignores
 * or rejects it. Opus 5.5, Sonnet 5.5 and Fable 5.1 match the `opus-5`,
 * `sonnet-5` and `fable-5` alternatives on purpose, because `\b` matches at
 * the hyphen before their trailing version digit. Future reasoning-first
 * siblings get added to the regex as Anthropic releases them, in lockstep
 * with `modelSupportsTemperature`.
 *
 * @param modelId Anthropic-side model id.
 * @returns `true` when Anthropic accepts a `thinking` block for this model.
 */
export function modelSupportsThinking(modelId: string): boolean {
  return /^claude-(opus-4-(7|8)|opus-5|sonnet-5|fable-5)\b/i.test(modelId);
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
 * @param thinking Caller-supplied `{ budgetTokens }`; `false` (thinking
 *   off, see {@link resolveThinkingOff}) and `undefined` return `null`.
 * @param requestedMaxTokens The max_tokens already resolved for the request.
 */
export function resolveThinkingPayload(
  modelId: string,
  thinking: { budgetTokens: number } | false | undefined,
  requestedMaxTokens: number | undefined,
): ResolvedThinkingPayload | null {
  if (!thinking || !modelSupportsThinking(modelId)) return null;
  return { thinking: { type: 'adaptive' }, maxTokens: requestedMaxTokens ?? 0 };
}

/**
 * How one model takes a request to turn thinking off.
 *
 * - `omit`: the model does not think unless asked, so leaving `thinking` out
 *   is off.
 * - `send`: the model thinks by default and turns it off only for this
 *   `thinking` value. `maxEffort` is the highest `output_config.effort` the
 *   value is accepted with; absent means any effort.
 * - `always_on`: the model always thinks and rejects every off shape.
 */
export type ThinkingOffShape =
  | { kind: 'omit' }
  | {
      kind: 'send';
      thinking: { type: 'disabled' } | { type: 'between_tools' };
      maxEffort?: 'high';
    }
  | { kind: 'always_on' };

/**
 * The request shape that turns thinking off on a Claude model, for a caller
 * passing `thinking: false`.
 *
 * | Model | Off shape | Source |
 * | --- | --- | --- |
 * | Sonnet 5.5 | `{ type: 'between_tools' }` at effort high or below | probed 2026-09-30: `disabled` returns 400, `between_tools` 200 |
 * | Opus 5 | `{ type: 'disabled' }` at effort high or below | probed 2026-09-30: `disabled` 200, `between_tools` 400 |
 * | Sonnet 5 | `{ type: 'disabled' }` | Anthropic's model docs |
 * | Opus 5.5, Fable 5.x, Mythos 5.x | none: always on | probed 2026-09-30 on Opus 5.5 and Fable 5.1: both shapes return 400 |
 * | everything else | omit the field | thinks only when asked |
 *
 * The 5.5 checks run first because `opus-5\b` and `sonnet-5\b` also match
 * the 5.5 ids. An unknown id gets `omit`, which never sends a shape that
 * could return 400. Anchored like {@link modelSupportsThinking}, so the id
 * is the bare Anthropic-side one.
 *
 * @param modelId Anthropic-side model id, bare or dated.
 * @returns The off shape for the model.
 */
export function resolveThinkingOff(modelId: string): ThinkingOffShape {
  if (/^claude-sonnet-5-5\b/i.test(modelId)) {
    return { kind: 'send', thinking: { type: 'between_tools' }, maxEffort: 'high' };
  }
  if (/^claude-(opus-5-5|fable-5|mythos-5)\b/i.test(modelId)) return { kind: 'always_on' };
  if (/^claude-opus-5\b/i.test(modelId)) {
    return { kind: 'send', thinking: { type: 'disabled' }, maxEffort: 'high' };
  }
  if (/^claude-sonnet-5\b/i.test(modelId)) return { kind: 'send', thinking: { type: 'disabled' } };
  return { kind: 'omit' };
}
