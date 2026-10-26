/**
 * HierarchicalStrategy — Multi-level summary tree for very long conversations.
 *
 * Maintains 4 levels of compression:
 *   L0: Raw messages (last N turns)
 *   L1: Per-segment summaries (~50 turns each)
 *   L2: Per-session summaries (merges L1 nodes)
 *   L3: Overall conversation summary (single node)
 *
 * Each level compresses ~5-10x, giving total compression of up to 1000x
 * for multi-day conversations.
 */

import type {
  CompactionEntry,
  CompactionInput,
  CompactionResult,
  ContextMessage,
  ICompactionStrategy,
  InfiniteContextConfig,
  SummaryChainNode,
} from '../../../core/types.js';
import { compactionSplitIndex } from './compactionSplit.js';
import { extractiveSummary, summaryRoom } from './extractiveSummary.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function generateId(level: number): string {
  return `hier-L${level}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Maximum L1 nodes before triggering L2 merge. */
const MAX_L1_NODES = 5;
/** Maximum L2 nodes before triggering L3 merge. */
const MAX_L2_NODES = 3;

export class HierarchicalStrategy implements ICompactionStrategy {
  readonly name = 'hierarchical' as const;
  private readonly llmInvoker?: (prompt: string) => Promise<string>;

  /**
   * @param llmInvoker - Writes the summaries. Without one, or when it fails or
   *   answers nothing, a segment's summary is its user messages, cut to 80
   *   characters each, and no levels are merged. Either way the window's summary
   *   message holds the newest summary whole, within the tokens the segment
   *   held, and the older ones only as far as the window has room for them under
   *   the compaction threshold.
   */
  constructor(llmInvoker?: (prompt: string) => Promise<string>) {
    this.llmInvoker = llmInvoker;
  }

  async compact(
    input: CompactionInput,
    config: InfiniteContextConfig,
  ): Promise<CompactionResult> {
    const startTime = Date.now();
    const { messages, summaryChain } = input;

    // The newest turns stay as they are; see compactionSplitIndex.
    const splitIdx = compactionSplitIndex(messages.length, config.preserveRecentTurns);
    if (splitIdx <= 0) {
      return this.noopResult(messages, startTime);
    }

    const toCompact = messages.slice(0, splitIdx);
    const toKeep = messages.slice(splitIdx);
    const inputTokens = toCompact.reduce((s, m) => s + m.tokenEstimate, 0);

    // Step 1: Create L0 summary of the compacted segment.
    const l0Node = await this.createL0Summary(toCompact, config);
    const allNewNodes: SummaryChainNode[] = [l0Node];

    // Step 2: Check if we need L1 merge (too many L0 nodes).
    const existingL0 = summaryChain.filter(
      (n) => n.level === 0 && !n.parentId,
    );
    const allL0 = [...existingL0, l0Node];
    if (allL0.length > MAX_L1_NODES) {
      const l1Node = await this.mergeLevel(allL0, 1, config);
      if (l1Node) {
        for (const child of allL0) child.parentId = l1Node.id;
        allNewNodes.push(l1Node);

        // Step 3: Check if we need L2 merge.
        const existingL1 = summaryChain.filter(
          (n) => n.level === 1 && !n.parentId,
        );
        const allL1 = [...existingL1, l1Node];
        if (allL1.length > MAX_L2_NODES) {
          const l2Node = await this.mergeLevel(allL1, 2, config);
          if (l2Node) {
            for (const child of allL1) child.parentId = l2Node.id;
            allNewNodes.push(l2Node);
          }
        }
      }
    }

    // Build summary message for prompt injection.
    const activeNodes = [...summaryChain, ...allNewNodes].filter(
      (n) => !n.parentId,
    );
    const parts = activeNodes
      .sort((a, b) => a.turnRange[0] - b.turnRange[0])
      .map((n) => {
        const levelTag = n.level > 0 ? ` (L${n.level} summary)` : '';
        return `[Turns ${n.turnRange[0]}–${n.turnRange[1]}${levelTag}]\n${n.summary}`;
      });
    // The newest summary, which covers this segment, stays whole within the tokens the segment held; the older ones,
    // cut from their end, take only the room left under the compaction threshold. Without a summarizer no level is
    // merged, so the segment summaries would otherwise pile up in the window. The summary chain keeps them all.
    const summaryText = extractiveSummary(
      parts.slice(0, -1),
      parts[parts.length - 1] ?? '',
      Math.max(25, inputTokens - 20),
      summaryRoom(input, config, toKeep.reduce((s, m) => s + m.tokenEstimate, 0), 20),
    );

    const outputTokens = estimateTokens(summaryText);

    const summaryMessage: ContextMessage = {
      role: 'system',
      content: `[Hierarchical conversation history — ${inputTokens} tokens → ${outputTokens} tokens]\n${summaryText}`,
      timestamp: Date.now(),
      turnIndex: toCompact[0].turnIndex,
      tokenEstimate: outputTokens + 20,
      compacted: true,
    };

    const entryId = generateId(0);
    const turnRange: [number, number] = [
      toCompact[0].turnIndex,
      toCompact[toCompact.length - 1].turnIndex,
    ];

    const entry: CompactionEntry = {
      id: entryId,
      timestamp: Date.now(),
      turnRange,
      strategy: 'hierarchical',
      inputTokens,
      outputTokens,
      compressionRatio:
        outputTokens > 0
          ? Math.round((inputTokens / outputTokens) * 10) / 10
          : inputTokens,
      summary: summaryText,
      droppedContent: [],
      preservedEntities: this.collectEntities(allNewNodes),
      tracesCreated: [],
      emotionalContext: input.emotionalContext,
      durationMs: Date.now() - startTime,
    };

    return {
      messages: [summaryMessage, ...toKeep],
      newNodes: allNewNodes,
      entry,
      tracesToEncode: [],
    };
  }

  // ── Level summaries ────────────────────────────────────────────────

  private async createL0Summary(
    messages: ContextMessage[],
    config: InfiniteContextConfig,
  ): Promise<SummaryChainNode> {
    const text = messages.map((m) => `[${m.role}] ${m.content}`).join('\n');
    const targetTokens = Math.max(
      80,
      Math.ceil(estimateTokens(text) / config.targetCompressionRatio),
    );
    const turnRange: [number, number] = [
      messages[0].turnIndex,
      messages[messages.length - 1].turnIndex,
    ];

    const prompt = [
      'Summarize this conversation segment. Preserve decisions, action items, entities, technical details, and open questions.',
      `Target: ~${targetTokens} tokens.`,
      '',
      `Turns ${turnRange[0]}–${turnRange[1]}:`,
      text,
      '',
      'Summary:',
    ].join('\n');

    let summary: string | undefined;
    if (this.llmInvoker) {
      try {
        summary = (await this.llmInvoker(prompt)).trim() || undefined;
      } catch {
        // The extractive summary below.
      }
    }
    summary ??= `Conversation turns ${turnRange[0]}–${turnRange[1]}: ${messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.slice(0, 80))
      .join('; ')}`;

    return {
      id: generateId(0),
      level: 0,
      turnRange,
      summary,
      tokenEstimate: estimateTokens(summary),
      createdAt: Date.now(),
      childIds: [],
      entities: this.extractEntitiesFromText(summary),
      compactionEntryId: '',
    };
  }

  private async mergeLevel(
    nodes: SummaryChainNode[],
    targetLevel: number,
    config: InfiniteContextConfig,
  ): Promise<SummaryChainNode | null> {
    const combined = nodes
      .map((n) => `[Turns ${n.turnRange[0]}–${n.turnRange[1]}]\n${n.summary}`)
      .join('\n\n');

    const targetTokens = Math.max(
      60,
      Math.ceil(estimateTokens(combined) / (config.targetCompressionRatio / 2)),
    );

    const turnRange: [number, number] = [
      nodes[0].turnRange[0],
      nodes[nodes.length - 1].turnRange[1],
    ];

    const prompt = [
      `Merge these L${targetLevel - 1} conversation summaries into a single higher-level summary.`,
      'Preserve the most important decisions, outcomes, and ongoing threads.',
      'Consolidate redundant information.',
      `Target: ~${targetTokens} tokens.`,
      '',
      combined,
      '',
      'Merged summary:',
    ].join('\n');

    if (!this.llmInvoker) return null;
    try {
      const summary = (await this.llmInvoker(prompt)).trim();
      if (!summary) return null;
      const allEntities = new Set<string>();
      for (const n of nodes) {
        for (const e of n.entities) allEntities.add(e);
      }

      return {
        id: generateId(targetLevel),
        level: targetLevel,
        turnRange,
        summary,
        tokenEstimate: estimateTokens(summary),
        createdAt: Date.now(),
        childIds: nodes.map((n) => n.id),
        entities: Array.from(allEntities),
        compactionEntryId: '',
      };
    } catch {
      return null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private extractEntitiesFromText(text: string): string[] {
    const entities = new Set<string>();
    const patterns = [
      /[\w/.-]+\.\w{1,5}/g, // file paths
      /https?:\/\/[^\s)]+/g, // URLs
      /`[^`]+`/g, // code identifiers
    ];
    for (const p of patterns) {
      const matches = text.match(p);
      if (matches) {
        for (const m of matches) entities.add(m.replace(/`/g, ''));
      }
    }
    return Array.from(entities).slice(0, 30);
  }

  private collectEntities(nodes: SummaryChainNode[]): string[] {
    const all = new Set<string>();
    for (const n of nodes) {
      for (const e of n.entities) all.add(e);
    }
    return Array.from(all);
  }

  private noopResult(
    messages: ContextMessage[],
    startTime: number,
  ): CompactionResult {
    return {
      messages,
      newNodes: [],
      entry: {
        id: generateId(0),
        timestamp: Date.now(),
        turnRange: [0, 0],
        strategy: 'hierarchical',
        inputTokens: 0,
        outputTokens: 0,
        compressionRatio: 1,
        summary: '',
        droppedContent: [],
        preservedEntities: [],
        tracesCreated: [],
        durationMs: Date.now() - startTime,
      },
      tracesToEncode: [],
    };
  }
}
