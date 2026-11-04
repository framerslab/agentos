/**
 * @file openaiModelFamilies.ts
 * @description Which OpenAI model ids are reasoning models and the context window each family has, moved here unchanged
 * from OpenAIProvider so a caller can read them without loading the provider: the long-context tier of the price table
 * (`openAiHasLongContextPricing` in openaiPricing.ts) is decided by them, and the spend budget and a host's spend guard
 * price a call with that table before it is made. OpenAIProvider imports and re-exports both.
 */

/**
 * Whether `modelId` is an OpenAI reasoning model — the o1/o3/o4 series or the
 * GPT-5 / GPT-6 families. These models reject custom sampling params
 * (`temperature`, `top_p`) with HTTP 400 in addition to requiring
 * `max_completion_tokens`; they run only at their fixed defaults. Single
 * source of truth for the o-series/gpt-5/gpt-6 detection used by both the
 * param guards.
 *
 * GPT-6 live-probed 2026-09-10 (chat.completions, `gpt-6-astra`):
 * `temperature: 0.5` → HTTP 400 `unsupported_value` ("Unsupported value:
 * 'temperature' does not support 0.5 with this model. Only the default (1)
 * value is supported."); `max_tokens: 16` → HTTP 400
 * `unsupported_parameter` ("Unsupported parameter: 'max_tokens' is not
 * supported with this model. Use 'max_completion_tokens' instead."). The
 * family therefore behaves exactly like GPT-5 on both guards.
 *
 * `gpt-6` is matched as a bare family prefix (mirroring `gpt-5`) so dated
 * snapshots of `gpt-6-astra` are covered. It is deliberately NOT generalized
 * to `gpt-\d` — a future family's param contract is unknown, and the
 * conservative default for an unrecognized id is the legacy `max_tokens`
 * path. Widen only for a family that has actually shipped and been probed.
 *
 * @param modelId Provider-side model identifier (e.g. `'o3'`, `'gpt-6-astra'`).
 */
export function isOpenAIReasoningModel(modelId: string): boolean {
  // o1 / o3 / o4 reasoning models, plus the GPT-5 and GPT-6 families.
  return /^(o\d|gpt-5|gpt-6)/i.test(modelId);
}

/**
 * Context-window size for the GPT-5, GPT-6 and o-series reasoning families.
 *
 * From the first-party model pages and GET /v1/models, 2026-09-23 to 29. The
 * family prefix alone does not decide the size: `gpt-5.4` is a 1.05M model
 * while its `-mini` and `-nano` siblings are 400K.
 *
 *   - 1,050,000: the GPT-6 family (`gpt-6.1-sol` included, per the
 *     2026-09-29 changelog), the GPT-5.6 family except `gpt-5.6-cyber`,
 *     `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4` and `gpt-5.4-pro` (max input
 *     922,000 on GPT-6).
 *   - 400,000: `gpt-5.6-cyber`, `gpt-5.4-mini` / `-nano`, `gpt-5.3-codex`,
 *     `gpt-5.2*`, `gpt-5.1*`, `gpt-5`, and `gpt-5-mini` / `-nano` / `-pro`.
 *   - 200,000: the o-series other than `o1-mini` and `o1-preview`.
 *   - 128,000: `o1-mini`, `o1-preview` and the `gpt-5*-chat-latest` snapshots.
 *
 * @param modelId Provider-side model identifier (e.g. `'gpt-6-sol'`).
 * @returns Context window in tokens.
 */
export function openAiReasoningContextWindow(modelId: string): number {
  const id = modelId.toLowerCase();
  if (/^o1-(mini|preview)/.test(id)) return 128000;
  if (/^o\d/.test(id)) return 200000;
  if (/^gpt-5(\.\d+)?-chat-latest$/.test(id)) return 128000;
  if (/^gpt-5\.6-cyber/.test(id)) return 400000;
  if (/^gpt-6/.test(id)) return 1050000;
  if (/^gpt-5\.[56]/.test(id)) return 1050000;
  // gpt-5.4 and gpt-5.4-pro, bare or dated, are 1.05M; -mini and -nano are 400K.
  if (/^gpt-5\.4(-pro)?(-\d{4}-\d{2}-\d{2})?$/.test(id)) return 1050000;
  return 400000;
}
