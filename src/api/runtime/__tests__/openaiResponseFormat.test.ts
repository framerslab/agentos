import { describe, it, expect } from 'vitest';
import {
  canUseStrictJsonSchema,
  makeStrictJsonSchema,
  buildOpenAIJsonSchemaResponseFormat,
} from '../openaiResponseFormat.js';

describe('canUseStrictJsonSchema', () => {
  it('rejects undefined', () => {
    expect(canUseStrictJsonSchema(undefined)).toBe(false);
  });

  it('rejects an empty object (Zod v3 lowering case)', () => {
    expect(canUseStrictJsonSchema({})).toBe(false);
  });

  it('rejects a non-object root', () => {
    expect(canUseStrictJsonSchema({ type: 'string' })).toBe(false);
  });

  it('accepts an object root with declared properties', () => {
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
    })).toBe(true);
  });
});

describe('makeStrictJsonSchema', () => {
  it('adds additionalProperties: false to every object', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
    }) as Record<string, unknown>;
    expect(out.additionalProperties).toBe(false);
  });

  it('lifts every declared property into required (strict mode requirement)', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    }) as Record<string, unknown>;
    expect(out.required).toEqual(['a', 'b']);
  });

  it('recurses into nested objects', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
        },
      },
    }) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.outer.additionalProperties).toBe(false);
    expect(out.properties.outer.required).toEqual(['inner']);
  });

  it('recurses into array items so nested arrays-of-objects are strict', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        ingredients: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, amount: { type: 'string' } },
          },
        },
      },
    }) as any;
    expect(out.properties.ingredients.items.additionalProperties).toBe(false);
    expect(out.properties.ingredients.items.required).toEqual(['name', 'amount']);
  });

  it('does not mutate the input', () => {
    const input = { type: 'object', properties: { a: { type: 'string' } } };
    const snap = JSON.stringify(input);
    makeStrictJsonSchema(input);
    expect(JSON.stringify(input)).toBe(snap);
  });

  it('passes through non-object / non-array nodes', () => {
    expect(makeStrictJsonSchema({ type: 'string' })).toEqual({ type: 'string' });
    expect(makeStrictJsonSchema(null)).toBe(null);
  });
});

describe('buildOpenAIJsonSchemaResponseFormat', () => {
  it('wraps the schema in OpenAI strict json_schema shape', () => {
    const out = buildOpenAIJsonSchemaResponseFormat({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    expect(out).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
      },
    });
    const schema = (out as any).json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['name']);
  });

  it('honors the schemaName argument', () => {
    const out = buildOpenAIJsonSchemaResponseFormat({
      type: 'object',
      properties: { x: { type: 'string' } },
    }, 'my_recipe');
    expect((out as any).json_schema.name).toBe('my_recipe');
  });

  it('sanitizes invalid characters in schemaName (OpenAI requires [a-zA-Z0-9_-])', () => {
    const out = buildOpenAIJsonSchemaResponseFormat({
      type: 'object',
      properties: { x: { type: 'string' } },
    }, 'not allowed!@#$.dots');
    expect((out as any).json_schema.name).toBe('not_allowed_____dots');
  });

  it('clips schemaName to 64 chars and falls back to "response" if it ends up empty', () => {
    const long = 'a'.repeat(100);
    const out1 = buildOpenAIJsonSchemaResponseFormat({ type: 'object', properties: {} }, long);
    expect((out1 as any).json_schema.name.length).toBeLessThanOrEqual(64);

    const out2 = buildOpenAIJsonSchemaResponseFormat({ type: 'object', properties: {} }, '!!!!');
    expect((out2 as any).json_schema.name).toBe('response');
  });
});

describe('canUseStrictJsonSchema — recursive scan (nested-gap fix)', () => {
  it('rejects a schema whose nested property is untyped `{}`', () => {
    // Previously only the root was checked; a nested `{}` (unsupported Zod
    // type) passed the gate and the API 400'd instead of degrading.
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' }, mystery: {} },
    })).toBe(false);
  });

  it('rejects a nested record shape (schema-valued additionalProperties)', () => {
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: {
        counters: { type: 'object', additionalProperties: { type: 'number' } },
      },
    })).toBe(false);
  });

  it('rejects an array whose items are untyped', () => {
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: { list: { type: 'array', items: {} } },
    })).toBe(false);
  });

  it('accepts nested unions whose every member is concrete', () => {
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: {
        result: {
          anyOf: [
            { type: 'object', properties: { kind: { enum: ['a'] }, x: { type: 'string' } } },
            { type: 'object', properties: { kind: { enum: ['b'] }, y: { type: 'number' } } },
          ],
        },
      },
    })).toBe(true);
  });

  it('accepts nullable type arrays from the lowering (e.g. ["string","null"])', () => {
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: { hint: { type: ['string', 'null'] } },
    })).toBe(true);
  });

  it('rejects a union containing an untyped member', () => {
    expect(canUseStrictJsonSchema({
      type: 'object',
      properties: { result: { anyOf: [{ type: 'string' }, {}] } },
    })).toBe(false);
  });
});

describe('makeStrictJsonSchema — union recursion (discriminatedUnion 400 fix)', () => {
  it('recurses into anyOf members so object variants become strict', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        action: {
          anyOf: [
            { type: 'object', properties: { kind: { enum: ['move'] }, dir: { type: 'string' } } },
            { type: 'object', properties: { kind: { enum: ['wait'] } } },
          ],
        },
      },
    }) as any;
    const variants = out.properties.action.anyOf;
    expect(variants[0].additionalProperties).toBe(false);
    expect(variants[0].required).toEqual(['kind', 'dir']);
    expect(variants[1].additionalProperties).toBe(false);
    expect(variants[1].required).toEqual(['kind']);
  });

  it('recurses into oneOf members the same way', () => {
    const out = makeStrictJsonSchema({
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    }) as any;
    expect(out.oneOf[0].additionalProperties).toBe(false);
    expect(out.oneOf[1].additionalProperties).toBe(false);
  });
});
