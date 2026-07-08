/**
 * @file responseFormatForProvider.test.ts
 * Matrix tests for the per-provider structured-output payload builder used
 * by generateObject's primary path and by generateText's fallback legs.
 * Covers providers × {plain object schema, record-bearing schema, top-level
 * array envelope, Fable model} and the shape describer that feeds the
 * `fallback_fired` log's `rebuiltResponseFormatType` field.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildResponseFormatForProvider,
  describeResponseFormatShape,
} from '../responseFormatForProvider.js';
import { lowerZodToJsonSchema } from '../../../orchestration/compiler/SchemaLowering.js';

const plainSchema = z.object({ title: z.string(), count: z.number().int() });
// z.record lowers to a schema-valued additionalProperties -> fails every
// strict gate (the exact shape behind the 2026-07-06 Anthropic 400 storm).
const recordSchema = z.object({ palette: z.record(z.string(), z.string()) });

function inputs(providerId: string, modelId: string, schema: z.ZodTypeAny) {
  return {
    providerId,
    modelId,
    jsonSchema: lowerZodToJsonSchema(schema),
    effectiveSchema: schema,
    schemaName: 'testSchema',
  };
}

describe('buildResponseFormatForProvider', () => {
  it('openai + plain schema -> strict json_schema', () => {
    const rf = buildResponseFormatForProvider(inputs('openai', 'gpt-4o', plainSchema));
    expect(rf).toMatchObject({ type: 'json_schema' });
    expect((rf as any).json_schema.strict).toBe(true);
    expect((rf as any).json_schema.name).toBeTruthy();
  });

  it('openai + record schema -> json_object degrade', () => {
    const rf = buildResponseFormatForProvider(inputs('openai', 'gpt-4o-mini', recordSchema));
    expect(rf).toEqual({ type: 'json_object' });
  });

  it('anthropic + forced-tool-capable model -> tool marker', () => {
    const rf = buildResponseFormatForProvider(
      inputs('anthropic', 'claude-sonnet-4-6', plainSchema),
    );
    expect((rf as any)._agentosUseToolForStructuredOutput).toBe(true);
    expect((rf as any).tool.input_schema).toBeTruthy();
  });

  it('anthropic + Fable -> undefined (prompt-only)', () => {
    expect(
      buildResponseFormatForProvider(inputs('anthropic', 'claude-fable-5', plainSchema)),
    ).toBeUndefined();
  });

  it('anthropic + empty modelId (default-model fallback entry) -> tool marker', () => {
    const rf = buildResponseFormatForProvider(inputs('anthropic', '', plainSchema));
    expect((rf as any)._agentosUseToolForStructuredOutput).toBe(true);
  });

  it('gemini -> _gemini responseSchema payload', () => {
    const rf = buildResponseFormatForProvider(inputs('gemini', 'gemini-2.5-pro', plainSchema));
    expect((rf as any)._gemini?.responseSchema).toBeTruthy();
  });

  it('gemini-cli -> undefined (provider never reads responseFormat)', () => {
    expect(
      buildResponseFormatForProvider(inputs('gemini-cli', 'gemini-2.5-pro', plainSchema)),
    ).toBeUndefined();
  });

  it('openrouter + plain schema -> strict json_schema; record -> json_object', () => {
    expect(
      buildResponseFormatForProvider(inputs('openrouter', 'openai/gpt-5.5', plainSchema)),
    ).toMatchObject({ type: 'json_schema' });
    expect(
      buildResponseFormatForProvider(inputs('openrouter', 'openai/gpt-5.5', recordSchema)),
    ).toEqual({ type: 'json_object' });
  });

  it('unknown provider -> undefined (schema rides the system prompt)', () => {
    expect(
      buildResponseFormatForProvider(inputs('ollama', 'llama3', plainSchema)),
    ).toBeUndefined();
  });

  it('top-level array envelope schema builds without throwing on every provider', () => {
    const envelope = z.object({ items: z.array(plainSchema) });
    for (const [p, m] of [
      ['openai', 'gpt-4o'],
      ['anthropic', 'claude-opus-4-8'],
      ['gemini', 'gemini-2.5-pro'],
      ['openrouter', 'openai/gpt-5.5'],
    ] as const) {
      expect(() => buildResponseFormatForProvider(inputs(p, m, envelope))).not.toThrow();
    }
  });
});

describe('describeResponseFormatShape', () => {
  it('maps the four shapes + none', () => {
    expect(describeResponseFormatShape(undefined)).toBe('none');
    expect(
      describeResponseFormatShape({ _agentosUseToolForStructuredOutput: true }),
    ).toBe('anthropic_tool');
    expect(describeResponseFormatShape({ type: 'json_object', _gemini: {} })).toBe(
      'gemini_response_schema',
    );
    expect(describeResponseFormatShape({ type: 'json_schema', json_schema: {} })).toBe(
      'json_schema',
    );
    expect(describeResponseFormatShape({ type: 'json_object' })).toBe('json_object');
    expect(describeResponseFormatShape({ weird: true })).toBe('unknown');
  });
});
