/**
 * @file responseFormatForProvider.ts
 * @description The ONE place that maps (providerId, modelId, schema) to the
 * provider-native structured-output payload. generateObject's primary path
 * and generateText's fallback legs both route through here, so a fallback
 * hop onto a foreign provider rebuilds the payload for THAT provider
 * instead of inheriting the primary's shape verbatim — which the OpenAI /
 * OpenRouter provider guards then silently dropped, leaving the leg with
 * the schema in the system prompt only and zero provider-side enforcement.
 *
 * @module agentos/api/runtime/responseFormatForProvider
 */
import type { ZodType } from 'zod';
import {
  canUseStrictJsonSchema,
  buildOpenAIJsonSchemaResponseFormat,
} from './openaiResponseFormat.js';
import {
  buildResponseFormat,
  type AnthropicStructuredOutputMarker,
} from '../../core/llm/providers/structuredOutputFormat.js';

/**
 * Providers whose chat API accepts `response_format: { type: 'json_object' }`
 * as a loose JSON mode. (Moved from generateObject.ts so the provider-branch
 * logic lives exactly once.)
 */
export const JSON_MODE_PROVIDERS = new Set(['openai', 'openrouter']);

/** Inputs for {@link buildResponseFormatForProvider}. */
export interface BuildResponseFormatForProviderInputs {
  /** Provider identifier (e.g. `"openai"`, `"anthropic"`, `"openrouter"`). */
  providerId: string;
  /**
   * Provider-side model id. `''` when a fallback entry omits `model` (the
   * provider default is resolved later): for Anthropic the route is then
   * decided on the schema alone, and the provider decides for its real model
   * on the same object schema (see `anthropicSchemaRoute`).
   */
  modelId: string;
  /** Lowered JSON Schema (`lowerZodToJsonSchema` of `effectiveSchema`). */
  jsonSchema: Record<string, unknown>;
  /** Zod schema, already array-envelope-wrapped where applicable. */
  effectiveSchema: ZodType;
  /** Schema name forwarded into the provider payload. */
  schemaName: string | undefined;
}

/**
 * Build the provider-native structured-output payload for one (provider,
 * model) pair, or `undefined` when the provider has no usable enforcement
 * surface (the schema already rides the system prompt and caller-side Zod
 * validation still runs).
 *
 * Behavior is generateObject's historical provider branch, verbatim:
 * - `openai` — strict `json_schema` when the lowered schema satisfies the
 *   strict validator, else loose `json_object`.
 * - `anthropic` — the structured-output marker with its route: the native
 *   JSON output format on every model that has it (Opus 4.5 and later,
 *   Sonnet 4.5 and later, Haiku 4.5 and later, Fable, Mythos) when the
 *   schema fits its limits; the non-strict forced schema tool on a model
 *   without the format (Claude Opus 4 and Sonnet 4) and for a schema the
 *   format cannot carry (a record, a `$ref`, a `oneOf`, an untyped node, more
 *   union-typed or optional properties than the format takes) on a model that
 *   accepts a forced choice, the empty id included; and `undefined` for such
 *   a schema on a model that refuses a forced choice (Claude Opus 5.5, Sonnet
 *   5.5, Fable, Mythos 5.1), which leaves the schema to the prompt.
 * - `gemini` — native `responseSchema` marker.
 * - `gemini-cli` — `undefined`. GeminiCLIProvider never reads
 *   `options.responseFormat` (bridge options + text return only), so
 *   emitting the Gemini marker there is dead weight; the leg is prompt-only
 *   in practice and this builder says so honestly.
 * - `openrouter` — OpenAI-shaped strict `json_schema` (forwarded upstream
 *   with `require_parameters` routing) when strict-compatible, else
 *   `json_object`.
 * - any other {@link JSON_MODE_PROVIDERS} member — `json_object`.
 * - unknown providers — `undefined`.
 */
