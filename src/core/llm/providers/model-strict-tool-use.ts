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
 * The structured-outputs validator requires `additionalProperties` to be
 * PRESENT and exactly `false` on every `object` node (`tools.N.custom: For
 * 'object' type, 'additionalProperties' must be explicitly set to false` —
 * live-API verified 2026-07-07: the key ABSENT is rejected too, nested
 * nodes included). An absent key is REWRITABLE — the provider stamps it via
 * {@link toolInputSchemaWithExplicitNoExtraProps} before sending — but a
 * schema-valued one, which is how `z.record(...)` lowers (dynamic keys are
 * the point, so it can never be `false`), can never satisfy strict mode and
 * 400s deterministically on every attempt. So this check answers "can the
 * schema BE MADE strict", not "is it strict-ready as-lowered".
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


/**
 * Rewrite a strict-compatible `input_schema` so every reachable object node
 * carries `additionalProperties: false` EXPLICITLY.
 *
 * The structured-outputs validator does not merely reject schema-valued
 * `additionalProperties` — it requires the key PRESENT and `false` on every
 * `object` node ("For 'object' type, 'additionalProperties' must be
 * explicitly set to false"; live-API verified 2026-07-07: a root OR nested
 * object node with the key absent 400s, while an optional property left out
 * of `required` is accepted). Zod object schemas lower WITHOUT the key, so
 * the capability + shape gates alone still 400'd every zod-lowered
 * structured-output call — the strict stamp needs this rewrite, not just
 * the {@link toolInputSchemaSupportsStrict} shape check.
 *
 * The same walk STRIPS constraint keywords the strict validator rejects
 * (see {@link STRICT_UNSUPPORTED_KEYWORDS}) — stamping alone still 400'd
 * every schema whose Zod lowering carried e.g. an array `.max(...)`.
 *
 * Pure + non-mutating: returns a structural copy; the input schema object
 * is never written to. Positions walked mirror the shape check
 * (`properties` / `patternProperties` / `$defs` / `definitions` values,
 * `items` — single or tuple form — and `anyOf` / `oneOf` / `allOf`
 * members). Only nodes that read as object schemas (`type: 'object'`, an
 * `'object'` member of a type array, or a `properties` map) get the stamp.
 * `required` is deliberately untouched: Anthropic strict accepts optional
 * properties — unlike OpenAI's json_schema mode, force-requiring them here
 * would corrupt `.optional()` semantics.
 *
 * Callers gate on {@link toolInputSchemaSupportsStrict} FIRST: a node with
 * a present, non-`false` `additionalProperties` (a lowered `z.record`) can
 * never satisfy strict mode, so the whole schema degrades to the
 * non-strict forced tool instead of being rewritten.
 *
 * @param inputSchema Lowered JSON Schema destined for `tool.input_schema`.
 * @returns A copy with `additionalProperties: false` stamped on every
 *   reachable object node that lacks it.
 */
export function toolInputSchemaWithExplicitNoExtraProps(inputSchema: unknown): unknown {
  return stampNoExtraProps(inputSchema, 0);
}

/**
 * Constraint keywords the structured-outputs strict validator REJECTS with
 * `tools.N.custom: For '<type>' type, property '<kw>' is not supported` —
 * mapped empirically against the live API (2026-07-07, one probe per
 * keyword): arrays reject `maxItems` + `uniqueItems` (while `minItems` is
 * ACCEPTED); numbers reject `minimum` / `maximum` / `exclusiveMinimum` /
 * `multipleOf` (exclusiveMaximum stripped by symmetry); objects reject
 * `minProperties` / `maxProperties`. Accepted and therefore KEPT: `enum`,
 * `const`, `pattern`, `minLength` / `maxLength`, `minItems`, `format`,
 * `default`, `description`. Zod lowerings emit the rejected keywords from
 * everyday builders (`.max(25)` on an array → `maxItems`), so without the
 * strip a strict-stamped schema 400s at request time and the call degrades
 * through retry/fallback to prose — the "Failed to extract valid JSON"
 * lottery structured output exists to prevent. Stripping is lossless for
 * callers: generateObject re-validates the parsed object against the
 * original Zod schema, so the constraints are still enforced caller-side;
 * only API-side enforcement of those bounds is forgone (structure remains
 * guaranteed).
 */
const STRICT_UNSUPPORTED_KEYWORDS = [
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
] as const;

function stampNoExtraProps(node: unknown, depth: number): unknown {
  if (depth > MAX_STRICT_SCAN_DEPTH) return node;
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sub => stampNoExtraProps(sub, depth + 1));
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  for (const kw of STRICT_UNSUPPORTED_KEYWORDS) {
    if (kw in out) delete out[kw];
  }
  const typeIsObject =
    out.type === 'object' ||
    (Array.isArray(out.type) && (out.type as unknown[]).includes('object')) ||
    (out.properties != null && typeof out.properties === 'object');
  if (typeIsObject && !('additionalProperties' in out)) {
    out.additionalProperties = false;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions'] as const) {
    const map = out[key];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const next: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(map as Record<string, unknown>)) {
        next[k] = stampNoExtraProps(sub, depth + 1);
      }
      out[key] = next;
    }
  }
  if (out.items !== undefined) out.items = stampNoExtraProps(out.items, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const members = out[key];
    if (Array.isArray(members)) out[key] = members.map(sub => stampNoExtraProps(sub, depth + 1));
  }
  return out;
}
