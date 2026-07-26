/**
 * @fileoverview Fail-closed OpenAI prompt-cache request-parameter helpers
 * (spec batch-1 C2).
 *
 * OPPOSITE unknown-model polarity from `model-cache-capabilities.ts` (which
 * is deliberately permissive for unknown future Claude models): unknown
 * OpenAI models get NO retention params — the caller omits the field and
 * debug-logs — because OpenAI rejects these fields on unsupported models.
 *
 * Matching is EXACT-FAMILY: a family id matches itself plus an optional
 * dated snapshot suffix (`-YYYY-MM-DD`). No bare prefix matching — `gpt-5.5`
 * must never match `gpt-5.5-pro`. Longest family wins so `gpt-5.1-codex`
 * beats `gpt-5.1`.
 *
 * Source (2026-07-19, developers.openai.com/api/docs/guides/prompt-caching):
 * - `prompt_cache_options.ttl` — GPT-5.6+ families; sole value `'30m'`
 *   (MINIMUM cache lifetime, not a maximum).
 * - `prompt_cache_retention: '24h'` — enumerated allow-list below; gpt-5.5
 *   and gpt-5.5-pro accept ONLY `'24h'`.
 * - `'in_memory'` — the guide enumerates no allow-list; the conservative
 *   floor here is the 24h list minus the only-24h pair. Expanding this list
 *   requires a sourced doc citation added to this comment.
 */

import { createHash } from 'node:crypto';

/** Retention values a caller may request. */
export type OpenAiCacheRetention = 'in_memory' | '24h' | '30m';

const TTL_30M_FAMILIES = ['gpt-5.6', 'gpt-5.6-sol'] as const;

const RETENTION_24H_FAMILIES = [
  'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.2',
  'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.1-chat-latest',
  'gpt-5', 'gpt-5-codex', 'gpt-4.1',
] as const;

const ONLY_24H_FAMILIES = ['gpt-5.5', 'gpt-5.5-pro'] as const;

const SNAPSHOT_SUFFIX = /^-\d{4}-\d{2}-\d{2}$/;

/** Exact family match with optional dated snapshot suffix. */
function matchesFamily(modelId: string, family: string): boolean {
  const id = modelId.toLowerCase();
  if (id === family) return true;
  if (!id.startsWith(family)) return false;
  return SNAPSHOT_SUFFIX.test(id.slice(family.length));
}

/** Longest-family-first so `gpt-5.5-pro` wins over `gpt-5.5`, etc. */
function inFamilyList(modelId: string, families: readonly string[]): boolean {
  return [...families].sort((a, b) => b.length - a.length).some((f) => matchesFamily(modelId, f));
}

/**
 * Resolve the wire params for a requested retention on a model, or `null`
 * when the combination is unsupported (caller omits the field + debug-logs;
 * never a hard error).
 */
export function resolveOpenAiCacheRetentionParams(
  modelId: string,
  requested: OpenAiCacheRetention,
):
  | { prompt_cache_options: { ttl: '30m' } }
  | { prompt_cache_retention: 'in_memory' | '24h' }
  | null {
  const is56 = inFamilyList(modelId, TTL_30M_FAMILIES);
  if (requested === '30m') {
    return is56 ? { prompt_cache_options: { ttl: '30m' } } : null;
  }
  if (is56) return null; // 5.6+ families use prompt_cache_options.ttl exclusively
  if (!inFamilyList(modelId, RETENTION_24H_FAMILIES)) return null;
  if (requested === '24h') return { prompt_cache_retention: '24h' };
  return inFamilyList(modelId, ONLY_24H_FAMILIES) ? null : { prompt_cache_retention: 'in_memory' };
}

/**
 * Resolve the wire `prompt_cache_key` per the quad-mode contract
 * (spec C2.2): absent/`false` → omit; `'auto'` → sha256-derived from the
 * session id when present (raw ids never leave the process), else omit;
 * explicit string → sent verbatim after trimming (empty → omit).
 */
export function resolvePromptCacheKey(
  option: string | false | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (option === false || option === undefined) return undefined;
  if (option === 'auto') {
    if (!sessionId || !sessionId.trim()) return undefined;
    return 'agentos:' + createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  }
  const trimmed = option.trim();
  return trimmed.length ? trimmed : undefined;
}
