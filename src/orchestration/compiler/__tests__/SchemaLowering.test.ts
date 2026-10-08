import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { lowerZodToJsonSchema } from '../SchemaLowering.js';

describe('lowerZodToJsonSchema — union / literal / record (structured-output gap)', () => {
  it('lowers z.literal to an enum of its constant', () => {
    expect(lowerZodToJsonSchema(z.literal('freeform'))).toEqual({ enum: ['freeform'] });
  });

  it('lowers z.union to anyOf of the option schemas', () => {
    expect(lowerZodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('lowers z.record to an object with additionalProperties', () => {
    expect(lowerZodToJsonSchema(z.record(z.string(), z.number()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    });
  });

  it('lowers a top-level z.discriminatedUnion to anyOf of object variants', () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.string() }),
      z.object({ kind: z.literal('b'), y: z.number().optional() }),
    ]);
    expect(lowerZodToJsonSchema(schema)).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { kind: { enum: ['a'] }, x: { type: 'string' } },
          required: ['kind', 'x'],
        },
        {
          type: 'object',
          properties: { kind: { enum: ['b'] }, y: { type: 'number' } },
          required: ['kind'],
        },
      ],
    });
  });

  it('object schemas are unchanged (no regression)', () => {
    expect(lowerZodToJsonSchema(z.object({ a: z.string(), b: z.number().optional() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
  });
});

describe('lowerZodToJsonSchema — tuples (OpenAI strict-mode gap)', () => {
  // A ZodTuple previously fell through to `{}` (no `type` key), which made any
  // schema containing one unusable under OpenAI strict structured outputs
  // ("schema must have a 'type' key" — the wilds DungeonLayoutSchema
  // `spawnPos: z.tuple([number, number, number])` path, 2026-07-02).
  it('lowers a homogeneous tuple to a fixed-length typed array', () => {
    expect(lowerZodToJsonSchema(z.tuple([z.number(), z.number(), z.number()]))).toEqual({
      type: 'array',
      items: { type: 'number' },
      minItems: 3,
      maxItems: 3,
    });
  });

  it('lowers a heterogeneous tuple to a deduped anyOf items array', () => {
    expect(lowerZodToJsonSchema(z.tuple([z.string(), z.number(), z.string()]))).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      minItems: 3,
      maxItems: 3,
    });
  });

  it('drops maxItems when the tuple has a rest element', () => {
    expect(lowerZodToJsonSchema(z.tuple([z.string()]).rest(z.number()))).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      minItems: 1,
    });
  });

  it('a tuple nested inside an object no longer produces a typeless node', () => {
    const lowered = lowerZodToJsonSchema(
      z.object({ spawnPos: z.tuple([z.number(), z.number(), z.number()]) }),
    ) as { properties: { spawnPos: Record<string, unknown> } };
    expect(lowered.properties.spawnPos.type).toBe('array');
  });
});

describe('lowerZodToJsonSchema — nullable (OpenAI strict-mode gap)', () => {
  // z.foo().nullable() previously fell through to `{}` (no `type` key) —
  // one nullable field anywhere in a schema made OpenAI strict mode 400
  // the whole structured-output call.
  it('lowers a nullable primitive to a type array including null', () => {
    expect(lowerZodToJsonSchema(z.string().nullable())).toEqual({
      type: ['string', 'null'],
    });
    expect(lowerZodToJsonSchema(z.number().nullable())).toEqual({
      type: ['number', 'null'],
    });
  });

  it('lowers a nullable object to anyOf [object, null]', () => {
    expect(lowerZodToJsonSchema(z.object({ a: z.string() }).nullable())).toEqual({
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'null' },
      ],
    });
  });

  it('lowers a nullable enum to anyOf [enum, null]', () => {
    expect(lowerZodToJsonSchema(z.enum(['x', 'y']).nullable())).toEqual({
      anyOf: [{ enum: ['x', 'y'] }, { type: 'null' }],
    });
  });

  it('a nullable field stays REQUIRED on its parent (nullable is not optional)', () => {
    expect(lowerZodToJsonSchema(z.object({ hint: z.string().nullable() }))).toEqual({
      type: 'object',
      properties: { hint: { type: ['string', 'null'] } },
      required: ['hint'],
    });
  });

  it('nullable of an unsupported inner type stays untyped `{}`', () => {
    expect(lowerZodToJsonSchema(z.unknown().nullable())).toEqual({});
  });
});

