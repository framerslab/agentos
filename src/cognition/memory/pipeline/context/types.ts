/**
 * Infinite Context Window — Types
 *
 * Data model for context window lifecycle management, compaction strategies,
 * and transparency logging.
 */

import type { EmotionalContext, MemoryTrace } from '../../core/types.js';
import type { ObservationNote } from '../observation/MemoryObserver.js';

// ── Configuration ──────────────────────────────────────────────────────

export type CompactionStrategy = 'sliding' | 'hierarchical' | 'hybrid';
export type TransparencyLevel = 'full' | 'summary' | 'silent';

export interface InfiniteContextConfig {
  /** Enable infinite context window management. */
  enabled: boolean;
  /** Compaction strategy to use. */
  strategy: CompactionStrategy;
  /** Trigger compaction when context reaches this fraction of max tokens (0–1). */
  compactionThreshold: number;
  /**
   * Turns kept as they are, newest first (two messages a turn), while older
   * messages remain to summarize. A conversation shorter than that, over its
   * threshold all the same, gives up its two oldest messages; the newest
   * message is never summarized.
   */
  preserveRecentTurns: number;
  /** Transparency logging level. */
  transparencyLevel: TransparencyLevel;
  /** Max compaction log entries retained in memory. */
  logRetention: number;
  /** Token budget for the rolling summary chain header. */
  maxSummaryChainTokens: number;
  /** Target compression ratio for summaries (e.g. 8 = 8:1). */
  targetCompressionRatio: number;
  /**
   * Writes the summaries. CognitiveMemoryManager falls back to the reflector's,
   * the observer's or the feature-detection invoker; without any, and when a
   * call fails or answers nothing, compaction writes extractive summaries.
   */
  llmInvoker?: (prompt: string) => Promise<string>;
  /** Model ID for summarization calls. */
  modelId?: string;
}

export const DEFAULT_INFINITE_CONTEXT_CONFIG: InfiniteContextConfig = {
  enabled: false,
  strategy: 'sliding',
  compactionThreshold: 0.75,
  preserveRecentTurns: 20,
  transparencyLevel: 'summary',
  logRetention: 100,
  maxSummaryChainTokens: 2000,
  targetCompressionRatio: 8,
};

// ── Messages ───────────────────────────────────────────────────────────

export interface ContextMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  /** The turn: each user message opens the next one, from 1; earlier messages are turn 0. */
  turnIndex: number;
  tokenEstimate: number;
  /** Set to true after this message has been compacted into a summary. */
  compacted?: boolean;
}

// ── Compaction Events ──────────────────────────────────────────────────

export interface CompactionEntry {
  id: string;
  timestamp: number;
  /** Inclusive turn range that was compacted. */
  turnRange: [number, number];
  /** Strategy that produced this compaction. */
  strategy: CompactionStrategy;
  /** Token count of the raw messages before compaction. */
  inputTokens: number;
  /** Token count of the produced summary. */
  outputTokens: number;
  /** Compression ratio (inputTokens / outputTokens). */
  compressionRatio: number;
  /** The summary text that replaced the raw messages. */
  summary: string;
  /** Content fragments intentionally dropped (low importance). */
  droppedContent: string[];
  /** Named entities preserved in the summary. */
  preservedEntities: string[];
  /** Memory trace IDs created from this compaction. */
  tracesCreated: string[];
  /** Observation notes extracted during compaction (hybrid strategy). */
  observationNotes?: ObservationNote[];
  /** Emotional context at time of compaction. */
  emotionalContext?: EmotionalContext;
  /** Duration of the compaction operation in ms. */
  durationMs: number;
}

// ── Summary Chain ──────────────────────────────────────────────────────

export interface SummaryChainNode {
  id: string;
  /** Level in the hierarchy (0 = leaf summary, higher = summary-of-summaries). */
  level: number;
  /** Turn range covered by this node. */
  turnRange: [number, number];
  /** The summary text. */
  summary: string;
  /** Token estimate for this summary. */
  tokenEstimate: number;
  /** Timestamp of creation. */
  createdAt: number;
  /** ID of the parent node (summary that absorbed this one), if any. */
  parentId?: string;
  /** IDs of child nodes that were merged to create this node. */
  childIds: string[];
  /** Key entities mentioned in this summary. */
  entities: string[];
  /** Compaction entry ID that produced this node. */
  compactionEntryId: string;
}

// ── Strategy Interface ─────────────────────────────────────────────────

export interface CompactionInput {
  /** All messages in the conversation. */
  messages: ContextMessage[];
  /** Maximum token budget for the entire context window. */
  maxContextTokens: number;
  /** Current total token count. */
  currentTokens: number;
  /** Existing summary chain (for incremental compaction). */
  summaryChain: SummaryChainNode[];
  /** Current emotional context, if available. */
  emotionalContext?: EmotionalContext;
  /** Recent memory traces for context (hybrid strategy). */
  recentTraces?: MemoryTrace[];
}

export interface CompactionResult {
  /** Messages after compaction (some replaced with summary blocks). */
  messages: ContextMessage[];
  /** New summary chain nodes produced. */
  newNodes: SummaryChainNode[];
  /** Compaction log entry. */
  entry: CompactionEntry;
  /** Memory traces to encode from the compacted content. */
  tracesToEncode: Partial<MemoryTrace>[];
}

export interface ICompactionStrategy {
  readonly name: CompactionStrategy;
  compact(input: CompactionInput, config: InfiniteContextConfig): Promise<CompactionResult>;
}
