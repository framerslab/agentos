/**
 * @file streamObject.ts
 * Streaming structured output extraction for the AgentOS high-level API.
 *
 * Wraps {@link streamText} with incremental JSON parsing so callers can
 * observe partial objects as the LLM produces tokens, and each completed
 * element of one array field of the schema, then receive a final
 * Zod-validated result once the stream completes.
 *
 * @see {@link generateObject} for the non-streaming counterpart.
 * @see {@link streamText} for the underlying streaming text primitive.
 */
import type { ZodType, ZodError } from 'zod';

import { streamText } from './streamText.js';
import type { StreamPart, StreamTextResult } from './streamText.js';
import type { Message, TokenUsage } from './generateText.js';
import type { AttemptOutcome } from '../core/llm/providers/IProvider.js';
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
 * The type of one element of the array field `K` of `T`, which
 * {@link StreamObjectResult.elementStream} yields when
 * {@link StreamObjectOptions.elements} names `K`: `never` when `K` names no
 * field of `T` that holds an array (and when no field was named), and
 * `unknown` when `K` is a `string` whose value the type does not know.
 *
 * @typeParam T - The object type the schema infers.
 * @typeParam K - The field name given as `elements`.
 *
 * @example
 * ```ts
 * type Sentence = StreamObjectElement<{ sentences: { text: string }[] }, 'sentences'>;
 * // { text: string }
 * ```
 */
export type StreamObjectElement<T, K extends string> = string extends K
  ? unknown
  : K extends keyof T
    ? NonNullable<T[K]> extends ReadonlyArray<infer E>
      ? E
      : never
    : never;

/**
 * Options for a {@link streamObject} call.
 *
 * Shares the same shape as {@link GenerateObjectOptions} from {@link generateObject}.
 * At minimum, `schema` and either `prompt` or `messages` must be supplied.
 *
 * @typeParam T - The Zod schema type defining the expected output shape.
 * @typeParam K - The array field named by {@link StreamObjectOptions.elements};
 *   a call infers it from the name it passes.
 *
 * @example
 * ```ts
 * const opts: StreamObjectOptions<typeof mySchema> = {
 *   schema: z.object({ name: z.string(), items: z.array(z.string()) }),
 *   prompt: 'List 3 fruits with a person name',
 * };
 * ```
 */
export interface StreamObjectOptions<T extends ZodType, K extends string = string> {
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

  /**
   * The name of one top-level array field of `schema`, whose elements
   * {@link StreamObjectResult.elementStream} yields one at a time as each is
   * completed: an element once the next one begins, and the last one when the
   * stream ends with text that parses. Each is parsed by the array's element
   * schema; an element that fails it is skipped and counted in
   * {@link StreamObjectResult.skipped}. A name that is not a field of the
   * schema holding an array (optional, nullable or with a default included;
   * one behind a transform, a pipe or `z.lazy()` is not) throws a `TypeError`
   * at the call, before any request is sent. A field the schema puts after
   * the array holds the last element back until the stream ends.
   *
   * @example `"sentences"` for `z.object({ sentences: z.array(Sentence) })`
   */
  elements?: K;

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
   * {@link GenerateTextOptions.effort}.
   */
  effort?: string;

  /**
   * Extended-thinking switch forwarded to
   * {@link GenerateTextOptions.thinking}; see
   * {@link GenerateObjectOptions.thinking}.
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
   * {@link GenerateTextOptions.abortSignal}: the provider's stream stops, the
   * partial-object and element iterations end, and `object` rejects with the
   * signal's reason.
   */
  abortSignal?: AbortSignal;

  /**
   * Per-call request timeout in milliseconds, forwarded to
   * {@link GenerateTextOptions.requestTimeout}.
   */
  requestTimeout?: number;

  /**
   * The most requests the stream's call sends, a first and its retries together; the provider's configured count
   * when left out. Forwarded to {@link GenerateTextOptions.maxAttempts}.
   */
  maxAttempts?: number;

  /** Called after each request the stream's call sent, so a caller can settle the attempts it paid for. */
  onAttempt?: (outcome: AttemptOutcome) => void;
}

