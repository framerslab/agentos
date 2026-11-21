/**
 * @file openaiModelFamilies.ts
 * @description Which OpenAI model ids are reasoning models and the context window each family has, moved here unchanged
 * from OpenAIProvider so a caller can read them without loading the provider: the long-context tier of the price table
 * (`openAiHasLongContextPricing` in openaiPricing.ts) is decided by them, and the spend budget and a host's spend guard
 * price a call with that table before it is made. OpenAIProvider imports and re-exports both. The rule for which calls
 * OpenAIProvider sends to the Responses API, and the least output cap that API takes, live here for the same reason:
 * the spend budget counts the cap such a call sends (`maxCostRequestOf` in spendBudget.ts).
 */

import type { ModelCompletionOptions } from '../IProvider.js';

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

/**
 * The smallest `max_output_tokens` the Responses API takes: the reference lists `minimum: 16`
 * (https://developers.openai.com/api/reference/resources/responses/methods/create), and a call with 8 answered HTTP 400
 * "Expected a value >= 16, but got 8 instead." on 2026-11-17. The Responses builder raises a smaller cap to it, and a
 * call's spend bound counts the raised cap (`maxCostRequestOf` in spendBudget.ts).
 */
export const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * Whether OpenAI serves `modelId` only through the Responses API. OpenAI lists
 * the `-pro` tiers, the codex models, `gpt-5.6-cyber` and the deep-research
 * models as Responses-only; on /v1/chat/completions they fail (gpt-5.3-codex
 * answers 404). OpenAIProvider sends every call to these ids to /v1/responses
 * (see {@link openAiRequiresResponsesApi}).
 *
 * Only OpenAI's own families (`gpt-`, the o-series, `codex-`) qualify. Groq,
 * xAI, Together and Mistral delegate to OpenAIProvider with their own model ids,
 * and an id such as `grok-4-pro` on one of those endpoints is served by its
 * Chat Completions route.
 *
 * @param modelId Provider-side model identifier.
 * @returns `true` when the model has no Chat Completions endpoint.
 */
export function isOpenAIResponsesOnlyModel(modelId: string): boolean {
  return /^(gpt-|o\d|codex-)/i.test(modelId)
    && /-pro(-\d{4}-\d{2}-\d{2})?$|codex|^gpt-5\.6-cyber|deep-research/i.test(modelId);
}

/**
 * Whether the request carries function tools (present + non-empty). Used to
 * decide whether OpenAIProvider's `openAiRejectsReasoningEffortWithTools` guard
 * applies (reasoning_effort is only incompatible WITH tools) and whether a
 * GPT-5 or GPT-6 call goes to the Responses API ({@link openAiRequiresResponsesApi}).
 *
 * @param tools The request's `tools` option.
 * @returns `true` when the request carries at least one tool.
 */
export function requestHasFunctionTools(tools: unknown): boolean {
  return Array.isArray(tools) ? tools.length > 0 : tools != null;
}

/**
 * Whether a call to `modelId` can be served only by `/v1/responses`:
 *
 *   - any call to a Responses-only model ({@link isOpenAIResponsesOnlyModel});
 *   - a GPT-6 call carrying function tools. Chat Completions does not serve
 *     it: `gpt-6-astra` rejects tool calls there with or without a
 *     `reasoning_effort` (probed 2026-09-10 and 2026-09-30), the `gpt-6.1-sol` model page lists
 *     tool calling on Responses only, and the `gpt-6-sol` / `gpt-6-luna`
 *     pages allow chat tool calls only with `reasoning_effort: 'none'`. A
 *     2026-09-30 probe of a GPT-6 tool call with no `reasoning_effort` on
 *     /v1/chat/completions returned HTTP 400.
 *   - a GPT-5 call carrying function tools, with or without an effort. On
 *     2026-11-18 OpenAI answered ten `gpt-5.6-sol` tool calls on
 *     /v1/chat/completions whose bodies held no `reasoning_effort` key
 *     (`max_completion_tokens`, `messages`, `model`, `stream`,
 *     `stream_options`, `tools`) with HTTP 400 "Function tools with
 *     reasoning_effort are not supported for gpt-5.6-sol in
 *     /v1/chat/completions. To use function tools, use /v1/responses or set
 *     reasoning_effort to 'none'.": the model applies its default effort
 *     (`medium` on the GPT-5.6 and GPT-5.5 model pages,
 *     https://developers.openai.com/api/docs/models/gpt-5.6-sol) when the call
 *     names none (https://developers.openai.com/api/docs/models/gpt-5.5
 *     says the same of `gpt-5.5`). Every GPT-5 model page
 *     (`https://developers.openai.com/api/docs/models/{id}` for each GPT-5 id
 *     at https://developers.openai.com/api/docs/models) lists `v1/responses`
 *     as supported (read 2026-11-21), so the call goes there and keeps its
 *     tools. Sending `reasoning_effort: 'none'` on chat instead is not done:
 *     no probe shows every GPT-5 model accepts it.
 *
 * OpenAIProvider's `shouldRouteToOpenAiResponsesApi` applies this rule to streamed and
 * non-streamed calls alike. A call this rule sends to Responses whose content
 * Responses cannot carry is refused before anything is sent
 * (`RESPONSES_UNMAPPABLE_CONTENT`), since Chat Completions would refuse it too.
 *
 * @param modelId Provider-side model identifier.
 * @param options The request's tools.
 * @returns `true` when the call has no Chat Completions route.
 */
export function openAiRequiresResponsesApi(
  modelId: string,
  options: Pick<ModelCompletionOptions, 'tools'>,
): boolean {
  return (
    isOpenAIResponsesOnlyModel(modelId) ||
    (/^gpt-(5|6)/i.test(modelId) && requestHasFunctionTools(options.tools))
  );
}
