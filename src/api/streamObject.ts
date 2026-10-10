/**
 * @file streamObject.ts
 * Streaming structured output extraction for the AgentOS high-level API.
 *
 * Wraps {@link streamText} with incremental JSON parsing so callers can
 * observe partial objects as the LLM produces tokens, then receive a final
 * Zod-validated result once the stream completes.
 *
 * @see {@link generateObject} for the non-streaming counterpart.
 * @see {@link streamText} for the underlying streaming text primitive.
 */
import type { ZodType, ZodError } from 'zod';

import { streamText } from './streamText.js';
import type { Message, TokenUsage } from './generateText.js';
import { resolveModelOption } from './model.js';
import { lowerZodToJsonSchema } from '../orchestration/compiler/SchemaLowering.js';
import { ObjectGenerationError } from './generateObject.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Recursively makes every property in `T` optional, including nested objects.
 * Used to type the partial objects yielded by `StreamObjectResult.partialObjectStream`
 * as the LLM incrementally builds the JSON response.
 *
 * @typeParam T - The source type to make deeply partial.
 */
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Options for a {@link streamObject} call.
 *
 * Shares the same shape as {@link GenerateObjectOptions} from {@link generateObject}.
 * At minimum, `schema` and either `prompt` or `messages` must be supplied.
 *
 * @typeParam T - The Zod schema type defining the expected output shape.
 *
 * @example
 * ```ts
 * const opts: StreamObjectOptions<typeof mySchema> = {
 *   schema: z.object({ name: z.string(), items: z.array(z.string()) }),
 *   prompt: 'List 3 fruits with a person name',
 * };
 * ```
 */
export interface StreamObjectOptions<T extends ZodType> {
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
   * Human-readable name for the schema, injected into the system prompt.
   *
   * @example `"ShoppingList"`
   */
  schemaName?: string;

  /**
   * Description of the schema, injected into the system prompt.
   *
   * @example `"A shopping list with a person's name and items."`
   */
  schemaDescription?: string;

  /** User prompt. */
  prompt?: string;

  /** System prompt. Schema instructions are appended automatically. */
  system?: string;

  /** Full conversation history. */
  messages?: Message[];

  /** Sampling temperature forwarded to the provider. */
  temperature?: number;

  /** Hard cap on output tokens. */
  maxTokens?: number;

  /**
   * Reasoning depth forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.effort}.
   */
  effort?: string;

  /**
   * Extended-thinking switch forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.thinking}; see
   * {@link import('./generateObject.js').GenerateObjectOptions.thinking}.
   */
  thinking?: { budgetTokens: number } | false;

  /**
   * Number of retries on validation failure.
   * Unlike {@link generateObject}, streaming retries are not currently supported
   * (the stream is consumed once). This field is accepted for API symmetry but
   * is unused; validation errors on the final object throw immediately.
   *
   * @default 0
   */
  maxRetries?: number;

  /** Override the API key. */
  apiKey?: string;

  /** Override the provider base URL. */
  baseUrl?: string;

  /**
   * Ends the stream when it aborts, forwarded to
   * {@link import('./generateText.js').GenerateTextOptions.abortSignal}: the provider's stream stops, the
   * partial-object iteration ends, and `object` rejects with the signal's reason.
   */
  abortSignal?: AbortSignal;
}

/**
 * The result object returned immediately by {@link streamObject}.
 *
 * Consumers iterate `partialObjectStream` for incremental partial objects,
 * or `await` the promise properties for the final validated result.
 *
 * @typeParam T - The inferred type from the Zod schema.
 */
export interface StreamObjectResult<T> {
  /**
   * Async iterable yielding partial objects as the LLM builds the JSON
   * response token by token. Each yielded value has the same shape as `T`
   * but with all fields optional ({@link DeepPartial}).
   *
   * @example
   * ```ts
   * for await (const partial of result.partialObjectStream) {
   *   console.log('partial:', partial);
   * }
   * ```
   */
  partialObjectStream: AsyncIterable<DeepPartial<T>>;

  /**
   * Resolves to the final Zod-validated object when the stream completes.
   *
   * @throws {ObjectGenerationError} When the final JSON fails validation.
   */
  object: Promise<T>;

