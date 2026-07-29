/**
 * @file structuredOutputFormat.ts
 * @description Provider-specific structured-output payload adapter.
 *
 * Converts a Zod schema + provider id into the per-provider payload shape that
 * agentos plumbs through `GenerateTextOptions._responseFormat` to the
 * underlying `provider.generateCompletion` call. Each provider routes that
 * payload to its native structured-output API surface:
 *
 *   - openai     → response_format: { type: 'json_schema', json_schema: {...} }
 *   - anthropic  → forced tool_use (single tool with input_schema, tool_choice forced)
 *   - gemini     → generationConfig.responseMimeType + responseSchema
 *   - openrouter → degrades to json_object (OpenRouter has no schema enforcement)
 *   - requesty   → degrades to json_object (aggregator; no cross-upstream schema enforcement)
 *
 * @module agentos/core/llm/providers/structuredOutputFormat
 */
import type { ZodType } from 'zod';
import { lowerZodToJsonSchema } from '../../../orchestration/compiler/SchemaLowering.js';

/**
 * Input to {@link buildResponseFormat}.
 */
export interface BuildResponseFormatInput {
  /** Provider id (e.g., 'openai', 'anthropic', 'gemini'). */
  provider: string;
  /** Zod schema describing the desired response shape. */
  schema: ZodType;
  /**
   * Display name for the schema in provider payloads. Surfaces in OpenAI's
   * json_schema.name and Anthropic's tool name. Sanitized to
   * /[a-zA-Z0-9_]/, truncated to 64 chars, falls back to 'response' when
   * empty after sanitization.
   */
  schemaName: string;
}

const SCHEMA_NAME_INVALID_CHARS = /[^a-zA-Z0-9_]/g;
const SCHEMA_NAME_MAX_LEN = 64;

function sanitizeName(name: string): string {
  // Two-pass: replace invalid chars with underscore (preserves boundaries
  // for inputs like "Foo.Bar" → "Foo_Bar"), then collapse the all-invalid
  // case ("!!!" → "___" → "response") via a separate strip-only check.
  // Keeps user-recognizable names while still falling back when nothing
  // useful survives.
  const stripped = name.replace(SCHEMA_NAME_INVALID_CHARS, '');
  if (!stripped) return 'response';
  return name.replace(SCHEMA_NAME_INVALID_CHARS, '_').slice(0, SCHEMA_NAME_MAX_LEN);
}

/**
 * Adapt a lowered JSON Schema into a shape Anthropic's tool `input_schema`
 * accepts. The Anthropic Messages API requires the tool input_schema to be a
 * JSON Schema **object** with a top-level `type`, and REJECTS a top-level
 * `oneOf` / `allOf` / `anyOf` (`input_schema does not support … at the top
 * level`). {@link lowerZodToJsonSchema} emits `{ anyOf: [...] }` for a top-level
 * `z.union` / `z.discriminatedUnion` and `{}` for shapes it does not model.
 * Two adaptations:
 *
 *  1. **Union of objects → one merged object.** Union the members' `properties`
 *     (merging same-named `enum` members so a discriminant like `kind` becomes
 *     the full set of variant values), and keep in `required` only the fields
 *     required by EVERY member, so variant-specific fields stay optional. The
 *     model returns one flat object; the caller's Zod schema re-validates the
 *     exact variant, so strictness is preserved. Nested `anyOf` (inside a
 *     property / `additionalProperties`) is left intact — Anthropic only forbids
 *     it at the TOP level.
 *  2. **No top-level `type` (e.g. `{}` or a non-object union) → `{ type: 'object' }`**
 *     (mirrors the `?? { type: 'object' }` fallback AnthropicProvider's regular
 *     tool-conversion path applies). An object schema already carrying a `type`
 *     passes through unchanged.
 */
function ensureAnthropicObjectSchema(jsonSchema: unknown): Record<string, unknown> {
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return { type: 'object' };
  }
  const schema = jsonSchema as Record<string, unknown>;

  const variants = (
    Array.isArray(schema.anyOf)
      ? schema.anyOf
      : Array.isArray(schema.oneOf)
        ? schema.oneOf
        : null
  ) as Array<Record<string, unknown>> | null;

  if (
    variants &&
    variants.length > 0 &&
    variants.every((v) => v && typeof v === 'object' && v.type === 'object')
  ) {
    const mergedProperties: Record<string, unknown> = {};
    const requiredCounts: Record<string, number> = {};
    for (const variant of variants) {
      const props =
        variant.properties && typeof variant.properties === 'object'
          ? (variant.properties as Record<string, unknown>)
          : {};
      for (const [key, propSchema] of Object.entries(props)) {
        const existing = mergedProperties[key] as
          | Record<string, unknown>
          | undefined;
        const incoming = propSchema as Record<string, unknown>;
        if (
          existing &&
          Array.isArray(existing.enum) &&
          incoming &&
          Array.isArray(incoming.enum)
        ) {
          // Same field is an enum across variants (e.g. the discriminant) —
          // union the allowed values so the model can satisfy any variant.
          mergedProperties[key] = {
            enum: Array.from(new Set([...existing.enum, ...incoming.enum])),
          };
        } else if (!(key in mergedProperties)) {
          mergedProperties[key] = propSchema;
        }
      }
      const variantRequired = Array.isArray(variant.required)
        ? (variant.required as string[])
        : [];
      for (const field of variantRequired) {
        requiredCounts[field] = (requiredCounts[field] ?? 0) + 1;
      }
    }
    // A field is required in the merged object only when EVERY variant requires
    // it; variant-specific fields must stay optional.
    const required = Object.keys(requiredCounts).filter(
      (field) => requiredCounts[field] === variants.length,
    );
    return {
      type: 'object',
      properties: mergedProperties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if ('type' in schema) {
    return schema;
  }
  return { type: 'object', ...schema };
}

/**
 * Build a provider-specific structured-output payload from a Zod schema.
 *
 * @param input - Provider id, Zod schema, schema display name.
 * @returns Object suitable for `GenerateTextOptions._responseFormat`. The
 *          per-provider implementation routes the payload to its native
 *          structured-output API surface.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { buildResponseFormat } from '@framers/agentos/core/llm/providers/structuredOutputFormat';
 *
 * const schema = z.object({ verdict: z.enum(['yes', 'no']), confidence: z.number() });
 * const rf = buildResponseFormat({ provider: 'openai', schema, schemaName: 'Verdict' });
 * // → { type: 'json_schema', json_schema: { name: 'Verdict', strict: true, schema: { ... } } }
 * ```
 */
export function buildResponseFormat(
  input: BuildResponseFormatInput,
): Record<string, unknown> {
  const jsonSchema = lowerZodToJsonSchema(input.schema);
  const schemaName = sanitizeName(input.schemaName);

  switch (input.provider) {
    case 'openai':
      return {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      };
    case 'anthropic':
      return {
        _agentosUseToolForStructuredOutput: true,
        tool: {
          name: schemaName,
          input_schema: ensureAnthropicObjectSchema(jsonSchema),
        },
      };
    case 'gemini':
    case 'gemini-cli':
      return {
        type: 'json_object',
        _gemini: { responseSchema: jsonSchema },
      };
    case 'openrouter':
    case 'requesty':
    default:
      // OpenRouter, Requesty, and unknown providers: best-effort json_object. The
      // model is asked to return JSON but the schema is not enforced
      // by the provider. Caller-side Zod validation still runs and
      // throws on invalid output rather than retrying.
      return { type: 'json_object' };
  }
}