/**
 * The result object returned immediately by {@link streamObject}.
 *
 * Consumers iterate `partialObjectStream` for incremental partial objects, or
 * `elementStream` for the completed elements of the array field named by
 * {@link StreamObjectOptions.elements}, and `await` the promise properties for
 * the final validated result. Reading either iterable starts the request; the
 * promises settle when the stream ends, or when every iterable that was read
 * stopped before the end.
 *
 * @typeParam T - The inferred type from the Zod schema.
 * @typeParam E - The type of one element `elementStream` yields
 *   ({@link StreamObjectElement}).
 */
export interface StreamObjectResult<T, E = unknown> {
  /**
   * Async iterable yielding partial objects as the LLM builds the JSON
   * response token by token. Each yielded value has the same shape as `T`
   * but with all fields optional ({@link DeepPartial}). The iteration ends
   * without throwing when the stream fails, and `object` then rejects. A
   * reader that starts after `elementStream` began the stream receives the
   * latest partial object first.
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
   * Async iterable yielding each element of the array field named by
   * {@link StreamObjectOptions.elements}, in order, as soon as it is complete:
   * an element once the next one begins, and the last one when the stream
   * ends with text that parses, so a reply cut off at the token limit never
   * yields its unfinished last element. Each is the value the array's element
   * schema parses it to; an element that fails the schema is skipped and
   * counted in {@link StreamObjectResult.skipped}. Without `elements` it
   * yields nothing.
   *
   * When the stream fails, the iteration throws the stream's error after the
   * elements completed before it, so a failed answer never reads as a
   * finished one. When the stream ends with text that does not parse, such
   * as a reply cut off at the token limit, the iteration throws the
   * {@link ObjectGenerationError} `object` rejects with
   * (`Failed to parse streamed JSON: ...`) after the elements completed
   * before the end; an empty reply ends it with nothing yielded, and `object`
   * rejects. A reader that starts after every iterable that was read
   * stopped before the end throws {@link ObjectGenerationError}
   * (`Stream interrupted: ...`) after the elements completed before the stop.
   * When `abortSignal` aborts, the iteration ends.
   *
   * @example
   * ```ts
   * for await (const sentence of result.elementStream) {
   *   console.log(sentence.text);
   * }
   * ```
   */
  elementStream: AsyncIterable<E>;

  /**
   * Resolves to the final Zod-validated object when the stream completes.
   * A rejection that nothing awaits is not reported as an unhandled one.
   *
   * @throws {ObjectGenerationError} When the final JSON fails to parse or
   *   validate, and with the message `Stream interrupted: <message>` when the
   *   stream fails or every reader stops before it ends. When `abortSignal`
   *   aborts, it rejects with the signal's reason instead.
   */
  object: Promise<T>;

  /** Resolves to the raw text when the stream completes. */
  text: Promise<string>;

  /**
   * Resolves to aggregated token usage when the stream completes: zero for
   * whatever the provider never reported.
   */
  usage: Promise<TokenUsage>;

  /**
   * Resolves, when the stream ends, to the usage the provider reported, a
   * report of zero tokens included, or to `undefined` when the stream failed,
   * was aborted or was not read to its end, or ended with no usage reported.
   * A caller never reads usage it never received as zero, as it would from
   * {@link StreamObjectResult.usage}.
   */
  reportedUsage: Promise<TokenUsage | undefined>;

  /**
   * Resolves, when the stream ends, to the number of elements of the
   * {@link StreamObjectOptions.elements} field that failed the element schema
   * and were skipped; 0 without `elements`.
   */
  skipped: Promise<number>;
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
 * Parses the text cut back to just after its last comma, opening brace or
 * opening bracket outside a string, as {@link tryParsePartialJson} parses it.
 *
 * Text that ends inside a member that cannot be closed yet (an object key, a
 * key without its value, a number or literal still being written) does not
 * parse with its open strings and brackets closed, but the members before
 * that one do: when a chunk ends inside the first key of the next element of
 * an array, `[A,B,{"te` is read as `[A,B,{}]`, so `A` and `B` are complete.
 *
 * @param buffer - The accumulated JSON text so far.
 * @returns The parsed value, or `undefined` when the cut text does not parse either.
 */
function tryParseBeforeOpenMember(buffer: string): unknown | undefined {
  let inString = false;
  let escaped = false;
  let cut = 0;
  for (let at = 0; at < buffer.length; at += 1) {
    const ch = buffer[at];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString && (ch === ',' || ch === '{' || ch === '[')) {
      cut = at + 1;
    }
  }
  return cut === 0 ? undefined : tryParsePartialJson(buffer.slice(0, cut));
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

/** A Zod v4 node's `_def`, read defensively, as {@link lowerZodToJsonSchema} reads it. */
function zodDef(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const def = (schema as { _def?: unknown })._def;
  return typeof def === 'object' && def !== null ? (def as Record<string, unknown>) : undefined;
}

/**
 * The Zod wrappers whose inner schema reads the same JSON value: an optional,
 * nullable or default array field is still an array field.
 */
const SAME_VALUE_WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'nonoptional', 'readonly', 'catch']);

