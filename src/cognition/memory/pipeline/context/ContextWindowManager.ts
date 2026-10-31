/**
 * ContextWindowManager — Lifecycle orchestrator for infinite context conversations.
 *
 * Sits between the conversation loop and the LLM call. Before each turn:
 * 1. Tracks all messages and their token costs
 * 2. Checks if context window is approaching capacity
 * 3. Triggers compaction when threshold is reached
 * 4. Replaces old messages with compressed summaries
 * 5. Logs every compaction with full transparency
 * 6. Encodes important content as long-term memory traces
 *
 * The manager maintains a rolling summary chain so the agent always has
 * narrative context from the full conversation history.
 */

import type { EmotionalContext, MemoryTrace } from '../../core/types.js';
import { CompactionEngine } from './CompactionEngine.js';
import { CompactionLog, type CompactionLogStats } from './CompactionLog.js';
import { RollingSummaryChain } from './RollingSummaryChain.js';
import type {
  CompactionEntry,
  ContextMessage,
  InfiniteContextConfig,
  SummaryChainNode,
} from './types.js';
import { DEFAULT_INFINITE_CONTEXT_CONFIG } from './types.js';
import type { MemoryObserver } from '../observation/MemoryObserver.js';
import type { MemoryReflector } from '../observation/MemoryReflector.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ContextWindowManagerConfig {
  /** Maximum context window size in tokens. */
  maxContextTokens: number;
  /** Infinite context configuration. */
  infiniteContext: Partial<InfiniteContextConfig>;
  /**
   * Writes the summaries. `infiniteContext.llmInvoker` takes its place when set.
   * Without either, compaction runs on extractive summaries: each strategy takes
   * the segment's user messages (or the hybrid strategy's observation notes),
   * and the summary chain joins and cuts its oldest summaries.
   */
  llmInvoker?: (prompt: string) => Promise<string>;
  /** Optional: MemoryObserver for hybrid strategy. */
  observer?: MemoryObserver;
  /** Optional: MemoryReflector for hybrid strategy. */
  reflector?: MemoryReflector;
  /**
   * Encodes a compaction's traces into long-term memory. It runs after the turn
   * goes on, and the ids it answers become the compaction's `tracesCreated` in
   * the log.
   */
  onTracesCreated?: (traces: Partial<MemoryTrace>[]) => Promise<void | string[]>;
}

export class ContextWindowManager {
  private messages: ContextMessage[] = [];
  private turnCounter = 0;
  private readonly config: InfiniteContextConfig;
  private readonly maxContextTokens: number;
  private readonly engine: CompactionEngine;
  private readonly log: CompactionLog;
  private readonly chain: RollingSummaryChain;
  private readonly onTracesCreated?: (
    traces: Partial<MemoryTrace>[],
  ) => Promise<void | string[]>;

  /** Total compactions performed in this session. */
  private compactionCount = 0;
  /** Whether a compaction is currently running (prevent re-entry). */
  private compacting = false;

  constructor(managerConfig: ContextWindowManagerConfig) {
    this.config = {
      ...DEFAULT_INFINITE_CONTEXT_CONFIG,
      ...managerConfig.infiniteContext,
    };
    this.maxContextTokens = managerConfig.maxContextTokens;
    this.onTracesCreated = managerConfig.onTracesCreated;

    const llmInvoker =
      this.config.llmInvoker ?? managerConfig.llmInvoker;

    this.engine = new CompactionEngine(
      llmInvoker,
      managerConfig.observer,
      managerConfig.reflector,
    );
    this.log = new CompactionLog(
      this.config.logRetention,
      this.config.transparencyLevel,
    );
    this.chain = new RollingSummaryChain(
      this.config.maxSummaryChainTokens,
      llmInvoker,
    );
  }

  // ── Core API ───────────────────────────────────────────────────────

  /**
   * Add a message to the tracked conversation.
   * Call this for every message (user, assistant, system, tool).
   */
  addMessage(
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: string,
  ): void {
    // A user message opens the next turn, and the replies and tool messages
    // after it carry the same turn index. Messages before the first user
    // message are turn 0.
    if (role === 'user') {
      this.turnCounter++;
    }

    const msg: ContextMessage = {
      role,
      content,
      timestamp: Date.now(),
      turnIndex: this.turnCounter,
      tokenEstimate: estimateTokens(content),
    };
    this.messages.push(msg);
  }

