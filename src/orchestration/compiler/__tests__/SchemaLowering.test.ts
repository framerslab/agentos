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
