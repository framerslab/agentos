// File: backend/agentos/core/llm/providers/implementations/GeminiProvider.ts

/**
 * @fileoverview Implements the IProvider interface for Google's Gemini API.
 *
 * This provider integrates with the Gemini REST API directly (no SDK dependency),
 * handling the structural differences between the Gemini API and the OpenAI-style
 * conventions used by IProvider:
 *
 * Key API differences from OpenAI:
 * - Auth: API key in the `x-goog-api-key` header, never in the URL.
 * - Roles: Gemini uses `user` / `model` (not `assistant`).
 * - System instruction: Separate `systemInstruction` field, not a role.
 * - Tool calling: Uses `functionDeclarations` under `tools[]`, response uses `functionCall`.
 * - Streaming: SSE via `streamGenerateContent?alt=sse` endpoint.
 * - Finish reasons: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION` (uppercase enum strings).
 * - Response shape: `candidates[0].content.parts[0].text` (not `choices[0].message.content`).
 * - Usage: `usageMetadata.promptTokenCount` / `candidatesTokenCount` / `totalTokenCount`.
 *
 * @module backend/agentos/core/llm/providers/implementations/GeminiProvider
 * @implements {IProvider}
 */

import {
  IProvider,
  ChatMessage,
  ModelCompletionOptions,
  ModelCompletionResponse,
  ModelCompletionChoice,
  ModelInfo,
  ModelUsage,
  ProviderEmbeddingOptions,
  ProviderEmbeddingResponse,
} from '../IProvider';
import { stripOpenRouterOnlyParams } from '../openrouter-only-params';
import { redactUrlSecrets } from '../url-secrets';
import { GeminiProviderError } from '../errors/GeminiProviderError';
import { ApiKeyPool } from '../../../providers/ApiKeyPool.js';
import { computeRetryBackoffMs } from './retry-backoff.js';
import { sanitizeGeminiResponseSchema } from './geminiResponseSchema.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the GeminiProvider.
 *
 * @example
 * const config: GeminiProviderConfig = {
 *   apiKey: process.env.GEMINI_API_KEY!,
 *   defaultModelId: 'gemini-2.5-flash',
 * };
 */
export interface GeminiProviderConfig {
  /**
   * Google Gemini API key.
   * Typically sourced from the `GEMINI_API_KEY` environment variable.
   * Sent in the `x-goog-api-key` header, never in the request URL, so it
   * stays out of proxy and access logs.
   */
  apiKey: string;
  /**
   * Base URL for the Gemini API.
   * @default "https://generativelanguage.googleapis.com/v1beta"
   */
  baseURL?: string;
  /**
   * Default model ID when none is specified per-request.
   * @default "gemini-2.5-flash"
   */
  defaultModelId?: string;
  /**
   * Maximum retry attempts for transient failures.
   * @default 3
   */
  maxRetries?: number;
  /**
   * Request timeout in milliseconds.
   * @default 60000
   */
  requestTimeout?: number;
}

// ---------------------------------------------------------------------------
// Gemini API request/response types
// ---------------------------------------------------------------------------

/**
 * A single part within a Gemini content message.
 * Can be text, a function call (from model), or a function response (from user).
 */
interface GeminiPart {
  /** Text content. */
  text?: string;
  /** Function call from the model — contains the function name and parsed arguments. */
  functionCall?: { name: string; args: Record<string, unknown> };
  /** Function response — sent by the caller after executing a tool call. */
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** True on a thought-summary part, which Gemini returns only with `includeThoughts`. */
  thought?: boolean;
  /**
   * Opaque signature Gemini attaches to the first function call of a step.
   * Gemini 3 requires it back, verbatim, on the replayed call.
   */
  thoughtSignature?: string;
  /** An image (or other media) sent inline: its MIME type and base64 bytes. */
  inlineData?: { mimeType: string; data: string };
}

/**
 * The most inline image data one request carries. Gemini caps a request with
 * inline data at 20 MB in all (https://ai.google.dev/gemini-api/docs/image-understanding).
 */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** The value of an ASCII hex digit, or -1. */
function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/** The bytes of a percent-encoded payload: `%XX` is one byte, any other character its UTF-8 bytes. */
function percentDecodeBytes(payload: string): Buffer {
  const text = Buffer.from(payload, 'utf8');
  const out = Buffer.allocUnsafe(text.length);
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const high = text[i] === 0x25 && i + 2 < text.length ? hexValue(text[i + 1]) : -1;
    const low = high >= 0 ? hexValue(text[i + 2]) : -1;
    if (low >= 0) {
      out[length] = high * 16 + low;
      i += 2;
    } else {
      out[length] = text[i];
    }
    length += 1;
  }
  return out.subarray(0, length);
}

/**
 * A data URL as Gemini inline data. Gemini takes images as inline bytes or
 * File API uploads and does not fetch image URLs; this adapter does not fetch
 * them either, since that would reach whatever network the process runs in.
 * So an http(s) image is an error: pass its bytes as a data URL.
 */
function inlineDataOf(url: string): { mimeType: string; data: string } {
  if (/^https?:\/\//i.test(url)) {
    throw new GeminiProviderError(
      'Gemini takes an image as inline data and does not fetch image URLs, nor does this provider: pass the image as a data URL.',
      'IMAGE_URL_NOT_SUPPORTED',
    );
  }
  const match = /^data:([^;,]+)[^,]*?(;base64)?,(.*)$/is.exec(url);
  if (!match) {
    throw new GeminiProviderError('Gemini takes an image as a data URL; this image_url is not one.', 'INVALID_IMAGE_URL');
  }
  const [, mimeType, base64, payload] = match;
  if (base64) return { mimeType, data: payload.replace(/\s+/g, '') };
  return { mimeType, data: percentDecodeBytes(payload).toString('base64') };
}

/** The number of bytes a base64 string decodes to. */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** A single message in the Gemini contents array. */
interface GeminiContent {
  /** Either `user` or `model`. Gemini does not have an `assistant` or `system` role. */
  role: 'user' | 'model';
  /** Message parts (text, function calls, etc.). */
  parts: GeminiPart[];
}

/** System instruction — a top-level field separate from the contents array. */
interface GeminiSystemInstruction {
  parts: Array<{ text: string }>;
}

/**
 * Most requests `models/{model}:batchEmbedContents` accepts in one call. The
 * API returns HTTP 400 "at most 100 requests can be in one batch" above this
 * (probed 2026-09-29 on gemini-embedding-001).
 */
const GEMINI_EMBED_BATCH_LIMIT = 100;

/** Response body of `models/{model}:batchEmbedContents`. */
interface GeminiBatchEmbedResponse {
  embeddings: Array<{ values: number[] }>;
  /** The call's prompt tokens: gemini-embedding-2 reports them, gemini-embedding-001 omits them. */
  usageMetadata?: { promptTokenCount?: number };
}

/**
 * Placeholder signature Google documents for replaying a function call whose
 * real signature is unavailable, such as a call made by another provider in a
 * fallback chain. Gemini 3 returns HTTP 400 for a replayed call with no
 * signature and accepts this value, and Gemini 2.5 accepts it too (probed
 * 2026-09-29).
 */
const GEMINI_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** Generation configuration parameters. */
interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  thinkingConfig?: GeminiThinkingConfig;
}

/**
 * Thinking controls. The 3.x generation takes a `thinkingLevel`; the 2.5
 * family takes a `thinkingBudget` and rejects a level. They nest under
 * `generationConfig`; at the payload root Gemini rejects them.
 */
interface GeminiThinkingConfig {
  /**
   * Gemini 3 thinking depth, such as `'low'` or `'high'`. Gemini 2.5 rejects
   * this field with HTTP 400 "Thinking level is not supported for this model"
   * (probed 2026-09-29).
   */
  thinkingLevel?: string;
  /**
   * Thinking token budget. `-1` hands Gemini dynamic control and a positive
   * value caps the budget. `0` disables thinking where the model allows it:
   * Gemini 2.5 Flash accepts it, and Gemini 3.1 Pro rejects it with HTTP 400
   * "This model only works in thinking mode" (probed 2026-09-29).
   */
  thinkingBudget?: number;
  /**
   * Return thought summaries. They arrive as parts marked `thought: true`,
   * which GeminiProvider keeps out of the answer text.
   */
  includeThoughts?: boolean;
}

