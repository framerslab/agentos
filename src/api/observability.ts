import type { Span } from '@opentelemetry/api';

export interface ApiUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  totalCostUSD?: number;
  /** Cache-read tokens (normalized across providers; spec batch-1 C1). */
  cacheReadTokens?: number;
  /** Cache-creation tokens (normalized across providers). */
  cacheCreationTokens?: number;
  /** Provider-independent input total INCLUDING cached reads/writes. */
  inclusiveInputTokens?: number;
}

export function attachUsageAttributes(span: Span | null, usage?: ApiUsageLike | null): void {
  if (!span || !usage) return;

  if (typeof usage.promptTokens === 'number') {
    span.setAttribute('llm.usage.prompt_tokens', usage.promptTokens);
  }
  if (typeof usage.completionTokens === 'number') {
    span.setAttribute('llm.usage.completion_tokens', usage.completionTokens);
  }
  if (typeof usage.totalTokens === 'number') {
    span.setAttribute('llm.usage.total_tokens', usage.totalTokens);
  }

  const totalCostUSD =
    typeof usage.totalCostUSD === 'number'
      ? usage.totalCostUSD
      : typeof usage.costUSD === 'number'
        ? usage.costUSD
        : undefined;
  if (typeof totalCostUSD === 'number') {
    span.setAttribute('llm.usage.cost_usd', totalCostUSD);
  }
}

export function toTurnMetricUsage(usage?: ApiUsageLike | null): {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalCostUSD?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} | undefined {
  if (!usage) return undefined;

  const totalTokens = typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined;
  const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : undefined;
  const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : undefined;
  const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined;
  const cacheCreationTokens =
    typeof usage.cacheCreationTokens === 'number' ? usage.cacheCreationTokens : undefined;
  const totalCostUSD =
    typeof usage.totalCostUSD === 'number'
      ? usage.totalCostUSD
      : typeof usage.costUSD === 'number'
        ? usage.costUSD
        : undefined;

  if (
    totalTokens === undefined
    && promptTokens === undefined
    && completionTokens === undefined
    && totalCostUSD === undefined
    && cacheReadTokens === undefined
    && cacheCreationTokens === undefined
  ) {
    return undefined;
  }

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    totalCostUSD,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

export interface GenAiSpanInfo {
  providerName: string;
  operationName: 'chat';
  requestModel: string;
  responseModel?: string;
  usage?: ApiUsageLike | null;
  durationMs?: number;
  /** Caller-requested OpenAI service tier (emitted as `openai.request.service_tier`). */
  requestServiceTier?: string;
  /** Provider-reported service tier the call ran at (`openai.response.service_tier`). */
  responseServiceTier?: string;
}

/**
 * OTel GenAI semconv attributes, dual-emitted beside the legacy
 * `llm.usage.*` set (spec batch-1 C1). Attribute names pinned to
 * open-telemetry/semantic-conventions-genai commit
 * c26a2c21d1ee70d5231bd440c7b48d3c94ee506a — see
 * docs/observability/OBSERVABILITY.md. Called ONLY from the
 * generateText/streamText chat spans; embeddings and media surfaces are
 * distinct gen_ai operations and are out of scope for this batch.
 * `gen_ai.usage.input_tokens` reads the normalized inclusive input total
 * (cached tokens included per the semconv contract) — never a provider-raw
 * prompt count.
 */
export function attachGenAiAttributes(span: Span | null, info: GenAiSpanInfo): void {
  if (!span) return;
  span.setAttribute('gen_ai.provider.name', info.providerName);
  span.setAttribute('gen_ai.operation.name', info.operationName);
  span.setAttribute('gen_ai.request.model', info.requestModel);
  if (info.responseModel !== undefined) span.setAttribute('gen_ai.response.model', info.responseModel);
  // Service tiers use the OTel registry's provider-scoped attribute names —
  // nothing invented under gen_ai.* (spec batch-1 review fold).
  if (info.requestServiceTier !== undefined) span.setAttribute('openai.request.service_tier', info.requestServiceTier);
  if (info.responseServiceTier !== undefined) span.setAttribute('openai.response.service_tier', info.responseServiceTier);
  const u = info.usage;
  if (u) {
    if (typeof u.inclusiveInputTokens === 'number') {
      span.setAttribute('gen_ai.usage.input_tokens', u.inclusiveInputTokens);
    }
    if (typeof u.completionTokens === 'number') {
      span.setAttribute('gen_ai.usage.output_tokens', u.completionTokens);
    }
    if (typeof u.cacheReadTokens === 'number') {
      span.setAttribute('gen_ai.usage.cache_read.input_tokens', u.cacheReadTokens);
    }
    if (typeof u.cacheCreationTokens === 'number') {
      span.setAttribute('gen_ai.usage.cache_creation.input_tokens', u.cacheCreationTokens);
    }
  }
}
