/**
 * @fileoverview ChunkingEngine — splits raw document text into `DocumentChunk`
 * slices ready for embedding and vector-store ingestion.
 *
 * Four strategies are supported:
 *
 * - **fixed**       — split at a fixed character count with word-boundary
 *                     awareness and configurable overlap.
 * - **semantic**    — embed individual sentences and split where cosine
 *                     similarity drops below a threshold (topic boundaries).
 *                     Falls back to `fixed` when no `embedFn` is supplied.
 * - **hierarchical**— honour Markdown heading structure; each heading creates
 *                     a new chunk boundary with the heading stored in metadata.
 *                     Long sections are sub-split with `fixed`.
 * - **layout**      — preserve fenced code blocks and pipe-delimited tables as
 *                     atomic chunks; surrounding prose is split with `fixed`.
 *
 * @module memory/ingestion/ChunkingEngine
 */

import type { DocumentChunk } from '../facade/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The four supported chunking strategies.
 *
 * - `'fixed'`       — character-count split with overlap.
 * - `'semantic'`    — embedding-guided topic-boundary split.
 * - `'hierarchical'`— Markdown heading-aware split.
 * - `'layout'`      — code/table-aware split that preserves special blocks.
 */
export type ChunkStrategy = 'fixed' | 'semantic' | 'hierarchical' | 'layout';

/**
 * Options controlling how the `ChunkingEngine` splits a document.
 *
 * All fields except `strategy` are optional and fall back to sensible defaults.
 */
export interface ChunkOptions {
  /**
   * Algorithm used to split the content.
   * @see ChunkStrategy
   */
  strategy: ChunkStrategy;

  /**
   * Target character count for each produced chunk.
   * @default 512
   */
  chunkSize?: number;

  /**
   * Number of characters to overlap between consecutive chunks.
   * Prevents context loss at split boundaries.
   * @default 64
   */
  chunkOverlap?: number;

