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

/**
 * Whether a lowered tool `input_schema` can carry `strict: true` without the
 * Anthropic API rejecting the whole request.
 *
 * The structured-outputs validator requires that any `object` node which
 * DECLARES `additionalProperties` declares it as exactly `false`
 * (`tools.N.custom: For 'object' type, 'additionalProperties' must be
 * explicitly set to false`). An ABSENT `additionalProperties` is accepted —
 * but a schema-valued one, which is how `z.record(...)` lowers (dynamic keys
 * are the point, so it can never be `false`), 400s deterministically on
 * every attempt.
 *
 * This is the schema-shape half of the strict gate; model capability
 * ({@link modelSupportsStrictToolUse}) is the other half, and
 * AnthropicProvider stamps `strict: true` only when BOTH hold. Without the
 * shape half, every record-bearing generateObject schema (component trees,
 * mechanics compositions, dungeon layouts) failed 100% at the provider the
 * day strict tools shipped — the schema can never satisfy strict mode, so
 * the only sound move is degrading that call to the non-strict forced tool
 * (best-effort adherence + caller-side Zod validation, the pre-strict
 * behavior). Mirrors how the OpenAI / OpenRouter strict paths gate on
 * `canUseStrictJsonSchema` before opting a schema into strict mode.
 *
 * The walk visits only positions that hold subschemas (`properties` /
 * `patternProperties` / `$defs` / `definitions` VALUES, `items`,
 * `anyOf` / `oneOf` / `allOf` members) — a FIELD literally named
 * `additionalProperties` inside `properties` must not trip the check.
 *
 * @param inputSchema Lowered JSON Schema destined for `tool.input_schema`.
 * @returns `true` when no reachable node carries a non-`false`
 *   `additionalProperties`; `false` otherwise (caller must omit `strict`).
 */
export function toolInputSchemaSupportsStrict(inputSchema: unknown): boolean {
  return nodeSupportsStrict(inputSchema, 0);
}

/** Defensive recursion bound — lowered schemas are shallow trees; anything
 *  deeper is malformed and must not stack-overflow the request path. */
const MAX_STRICT_SCAN_DEPTH = 64;

function nodeSupportsStrict(node: unknown, depth: number): boolean {
  if (depth > MAX_STRICT_SCAN_DEPTH) return false;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
  const schema = node as Record<string, unknown>;
  if ('additionalProperties' in schema && schema.additionalProperties !== false) {
    return false;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions'] as const) {
    const map = schema[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const sub of Object.values(map as Record<string, unknown>)) {
        if (!nodeSupportsStrict(sub, depth + 1)) return false;
      }
    }
  }
  const items = schema.items;
  if (Array.isArray(items)) {
    for (const sub of items) if (!nodeSupportsStrict(sub, depth + 1)) return false;
  } else if (items && typeof items === 'object') {
    if (!nodeSupportsStrict(items, depth + 1)) return false;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      for (const sub of members) if (!nodeSupportsStrict(sub, depth + 1)) return false;
    }
  }
  return true;
}