describe('lowerZodToJsonSchema — size constraints (prompt-only structured output)', () => {
  const contract = z.object({
    summary: z.string().min(1).max(2000),
    tags: z.array(z.string().min(1).max(80)).max(16),
    intents: z
      .array(z.object({ trackId: z.string().max(120), intent: z.string().max(300) }))
      .min(1)
      .max(40),
    score: z.number().min(0).max(10),
    note: z.string().max(60).optional(),
  });

  it('drops every size check by default (provider payloads are unchanged)', () => {
    const lowered = lowerZodToJsonSchema(contract);
    expect(JSON.stringify(lowered)).not.toMatch(
      /maxLength|minLength|maxItems|minItems|maximum|minimum/,
    );
    expect(lowered).toEqual({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        intents: {
          type: 'array',
          items: {
            type: 'object',
            properties: { trackId: { type: 'string' }, intent: { type: 'string' } },
            required: ['trackId', 'intent'],
          },
        },
        score: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['summary', 'tags', 'intents', 'score'],
    });
  });

  it('emits string, array and number bounds on request, through wrappers and nesting', () => {
    expect(lowerZodToJsonSchema(contract, { sizeConstraints: true })).toEqual({
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 80 },
          maxItems: 16,
        },
        intents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              trackId: { type: 'string', maxLength: 120 },
              intent: { type: 'string', maxLength: 300 },
            },
            required: ['trackId', 'intent'],
          },
          minItems: 1,
          maxItems: 40,
        },
        score: { type: 'number', minimum: 0, maximum: 10 },
        note: { type: 'string', maxLength: 60 },
      },
      required: ['summary', 'tags', 'intents', 'score'],
    });
  });

  it('keeps the tightest bound when checks stack, and the exclusive numeric forms', () => {
    expect(lowerZodToJsonSchema(z.string().max(100).max(40), { sizeConstraints: true })).toEqual({
      type: 'string',
      maxLength: 40,
    });
    expect(lowerZodToJsonSchema(z.string().length(8), { sizeConstraints: true })).toEqual({
      type: 'string',
      minLength: 8,
      maxLength: 8,
    });
    expect(lowerZodToJsonSchema(z.number().gt(0).lt(1), { sizeConstraints: true })).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    });
    // A number format check (`.int()`, `.int32()`) is a range, not an authored bound,
    // and it must not hide a bound written before OR after it.
    expect(lowerZodToJsonSchema(z.number().int().min(1), { sizeConstraints: true })).toEqual({
      type: 'integer',
      minimum: 1,
    });
    const boundedInt = z.number().min(1).max(10).int();
    expect(lowerZodToJsonSchema(boundedInt, { sizeConstraints: true })).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
    expect(lowerZodToJsonSchema(z.number().int(), { sizeConstraints: true })).toEqual({
      type: 'integer',
    });
    expect(lowerZodToJsonSchema(z.int32().max(5), { sizeConstraints: true })).toEqual({
      type: 'integer',
      maximum: 5,
    });
    expect(lowerZodToJsonSchema(z.float64(), { sizeConstraints: true })).toEqual({ type: 'number' });
    // The default lowering never says integer: provider payloads are unchanged.
    expect(lowerZodToJsonSchema(z.number().int())).toEqual({ type: 'number' });
    expect(lowerZodToJsonSchema(z.int32().max(5))).toEqual({ type: 'number' });
    expect(lowerZodToJsonSchema(z.number().positive(), { sizeConstraints: true })).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
    });
    expect(lowerZodToJsonSchema(z.string().nonempty(), { sizeConstraints: true })).toEqual({
      type: 'string',
      minLength: 1,
    });
    const nonEmptyList = z.array(z.string()).nonempty();
    expect(lowerZodToJsonSchema(nonEmptyList, { sizeConstraints: true })).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    });
  });

  it('leaves an unbounded node as it was', () => {
    expect(lowerZodToJsonSchema(z.string(), { sizeConstraints: true })).toEqual({ type: 'string' });
    expect(lowerZodToJsonSchema(z.array(z.number()), { sizeConstraints: true })).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
  });

  it('keeps each tuple position apart with its own bounds (prompt text only)', () => {
    const pair = z.tuple([z.string().max(5), z.string().max(50)]);
    expect(lowerZodToJsonSchema(pair, { sizeConstraints: true })).toEqual({
      type: 'array',
      prefixItems: [
        { type: 'string', maxLength: 5 },
        { type: 'string', maxLength: 50 },
      ],
      minItems: 2,
      maxItems: 2,
    });
    const withRest = z.tuple([z.string()]).rest(z.number().max(3));
    expect(lowerZodToJsonSchema(withRest, { sizeConstraints: true })).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }],
      items: { type: 'number', maximum: 3 },
      minItems: 1,
    });
    // The default lowering keeps the collapsed shape strict provider modes accept.
    expect(lowerZodToJsonSchema(pair)).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 2,
    });
  });
});
