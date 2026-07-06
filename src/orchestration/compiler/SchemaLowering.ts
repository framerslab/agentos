/**
 * @file SchemaLowering.ts
 * @description Minimal Zod-to-JSON-Schema converter for the AgentOS orchestration layer.
 *
 * Intentionally hand-rolled to avoid adding `zod-to-json-schema` as a dependency.
 * Handles the subset of Zod types used in node input/output schemas across the codebase:
 * z.string, z.number, z.boolean, z.null, z.object, z.array, z.enum, z.optional, z.default,
 * z.nullable, z.union/z.discriminatedUnion, z.literal, z.record, z.tuple.
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

    case 'nullable': {
      // z.foo().nullable() — lower the inner schema and widen it with null.
      // A bare-primitive inner collapses into a JSON Schema type array
      // (`{ type: ['string', 'null'] }`), which OpenAI strict mode accepts
      // natively; composite inners (objects, arrays, enums, unions) ride an
      // `anyOf` pair instead. Previously nullable fell through to `{}`
      // (untyped), and OpenAI strict mode rejects any node without a `type`
      // key — one `.nullable()` field anywhere in a schema 400'd the whole
      // structured-output call. Note nullable is NOT optional: the field
      // stays in the parent object's `required` array and the model must
      // emit it (possibly as null) — exactly the OpenAI-recommended shape
      // for strict-mode "optional-ish" fields.
      const inner = lowerZodToJsonSchema(def.innerType as ZodType);
      const innerKeys = Object.keys(inner);
      if (innerKeys.length === 0) {
        // Inner type itself is unsupported — stay untyped rather than
        // inventing a shape; the strict-mode gate degrades the call.
        return {};
      }
      if (innerKeys.length === 1 && typeof inner.type === 'string') {
        return { type: [inner.type, 'null'] };
      }
      return { anyOf: [inner, { type: 'null' }] };
    }

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

    case 'tuple': {
      // Zod v4: def.items is the array of member schemas; def.rest is the
      // optional rest-element schema. Lowered as a fixed-length array rather
      // than draft-2020 `prefixItems` because OpenAI strict structured
      // outputs rejects any node without a `type` key AND does not support
      // `prefixItems` — a tuple previously fell through to `{}` here, which
      // made the WHOLE schema unusable in strict mode ("schema must have a
      // 'type' key" on the tuple path). Positional member types collapse
      // into `items` (deduped anyOf when heterogeneous); exact arity rides
      // minItems/maxItems (no maxItems when a rest element exists). This is
      // deliberately looser than true tuple validation — the caller's Zod
      // schema still validates the parsed output, so correctness holds; the
      // JSON schema only needs to guide the model.
      const members = ((def.items as ZodType[] | undefined) ?? []).map((m) =>
        lowerZodToJsonSchema(m),
      );
      const rest = def.rest ? lowerZodToJsonSchema(def.rest as ZodType) : undefined;
      const candidates = [...members, ...(rest ? [rest] : [])];
      const unique = candidates.filter(
        (c, i) => candidates.findIndex((o) => JSON.stringify(o) === JSON.stringify(c)) === i,
      );
      const items =
        unique.length === 0 ? {} : unique.length === 1 ? unique[0] : { anyOf: unique };
      return {
        type: 'array',
        items,
        minItems: members.length,
        ...(rest ? {} : { maxItems: members.length }),
      };
    }

    default:
      // Unknown / unsupported Zod type — return empty schema (treat as untyped).
      return {};
  }
}