  /** Resolves to the raw text when the stream completes. */
  text: Promise<string>;

  /** Resolves to aggregated token usage when the stream completes. */
  usage: Promise<TokenUsage>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the same schema-aware system prompt used by {@link generateObject}.
 *
 * Duplicated here to keep the streaming module self-contained without
 * exporting the helper from generateObject.
 *
 * @param userSystem - Optional user-supplied system prompt to prepend.
 * @param jsonSchema - JSON Schema representation of the Zod schema.
 * @param schemaName - Optional name for the schema.
 * @param schemaDescription - Optional description.
 * @returns The assembled system prompt.
 */
function buildSchemaSystemPrompt(
  userSystem: string | undefined,
  jsonSchema: Record<string, unknown>,
  schemaName?: string,
  schemaDescription?: string
): string {
  const parts: string[] = [];

  if (userSystem) {
    parts.push(userSystem);
    parts.push('');
  }

  parts.push(
    'You MUST respond with ONLY a valid JSON object — no markdown, no code fences, no explanation.'
  );

  if (schemaName) {
    parts.push(`The JSON object should be a "${schemaName}".`);
  }
  if (schemaDescription) {
    parts.push(schemaDescription);
  }

  parts.push('');
  parts.push('The JSON MUST conform to this JSON Schema:');
  parts.push(JSON.stringify(jsonSchema, null, 2));

  return parts.join('\n');
}

/**
 * Attempts to parse a partial JSON string by speculatively adding closing
 * brackets and braces.
 *
 * The LLM streams tokens incrementally, so at any point the buffer may be
 * an incomplete JSON string (e.g. `{"name":"Jo`). This function tries up to
 * 8 closing combinations to produce a parseable partial object.
 *
 * @param buffer - The accumulated JSON text so far.
 * @returns The parsed partial object, or `undefined` if no parse succeeded.
 */
function tryParsePartialJson(buffer: string): unknown | undefined {
  const trimmed = buffer.trim();
  if (!trimmed) return undefined;

  // Fast path: maybe the buffer is already valid JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    // Expected — the buffer is incomplete
  }