type GeminiThinkingLevel = 'low' | 'medium' | 'high';

/**
 * Thinking levels each model accepts, keyed by exact model id and limited to
 * what was verified against the live API (2026-09-30). The set differs per
 * model, not per family: the 3.x image models take `minimal` | `high`, the
 * 2.5 family rejects any level with 400 INVALID_ARGUMENT, and an alias can
 * move to a model with a different set. A model missing here never receives
 * a level, which is always accepted.
 */
const GEMINI_THINKING_LEVELS: Readonly<Record<string, ReadonlySet<GeminiThinkingLevel>>> = {
  'gemini-3.1-pro-preview': new Set<GeminiThinkingLevel>(['low', 'medium', 'high']),
};

/**
 * The thinking level to send for the provider-neutral `effort` on `modelId`,
 * or `undefined` when the API default should stand: no effort, an effort
 * with no Gemini equivalent, or a model that does not take that level.
 */
function geminiThinkingLevelFor(
  modelId: string,
  effort: string | undefined,
): GeminiThinkingLevel | undefined {
  const level: GeminiThinkingLevel | undefined =
    effort === 'low' || effort === 'medium'
      ? effort
      : effort === 'high' || effort === 'xhigh' || effort === 'max'
        ? 'high'
        : undefined;
  if (!level) return undefined;
  return GEMINI_THINKING_LEVELS[modelId]?.has(level) ? level : undefined;
}

/**
 * Pinned model ids and the alias that keeps serving their tier once Google
 * retires them. Preview ids are retired without a redirect (the retired id
 * answers HTTP 404); when a request for a key here fails that way, the
 * provider retries it once on the alias.
 */
const GEMINI_RETIRED_MODEL_ALIAS: Readonly<Record<string, string>> = {
  'gemini-3.1-pro-preview': 'gemini-pro-latest',
};

/** Pinned ids already reported as retired, so the warning prints once each. */
const warnedRetiredGeminiModels = new Set<string>();

/**
 * Long-context price tier: above `abovePromptTokens` prompt tokens the whole
 * request bills at these per-1M rates instead of the catalog's.
 */
const GEMINI_LONG_CONTEXT_PRICING: Readonly<
  Record<string, { abovePromptTokens: number; input: number; output: number }>
> = {
  'gemini-3.1-pro-preview': { abovePromptTokens: 200_000, input: 4.00, output: 18.00 },
  'gemini-pro-latest': { abovePromptTokens: 200_000, input: 4.00, output: 18.00 },
  'gemini-2.5-pro': { abovePromptTokens: 200_000, input: 2.50, output: 15.00 },
};

/** A single function declaration for tool calling. */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** Tool definition wrapper containing function declarations. */
interface GeminiToolDef {
  functionDeclarations: GeminiFunctionDeclaration[];
}

/** Token usage metadata from Gemini responses. */
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /**
   * Tokens the model spent thinking. Separate from `candidatesTokenCount`,
   * included in `totalTokenCount`, and billed at the output rate.
   */
  thoughtsTokenCount?: number;
  /**
   * Prompt tokens served from Gemini's cache (implicit caching is default-on
   * for 2.5+ models; explicit cachedContents count here too). A subset of
   * `promptTokenCount`, never additional to it.
   */
  cachedContentTokenCount?: number;
}

/** A single candidate in the Gemini response. */
interface GeminiCandidate {
  content?: {
    role: 'model';
    parts: GeminiPart[];
  };
  finishReason?: string;
  safetyRatings?: Array<{ category: string; probability: string }>;
}

/** Full response from the Gemini generateContent endpoint. */
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/** Gemini API error envelope returned on non-2xx responses. */
interface GeminiAPIError {
  error: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
}

// ---------------------------------------------------------------------------
// Known model catalog
// ---------------------------------------------------------------------------

/**
 * Static catalog of well-known Gemini models and their metadata.
 *
 * Ids and token limits come from a live GET /v1beta/models probe and rates from
 * ai.google.dev/gemini-api/docs/pricing, both on 2026-09-29. `getModelInfo` is
 * an exact-id lookup over this array, so a model missing here resolves to
 * undefined and its calls carry no context limit and no price.
 *
 * Tiers advance independently. Flash has reached 3.8 while Pro is at
 * 3.1-preview, the only Pro id served. `gemini-3-pro-preview` appears in
 * Google's doc index and is absent from the live listing.
 *
 * Rates are the standard tier. Prompts over 200K tokens on 3.1 Pro and 2.5
 * Pro bill at the tier in GEMINI_LONG_CONTEXT_PRICING, and Gemini 3.6 / 3.7 /
 * 3.8 Flash list at promotional rates through 2026-12-31 and meter at the
 * post-promotion rate.
 */
