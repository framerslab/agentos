import { describe, expect, it } from 'vitest';

import { sanitizeGeminiResponseSchema } from '../implementations/geminiResponseSchema.js';

describe('sanitizeGeminiResponseSchema', () => {
  it('strips the z.record map encoding that 400ed world creation (2026-07-16)', () => {
    // z.record(...) lowers to { type: 'object', additionalProperties: <schema> }
    // nested under a property — exactly the shape Gemini rejected with
    // `Unknown name "additionalProperties" at 'generation_config.response_schema.properties…'`.
    const schema = {
      type: 'object',
      properties: {
        objectives: { type: 'array', items: { type: 'string' } },
        rewardsByStat: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
      },
      required: ['objectives'],
    };
    const out = sanitizeGeminiResponseSchema(schema);
    expect(JSON.stringify(out)).not.toContain('additionalProperties');
    expect((out.properties as Record<string, unknown>).rewardsByStat).toEqual({ type: 'object' });
    // Untouched siblings survive intact.
    expect((out.properties as Record<string, unknown>).objectives).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(out.required).toEqual(['objectives']);
  });

  it('strips strict-mode additionalProperties:false and other non-Gemini keys recursively', () => {
    const out = sanitizeGeminiResponseSchema({
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      patternProperties: { '^x-': { type: 'string' } },
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { a: { type: 'string', examples: ['x'] } },
        },
      },
    });
    const text = JSON.stringify(out);
    for (const banned of ['additionalProperties', '$schema', 'patternProperties', 'examples']) {
      expect(text).not.toContain(banned);
    }
    expect(out).toMatchObject({
      type: 'object',
      properties: { nested: { type: 'object', properties: { a: { type: 'string' } } } },
    });
  });

  it('preserves the full Gemini field subset verbatim', () => {
    const schema = {
      type: 'string',
      format: 'date-time',
      description: 'when it happens',
      nullable: true,
      enum: ['now', 'later'],
      minLength: 1,
      maxLength: 32,
      pattern: '^[a-z]+$',
    };
    expect(sanitizeGeminiResponseSchema(schema)).toEqual(schema);
  });

  it('rewrites const to a single-member enum and oneOf to anyOf', () => {
    const out = sanitizeGeminiResponseSchema({
      type: 'object',
      properties: {
        kind: { const: 'boss' },
        payload: { oneOf: [{ type: 'string' }, { type: 'number', const: 7 }] },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.kind).toEqual({ enum: ['boss'] });
    expect(props.payload).toEqual({ anyOf: [{ type: 'string' }, { type: 'number', enum: [7] }] });
  });

  it('converts the nullable type-array lowering to type + nullable', () => {
    // SchemaLowering emits { type: ['string', 'null'] } for bare-primitive
    // z.foo().nullable(); Gemini wants a single type plus a nullable flag.
    expect(sanitizeGeminiResponseSchema({ type: ['string', 'null'] })).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('inlines a single-member allOf and expresses tuple items as anyOf', () => {
    const out = sanitizeGeminiResponseSchema({
      allOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
    });
    expect(out).toEqual({ type: 'object', properties: { a: { type: 'string' } } });

    const tuple = sanitizeGeminiResponseSchema({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
    });
    expect(tuple).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    });
  });

  it('never throws on malformed nodes and never mutates its input', () => {
    const schema = {
      type: 'object',
      properties: { odd: null as unknown, rec: { type: 'object', additionalProperties: false } },
    };
    const frozen = JSON.parse(JSON.stringify(schema));
    expect(() => sanitizeGeminiResponseSchema(schema)).not.toThrow();
    sanitizeGeminiResponseSchema(schema);
    expect(schema).toEqual(frozen);
  });
});
