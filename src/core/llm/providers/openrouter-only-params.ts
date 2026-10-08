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
 * top-level fields with HTTP 400. Vendor-specific extras a caller
 * legitimately aims at a native vendor (e.g. Anthropic `metadata`) pass
 * through untouched.
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
