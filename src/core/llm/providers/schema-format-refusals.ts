/**
 * @file schema-format-refusals.ts
 * Anthropic's JSON output format compiles the request's schema into a grammar
 * the model is held to, and answers a schema whose grammar is too large with
 * HTTP 400:
 *
 *   "The compiled grammar is too large, which would cause performance issues.
 *    Simplify your tool schemas or reduce the number of strict tools."
 *
 * The limit is not a count the request builder can check before sending (a
 * schema inside the documented 16 union-typed and 24 optional parameters is
 * refused all the same when its nested objects, enums and string bounds make
 * the grammar large), so the refusal is read from the answer. The providers
 * that send a schema to that format (AnthropicProvider directly, and
 * OpenRouterProvider on a Claude model, whose strict `json_schema` OpenRouter
 * forwards to it) send the request once more without it, and remember the
 * refusal here for the process, keyed by the provider, the model and a hash
 * of the schema, so the next call with the same schema and model takes the
 * route without the format at once instead of paying the refused round trip.
 *
 * @module agentos/core/llm/providers/schema-format-refusals
 */

/** The words of the vendor's refusal, matched without regard to case. */
const GRAMMAR_TOO_LARGE = /compiled grammar is too large/i;

/**
 * Whether an answer is the JSON output format's refusal of a schema whose
 * compiled grammar is too large: HTTP 400 and one of `texts` (the error's
 * message, or its body as text) holding the vendor's words.
 *
 * @param status The answer's HTTP status.
 * @param texts The error message and any other text of the answer to read.
 * @returns `true` only for a 400 that carries the grammar refusal.
 */
export function isSchemaGrammarTooLarge(status: number | undefined, ...texts: unknown[]): boolean {
  if (status !== 400) return false;
  return texts.some((text) => typeof text === 'string' && GRAMMAR_TOO_LARGE.test(text));
}

/** The providers that remember a refused schema. */
export type SchemaFormatRefusalProvider = 'anthropic' | 'openrouter';

/** Most refusals kept; the oldest goes first past it. A process meets a handful of schemas. */
const MAX_REMEMBERED = 1024;

/** `<provider>\u0000<model>\u0000<schema hash>` of every refusal this process has seen, oldest first. */
const refused = new Set<string>();

/** The schema as JSON with every object's keys sorted, so two equal schemas give one text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A 53-bit string hash (cyrb53), as 14 hex digits. */
function hash53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * The hash a refusal is remembered by: two 53-bit hashes of the schema's
 * canonical JSON, with its length. Pure JavaScript, so it runs wherever the
 * providers run.
 *
 * @param schema The lowered JSON schema.
 */
export function schemaHash(schema: unknown): string {
  const text = canonicalJson(schema);
  return `${hash53(text, 0)}${hash53(text, 0x9e3779b9)}${text.length.toString(16)}`;
}

function refusalKey(provider: SchemaFormatRefusalProvider, model: string, schema: unknown): string {
  return `${provider}\u0000${model}\u0000${schemaHash(schema)}`;
}

/**
 * Remembers, for the process, that `model` on `provider` refused `schema` as
 * too large for the JSON output format.
 */
export function rememberSchemaFormatRefusal(
  provider: SchemaFormatRefusalProvider,
  model: string,
  schema: unknown,
): void {
  const key = refusalKey(provider, model, schema);
  refused.delete(key);
  refused.add(key);
  while (refused.size > MAX_REMEMBERED) {
    const oldest = refused.values().next().value;
    if (oldest === undefined) break;
    refused.delete(oldest);
  }
}

/**
 * Whether `model` on `provider` has refused `schema` as too large for the
 * JSON output format earlier in this process.
 */
export function schemaFormatRefused(
  provider: SchemaFormatRefusalProvider,
  model: string,
  schema: unknown,
): boolean {
  return refused.has(refusalKey(provider, model, schema));
}

/**
 * Forgets every remembered refusal.
 * @internal For tests.
 */
export function resetSchemaFormatRefusals(): void {
  refused.clear();
}
