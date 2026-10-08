/**
 * @file geminiResponseSchema.ts
 * @description Sanitize a lowered JSON Schema into the subset Gemini's
 * `generationConfig.responseSchema` actually accepts.
 *
 * Gemini's structured-output schema is an OpenAPI-3.0-style proto, NOT full
 * JSON Schema: any unknown field is rejected at the HTTP layer with
 * `Invalid JSON payload received. Unknown name "<field>"` — the whole call
 * 400s. The proven production offender is `additionalProperties`
 * (2026-07-16: a world-creation objectives pass died on it), which enters
 * lowered schemas two ways:
 *
 *   1. `z.record(...)` lowers to `{ type: 'object', additionalProperties }` —
 *      the standard JSON Schema map encoding.
 *   2. OpenAI strict-mode shapes carry `additionalProperties: false` on
 *      every object node.
 *
 * Rather than deny-listing known offenders (and 400ing on the next unknown
 * key), this keeps ONLY the fields of Gemini's published Schema object and
 * applies enforcement-preserving transforms for common JSON Schema idioms:
 *
 *   - `const: X`            → `enum: [X]`
 *   - `oneOf: [...]`        → `anyOf: [...]`
 *   - `allOf: [one member]` → inlined member
 *   - `type: ['T', 'null']` → `{ type: 'T', nullable: true }` (the nullable
 *     lowering emits the two-member array form)
 *   - map-style `additionalProperties` → dropped; the node stays a plain
 *     object and the caller-side Zod validation still enforces the value
 *     shape after decode.
 *
 * Pure and total: never throws, never mutates its input, and any node it
 * cannot express degrades to a LESS constrained schema (Gemini decodes
 * more freely; the caller's Zod parse remains the source of truth).
 *
 * @module agentos/core/llm/providers/implementations/geminiResponseSchema
 */

/**
 * Fields of Gemini's Schema proto (generationConfig.responseSchema).
 * Anything outside this set is rejected by the API with an
 * `Unknown name` 400, so the sanitizer keeps strictly to it.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'properties',
  'required',
  'propertyOrdering',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively sanitize one schema node. Non-object nodes pass through
 * untouched (defensive: lowered schemas are objects, but a malformed input
 * must never throw at the provider boundary).
 */
function sanitizeNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};

  // ── Transforms for idioms Gemini spells differently ──
  // const → single-member enum (keeps the constraint instead of dropping it).
  if ('const' in node && !('enum' in node)) {
    out.enum = [node.const];
  }
  // oneOf → anyOf (Gemini only accepts anyOf).
  const unionMembers = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : undefined;
  if (unionMembers) {
    out.anyOf = unionMembers.map((m) => sanitizeNode(m));
  }
  // allOf with exactly one member → inline it (common wrapper emission).
  // Multi-member allOf has no Gemini spelling — degrade by dropping (the
  // node keeps whatever direct fields it carries; Zod still validates).
  if (Array.isArray(node.allOf) && node.allOf.length === 1) {
    const inlined = sanitizeNode(node.allOf[0]);
    if (isPlainObject(inlined)) Object.assign(out, inlined);
  }

  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_SCHEMA_FIELDS.has(key)) continue; // additionalProperties, $schema, $defs, patternProperties, …
    if (key === 'anyOf') continue; // handled above (merged with oneOf)

    if (key === 'type' && Array.isArray(value)) {
      // Nullable lowering emits `type: ['T', 'null']`; Gemini wants a single
      // type + nullable flag. A multi-type array beyond that becomes an anyOf
      // of single-type nodes.
      const nonNull = value.filter((t) => t !== 'null');
      const nullable = value.length !== nonNull.length;
      if (nonNull.length === 1) {
        out.type = nonNull[0];
        if (nullable) out.nullable = true;
      } else if (nonNull.length > 1 && !out.anyOf) {
        out.anyOf = nonNull.map((t) => ({ type: t }));
        if (nullable) out.nullable = true;
      }
      continue;
    }

    if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        props[name] = sanitizeNode(sub);
      }
      out.properties = props;
      continue;
    }

    if (key === 'items') {
      // Tuple-style `items: [...]` has no Gemini spelling — express the
      // member union as anyOf so element constraints survive.
      out.items = Array.isArray(value)
        ? { anyOf: value.map((m) => sanitizeNode(m)) }
        : sanitizeNode(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

/**
 * Sanitize a lowered JSON Schema for `generationConfig.responseSchema`.
 * Always returns a fresh object; the input is never mutated.
 */
export function sanitizeGeminiResponseSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const out = sanitizeNode(schema);
  return isPlainObject(out) ? out : {};
}
