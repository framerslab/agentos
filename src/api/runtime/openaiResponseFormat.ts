/**
 * @file openaiResponseFormat.ts
 * @description Helpers for building OpenAI's `response_format: json_schema`
 * payload from a lowered JSON Schema.
 *
 * OpenAI's strict structured-outputs mode (added with `gpt-4o-2024-08-06`)
 * guarantees the model produces JSON that conforms to a provided schema. It
 * has stricter requirements than the looser `json_object` mode:
 *
 *  - Every object must declare `additionalProperties: false`.
 *  - Every property of every object must appear in the `required` array, so
 *    a property the source schema leaves optional is made nullable instead:
 *    the model writes `null` for it, and the reply readers drop that `null`
 *    before validating (`dropNullsForOptionalFields` in `structuredReply.ts`).
 *  - Unsupported keywords (`format`, `pattern`, `minLength`, etc.) are stripped.
 *
 * This module wraps a lowered JSON Schema (from {@link lowerZodToJsonSchema})
 * into a strict-compatible payload. When the lowered schema is empty (the
 * Zod v3 case where the lowering helper returns `{}` because it only knows
 * v4 internals), the caller should fall back to `json_object` mode.
 *
 * @see https://platform.openai.com/docs/guides/structured-outputs
 */

/**
 * Returns true when the schema is concrete enough to be wrapped in OpenAI's
 * strict json_schema mode. A schema with no `type` and no `properties` is
 * treated as "unknown / untyped" and won't satisfy strict mode.
 *
 * The check is RECURSIVE: strict mode rejects the whole request when ANY
 * reachable node is untyped (`{}` from an unsupported Zod type) or is a
 * record-shaped object (strict demands `additionalProperties: false` on
 * every object, so a schema-valued `additionalProperties` can never
 * comply). Previously only the root was checked, so a nested `{}` slipped
 * through and the API returned a 400 instead of the caller degrading to
 * `json_object` mode.
 */
export function canUseStrictJsonSchema(jsonSchema: Record<string, unknown> | undefined): boolean {
  if (!jsonSchema) return false;
  if (Object.keys(jsonSchema).length === 0) return false;
  // Strict mode demands an object root with declared properties.
  if (jsonSchema.type !== 'object' || typeof jsonSchema.properties !== 'object') return false;
  return isStrictCompatibleNode(jsonSchema);
}

/**
 * Recursive strict-compatibility scan. A node qualifies when it is a
 * union whose every member qualifies, an enum / const, a type array
 * (nullable lowering, e.g. `['string','null']`), or a typed node whose
 * children (object properties / array items) all qualify. An empty `{}`
 * node — the lowering fallback for unsupported Zod types — disqualifies
 * the whole schema, as does a record-shaped object (see above).
 */
function isStrictCompatibleNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.anyOf)) {
    return obj.anyOf.length > 0 && obj.anyOf.every((v) => isStrictCompatibleNode(v));
  }
  if (Array.isArray(obj.oneOf)) {
    return obj.oneOf.length > 0 && obj.oneOf.every((v) => isStrictCompatibleNode(v));
  }
  if (Array.isArray(obj.enum)) return obj.enum.length > 0;
  if ('const' in obj) return true;
  if (Array.isArray(obj.type)) {
    return obj.type.length > 0 && obj.type.every((t) => typeof t === 'string');
  }
  if (typeof obj.type !== 'string') return false; // `{}` / unknown-shaped node

  if (obj.type === 'object') {
    if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
      // Record shape — strict mode requires additionalProperties: false.
      return false;
    }
    const props = obj.properties;
    if (!props || typeof props !== 'object') return false;
    return Object.values(props as Record<string, unknown>).every((v) => isStrictCompatibleNode(v));
  }
  if (obj.type === 'array') {
    if (!obj.items || typeof obj.items !== 'object') return false;
    return isStrictCompatibleNode(obj.items);
  }
  return true; // primitives: string / number / boolean / integer / null
}

/**
 * Recursively prepares a JSON Schema for OpenAI strict mode:
 *  - On every object node, sets `additionalProperties: false` and lifts every
 *    declared property name into `required`.
 *  - Makes every property the node's own `required` leaves out (every
 *    property, when the node has no `required`) accept `null`: strict mode
 *    has no optional property, so a model under constrained decoding must
 *    write each one. Without `null` it wrote a placeholder that fails the
 *    caller's own checks (`""` under a `.min(1)`, `0` under a `.min(5)`), or
 *    an invented value that passes them. A property that already accepts
 *    `null` is left as it is.
 *  - Walks into `properties` and `items` so nested arrays-of-objects are
 *    handled correctly (the most common reason callers hit this code path).
 *  - Returns a fresh object; does not mutate the input.
 */
