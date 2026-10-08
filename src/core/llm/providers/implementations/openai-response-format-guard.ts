/**
 * @file openai-response-format-guard.ts
 * @description Coerce an arbitrary `responseFormat` into one the OpenAI Chat
 * Completions API will accept, or drop it.
 *
 * agentos builds a PROVIDER-SPECIFIC structured-output payload for the PRIMARY
 * provider (see structuredOutputFormat.ts), then `generateText` reuses that
 * same payload across the multi-provider fallback chain. When the primary is
 * Anthropic, the payload is the tool-marker shape
 * `{ _agentosUseToolForStructuredOutput: true, tool: {...} }` (no `type`), and
 * Gemini's is `{ type: 'json_object', _gemini: {...} }`. Forwarding either to
 * OpenAI verbatim makes the API reject the request:
 *   "Missing required parameter: 'response_format.type'."
 *
 * OpenAI's `response_format` accepts exactly three `type` values: `text`,
 * `json_object`, `json_schema`. This guard forwards only those shapes (stripping
 * any foreign markers like `_gemini`) and returns `undefined` for anything else,
 * mirroring how OpenRouterProvider already guards its forward.
 *
 * @module agentos/core/llm/providers/implementations/openai-response-format-guard
 */

/** OpenAI Chat Completions `response_format.type` values. */
const OPENAI_RESPONSE_FORMAT_TYPES = new Set(['text', 'json_object', 'json_schema']);

/**
 * Return an OpenAI-API-valid `response_format`, or `undefined` if the input is
 * not OpenAI-shaped (e.g. an Anthropic tool-marker or a typeless object reused
 * from a different primary provider on a fallback hop).
 *
 * - `json_schema` → forwarded with its `json_schema` payload only.
 * - `text` / `json_object` → forwarded as the bare `{ type }` (drops foreign
 *   markers such as Gemini's `_gemini`).
 * - anything else (no type, unknown type, tool-marker) → `undefined`.
 */
export function toOpenAiResponseFormat(
  responseFormat: unknown,
): Record<string, unknown> | undefined {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined;
  const rf = responseFormat as Record<string, unknown>;
  const type = rf.type;
  if (typeof type !== 'string' || !OPENAI_RESPONSE_FORMAT_TYPES.has(type)) {
    return undefined;
  }
  if (type === 'json_schema') {
    // OpenAI rejects json_schema mode unless json_schema carries a string
    // `name` and an object `schema`. A malformed json_schema reaching the API
    // errors the same way the typeless fallback payload did, so drop it rather
    // than forward something OpenAI can't use.
    const js = rf.json_schema;
    if (
      !js ||
      typeof js !== 'object' ||
      typeof (js as Record<string, unknown>).name !== 'string' ||
      typeof (js as Record<string, unknown>).schema !== 'object' ||
      (js as Record<string, unknown>).schema === null
    ) {
      return undefined;
    }
    return { type, json_schema: js };
  }
  // text | json_object — bare type, stripping any non-OpenAI markers.
  return { type };
}

/**
 * Return the `/v1/responses` form of a `responseFormat` (the value of
 * `text.format`), or `undefined` when {@link toOpenAiResponseFormat} drops it.
 *
 * The same validation applies: the input must be OpenAI-shaped, foreign
 * markers (`_gemini`) are stripped, and Anthropic tool-markers are dropped.
 * The Responses API takes the json_schema fields flat on the format object
 * rather than nested under `json_schema`:
 *
 * - `json_schema` → `{ type: 'json_schema', name, schema, strict?, description? }`.
 * - `text` / `json_object` → the bare `{ type }`.
 *
 * @param responseFormat The caller's `responseFormat`, possibly built for
 *   another provider on a fallback hop.
 * @returns The `text.format` object, or `undefined` to omit it.
 */
export function toOpenAiResponsesTextFormat(
  responseFormat: unknown,
): Record<string, unknown> | undefined {
  const chatFormat = toOpenAiResponseFormat(responseFormat);
  if (!chatFormat) return undefined;
  if (chatFormat.type !== 'json_schema') return { type: chatFormat.type };
  const js = chatFormat.json_schema as Record<string, unknown>;
  return {
    type: 'json_schema',
    name: js.name,
    schema: js.schema,
    ...(typeof js.strict === 'boolean' ? { strict: js.strict } : {}),
    ...(typeof js.description === 'string' ? { description: js.description } : {}),
  };
}
