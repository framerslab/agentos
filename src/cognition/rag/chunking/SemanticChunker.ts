/**
 * @fileoverview Semantic text chunker that splits on natural boundaries instead
 * of fixed character counts.
 *
 * Splitting, in order:
 * 1. **Heading boundaries** — Markdown headings (`# ## ###` etc.) start new chunks
 * 2. **Paragraph boundaries** — Double newlines are the preferred split point
 * 3. **Sentence boundaries** — Period/exclamation/question followed by whitespace
 * 4. **Fixed-size fallback** — Only when paragraphs/sentences exceed `maxSize`
 *
 * Each chunk preserves complete sentences/paragraphs and includes configurable
 * overlap context from the previous chunk for retrieval continuity.
 *
 * Special handling:
 * - **Code blocks** (fenced with triple backticks) stay one chunk unless longer than `maxSize`; a fence left open
 *   runs to the end of the text
 * - **Markdown headings** always start new chunks for better section-level retrieval
 * - **Small fragments** below `minSize` are merged with the previous chunk
 *
 * @module agentos/rag/chunking/SemanticChunker
 * @see RetrievalAugmentor for integration with the RAG pipeline
 */

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Configuration for the semantic chunker.
 *
 * @interface SemanticChunkerConfig
 */
export interface SemanticChunkerConfig {
  /** Target chunk size in characters. Default: 1000. */
  targetSize?: number;
  /** Maximum chunk size — hard limit before forced splitting. Default: 2000. */
  maxSize?: number;
  /** Minimum chunk size — fragments below this merge with previous. Default: 200. */
  minSize?: number;
  /** Overlap characters from previous chunk prepended for context. Default: 100. */
  overlap?: number;
  /** Whether to detect and preserve fenced code blocks intact. Default: true. */
  preserveCodeBlocks?: boolean;
  /** Whether to detect markdown headings as chunk-start boundaries. Default: true. */
  respectHeadings?: boolean;
}

/**
 * A semantically coherent text chunk produced by the chunker.
 *
 * @interface SemanticChunk
 * @property {string} text - The chunk text content (may include overlap prefix).
 * @property {number} index - 0-based sequence index within the chunked document.
 * @property {number} startOffset - Character offset in the original text where this chunk begins.
 * @property {number} endOffset - Character offset in the original text where this chunk ends.
 * @property {BoundaryType} boundaryType - Type of boundary that determined this chunk's split.
 * @property {Record<string, unknown>} [metadata] - Pass-through metadata from the caller.
 */
export interface SemanticChunk {
  /** The chunk text content (may include overlap prefix from previous chunk). */
  text: string;
  /** 0-based sequence index within the chunked document. */
  index: number;
  /** Character offset in the original text where this chunk begins (before overlap). */
  startOffset: number;
  /** Character offset in the original text where this chunk ends. */
  endOffset: number;
  /** Type of boundary that determined this chunk's split point. */
  boundaryType: BoundaryType;
  /** Pass-through metadata from the caller. */
  metadata?: Record<string, unknown>;
}

/**
 * The type of boundary used to split a chunk.
 */
