/**
 * SlidingSummaryStrategy — Default compaction strategy.
 *
 * Summarizes the oldest N messages into a single paragraph, preserving
 * the most recent K turns raw. Simple, predictable, low latency.
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
import { earlierSummaries, extractiveSummary, summaryRoom } from './extractiveSummary.js';

/** ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function generateId(): string {
  return `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SlidingSummaryStrategy implements ICompactionStrategy {
  readonly name = 'sliding' as const;
  private readonly llmInvoker?: (prompt: string) => Promise<string>;

  /**
   * @param llmInvoker - Writes the summary. Without one, or when it fails or
   *   answers nothing, the summary is the segment's first and last user messages.
   */
  constructor(llmInvoker?: (prompt: string) => Promise<string>) {
    this.llmInvoker = llmInvoker;
  }

  async compact(
    input: CompactionInput,
    config: InfiniteContextConfig,
  ): Promise<CompactionResult> {
    const startTime = Date.now();
    const { messages } = input;

    // The newest turns stay as they are; see compactionSplitIndex.
    const splitIdx = compactionSplitIndex(messages.length, config.preserveRecentTurns);
    if (splitIdx <= 0) {
      // Nothing to compact.
      return this.noopResult(messages, startTime);
    }

    const toCompact = messages.slice(0, splitIdx);
    const toKeep = messages.slice(splitIdx);

    // Calculate input tokens.
    const inputTokens = toCompact.reduce((s, m) => s + m.tokenEstimate, 0);

    // Build the summarization prompt.
    const targetTokens = Math.max(
      100,
      Math.ceil(inputTokens / config.targetCompressionRatio),
    );
    const conversationText = toCompact
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n');

    const prompt = [
      'Summarize this conversation segment concisely, preserving:',
      '- All decisions made and their rationale',
      '- Action items and commitments',
      '- Named entities (people, projects, URLs, file paths)',
      '- Technical details that affect ongoing work',
      '- Any unresolved questions or open threads',
      '',
      'Drop: greetings, filler, repeated information, verbose explanations of things already decided.',
      `Target length: ~${targetTokens} tokens.`,
      '',
      `Conversation (turns ${toCompact[0].turnIndex}–${toCompact[toCompact.length - 1].turnIndex}):`,
      '',
      conversationText,
      '',
      'Summary:',
    ].join('\n');

    let summary: string | undefined;
    let droppedContent: string[] = [];

    if (this.llmInvoker) {
      try {
        const written = (await this.llmInvoker(prompt)).trim();
        if (written) {
          summary = written;
          droppedContent = this.detectDropped(toCompact, written);
        }
      } catch {
        // The extractive summary below.
      }
    }
    // No summarizer, a failed call or an empty answer: the segment's first and
    // last user messages stand for it, within the tokens it held less the
    // summary message's header, after an earlier summary in it, carried forward
    // as far as the window has room for it.
    summary ??= this.fallbackSummary(
      toCompact,
      Math.max(25, inputTokens - 20),
      summaryRoom(input, config, toKeep.reduce((s, m) => s + m.tokenEstimate, 0), 20),
    );
    const entities = this.extractEntities(summary);

    const outputTokens = estimateTokens(summary);
    const turnRange: [number, number] = [
      toCompact[0].turnIndex,
      toCompact[toCompact.length - 1].turnIndex,
    ];

    // Build the summary message that replaces compacted messages.
    const summaryMessage: ContextMessage = {
      role: 'system',
      content: `[Conversation summary — turns ${turnRange[0]}–${turnRange[1]}, ${inputTokens} tokens compressed to ${outputTokens}]\n${summary}`,
      timestamp: Date.now(),
      turnIndex: toCompact[0].turnIndex,
      tokenEstimate: outputTokens + 20, // overhead for the header
      compacted: true,
    };

    const entryId = generateId();

    const node: SummaryChainNode = {
      id: `chain-${entryId}`,
      level: 0,
      turnRange,
      summary,
      tokenEstimate: outputTokens,
      createdAt: Date.now(),
      childIds: [],
      entities,
      compactionEntryId: entryId,
    };

    const entry: CompactionEntry = {
      id: entryId,
      timestamp: Date.now(),
      turnRange,
      strategy: 'sliding',
      inputTokens,
      outputTokens,
      compressionRatio:
        outputTokens > 0
          ? Math.round((inputTokens / outputTokens) * 10) / 10
          : inputTokens,
      summary,
      droppedContent,
      preservedEntities: entities,
      tracesCreated: [],
      emotionalContext: input.emotionalContext,
      durationMs: Date.now() - startTime,
    };

    return {
      messages: [summaryMessage, ...toKeep],
      newNodes: [node],
      entry,
      tracesToEncode: [],
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Extract likely entity names from summary text. */
  private extractEntities(text: string): string[] {
    const entities = new Set<string>();

    // File paths.
    const pathMatches = text.match(/[\w/.-]+\.\w{1,5}/g);
    if (pathMatches) {
      for (const p of pathMatches) entities.add(p);
    }

    // URLs.
    const urlMatches = text.match(/https?:\/\/[^\s)]+/g);
    if (urlMatches) {
      for (const u of urlMatches) entities.add(u);
    }

    // Capitalized multi-word names (simple heuristic).
    const nameMatches = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
    if (nameMatches) {
      for (const n of nameMatches) entities.add(n);
    }

    // Backtick-quoted identifiers.
    const codeMatches = text.match(/`[^`]+`/g);
    if (codeMatches) {
      for (const c of codeMatches) entities.add(c.replace(/`/g, ''));
    }

    return Array.from(entities).slice(0, 50); // cap at 50
  }

  /** Detect content fragments from compacted messages missing from summary. */
  private detectDropped(
    messages: ContextMessage[],
    summary: string,
  ): string[] {
    const dropped: string[] = [];
    const summaryLower = summary.toLowerCase();

    for (const msg of messages) {
      // Check if any significant user statements are absent.
      if (msg.role !== 'user' || msg.content.length < 30) continue;
      // Extract key phrases (first sentence or up to 80 chars).
      const firstSentence = msg.content.split(/[.!?\n]/)[0].trim();
      if (
        firstSentence.length > 15 &&
        !summaryLower.includes(firstSentence.toLowerCase().slice(0, 30))
      ) {
        dropped.push(
          `Turn ${msg.turnIndex}: "${firstSentence.slice(0, 100)}"`,
        );
      }
    }

    return dropped.slice(0, 20); // cap
  }

  /**
   * Crude fallback when LLM is unavailable: the first and last user messages,
   * within `maxTokens`, after a summary an earlier compaction left in the
   * segment, carried forward as far as `roomTokens` leaves room for it.
   */
  private fallbackSummary(messages: ContextMessage[], maxTokens: number, roomTokens: number): string {
    const earlier = earlierSummaries(messages);
    const userMsgs = messages.filter((m) => m.role === 'user');
    let anchors = '';
    if (userMsgs.length > 0) {
      // Take first and last user messages as anchors.
      const first = userMsgs[0].content.slice(0, 200);
      const last = userMsgs[userMsgs.length - 1].content.slice(0, 200);
      anchors = userMsgs.length === 1 ? `User discussed: ${first}` : `Conversation started with: ${first}\n\nMost recently discussed: ${last}`;
    }
    return extractiveSummary(earlier, anchors, maxTokens, roomTokens) || 'Previous conversation context.';
  }

  /** No-op result when nothing needs compaction. */
  private noopResult(
    messages: ContextMessage[],
    startTime: number,
  ): CompactionResult {
    return {
      messages,
      newNodes: [],
      entry: {
        id: generateId(),
        timestamp: Date.now(),
        turnRange: [0, 0],
        strategy: 'sliding',
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
