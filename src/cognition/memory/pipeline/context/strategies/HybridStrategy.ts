/**
 * HybridStrategy — Best-quality compaction using the full cognitive memory pipeline.
 *
 * Combines three approaches:
 * 1. MemoryObserver — personality-biased note extraction from conversation
 * 2. MemoryReflector — consolidation of notes into typed long-term traces
 * 3. Rolling summary — narrative continuity via SlidingSummaryStrategy
 *
 * Produces both a readable summary AND long-term memory traces, giving
 * the agent both narrative context and structured recall.
 */

import type { MemoryObserver, ObservationNote } from '../../observation/MemoryObserver.js';
import type { MemoryReflector } from '../../observation/MemoryReflector.js';
import type { MemoryTrace } from '../../../core/types.js';
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
import { earlierSummaries, withinTokens } from './extractiveSummary.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function generateId(): string {
  return `hybrid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class HybridStrategy implements ICompactionStrategy {
  readonly name = 'hybrid' as const;
  private readonly llmInvoker?: (prompt: string) => Promise<string>;
  private readonly observer?: MemoryObserver;
  private readonly reflector?: MemoryReflector;

  /**
   * @param llmInvoker - Writes the narrative summary. Without one, or when it
   *   fails or answers nothing, the summary is an earlier summary in the segment,
   *   carried forward, and the ten most important observation notes, or without
   *   notes the segment's first three user messages, cut to the tokens the
   *   segment held less the summary message's header.
   * @param observer - Extracts observation notes from the segment.
   * @param reflector - Consolidates the notes into memory traces.
   */
  constructor(
    llmInvoker?: (prompt: string) => Promise<string>,
    observer?: MemoryObserver,
    reflector?: MemoryReflector,
  ) {
    this.llmInvoker = llmInvoker;
    this.observer = observer;
    this.reflector = reflector;
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
      return this.noopResult(messages, startTime);
    }

    const toCompact = messages.slice(0, splitIdx);
    const toKeep = messages.slice(splitIdx);
    const inputTokens = toCompact.reduce((s, m) => s + m.tokenEstimate, 0);

    const turnRange: [number, number] = [
      toCompact[0].turnIndex,
      toCompact[toCompact.length - 1].turnIndex,
    ];

    // ── Phase 1: Extract observation notes via MemoryObserver ────────

    const observationNotes: ObservationNote[] = [];
    if (this.observer) {
      // Feed all compactable messages through the observer.
      for (const msg of toCompact) {
        const notes = await this.observer.observe(
          msg.role as 'user' | 'assistant',
          msg.content,
          input.emotionalContext
            ? {
                valence: input.emotionalContext.valence,
                arousal: input.emotionalContext.arousal,
                dominance: input.emotionalContext.dominance,
              }
            : undefined,
        );
        if (notes) observationNotes.push(...notes);
      }

      // Force-extract any remaining buffered content.
      const remaining = await this.observer.extractNotes(
        input.emotionalContext
          ? {
              valence: input.emotionalContext.valence,
              arousal: input.emotionalContext.arousal,
              dominance: input.emotionalContext.dominance,
            }
          : undefined,
      );
      if (remaining) observationNotes.push(...remaining);
    }

    // ── Phase 2: Consolidate notes into long-term traces via Reflector

    const tracesToEncode: Partial<MemoryTrace>[] = [];
    if (this.reflector && observationNotes.length > 0) {
      // Feed notes to reflector.
      for (const note of observationNotes) {
        const result = await this.reflector.addNotes([note]);
        if (result) {
          tracesToEncode.push(...result.traces);
        }
      }

      // Force reflect if notes remain.
      if (this.reflector.getPendingNoteCount() > 0) {
        const result = await this.reflector.reflect();
        if (result) {
          tracesToEncode.push(...result.traces);
        }
      }
    }

    // ── Phase 3: Generate narrative summary (for prompt context) ─────

    const summary = await this.generateHybridSummary(
      toCompact,
      observationNotes,
      tracesToEncode,
      config,
      // An extractive summary takes no more tokens than the segment, less the summary message's header.
      Math.max(25, inputTokens - 30),
    );

    const outputTokens = estimateTokens(summary);

    // ── Assemble result ──────────────────────────────────────────────

    const summaryMessage: ContextMessage = {
      role: 'system',
      content: [
        `[Hybrid compaction — turns ${turnRange[0]}–${turnRange[1]}]`,
        `[${inputTokens} tokens → ${outputTokens} tokens, ${observationNotes.length} observations, ${tracesToEncode.length} traces created]`,
        summary,
      ].join('\n'),
      timestamp: Date.now(),
      turnIndex: toCompact[0].turnIndex,
      tokenEstimate: outputTokens + 30,
      compacted: true,
    };

    const entryId = generateId();
    const entities = this.extractEntities(summary, observationNotes);

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
      strategy: 'hybrid',
      inputTokens,
      outputTokens,
      compressionRatio:
        outputTokens > 0
          ? Math.round((inputTokens / outputTokens) * 10) / 10
          : inputTokens,
      summary,
      droppedContent: [],
      preservedEntities: entities,
      tracesCreated: tracesToEncode
        .filter((t) => t.id)
        .map((t) => t.id as string),
      observationNotes,
      emotionalContext: input.emotionalContext,
      durationMs: Date.now() - startTime,
    };

    return {
      messages: [summaryMessage, ...toKeep],
      newNodes: [node],
      entry,
      tracesToEncode,
    };
  }

  // ── Summary generation ─────────────────────────────────────────────

  private async generateHybridSummary(
    messages: ContextMessage[],
    notes: ObservationNote[],
    traces: Partial<MemoryTrace>[],
    config: InfiniteContextConfig,
    maxFallbackTokens: number,
  ): Promise<string> {
    const conversationText = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n');
    const inputTokens = estimateTokens(conversationText);
    const targetTokens = Math.max(
      120,
      Math.ceil(inputTokens / config.targetCompressionRatio),
    );

    // Build context from extracted notes and traces.
    const notesSummary =
      notes.length > 0
        ? `\n\nExtracted observations (${notes.length}):\n${notes
            .slice(0, 15)
            .map((n) => `- [${n.type}] ${n.content} (importance: ${n.importance.toFixed(2)})`)
            .join('\n')}`
        : '';

    const tracesSummary =
      traces.length > 0
        ? `\n\nConsolidated memory traces (${traces.length}):\n${traces
            .slice(0, 10)
            .map((t) => `- [${t.type}/${t.scope}] ${t.content?.slice(0, 150)}`)
            .join('\n')}`
        : '';

    const prompt = [
      'Create a rich conversation summary that serves as context for an ongoing conversation.',
      'You have access to both the raw conversation AND extracted cognitive observations.',
      '',
      'Structure your summary as:',
      '1. **Key context**: What the conversation is about, who is involved',
      '2. **Decisions & outcomes**: What was decided, built, or resolved',
      '3. **Open threads**: Unresolved questions, pending work, next steps',
      '4. **Important details**: Technical specifics, file paths, configurations',
      '',
      `Target: ~${targetTokens} tokens.`,
      '',
      'Raw conversation:',
      conversationText,
      notesSummary,
      tracesSummary,
      '',
      'Summary:',
    ].join('\n');

    if (this.llmInvoker) {
      try {
        const written = (await this.llmInvoker(prompt)).trim();
        if (written) return written;
      } catch {
        // The extractive summary below.
      }
    }
    // No summarizer, a failed call or an empty answer: an earlier summary in
    // the segment, carried forward, and the most important observation notes
    // or the segment's first user messages stand for it, within
    // `maxFallbackTokens`, so the summary never takes more of the window than
    // the turns it replaces.
    const earlier = earlierSummaries(messages);
    const own =
      notes.length > 0
        ? [...notes]
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 10)
            .map((n) => `[${n.type}] ${n.content}`)
            .join('\n')
        : `Conversation turns ${messages[0].turnIndex}–${messages[messages.length - 1].turnIndex}: ${messages
            .filter((m) => m.role === 'user')
            .slice(0, 3)
            .map((m) => m.content.slice(0, 100))
            .join('; ')}`;
    return withinTokens([...earlier, own].join('\n\n'), maxFallbackTokens);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private extractEntities(
    summary: string,
    notes: ObservationNote[],
  ): string[] {
    const entities = new Set<string>();

    // From summary text.
    const patterns = [
      /[\w/.-]+\.\w{1,5}/g,
      /https?:\/\/[^\s)]+/g,
      /`[^`]+`/g,
    ];
    for (const p of patterns) {
      const matches = summary.match(p);
      if (matches) {
        for (const m of matches) entities.add(m.replace(/`/g, ''));
      }
    }

    // From observation notes.
    for (const note of notes) {
      if (note.entities) {
        for (const e of note.entities) entities.add(e);
      }
    }

    return Array.from(entities).slice(0, 50);
  }

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
        strategy: 'hybrid',
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