  // Strip any leading code fence marker that the model may have started
  let cleaned = trimmed;
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7).trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3).trim();
  }

  // Try progressively adding closing characters.
  // Count open braces/brackets that need closing.
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of cleaned) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if (ch === '}' || ch === ']') closers.pop();
  }

  // If we're inside a string, close it first
  let candidate = cleaned;
  if (inString) {
    candidate += '"';
  }

  // Remove any trailing comma before we add closers (JSON doesn't allow trailing commas)
  candidate = candidate.replace(/,\s*$/, '');

  // Add the necessary closing characters in reverse order
  candidate += closers.reverse().join('');

  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Extracts a JSON object from raw text, handling code fences and brace extraction.
 *
 * @param text - The complete raw text to parse.
 * @returns The parsed value.
 * @throws {SyntaxError} When no valid JSON can be extracted.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    return JSON.parse(fenceMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new SyntaxError(`No valid JSON found in streamed response: ${trimmed.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Streams a structured object by incrementally parsing JSON as the LLM
 * produces tokens, then validates the final result against a Zod schema.
 *
 * Returns immediately with a {@link StreamObjectResult} containing async
 * iterables and promises. The underlying LLM call begins lazily when a
 * consumer starts iterating `partialObjectStream` or awaits a promise.
 *
 * @typeParam T - The Zod schema type. Partial objects are typed as
 *   `DeepPartial<z.infer<T>>`, and the final `object` promise resolves
 *   to `z.infer<T>`.
 *
 * @param opts - Streaming generation options including the Zod schema,
 *   prompt/messages, and optional provider/model overrides.
 * @returns A {@link StreamObjectResult} with `partialObjectStream`, `object`,
 *   `text`, and `usage` properties.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { streamObject } from '@framers/agentos';
 *
 * const result = streamObject({
 *   provider: 'openai',
 *   model: 'gpt-4o',
 *   schema: z.object({ name: z.string(), hobbies: z.array(z.string()) }),
 *   prompt: 'Create a profile for a fictional character.',
 * });
 *
 * for await (const partial of result.partialObjectStream) {
 *   console.log('partial:', partial);
 * }
 *
 * const final = await result.object;
 * console.log('final:', final);
 * ```
 *
 * @see {@link generateObject} for non-streaming structured output.
 * @see {@link streamText} for plain text streaming.
 */
export function streamObject<T extends ZodType>(
  opts: StreamObjectOptions<T>
): StreamObjectResult<z.infer<T>> {
  // Deferred promise resolvers — settled when the stream completes
  let resolveObject: (v: z.infer<T>) => void;
  let rejectObject: (e: Error) => void;
  let resolveText: (v: string) => void;
  let resolveUsage: (v: TokenUsage) => void;

  const objectPromise = new Promise<z.infer<T>>((res, rej) => {
    resolveObject = res;
    rejectObject = rej;
  });
  const textPromise = new Promise<string>((res) => {
    resolveText = res;
  });
  const usagePromise = new Promise<TokenUsage>((res) => {
    resolveUsage = res;
  });

  // Convert the Zod schema to JSON Schema for the system prompt. Streaming
  // has no provider-side structured-output payload: this text is the only
  // schema the model ever sees, so it carries the Zod size checks too.
  const jsonSchema = lowerZodToJsonSchema(opts.schema, { sizeConstraints: true });

  const systemPrompt = buildSchemaSystemPrompt(
    opts.system,
    jsonSchema,
    opts.schemaName,
    opts.schemaDescription
  );

  /**
   * The core async generator that drives the stream. It calls streamText()
   * under the hood and incrementally parses the accumulating JSON buffer,
   * yielding DeepPartial<T> snapshots as they become available.
   */
  async function* runPartialStream(): AsyncGenerator<DeepPartial<z.infer<T>>> {
    // Track the last successfully parsed partial to avoid duplicate yields
    let lastPartialJson = '';
    let buffer = '';

    const stream = streamText({
      provider: opts.provider,
      model: opts.model,
      system: systemPrompt,
      messages: opts.messages,
      prompt: opts.prompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      effort: opts.effort,
      thinking: opts.thinking,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });

    try {
      for await (const chunk of stream.textStream) {
        buffer += chunk;

        // Attempt incremental parse on each token arrival
        const partial = tryParsePartialJson(buffer);
        if (partial !== undefined && typeof partial === 'object' && partial !== null) {
          // Only yield when the parsed shape has actually changed
          const serialized = JSON.stringify(partial);
          if (serialized !== lastPartialJson) {
            lastPartialJson = serialized;
            yield partial as DeepPartial<z.infer<T>>;
          }
        }
      }

      // Stream is complete — resolve the final values
      const finalText = buffer;
      resolveText!(finalText);
      resolveUsage!(await stream.usage);

      // The caller's signal ended the stream: the object rejects with the
      // signal's reason rather than with a parse error of the cut-off text.
      if (opts.abortSignal?.aborted) {
        rejectObject!(opts.abortSignal.reason);
        return;
      }

      // Final parse and validation
      let parsed: unknown;
      try {
        parsed = extractJson(finalText);
      } catch (parseErr) {
        const err = new ObjectGenerationError(
          `Failed to parse streamed JSON: ${(parseErr as Error).message}`,
          finalText
        );
        rejectObject!(err);
        return;
      }

      const validation = opts.schema.safeParse(parsed) as
        | { success: true; data: z.infer<T> }
        | { success: false; error: ZodError };

      if (validation.success) {
        resolveObject!(validation.data);
      } else {
        rejectObject!(
          new ObjectGenerationError(
            `Streamed JSON does not match schema: ${validation.error.message}`,
            finalText,
            validation.error
          )
        );
      }
    } catch (err) {
      // Stream interrupted or errored — resolve promises so awaiting callers unblock
      const error = err instanceof Error ? err : new Error(String(err));
      resolveText!(buffer);
      resolveUsage!({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      rejectObject!(new ObjectGenerationError(`Stream interrupted: ${error.message}`, buffer));
    }
  }

  return {
    partialObjectStream: runPartialStream(),
    object: objectPromise,
    text: textPromise,
    usage: usagePromise,
  };
}

// Re-export the z namespace type for downstream inference
import type { z } from 'zod';
