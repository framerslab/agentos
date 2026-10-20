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
  responseFormatCarriesSchema,
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

  it('anthropic + a model with the JSON output format (Sonnet 4.6) -> marker with route json_schema', () => {
    const rf = buildResponseFormatForProvider(
      inputs('anthropic', 'claude-sonnet-4-6', plainSchema),
    );
    expect(rf).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'json_schema' });
    expect((rf as any).tool.input_schema).toBeTruthy();
  });

  it('anthropic + Fable -> marker with route json_schema (the format, never a forced tool)', () => {
    expect(
      buildResponseFormatForProvider(inputs('anthropic', 'claude-fable-5', plainSchema)),
    ).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'json_schema' });
  });

  it('anthropic + Sonnet 5.5 -> marker with route json_schema', () => {
    expect(
      buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-5-5', plainSchema)),
    ).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'json_schema' });
  });

  it('anthropic + Sonnet 5.5 + record schema -> undefined (the format cannot carry it and the model refuses a forced tool; the schema rides the prompt)', () => {
    expect(
      buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-5-5', recordSchema)),
    ).toBeUndefined();
  });

  it('anthropic + Sonnet 4.6 + record schema -> marker with route forced_tool (the non-strict forced tool it gets today)', () => {
    expect(
      buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-4-6', recordSchema)),
    ).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'forced_tool', tool: { name: 'testSchema' } });
  });

  it('anthropic + Claude Sonnet 4 (May 2025) -> marker with route forced_tool', () => {
    expect(
      buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-4-20250514', plainSchema)),
    ).toMatchObject({ _agentosUseToolForStructuredOutput: true, route: 'forced_tool', tool: { name: 'testSchema' } });
  });

  it('anthropic + empty modelId (default-model fallback entry) -> routed by the schema: the format, else the forced tool', () => {
    expect(buildResponseFormatForProvider(inputs('anthropic', '', plainSchema))).toMatchObject({
      _agentosUseToolForStructuredOutput: true,
      route: 'json_schema',
    });
    expect(buildResponseFormatForProvider(inputs('anthropic', '', recordSchema))).toMatchObject({
      _agentosUseToolForStructuredOutput: true,
      route: 'forced_tool',
    });
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
    // An Anthropic marker answers by its route; one without a route is the forced tool.
    expect(
      describeResponseFormatShape({ _agentosUseToolForStructuredOutput: true }),
    ).toBe('anthropic_tool');
    expect(
      describeResponseFormatShape({ _agentosUseToolForStructuredOutput: true, route: 'forced_tool' }),
    ).toBe('anthropic_tool');
    expect(
      describeResponseFormatShape({ _agentosUseToolForStructuredOutput: true, route: 'json_schema' }),
    ).toBe('anthropic_json_schema');
    expect(
      describeResponseFormatShape({ _agentosUseToolForStructuredOutput: true, route: 'none' }),
    ).toBe('none');
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

describe('responseFormatCarriesSchema', () => {
  // A payload that carries no schema leaves the schema to the prompt (session.send, the completion gateway).
  it('a strict json_schema, the Anthropic marker (the format or the tool) and Gemini responseSchema carry the schema; no payload and JSON mode do not', () => {
    const carries = (providerId: string, modelId: string, schema: z.ZodTypeAny) =>
      responseFormatCarriesSchema(buildResponseFormatForProvider(inputs(providerId, modelId, schema)));
    expect(carries('openai', 'gpt-4o', plainSchema)).toBe(true);
    expect(carries('anthropic', 'claude-sonnet-4-6', plainSchema)).toBe(true);
    expect(carries('gemini', 'gemini-2.5-pro', plainSchema)).toBe(true);
    expect(carries('openai', 'gpt-4o-mini', recordSchema)).toBe(false);
    expect(carries('openrouter', 'openai/gpt-4o', recordSchema)).toBe(false);
    // Claude Sonnet 5.5 takes the JSON output format for a plain schema; a record is outside it, so no payload carries that one.
    expect(carries('anthropic', 'claude-sonnet-5-5', plainSchema)).toBe(true);
    expect(carries('anthropic', 'claude-sonnet-5-5', recordSchema)).toBe(false);
    expect(carries('ollama', 'llama3', plainSchema)).toBe(false);
  });
});

describe('responseFormatCarriesSchema by an Anthropic marker route', () => {
  it('the JSON output format and the forced tool carry the schema; a none marker and no payload do not', () => {
    const plain = buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-5-5', plainSchema));
    expect(responseFormatCarriesSchema(plain)).toBe(true);
    expect(responseFormatCarriesSchema(buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-4-20250514', plainSchema)))).toBe(true);
    expect(responseFormatCarriesSchema(buildResponseFormatForProvider(inputs('anthropic', 'claude-sonnet-5-5', recordSchema)))).toBe(false);
    expect(responseFormatCarriesSchema({ _agentosUseToolForStructuredOutput: true, route: 'none', tool: { name: 'x', input_schema: {} } })).toBe(false);
  });
});
