/**
 * @file SchemaLowering.ts
 * @description Minimal Zod-to-JSON-Schema converter for the AgentOS orchestration layer.
 *
 * Intentionally hand-rolled to avoid adding `zod-to-json-schema` as a dependency.
 * Handles the subset of Zod types used in node input/output schemas across the codebase:
 * z.string, z.number, z.boolean, z.null, z.object, z.array, z.enum, z.optional, z.default.
 *
 * Targets Zod v4 `_def` internals:
 * - Discriminant field: `_def.type` (string literal, e.g. `"string"`, `"object"`)
 * - Array inner schema: `_def.element`
 * - Object shape: `_def.shape` (plain Record, NOT a function as in Zod v3)
 * - Enum values: `_def.entries` (Record<string, string> — keys and values are the same)
 * - Optional/Default inner schema: `_def.innerType`
 *
 * Unsupported types fall through to an empty object `{}` — callers should treat that as
 * an "unknown / untyped" schema rather than an error.
 */

import type { ZodType } from 'zod';

/**
 * Converts a Zod schema instance to a plain JSON Schema object.
 *
 * Recursively descends into ZodObject shapes, ZodArray item types, ZodOptional and
 * ZodDefault wrappers, transparently unwrapping them so the produced JSON Schema
 * is clean and does not contain Zod-specific metadata.
 *
 * @param schema - Any Zod schema instance.
 * @returns A JSON Schema-compatible plain object.
 *
 * @example
 * ```ts
 * const jsonSchema = lowerZodToJsonSchema(z.object({ name: z.string(), age: z.number().optional() }));
 * // → { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name'] }
 * ```
 */
export function lowerZodToJsonSchema(schema: ZodType): Record<string, unknown> {
  // Access Zod v4 internals via `_def`; the top-level `_def.type` is the discriminant.
  const def = (schema as any)._def as Record<string, unknown> | undefined;
  if (!def) return {};

  // In Zod v4 the discriminant is `_def.type` (a plain string literal).
  const typeName = def.type as string | undefined;

  switch (typeName) {
    case 'string':
      return { type: 'string' };

    case 'number':
      return { type: 'number' };

    case 'boolean':
      return { type: 'boolean' };

    case 'null':
      return { type: 'null' };

    case 'enum': {
      // Zod v4: def.entries is Record<string, string> — extract the values array.
      const entries = def.entries as Record<string, string>;
      return { enum: Object.values(entries) };
    }

    case 'array': {
      // Zod v4: def.element holds the inner schema instance.
      return {
        type: 'array',
        items: lowerZodToJsonSchema(def.element as ZodType),
      };
    }

    case 'object': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Zod v4: def.shape is a plain Record<string, ZodType> (not a function as in Zod v3).
      const shape = def.shape as Record<string, ZodType>;

      for (const [key, fieldSchema] of Object.entries(shape)) {
        properties[key] = lowerZodToJsonSchema(fieldSchema);

        // A field is required unless its outermost wrapper is optional or has a default.
        const fieldType = ((fieldSchema as any)._def as Record<string, unknown> | undefined)?.type as string | undefined;
        if (fieldType !== 'optional' && fieldType !== 'default') {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    case 'optional':
      // Unwrap; optionality is expressed via absence from `required`, not in the field schema.
      return lowerZodToJsonSchema(def.innerType as ZodType);

    case 'default':
      // Unwrap; defaults are runtime concerns, not JSON Schema concerns for our use case.
      return lowerZodToJsonSchema(def.innerType as ZodType);

    case 'union': {
      // z.union AND z.discriminatedUnion both surface as `union` in Zod v4 (the
      // discriminated variant only adds `_def.discriminator`). Lower each option
      // and expose them via `anyOf`. The result intentionally has no top-level
      // `type`: the Anthropic structured-output adapter injects `{ type: 'object' }`
      // (its tool input_schema requires a type), and OpenAI strict mode declines a
      // typeless root (`canUseStrictJsonSchema`) and degrades to json_object — so a
      // typeless `anyOf` is safe across providers while still giving the model the
      // real variant shapes (previously a union lowered to `{}`, leaving the model
      // unguided and structured output validation failing).
      const options = (def.options as ZodType[] | undefined) ?? [];
      return { anyOf: options.map((opt) => lowerZodToJsonSchema(opt)) };
    }

    case 'literal': {
      // Zod v4: def.values is an array of allowed literal constants (a literal may
      // carry more than one). Model it as a single-value enum so discriminants in a
      // discriminated union read correctly.
      const values = (def.values as unknown[] | undefined) ?? [];
      return { enum: values };
    }

    case 'record': {
      // Open-ended string-keyed map → JSON Schema object whose value shape is
      // described by additionalProperties.
      return {
        type: 'object',
        additionalProperties: lowerZodToJsonSchema(def.valueType as ZodType),
      };
    }

    default:
      // Unknown / unsupported Zod type — return empty schema (treat as untyped).
      return {};
  }
}
