import { describe, it, expect } from 'vitest';
import {
  toOpenAiResponseFormat,
  toOpenAiResponsesTextFormat,
} from '../implementations/openai-response-format-guard';

/**
 * Regression guard for the multi-provider fallback bug (2026-06-01):
 *
 * `generateObject` builds a PROVIDER-SPECIFIC `responseFormat` for the PRIMARY
 * provider, then `generateText` reuses that same object across the whole
 * fallback chain. When the primary is Anthropic, the object is the tool-marker
 * shape `{ _agentosUseToolForStructuredOutput: true, tool: {...} }` (no `type`).
 * On fallback to OpenAI, the OpenAI provider blindly forwarded it as
 * `response_format`, and OpenAI's API rejected it:
 *   "Missing required parameter: 'response_format.type'".
 *
 * The OpenAI provider must only forward a response_format it actually
 * understands (OpenAI's `text` | `json_object` | `json_schema`), and drop
 * anything else — mirroring how OpenRouterProvider already guards.
 */
describe('toOpenAiResponseFormat', () => {
  it('passes through a valid json_schema response_format', () => {
    const rf = {
      type: 'json_schema',
      json_schema: { name: 'Verdict', strict: true, schema: { type: 'object' } },
    };
    expect(toOpenAiResponseFormat(rf)).toEqual(rf);
  });

  it('DROPS a json_schema missing its required name/schema fields', () => {
    // OpenAI rejects json_schema mode without json_schema.name + .schema.
    // A malformed json_schema reaching OpenAI would error the same way the
    // typeless fallback payload did, so the guard must drop it.
    expect(toOpenAiResponseFormat({ type: 'json_schema' })).toBeUndefined();
    expect(toOpenAiResponseFormat({ type: 'json_schema', json_schema: {} })).toBeUndefined();
    expect(toOpenAiResponseFormat({ type: 'json_schema', json_schema: { name: 'X' } })).toBeUndefined();
    expect(toOpenAiResponseFormat({ type: 'json_schema', json_schema: { schema: { type: 'object' } } })).toBeUndefined();
  });

  it('passes through json_object and text modes', () => {
    expect(toOpenAiResponseFormat({ type: 'json_object' })).toEqual({ type: 'json_object' });
    expect(toOpenAiResponseFormat({ type: 'text' })).toEqual({ type: 'text' });
  });

  it('DROPS the Anthropic tool-marker shape (the fallback bug)', () => {
    const anthropicShape = {
      _agentosUseToolForStructuredOutput: true,
      tool: { name: 'Verdict', input_schema: { type: 'object' } },
    };
    expect(toOpenAiResponseFormat(anthropicShape)).toBeUndefined();
  });

  it('DROPS the Gemini-internal shape carrying a non-OpenAI marker', () => {
    // Gemini's helper returns { type: 'json_object', _gemini: {...} }. The
    // type is OpenAI-valid but the _gemini marker is junk to OpenAI — strip it
    // to a clean json_object rather than forwarding the marker.
    const geminiShape = { type: 'json_object', _gemini: { responseSchema: { type: 'object' } } };
    expect(toOpenAiResponseFormat(geminiShape)).toEqual({ type: 'json_object' });
  });

  it('DROPS an object with no type at all', () => {
    expect(toOpenAiResponseFormat({ foo: 'bar' })).toBeUndefined();
  });

  it('DROPS an unknown/invalid type', () => {
    expect(toOpenAiResponseFormat({ type: 'tool_use' })).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(toOpenAiResponseFormat(undefined)).toBeUndefined();
  });
});

/**
 * The /v1/responses form of the same guard: `text.format` takes the
 * json_schema fields flat on the format object, and anything the chat guard
 * drops is dropped here too.
 */
describe('toOpenAiResponsesTextFormat', () => {
  it('flattens json_schema, keeps bare json_object and text, and drops what the chat guard drops', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    expect(
      toOpenAiResponsesTextFormat({
        type: 'json_schema',
        json_schema: { name: 'Verdict', strict: true, description: 'The verdict.', schema },
      }),
    ).toEqual({ type: 'json_schema', name: 'Verdict', schema, strict: true, description: 'The verdict.' });
    expect(toOpenAiResponsesTextFormat({ type: 'json_schema', json_schema: { name: 'V', schema } })).toEqual({
      type: 'json_schema',
      name: 'V',
      schema,
    });
    expect(toOpenAiResponsesTextFormat({ type: 'json_object', _gemini: { responseSchema: schema } })).toEqual({
      type: 'json_object',
    });
    expect(toOpenAiResponsesTextFormat({ type: 'text' })).toEqual({ type: 'text' });
    expect(
      toOpenAiResponsesTextFormat({ _agentosUseToolForStructuredOutput: true, tool: { name: 'V', input_schema: schema } }),
    ).toBeUndefined();
    expect(toOpenAiResponsesTextFormat({ type: 'json_schema', json_schema: { name: 'V' } })).toBeUndefined();
  });
});