  /**
   * Check whether compaction is needed and perform it if so.
   * Call this BEFORE assembling the prompt for the LLM.
   *
   * Returns the current message list (potentially compacted).
   */
  async beforeTurn(
    systemPromptTokens: number,
    memoryBudgetTokens: number,
    emotionalContext?: EmotionalContext,
  ): Promise<ContextMessage[]> {
    if (!this.config.enabled || this.compacting) {
      return this.messages;
    }

    const conversationTokens = this.messages.reduce(
      (s, m) => s + m.tokenEstimate,
      0,
    );
    const totalTokens =
      systemPromptTokens + memoryBudgetTokens + conversationTokens;
    const threshold = this.maxContextTokens * this.config.compactionThreshold;

    if (totalTokens < threshold) {
      return this.messages;
    }

    // Perform compaction.
    this.compacting = true;
    try {
      const result = await this.engine.compact(
        {
          messages: this.messages,
          maxContextTokens: this.maxContextTokens,
          currentTokens: totalTokens,
          summaryChain: this.chain.getAllNodes(),
          emotionalContext,
        },
        this.config,
      );

      // A strategy that found nothing to summarize (the newest message alone, or
      // the turns it keeps, fill the window) changes nothing, and no compaction
      // is logged or counted.
      if (result.newNodes.length === 0) {
        return this.messages;
      }

      // Update internal state.
      this.messages = result.messages;
      this.chain.addNodes(result.newNodes);
      this.log.append(result.entry);
      this.compactionCount++;

      // Collapse the summary chain if it's grown too large.
      const collapseNodes = await this.chain.collapse();
      if (collapseNodes.length > 0) {
        this.chain.addNodes(collapseNodes);
      }

      // Encode any traces produced by the compaction (hybrid strategy).
      if (result.tracesToEncode.length > 0 && this.onTracesCreated) {
        const entryId = result.entry.id;
        // Fire and forget — don't block the conversation turn. The ids of the
        // stored traces go into the logged entry when the encoding ends.
        this.onTracesCreated(result.tracesToEncode)
          .then((ids) => {
            const logged = this.log.getById(entryId);
            if (!logged || !Array.isArray(ids)) return;
            for (const id of ids) {
              if (!logged.tracesCreated.includes(id)) logged.tracesCreated.push(id);
            }
          })
          .catch(() => {
            /* trace encoding failure is non-fatal */
          });
      }

      return this.messages;
    } finally {
      this.compacting = false;
    }
  }

  /**
   * Get the formatted summary chain for injection into the system prompt
   * or as a conversation-history block.
   */
  getSummaryContext(): string {
    return this.chain.formatForPrompt();
  }

  // ── Message Management ─────────────────────────────────────────────

  /** Get all current messages (including any summary blocks). */
  getMessages(): readonly ContextMessage[] {
    return this.messages;
  }

  /** Get only the raw (non-compacted) messages. */
  getRawMessages(): ContextMessage[] {
    return this.messages.filter((m) => !m.compacted);
  }

  /** Current total token estimate across all messages. */
  getCurrentTokens(): number {
    return this.messages.reduce((s, m) => s + m.tokenEstimate, 0);
  }

  /** Current turn index. */
  getCurrentTurn(): number {
    return this.turnCounter;
  }

  /** Replace the message list (e.g. after external manipulation). */
  setMessages(messages: ContextMessage[]): void {
    this.messages = messages;
  }

  // ── Transparency ───────────────────────────────────────────────────

  /** Get the compaction log. */
  getLog(): CompactionLog {
    return this.log;
  }

  /** Get all compaction entries. */
  getCompactionHistory(): readonly CompactionEntry[] {
    return this.log.getAll();
  }

  /** Get aggregate stats. */
  getStats(): ContextWindowStats {
    const logStats = this.log.getStats();
    return {
      ...logStats,
      currentTokens: this.getCurrentTokens(),
      maxTokens: this.maxContextTokens,
      utilization: this.getCurrentTokens() / this.maxContextTokens,
      currentTurn: this.turnCounter,
      messageCount: this.messages.length,
      compactedMessageCount: this.messages.filter((m) => m.compacted).length,
      summaryChainNodes: this.chain.size,
      summaryChainTokens: this.chain.getTotalTokens(),
      strategy: this.config.strategy,
      enabled: this.config.enabled,
    };
  }

  /** Get the summary chain for UI display. */
  getSummaryChain(): SummaryChainNode[] {
    return this.chain.getAllNodes();
  }

  /** Search the compaction log for a keyword. */
  searchHistory(keyword: string): CompactionEntry[] {
    return this.log.search(keyword);
  }

  /** Find what happened to a specific turn. */
  findTurnHistory(turnIndex: number): CompactionEntry[] {
    return this.log.findByTurn(turnIndex);
  }

  /**
   * Format a transparency report for the agent's context.
   * Includes: current state, recent compactions, summary chain.
   */
  formatTransparencyReport(): string {
    const stats = this.getStats();
    const lines: string[] = [
      '=== Context Window Status ===',
      `Tokens: ${stats.currentTokens}/${stats.maxTokens} (${(stats.utilization * 100).toFixed(1)}%)`,
      `Turn: ${stats.currentTurn}, Messages: ${stats.messageCount} (${stats.compactedMessageCount} compacted)`,
      `Strategy: ${stats.strategy}, Compactions: ${stats.totalCompactions}`,
    ];

    if (stats.totalCompactions > 0) {
      lines.push(
        `Avg compression: ${stats.avgCompressionRatio}x, Total traces created: ${stats.totalTracesCreated}`,
      );
    }

    const recent = this.log.getAll().slice(-3);
    if (recent.length > 0) {
      lines.push('', '--- Recent Compactions ---');
      for (const entry of recent) {
        lines.push(CompactionLog.formatEntry(entry));
      }
    }

    const summaryContext = this.chain.formatForPrompt();
    if (summaryContext) {
      lines.push('', '--- Summary Chain ---', summaryContext);
    }

    return lines.join('\n');
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Reset all state. */
  clear(): void {
    this.messages = [];
    this.turnCounter = 0;
    this.compactionCount = 0;
    this.log.clear();
    this.chain.clear();
  }

  /** Get the compaction engine (for strategy inspection/testing). */
  getEngine(): CompactionEngine {
    return this.engine;
  }

  /** Whether infinite context is enabled. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Current config (read-only). */
  getConfig(): Readonly<InfiniteContextConfig> {
    return this.config;
  }
}

export interface ContextWindowStats extends CompactionLogStats {
  currentTokens: number;
  maxTokens: number;
  utilization: number;
  currentTurn: number;
  messageCount: number;
  compactedMessageCount: number;
  summaryChainNodes: number;
  summaryChainTokens: number;
  strategy: string;
  enabled: boolean;
}
