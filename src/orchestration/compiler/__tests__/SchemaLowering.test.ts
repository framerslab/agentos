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