/** The schema under a node's {@link SAME_VALUE_WRAPPERS}. */
function unwrapZod(schema: unknown): unknown {
  let node = schema;
  for (;;) {
    const def = zodDef(node);
    const type = def?.type;
    if (def === undefined || typeof type !== 'string' || !SAME_VALUE_WRAPPERS.has(type) || def.innerType === undefined) {
      return node;
    }
    node = def.innerType;
  }
}

/**
 * The element schema of the array field `field` of `schema`, the field
 * {@link StreamObjectOptions.elements} names.
 *
 * @throws {TypeError} When `field` is not the name of a field of the schema that holds an array.
 */
function arrayElementSchema(schema: ZodType, field: unknown): ZodType {
  const objectDef = zodDef(unwrapZod(schema));
  const shape = objectDef?.type === 'object' ? objectDef.shape : undefined;
  const fieldDef =
    typeof field === 'string' &&
    typeof shape === 'object' &&
    shape !== null &&
    Object.prototype.hasOwnProperty.call(shape, field)
      ? zodDef(unwrapZod((shape as Record<string, unknown>)[field]))
      : undefined;
  if (fieldDef?.type !== 'array' || fieldDef.element === undefined) {
    throw new TypeError(`streamObject(): elements names '${String(field)}', which is not an array field of the schema`);
  }
  return fieldDef.element as ZodType;
}

/** `err` as an Error: itself when it is one, otherwise an Error naming it. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * How the whole text of a stream parsed when it ended: the value, or the
 * error `object` rejects with, which `elementStream` throws too.
 */
type FinalParse = { ok: true; value: unknown } | { ok: false; error: ObjectGenerationError };

/**
 * What ended a {@link streamObject} stream: its own end (with the parse of
 * the whole text), a failure, the caller's signal, or every reader stopping
 * before the end.
 */
type StreamEnding =
  | { kind: 'done'; parsed: FinalParse }
  | { kind: 'failed'; error: Error }
  | { kind: 'aborted' }
  | { kind: 'abandoned' };

/** Where the reader of one of the result's iterables is: not started, reading, or stopped before the end. */
type ReaderState = 'unread' | 'reading' | 'stopped';

/** What `Stream interrupted: ` names when every reader stopped before the stream ended. */
const STOPPED_READING = 'reading stopped before the stream ended';

/**
 * Streams a structured object by incrementally parsing JSON as the LLM
 * produces tokens, then validates the final result against a Zod schema.
 *
 * Returns immediately with a {@link StreamObjectResult} containing async
 * iterables and promises. The underlying LLM call begins lazily when a
 * consumer starts iterating `partialObjectStream` or `elementStream`;
 * awaiting a promise alone starts no request.
 *
 * With {@link StreamObjectOptions.elements} naming one array field of the
 * schema, `elementStream` yields each element of that array as soon as it is
 * complete, parsed by the array's element schema.
 *
 * The stream is read through {@link StreamTextResult.fullStream}, so the
 * `error` part that ends a failed stream ends it as cut:
 * `partialObjectStream` ends, `elementStream` throws the failure, `object`
 * rejects with `Stream interrupted: <message>` and `reportedUsage` resolves
 * to `undefined`. When every iterable that was read stops before the stream
 * ends, the request is closed and the result settles the same way.
 *
 * @typeParam T - The Zod schema type. Partial objects are typed as
 *   `DeepPartial<z.infer<T>>`, and the final `object` promise resolves
 *   to `z.infer<T>`.
 * @typeParam K - The field named by `elements`, inferred from the call;
 *   `elementStream` yields `StreamObjectElement<z.infer<T>, K>`.
 *
 * @param opts - Streaming generation options including the Zod schema,
 *   prompt/messages, and optional provider/model overrides.
 * @returns A {@link StreamObjectResult} with `partialObjectStream`,
 *   `elementStream`, `object`, `text`, `usage`, `reportedUsage` and
 *   `skipped` properties.
 * @throws {TypeError} When `elements` names no array field of the schema,
 *   at the call, before any request is sent.
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
 * @example
 * ```ts
 * const answer = streamObject({
 *   provider: 'openai',
 *   schema: z.object({ sentences: z.array(z.object({ text: z.string(), passage: z.number() })) }),
 *   elements: 'sentences',
 *   prompt: 'Answer from the passages, one sentence per claim.',
 * });
 *
 * for await (const sentence of answer.elementStream) {
 *   console.log(sentence.passage, sentence.text); // each sentence once it is complete
 * }
 * console.log(await answer.skipped, await answer.reportedUsage);
 * ```
 *
 * @see {@link generateObject} for non-streaming structured output.
 * @see {@link streamText} for plain text streaming.
 */