export function makeStrictJsonSchema(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, unknown>;
    const declaredRequired = new Set(
      Array.isArray(obj.required) ? (obj.required as unknown[]).filter((k): k is string => typeof k === 'string') : [],
    );
    const newProps: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(props)) {
      const strict = makeStrictJsonSchema(props[key]);
      newProps[key] = declaredRequired.has(key) ? strict : withNull(strict);
      required.push(key);
    }
    out.properties = newProps;
    out.required = required;
    out.additionalProperties = false;
  }

  if (out.type === 'array' && out.items) {
    out.items = makeStrictJsonSchema(out.items);
  }

  // Union members must also comply — a discriminated union lowers to
  // `anyOf` whose object variants each need `additionalProperties: false`
  // + full `required`, or the API rejects the schema with a 400. This was
  // the missing recursion that made every discriminatedUnion-rooted (or
  // union-containing) schema fail strict mode.
  if (Array.isArray(out.anyOf)) {
    out.anyOf = (out.anyOf as unknown[]).map((v) => makeStrictJsonSchema(v));
  }
  if (Array.isArray(out.oneOf)) {
    out.oneOf = (out.oneOf as unknown[]).map((v) => makeStrictJsonSchema(v));
  }

  return out;
}

/** True when a JSON Schema node already accepts `null`. */
function acceptsNull(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (obj.type === 'null') return true;
  if (Array.isArray(obj.type) && obj.type.includes('null')) return true;
  if (Array.isArray(obj.enum) && obj.enum.includes(null)) return true;
  if ('const' in obj && obj.const === null) return true;
  if (Array.isArray(obj.anyOf) && obj.anyOf.some((v) => acceptsNull(v))) return true;
  if (Array.isArray(obj.oneOf) && obj.oneOf.some((v) => acceptsNull(v))) return true;
  return false;
}

/**
 * The node widened to accept `null`, as the lowering writes a `.nullable()`:
 * a bare primitive type becomes a type array (`['string', 'null']`); any other
 * node (an object, an array, an enum) becomes an `anyOf` with `{ type: 'null' }`,
 * and a union's own `anyOf` takes `{ type: 'null' }` as one more member. A node
 * that accepts `null` already is returned as it is.
 */
function withNull(node: unknown): unknown {
  if (!node || typeof node !== 'object' || acceptsNull(node)) return node;
  const obj = node as Record<string, unknown>;
  const primitive = obj.type === 'string' || obj.type === 'number' || obj.type === 'integer' || obj.type === 'boolean';
  if (primitive && !('enum' in obj) && !('const' in obj)) {
    return { ...obj, type: [obj.type, 'null'] };
  }
  if (Array.isArray(obj.type) && obj.type.every((t) => typeof t === 'string') && !('enum' in obj) && !('const' in obj)) {
    return { ...obj, type: [...obj.type, 'null'] };
  }
  if (Array.isArray(obj.anyOf) && Object.keys(obj).every((k) => k === 'anyOf' || k === 'description')) {
    return { ...obj, anyOf: [...obj.anyOf, { type: 'null' }] };
  }
  return { anyOf: [node, { type: 'null' }] };
}

/**
 * Build OpenAI's full `response_format` payload from a lowered JSON Schema.
 *
 * @param jsonSchema - The lowered JSON Schema (from `lowerZodToJsonSchema`).
 * @param schemaName - Name passed to OpenAI for trace/debug purposes.
 *                    Falls back to `"response"` when omitted.
 */
export function buildOpenAIJsonSchemaResponseFormat(
  jsonSchema: Record<string, unknown>,
  schemaName: string = 'response',
): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: sanitizeSchemaName(schemaName),
      schema: makeStrictJsonSchema(jsonSchema),
      strict: true,
    },
  };
}

/**
 * OpenAI requires `name` to match `^[a-zA-Z0-9_-]+$` and be ≤ 64 chars.
 * Replace anything outside that set with `_` and clip to length.
 */
function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  // If the cleaned name carries no real signal (empty, or all-underscores
  // because every input character was illegal), fall back to a stable
  // generic name rather than passing OpenAI a string of placeholders.
  const hasRealChars = /[a-zA-Z0-9-]/.test(cleaned);
  return hasRealChars ? cleaned : 'response';
}
