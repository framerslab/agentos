/**
 * @fileoverview Whether a request fits a model's context window, measured the
 * way the fallback walkers check a model before they send it.
 *
 * The input estimate is characters / 4 plus a 10% margin, over the text the
 * request sends: message content (system blocks included), tool-call fields,
 * and tool schemas or the tool text a prompt shim renders; on OpenRouter a
 * `customModelParams.messages` or `.tools` override replaces them, as it does
 * in the payload. Image parts and
 * replayed reasoning fields (Anthropic thinking blocks and signatures, Gemini
 * thought signatures) are not counted. The output allowance is the one the
 * provider will send. A call that enables OpenRouter's context-compression
 * plugin is taken as fitting: OpenRouter trims the prompt to the window.
 *
 * @module api/runtime/contextWindowFit
 */

import { clampMaxOutputTokens } from '../../core/llm/providers/model-output-limits.js';
import { findCatalogTextModel } from '../../core/llm/routing/UncensoredModelCatalog.js';

const CHARS_PER_TOKEN = 4;
const ESTIMATE_MARGIN = 1.1;
/** OpenRouterProvider's `max_tokens` for a call that sets none. */
const OPENROUTER_DEFAULT_MAX_TOKENS = 4096;
/** Keys whose values are not sent to the model as text. */
const UNCOUNTED_KEYS = new Set([
  'role',
  'type',
  'cache_control',
  'thinking',
  'thinkingBlocks',
  'signature',
  'thoughtSignature',
]);

/** The request one model would be sent. */
export interface ContextFitRequest {
  provider: string;
  model: string;
  /** The messages as sent, system messages included. */
  messages?: ReadonlyArray<unknown>;
  /** A system prompt kept apart from `messages`, when the caller has one. */
  system?: unknown;
  prompt?: string;
  /** The tool schemas as sent. */
  tools?: unknown;
  /** The call's `maxTokens` (a fallback hop's, after its overrides). */
  maxTokens?: number;
  customModelParams?: Record<string, unknown>;
}

/** The check's verdict and the numbers behind it. */
export interface ContextFit {
  /**
   * False only when the catalog knows the model's window, the request exceeds
   * it, and the call has not enabled OpenRouter's context compression.
   */
  fits: boolean;
  contextWindow?: number;
  estimatedInputTokens: number;
  outputTokens: number;
}

function textChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textChars(item), 0);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'image_url' || record.type === 'image') return 0;
    let sum = 0;
    for (const [key, item] of Object.entries(record)) {
      if (!UNCOUNTED_KEYS.has(key)) sum += textChars(item);
    }
    return sum;
  }
  return 0;
}

/** The output tokens a provider sends for a call. */
function outputAllowance(
  provider: string,
  model: string,
  maxTokens: number | undefined,
  customModelParams: Record<string, unknown> | undefined,
): number {
  if (provider === 'openrouter') {
    // OpenRouterProvider sends `max_tokens: clamp(model, maxTokens) ?? 4096`
    // and spreads customModelParams after it, so an override wins.
    const override = customModelParams?.max_tokens;
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
    return clampMaxOutputTokens(model, maxTokens) ?? OPENROUTER_DEFAULT_MAX_TOKENS;
  }
  return maxTokens ?? 0;
}

/**
 * Whether the call enables OpenRouter's context-compression plugin, which
 * trims a prompt over the window from the middle until it fits
 * (`plugins: [{ id: 'context-compression' }]`; `enabled: false` turns it off).
 */
function compressesToFit(provider: string, customModelParams: Record<string, unknown> | undefined): boolean {
  if (provider !== 'openrouter') return false;
  const plugins = customModelParams?.plugins;
  if (!Array.isArray(plugins)) return false;
  return plugins.some((plugin: unknown) => {
    if (!plugin || typeof plugin !== 'object') return false;
    const entry = plugin as { id?: unknown; enabled?: unknown };
    return entry.id === 'context-compression' && entry.enabled !== false;
  });
}

/**
 * Whether `request` fits its model's context window. A model the catalog
 * does not list (every direct-provider model) is taken as fitting, and so is
 * a call that enables OpenRouter's context compression.
 */
export function checkContextFit(request: ContextFitRequest): ContextFit {
  // OpenRouterProvider spreads customModelParams over its payload last, so a
  // `messages`, `tools` or `model` override there is what is sent, and the
  // window to fit is the overriding model's. The output allowance stays on
  // the call's own model: the provider clamps `max_tokens` by it before the
  // override applies.
  const overrides = request.provider === 'openrouter' ? request.customModelParams : undefined;
  const sentModel =
    typeof overrides?.model === 'string' && overrides.model.trim() !== '' ? overrides.model : request.model;
  const sentTools = overrides?.tools !== undefined ? overrides.tools : request.tools;
  const messageChars = Array.isArray(overrides?.messages)
    ? textChars(overrides?.messages)
    : textChars(request.messages) + textChars(request.system) + textChars(request.prompt);
  const chars = messageChars + (sentTools === undefined ? 0 : (JSON.stringify(sentTools) ?? '').length);
  const estimatedInputTokens = Math.ceil((chars / CHARS_PER_TOKEN) * ESTIMATE_MARGIN);
  const outputTokens = outputAllowance(request.provider, request.model, request.maxTokens, request.customModelParams);
  const contextWindow = findCatalogTextModel(sentModel, request.provider)?.contextWindow;
  return {
    fits:
      contextWindow === undefined ||
      estimatedInputTokens + outputTokens <= contextWindow ||
      compressesToFit(request.provider, request.customModelParams),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    estimatedInputTokens,
    outputTokens,
  };
}