const GEMINI_MODELS: ModelInfo[] = [
  // --- Pro ---
  {
    modelId: 'gemini-3.1-pro-preview',
    providerId: 'gemini',
    displayName: 'Gemini 3.1 Pro Preview',
    description: 'Top pro-tier Gemini model. Always thinks; thinking tokens bill as output.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    // Prompts up to 200k tokens; see GEMINI_LONG_CONTEXT_PRICING above that.
    pricePer1MTokensInput: 2.00,
    pricePer1MTokensOutput: 12.00,
    supportsStreaming: true,
    status: 'active',
  },

  // --- Flash. 3.6, 3.7 and 3.8 list at $0.75 / $3.75 through 2026-12-31 and
  // $1.50 / $7.50 from 2027-01-01. They meter at $1.50 / $7.50 because the
  // promotion has a published end date: cost rollups stay conservative until
  // then and stay right after it. ---
  {
    modelId: 'gemini-3.8-flash',
    providerId: 'gemini',
    displayName: 'Gemini 3.8 Flash',
    description: 'Newest Flash model. Fast and low-cost, with reasoning and multimodal input.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 1.50,
    pricePer1MTokensOutput: 7.50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-3.7-flash',
    providerId: 'gemini',
    displayName: 'Gemini 3.7 Flash',
    description: 'Flash model with reasoning and multimodal input.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 1.50,
    pricePer1MTokensOutput: 7.50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-3.6-flash',
    providerId: 'gemini',
    displayName: 'Gemini 3.6 Flash',
    description: 'Flash model with reasoning and multimodal input.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 1.50,
    pricePer1MTokensOutput: 7.50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-3.5-flash',
    providerId: 'gemini',
    displayName: 'Gemini 3.5 Flash',
    description: 'Flash model with reasoning and multimodal input, at standard pricing.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 1.50,
    pricePer1MTokensOutput: 9.00,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-3-flash-preview',
    providerId: 'gemini',
    displayName: 'Gemini 3 Flash Preview',
    description: 'First Gemini 3 Flash preview.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 0.50,
    pricePer1MTokensOutput: 3.00,
    supportsStreaming: true,
    status: 'active',
  },

  // --- Flash-Lite ---
  {
    modelId: 'gemini-3.5-flash-lite',
    providerId: 'gemini',
    displayName: 'Gemini 3.5 Flash-Lite',
    description: 'Lowest-cost Gemini 3.5 tier, for high-volume and latency-sensitive work.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 0.30,
    pricePer1MTokensOutput: 2.50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-3.1-flash-lite',
    providerId: 'gemini',
    displayName: 'Gemini 3.1 Flash-Lite',
    description: 'Lowest-cost Gemini 3.1 tier. Google lists a shutdown date of 2027-05-07.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 0.25,
    pricePer1MTokensOutput: 1.50,
    supportsStreaming: true,
    status: 'active',
  },

  // --- Floating aliases. Google can repoint these without changing the id, so
  // a price here can go stale unnoticed. They are listed because an unlisted id
  // resolves to undefined and meters at zero. generateContent reported these
  // targets on 2026-09-29 (response modelVersion): pro-latest to 3.1 Pro,
  // flash-latest to 3.8 Flash, flash-lite-latest to 3.5 Flash-Lite. ---
  {
    modelId: 'gemini-pro-latest',
    providerId: 'gemini',
    displayName: 'Gemini Pro (latest alias)',
    description: 'Alias of the current pro-tier model (gemini-3.1-pro-preview as of 2026-09-30).',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    // Priced as the model the alias resolves to today.
    pricePer1MTokensInput: 2.00,
    pricePer1MTokensOutput: 12.00,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-flash-latest',
    providerId: 'gemini',
    displayName: 'Gemini Flash (latest)',
    description: 'Floating alias for the current Gemini Flash tier.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 1.50,
    pricePer1MTokensOutput: 7.50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-flash-lite-latest',
    providerId: 'gemini',
    displayName: 'Gemini Flash-Lite (latest)',
    description: 'Floating alias for the current Gemini Flash-Lite tier.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 0.30,
    pricePer1MTokensOutput: 2.50,
    supportsStreaming: true,
    status: 'active',
  },

  // --- Gemini 2.5 ---
  {
    modelId: 'gemini-2.5-pro',
    providerId: 'gemini',
    displayName: 'Gemini 2.5 Pro',
    description: 'Previous-generation Pro model.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 1.25,
    pricePer1MTokensOutput: 10.00,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-2.5-flash',
    providerId: 'gemini',
    displayName: 'Gemini 2.5 Flash',
    description: 'Previous-generation Flash model with reasoning and multimodal input.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 0.30,
    pricePer1MTokensOutput: 2.50,
    supportsStreaming: true,
    status: 'active',
  },
  {
    modelId: 'gemini-2.5-flash-lite',
    providerId: 'gemini',
    displayName: 'Gemini 2.5 Flash-Lite',
    description: 'Cheapest Gemini model served.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 65536,
    pricePer1MTokensInput: 0.10,
    pricePer1MTokensOutput: 0.40,
    supportsStreaming: true,
    status: 'active',
  },

  // --- Embeddings. Both ids accept embedContent and batchEmbedContents and
  // return 3072-dimension vectors (probed 2026-09-29). Google's pricing page
  // lists gemini-embedding-2 at $0.20 per 1M text tokens and carries no price
  // for gemini-embedding-001, so that row leaves its price unset: an unset
  // price reads as unknown to a caller, where 0 would read as free. ---
  {
    modelId: 'gemini-embedding-2',
    providerId: 'gemini',
    displayName: 'Gemini Embedding 2',
    description: 'Multimodal embedding model mapping text, images, video, audio and PDFs into one vector space.',
    capabilities: ['embeddings'],
    contextWindowSize: 8192,
    inputTokenLimit: 8192,
    embeddingDimension: 3072,
    pricePer1MTokensInput: 0.20,
    pricePer1MTokensTotal: 0.20,
    supportsStreaming: false,
    status: 'active',
  },
  {
    modelId: 'gemini-embedding-001',
    providerId: 'gemini',
    displayName: 'Gemini Embedding 001',
    description: 'Text embedding model. An index built with it needs it for queries too, since vectors from different embedding models are not comparable.',
    capabilities: ['embeddings'],
    contextWindowSize: 2048,
    inputTokenLimit: 2048,
    embeddingDimension: 3072,
    supportsStreaming: false,
    status: 'active',
  },

  // --- Retired by Google. generateContent returns HTTP 404 for both ids
  // ("This model models/gemini-2.0-flash is no longer available" for 2.0
  // Flash), probed 2026-09-29 with a gemini-2.5-flash-lite control returning
  // 200. The rows stay as `deprecated` so getModelInfo still answers for a
  // caller holding either id. ---
  {
    modelId: 'gemini-2.0-flash',
    providerId: 'gemini',
    displayName: 'Gemini 2.0 Flash (retired)',
    description: 'Retired by Google and no longer served. Google names gemini-3.8-flash as its replacement.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 1048576,
    outputTokenLimit: 8192,
    pricePer1MTokensInput: 0.10,
    pricePer1MTokensOutput: 0.40,
    supportsStreaming: true,
    status: 'deprecated',
  },
  {
    modelId: 'gemini-1.5-pro',
    providerId: 'gemini',
    displayName: 'Gemini 1.5 Pro (retired)',
    description: 'Retired by Google and no longer served. Use gemini-3.1-pro-preview.',
    capabilities: ['chat', 'tool_use', 'vision_input', 'json_mode'],
    contextWindowSize: 2097152,
    outputTokenLimit: 8192,
    pricePer1MTokensInput: 1.25,
    pricePer1MTokensOutput: 5.00,
    supportsStreaming: true,
    status: 'deprecated',
  },
];

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * @class GeminiProvider
 * @implements {IProvider}
 *
 * Provides native integration with Google's Gemini REST API.
 *
 * Handles the structural differences between Gemini's API and the OpenAI-style
 * conventions used by IProvider: role mapping (`assistant` -> `model`), system
 * instruction extraction, tool schema translation, and finish reason normalization.
 *
 * @example
 * const provider = new GeminiProvider();
 * await provider.initialize({ apiKey: 'AIzaSy...' });
 * const response = await provider.generateCompletion(
 *   'gemini-2.5-flash',
 *   [{ role: 'user', content: 'Hello!' }],
 *   { maxTokens: 1024 },
 * );
 */
export class GeminiProvider implements IProvider {
  /** @inheritdoc */
  public readonly providerId: string = 'gemini';
  /** @inheritdoc */
  public isInitialized: boolean = false;
  /** @inheritdoc */
  public defaultModelId?: string;

  private config!: GeminiProviderConfig;
  private keyPool: ApiKeyPool | null = null;

  constructor() {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the Gemini provider with the given configuration.
   *
   * Validates that an API key is present. Does NOT make a network call on
   * startup — Gemini does not have a lightweight health/models endpoint
   * that works without model-scoped paths.
   *
   * @param {GeminiProviderConfig} config - Provider configuration.
   * @returns {Promise<void>}
   * @throws {GeminiProviderError} If the API key is missing.
   */
  public async initialize(config: GeminiProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new GeminiProviderError(
        'API key is required for GeminiProvider initialization. Set GEMINI_API_KEY.',
        'INIT_FAILED_MISSING_API_KEY',
      );
    }

    this.config = {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      maxRetries: 3,
      requestTimeout: 60000,
      defaultModelId: 'gemini-2.5-flash',
      ...config,
    };
    this.keyPool = new ApiKeyPool(config.apiKey);
    this.defaultModelId = this.config.defaultModelId;
    this.isInitialized = true;

    console.log(
      `GeminiProvider initialized. Default model: ${this.defaultModelId || 'Not set'}.`,
    );
  }

  // -------------------------------------------------------------------------
  // Chat completions (non-streaming)
  // -------------------------------------------------------------------------

