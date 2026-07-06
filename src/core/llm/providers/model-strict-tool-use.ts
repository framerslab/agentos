/**
 * @fileoverview Strict-tool-use capability helper for the Anthropic Claude
 * models.
 *
 * Anthropic's structured-outputs surface (beta `structured-outputs-2025-11-13`)
 * adds `strict: true` on a tool definition: the API then validates the model's
 * tool input against `input_schema` server-side and guarantees conformance,
 * instead of the best-effort schema adherence unmarked tools get. That is
 * exactly what the forced-tool structured-output path wants — without it, a
 * long or adversarial generation can emit tool input that drifts from the
 * schema and the caller's Zod parse fails with nothing to retry on.
 *
 * The flag is NOT universally supported: models older than the 4.5
 * generation reject unknown tool fields ("tools.0.strict: Extra inputs are
 * not permitted"), so sending it blind would 400 every structured-output
 * call on those models. This helper is the single gate deciding when the
 * flag (and its beta header — see AnthropicProvider.betaHeaders) may ride.
 *
 * Two consumers read this:
 *   - {@link AnthropicProvider} adds `strict: true` to the forced
 *     structured-output tool when the resolved model supports it, and emits
 *     the matching `anthropic-beta` header for any payload whose tools carry
 *     the flag.
 *   - Tests pin the allowlist so a new model family gets an explicit,
 *     reviewed decision instead of silently inheriting behavior.
 *
 * Sibling of `modelSupportsForcedToolChoice` / `modelSupportsThinking`. Kept
 * in its own pure module so the unit test imports no provider/SDK code.
 */

/**
 * Whether the Anthropic API accepts `strict: true` on a tool definition for
 * the given Claude model id.
 *
 * Allow-by-explicit-family: the structured-outputs surface launched with the
 * 4.5 generation (Sonnet 4.5, Opus 4.5, Haiku 4.5) and carries forward to
 * every later family (Opus 4.6-4.8, Sonnet 5, Haiku 5, Fable 5). Older
 * models (Sonnet 4.x dated snapshots, Opus 4.0/4.1, the 3.x line) reject
 * the field. New families get added here as Anthropic releases them.
 *
 * @param modelId Anthropic-side model id (e.g. `"claude-sonnet-5"` or
 *   `"claude-opus-4-8"`, dated variants included).
 * @returns `true` when the model accepts `strict: true` tool definitions.
 */
export function modelSupportsStrictToolUse(modelId: string): boolean {
  return /^claude-(sonnet-(4-5|5)|opus-(4-[5-9]|5)|haiku-(4-5|5)|fable-5)\b/i.test(
    modelId,
  );
}
