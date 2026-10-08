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
 *
 * Size checks (`.min()` / `.max()` / `.length()` on strings and arrays, `.min()` /
 * `.max()` on numbers) are dropped by default, because provider structured-output
 * modes accept different keyword subsets and a rejected keyword fails the whole
 * request. They are emitted on request ({@link LowerZodOptions.sizeConstraints}) for
 * schema TEXT a model reads but no provider enforces: the prompt-only JSON path, where
 * the lowered schema is the only place the model can learn a limit.
 */

import type { ZodType } from 'zod';

/** Options for {@link lowerZodToJsonSchema}. */
export interface LowerZodOptions {
  /**
   * Emit the schema's size checks as JSON Schema keywords: `minLength` / `maxLength`
   * on strings, `minItems` / `maxItems` on arrays, `minimum` / `maximum` (and the
   * exclusive forms) on numbers. Default `false`: the default output is unchanged for
   * every caller that hands the schema to a provider's structured-output mode.
   */
  sizeConstraints?: boolean;
}

/** The bounds a schema author wrote on one node, read from that node's own checks. */
interface AuthoredBounds {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

/**
 * Reads the size and range checks attached to a Zod v4 node (`_zod.def.checks`):
 * `min_length` / `max_length` / `length_equals` on strings and arrays, `greater_than`
 * / `less_than` on numbers. When several checks stack, the tightest bound wins.
 *
 * The node's `_zod.bag` is NOT used: a number format check (`.int()`, `.int32()`)
 * overwrites the bag's `minimum` and `maximum` with the format's whole range when it
 * attaches, so `z.number().min(1).max(10).int()` would read as unbounded (Codex
 * review of 52680b4a3). The checks keep what the author wrote; the format's own range
 * is not a bound and is left out. Values that are not plain numbers (bigint, Date
 * bounds) are ignored. Zod internals are read defensively throughout.
 */
function authoredBounds(schema: ZodType): AuthoredBounds {
  const checks = (schema as unknown as { _zod?: { def?: { checks?: unknown[] } } })._zod?.def
    ?.checks;
  const out: AuthoredBounds = {};
  if (!Array.isArray(checks)) return out;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const tighterMax = (current: number | undefined, next: number): number =>
    current === undefined ? next : Math.min(current, next);
  const tighterMin = (current: number | undefined, next: number): number =>
    current === undefined ? next : Math.max(current, next);
  for (const check of checks) {
    const def = (check as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (!def) continue;
    switch (def.check) {
      case 'max_length': {
        const v = num(def.maximum);
        if (v !== undefined) out.maxLength = tighterMax(out.maxLength, v);
        break;
      }
      case 'min_length': {
        const v = num(def.minimum);
        if (v !== undefined) out.minLength = tighterMin(out.minLength, v);
        break;
      }
      case 'length_equals': {
        const v = num(def.length);
        if (v !== undefined) {
          out.minLength = tighterMin(out.minLength, v);
          out.maxLength = tighterMax(out.maxLength, v);
        }
        break;
      }
      case 'less_than': {
        const v = num(def.value);
        if (v === undefined) break;
        if (def.inclusive === false) out.exclusiveMaximum = tighterMax(out.exclusiveMaximum, v);
        else out.maximum = tighterMax(out.maximum, v);
        break;
      }
      case 'greater_than': {
        const v = num(def.value);
        if (v === undefined) break;
        if (def.inclusive === false) out.exclusiveMinimum = tighterMin(out.exclusiveMinimum, v);
        else out.minimum = tighterMin(out.minimum, v);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** `minLength` / `maxLength` or `minItems` / `maxItems` for a string or array node. */
function lengthKeywords(
  schema: ZodType,
  minKey: 'minLength' | 'minItems',
  maxKey: 'maxLength' | 'maxItems',
): Record<string, number> {
  const { minLength, maxLength } = authoredBounds(schema);
  return {
    ...(minLength !== undefined ? { [minKey]: minLength } : {}),
    ...(maxLength !== undefined ? { [maxKey]: maxLength } : {}),
  };
}

/**
 * True when the node carries an integer number format (`z.int()`, `z.int32()`,
 * `z.number().int()`): the format lives on the node's own def for the format
 * schemas and on a `number_format` check for the method form.
 */
function isIntegerFormat(schema: ZodType): boolean {
  const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  const isInt = (v: unknown): boolean => typeof v === 'string' && v.includes('int');
  if (isInt(def?.format)) return true;
  const checks = Array.isArray(def?.checks) ? (def?.checks as unknown[]) : [];
  return checks.some((check) => {
    const cd = (check as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    return cd?.check === 'number_format' && isInt(cd.format);
  });
}

/** `minimum` / `maximum` / `exclusiveMinimum` / `exclusiveMaximum` for a number node. */
function numericKeywords(schema: ZodType): Record<string, number> {
  const b = authoredBounds(schema);
  return {
    ...(b.minimum !== undefined ? { minimum: b.minimum } : {}),
    ...(b.maximum !== undefined ? { maximum: b.maximum } : {}),
    ...(b.exclusiveMinimum !== undefined ? { exclusiveMinimum: b.exclusiveMinimum } : {}),
    ...(b.exclusiveMaximum !== undefined ? { exclusiveMaximum: b.exclusiveMaximum } : {}),
  };
}

/**
 * Converts a Zod schema instance to a plain JSON Schema object.
 *
 * Recursively descends into ZodObject shapes, ZodArray item types, ZodOptional and
 * ZodDefault wrappers, transparently unwrapping them so the produced JSON Schema
 * is clean and does not contain Zod-specific metadata.
 *
 * @param schema - Any Zod schema instance.
 * @param options - {@link LowerZodOptions}; omit for the default keyword set.
 * @returns A JSON Schema-compatible plain object.
 *
 * @example
 * ```ts
 * lowerZodToJsonSchema(z.object({ name: z.string(), age: z.number().optional() }));
 * // → { type: 'object',
 * //     properties: { name: { type: 'string' }, age: { type: 'number' } },
 * //     required: ['name'] }
 * lowerZodToJsonSchema(z.string().max(120), { sizeConstraints: true });
 * // → { type: 'string', maxLength: 120 }
 * ```
 */
export function lowerZodToJsonSchema(
  schema: ZodType,
  options: LowerZodOptions = {},
): Record<string, unknown> {
  const lower = (inner: ZodType): Record<string, unknown> => lowerZodToJsonSchema(inner, options);
  const sized = options.sizeConstraints === true;
  // Access Zod v4 internals via `_def`; the top-level `_def.type` is the discriminant.
  const def = (schema as any)._def as Record<string, unknown> | undefined;
  if (!def) return {};

  // In Zod v4 the discriminant is `_def.type` (a plain string literal).
  const typeName = def.type as string | undefined;

  switch (typeName) {
    case 'string':
      return sized
        ? { type: 'string', ...lengthKeywords(schema, 'minLength', 'maxLength') }
        : { type: 'string' };

    case 'number':
      // Bounded mode is prompt text, so an integer format can say so; the
      // default stays `number` for the provider payloads.
      return sized
        ? { type: isIntegerFormat(schema) ? 'integer' : 'number', ...numericKeywords(schema) }
        : { type: 'number' };

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
        items: lower(def.element as ZodType),
        ...(sized ? lengthKeywords(schema, 'minItems', 'maxItems') : {}),
      };
    }

    case 'object': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Zod v4: def.shape is a plain Record<string, ZodType> (not a function as in Zod v3).
      const shape = def.shape as Record<string, ZodType>;

      for (const [key, fieldSchema] of Object.entries(shape)) {
        properties[key] = lower(fieldSchema);

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
      return lower(def.innerType as ZodType);

    case 'default':
      // Unwrap; defaults are runtime concerns, not JSON Schema concerns for our use case.
      return lower(def.innerType as ZodType);

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
      const inner = lower(def.innerType as ZodType);
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
      const variants = (def.options as ZodType[] | undefined) ?? [];
      return { anyOf: variants.map((opt) => lower(opt)) };
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
        additionalProperties: lower(def.valueType as ZodType),
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
        lower(m),
      );
      const rest = def.rest ? lower(def.rest as ZodType) : undefined;
      if (sized) {
        // Bounded mode is prompt text that no strict provider mode parses, so
        // the per-position schemas can stay apart (draft 2020-12 prefixItems)
        // and each member keeps its own bounds; collapsing them into one
        // `items` would read a 5-character slot as a 50-character one.
        return {
          type: 'array',
          prefixItems: members,
          ...(rest ? { items: rest } : {}),
          minItems: members.length,
          ...(rest ? {} : { maxItems: members.length }),
        };
      }
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
