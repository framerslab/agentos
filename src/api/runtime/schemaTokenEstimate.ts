/**
 * @file schemaTokenEstimate.ts
 * @description Estimate the output-token budget needed to produce a complete
 * JSON object matching a given Zod schema.
 *
 * Used by `generateObject()` to auto-size `maxTokens` when the caller doesn't
 * pass an explicit value. Without this, complex nested-array schemas (e.g.
 * `z.array(z.object({...}))`) reliably truncate at the provider default of
 * ~256–512 tokens and the resulting JSON fails to parse.
 *
 * Walks the Zod schema directly (not a lowered JSON Schema) so it works on
 * both Zod v3 (`_def.typeName`) and Zod v4 (`_def.type`) without a runtime
 * Zod dependency on a specific version.
 */

const TOKENS_PER_LEAF = 30;       // average tokens per primitive field
const TOKENS_PER_ARRAY_ITEM = 60; // assumed per-element budget for typical strings
const MIN_BUDGET = 512;
// 2026-05-30: raised 8192 -> 32000. The old 8192 ceiling truncated large-output
// schemas (e.g. a `source: z.string().max(80_000)` codegen field) even when the
// model supports far more, which forced every such caller to pass maxTokens by
// hand. Sonnet 4.x supports ~64K output and Opus 4.8 128K, so 32000 is a safe
// auto-estimate ceiling; callers needing more still pass maxTokens explicitly.
const MAX_BUDGET = 32000;
const HEADROOM = 1.5;             // 50% headroom for prose-heavy fields
const MAX_DEPTH = 8;              // recursion safety on cyclic-ish schemas

/**
 * Returns the estimated `maxTokens` budget for the given Zod schema.
 *
 * Result is clamped to [{@link MIN_BUDGET}, {@link MAX_BUDGET}]. Callers that
 * need a different budget should pass `opts.maxTokens` explicitly.
 *
 * @param schema - Any Zod schema instance (v3 or v4).
 * @returns A token budget suitable for the provider's `max_tokens`/`max_output_tokens` field.
 */
export function estimateMaxTokensForZodSchema(schema: unknown): number {
  const estimate = Math.ceil(walk(schema, 0) * HEADROOM);
  if (estimate < MIN_BUDGET) return MIN_BUDGET;
  if (estimate > MAX_BUDGET) return MAX_BUDGET;
  return estimate;
}

/**
 * Recursive token estimate for a single Zod node.
 *
 * - `ZodOptional` / `ZodNullable` / `ZodDefault` / `ZodReadonly` / `ZodEffects`
 *   are unwrapped (they contribute the inner schema's budget, not their own).
 * - `ZodObject` walks `_def.shape` (a function in v3, a record in v4).
 * - `ZodArray` reads the inner element from `_def.element` (v4) or `_def.type` (v3),
 *   and budgets for an assumed item count of 6 (objects) / 8 (primitives).
 * - `ZodEnum` / `ZodNativeEnum` / `ZodLiteral` are bounded by the longest value.
 * - `ZodUnion` / `ZodDiscriminatedUnion` budget for the worst-case branch.
 */
function walk(node: unknown, depth: number): number {
  if (!node || depth > MAX_DEPTH) return TOKENS_PER_LEAF;
  const def = (node as { _def?: Record<string, unknown> })._def;
  if (!def) return TOKENS_PER_LEAF;

  // Zod v3 uses `_def.typeName` ("ZodObject"). Zod v4 uses `_def.type` ("object").
  // Normalize to the v3 form so the switch below has one shape to match against.
  const typeNameV3 = def.typeName as string | undefined;
  const typeV4 = def.type as string | undefined;
  const kind: string = typeNameV3
    ?? (typeV4 ? `Zod${typeV4[0].toUpperCase()}${typeV4.slice(1)}` : '');

  switch (kind) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodReadonly':
    case 'ZodEffects':
      return walk(def.innerType ?? def.schema, depth + 1);

    case 'ZodObject': {
      // v3: shape is a function returning the shape object.
      // v4: shape is the shape object directly.
      const shapeRaw = def.shape;
      const shape: Record<string, unknown> = typeof shapeRaw === 'function'
        ? (shapeRaw as () => Record<string, unknown>)()
        : (shapeRaw as Record<string, unknown> | undefined) ?? {};
      let sum = 64; // braces, commas, base structure overhead
      for (const key of Object.keys(shape)) {
        sum += key.length + 8;            // field name + JSON syntax
        sum += walk(shape[key], depth + 1);
      }
      return sum;
    }

    case 'ZodArray': {
      // v3 stores element on def.type (a Zod schema), v4 on def.element.
      const inner = (def.element ?? def.type) as { _def?: Record<string, unknown> } | undefined;
      const itemBudget = walk(inner, depth + 1);
      const innerKind = inner?._def?.typeName ?? inner?._def?.type;
      const isObjectItem = innerKind === 'ZodObject' || innerKind === 'object';
      const assumedCount = isObjectItem ? 6 : 8;
      return 24 + assumedCount * Math.max(itemBudget, TOKENS_PER_ARRAY_ITEM);
    }

    case 'ZodEnum':
    case 'ZodNativeEnum': {
      const valuesSrc = (def.values as unknown) ?? Object.values((def.entries as Record<string, unknown> | undefined) ?? {});
      const arr = Array.isArray(valuesSrc) ? valuesSrc : Object.values(valuesSrc as Record<string, unknown>);
      return arr.length > 0
        ? Math.max(...arr.map((v) => String(v).length)) + 4
        : TOKENS_PER_LEAF;
    }

    case 'ZodLiteral':
      return String(def.value ?? '').length + 4;

    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const opts = (def.options as unknown[] | undefined) ?? [];
      return opts.length > 0
        ? Math.max(...opts.map((o) => walk(o, depth + 1)))
        : TOKENS_PER_LEAF;
    }

    case 'ZodString': {
      const maxChars = stringMaxChars(def);
      // A bounded string contributes ~maxChars/4 tokens (~4 chars/token); the
      // global HEADROOM multiplier covers denser code / JSON-escaped text.
      // Unbounded strings keep the small leaf default — the caller should add
      // .max() or pass an explicit maxTokens for large free-form output.
      return maxChars && maxChars > 0 ? Math.ceil(maxChars / 4) : TOKENS_PER_LEAF;
    }

    default:
      return TOKENS_PER_LEAF;
  }
}

/**
 * Extracts a string's `.max(N)` character constraint across Zod v3 + v4
 * internal shapes. Returns null when the string is unbounded.
 *
 * - Zod v3: `_def.checks` is `[{ kind: 'max', value: N }]`.
 * - Zod v4: the constraint nests under `_zod.def` (or `def`) with
 *   `check: 'max_length'` and a numeric `maximum`.
 */
function stringMaxChars(def: Record<string, unknown>): number | null {
  const checks = def.checks as unknown;
  if (!Array.isArray(checks)) return null;
  for (const c of checks) {
    const check = c as Record<string, unknown> | null;
    if (!check) continue;
    if (check.kind === 'max' && typeof check.value === 'number') {
      return check.value;
    }
    const inner = ((check._zod as Record<string, unknown> | undefined)?.def
      ?? (check.def as Record<string, unknown> | undefined)
      ?? check) as Record<string, unknown>;
    if (
      (inner.check === 'max_length' || inner.check === 'max')
      && typeof inner.maximum === 'number'
    ) {
      return inner.maximum;
    }
  }
  return null;
}
