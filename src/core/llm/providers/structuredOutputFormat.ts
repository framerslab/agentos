/**
 * @file structuredOutputFormat.ts
 * @description Provider-specific structured-output payload adapter.
 *
 * Converts a Zod schema + provider id into the per-provider payload shape that
 * agentos plumbs through `GenerateTextOptions._responseFormat` to the
 * underlying `provider.generateCompletion` call. Each provider routes that
 * payload to its native structured-output API surface:
 *
 *   - openai     → response_format: { type: 'json_schema', json_schema: {...} }
 *   - anthropic  → forced tool_use (single tool with input_schema, tool_choice forced)
 *   - gemini     → generationConfig.responseMimeType + responseSchema
 *   - openrouter → degrades to json_object (OpenRouter has no schema enforcement)
 *   - requesty   → degrades to json_object (aggregator; no cross-upstream schema enforcement)
 *
 * @module agentos/core/llm/providers/structuredOutputFormat
 */
import type { ZodType } from 'zod';
import { lowerZodToJsonSchema } from '../../../orchestration/compiler/SchemaLowering.js';

/**
 * Input to {@link buildResponseFormat}.
 */
export interface BuildResponseFormatInput {
  /** Provider id (e.g., 'openai', 'anthropic', 'gemini'). */
  provider: string;
  /** Zod schema describing the desired response shape. */
  schema: ZodType;
  /**
   * Display name for the schema in provider payloads. Surfaces in OpenAI's
   * json_schema.name and Anthropic's tool name. Sanitized to
   * /[a-zA-Z0-9_]/, truncated to 64 chars, falls back to 'response' when
   * empty after sanitization.
   */
  schemaName: string;
}

const SCHEMA_NAME_INVALID_CHARS = /[^a-zA-Z0-9_]/g;
const SCHEMA_NAME_MAX_LEN = 64;

function sanitizeName(name: string): string {
  // Two-pass: replace invalid chars with underscore (preserves boundaries
  // for inputs like "Foo.Bar" → "Foo_Bar"), then collapse the all-invalid
  // case ("!!!" → "___" → "response") via a separate strip-only check.
  // Keeps user-recognizable names while still falling back when nothing
  // useful survives.
  const stripped = name.replace(SCHEMA_NAME_INVALID_CHARS, '');
  if (!stripped) return 'response';
  return name.replace(SCHEMA_NAME_INVALID_CHARS, '_').slice(0, SCHEMA_NAME_MAX_LEN);
}

/**
 * Build a provider-specific structured-output payload from a Zod schema.
 *
 * @param input - Provider id, Zod schema, schema display name.
 * @returns Object suitable for `GenerateTextOptions._responseFormat`. The
 *          per-provider implementation routes the payload to its native
 *          structured-output API surface.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { buildResponseFormat } from '@framers/agentos/core/llm/providers/structuredOutputFormat';
 *
 * const schema = z.object({ verdict: z.enum(['yes', 'no']), confidence: z.number() });
 * const rf = buildResponseFormat({ provider: 'openai', schema, schemaName: 'Verdict' });
 * // → { type: 'json_schema', json_schema: { name: 'Verdict', strict: true, schema: { ... } } }
 * ```
 */
export function buildResponseFormat(
  input: BuildResponseFormatInput,
): Record<string, unknown> {
  const jsonSchema = lowerZodToJsonSchema(input.schema);
  const schemaName = sanitizeName(input.schemaName);

  switch (input.provider) {
    case 'openai':
      return {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      };
    case 'anthropic':
      return {
        _agentosUseToolForStructuredOutput: true,
        tool: { name: schemaName, input_schema: jsonSchema },
      };
    case 'gemini':
    case 'gemini-cli':
      return {
        type: 'json_object',
        _gemini: { responseSchema: jsonSchema },
      };
    case 'openrouter':
    case 'requesty':
    default:
      // OpenRouter, Requesty, and unknown providers: best-effort json_object. The
      // model is asked to return JSON but the schema is not enforced
      // by the provider. Caller-side Zod validation still runs and
      // throws on invalid output rather than retrying.
      return { type: 'json_object' };
  }
}