export function streamObject<T extends ZodType, K extends string = never>(
  opts: StreamObjectOptions<T, K>
): StreamObjectResult<z.infer<T>, StreamObjectElement<z.infer<T>, K>> {
  type Output = z.infer<T>;
  type Item = StreamObjectElement<Output, K>;

  // A name that is no array field of the schema is the caller's mistake, so it
  // throws here, before anything is set up or sent.
  const elementField: string | undefined = opts.elements;
  const elementSchema = elementField === undefined ? undefined : arrayElementSchema(opts.schema, elementField);

  // Deferred promise resolvers — settled when the stream ends
  let resolveObject!: (v: Output) => void;
  let rejectObject!: (e: unknown) => void;
  let resolveText!: (v: string) => void;
  let resolveUsage!: (v: TokenUsage) => void;
  let resolveReportedUsage!: (v: TokenUsage | undefined) => void;
  let resolveSkipped!: (v: number) => void;

  const objectPromise = new Promise<Output>((res, rej) => {
    resolveObject = res;
    rejectObject = rej;
  });
  // A caller that reads only the iterables never awaits `object`, so its
  // rejection is not reported as an unhandled one; a caller that awaits it
  // still receives the rejection.
  objectPromise.catch(() => undefined);
  const textPromise = new Promise<string>((res) => {
    resolveText = res;
  });
  const usagePromise = new Promise<TokenUsage>((res) => {
    resolveUsage = res;
  });
  const reportedUsagePromise = new Promise<TokenUsage | undefined>((res) => {
    resolveReportedUsage = res;
  });
  const skippedPromise = new Promise<number>((res) => {
    resolveSkipped = res;
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

  // The stream is read once, through streamText's fullStream, for both
  // iterables. Each iterable takes from a queue of its own; a reader that
  // finds its queue empty reads the next part, and both share the read in
  // flight, so the stream moves only as fast as its readers read it.
  let stream: StreamTextResult | undefined;
  let parts: AsyncIterator<StreamPart> | undefined;
  // True while `parts` can still be read: false once it ended, threw or was closed.
  let partsOpen = false;
  // True when reading `parts` threw: that stream's usage then resolves to zero.
  let partsThrew = false;
  // True once streamText counted usage a provider reported. Its summed usage
  // starts at zero, so a report of zero tokens and no report read alike there.
  let usageReported = false;
  let reading: Promise<void> | undefined;
  let ending: StreamEnding | undefined;
  let settled: Promise<void> = Promise.resolve();

  let buffer = '';
  // The last partial object, serialized, so a parse that did not change yields nothing.
  let lastPartialJson = '';
  let latestPartial: DeepPartial<Output> | undefined;
  // How many elements of the array field were yielded or skipped.
  let examined = 0;
  let skippedCount = 0;
  const partials: DeepPartial<Output>[] = [];
  const elements: Item[] = [];
  let partialReader: ReaderState = 'unread';
  let elementReader: ReaderState = 'unread';

  /** The stream's next part, or `undefined` once reading it threw, which ends the stream as failed. */
  async function nextPart(): Promise<IteratorResult<StreamPart> | undefined> {
    try {
      if (!parts) {
        stream = streamText({
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
          ...(opts.requestTimeout !== undefined ? { requestTimeout: opts.requestTimeout } : {}),
          ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
          ...(opts.onAttempt ? { onAttempt: opts.onAttempt } : {}),
          __onUsageReport: () => {
            usageReported = true;
          },
        });
        parts = stream.fullStream[Symbol.asyncIterator]();
        partsOpen = true;
      }
      return await parts.next();
    } catch (err) {
      // streamText reports a failed stream as an `error` part, so a throw here
      // is a failure of the stream itself.
      partsOpen = false;
      partsThrew = true;
      void finish({ kind: 'failed', error: asError(err) });
      return undefined;
    }
  }

  /** Reads one part and acts on it. Never rejects: a failure ends the stream. */
  async function readPart(): Promise<void> {
    if (ending) return;
    const next = await nextPart();
    // Reading failed, or the stream ended while the part was in flight.
    if (next === undefined || ending) return;
    try {
      if (next.done) {
        partsOpen = false;
        onEnd();
      } else {
        onPart(next.value);
      }
    } catch (err) {
      // An element schema that throws as it parses (an async refinement)
      // ends the stream as failed.
      void finish({ kind: 'failed', error: asError(err) });
    }
  }

  /** The read of the next part that every waiting reader shares, started when none is in flight. */
  function advance(): Promise<void> {
    reading ??= readPart().finally(() => {
      reading = undefined;
    });
    return reading;
  }

  /** Acts on one part: text grows the buffer, and an `error` part ends the stream. */
  function onPart(part: StreamPart): void {
    if (part.type === 'error') {
      void finish(opts.abortSignal?.aborted ? { kind: 'aborted' } : { kind: 'failed', error: part.error });
      return;
    }
    // streamObject sends no tools, so text is the only other part it reads.
    if (part.type !== 'text') return;
    // Text that arrives after the caller's signal aborted is not read: the call has ended.
    if (opts.abortSignal?.aborted) {
      void finish({ kind: 'aborted' });
      return;
    }
    buffer += part.text;

    // Attempt incremental parse on each token arrival
    const partial = tryParsePartialJson(buffer);
    if (partial === undefined || typeof partial !== 'object' || partial === null) {
      // The text ends inside a member that cannot be closed yet, such as the
      // first key of the next element: the elements before it are complete,
      // and a stream cut here keeps them.
      if (elementSchema !== undefined) collectElements(tryParseBeforeOpenMember(buffer), false);
      return;
    }
    // Only act when the parsed shape has actually changed
    const serialized = JSON.stringify(partial);
    if (serialized === lastPartialJson) return;
    lastPartialJson = serialized;
    latestPartial = partial as DeepPartial<Output>;
    if (partialReader === 'reading') partials.push(latestPartial);
    // Every element before the last one is complete: the next one has begun.
    collectElements(partial, false);
  }

  /** Acts on the end of the stream: the whole text is parsed, and its last element is complete when it parses. */
  function onEnd(): void {
    // The caller's signal ended the call: the object rejects with the signal's
    // reason rather than with a parse error of the cut-off text.
    if (opts.abortSignal?.aborted) {
      void finish({ kind: 'aborted' });
      return;
    }
    let parsed: FinalParse;
    try {
      parsed = { ok: true, value: extractJson(buffer) };
    } catch (error) {
      parsed = {
        ok: false,
        error: new ObjectGenerationError(`Failed to parse streamed JSON: ${asError(error).message}`, buffer),
      };
    }
    if (parsed.ok) collectElements(parsed.value, true);
    void finish({ kind: 'done', parsed });
  }

  /**
   * Parses each element of the array field in `value` that is complete and
   * not yet examined: every element at the end, every one but the last before it.
   */
  function collectElements(value: unknown, atEnd: boolean): void {
    if (elementSchema === undefined || elementField === undefined) return;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    const list = (value as Record<string, unknown>)[elementField];
    if (!Array.isArray(list)) return;
    const complete = atEnd ? list.length : list.length - 1;
    for (; examined < complete; examined += 1) {
      const checked = elementSchema.safeParse(list[examined]);
      if (!checked.success) skippedCount += 1;
      else if (elementReader !== 'stopped') elements.push(checked.data as Item);
    }
  }

  /** Ends the stream with `end` (the first ending wins) and settles the result. */
  function finish(end: StreamEnding): Promise<void> {
    if (ending === undefined) {
      ending = end;
      settled = settle(end);
    }
    return settled;
  }

  /**
   * Settles the result for `end`. A stream still open is closed first, so
   * streamText's own cleanup runs and settles the usage of what was sent.
   * Never rejects.
   */
  async function settle(end: StreamEnding): Promise<void> {
    resolveSkipped(skippedCount);
    resolveText(buffer);
    try {
      if (end.kind === 'done') {
        settleObject(end.parsed);
      } else {
        rejectObject(
          end.kind === 'aborted'
            ? opts.abortSignal?.reason
            : new ObjectGenerationError(
                `Stream interrupted: ${end.kind === 'failed' ? end.error.message : STOPPED_READING}`,
                buffer
              )
        );
        resolveReportedUsage(undefined);
      }
      if (partsOpen) {
        partsOpen = false;
        await parts?.return?.();
      }
    } catch (err) {
      // A schema that throws as it validates, or a stream whose cleanup threw:
      // the object has no result to give.
      rejectObject(new ObjectGenerationError(`Stream interrupted: ${asError(err).message}`, buffer));
    }
    const usage =
      stream !== undefined && !partsThrew
        ? await stream.usage
        : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    resolveUsage(usage);
    // The provider's report, zeros included, of a stream that ended on its own.
    resolveReportedUsage(end.kind === 'done' && usageReported ? usage : undefined);
  }

  /** Settles `object` from the parse of the whole text: the validated value, or the error that kept it from one. */
  function settleObject(parsed: FinalParse): void {
    if (!parsed.ok) {
      rejectObject(parsed.error);
      return;
    }
    const validation = opts.schema.safeParse(parsed.value) as
      | { success: true; data: Output }
      | { success: false; error: ZodError };

    if (validation.success) {
      resolveObject(validation.data);
    } else {
      rejectObject(
        new ObjectGenerationError(
          `Streamed JSON does not match schema: ${validation.error.message}`,
          buffer,
          validation.error
        )
      );
    }
  }

  /**
   * Records that the reader of one iterable left it before the end. The
   * stream goes on while the other iterable is being read; when neither is,
   * the request is closed and the result settles as interrupted, or as
   * aborted when the caller's signal has aborted.
   */
  function stopReading(reader: 'partial' | 'element'): Promise<void> {
    if (reader === 'partial') {
      partialReader = 'stopped';
      partials.length = 0;
    } else {
      elementReader = 'stopped';
      elements.length = 0;
    }
    if (ending !== undefined || partialReader === 'reading' || elementReader === 'reading') return settled;
    // A reader that stops after the caller's signal aborted (an abort, then a
    // `break`) ends the call as the signal did: `object` rejects with its reason.
    return finish(opts.abortSignal?.aborted ? { kind: 'aborted' } : { kind: 'abandoned' });
  }

  /** The partial objects, taken from the shared stream. */
  async function* readPartials(): AsyncGenerator<DeepPartial<Output>> {
    partialReader = 'reading';
    // A reader that starts once the stream is under way begins with the latest partial object.
    if (latestPartial !== undefined) partials.push(latestPartial);
    let ended = false;
    try {
      while (true) {
        if (partials.length > 0) {
          yield partials.shift()!;
          continue;
        }
        if (ending !== undefined) {
          ended = true;
          return;
        }
        await advance();
      }
    } finally {
      if (!ended) await stopReading('partial');
    }
  }

  /** The completed elements of the array field, taken from the shared stream. */
  async function* readElements(): AsyncGenerator<Item> {
    elementReader = 'reading';
    let ended = false;
    try {
      while (true) {
        if (elements.length > 0) {
          yield elements.shift()!;
          continue;
        }
        if (ending !== undefined) {
          ended = true;
          // A failed answer never reads as a finished one.
          if (ending.kind === 'failed') throw ending.error;
          // Nor does one whose text does not parse at its end, such as a reply
          // the token limit cut off: the iteration throws the error `object`
          // rejects with. An empty reply (whitespace at most, as the parsers
          // read it) yielded nothing, and ends the iteration.
          if (ending.kind === 'done' && !ending.parsed.ok && buffer.trim() !== '') throw ending.parsed.error;
          // Nor does one whose request was closed because every reader
          // stopped before the end: this reader started after them.
          if (ending.kind === 'abandoned') {
            throw new ObjectGenerationError(`Stream interrupted: ${STOPPED_READING}`, buffer);
          }
          return;
        }
        await advance();
      }
    } finally {
      if (!ended) await stopReading('element');
    }
  }

  return {
    partialObjectStream: readPartials(),
    elementStream: readElements(),
    object: objectPromise,
    text: textPromise,
    usage: usagePromise,
    reportedUsage: reportedUsagePromise,
    skipped: skippedPromise,
  };
}

// Re-export the z namespace type for downstream inference
import type { z } from 'zod';