  /**
   * Async function that embeds a batch of strings into dense vectors.
   * Required for the `'semantic'` strategy; ignored by all others.
   * When omitted and `strategy` is `'semantic'`, the engine falls back to
   * the `'fixed'` strategy.
   *
   * @param texts - Batch of strings to embed.
   * @returns Promise resolving to one vector (number[]) per input string.
   */
  embedFn?: (texts: string[]) => Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Default target chunk size in characters. */
const DEFAULT_CHUNK_SIZE = 512;

/** Default overlap between consecutive chunks in characters. */
const DEFAULT_CHUNK_OVERLAP = 64;

/**
 * Cosine similarity threshold below which two consecutive sentence embeddings
 * are considered to belong to different topics.  Split points are inserted
 * wherever similarity falls below this value.
 */
const SEMANTIC_SPLIT_THRESHOLD = 0.3;

/**
 * Maximum allowed chunk character count for a semantic group before it is
 * further sub-split with the fixed strategy.  Expressed as a multiplier of
 * `chunkSize`.
 */
const SEMANTIC_MAX_CHUNK_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Helper — cosine similarity
// ---------------------------------------------------------------------------

/**
 * Computes the cosine similarity between two equal-length dense vectors.
 *
 * Returns a value in [-1, 1] where 1 means identical direction and 0 means
 * orthogonal.  Returns 0 safely when either vector is the zero vector.
 *
 * @param a - First vector.
 * @param b - Second vector.
 * @returns Cosine similarity scalar.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mA = Math.sqrt(magA);
  const mB = Math.sqrt(magB);
  if (mA === 0 || mB === 0) return 0;
  return dot / (mA * mB);
}

// ---------------------------------------------------------------------------
// Helper — fixed strategy (used internally by other strategies)
// ---------------------------------------------------------------------------

/**
 * Splits `content` into fixed-size character chunks with optional overlap,
 * breaking at word boundaries so no word is split mid-token.
 *
 * @param content     - Full text to split.
 * @param chunkSize   - Maximum character count per chunk.
 * @param chunkOverlap - Number of trailing characters from the previous chunk
 *                       included inside the next chunk's `chunkSize` limit.
 * @param startIndex  - The `DocumentChunk.index` to assign to the first
 *                      produced chunk.  Useful when merging partial results.
 * @param baseMetadata - Extra metadata fields merged into every produced chunk.
 * @returns Array of `DocumentChunk` objects in order.
 */
function fixedChunks(
  content: string,
  chunkSize: number,
  chunkOverlap: number,
  startIndex: number = 0,
  baseMetadata?: Record<string, unknown>,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let pos = 0;
  let lastEnd = 0;
  let chunkIndex = startIndex;

  while (pos < content.length) {
    // Desired end position for this window.
    let end = pos + chunkSize;

    if (end >= content.length) {
      // We've reached (or exceeded) the end — take whatever remains.
      const slice = content.slice(pos).trim();
      if (slice.length > 0) {
        chunks.push({
          content: slice,
          index: chunkIndex++,
          ...(baseMetadata ? { metadata: { ...baseMetadata } } : {}),
        });
      }
      break;
    }

    // Walk backwards from `end` until we land on a whitespace boundary so we
    // never split a word in the middle.
    while (end > pos && !/\s/.test(content[end])) {
      end--;
    }

    // Edge cases: no whitespace in the window, or none past the last cut,
    // where the walk would find that cut's whitespace again: hard-cut, so
    // every turn moves on.
    if (end <= lastEnd) {
      end = pos + chunkSize;
    }

    const slice = content.slice(pos, end).trim();
    if (slice.length > 0) {
      chunks.push({
        content: slice,
        index: chunkIndex++,
        ...(baseMetadata ? { metadata: { ...baseMetadata } } : {}),
      });
    }

    lastEnd = end;
    // Advance, stepping back by `chunkOverlap` characters, and always past
    // this window's start, so the loop ends on every input.
    const next = end - chunkOverlap;
    pos = next > pos ? next : end;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// ChunkingEngine
// ---------------------------------------------------------------------------

/**
 * Splits raw document text into an ordered array of `DocumentChunk` objects
 * suitable for embedding and storage in a vector index.
 *
 * @example
 * ```typescript
 * const engine = new ChunkingEngine();
 * const chunks = await engine.chunk(content, { strategy: 'fixed', chunkSize: 512 });
 * ```
 */
export class ChunkingEngine {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Chunks the provided `content` string according to the given `options`.
   *
   * All strategy implementations are async to accommodate the optional
   * `embedFn` used by the semantic strategy.
   *
   * @param content - Full document text to split.
   * @param options - Chunking strategy and tuning parameters.
   * @returns Ordered array of `DocumentChunk` objects with sequential indices.
   */
  async chunk(content: string, options: ChunkOptions): Promise<DocumentChunk[]> {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

    if (!(chunkSize >= 1)) {
      throw new RangeError(`chunkSize must be at least 1, got ${chunkSize}`);
    }

    switch (options.strategy) {
      case 'fixed':
        return this._chunkFixed(content, chunkSize, chunkOverlap);

      case 'semantic':
        return this._chunkSemantic(content, chunkSize, chunkOverlap, options.embedFn);

      case 'hierarchical':
        return this._chunkHierarchical(content, chunkSize, chunkOverlap);

      case 'layout':
        return this._chunkLayout(content, chunkSize, chunkOverlap);

      default: {
        // TypeScript exhaustiveness guard.
        const never: never = options.strategy;
        throw new Error(`ChunkingEngine: unknown strategy "${String(never)}"`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Strategy: fixed
  // -------------------------------------------------------------------------

  /**
   * Splits content at a fixed character count with word-boundary awareness
   * and configurable overlap between consecutive chunks.
   *
   * @param content      - Text to split.
   * @param chunkSize    - Target character count per chunk.
   * @param chunkOverlap - Overlap in characters between consecutive chunks.
   * @returns Ordered `DocumentChunk[]`.
   */
  private _chunkFixed(
    content: string,
    chunkSize: number,
    chunkOverlap: number,
  ): DocumentChunk[] {
    return fixedChunks(content, chunkSize, chunkOverlap, 0);
  }

  // -------------------------------------------------------------------------
  // Strategy: semantic
  // -------------------------------------------------------------------------

  /**
   * Embeds individual sentences and inserts split points wherever the cosine
   * similarity between consecutive sentence embeddings drops below
   * {@link SEMANTIC_SPLIT_THRESHOLD} (topic boundary heuristic).
   *
   * When `embedFn` is not supplied the method falls back to `_chunkFixed`.
   *
   * Any resulting group that exceeds `2 × chunkSize` characters is further
   * sub-split with the fixed strategy.
   *
   * @param content      - Text to split.
   * @param chunkSize    - Target character count per chunk.
   * @param chunkOverlap - Overlap used when sub-splitting oversized groups.
   * @param embedFn      - Optional batch embedding function.
   * @returns Ordered `DocumentChunk[]`.
   */
  private async _chunkSemantic(
    content: string,
    chunkSize: number,
    chunkOverlap: number,
    embedFn?: (texts: string[]) => Promise<number[][]>,
  ): Promise<DocumentChunk[]> {
    // No embedding function → fall back to fixed.
    if (!embedFn) {
      return this._chunkFixed(content, chunkSize, chunkOverlap);
    }

    // Split into sentences.  We use two approaches to cover common patterns:
    //   1. Lookbehind / lookahead regex (modern engines support this).
    //   2. Simple split on terminal punctuation + whitespace as fallback.
    let sentences: string[];
    try {
      sentences = content.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.trim().length > 0);
    } catch {
      // Safari / older engines may not support lookbehind — use simpler split.
      sentences = content.split(/[.!?]\s+/).filter((s) => s.trim().length > 0);
    }

    // Degenerate case: no meaningful sentences.
    if (sentences.length === 0) {
      return this._chunkFixed(content, chunkSize, chunkOverlap);
    }

    // Single sentence: emit as one chunk.
    if (sentences.length === 1) {
      return [{ content: sentences[0].trim(), index: 0 }];
    }

    // Batch-embed all sentences.
    const embeddings = await embedFn(sentences);

    // Identify split points: positions BETWEEN sentence[i] and sentence[i+1]
    // where similarity falls below the threshold.
    const splitAfter = new Set<number>();
    for (let i = 0; i < sentences.length - 1; i++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[i + 1]);
      if (sim < SEMANTIC_SPLIT_THRESHOLD) {
        splitAfter.add(i);
      }
    }

    // Group sentences into chunks.
    const groups: string[][] = [];
    let currentGroup: string[] = [];
    for (let i = 0; i < sentences.length; i++) {
      currentGroup.push(sentences[i]);
      if (splitAfter.has(i) || i === sentences.length - 1) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    }

    // Convert groups to DocumentChunks, sub-splitting oversized ones.
    const maxGroupSize = chunkSize * SEMANTIC_MAX_CHUNK_MULTIPLIER;
    const result: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const group of groups) {
      const groupText = group.join(' ').trim();
      if (groupText.length === 0) continue;

      if (groupText.length > maxGroupSize) {
        // Sub-split the oversized group with fixed strategy.
        const subChunks = fixedChunks(groupText, chunkSize, chunkOverlap, chunkIndex);
        result.push(...subChunks);
        chunkIndex += subChunks.length;
      } else {
        result.push({ content: groupText, index: chunkIndex++ });
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Strategy: hierarchical
  // -------------------------------------------------------------------------

  /**
   * Recognises Markdown heading lines (`# H1`, `## H2`, …, `###### H6`) and
   * creates a new chunk boundary at each heading.  The heading text is stored
   * in `DocumentChunk.heading` and its level in `metadata.headingLevel`.
   *
   * Sections whose text exceeds `chunkSize` are sub-split with the fixed
   * strategy while preserving the heading metadata.
   *
   * @param content      - Markdown-formatted text.
   * @param chunkSize    - Maximum characters per output chunk.
   * @param chunkOverlap - Overlap used when sub-splitting oversized sections.
   * @returns Ordered `DocumentChunk[]`.
   */
  private _chunkHierarchical(
    content: string,
    chunkSize: number,
    chunkOverlap: number,
  ): DocumentChunk[] {
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;

    /** A raw section extracted from the document. */
    interface Section {
      heading: string | undefined;
      headingLevel: number | undefined;
      /** Parent heading stack for hierarchy tracking. */
      ancestorHeadings: string[];
      text: string;
    }

    const sections: Section[] = [];

    // Track a heading stack to capture hierarchy context.
    const headingStack: Array<{ level: number; text: string }> = [];

    // Find all heading match positions and slice between them.
    let lastMatchEnd = 0;
    let currentHeading: string | undefined;
    let currentHeadingLevel: number | undefined;
    let currentAncestors: string[] = [];

    // Collect all matches first so we can slice between them.
    const matches: Array<{ index: number; end: number; level: number; text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = headingRegex.exec(content)) !== null) {
      matches.push({
        index: m.index,
        end: m.index + m[0].length,
        level: m[1].length,
        text: m[2].trim(),
      });
    }

    if (matches.length === 0) {
      // No headings — treat entire content as a single section.
      sections.push({
        heading: undefined,
        headingLevel: undefined,
        ancestorHeadings: [],
        text: content,
      });
    } else {
      // Text before the first heading (preamble).
      const preamble = content.slice(0, matches[0].index).trim();
      if (preamble.length > 0) {
        sections.push({
          heading: undefined,
          headingLevel: undefined,
          ancestorHeadings: [],
          text: preamble,
        });
      }

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const nextIndex = i + 1 < matches.length ? matches[i + 1].index : content.length;
        // The body of this section is the text after the heading line.
        const body = content.slice(match.end, nextIndex).trim();

        // Update heading stack: pop entries at the same level or deeper.
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= match.level) {
          headingStack.pop();
        }
        const ancestors = headingStack.map((h) => h.text);
        headingStack.push({ level: match.level, text: match.text });

        sections.push({
          heading: match.text,
          headingLevel: match.level,
          ancestorHeadings: ancestors,
          text: body,
        });

        void lastMatchEnd; // suppress unused-variable lint
        void currentHeading;
        void currentHeadingLevel;
        void currentAncestors;
        lastMatchEnd = nextIndex;
        currentHeading = match.text;
        currentHeadingLevel = match.level;
        currentAncestors = [...ancestors];
      }
    }

    // Materialise sections into DocumentChunks.
    const result: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const section of sections) {
      const text = section.text;
      if (text.length === 0 && section.heading === undefined) continue;

      // Build metadata common to all chunks from this section.
      const sectionMeta: Record<string, unknown> = {};
      if (section.headingLevel !== undefined) {
        sectionMeta.headingLevel = section.headingLevel;
      }
      if (section.ancestorHeadings.length > 0) {
        sectionMeta.ancestorHeadings = section.ancestorHeadings;
      }

      if (text.length === 0) {
        // Heading with no body — emit an empty-content chunk.
        result.push({
          content: section.heading ?? '',
          index: chunkIndex++,
          heading: section.heading,
          metadata: Object.keys(sectionMeta).length > 0 ? sectionMeta : undefined,
        });
        continue;
      }

      if (text.length <= chunkSize) {
        // Fits in a single chunk.
        result.push({
          content: text,
          index: chunkIndex++,
          heading: section.heading,
          metadata: Object.keys(sectionMeta).length > 0 ? sectionMeta : undefined,
        });
      } else {
        // Sub-split the section body with the fixed strategy, preserving heading
        // metadata on every produced sub-chunk.
        const subChunks = fixedChunks(text, chunkSize, chunkOverlap, chunkIndex, sectionMeta);
        for (const sc of subChunks) {
          result.push({
            ...sc,
            heading: section.heading,
          });
          chunkIndex++;
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Strategy: layout
  // -------------------------------------------------------------------------

  /**
   * Detects fenced code blocks (``` … ```) and pipe-delimited tables and
   * emits each as an atomic chunk (never split mid-block).  Surrounding prose
   * is split with the fixed strategy.
   *
   * Chunk metadata:
   * - Code blocks:  `{ type: 'code' }`
   * - Tables:       `{ type: 'table' }`
   * - Prose:        no special metadata.
   *
   * @param content      - Text potentially containing code blocks and tables.
   * @param chunkSize    - Target character count for prose chunks.
   * @param chunkOverlap - Overlap for prose fixed-splits.
   * @returns Ordered `DocumentChunk[]`.
   */
  private _chunkLayout(
    content: string,
    chunkSize: number,
    chunkOverlap: number,
  ): DocumentChunk[] {
    /**
     * A segment extracted from the raw content, typed as prose, code, or
     * table.
     */
    interface Segment {
      kind: 'prose' | 'code' | 'table';
      text: string;
    }

    const segments: Segment[] = [];
    const lines = content.split('\n');
    let i = 0;

    while (i < lines.length) {
      // ── Fenced code block ────────────────────────────────────────────────
      if (/^```/.test(lines[i])) {
        // Flush any preceding prose first (handled after the block ends).
        const fence = lines[i].match(/^(`{3,})/)?.[1] ?? '```';
        const blockLines: string[] = [lines[i]];
        i++;
        while (i < lines.length && !lines[i].startsWith(fence)) {
          blockLines.push(lines[i]);
          i++;
        }
        // Include the closing fence if present.
        if (i < lines.length) {
          blockLines.push(lines[i]);
          i++;
        }
        segments.push({ kind: 'code', text: blockLines.join('\n') });
        continue;
      }

      // ── Table block ───────────────────────────────────────────────────────
      // A table is a contiguous run of lines where every non-blank line
      // contains at least one `|` pipe character.
      if (/\|/.test(lines[i])) {
        const tableLines: string[] = [];
        while (i < lines.length && (lines[i].trim() === '' || /\|/.test(lines[i]))) {
          // Stop accumulating if we hit a blank line after table content.
          if (lines[i].trim() === '' && tableLines.length > 0) {
            break;
          }
          tableLines.push(lines[i]);
          i++;
        }
        if (tableLines.some((l) => /\|/.test(l))) {
          segments.push({ kind: 'table', text: tableLines.join('\n') });
        } else {
          // No actual pipe content — treat as prose.
          segments.push({ kind: 'prose', text: tableLines.join('\n') });
        }
        continue;
      }

      // ── Prose line ───────────────────────────────────────────────────────
      // Accumulate lines until we hit a code fence or table.
      const proseLines: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i]) && !/\|/.test(lines[i])) {
        proseLines.push(lines[i]);
        i++;
      }
      const proseText = proseLines.join('\n').trim();
      if (proseText.length > 0) {
        segments.push({ kind: 'prose', text: proseText });
      }
    }

    // Convert segments to DocumentChunks.
    const result: DocumentChunk[] = [];
    let chunkIndex = 0;

    for (const seg of segments) {
      if (seg.text.trim().length === 0) continue;

      switch (seg.kind) {
        case 'code':
          result.push({
            content: seg.text,
            index: chunkIndex++,
            metadata: { type: 'code' },
          });
          break;

        case 'table':
          result.push({
            content: seg.text,
            index: chunkIndex++,
            metadata: { type: 'table' },
          });
          break;

        case 'prose': {
          // Split prose with the fixed strategy.
          const proseChunks = fixedChunks(seg.text, chunkSize, chunkOverlap, chunkIndex);
          result.push(...proseChunks);
          chunkIndex += proseChunks.length;
          break;
        }
      }
    }

    return result;
  }
}
