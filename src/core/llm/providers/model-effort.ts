/**
 * @fileoverview Effort-capability helper for the reasoning Claude models.
 *
 * `output_config.effort` (low|medium|high|xhigh|max) controls reasoning depth
 * and overall token spend. Supported on Fable 5 / Mythos 5, Opus 4.5/4.6/4.7/4.8,
 * Sonnet 5, and Sonnet 4.6 (Sonnet 5 is the first Sonnet tier with `xhigh`);
 * Sonnet 4.5, Haiku 4.5, and older models 400 on it. It is
 * INDEPENDENT of the extended-thinking block and of tool_choice; it rides on
 * `output_config` and is emitted whenever the caller passes an effort level and
 * the model supports it. Kept pure (no provider/SDK import) like
 * `model-thinking.ts` so the unit test imports no provider code.
 */

/** The effort levels Anthropic accepts (Claude Code default for coding is `xhigh`). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Whether the given Claude model id accepts `output_config.effort`.
 *
 * Allow-by-explicit-family: Opus 4.5/4.6/4.7/4.8, Sonnet 5, Sonnet 4.6, and Fable/Mythos 5.
 * Matches both the bare (`claude-opus-4-8`) and provider-prefixed
 * (`anthropic/claude-opus-4-8`) forms, with no `^` anchor.
 *
 * @param modelId Anthropic-side model id.
 */
export function modelSupportsEffort(modelId: string): boolean {
  return /claude-(opus-4-(5|6|7|8)|sonnet-(4-6|5)|fable-5|mythos-5)/i.test(modelId);
}

/** Whether a value is a valid effort level. */
export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * OpenAI reasoning models (o-series, GPT-5 family) take `reasoning_effort`
 * (none|low|medium|high|xhigh) — the OpenAI analogue of Anthropic's
 * `output_config.effort`. This maps the agentos effort scale onto it; `max`
 * clamps to `xhigh`, the GPT-5.x ceiling (there is no higher OpenAI tier).
 * Returns undefined for unknown / empty / non-string values so the request
 * payload omits `reasoning_effort` entirely (the model then runs at its default).
 */
const OPENAI_REASONING_EFFORT: Record<EffortLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};
export function mapEffortToOpenAiReasoningEffort(effort: unknown): string | undefined {
  return isEffortLevel(effort) ? OPENAI_REASONING_EFFORT[effort] : undefined;
}

/**
 * Whether an OpenAI model accepts `reasoning.effort: 'xhigh'` on the
 * `/v1/responses` endpoint. `minimal|low|medium|high` are universal across the
 * GPT-5 family; `xhigh` is NOT — allow-list only the ids a live probe confirms.
 *
 * Live-probed 2026-07-08: `POST /v1/responses {model:'gpt-5.5', tools:[…],
 * reasoning:{effort:'xhigh'}}` → HTTP 200 (status: completed). gpt-5.5 (and its
 * point/`-pro` variants) accept it. Live-probed 2026-07-14: `gpt-5.6` and
 * `gpt-5.6-sol` with `reasoning:{effort:'xhigh'}` → HTTP 200 (status:
 * completed) — the 5.6 family joins the allow-list. Widen further only after
 * probing the new id.
 */
export function modelAcceptsXhighResponsesEffort(modelId: string): boolean {
  return /^gpt-5\.[56]/i.test(modelId);
}

/**
 * Map the agentos effort scale onto OpenAI's `/v1/responses` `reasoning.effort`
 * for `modelId`. Identical to {@link mapEffortToOpenAiReasoningEffort} EXCEPT it
 * caps `xhigh` → `high` for any model NOT on
 * {@link modelAcceptsXhighResponsesEffort} — a model-aware guard so a request
 * for maximum depth degrades one step instead of 400ing the whole Responses
 * call on a model that rejects `xhigh`.
 */
export function mapEffortToOpenAiResponsesEffort(
  modelId: string,
  effort: unknown,
): string | undefined {
  const base = mapEffortToOpenAiReasoningEffort(effort);
  if (base === undefined) return undefined;
  return base === 'xhigh' && !modelAcceptsXhighResponsesEffort(modelId) ? 'high' : base;
}

/**
 * Chat-completions models whose `reasoning_effort` accepts `'max'`.
 * Live-probed per entry — record request shape, status, response summary,
 * date, and the exact model alias in this comment when adding one.
 *
 * 2026-07-20 probe (chat.completions, top-level `reasoning_effort: 'max'`,
 * max_completion_tokens 16): DEFINITIVE REFUSAL on BOTH `gpt-5.6` and
 * `gpt-5.6-sol` — HTTP 400 `invalid_request_error`,
 * `code: 'unsupported_value'`, `param: 'reasoning_effort'`, message
 * enumerating the supported set: `'none', 'low', 'medium', 'high', 'xhigh'`.
 * `xhigh` is therefore the PROVEN hard ceiling for the gpt-5.6 family on
 * Chat Completions (matching the 2026-07-14 xhigh probe above; the model
 * catalog's `max` listing does not apply to this API surface). The list
 * stays empty until a future family probe returns HTTP 200.
 */
const CHAT_MAX_EFFORT_MODELS: readonly string[] = [];

/**
 * Model-aware Chat `reasoning_effort` mapping (spec batch-1 C3): `max`
 * stays `'max'` on probe-verified models, else falls back to the standard
 * mapping (which clamps `max` → `'xhigh'`).
 */
export function mapEffortToOpenAiReasoningEffortForModel(
  effort: unknown,
  modelId: string,
): string | undefined {
  const base = mapEffortToOpenAiReasoningEffort(effort);
  if (
    effort === 'max'
    && base === 'xhigh'
    && CHAT_MAX_EFFORT_MODELS.some((f) => modelId.toLowerCase().startsWith(f))
  ) {
    return 'max';
  }
  return base;
}