export function buildResponseFormatForProvider(
  inputs: BuildResponseFormatForProviderInputs,
): Record<string, unknown> | undefined {
  const { providerId, modelId, jsonSchema, effectiveSchema, schemaName } = inputs;
  if (providerId === 'openai') {
    return canUseStrictJsonSchema(jsonSchema)
      ? buildOpenAIJsonSchemaResponseFormat(jsonSchema, schemaName)
      : { type: 'json_object' as const };
  }
  if (providerId === 'anthropic') {
    // The marker carries one object schema and the route the model takes with
    // it. A route of `none` means neither the JSON output format nor a forced
    // tool carries this schema on this model: no payload, so the schema rides
    // the system prompt (the session and gateway paths write it there, and
    // generateObject writes it there on every provider).
    const marker = buildResponseFormat({
      provider: providerId,
      modelId,
      schema: effectiveSchema,
      schemaName: schemaName ?? 'response',
    }) as unknown as AnthropicStructuredOutputMarker;
    return marker.route === 'none' ? undefined : (marker as unknown as Record<string, unknown>);
  }
  if (providerId === 'gemini') {
    return buildResponseFormat({
      provider: providerId,
      schema: effectiveSchema,
      schemaName: schemaName ?? 'response',
    });
  }
  if (providerId === 'gemini-cli') {
    // GeminiCLIProvider never reads options.responseFormat (bridge options +
    // text return only), so emitting the Gemini marker there is dead weight.
    // The leg is prompt-only in practice; say so honestly.
    return undefined;
  }
  if (providerId === 'openrouter') {
    return canUseStrictJsonSchema(jsonSchema)
      ? buildOpenAIJsonSchemaResponseFormat(jsonSchema, schemaName)
      : { type: 'json_object' as const };
  }
  if (JSON_MODE_PROVIDERS.has(providerId)) {
    return { type: 'json_object' as const };
  }
  // Unknown provider: no provider-native enforcement; the schema already
  // rides the system prompt and caller-side Zod validation still runs.
  return undefined;
}

/**
 * The route an Anthropic marker carries: its `route` field, or `forced_tool`
 * for a marker built without one (a hand-written marker from before the field
 * existed, which the provider sends as the forced tool on a model without
 * JSON outputs).
 */
function anthropicMarkerRoute(responseFormat: Record<string, unknown>): 'json_schema' | 'forced_tool' | 'none' {
  const route = responseFormat.route;
  return route === 'json_schema' || route === 'none' ? route : 'forced_tool';
}

/**
 * Whether a payload from {@link buildResponseFormatForProvider} carries the
 * schema to the model. A strict `json_schema`, an Anthropic marker whose route
 * is the JSON output format or the forced schema tool, and Gemini's
 * `responseSchema` (typed `json_object`, with the schema under `_gemini`) do;
 * no payload, an Anthropic marker whose route is `none`, the loose
 * `json_object` mode and any other shape do not, so the schema has to ride
 * the prompt.
 */
export function responseFormatCarriesSchema(
  responseFormat: Record<string, unknown> | undefined,
): boolean {
  if (!responseFormat) return false;
  if (responseFormat._agentosUseToolForStructuredOutput === true) {
    return anthropicMarkerRoute(responseFormat) !== 'none';
  }
  return responseFormat.type === 'json_schema' || responseFormat._gemini !== undefined;
}

/**
 * Compact label for a structured-output payload shape, used by the
 * `fallback_fired` log line (`rebuiltResponseFormatType`) as the live
 * verification signal that per-leg rebuild is active.
 *
 * @returns `'none'` | `'anthropic_json_schema'` | `'anthropic_tool'` |
 *   `'gemini_response_schema'` | the payload's `type` string (`'json_schema'`
 *   / `'json_object'` / …) | `'unknown'`. An Anthropic marker answers by its
 *   route: `anthropic_json_schema` for the JSON output format,
 *   `anthropic_tool` for the forced tool, `none` when neither is sent.
 */
export function describeResponseFormatShape(
  responseFormat: Record<string, unknown> | undefined,
): string {
  if (!responseFormat) return 'none';
  if (responseFormat._agentosUseToolForStructuredOutput) {
    const route = anthropicMarkerRoute(responseFormat);
    return route === 'json_schema' ? 'anthropic_json_schema' : route === 'forced_tool' ? 'anthropic_tool' : 'none';
  }
  if (responseFormat._gemini) return 'gemini_response_schema';
  return typeof responseFormat.type === 'string' ? responseFormat.type : 'unknown';
}
