/**
 * @file generateObject.ts
 * Zod-validated structured output extraction for the AgentOS high-level API.
 *
 * Forces the LLM to produce JSON matching a caller-supplied Zod schema.  When
 * the provider supports native JSON mode (`response_format: { type: 'json_object' }`),
 * it is enabled automatically.  On parse or validation failure, the call is
 * retried with error feedback appended to the conversation so the model can
 * self-correct.
 *
 * @see {@link generateText} for the underlying text generation primitive.
 * @see {@link streamObject} for the streaming counterpart.
 */
import { z, type ZodType, type ZodError } from 'zod';

import { generateText } from './generateText.js';
import type { Message, SystemContentBlock, TokenUsage } from './generateText.js';
import { resolveModelOption } from './model.js';
import { lowerZodToJsonSchema } from '../orchestration/compiler/SchemaLowering.js';
import { estimateMaxTokensForZodSchema } from './runtime/schemaTokenEstimate.js';
import { buildResponseFormatForProvider } from './runtime/responseFormatForProvider.js';
import { buildResponseFormat } from '../core/llm/providers/structuredOutputFormat.js';

/**
 * Detect whether a Zod schema's outer type is `ZodArray`. We support
 * both the v4 `_def.type === 'array'` shape and the legacy v3
 * `_def.typeName === 'ZodArray'` shape so callers on either Zod
 * version get transparent array-envelope handling. Walks through any
 * `ZodEffects` / `ZodPipeline` wrappers so refined arrays still
 * trigger the wrap path.
 */
