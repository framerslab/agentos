/**
 * @fileoverview Shared helpers for persisting trace metadata in SQLite-first
 * memory paths.
 *
 * The Phase 1 memory facade stores core retrieval counters in dedicated
 * columns, but richer decay state is persisted inside `memory_traces.metadata`
 * to avoid a schema expansion. These helpers keep that JSON contract
 * consistent across the facade, consolidation loop, feedback loop, and
 * agent-facing memory tools.
 *
 * @module memory/store/tracePersistence
 */

import { sha256 } from '../../core/util/crossPlatformCrypto.js';

/**
 * Default stability for traces that do not yet have an explicit persisted
 * decay state.
 */
export const DEFAULT_TRACE_STABILITY_MS = 86_400_000;

/**
 * Default reinforcement interval for traces that do not yet have an explicit
 * persisted decay state.
 */
export const DEFAULT_TRACE_REINFORCEMENT_INTERVAL_MS = 86_400_000;

/**
 * Persisted decay state stored under `metadata.decay`.
 */
export interface PersistedDecayState {
  stability: number;
  accessCount: number;
  reinforcementInterval: number;
  nextReinforcementAt?: number;
}

const FTS_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'the',
  'to',
  'us',
  'we',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse a raw `metadata` JSON string into a plain object.
 */
export function parseTraceMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Read the persisted decay state from a metadata object, applying defaults
 * when fields are absent.
 */
export function readPersistedDecayState(
  metadata: Record<string, unknown>,
  retrievalCount = 0,
): PersistedDecayState {
  const decay = isRecord(metadata.decay) ? metadata.decay : {};
  const nextReinforcementAt = finiteNumber(decay.nextReinforcementAt);

  return {
    stability: finiteNumber(decay.stability) ?? DEFAULT_TRACE_STABILITY_MS,
    accessCount: finiteNumber(decay.accessCount) ?? retrievalCount,
    reinforcementInterval:
      finiteNumber(decay.reinforcementInterval) ?? DEFAULT_TRACE_REINFORCEMENT_INTERVAL_MS,
    ...(nextReinforcementAt !== undefined ? { nextReinforcementAt } : {}),
  };
}

/**
 * Merge a decay state payload into an existing metadata object.
 */
export function withPersistedDecayState(
  metadata: Record<string, unknown>,
  state: PersistedDecayState,
): Record<string, unknown> {
  const nextDecay: Record<string, unknown> = {
    stability: state.stability,
    accessCount: state.accessCount,
    reinforcementInterval: state.reinforcementInterval,
  };

  if (state.nextReinforcementAt !== undefined) {
    nextDecay.nextReinforcementAt = state.nextReinforcementAt;
  }

  return {
    ...metadata,
    decay: nextDecay,
  };
}

/**
 * Build initial metadata for a newly inserted memory trace.
 */
export function buildInitialTraceMetadata(
  baseMetadata: Record<string, unknown> = {},
  options?: {
    contentHash?: string;
    entities?: string[];
    scopeId?: string;
    stability?: number;
    accessCount?: number;
    reinforcementInterval?: number;
    nextReinforcementAt?: number;
  },
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...baseMetadata };

  if (options?.contentHash !== undefined) {
    metadata.content_hash = options.contentHash;
  }
  if (options?.entities !== undefined) {
    metadata.entities = options.entities;
  }
  if (options?.scopeId !== undefined) {
    metadata.scopeId = options.scopeId;
  }

  return withPersistedDecayState(metadata, {
    stability: options?.stability ?? DEFAULT_TRACE_STABILITY_MS,
    accessCount: options?.accessCount ?? 0,
    reinforcementInterval:
      options?.reinforcementInterval ?? DEFAULT_TRACE_REINFORCEMENT_INTERVAL_MS,
    ...(options?.nextReinforcementAt !== undefined
      ? { nextReinforcementAt: options.nextReinforcementAt }
      : {}),
  });
}

/**
 * Compute a SHA-256 hex digest for trace content.
 */
export async function sha256Hex(content: string): Promise<string> {
  return sha256(content);
}

/**
 * Convert free-form natural language into a conservative FTS5 query.
 *
 * This avoids syntax errors when callers pass punctuation-heavy questions such
 * as "What are my workflow preferences?" into a raw `MATCH` clause.
 */
export function buildNaturalLanguageFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';

  const rawTokens = Array.from(
    new Set(
      (trimmed.match(/[\p{L}\p{N}_]+/gu) ?? [])
        .map((token) => token.toLowerCase())
        .filter(Boolean),
    ),
  );

  if (rawTokens.length === 0) {
    return '';
  }

  const filteredTokens = rawTokens.filter(
    (token) => token.length > 1 && !FTS_STOP_WORDS.has(token),
  );
  const tokens = filteredTokens.length > 0 ? filteredTokens : rawTokens;

  return tokens.map((token) => `${token}*`).join(' OR ');
}

/**
 * One binding of `value` for each `?` in an SQL fragment the full-text helpers
 * made with `?` as their query placeholder. Postgres's rank and relevance order
 * read the query text through a placeholder of their own; SQLite's read the
 * match and hold none, so a statement binds the query text once per fragment
 * on one engine and not at all on the other.
 */
export function bindingsFor(fragment: string, value: unknown): unknown[] {
  return Array.from({ length: (fragment.match(/\?/g) ?? []).length }, () => value);
}