export type BoundaryType = 'paragraph' | 'sentence' | 'heading' | 'code-block' | 'fixed';

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Regex matching Markdown heading lines (# through ######).
 * Captures the heading line at the start of a string or after a newline.
 */
const HEADING_RE = /(?:^|\n)(#{1,6}\s+.+)/;

/**
 * Regex for fenced code block start/end markers.
 */
const CODE_FENCE_RE = /^```/;

/**
 * Regex for sentence boundaries: `. ` or `! ` or `? ` followed by an
 * uppercase letter or end of text. Also matches after newline.
 */
const SENTENCE_BOUNDARY_RE = /[.!?]\s+(?=[A-Z\n])|[.!?]\s*$/;

// ── Semantic Chunker ──────────────────────────────────────────────────────

/**
 * Semantic text chunker that splits on natural boundaries instead of
 * fixed character counts.
 *
 * Produces chunks that are more semantically coherent than fixed-size
 * splitting, improving retrieval quality by keeping related ideas together.
 *
 * @example Basic usage
 * ```typescript
 * const chunker = new SemanticChunker({ targetSize: 800, overlap: 50 });
 * const chunks = chunker.chunk(markdownDocument);
 * for (const c of chunks) {
 *   console.log(`Chunk ${c.index} (${c.boundaryType}): ${c.text.length} chars`);
 * }
 * ```
 *
 * @example Preserving code blocks
 * ```typescript
 * const chunker = new SemanticChunker({
 *   targetSize: 1000,
 *   maxSize: 3000, // Allow larger chunks for code blocks
 *   preserveCodeBlocks: true,
 * });
 * const chunks = chunker.chunk(technicalDoc);
 * ```
 */
export class SemanticChunker {
  /** Resolved configuration with defaults applied. */
  private config: Required<SemanticChunkerConfig>;

  /**
   * Creates a new SemanticChunker.
   *
   * @param {SemanticChunkerConfig} [config] - Chunking configuration.
   * @param {number} [config.targetSize=1000] - Target chunk size in characters.
   * @param {number} [config.maxSize=2000] - Maximum chunk size (hard limit).
   * @param {number} [config.minSize=200] - Minimum chunk size before merging.
   * @param {number} [config.overlap=100] - Overlap characters from previous chunk.
   * @param {boolean} [config.preserveCodeBlocks=true] - Keep code blocks intact.
   * @param {boolean} [config.respectHeadings=true] - Start new chunks at headings.
   *
   * @example
   * ```typescript
   * const chunker = new SemanticChunker({
   *   targetSize: 800,
   *   maxSize: 1500,
   *   overlap: 80,
   * });
   * ```
   */
  constructor(config?: SemanticChunkerConfig) {
    this.config = {
      targetSize: config?.targetSize ?? 1000,
      maxSize: config?.maxSize ?? 2000,
      minSize: config?.minSize ?? 200,
      overlap: config?.overlap ?? 100,
      preserveCodeBlocks: config?.preserveCodeBlocks ?? true,
      respectHeadings: config?.respectHeadings ?? true,
    };
  }

  /**
   * Splits text into semantically coherent chunks.
   *
   * Pipeline:
   * 1. Pre-process: extract code blocks (if `preserveCodeBlocks`)
   * 2. Split by headings (if `respectHeadings`) — each heading starts a new section
   * 3. Within sections, split by paragraphs (double newline)
   * 4. If a paragraph exceeds `maxSize`, split by sentences
   * 5. If a sentence exceeds `maxSize`, split at word boundaries (fixed fallback)
   * 6. Merge small fragments (< `minSize`) with the previous chunk
   * 7. Add overlap from the end of the previous chunk to each chunk
   *
   * A text that is empty or white space alone gives no chunks: `chunk()` answers `[]` and does not throw. A code
   * fence left open runs to the end of the text as one code block.
   *
   * @param {string} text - The full text to chunk.
   * @param {Record<string, unknown>} [metadata] - Optional metadata attached to all chunks.
   * @returns {SemanticChunk[]} Array of chunks in order; empty for an empty or white-space text.
   *
   * @example
   * ```typescript
   * const chunks = chunker.chunk(
   *   '# Introduction\n\nFirst paragraph.\n\n## Details\n\nSecond paragraph.',
   *   { source: 'docs/readme.md' },
   * );
   * // chunks[0].boundaryType === 'heading'
   * // chunks[0].text includes "# Introduction\n\nFirst paragraph."
   * ```
   */
  chunk(text: string, metadata?: Record<string, unknown>): SemanticChunk[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    // Step 1: Split into raw segments by headings and code blocks
    const rawSegments = this.splitByStructure(text);

    // Step 2: Split oversized segments further by paragraphs, sentences, or fixed
    const refinedSegments: Array<{ text: string; offset: number; boundary: BoundaryType }> = [];
    for (const segment of rawSegments) {
      if (segment.text.length <= this.config.maxSize) {
        refinedSegments.push(segment);
      } else {
        // Further split this oversized segment
        const subSegments = this.splitOversizedSegment(segment.text, segment.offset);
        refinedSegments.push(...subSegments);
      }
    }

    // Step 3: Merge fragments smaller than minSize with the previous chunk
    const merged = this.mergeSmallFragments(refinedSegments);

    // Step 4: Build final chunks with overlap
    const chunks: SemanticChunk[] = [];
    for (let i = 0; i < merged.length; i++) {
      const segment = merged[i];
      let chunkText = segment.text;

      // Add overlap from previous chunk
      if (i > 0 && this.config.overlap > 0) {
        const prevText = merged[i - 1].text;
        const overlapText = prevText.slice(-this.config.overlap);
        if (overlapText.length > 0) {
          chunkText = overlapText + chunkText;
        }
      }

      chunks.push({
        text: chunkText,
        index: i,
        startOffset: segment.offset,
        endOffset: segment.offset + segment.text.length,
        boundaryType: segment.boundary,
        metadata,
      });
    }

    return chunks;
  }

  /**
   * Splits text into structural segments based on headings and code blocks.
   *
   * This is the first pass that identifies major structural boundaries:
   * - Markdown headings always start new segments
   * - Fenced code blocks are kept as single segments when possible
   * - Remaining text is split by paragraphs (double newline)
   *
   * @param {string} text - Full document text.
   * @returns {Array<{ text: string; offset: number; boundary: BoundaryType }>} Segments.
   */
  private splitByStructure(
    text: string,
  ): Array<{ text: string; offset: number; boundary: BoundaryType }> {
    const segments: Array<{ text: string; offset: number; boundary: BoundaryType }> = [];
    const lines = text.split('\n');
    let currentSegment = '';
    let currentOffset = 0;
    let segmentStart = 0;
    let currentBoundary: BoundaryType = 'paragraph';
    let inCodeBlock = false;
    let codeBlockStart = 0;
    let codeBlockContent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineOffset = currentOffset;
      currentOffset += line.length + 1; // +1 for the newline

      // Handle code block boundaries
      if (this.config.preserveCodeBlocks && CODE_FENCE_RE.test(line.trim())) {
        if (!inCodeBlock) {
          // Starting a code block: flush the gathering segment and empty it, so a fence left open to the end of the
          // text, which the end of this loop flushes as a code block, does not flush that text a second time.
          if (currentSegment.trim().length > 0) {
            segments.push({
              text: currentSegment,
              offset: segmentStart,
              boundary: currentBoundary,
            });
          }
          currentSegment = '';
          inCodeBlock = true;
          codeBlockStart = lineOffset;
          codeBlockContent = line + '\n';
          continue;
        } else {
          // Ending a code block
          codeBlockContent += line;
          segments.push({
            text: codeBlockContent,
            offset: codeBlockStart,
            boundary: 'code-block',
          });
          inCodeBlock = false;
          codeBlockContent = '';
          currentSegment = '';
          segmentStart = currentOffset;
          currentBoundary = 'paragraph';
          continue;
        }
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      // Handle headings
      if (this.config.respectHeadings && /^#{1,6}\s+/.test(line)) {
        // Flush current segment
        if (currentSegment.trim().length > 0) {
          segments.push({
            text: currentSegment,
            offset: segmentStart,
            boundary: currentBoundary,
          });
        }
        currentSegment = line + '\n';
        segmentStart = lineOffset;
        currentBoundary = 'heading';
        continue;
      }

      // Check for paragraph boundary (empty line)
      if (line.trim() === '' && currentSegment.trim().length > 0) {
        // Check if current segment is at or near target size — if so, split here
        if (currentSegment.length >= this.config.targetSize) {
          segments.push({
            text: currentSegment,
            offset: segmentStart,
            boundary: currentBoundary,
          });
          currentSegment = '';
          segmentStart = currentOffset;
          currentBoundary = 'paragraph';
          continue;
        }
      }

      // Accumulate into current segment
      currentSegment += line + '\n';
    }

    // Handle unclosed code block
    if (inCodeBlock && codeBlockContent.trim().length > 0) {
      segments.push({
        text: codeBlockContent,
        offset: codeBlockStart,
        boundary: 'code-block',
      });
    }

    // Flush remaining segment
    if (currentSegment.trim().length > 0) {
      segments.push({
        text: currentSegment,
        offset: segmentStart,
        boundary: currentBoundary,
      });
    }

    return segments;
  }

  /**
   * Further splits an oversized segment by paragraph and sentence boundaries.
   *
   * Called when a structural segment exceeds `maxSize`. Tries progressively
   * smaller split granularity:
   * 1. Paragraph splits (double newline)
   * 2. Sentence splits (period/exclamation/question + space + uppercase)
   * 3. Word boundary splits (fixed-size fallback)
   *
   * @param {string} text - Oversized segment text.
   * @param {number} baseOffset - Character offset of this segment in the original text.
   * @returns {Array<{ text: string; offset: number; boundary: BoundaryType }>} Sub-segments.
   */
  private splitOversizedSegment(
    text: string,
    baseOffset: number,
  ): Array<{ text: string; offset: number; boundary: BoundaryType }> {
    // Try paragraph splitting first
    const paragraphs = text.split(/\n\s*\n/);
    if (paragraphs.length > 1) {
      const results: Array<{ text: string; offset: number; boundary: BoundaryType }> = [];
      let accumulated = '';
      let accOffset = baseOffset;
      let runningOffset = baseOffset;

      for (const para of paragraphs) {
        if (accumulated.length > 0 && accumulated.length + para.length + 2 > this.config.targetSize) {
          // Flush accumulated
          if (accumulated.length > this.config.maxSize) {
            // Even accumulated is too large — split by sentences
            results.push(...this.splitBySentences(accumulated, accOffset));
          } else {
            results.push({ text: accumulated, offset: accOffset, boundary: 'paragraph' });
          }
          accumulated = para;
          accOffset = runningOffset;
        } else {
          if (accumulated.length > 0) {
            accumulated += '\n\n' + para;
          } else {
            accumulated = para;
            accOffset = runningOffset;
          }
        }
        runningOffset += para.length + 2; // +2 for the \n\n separator
      }

      // Flush remaining
      if (accumulated.trim().length > 0) {
        if (accumulated.length > this.config.maxSize) {
          results.push(...this.splitBySentences(accumulated, accOffset));
        } else {
          results.push({ text: accumulated, offset: accOffset, boundary: 'paragraph' });
        }
      }

      return results;
    }

    // No paragraph boundaries — try sentences
    return this.splitBySentences(text, baseOffset);
  }

  /**
   * Splits text by sentence boundaries.
   *
   * Detects sentence endings (`.` `!` `?` followed by whitespace) and accumulates
   * sentences until reaching `targetSize`. Falls back to word-boundary splitting
   * for sentences exceeding `maxSize`.
   *
   * @param {string} text - Text to split by sentences.
   * @param {number} baseOffset - Character offset in the original text.
   * @returns {Array<{ text: string; offset: number; boundary: BoundaryType }>} Sentence-split chunks.
   */
  private splitBySentences(
    text: string,
    baseOffset: number,
  ): Array<{ text: string; offset: number; boundary: BoundaryType }> {
    // Split on sentence boundaries
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length <= 1) {
      // No sentence boundaries — fall back to fixed splitting
      return this.splitFixed(text, baseOffset);
    }

    const results: Array<{ text: string; offset: number; boundary: BoundaryType }> = [];
    let accumulated = '';
    let accOffset = baseOffset;
    let runningOffset = baseOffset;

    for (const sentence of sentences) {
      if (accumulated.length > 0 && accumulated.length + sentence.length + 1 > this.config.targetSize) {
        if (accumulated.length > this.config.maxSize) {
          results.push(...this.splitFixed(accumulated, accOffset));
        } else {
          results.push({ text: accumulated, offset: accOffset, boundary: 'sentence' });
        }
        accumulated = sentence;
        accOffset = runningOffset;
      } else {
        if (accumulated.length > 0) {
          accumulated += ' ' + sentence;
        } else {
          accumulated = sentence;
          accOffset = runningOffset;
        }
      }
      runningOffset += sentence.length + 1; // +1 for the space separator
    }

    if (accumulated.trim().length > 0) {
      if (accumulated.length > this.config.maxSize) {
        results.push(...this.splitFixed(accumulated, accOffset));
      } else {
        results.push({ text: accumulated, offset: accOffset, boundary: 'sentence' });
      }
    }

    return results;
  }

  /**
   * Last-resort fixed-size splitting at word boundaries.
   *
   * Splits text at the last space before `targetSize` to avoid breaking words.
   * This is only used when no paragraph or sentence boundaries are available
   * within a segment that exceeds `maxSize`.
   *
   * @param {string} text - Text to split at word boundaries.
   * @param {number} baseOffset - Character offset in the original text.
   * @returns {Array<{ text: string; offset: number; boundary: BoundaryType }>} Fixed-size chunks.
   */
  private splitFixed(
    text: string,
    baseOffset: number,
  ): Array<{ text: string; offset: number; boundary: BoundaryType }> {
    const results: Array<{ text: string; offset: number; boundary: BoundaryType }> = [];
    let position = 0;

    while (position < text.length) {
      let end = Math.min(position + this.config.targetSize, text.length);

      // If not at the end, try to break at a word boundary
      if (end < text.length) {
        const lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > position + this.config.minSize) {
          end = lastSpace;
        }
      }

      const chunk = text.slice(position, end).trim();
      if (chunk.length > 0) {
        results.push({
          text: chunk,
          offset: baseOffset + position,
          boundary: 'fixed',
        });
      }

      position = end;
      // Skip whitespace after split point
      while (position < text.length && text[position] === ' ') {
        position++;
      }
    }

    return results;
  }

  /**
   * Merges fragments smaller than `minSize` with the previous chunk.
   *
   * Small trailing fragments (e.g., a short concluding sentence) are merged
   * backwards to prevent creating chunks that are too small for meaningful
   * embedding.
   *
   * @param {Array<{ text: string; offset: number; boundary: BoundaryType }>} segments - Input segments.
   * @returns {Array<{ text: string; offset: number; boundary: BoundaryType }>} Segments with small ones merged.
   */
  private mergeSmallFragments(
    segments: Array<{ text: string; offset: number; boundary: BoundaryType }>,
  ): Array<{ text: string; offset: number; boundary: BoundaryType }> {
    if (segments.length <= 1) return segments;

    const merged: Array<{ text: string; offset: number; boundary: BoundaryType }> = [];

    for (const segment of segments) {
      if (
        merged.length > 0 &&
        segment.text.trim().length < this.config.minSize &&
        segment.boundary !== 'heading' &&
        segment.boundary !== 'code-block'
      ) {
        // Merge with previous
        const prev = merged[merged.length - 1];
        prev.text += '\n\n' + segment.text;
      } else {
        merged.push({ ...segment });
      }
    }

    return merged;
  }
}
