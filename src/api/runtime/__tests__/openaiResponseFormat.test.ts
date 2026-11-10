import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { lowerZodToJsonSchema } from '../../../orchestration/compiler/SchemaLowering.js';
import { buildResponseFormatForProvider } from '../responseFormatForProvider.js';
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
          required: ['inner'],
        },
      },
      required: ['outer'],
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
            required: ['name', 'amount'],
          },
        },
      },
      required: ['ingredients'],
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

describe('makeStrictJsonSchema — an optional property is required and nullable', () => {
  // Strict mode takes no optional property. Without null a model under
  // constrained decoding wrote a placeholder ("" under a .min(1), 0 under a
  // .min(5)) for every property the caller left optional.
  it('makes a property the node leaves out of required accept null, and leaves a required one as it is', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: { text: { type: 'string' }, speaker: { type: 'string' }, durationSec: { type: 'number' } },
      required: ['text'],
    }) as any;
    expect(out.required).toEqual(['text', 'speaker', 'durationSec']);
    expect(out.properties.text).toEqual({ type: 'string' });
    expect(out.properties.speaker).toEqual({ type: ['string', 'null'] });
    expect(out.properties.durationSec).toEqual({ type: ['number', 'null'] });
  });

  it('reads a node with no required as one whose every property is optional', () => {
    const out = makeStrictJsonSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'boolean' } } }) as any;
    expect(out.required).toEqual(['a', 'b']);
    expect(out.properties.a).toEqual({ type: ['string', 'null'] });
    expect(out.properties.b).toEqual({ type: ['boolean', 'null'] });
  });

  it('makes an optional nested object nullable through anyOf, its own optional properties too', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        transition: {
          type: 'object',
          properties: { kind: { enum: ['cut', 'fade'] }, durationMs: { type: 'number' } },
          required: ['kind'],
        },
      },
    }) as any;
    expect(out.required).toEqual(['transition']);
    expect(out.properties.transition).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: { kind: { enum: ['cut', 'fade'] }, durationMs: { type: ['number', 'null'] } },
          required: ['kind', 'durationMs'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    });
  });

  it('reaches the optional properties of objects inside an array', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        frames: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, imageUrl: { type: 'string' } }, required: ['text'] },
        },
      },
      required: ['frames'],
    }) as any;
    expect(out.properties.frames.type).toBe('array');
    expect(out.properties.frames.items.required).toEqual(['text', 'imageUrl']);
    expect(out.properties.frames.items.properties.text).toEqual({ type: 'string' });
    expect(out.properties.frames.items.properties.imageUrl).toEqual({ type: ['string', 'null'] });
    expect(out.properties.frames.items.additionalProperties).toBe(false);
  });

  it('makes an optional enum nullable through anyOf, and adds null to an optional union once', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        mood: { enum: ['calm', 'tense'] },
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    }) as any;
    expect(out.properties.mood).toEqual({ anyOf: [{ enum: ['calm', 'tense'] }, { type: 'null' }] });
    expect(out.properties.value).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] });
  });

  it('leaves an optional property that accepts null already as it is', () => {
    const out = makeStrictJsonSchema({
      type: 'object',
      properties: {
        note: { type: ['string', 'null'] },
        meta: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'null' }] },
      },
    }) as any;
    expect(out.properties.note).toEqual({ type: ['string', 'null'] });
    expect(out.properties.meta.anyOf).toHaveLength(2);
    expect(out.properties.meta.anyOf[1]).toEqual({ type: 'null' });
  });

  it('gives OpenAI and OpenRouter a strict payload whose optional Zod fields are required and nullable', () => {
    const schema = z.object({
      id: z.string(),
      frames: z.array(
        z.object({
          text: z.string().min(1),
          imageUrl: z.string().min(1).optional(),
          clipDurationSec: z.number().min(5).optional(),
          transition: z.object({ kind: z.enum(['cut', 'fade']), durationMs: z.number().min(150) }).optional(),
        }),
      ),
      note: z.string().nullable().optional(),
    });
    const jsonSchema = lowerZodToJsonSchema(schema);
    for (const providerId of ['openai', 'openrouter']) {
      const payload = buildResponseFormatForProvider({ providerId, modelId: 'gpt-4o-mini', jsonSchema, effectiveSchema: schema, schemaName: 'scene' }) as any;
      expect(payload.type).toBe('json_schema');
      const root = payload.json_schema.schema;
      expect(root.required).toEqual(['id', 'frames', 'note']);
      expect(root.properties.note).toEqual({ type: ['string', 'null'] });
      const frame = root.properties.frames.items;
      expect(frame.required).toEqual(['text', 'imageUrl', 'clipDurationSec', 'transition']);
      expect(frame.properties.text).toEqual({ type: 'string' });
      expect(frame.properties.imageUrl).toEqual({ type: ['string', 'null'] });
      expect(frame.properties.clipDurationSec).toEqual({ type: ['number', 'null'] });
      expect(frame.properties.transition.anyOf[1]).toEqual({ type: 'null' });
      expect(frame.properties.transition.anyOf[0].required).toEqual(['kind', 'durationMs']);
    }
  });
});
