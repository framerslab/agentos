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
