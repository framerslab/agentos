/**
 * @fileoverview Forced-tool_choice capability helper for the Anthropic
 * Claude models.
 *
 * Anthropic structured output and `toolChoice: 'required'` both resolve to a
 * FORCED `tool_choice` on the Messages API (`{ type: 'tool', name }` or
 * `{ type: 'any' }`). Most Claude models accept this, and it is the most
 * reliable way to constrain output. Claude Fable 5 / 5.1, Claude Mythos 5.1,
 * Claude Opus 5.5 and Claude Sonnet 5.5 reject a forced `tool_choice` at the
 * API level with a 400. Those models can still call tools under
 * `{ type: 'auto' }`; they only refuse to be forced.
 *
 * Two consumers read this:
 *   - {@link AnthropicProvider} clamps any resolved forced `tool_choice` to
 *     `auto` for those models (the same defensive clamp it already applies when
 *     extended thinking is active), so no caller has to remember the quirk.
 *   - {@link generateObject} skips the forced-tool structured-output payload
 *     for those models and falls through to the prompt-only JSON path instead (the
 *     schema already rides in the system prompt; the result text is
 *     extractJson + safeParse'd in the retry loop), so structured output
 *     degrades gracefully on those models and the request still succeeds.
 *
 * Sibling of `modelSupportsThinking` / `modelSupportsTemperature`. Kept in its
 * own pure module so the unit test imports no provider/SDK code.
 */

/**
 * Whether Anthropic will accept a forced `tool_choice` (`{ type: 'tool' }` or
 * `{ type: 'any' }`) for the given Claude model id.
 *
 * Deny-by-explicit-model. These models reject forced tool use, and every
 * other current Claude model (Sonnet 5 and earlier, Opus 5 and earlier,
 * Haiku) accepts it:
 *
 *   - Claude Fable 5 and 5.1, including dated variants such as
 *     `claude-fable-5-20260601`. The `fable-5` alternative also matches
 *     `claude-fable-5-1` because `\b` matches at the hyphen, which is intended
 *     since 5.1 is the same family under the same constraint.
 *   - Claude Mythos 5.1 (`claude-mythos-5-1`), per Anthropic's model docs.
 *   - Claude Opus 5.5 (`claude-opus-5-5`). Claude Opus 5 accepts forced tool
 *     use, so the pattern names the full `opus-5-5` id. A bare `opus-5` prefix
 *     would deny Opus 5 as well.
 *   - Claude Sonnet 5.5 (`claude-sonnet-5-5`). Claude Sonnet 5 accepts forced
 *     tool use, so the pattern names the full `sonnet-5-5` id for the same
 *     reason.
 *
 * Live-probed 2026-09-29 on the Messages API. `{type:'tool'}` and
 * `{type:'any'}` both return HTTP 400 on `claude-opus-5-5` and
 * `claude-fable-5-1`, with the message `tool_choice: type "tool" and "any" are
 * not supported for this model.` The same two requests return 200 on
 * `claude-opus-5`. Both return HTTP 400 on `claude-sonnet-5-5` (probed
 * 2026-09-30).
 *
 * `AnthropicProvider` clamps an unsupported forced choice to `{ type: 'auto' }`
 * and logs a warning. An extra entry here therefore costs guaranteed tool
 * invocation, while a missing entry fails the whole request with a 400. The
 * OpenAI effort allow-lists in `model-effort.ts` carry the reverse risk, since
 * admitting an unprobed id is what produces the 400 there.
 *
 * @param modelId Anthropic-side model id (e.g. `"claude-fable-5-1"` or
 *   `"claude-opus-5-5"`).
 * @returns `false` when Anthropic rejects a forced `tool_choice` for this
 *   model, `true` otherwise.
 */
export function modelSupportsForcedToolChoice(modelId: string): boolean {
  return !/^claude-(fable-5|mythos-5-1|opus-5-5|sonnet-5-5)\b/i.test(modelId);
}
