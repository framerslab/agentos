/**
 * @file model-strict-tool-use.test.ts
 * @description Pins the strict-tool-use capability allowlist. A new Claude
 *              family must get an explicit, reviewed entry here — silently
 *              inheriting `strict: true` (or silently losing it) is how a
 *              whole model generation either 400s on every structured call
 *              or quietly drops schema enforcement.
 */
import { describe, expect, it } from 'vitest';
import {
  modelSupportsStrictToolUse,
  toolInputSchemaSupportsStrict,
  toolInputSchemaWithExplicitNoExtraProps,
} from '../model-strict-tool-use';

describe('modelSupportsStrictToolUse', () => {
  it('accepts the 4.5-generation launch models', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-opus-4-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('accepts the later opus point releases and the 5.x families', () => {
    expect(modelSupportsStrictToolUse('claude-opus-4-6')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-opus-4-8')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-sonnet-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-fable-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-fable-5-20260601')).toBe(true);
  });

  it('rejects pre-4.5 models that 400 on the unknown strict field', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-20250514')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-opus-4-1')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-3-5-sonnet-20241022')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-3-haiku-20240307')).toBe(false);
  });

  it('does not false-positive on lookalike ids', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-50')).toBe(false);
    expect(modelSupportsStrictToolUse('gpt-4o')).toBe(false);
    expect(modelSupportsStrictToolUse('')).toBe(false);
  });
});

describe('toolInputSchemaSupportsStrict (schema-shape half of the strict gate)', () => {
  it('accepts a plain object schema with absent additionalProperties', () => {
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: { verdict: { enum: ['yes', 'no'] }, score: { type: 'number' } },
        required: ['verdict', 'score'],
      }),
    ).toBe(true);
  });

  it('accepts an explicit additionalProperties: false', () => {
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: { x: { type: 'string' } },
        additionalProperties: false,
      }),
    ).toBe(true);
  });

  it('rejects a record-shaped root (schema-valued additionalProperties — z.record lowering)', () => {
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        additionalProperties: { type: 'string' },
      }),
    ).toBe(false);
  });

  it('rejects additionalProperties: true', () => {
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: {},
        additionalProperties: true,
      }),
    ).toBe(false);
  });

  it('rejects a NESTED record — property value, array items, and union members', () => {
    const record = { type: 'object', additionalProperties: { type: 'number' } };
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: { config: record },
      }),
    ).toBe(false);
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: { entries: { type: 'array', items: record } },
      }),
    ).toBe(false);
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: { variant: { anyOf: [{ type: 'string' }, record] } },
      }),
    ).toBe(false);
  });

  it('does not false-positive on a FIELD literally named additionalProperties', () => {
    // `properties` values are subschemas keyed by FIELD NAME — a field that
    // happens to be called additionalProperties is data, not a schema keyword.
    expect(
      toolInputSchemaSupportsStrict({
        type: 'object',
        properties: { additionalProperties: { type: 'string' } },
      }),
    ).toBe(true);
  });

  it('tolerates non-object inputs (nothing schema-shaped to violate)', () => {
    expect(toolInputSchemaSupportsStrict(undefined)).toBe(true);
    expect(toolInputSchemaSupportsStrict(null)).toBe(true);
    expect(toolInputSchemaSupportsStrict('not-a-schema')).toBe(true);
  });

  it('refuses pathological nesting instead of scanning forever', () => {
    let node: Record<string, unknown> = { type: 'object', properties: {} };
    const root = node;
    for (let i = 0; i < 100; i++) {
      const child: Record<string, unknown> = { type: 'object', properties: {} };
      (node.properties as Record<string, unknown>).nested = child;
      node = child;
    }
    expect(toolInputSchemaSupportsStrict(root)).toBe(false);
  });
});

