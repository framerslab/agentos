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
 * OpenRouterProvider keeps spreading everything. Vendor-specific extras a
 * caller legitimately aims at a native vendor (e.g. Anthropic `metadata`)
 * pass through untouched.
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
 * A copy of `params` without the OpenRouter-only routing controls.
 * `undefined` in, or nothing surviving the strip, yields `undefined` so
 * callers can keep their existing `if (params)` / spread guards. Never
 * mutates the input — fallback legs reuse the same object.
 */
export function stripOpenRouterOnlyParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  let stripped: Record<string, unknown> | undefined;
  for (const key of Object.keys(params)) {
    if ((OPENROUTER_ONLY_PARAM_KEYS as readonly string[]).includes(key)) continue;
    (stripped ??= {})[key] = params[key];
  }
  return stripped;
}