function isTopLevelArraySchema(schema: ZodType): boolean {
  let current: unknown = schema;
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== 'object') return false;
    const def = (current as { _def?: { type?: string; typeName?: string; schema?: unknown; innerType?: unknown } })._def;
    if (!def) return false;
    if (def.type === 'array' || def.typeName === 'ZodArray') return true;
    // Unwrap one level of ZodEffects (refinements / transforms) or
    // ZodPipeline so a `z.array(...).refine(...)` still matches.
    if (def.schema) {
      current = def.schema;
      continue;
    }
    if (def.innerType) {
      current = def.innerType;
      continue;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when structured output generation fails after exhausting all retries.
 *
 * Captures both the raw LLM output and the Zod validation issues so callers
 * can inspect what went wrong and surface useful diagnostics.
 *
 * @example
 * ```ts
 * try {
 *   await generateObject({ schema: mySchema, prompt: '...' });
 * } catch (err) {
 *   if (err instanceof ObjectGenerationError) {
 *     console.error('Raw text:', err.rawText);
 *     console.error('Validation:', err.validationErrors);
 *   }
 * }
 * ```
 */
export class ObjectGenerationError extends Error {
  /** The name of this error class, useful for `instanceof` checks across realms. */
  override readonly name = 'ObjectGenerationError';

  /**
   * @param message - Human-readable summary of the failure.
   * @param rawText - The last raw text the LLM produced before we gave up.
   * @param validationErrors - Zod validation issues from the final attempt.
   */
  constructor(
    message: string,
    /** The raw text returned by the LLM on the final attempt. */
    public readonly rawText: string,
    /** Zod validation error details from the last parse attempt, if available. */
    public readonly validationErrors?: ZodError,
  ) {
    super(message);
    Object.setPrototypeOf(this, ObjectGenerationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for a {@link generateObject} call.
 *
 * At minimum, `schema` and either `prompt` or `messages` must be supplied.
 * Provider/model resolution follows the same rules as {@link generateText}.
 *
 * @typeParam T - The Zod schema type that defines the expected output shape.
 *
 * @example
 * ```ts
 * const opts: GenerateObjectOptions<typeof mySchema> = {
 *   schema: z.object({ name: z.string(), age: z.number() }),
 *   prompt: 'Extract: "John is 30 years old"',
 * };
 * ```
 */
export interface GenerateObjectOptions<T extends ZodType> {
  /**
   * Provider name. When supplied without `model`, the default text model for
   * the provider is resolved automatically.
   *
   * @example `"openai"`, `"anthropic"`, `"ollama"`
   */
  provider?: string;

  /**
   * Model identifier. Prefer the plain model name with `provider` set;
   * the combined `"provider:model"` string is also accepted.
   *
   * @example `"gpt-4o"` (with `provider: 'openai'`), `"gpt-4o-mini"`
   */
  model?: string;

  /** Zod schema defining the expected output shape. */
  schema: T;

  /**
   * Human-readable name for the schema, injected into the system prompt to
   * give the model context about what it is generating.
   *
   * @example `"PersonInfo"`
   */
  schemaName?: string;

  /**
   * Description of the schema, injected into the system prompt alongside
   * the JSON Schema definition.
   *
   * @example `"Information about a person extracted from unstructured text."`
   */
  schemaDescription?: string;

  /** User prompt. Convenience alternative to building a `messages` array. */
  prompt?: string;

  /**
   * System prompt. The schema extraction instructions are appended to this,
   * so any custom system context is preserved.
   *
   * Accepts a plain string (single system message) or an ordered array of
   * {@link SystemContentBlock} entries. When an array is supplied, caller
   * `cacheBreakpoint` flags are preserved on each block and a final
   * non-cached block is appended with the JSON schema + formatting rules.
   * This enables Anthropic prompt caching on the stable prefix while letting
   * the per-call schema vary freely.
   */
  system?: string | SystemContentBlock[];

  /** Full conversation history. */
  messages?: Message[];

  /** Sampling temperature forwarded to the provider (0-2 for most providers). */
  temperature?: number;

  /** Hard cap on output tokens. */
  maxTokens?: number;

  /**
   * Number of times to retry when JSON parsing or Zod validation fails.
   * Each retry appends the error details to the conversation so the model
   * can self-correct.
   *
   * @default 2
   */
  maxRetries?: number;

  /** Override the API key instead of reading from environment variables. */
  apiKey?: string;

  /** Override the provider base URL (useful for local proxies or Ollama). */
  baseUrl?: string;

  /**
   * Ordered fallback providers tried when the primary fails with a retryable
   * error. When undefined, auto-built from env keys. Pass `[]` to disable.
   * @see {@link import('./generateText.js').GenerateTextOptions.fallbackProviders}
   */
  fallbackProviders?: import('./generateText.js').FallbackProviderEntry[];

  /**
   * Called when a fallback provider is about to be tried.
   */
  onFallback?: (error: Error, fallbackProvider: string) => void;

  /**
   * Caller's intended content policy tier. Forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.policyTier}
   * so structured-output callers get the same policy-aware fallback
   * behavior as plain text callers — mature/private-adult requests
   * auto-route refusals to an uncensored OpenRouter model instead of
   * hard-failing on a content_policy_violation.
   *
   * Particularly relevant here because OpenAI's strict structured-
   * output mode (`response_format: json_schema`) is the most
   * aggressively-moderated path on the platform; a NSFW story
   * extraction tagged with `policyTier: 'mature'` will pre-empt the
   * 422 by routing to Hermes 3 (which honors the looser
   * `json_object` mode that {@link generateObject} falls back to for
   * non-OpenAI providers).
   */
  policyTier?: 'safe' | 'standard' | 'mature' | 'private-adult';
  /**
   * Per-call request timeout in milliseconds, forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.requestTimeout}.
   * Structured-output callers that emit long strings (e.g. codegen TSX) raise
   * the abort window for this call without slowing the provider's default
   * failover for chat / narration traffic.
   */
  requestTimeout?: number;

  /**
   * Reasoning-depth / token-spend control, forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.effort}. On
   * effort-capable models the provider emits it as `output_config.effort`
   * (Anthropic) or `reasoning_effort` (OpenAI o-series / GPT-5). Dropped on
   * models that don't support it.
   */
  effort?: string;

  /**
   * Per-call prompt-cache control, forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.cache}.
   * `false` opts this call out of ALL cache marking (the schema block's
   * marker included — right for one-shot extractions); `{ ttl: '1h' }` puts
   * a 1-hour TTL on the provider's auto markers (the moving message-tail).
   */
  cache?: { ttl?: '5m' | '1h' } | false;

  /**
   * TTL for the schema block's own cache marker (the block this call appends
   * after the caller's system). The schema bytes are stable per call SITE, so
   * sites whose calls gap more than 5 minutes (human-paced pipelines, slow
   * loops) should set `'1h'` — otherwise the entry expires between calls and
   * every call re-writes the prefix at the write premium. Defaults to the
   * 5-minute marker (previous behavior). Ignored when `cache` is `false`.
   */
  schemaCacheTtl?: '5m' | '1h';

  /**
   * Per-conversation affinity key, forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.sessionId}.
   * OpenRouter emits it as `session_id` for provider sticky routing —
   * upstream prompt caches are host-scoped, so a load-balanced multi-call
   * pipeline otherwise cold-misses the cache a prior call wrote on a
   * different host. Pass a stable id per logical session (blueprint/build
   * id for codegen loops, conversation id for chat extraction). Providers
   * without an affinity concept ignore the field.
   */
  sessionId?: string;
}

/**
 * The completed result returned by {@link generateObject}.
 *
 * @typeParam T - The inferred type from the Zod schema, representing the validated object.
 */
export interface GenerateObjectResult<T> {
  /** The parsed, Zod-validated object matching the provided schema. */
  object: T;

  /** The raw LLM output text before parsing. */
  text: string;

  /** Aggregated token usage across all attempts (including retries). */
  usage: TokenUsage;

  /**
   * Reason the model stopped generating on the final successful attempt.
   * Mirrors the finish reasons from {@link generateText}.
   */
  finishReason: string;

  /** Provider identifier used for the run. */
  provider: string;

  /** Resolved model identifier used for the run. */
  model: string;

  /**
   * Provider-fallback trail aggregated across all attempts. `fired` is true
   * when any attempt used or tried a non-primary provider — including a
   * fallback on a failed attempt that a later attempt recovered from on the
   * primary. Callers use this to flag a degraded run.
   */
  fallback?: import('./generateText.js').FallbackSignal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the schema-specific instruction text appended to every
 * generateObject call. Kept free of caller context so it can be composed
 * with either a plain string system prompt or a structured block array.
 */
function buildSchemaInstructionText(
  jsonSchema: Record<string, unknown>,
  schemaName?: string,
  schemaDescription?: string,
): string {
  const parts: string[] = [];
  parts.push('You MUST respond with ONLY a valid JSON object — no markdown, no code fences, no explanation.');
  if (schemaName) parts.push(`The JSON object should be a "${schemaName}".`);
  if (schemaDescription) parts.push(schemaDescription);
  parts.push('');
  parts.push('The JSON MUST conform to this JSON Schema:');
  parts.push(JSON.stringify(jsonSchema, null, 2));
  return parts.join('\n');
}

/**
 * Builds the system prompt passed to generateText.
 *
 * - String input: concatenates caller prompt with schema instructions and
 *   returns a single string (legacy behavior).
 * - `SystemContentBlock[]` input: preserves caller blocks and their
 *   `cacheBreakpoint` flags, then appends the schema instructions as a
 *   cached block. Placing `cacheBreakpoint` on the schema block maximizes
 *   the cached prefix length for repeat calls with the same schema, while
 *   the per-call prompt/messages still vary freely.
 */
function buildSchemaSystemPrompt(
  userSystem: string | SystemContentBlock[] | undefined,
  jsonSchema: Record<string, unknown>,
  schemaName?: string,
  schemaDescription?: string,
  schemaCacheTtl?: '5m' | '1h',
): string | SystemContentBlock[] {
  const schemaText = buildSchemaInstructionText(jsonSchema, schemaName, schemaDescription);

  if (Array.isArray(userSystem)) {
    return [
      ...userSystem,
      {
        text: schemaText,
        cacheBreakpoint: true,
        // Per-call-site TTL: schema bytes are stable per site, so sites whose
        // calls gap past the 5m default (human-paced pipelines) pass '1h' to
        // keep the entry alive between calls instead of re-writing it.
        ...(schemaCacheTtl === '1h' ? { cacheTtl: '1h' as const } : {}),
      },
    ];
  }

  // A string (or omitted) system normally takes the legacy joined-string
  // branch below, which carries no cache marker at all — a schemaCacheTtl
  // there would be silently ignored. Honor the option by upgrading to the
  // block emission (opt-in only: callers without schemaCacheTtl keep the
  // exact legacy string shape).
  if (schemaCacheTtl === '1h') {
    return [
      ...(userSystem ? [{ text: userSystem }] : []),
      { text: schemaText, cacheBreakpoint: true, cacheTtl: '1h' as const },
    ];
  }

  const parts: string[] = [];
  if (userSystem) {
    parts.push(userSystem);
    parts.push('');
  }
  parts.push(schemaText);
  return parts.join('\n');
}

/**
 * Attempts to extract a JSON object from raw LLM text.
 *
 * First tries a direct `JSON.parse`. If that fails, looks for JSON inside
 * common markdown code fences (` ```json ... ``` ` or ` ``` ... ``` `).
 * This handles the common case where models wrap JSON in code blocks
 * despite being told not to.
 *
 * @param text - The raw text to parse.
 * @returns The parsed value.
 * @throws {SyntaxError} When no valid JSON can be extracted.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: direct JSON parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to code fence extraction
  }

  // Try extracting from markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Last resort: find the first { and last } to extract a JSON object
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new SyntaxError(`No valid JSON found in LLM response: ${trimmed.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Retry feedback truncation
// ---------------------------------------------------------------------------

const MAX_FEEDBACK_BAD_RESPONSE_CHARS = 500;
const MAX_FEEDBACK_VALIDATION_ISSUES = 5;

/**
 * Ceiling for the truncation-aware budget escalation (see the retry loop).
 * When an attempt stops with `finishReason: 'length'` the output was cut off
 * by the token limit, so the next attempt is retried with `maxTokens` grown by
 * {@link TRUNCATION_ESCALATION_FACTOR} up to this ceiling. The provider layer
 * (`clampMaxOutputTokens`) reshapes it down to each model's real ceiling, so
 * this is a safe upper bound across providers (Sonnet ~64K, Opus 128K).
 */
const TRUNCATION_RETRY_MAX_TOKENS = 64000;
const TRUNCATION_ESCALATION_FACTOR = 1.5;
const TRUNCATION_RETRY_FEEDBACK =
  'Your previous response was cut off before the JSON was complete (the output hit the token limit). ' +
  'The token budget has been increased — respond again with ONLY the complete JSON object, ' +
  'keeping any long string fields as concise as the schema allows.';

/**
 * Truncates a bad LLM response for retry feedback to avoid prompt-token bloat.
 * @internal
 */
function summarizeBadResponse(text: string): string {
  if (text.length <= MAX_FEEDBACK_BAD_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_FEEDBACK_BAD_RESPONSE_CHARS)}... (truncated, ${text.length - MAX_FEEDBACK_BAD_RESPONSE_CHARS} more chars)`;
}

/**
 * Truncates Zod validation errors for retry feedback.
 * @internal
 */
function summarizeZodErrors(error: ZodError): string {
  const issues = error.issues.slice(0, MAX_FEEDBACK_VALIDATION_ISSUES);
  const lines = issues.map(i => `- ${i.path.join('.') || '<root>'}: ${i.message}`);
  if (error.issues.length > MAX_FEEDBACK_VALIDATION_ISSUES) {
    lines.push(`(${error.issues.length - MAX_FEEDBACK_VALIDATION_ISSUES} more issues omitted)`);
  }
  return lines.join('\n');
}

/**
 * Grows the output-token budget after a truncated attempt, capped at
 * {@link TRUNCATION_RETRY_MAX_TOKENS}. The provider layer clamps the result to
 * the target model's real ceiling, so this can never produce a request the
 * model rejects.
 * @internal
 */
function escalateForTruncation(current: number): number {
  return Math.min(TRUNCATION_RETRY_MAX_TOKENS, Math.ceil(current * TRUNCATION_ESCALATION_FACTOR));
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Generates a structured object by forcing the LLM to produce JSON matching
 * a Zod schema.
 *
 * Combines schema-aware prompt engineering with optional provider-native JSON
 * mode and automatic retry-with-feedback to reliably extract typed data from
 * unstructured text.
 *
 * @typeParam T - The Zod schema type. The returned `object` field is inferred
 *   as `z.infer<T>`.
 *
 * @param opts - Generation options including the Zod schema, prompt/messages,
 *   and optional provider/model overrides.
 * @returns A promise resolving to the validated object, raw text, usage, and metadata.
 *
 * @throws {ObjectGenerationError} When all retries are exhausted without
 *   producing valid JSON that passes Zod validation.
 * @throws {Error} When provider resolution fails (missing API key, unknown provider, etc.).
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { generateObject } from '@framers/agentos';
 *
 * const { object } = await generateObject({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   schema: z.object({ name: z.string(), age: z.number() }),
 *   prompt: 'Extract: "John is 30 years old"',
 * });
 *
 * console.log(object.name); // "John"
 * console.log(object.age);  // 30
 * ```
 *
 * @see {@link streamObject} for streaming partial objects as they build up.
 * @see {@link generateText} for plain text generation without schema constraints.
 */
export async function generateObject<T extends ZodType>(
  opts: GenerateObjectOptions<T>,
): Promise<GenerateObjectResult<z.infer<T>>> {
  const maxRetries = opts.maxRetries ?? 2;

  // OpenAI's structured-output mode (both `json_schema` strict and
  // looser `json_object`) REQUIRES the top-level response to be a JSON
  // object — bare arrays are rejected at the API level. When the
  // caller passes a `z.array(...)` schema directly, the model wraps
  // the response in `{ "<schemaName>": [...] }` (using whatever
  // `schemaName` we sent as the envelope key), Zod then rejects with
  // "expected array, received object", retries exhaust, and
  // ObjectGenerationError surfaces. Instead, transparently wrap the
  // array in `z.object({ items: <ArraySchema> })` for the request +
  // validation, then unwrap `result.items` before returning so the
  // caller sees the array shape they asked for. This keeps the
  // public API a thin abstraction over OpenAI's actual constraint.
  const wrapArrayEnvelope = isTopLevelArraySchema(opts.schema);
  const effectiveSchema = wrapArrayEnvelope
    ? z.object({ items: opts.schema as unknown as z.ZodArray<z.ZodTypeAny> })
    : opts.schema;
  const effectiveSchemaName = wrapArrayEnvelope
    ? `${opts.schemaName ?? 'response'}Envelope`
    : opts.schemaName;

  // Convert the Zod schema to JSON Schema for the system prompt.
  // Uses the hand-rolled SchemaLowering converter to avoid extra dependencies.
  const jsonSchema = lowerZodToJsonSchema(effectiveSchema);

  const systemPrompt = buildSchemaSystemPrompt(
    opts.system,
    jsonSchema,
    effectiveSchemaName,
    opts.schemaDescription,
    opts.schemaCacheTtl,
  );

  // Provider-native structured-output payload for the PRIMARY provider —
  // built by the same shared function the fallback legs use, so the
  // (provider, model, schema) -> payload logic lives exactly once. See
  // runtime/responseFormatForProvider.ts for the per-provider behavior
  // (OpenAI strict json_schema gate, Anthropic forced tool + Fable
  // prompt-only degrade, Gemini responseSchema, OpenRouter strict gate,
  // json_object fallbacks).
  const { providerId, modelId } = resolveModelOption(opts, 'text');
  let responseFormat = buildResponseFormatForProvider({
    providerId,
    modelId,
    jsonSchema,
    effectiveSchema,
    schemaName: effectiveSchemaName,
  });
  if (providerId === 'gemini-cli') {
    // gemini-cli primary: keep emitting the legacy Gemini marker so the
    // primary path stays byte-stable this pass. GeminiCLIProvider never
    // reads options.responseFormat (bridge options + text return only), so
    // the marker is dead weight either way — the per-leg builder reports
    // `undefined` honestly; remove this carve-out when the provider grows a
    // responseFormat consumer.
    responseFormat = buildResponseFormat({
      provider: providerId,
      schema: effectiveSchema,
      schemaName: effectiveSchemaName ?? 'response',
    });
  }
  // Per-leg rebuild callback: a fallback hop onto a foreign provider gets a
  // payload shaped for THAT provider instead of the primary's (which the
  // leg provider's guard would silently drop, running the leg with zero
  // provider-side enforcement — the 2026-07-07 gpt-4o-mini freestyle bug).
  const responseFormatBuilder = (
    legProviderId: string,
    legModelId: string,
  ): Record<string, unknown> | undefined =>
    buildResponseFormatForProvider({
      providerId: legProviderId,
      modelId: legModelId,
      jsonSchema,
      effectiveSchema,
      schemaName: effectiveSchemaName,
    });

  // Build the messages array, accumulating retry feedback as needed.
  const messages: Message[] = [];
  if (opts.messages) {
    messages.push(...opts.messages);
  }
  if (opts.prompt) {
    messages.push({ role: 'user', content: opts.prompt });
  }

  // Aggregate usage across all attempts (including retries)
  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastRawText = '';
  let lastValidationError: ZodError | undefined;

  // Auto-size the output budget when the caller didn't specify one. Without
  // this, complex nested schemas reliably truncate at the provider default
  // (256-512 tokens) and JSON.parse fails on the unfinished output. The
  // estimate scales with field count and array nesting depth so simple
  // schemas don't pay for tokens they won't use.
  //
  // `let`, not `const`: a truncated attempt (finishReason 'length') escalates
  // this for the next attempt so a cut-off structured-output call self-heals
  // instead of re-truncating with the same budget (see the retry loop below).
  let currentMaxTokens = opts.maxTokens ?? estimateMaxTokensForZodSchema(opts.schema);

  // Accumulate the provider-fallback signal across every attempt so a fallback
  // that fired on a failed attempt is still reported even when a later attempt
  // recovers on the primary.
  let anyFallbackFired = false;
  const accumulatedFallbackHops: import('./generateText.js').FallbackSignal['hops'] = [];

  // Attempt generation up to 1 + maxRetries times (initial + retries)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await generateText({
      provider: opts.provider,
      model: opts.model,
      system: systemPrompt,
      messages,
      temperature: opts.temperature,
      maxTokens: currentMaxTokens,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fallbackProviders: opts.fallbackProviders,
      onFallback: opts.onFallback,
      // Forward the caller's tier so generateText auto-builds a
      // policy-aware fallback chain on a content_policy_violation
      // from the primary (gpt-4o on the strict-JSON path is the
      // most-moderated route on the platform — single most common
      // structured-output failure mode for mature callers).
      policyTier: opts.policyTier,
      // Forward per-call requestTimeout to the underlying generateText so
      // large-output structured-output callers (codegen TSX) get a longer
      // abort window than the provider default.
      requestTimeout: opts.requestTimeout,
      // Forward reasoning effort so reasoning-capable models (gpt-5.x ->
      // reasoning_effort, effort-capable Claude -> output_config.effort) run at
      // the requested depth instead of their default.
      effort: opts.effort,
      // Forward per-call cache control: `false` = zero cache_control on the
      // wire (one-shot extractions, schema block included); `{ ttl: '1h' }`
      // = 1h TTL on the provider's auto markers (moving message-tail).
      ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
      // Per-conversation affinity key (OpenRouter session_id sticky
      // routing; other providers ignore it).
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      _responseFormat: responseFormat,
      // Fallback legs rebuild the payload for THEIR provider via this
      // callback (see generateText's fallback loop) instead of inheriting
      // the primary-shaped payload verbatim.
      _responseFormatBuilder: responseFormatBuilder,
    });

    // Accumulate token usage across attempts
    totalUsage.promptTokens += result.usage.promptTokens;
    totalUsage.completionTokens += result.usage.completionTokens;
    totalUsage.totalTokens += result.usage.totalTokens;
    if (typeof result.usage.costUSD === 'number') {
      totalUsage.costUSD = (totalUsage.costUSD ?? 0) + result.usage.costUSD;
    }

    // Accumulate the fallback trail across attempts (see anyFallbackFired above).
    if (result.fallback?.fired) anyFallbackFired = true;
    if (result.fallback?.hops?.length) accumulatedFallbackHops.push(...result.fallback.hops);
    // Prompt-cache metrics. generateText propagates these from the
    // provider layer (Anthropic's cache_read_input_tokens /
    // cache_creation_input_tokens); without this accumulation every
    // generateObject caller saw usage.cacheReadTokens as undefined even
    // on hits, blinding cost trackers to prompt-cache savings.
    // Only set the aggregate when the provider actually reported a
    // value — leaving it undefined for OpenAI (whose auto-cache does
    // not surface per-call counters) so callers can distinguish
    // "not reported" from "zero hits".
    if (typeof result.usage.cacheReadTokens === 'number') {
      totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + result.usage.cacheReadTokens;
    }
    if (typeof result.usage.cacheCreationTokens === 'number') {
      totalUsage.cacheCreationTokens =
        (totalUsage.cacheCreationTokens ?? 0) + result.usage.cacheCreationTokens;
    }

    lastRawText = result.text;

    // Step 1: Try to extract JSON from the raw text
    let parsed: unknown;
    try {
      parsed = extractJson(result.text);
    } catch (parseErr) {
      // JSON extraction failed — retry. A truncated attempt (finishReason
      // 'length') is a BUDGET problem, not malformed content: grow the budget
      // instead of telling the model its JSON was invalid (which would mislead
      // it into "fixing" correct-but-cut-off output).
      if (attempt < maxRetries) {
        messages.push({ role: 'assistant', content: summarizeBadResponse(result.text) });
        if (result.finishReason === 'length') {
          currentMaxTokens = escalateForTruncation(currentMaxTokens);
          messages.push({ role: 'user', content: TRUNCATION_RETRY_FEEDBACK });
        } else {
          messages.push({
            role: 'user',
            content: `Your response was not valid JSON. Error: ${(parseErr as Error).message}\n\nPlease respond with ONLY a valid JSON object matching the schema. No markdown, no code fences.`,
          });
        }
        continue;
      }
      throw new ObjectGenerationError(
        `Failed to extract valid JSON after ${maxRetries + 1} attempts${
          result.finishReason === 'length'
            ? ' (output was truncated at the token limit — the schema may need a smaller output or an explicit maxTokens)'
            : ''
        }: ${(parseErr as Error).message}`,
        result.text,
      );
    }

    // Step 2: Validate against the Zod schema
    // Use safeParse to capture structured validation errors for retry feedback
    const validation = effectiveSchema.safeParse(parsed) as
      | { success: true; data: { items: z.infer<T> } | z.infer<T> }
      | { success: false; error: ZodError };

    if (validation.success) {
      // Unwrap the synthetic envelope when we wrapped a top-level
      // array. Caller's contract is `z.infer<T>` so they receive the
      // raw array, not the `{ items: [...] }` envelope used on the
      // wire.
      const object = wrapArrayEnvelope
        ? (validation.data as { items: z.infer<T> }).items
        : (validation.data as z.infer<T>);
      return {
        object,
        text: result.text,
        usage: totalUsage,
        finishReason: result.finishReason,
        provider: result.provider,
        model: result.model,
        fallback: {
          fired: anyFallbackFired,
          finalProvider: result.provider,
          finalModel: result.model,
          hops: accumulatedFallbackHops.length
            ? accumulatedFallbackHops
            : [{ provider: result.provider, model: result.model, ok: true }],
        },
      };
    }

    // Validation failed — record the error and maybe retry
    lastValidationError = validation.error;

    if (attempt < maxRetries) {
      // Append truncated feedback to avoid prompt-token bloat on retries
      messages.push({ role: 'assistant', content: summarizeBadResponse(result.text) });
      if (result.finishReason === 'length') {
        // Parsed but incomplete because the output was cut off mid-object
        // (e.g. a required field never emitted) — grow the budget rather than
        // ask the model to "fix" a schema mismatch it didn't cause.
        currentMaxTokens = escalateForTruncation(currentMaxTokens);
        messages.push({ role: 'user', content: TRUNCATION_RETRY_FEEDBACK });
      } else {
        messages.push({
          role: 'user',
          content: `The JSON you produced does not match the required schema. Validation errors:\n${summarizeZodErrors(validation.error)}\n\nPlease fix the JSON and respond with ONLY a valid JSON object.`,
        });
      }
      continue;
    }
  }

  // All retries exhausted
  throw new ObjectGenerationError(
    `Failed to generate valid structured output after ${maxRetries + 1} attempts.`,
    lastRawText,
    lastValidationError,
  );
}