describe('toolInputSchemaWithExplicitNoExtraProps (strict-payload rewrite)', () => {
  it('stamps additionalProperties:false on the root and every nested object node', () => {
    const out = toolInputSchemaWithExplicitNoExtraProps({
      type: 'object',
      properties: {
        inner: { type: 'object', properties: { z: { type: 'number' } }, required: ['z'] },
      },
      required: ['inner'],
    }) as Record<string, any>;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.inner.additionalProperties).toBe(false);
    // required is untouched — Anthropic strict accepts optional properties
    // (live-API verified 2026-07-07); force-requiring would corrupt
    // `.optional()` semantics.
    expect(out.required).toEqual(['inner']);
    expect(out.properties.inner.required).toEqual(['z']);
  });

  it('covers array items, tuple items, union members, and definitions values', () => {
    const obj = { type: 'object', properties: { z: { type: 'number' } } };
    const out = toolInputSchemaWithExplicitNoExtraProps({
      type: 'object',
      properties: {
        list: { type: 'array', items: obj },
        tuple: { type: 'array', items: [obj, { type: 'string' }] },
        variant: { anyOf: [{ type: 'string' }, obj] },
      },
      definitions: { Def: obj },
    }) as Record<string, any>;
    expect(out.properties.list.items.additionalProperties).toBe(false);
    expect(out.properties.tuple.items[0].additionalProperties).toBe(false);
    expect(out.properties.variant.anyOf[1].additionalProperties).toBe(false);
    expect(out.definitions.Def.additionalProperties).toBe(false);
    // non-object members stay untouched
    expect('additionalProperties' in out.properties.tuple.items[1]).toBe(false);
    expect('additionalProperties' in out.properties.variant.anyOf[0]).toBe(false);
  });

  it('leaves an explicit additionalProperties untouched and never mutates its input', () => {
    const input = {
      type: 'object',
      properties: { x: { type: 'object', properties: {}, additionalProperties: false } },
    } as Record<string, any>;
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = toolInputSchemaWithExplicitNoExtraProps(input) as Record<string, any>;
    expect(out.properties.x.additionalProperties).toBe(false);
    expect(out.additionalProperties).toBe(false);
    // the caller's schema object is never written to
    expect(input).toEqual(snapshot);
    expect('additionalProperties' in input).toBe(false);
  });

  it('passes non-object inputs through unchanged', () => {
    expect(toolInputSchemaWithExplicitNoExtraProps(undefined)).toBeUndefined();
    expect(toolInputSchemaWithExplicitNoExtraProps(null)).toBeNull();
    expect(toolInputSchemaWithExplicitNoExtraProps('x')).toBe('x');
  });

  it('strips the constraint keywords the strict validator rejects (live-API mapped 2026-07-07)', () => {
    const out = toolInputSchemaWithExplicitNoExtraProps({
      type: 'object',
      properties: {
        files: { type: 'array', maxItems: 25, uniqueItems: true, minItems: 1, items: { type: 'string' } },
        score: { type: 'number', minimum: 0, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11, multipleOf: 1 },
        meta: { type: 'object', properties: {}, minProperties: 0, maxProperties: 5 },
      },
      required: ['files'],
    }) as Record<string, any>;
    // rejected keywords gone…
    expect('maxItems' in out.properties.files).toBe(false);
    expect('uniqueItems' in out.properties.files).toBe(false);
    for (const kw of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
      expect(kw in out.properties.score).toBe(false);
    }
    expect('minProperties' in out.properties.meta).toBe(false);
    expect('maxProperties' in out.properties.meta).toBe(false);
    // …accepted keywords kept (minItems IS supported, unlike maxItems)
    expect(out.properties.files.minItems).toBe(1);
    expect(out.properties.meta.additionalProperties).toBe(false);
  });

  it('keeps accepted keywords: enum, const, pattern, lengths, format, default', () => {
    const out = toolInputSchemaWithExplicitNoExtraProps({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['a', 'b'] },
        tag: { const: 'fixed' },
        name: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[a-z]+$' },
        url: { type: 'string', format: 'uri', default: 'x' },
      },
      required: ['kind'],
    }) as Record<string, any>;
    expect(out.properties.kind.enum).toEqual(['a', 'b']);
    expect(out.properties.tag.const).toBe('fixed');
    expect(out.properties.name.minLength).toBe(1);
    expect(out.properties.name.maxLength).toBe(50);
    expect(out.properties.name.pattern).toBe('^[a-z]+$');
    expect(out.properties.url.format).toBe('uri');
    expect(out.properties.url.default).toBe('x');
  });

  it('does not strip a FIELD literally named after a rejected keyword', () => {
    // properties-map KEYS are field names, not schema keywords.
    const out = toolInputSchemaWithExplicitNoExtraProps({
      type: 'object',
      properties: { maximum: { type: 'string' }, maxItems: { type: 'number' } },
    }) as Record<string, any>;
    expect(out.properties.maximum).toEqual({ type: 'string' });
    expect(out.properties.maxItems).toEqual({ type: 'number' });
  });
});

describe('draft-2020 keyword completeness (2026-07-07 C1.1)', () => {
  const record = { type: 'object', additionalProperties: { type: 'string' } };

  it.each([
    ['if', { type: 'object', properties: {}, if: record }],
    ['then', { type: 'object', properties: {}, then: record }],
    ['else', { type: 'object', properties: {}, else: record }],
    ['not', { type: 'object', properties: {}, not: record }],
    ['unevaluatedProperties', { type: 'object', properties: {}, unevaluatedProperties: record }],
    ['contains', { type: 'array', items: { type: 'string' }, contains: record }],
    ['prefixItems', { type: 'array', prefixItems: [record], items: { type: 'string' } }],
    ['dependentSchemas', { type: 'object', properties: {}, dependentSchemas: { flag: record } }],
  ] as const)('a record hidden under %s fails the gate', (_kw, schema) => {
    expect(toolInputSchemaSupportsStrict(schema)).toBe(false);
  });

  it('stamps additionalProperties:false + strips rejected keywords inside the widened positions', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      then: {
        type: 'object',
        properties: { b: { type: 'array', maxItems: 3, items: { type: 'string' } } },
      },
      dependentSchemas: {
        a: { type: 'object', properties: { d: { type: 'number', minimum: 1 } } },
      },
    };
    const out = toolInputSchemaWithExplicitNoExtraProps(schema) as Record<string, any>;
    expect(out.then.additionalProperties).toBe(false);
    expect(out.then.properties.b.maxItems).toBeUndefined();
    expect(out.dependentSchemas.a.additionalProperties).toBe(false);
    expect(out.dependentSchemas.a.properties.d.minimum).toBeUndefined();
    // non-mutating: the input keeps its constraint keywords
    expect(schema.then.properties.b.maxItems).toBe(3);
    expect(schema.dependentSchemas.a.properties.d.minimum).toBe(1);
  });

  it('stamps inside prefixItems tuple members', () => {
    const schema = {
      type: 'array',
      prefixItems: [{ type: 'object', properties: { c: { type: 'string' } } }],
      items: { type: 'string' },
    };
    const out = toolInputSchemaWithExplicitNoExtraProps(schema) as Record<string, any>;
    expect(out.prefixItems[0].additionalProperties).toBe(false);
  });
});
