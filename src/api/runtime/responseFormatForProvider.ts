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
import { buildResponseFormat } from '../../core/llm/providers/structuredOutputFormat.js';
import { modelSupportsForcedToolChoice } from '../../core/llm/providers/model-forced-tool-choice.js';

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
   * provider default is resolved later) — treated as forced-tool-capable
   * for Anthropic since every default Anthropic text model accepts a forced
   * `tool_choice`; only Fable-class models reject it.
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
 * - `anthropic` — forced `tool_use` marker (gold-standard tier) unless the
 *   model rejects a forced `tool_choice` (Fable) — those degrade to the
 *   prompt-only JSON path.
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
    // Forced tool_use is the gold-standard tier, but Fable rejects a forced
    // tool_choice at the API level — those models degrade to the prompt-only
    // JSON path (schema already rides the system prompt).
    return modelSupportsForcedToolChoice(modelId)
      ? buildResponseFormat({
          provider: providerId,
          schema: effectiveSchema,
          schemaName: schemaName ?? 'response',
        })
      : undefined;
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
 * Compact label for a structured-output payload shape, used by the
 * `fallback_fired` log line (`rebuiltResponseFormatType`) as the live
 * verification signal that per-leg rebuild is active.
 *
 * @returns `'none'` | `'anthropic_tool'` | `'gemini_response_schema'` |
 *   the payload's `type` string (`'json_schema'` / `'json_object'` / …) |
 *   `'unknown'`.
 */
export function describeResponseFormatShape(
  responseFormat: Record<string, unknown> | undefined,
): string {
  if (!responseFormat) return 'none';
  if (responseFormat._agentosUseToolForStructuredOutput) return 'anthropic_tool';
  if (responseFormat._gemini) return 'gemini_response_schema';
  return typeof responseFormat.type === 'string' ? responseFormat.type : 'unknown';
}