  /**
   * Generates a non-streaming chat completion via Gemini's generateContent endpoint.
   *
   * Extracts system messages and places them in the `systemInstruction` field,
   * maps `assistant` role to `model`, converts tool definitions to Gemini's
   * `functionDeclarations` format, and normalizes the response back to
   * IProvider conventions.
   *
   * @param {string} modelId - The Gemini model to use (e.g., "gemini-2.5-flash").
   * @param {ChatMessage[]} messages - Conversation messages. System-role messages are
   *   extracted and sent as the `systemInstruction` field.
   * @param {ModelCompletionOptions} options - Completion options.
   * @returns {Promise<ModelCompletionResponse>} A normalized completion response.
   * @throws {GeminiProviderError} On authentication, validation, or network errors.
   *
   * @example
   * const resp = await provider.generateCompletion('gemini-2.5-flash', [
   *   { role: 'system', content: 'You are a helpful assistant.' },
   *   { role: 'user', content: 'Explain quantum computing in one sentence.' },
   * ], { maxTokens: 256 });
   * console.log(resp.choices[0].message.content);
   */
  public async generateCompletion(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Promise<ModelCompletionResponse> {
    this.ensureInitialized();

    const payload = this.buildRequestPayload(modelId, messages, options);
    // Gemini uses model-scoped endpoints: /models/{model}:generateContent
    const endpoint = `/models/${modelId}:generateContent`;
    let apiResponse: GeminiResponse;
    try {
      apiResponse = await this.makeApiRequest<GeminiResponse>(endpoint, payload, options.requestTimeout, options.abortSignal);
    } catch (error: unknown) {
      // A retired pinned id: serve the call from its alias, whose response
      // reports the alias as the model that answered.
      const alias = this.retiredModelAlias(modelId, error);
      if (!alias) throw error;
      return this.generateCompletion(alias, messages, options);
    }

    return this.mapResponseToCompletion(apiResponse, modelId);
  }

  /**
   * The alias to retry on when a request for `modelId` failed because the id
   * is gone: HTTP 404 on an id listed in {@link GEMINI_RETIRED_MODEL_ALIAS}.
   * `undefined` for every other error and every other id, which propagate.
   * Warns once per retired id.
   */
  private retiredModelAlias(modelId: string, error: unknown): string | undefined {
    if (!(error instanceof GeminiProviderError) || error.httpStatus !== 404) return undefined;
    const alias = GEMINI_RETIRED_MODEL_ALIAS[modelId];
    if (!alias) return undefined;
    if (!warnedRetiredGeminiModels.has(modelId)) {
      warnedRetiredGeminiModels.add(modelId);
      console.warn(
        `[GeminiProvider] ${modelId} answered 404 (retired, or not available to this key); ` +
          `serving ${alias} instead. Update the pin.`,
      );
    }
    return alias;
  }

  // -------------------------------------------------------------------------
  // Chat completions (streaming)
  // -------------------------------------------------------------------------

  /**
   * Generates a streaming chat completion via Gemini's streamGenerateContent endpoint.
   *
   * Gemini streaming uses SSE with `alt=sse` query parameter. Each SSE data line
   * contains a JSON object with `candidates[].content.parts[].text` for text deltas
   * and `candidates[].content.parts[].functionCall` for tool invocations.
   *
   * Normalizes all events into the IProvider streaming contract with
   * `responseTextDelta`, `toolCallsDeltas`, and `isFinal`.
   *
   * @param {string} modelId - The Gemini model to use.
   * @param {ChatMessage[]} messages - Conversation messages.
   * @param {ModelCompletionOptions} options - Completion options.
   * @returns {AsyncGenerator<ModelCompletionResponse>} Incremental response chunks.
   * @throws {GeminiProviderError} On connection or stream errors.
   */
  public async *generateCompletionStream(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): AsyncGenerator<ModelCompletionResponse, void, undefined> {
    this.ensureInitialized();

    const payload = this.buildRequestPayload(modelId, messages, options);
    const responseId = `gemini-${modelId}-${Date.now()}`;

    // Handle pre-aborted signals
    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      yield this.buildAbortChunk(modelId);
      return;
    }

    // Streaming endpoint uses ?alt=sse and the API key query param
    const endpoint = `/models/${modelId}:streamGenerateContent`;
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.makeStreamRequest(endpoint, payload, options.requestTimeout);
    } catch (error: unknown) {
      // A retired pinned id fails here, before any chunk: serve the whole
      // stream from its alias (its chunks carry the alias as modelId).
      const alias = this.retiredModelAlias(modelId, error);
      if (!alias) throw error;
      yield* this.generateCompletionStream(alias, messages, options);
      return;
    }

    // Accumulators for building the complete response
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let lastFinishReason: string | null = null;
    let lastUsage: GeminiUsageMetadata | undefined;
    /** Map from part index -> tool call accumulator */
    const toolCallAccum: Map<
      number,
      { name: string; args: Record<string, unknown>; thoughtSignature?: string }
    > = new Map();
    let toolCallIndex = 0;

    const abortHandler = () => { /* consumer checks abortSignal each iteration */ };
    abortSignal?.addEventListener('abort', abortHandler, { once: true });

