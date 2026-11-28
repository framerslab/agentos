/**
 * @module core/llm/providers/openrouter-only-params
 *
 * `customModelParams` is one escape hatch shared by every provider: callers
 * build it once and fallback chains hand the SAME object to whichever
 * provider serves the retry leg. OpenRouter's routing controls are request
 * BODY fields that only OpenRouter's API accepts — spread into another
 * vendor's REST payload they reject the whole call (2026-07-09 production
 * outage: `GeminiProviderError: Unknown name "provider"` after an
 * OpenRouter → Gemini fallback carried `{ provider: { order: ['Groq'] } }`
 * into the native Gemini body).
 *
 * Native providers strip these keys at their payload boundary; the
 * OpenRouterProvider keeps them. Gemini's request fields (`thinkingConfig`,
 * `topK`, `safetySettings`, ...) are the mirror case: GeminiProvider consumes
 * them, and every other provider strips them, so a Gemini call that fails
 * over does not hand them to OpenAI or Anthropic, which reject unknown
 * top-level fields with HTTP 400. The structured-output fields are the same
 * case between OpenAI and Anthropic: OpenAI's `response_format` is not a
 * Messages field, and Anthropic's `output_config` is not a Chat Completions or
 * Responses field, so an OpenAI call that fails over to Claude, or a Claude
 * call that fails over to OpenAI, does not carry the other vendor's field
 * (each leg's own structured output is built for it by its provider). Other
 * vendor-specific extras a caller aims at a native vendor (e.g. Anthropic
 * `metadata`) pass through untouched.
 *
 * Messages request fields: https://platform.claude.com/docs/en/api/messages/create
 * Chat Completions request fields:
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 * generateContent request fields: https://ai.google.dev/api/generate-content
 */

/**
 * OpenRouter request-body routing controls, per its API reference:
 * `provider` (provider-routing preferences), `models` (fallback model list),
 * `route` (`'fallback'`), `transforms` (prompt transforms).
 */
export const OPENROUTER_ONLY_PARAM_KEYS = [
  'provider',
  'models',
  'route',
  'transforms',
] as const;

/**
 * Gemini generateContent request fields, in the camelCase names GeminiProvider
 * accepts through `customModelParams` (it moves `thinkingConfig` and `topK`
 * into `generationConfig`). No other vendor's API defines them.
 */
export const GEMINI_ONLY_PARAM_KEYS = [
  'thinkingConfig',
  'topK',
  'safetySettings',
  'toolConfig',
  'cachedContent',
  'generationConfig',
  'systemInstruction',
  'responseMimeType',
  'responseSchema',
  'responseModalities',
  'speechConfig',
  'mediaResolution',
] as const;

/**
 * OpenAI's structured-output request field. OpenAI-compatible APIs
 * (OpenRouter, Ollama's `/v1`) accept it too; Anthropic's Messages API and
 * Gemini's generateContent do not.
 */
export const OPENAI_FORMAT_PARAM_KEYS = ['response_format'] as const;

/**
 * Anthropic's output configuration (`format`, `effort`), a Messages request
 * field no OpenAI or Gemini request defines.
 */
export const ANTHROPIC_ONLY_PARAM_KEYS = ['output_config'] as const;

/** Keys no native provider other than their own vendor accepts. */
const FOREIGN_VENDOR_PARAM_KEYS: readonly string[] = [
  ...OPENROUTER_ONLY_PARAM_KEYS,
  ...GEMINI_ONLY_PARAM_KEYS,
];

/**
 * A copy of `params` without `keys`. `undefined` in, or nothing surviving the
 * strip, yields `undefined` so callers can keep their existing `if (params)` /
 * spread guards. Never mutates the input — fallback legs reuse the same object.
 */
function withoutKeys(
  params: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  let stripped: Record<string, unknown> | undefined;
  for (const key of Object.keys(params)) {
    if (keys.includes(key)) continue;
    (stripped ??= {})[key] = params[key];
  }
  return stripped;
}

/**
 * A copy of `params` without the OpenRouter-only routing controls, for
 * GeminiProvider (which handles its own Gemini fields).
 */
export function stripOpenRouterOnlyParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return withoutKeys(params, OPENROUTER_ONLY_PARAM_KEYS);
}

/**
 * A copy of `params` without Gemini's request fields, for OpenRouterProvider
 * (which keeps its own routing controls).
 */
export function stripGeminiOnlyParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return withoutKeys(params, GEMINI_ONLY_PARAM_KEYS);
}

/**
 * A copy of `params` without OpenRouter's routing controls and Gemini's
 * request fields, for native providers other than Gemini (OpenAI, Anthropic,
 * Ollama).
 */
export function stripForeignVendorParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return withoutKeys(params, FOREIGN_VENDOR_PARAM_KEYS);
}

/**
 * A copy of `params` for AnthropicProvider: without OpenRouter's routing
 * controls, Gemini's request fields and OpenAI's `response_format`.
 */
export function stripParamsForAnthropic(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return withoutKeys(params, [...FOREIGN_VENDOR_PARAM_KEYS, ...OPENAI_FORMAT_PARAM_KEYS]);
}

/**
 * A copy of `params` for OpenAIProvider: without OpenRouter's routing
 * controls, Gemini's request fields and Anthropic's `output_config`.
 */
export function stripParamsForOpenAI(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return withoutKeys(params, [...FOREIGN_VENDOR_PARAM_KEYS, ...ANTHROPIC_ONLY_PARAM_KEYS]);
}

/**
 * A copy of `params` for GeminiProvider's request root: without OpenRouter's
 * routing controls, OpenAI's `response_format` and Anthropic's
 * `output_config` (GeminiProvider handles its own Gemini fields).
 */
export function stripParamsForGemini(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return withoutKeys(params, [
    ...OPENROUTER_ONLY_PARAM_KEYS,
    ...OPENAI_FORMAT_PARAM_KEYS,
    ...ANTHROPIC_ONLY_PARAM_KEYS,
  ]);
}

/**
 * The passthrough parameters (`customModelParams`) as a provider writes them
 * into its request, for a caller that counts what the request carries:
 *
 *  - `params`: what the provider sends of them, after its own strip above;
 *    undefined when it sends none (the CLI bridges never read
 *    `customModelParams`).
 *  - `atRoot`: whether the provider writes them over its request's top-level
 *    fields, last, so a passthrough `tools` replaces the tools it built and a
 *    passthrough `response_format` replaces its structured-output field.
 *    OpenAI and the providers that send through its request builder (MiniMax,
 *    Groq, Mistral, Together, xAI, LiteLLM), OpenRouter, Requesty, Anthropic
 *    and Gemini do (Anthropic and Gemini strip `response_format` first, and
 *    still send their own structured output); Ollama writes them into its
 *    `options` bag, where they replace nothing of that kind.
 *
 * A provider id outside this list (a host's own provider) is taken to send
 * them whole and to replace nothing, so a count over them never falls short.
 *
 * @param providerId - The provider that serves the request.
 * @param params - The request's `customModelParams`.
 */
export function customModelParamsAsSent(
  providerId: string | undefined,
  params: Record<string, unknown> | undefined,
): { params: Record<string, unknown> | undefined; atRoot: boolean } {
  switch (providerId) {
    case 'openai':
    case 'minimax':
    case 'groq':
    case 'mistral':
    case 'together':
    case 'xai':
    case 'litellm':
      return { params: stripParamsForOpenAI(params), atRoot: true };
    case 'openrouter':
      return { params: stripGeminiOnlyParams(params), atRoot: true };
    case 'requesty':
      return { params, atRoot: true };
    case 'anthropic':
      return { params: stripParamsForAnthropic(params), atRoot: true };
    case 'gemini':
      // `topK` and `thinkingConfig` move into `generationConfig`, still sent.
      return { params: stripParamsForGemini(params), atRoot: true };
    case 'ollama':
      return { params: stripForeignVendorParams(params), atRoot: false };
    case 'claude-code-cli':
    case 'gemini-cli':
      return { params: undefined, atRoot: false };
    default:
      return { params, atRoot: false };
  }
}