    try {
      for await (const rawData of this.parseSseStream(stream)) {
        if (abortSignal?.aborted) {
          yield this.buildAbortChunk(modelId);
          break;
        }

        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(rawData) as GeminiResponse;
        } catch {
          // Malformed JSON — skip
          console.warn('GeminiProvider: Could not parse SSE event JSON:', rawData);
          continue;
        }

        // Handle API-level errors in the stream
        if (chunk.error) {
          yield {
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            modelId,
            choices: [],
            error: {
              message: chunk.error.message,
              type: chunk.error.status,
              code: chunk.error.code,
            },
            isFinal: true,
          };
          return;
        }

        // Track usage from every chunk — the last one will have final totals
        if (chunk.usageMetadata) {
          lastUsage = chunk.usageMetadata;
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        if (candidate.finishReason) {
          lastFinishReason = candidate.finishReason;
        }

        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          // A thought summary is the model's reasoning: it streams as
          // reasoning text, apart from the answer.
          if (part.thought) {
            if (typeof part.text === 'string' && part.text) {
              accumulatedReasoning += part.text;
              yield {
                id: responseId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                modelId,
                choices: [{ index: 0, message: { role: 'assistant', content: null }, finishReason: null }],
                reasoningTextDelta: part.text,
              };
            }
            continue;
          }
          if (part.text !== undefined) {
            // Text delta
            accumulatedContent += part.text;
            yield {
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              modelId,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: part.text },
                finishReason: null,
              }],
              responseTextDelta: part.text,
            };
          } else if (part.functionCall) {
            // Tool call — Gemini delivers function calls as complete objects,
            // not incremental deltas. We emit them as a single delta per call.
            const idx = toolCallIndex++;
            toolCallAccum.set(idx, {
              name: part.functionCall.name,
              args: part.functionCall.args,
              thoughtSignature: part.thoughtSignature,
            });

            yield {
              id: responseId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              modelId,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: null },
                finishReason: null,
              }],
              toolCallsDeltas: [{
                index: idx,
                id: `call_gemini_${Date.now()}_${idx}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  // Gemini delivers complete args, so emit them as a single delta
                  arguments_delta: JSON.stringify(part.functionCall.args),
                },
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              }],
            };
          }
        }
      }

      // Emit final chunk with usage and finish reason
      const toolCalls = this.assembleToolCalls(toolCallAccum);
      const hasToolCalls = toolCalls.length > 0;
      const usage = this.mapUsage(lastUsage, modelId);

      // Surface a content-policy block (SAFETY/RECITATION with no content) as a
      // thrown content_filter error — same as the non-streaming path — so the
      // policy-aware fallback can engage instead of silently yielding an empty
      // success chunk. The catch below re-throws content_filter so it propagates.
      if (this.mapFinishReason(lastFinishReason) === 'content_filter' && !accumulatedContent && !hasToolCalls) {
        throw new GeminiProviderError(
          `Gemini blocked the response (finishReason: ${lastFinishReason ?? 'unknown'}); no content returned.`,
          'content_filter',
        );
      }

      yield {
        id: responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        modelId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: accumulatedContent || null,
            ...(hasToolCalls && { tool_calls: toolCalls }),
            ...(accumulatedReasoning && { reasoningText: accumulatedReasoning }),
          },
          finishReason: this.mapFinishReason(lastFinishReason),
        }],
        usage,
        isFinal: true,
      };

    } catch (streamError: unknown) {
      // A content-policy block must PROPAGATE (not become a generic error
      // chunk) so the caller / fallback chain can act on code 'content_filter'.
      if (streamError instanceof GeminiProviderError && streamError.code === 'content_filter') {
        throw streamError;
      }
      const message = streamError instanceof Error
        ? streamError.message
        : 'Gemini stream processing error';
      console.error(`GeminiProvider stream error for model ${modelId}:`, message);
      yield {
        id: responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        modelId,
        choices: [],
        isFinal: true,
        error: { message, type: 'STREAM_PROCESSING_ERROR' },
      };
    } finally {
      abortSignal?.removeEventListener('abort', abortHandler);
    }
  }

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  /**
   * Generates embeddings using Gemini's embedding models.
   *
   * Sends the texts through `models/{model}:batchEmbedContents` in chunks of
   * at most {@link GEMINI_EMBED_BATCH_LIMIT}, one request per chunk, and
   * returns the vectors in input order. gemini-embedding-001 and
   * gemini-embedding-2 both accept batchEmbedContents (probed 2026-09-29),
   * although neither lists it in `supportedGenerationMethods`.
   * `options.dimensions` is sent as `outputDimensionality`, which both models
   * honor (768 and 1536 probed 2026-09-29); without it they return 3072.
   * Usage sums each call's `usageMetadata.promptTokenCount`, which
   * gemini-embedding-2 reports and gemini-embedding-001 omits, so the older
   * model's calls count zero tokens (probed 2026-09-30). When a later batch
   * fails, the thrown error carries the earlier batches' usage as
   * `partialUsage`, since those calls were billed.
   *
   * @param {string} modelId - Embedding model (e.g., "gemini-embedding-001").
   * @param {string[]} texts - Input texts to embed.
   * @param {ProviderEmbeddingOptions} [options] - Optional embedding parameters; `abortSignal`
   *   cancels the batch in flight, and no later batch is sent.
   * @returns {Promise<ProviderEmbeddingResponse>} Embedding vectors.
   * @throws {GeminiProviderError} On API errors; `REQUEST_ABORTED` when the caller's signal ends
   *   the call.
   */
  public async generateEmbeddings(
    modelId: string,
    texts: string[],
    options?: ProviderEmbeddingOptions,
  ): Promise<ProviderEmbeddingResponse> {
    this.ensureInitialized();

    const endpoint = `/models/${modelId}:batchEmbedContents`;
    const pricePer1M = GEMINI_MODELS.find(m => m.modelId === modelId)?.pricePer1MTokensInput;
    const usageFor = (tokens: number): ProviderEmbeddingResponse['usage'] => ({
      prompt_tokens: tokens,
      total_tokens: tokens,
      ...(pricePer1M !== undefined && tokens > 0 ? { costUSD: (tokens / 1_000_000) * pricePer1M } : {}),
    });
    const vectors: number[][] = [];
    let promptTokens = 0;
    for (let start = 0; start < texts.length; start += GEMINI_EMBED_BATCH_LIMIT) {
      const requests = texts.slice(start, start + GEMINI_EMBED_BATCH_LIMIT).map(text => ({
        model: `models/${modelId}`,
        content: { parts: [{ text }] },
        ...(options?.dimensions ? { outputDimensionality: options.dimensions } : {}),
      }));
      let apiResponse: GeminiBatchEmbedResponse;
      try {
        // The caller's signal cancels the batch in flight; no later batch is sent.
        apiResponse = await this.makeApiRequest<GeminiBatchEmbedResponse>(
          endpoint,
          { requests },
          undefined,
          options?.abortSignal,
        );
      } catch (error: unknown) {
        // The batches before this one were billed; keep their usage on the
        // error so the caller can still record it.
        if (start > 0 && error instanceof GeminiProviderError) {
          error.partialUsage = usageFor(promptTokens);
        }
        throw error;
      }
      for (const emb of apiResponse.embeddings) vectors.push(emb.values);
      promptTokens += apiResponse.usageMetadata?.promptTokenCount ?? 0;
    }

    return {
      object: 'list',
      data: vectors.map((embedding, index) => ({
        object: 'embedding' as const,
        embedding,
        index,
      })),
      model: modelId,
      usage: usageFor(promptTokens),
    };
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * Returns a static catalog of known Gemini models.
   *
   * Uses a hardcoded catalog kept up-to-date with major releases, since
   * the Gemini models list endpoint requires iterating over all models.
   *
   * @param {{ capability?: string }} [filter] - Optional capability filter.
   * @returns {Promise<ModelInfo[]>} Array of known Gemini models.
   */
  public async listAvailableModels(
    filter?: { capability?: string },
  ): Promise<ModelInfo[]> {
    this.ensureInitialized();
    if (filter?.capability) {
      return GEMINI_MODELS.filter(m => m.capabilities.includes(filter.capability!));
    }
    return [...GEMINI_MODELS];
  }

  /**
   * Retrieves metadata for a specific Gemini model from the static catalog.
   *
   * @param {string} modelId - Model identifier (e.g., "gemini-2.5-flash").
   * @returns {Promise<ModelInfo | undefined>} Model info or undefined if not found.
   */
  public async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    this.ensureInitialized();
    return GEMINI_MODELS.find(m => m.modelId === modelId);
  }

  /**
   * Performs a lightweight health check by sending a minimal generateContent request.
   *
   * @returns {Promise<{ isHealthy: boolean; details?: unknown }>} Health status.
   */
  public async checkHealth(): Promise<{ isHealthy: boolean; details?: unknown }> {
    try {
      const model = this.defaultModelId || 'gemini-2.5-flash';
      await this.makeApiRequest<GeminiResponse>(
        `/models/${model}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      );
      return { isHealthy: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Health check failed';
      return { isHealthy: false, details: { message, error } };
    }
  }

  /** @inheritdoc */
  public async shutdown(): Promise<void> {
    this.isInitialized = false;
    console.log('GeminiProvider shutdown complete.');
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Guard that throws if the provider has not been initialized.
   *
   * @private
   * @throws {GeminiProviderError} If not initialized.
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GeminiProviderError(
        'GeminiProvider is not initialized. Call initialize() first.',
        'PROVIDER_NOT_INITIALIZED',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Payload construction
  // -------------------------------------------------------------------------

  /**
   * Builds the Gemini API request payload from IProvider inputs.
   *
   * The key transformations are:
   * 1. System messages extracted to `systemInstruction` (Gemini has no system role).
   * 2. `assistant` role mapped to `model` (Gemini's convention).
   * 3. Tool messages mapped to `functionResponse` parts within user turns.
   * 4. OpenAI-style tool definitions converted to `functionDeclarations`.
   *
   * @param {string} modelId - Target model (endpoint; also its output ceiling and thinking levels).
   * @param {ChatMessage[]} messages - Conversation messages.
   * @param {ModelCompletionOptions} options - Completion options.
   * @returns {Record<string, unknown>} The request body for Gemini's API.
   * @private
   */
  private buildRequestPayload(
    modelId: string,
    messages: ChatMessage[],
    options: ModelCompletionOptions,
  ): Record<string, unknown> {
    // --- Extract system messages into systemInstruction ---
    // Gemini treats system instructions as a separate top-level field,
    // similar to Anthropic but with a `parts` array wrapper.
    const systemParts: string[] = [];
    const conversationMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
            : '';
        if (text) systemParts.push(text);
      } else {
        conversationMessages.push(msg);
      }
    }

    // --- Convert messages to Gemini content format ---
    const contents = this.convertMessages(conversationMessages);

    const payload: Record<string, unknown> = {
      contents,
    };

    // Include systemInstruction only if there's system content
    if (systemParts.length > 0) {
      payload.systemInstruction = {
        parts: [{ text: systemParts.join('\n\n') }],
      } satisfies GeminiSystemInstruction;
    }

    // --- Generation config ---
    const generationConfig: GeminiGenerationConfig = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.maxTokens !== undefined) {
      // Never above the model's output ceiling: the API rejects the whole
      // request, and a rescue hop's headroom
      // (FallbackProviderEntry.maxTokensHeadroom) can lift a large budget
      // past it. Models outside the catalog pass through unclamped.
      const outputLimit = GEMINI_MODELS.find(m => m.modelId === modelId)?.outputTokenLimit;
      generationConfig.maxOutputTokens =
        typeof outputLimit === 'number' ? Math.min(options.maxTokens, outputLimit) : options.maxTokens;
    }
    if (options.topP !== undefined) generationConfig.topP = options.topP;
    if (options.stopSequences?.length) generationConfig.stopSequences = options.stopSequences;
    // JSON mode: Gemini uses responseMimeType to enforce JSON output.
    // Schema-driven structured output: when the buildResponseFormat
    // adapter routes a Zod schema through Gemini, it sets
    // responseFormat: { type: 'json_object', _gemini: { responseSchema } }.
    // Forwarding the schema to generationConfig.responseSchema enables
    // Gemini's constrained-decoding enforcement (output is guaranteed
    // valid JSON conforming to the schema).
    if (options.responseFormat?.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json';
      const geminiExtra = (options.responseFormat as { _gemini?: { responseSchema?: Record<string, unknown> } })._gemini;
      if (geminiExtra?.responseSchema) {
        // Gemini's responseSchema is an OpenAPI-subset proto that 400s the
        // whole request on ANY unknown field (`Unknown name "…"`), and
        // lowered JSON Schemas legitimately carry fields outside it —
        // z.record lowers to `additionalProperties`, strict-mode shapes pin
        // `additionalProperties: false` (killed a world-creation objectives
        // pass in production, 2026-07-16). Sanitize to the accepted subset
        // at this boundary so every caller is covered.
        generationConfig.responseSchema = sanitizeGeminiResponseSchema(
          geminiExtra.responseSchema,
        );
      }
    }
    // topK support via customModelParams
    if (options.customModelParams?.topK !== undefined) {
      generationConfig.topK = options.customModelParams.topK as number;
    }
    // Thinking depth. A caller-supplied thinkingConfig is forwarded as is;
    // otherwise the provider-neutral `effort` becomes the model's thinking
    // level when the model is known to take that level. Thinking shares the
    // maxOutputTokens cap: room for it on a rescue hop comes from
    // FallbackProviderEntry.maxTokensHeadroom, not from this provider. The
    // shared `thinking` option is Anthropic's on-switch and is not translated:
    // on a fallback hop it would turn "thinking on" into a thinking-token cap.
    const customThinking = options.customModelParams?.thinkingConfig;
    if (customThinking && typeof customThinking === 'object') {
      generationConfig.thinkingConfig = customThinking as GeminiThinkingConfig;
    } else {
      const thinkingLevel = geminiThinkingLevelFor(modelId, options.effort);
      if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
    }

    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    // --- Tool definitions ---
    const tools = this.convertToolDefs(options.tools);
    if (tools.length > 0) {
      payload.tools = [{ functionDeclarations: tools }];
    }

    // Pass through custom model params (excluding ones we already handle,
    // and never OpenRouter's routing controls — Gemini 400s on unknown
    // top-level names like `provider`; see openrouter-only-params).
    if (options.customModelParams) {
      // thinkingConfig belongs inside generationConfig (set above); at the
      // payload root Gemini rejects it as an unknown field.
      const { topK, thinkingConfig, ...rest } = options.customModelParams;
      const passthrough = stripOpenRouterOnlyParams(rest);
      if (passthrough) {
        Object.assign(payload, passthrough);
      }
    }

    return payload;
  }

  /**
   * Converts an array of ChatMessages to Gemini's content format.
   *
   * Maps IProvider roles to Gemini roles:
   * - `user` -> `user`
   * - `assistant` -> `model` (Gemini uses "model" instead of "assistant")
   * - `tool` -> `user` with `functionResponse` parts
   *
   * Consecutive tool results share one `user` turn, because Gemini requires
   * the responses to a turn of parallel function calls in a single content
   * (one functionResponse part per call). A tool result without `name`, as
   * `generateText` records them, takes the function name of the call with the
   * same id.
   *
   * @param {ChatMessage[]} messages - IProvider-format messages.
   * @returns {GeminiContent[]} Gemini-format content array.
   * @private
   */
  private convertMessages(messages: ChatMessage[]): GeminiContent[] {
    // The inline image bytes so far, against Gemini's per-request limit.
    let inlineBytes = 0;
    const contents: GeminiContent[] = [];
    const toolNameByCallId = new Map<string, string>();

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        // --- Assistant messages map to "model" role ---
        const parts: GeminiPart[] = [];

        // Add text content if present
        if (typeof msg.content === 'string' && msg.content) {
          parts.push({ text: msg.content });
        }

        // Convert tool_calls to functionCall parts. Each call's thought
        // signature is replayed verbatim. A turn with no signature at all (a
        // call made by another provider, or history that dropped it) gets the
        // documented placeholder on its first call, which is where Gemini puts
        // its own; without one Gemini 3 rejects the request with HTTP 400.
        if (msg.tool_calls?.length) {
          const turnHasSignature = msg.tool_calls.some(tc => tc.thoughtSignature);
          msg.tool_calls.forEach((tc, i) => {
            if (tc.id) toolNameByCallId.set(tc.id, tc.function.name);
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : (tc.function.arguments as unknown as Record<string, unknown>) ?? {};
            } catch {
              parsedArgs = {};
            }
            const part: GeminiPart = {
              functionCall: { name: tc.function.name, args: parsedArgs },
            };
            if (tc.thoughtSignature) {
              part.thoughtSignature = tc.thoughtSignature;
            } else if (!turnHasSignature && i === 0) {
              part.thoughtSignature = GEMINI_SKIP_THOUGHT_SIGNATURE;
            }
            parts.push(part);
          });
        }

        // Ensure at least one part — Gemini requires non-empty parts
        if (parts.length === 0) {
          parts.push({ text: '' });
        }

        contents.push({ role: 'model', parts });

      } else if (msg.role === 'tool') {
        // --- Tool result messages become user-role functionResponse ---
        // Gemini expects tool results as functionResponse parts in a user turn.
        let responseData: Record<string, unknown>;
        if (typeof msg.content === 'string') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(msg.content);
          } catch {
            // If the tool result isn't valid JSON, wrap it
            parsed = msg.content;
          }
          // functionResponse.response is a JSON object (a protobuf Struct);
          // Gemini rejects a string, number, array or null there with HTTP
          // 400, so such a result is wrapped.
          responseData = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { result: parsed };
        } else {
          responseData = { result: JSON.stringify(msg.content ?? '') };
        }

        const responsePart: GeminiPart = {
          functionResponse: {
            name: msg.name
              || (msg.tool_call_id ? toolNameByCallId.get(msg.tool_call_id) : undefined)
              || 'unknown',
            response: responseData,
          },
        };
        const previous = contents[contents.length - 1];
        if (
          previous?.role === 'user'
          && previous.parts.length > 0
          && previous.parts.every(part => part.functionResponse)
        ) {
          previous.parts.push(responsePart);
        } else {
          contents.push({ role: 'user', parts: [responsePart] });
        }

      } else {
        // --- User messages ---
        const parts: GeminiPart[] = [];

        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          // Multimodal content: text parts as text, images as inline data.
          for (const part of msg.content) {
            if (part.type === 'text') {
              parts.push({ text: (part as { text: string }).text });
            } else if (part.type === 'image_url') {
              const inlineData = inlineDataOf((part as { image_url: { url: string } }).image_url.url);
              inlineBytes += base64Bytes(inlineData.data);
              if (inlineBytes > MAX_INLINE_IMAGE_BYTES) {
                throw new GeminiProviderError(
                  `The images in this request come to more than Gemini's 20 MB of inline data per request.`,
                  'IMAGE_TOO_LARGE',
                );
              }
              parts.push({ inlineData });
            }
          }
        }

        if (parts.length === 0) {
          parts.push({ text: '' });
        }

        contents.push({ role: 'user', parts });
      }
    }

    return contents;
  }

  /**
   * Converts OpenAI-style tool definitions to Gemini's functionDeclarations format.
   *
   * OpenAI uses `{ type: 'function', function: { name, description, parameters } }`
   * while Gemini uses `{ name, description, parameters }` inside a `functionDeclarations` array.
   *
   * @param {Array<Record<string, unknown>>} [tools] - OpenAI-formatted tool defs.
   * @returns {GeminiFunctionDeclaration[]} Gemini-formatted function declarations.
   * @private
   */
  private convertToolDefs(tools?: Array<Record<string, unknown>>): GeminiFunctionDeclaration[] {
    if (!tools || tools.length === 0) return [];
    return tools.map(tool => {
      // OpenAI format: { type: 'function', function: { name, description, parameters } }
      const fn = (tool as any)?.function;
      if (fn?.name) {
        return {
          name: fn.name as string,
          description: (fn.description ?? '') as string,
          // Gemini uses the same "parameters" field name as OpenAI, unlike Anthropic's input_schema
          parameters: fn.parameters,
        };
      }
      // AgentOS ITool format: { name, description, inputSchema }
      return {
        name: (tool as any).name ?? 'unknown',
        description: (tool as any).description ?? '',
        parameters: (tool as any).inputSchema ?? (tool as any).parameters,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Response mapping
  // -------------------------------------------------------------------------

  /**
   * Maps a non-streaming Gemini response to IProvider format.
   *
   * Extracts text from `candidates[0].content.parts`, converts `functionCall`
   * parts to OpenAI-style `tool_calls`, and normalizes usage metadata.
   *
   * @param {GeminiResponse} apiResponse - Raw Gemini API response.
   * @param {string} modelId - The model ID used for the request.
   * @returns {ModelCompletionResponse} Normalized completion response.
   * @private
   */
  private mapResponseToCompletion(
    apiResponse: GeminiResponse,
    modelId: string,
  ): ModelCompletionResponse {
    const candidate = apiResponse.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    // Collect text from all text parts
    // Thought-summary parts (present only with includeThoughts) are the
    // model's reasoning and stay out of the answer.
    const textParts = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text!);
    const fullText = textParts.join('');
    // They are returned apart, as the turn's reasoning summary.
    const reasoningText = parts
      .filter(p => p.thought && typeof p.text === 'string' && p.text)
      .map(p => p.text!)
      .join('');

    // Collect function calls and convert to OpenAI-style tool_calls
    const toolCalls = parts
      .filter(p => p.functionCall)
      .map((p, idx) => ({
        id: `call_gemini_${Date.now()}_${idx}`,
        type: 'function' as const,
        function: {
          name: p.functionCall!.name,
          arguments: JSON.stringify(p.functionCall!.args ?? {}),
        },
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
      }));

    const hasToolCalls = toolCalls.length > 0;
    const finishReason = this.mapFinishReason(candidate?.finishReason ?? null);
    const usage = this.mapUsage(apiResponse.usageMetadata, modelId);

    // A SAFETY / RECITATION block returns no content with finishReason
    // 'content_filter'. Surface it as a content-policy error (code
    // 'content_filter', recognized by isContentPolicyRefusal) so the
    // policy-aware fallback chain can engage an uncensored model. Returning an
    // empty 200 here stranded the caller — the fallback could never fire.
    if (finishReason === 'content_filter' && !fullText && !hasToolCalls) {
      throw new GeminiProviderError(
        `Gemini blocked the response (finishReason: ${candidate?.finishReason ?? 'unknown'}); no content returned.`,
        'content_filter',
      );
    }

    const choice: ModelCompletionChoice = {
      index: 0,
      message: {
        role: 'assistant',
        content: fullText || null,
        ...(hasToolCalls && { tool_calls: toolCalls }),
        ...(reasoningText && { reasoningText }),
      },
      finishReason,
    };

    return {
      id: `gemini-${modelId}-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      modelId,
      choices: [choice],
      usage,
    };
  }

  /**
   * Maps Gemini finish reasons to IProvider-convention finish reasons.
   *
   * Gemini uses uppercase enum strings:
   * - `STOP` -> `"stop"` (natural completion)
   * - `MAX_TOKENS` -> `"length"` (hit token limit)
   * - `SAFETY` -> `"content_filter"` (blocked by safety filters)
   * - `RECITATION` -> `"content_filter"` (blocked by recitation check)
   *
   * @param {string | null} finishReason - Gemini's finish reason value.
   * @returns {string} Normalized finish reason.
   * @private
   */
  private mapFinishReason(finishReason: string | null): string {
    switch (finishReason) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY': return 'content_filter';
      case 'RECITATION': return 'content_filter';
      default: return finishReason?.toLowerCase() ?? 'stop';
    }
  }

  /**
   * Maps Gemini usage metadata to IProvider's ModelUsage format.
   *
   * @param {GeminiUsageMetadata} [meta] - Gemini usage metadata.
   * @param {string} modelId - Model ID for cost estimation.
   * @returns {ModelUsage} Normalized usage metrics.
   * @private
   */
  private mapUsage(meta: GeminiUsageMetadata | undefined, modelId: string): ModelUsage {
    const promptTokens = meta?.promptTokenCount ?? 0;
    // Thinking tokens are output the model generated and Google bills at the
    // output rate ("output price, including thinking tokens"), reported apart
    // from candidatesTokenCount. Counted here so completion tokens and cost
    // match the bill — the same convention as OpenAI's completion_tokens,
    // which includes reasoning tokens.
    const completionTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
    const totalTokens = meta?.totalTokenCount ?? (promptTokens + completionTokens);
    // Gemini implicit caching (default-on for 2.5+) reports the cached
    // subset of promptTokenCount in cachedContentTokenCount; normalize it
    // into the same field the Anthropic/OpenAI/OpenRouter providers
    // populate so cache hits meter identically everywhere. promptTokens
    // stays inclusive of the cached subset, and an explicit 0 is preserved
    // (an observed miss), while absent stays absent (unreported) — the same
    // typeof gate the OpenAI/OpenRouter mappings use.
    const cachedContentTokens = meta?.cachedContentTokenCount;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      ...(typeof cachedContentTokens === 'number' && cachedContentTokens >= 0
        ? { cacheReadInputTokens: cachedContentTokens }
        : {}),
      costUSD: this.estimateCost(promptTokens, completionTokens, modelId),
    };
  }

  /**
   * Assembles completed tool calls from the streaming accumulator.
   *
   * @param {Map<number, { name: string; args: Record<string, unknown> }>} accum - Accumulated tool calls.
   * @returns {NonNullable<ChatMessage['tool_calls']>} OpenAI-style tool_calls array.
   * @private
   */
  private assembleToolCalls(
    accum: Map<number, { name: string; args: Record<string, unknown>; thoughtSignature?: string }>,
  ): NonNullable<ChatMessage['tool_calls']> {
    if (accum.size === 0) return [];
    return Array.from(accum.entries()).map(([idx, tc]) => ({
      id: `call_gemini_${Date.now()}_${idx}`,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args ?? {}),
      },
      ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
    }));
  }

  /**
   * Estimates USD cost for a given model and token counts.
   *
   * Looks up pricing from the static model catalog. Returns undefined
   * if the model is not found in the catalog.
   *
   * @param {number} inputTokens - Number of input tokens.
   * @param {number} outputTokens - Number of output tokens.
   * @param {string} modelId - Model identifier for pricing lookup.
   * @returns {number | undefined} Estimated cost in USD.
   * @private
   */
  private estimateCost(
    inputTokens: number,
    outputTokens: number,
    modelId: string,
  ): number | undefined {
    const info = GEMINI_MODELS.find(m => m.modelId === modelId);
    if (!info?.pricePer1MTokensInput || !info?.pricePer1MTokensOutput) return undefined;
    // Long prompts bill the whole request at a higher tier on some models.
    const longContext = GEMINI_LONG_CONTEXT_PRICING[modelId];
    const isLong = longContext !== undefined && inputTokens > longContext.abovePromptTokens;
    const inputRate = isLong ? longContext.input : info.pricePer1MTokensInput;
    const outputRate = isLong ? longContext.output : info.pricePer1MTokensOutput;
    return (
      (inputTokens / 1_000_000) * inputRate +
      (outputTokens / 1_000_000) * outputRate
    );
  }

  /**
   * Builds an abort chunk for early stream termination.
   *
   * @param {string} modelId - The model ID for the response.
   * @returns {ModelCompletionResponse} A terminal chunk with abort error.
   * @private
   */
  private buildAbortChunk(modelId: string): ModelCompletionResponse {
    return {
      id: `gemini-abort-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      modelId,
      choices: [],
      error: { message: 'Stream aborted by caller', type: 'abort' },
      isFinal: true,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP transport
  // -------------------------------------------------------------------------

  /**
   * The next API key to send: the pool rotates between configured keys and
   * skips one in cooldown after a 429. Falls back to the configured key when
   * the provider was configured without initialization (tests).
   */
  private nextApiKey(): string {
    return this.keyPool?.hasKeys ? this.keyPool.next() : this.config.apiKey;
  }

  /**
   * Request headers for one call. The key travels in `x-goog-api-key`, which
   * Gemini accepts on every endpoint this provider calls.
   */
  private requestHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent': 'AgentOS/1.0 (GeminiProvider)',
      'x-goog-api-key': apiKey,
    };
  }

  /**
   * Makes a non-streaming API request to the Gemini API with retry logic.
   *
   * The API key goes in the `x-goog-api-key` header. Each attempt draws a key
   * from the pool, so a retry after a 429 uses another key when one is
   * configured.
   *
   * @template T The expected response type.
   * @param {string} endpoint - API endpoint path (e.g., "/models/gemini-2.5-flash:generateContent").
   * @param {Record<string, unknown>} body - Request body.
   * @param {number} [requestTimeoutOverride] - Per-call timeout in ms, over the configured default.
   * @param {AbortSignal} [abortSignal] - Caller's signal. It aborts the fetch in flight, and once
   *   it has fired no further attempt is sent.
   * @returns {Promise<T>} Parsed JSON response.
   * @throws {GeminiProviderError} On authentication, validation, rate-limit, or network errors;
   *   `REQUEST_ABORTED` when the caller's signal ends the request.
   * @private
   */
  private async makeApiRequest<T>(
    endpoint: string,
    body: Record<string, unknown>,
    requestTimeoutOverride?: number,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.config.baseURL}${endpoint}`;

    let lastError: Error = new GeminiProviderError(
      'Request failed after all retries.',
      'MAX_RETRIES_REACHED',
    );

    // CR8: honor a per-call requestTimeout override (e.g. long codegen) over
    // the provider default; only Anthropic read this before.
    const effectiveTimeout =
      typeof requestTimeoutOverride === 'number' && requestTimeoutOverride > 0
        ? requestTimeoutOverride
        : this.config.requestTimeout;

    for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
      if (abortSignal?.aborted) {
        throw new GeminiProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
      }
      const apiKey = this.nextApiKey();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.requestHeaders(apiKey),
          body: JSON.stringify(body),
          // The caller's signal aborts this attempt's fetch as the timer does.
          signal: abortSignal ? AbortSignal.any([controller.signal, abortSignal]) : controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({})) as Partial<GeminiAPIError>;
          const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
          const errorStatus = errorData.error?.status;

          // Non-retryable client errors (auth, bad request, not found)
          if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
            throw new GeminiProviderError(
              errorMessage,
              'API_CLIENT_ERROR',
              response.status,
              errorStatus,
              errorData,
            );
          }

          // Rate limit — respect Retry-After header
          if (response.status === 429) {
            lastError = new GeminiProviderError(
              errorMessage,
              'RATE_LIMIT_EXCEEDED',
              429,
              errorStatus,
              errorData,
            );
            // The key's quota is spent: the pool rests it, and the next
            // attempt draws another key when one is configured.
            this.keyPool?.markExhausted(apiKey);
            const retryAfter = response.headers.get('retry-after');
            // Retry-After is authoritative when present; otherwise jittered backoff.
            const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : computeRetryBackoffMs(attempt);
            await new Promise(resolve => setTimeout(resolve, retryAfterMs));
            continue;
          }

          // Retryable server errors (5xx)
          if (response.status >= 500) {
            lastError = new GeminiProviderError(
              errorMessage,
              'API_SERVER_ERROR',
              response.status,
              errorStatus,
              errorData,
            );
            await new Promise(resolve => setTimeout(resolve, computeRetryBackoffMs(attempt)));
            continue;
          }

          throw new GeminiProviderError(
            errorMessage,
            'API_REQUEST_FAILED',
            response.status,
            errorStatus,
            errorData,
          );
        }

        return (await response.json()) as T;
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        // A caller abort ends the request here; it is not a timeout to retry.
        if (abortSignal?.aborted) {
          throw new GeminiProviderError('Request aborted by caller.', 'REQUEST_ABORTED');
        }
        if (error instanceof GeminiProviderError) {
          if (error.code === 'API_CLIENT_ERROR') throw error;
          lastError = error;
        } else if (error instanceof Error && error.name === 'AbortError') {
          lastError = new GeminiProviderError(
            `Request timed out after ${effectiveTimeout}ms.`,
            'REQUEST_TIMEOUT',
          );
        } else {
          lastError = new GeminiProviderError(
            error instanceof Error
              ? redactUrlSecrets(error.message, this.config.baseURL, [apiKey])
              : 'Network or unknown error',
            'NETWORK_ERROR',
          );
        }

        if (attempt === this.config.maxRetries! - 1) break;
        const delay = computeRetryBackoffMs(attempt);
        console.warn(`[GeminiProvider] Retry ${attempt + 1}/${this.config.maxRetries! - 1} in ${(delay / 1000).toFixed(1)}s`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Makes a streaming API request and returns the raw ReadableStream.
   *
   * Uses the `?alt=sse` query parameter to enable SSE streaming; the API key
   * goes in the `x-goog-api-key` header.
   *
   * @param {string} endpoint - API endpoint (e.g., "/models/gemini-2.5-flash:streamGenerateContent").
   * @param {Record<string, unknown>} body - Request body.
   * @returns {Promise<ReadableStream<Uint8Array>>} The response body stream.
   * @throws {GeminiProviderError} On connection errors.
   * @private
   */
  private async makeStreamRequest(
    endpoint: string,
    body: Record<string, unknown>,
    requestTimeoutOverride?: number,
  ): Promise<ReadableStream<Uint8Array>> {
    const apiKey = this.nextApiKey();
    const url = `${this.config.baseURL}${endpoint}?alt=sse`;
    const headers = this.requestHeaders(apiKey);

    const controller = new AbortController();
    // CR8: honor a per-call requestTimeout override over the provider default.
    const effectiveTimeout =
      typeof requestTimeoutOverride === 'number' && requestTimeoutOverride > 0
        ? requestTimeoutOverride
        : this.config.requestTimeout;
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as Partial<GeminiAPIError>;
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        // A key whose quota is spent rests, so the next request draws another.
        if (response.status === 429) this.keyPool?.markExhausted(apiKey);
        throw new GeminiProviderError(
          errorMessage,
          'STREAM_CONNECTION_FAILED',
          response.status,
          errorData.error?.status,
          errorData,
        );
      }

      if (!response.body) {
        throw new GeminiProviderError(
          'Expected a stream response but body was null.',
          'STREAM_BODY_NULL',
        );
      }

      return response.body;
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof GeminiProviderError) throw error;
      throw new GeminiProviderError(
        error instanceof Error
          ? redactUrlSecrets(error.message, this.config.baseURL, [apiKey])
          : 'Failed to connect to Gemini stream.',
        'STREAM_CONNECTION_FAILED',
      );
    }
  }

  // -------------------------------------------------------------------------
  // SSE parsing
  // -------------------------------------------------------------------------

  /**
   * Parses an SSE (Server-Sent Events) stream from Gemini.
   *
   * Gemini SSE events follow the standard format:
   * ```
   * data: <json_payload>
   *
   * data: <json_payload>
   * ```
   *
   * This parser extracts the `data:` line content for each event and yields
   * the raw JSON strings for the caller to parse and dispatch.
   *
   * @param {ReadableStream<Uint8Array>} stream - The raw SSE byte stream.
   * @returns {AsyncGenerator<string>} Yields JSON string payloads.
   * @private
   */
  private async *parseSseStream(
    stream: ReadableStream<Uint8Array>,
  ): AsyncGenerator<string, void, undefined> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete events (separated by double newlines)
        const events = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = events.pop() || '';

        for (const event of events) {
          const trimmed = event.trim();
          if (!trimmed) continue;

          // Extract content after "data: " prefix
          // Events may have multi-line data (though Gemini typically uses single-line)
          const lines = trimmed.split('\n');
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              dataLines.push(line.slice(6));
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5));
            }
          }

          if (dataLines.length > 0) {
            const data = dataLines.join('\n').trim();
            // Skip empty data or the [DONE] signal
            if (data && data !== '[DONE]') {
              yield data;
            }
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        const lines = buffer.trim().split('\n');
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5));
          }
        }
        if (dataLines.length > 0) {
          const data = dataLines.join('\n').trim();
          if (data && data !== '[DONE]') {
            yield data;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
