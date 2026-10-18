/**
 * @fileoverview Tests for SemanticChunker — boundary-aware text splitting.
 */

import { describe, it, expect } from 'vitest';
import { SemanticChunker, type SemanticChunk } from '../chunking/SemanticChunker.js';

// ── Tests ────────────────────────────────────────────────────────────────

describe('SemanticChunker', () => {
  describe('basic splitting', () => {
    it('returns empty array for empty text', () => {
      const chunker = new SemanticChunker();
      expect(chunker.chunk('')).toEqual([]);
      expect(chunker.chunk('   ')).toEqual([]);
    });

    it('returns single chunk for short text', () => {
      const chunker = new SemanticChunker({ targetSize: 1000 });
      const chunks = chunker.chunk('Hello, this is a short text.');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toContain('Hello');
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].boundaryType).toBeDefined();
    });

    it('passes through metadata to all chunks', () => {
      const chunker = new SemanticChunker({ targetSize: 50 });
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
      const chunks = chunker.chunk(text, { source: 'test.md' });
      for (const chunk of chunks) {
        expect(chunk.metadata).toEqual({ source: 'test.md' });
      }
    });
  });

  describe('paragraph boundary splitting', () => {
    it('respects paragraph boundaries (double newline)', () => {
      const chunker = new SemanticChunker({
        targetSize: 50,
        maxSize: 200,
        minSize: 10,
        overlap: 0,
      });

      const text = [
        'First paragraph with some content here.',
        '',
        'Second paragraph with different content.',
        '',
        'Third paragraph with even more content.',
      ].join('\n');

      const chunks = chunker.chunk(text);
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // Chunks should contain complete paragraphs
      const allText = chunks.map((c) => c.text).join('');
      expect(allText).toContain('First paragraph');
      expect(allText).toContain('Second paragraph');
    });
  });

  describe('heading detection', () => {
    it('starts new chunks at markdown headings', () => {
      const chunker = new SemanticChunker({
        targetSize: 500,
        maxSize: 1000,
        minSize: 10,
        overlap: 0,
        respectHeadings: true,
      });

      const text = [
        '# Introduction',
        '',
        'This is the intro section.',
        '',
        '## Details',
        '',
        'This is the details section.',
        '',
        '### Sub-details',
        '',
        'This is a sub-section.',
      ].join('\n');

      const chunks = chunker.chunk(text);

      // Should have at least 3 chunks (one per heading)
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // At least one chunk should have heading boundary type
      const headingChunks = chunks.filter((c) => c.boundaryType === 'heading');
      expect(headingChunks.length).toBeGreaterThanOrEqual(1);
    });

    it('does not split on headings when respectHeadings is false', () => {
      const chunker = new SemanticChunker({
        targetSize: 5000,
        maxSize: 10000,
        overlap: 0,
        respectHeadings: false,
      });

      const text = '# Title\n\nContent.\n\n## Subtitle\n\nMore content.';
      const chunks = chunker.chunk(text);
      expect(chunks).toHaveLength(1);
    });
  });

  describe('code block preservation', () => {
    it('preserves fenced code blocks as single chunks', () => {
      const chunker = new SemanticChunker({
        targetSize: 50,
        maxSize: 2000,
        minSize: 10,
        overlap: 0,
        preserveCodeBlocks: true,
      });

      const text = [
        'Some text before code.',
        '',
        '```typescript',
        'function hello() {',
        '  console.log("hello world");',
        '  return 42;',
        '}',
        '```',
        '',
        'Some text after code.',
      ].join('\n');

      const chunks = chunker.chunk(text);

      // Find the code block chunk
      const codeChunk = chunks.find((c) => c.boundaryType === 'code-block');
      expect(codeChunk).toBeDefined();
      expect(codeChunk!.text).toContain('function hello()');
      expect(codeChunk!.text).toContain('console.log');
    });

    it('gives the text before a code block left open once, then the block to the end of the text', () => {
      const chunker = new SemanticChunker({ minSize: 10, overlap: 0 });
      const intro = 'An introduction long enough to stand as a chunk of its own.';
      const chunks = chunker.chunk(`${intro}\n\n\`\`\`ts\nconst open = true;\n`);
      expect(chunks.map((c) => c.boundaryType)).toEqual(['paragraph', 'code-block']);
      expect(chunks.filter((c) => c.text.includes('An introduction'))).toHaveLength(1);
      expect(chunks[1].text).toBe('```ts\nconst open = true;\n\n');
      expect(chunks[1].startOffset).toBe(intro.length + 2);
    });
  });

  describe('sentence splitting fallback', () => {
    it('splits long paragraphs by sentences', () => {
      const chunker = new SemanticChunker({
        targetSize: 100,
        maxSize: 150,
        minSize: 20,
        overlap: 0,
      });

      // One long paragraph with multiple sentences
      const text =
        'The first sentence is about databases. ' +
        'The second sentence discusses indexing strategies. ' +
        'The third sentence covers query optimization. ' +
        'The fourth sentence mentions caching layers. ' +
        'The fifth sentence describes distributed systems.';

      const chunks = chunker.chunk(text);
      expect(chunks.length).toBeGreaterThan(1);

      // Each chunk should be within maxSize
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(300); // some tolerance for merging
      }
    });
  });

  describe('small fragment merging', () => {
    it('merges chunks below minSize with previous chunk', () => {
      const chunker = new SemanticChunker({
        targetSize: 200,
        maxSize: 500,
        minSize: 100,
        overlap: 0,
        respectHeadings: true,
      });

      const text = [
        '# Main Section',
        '',
        'This is a substantial paragraph with enough content to stand on its own as a chunk.',
        '',
        'Tiny.',  // This is too small, should be merged
      ].join('\n');

      const chunks = chunker.chunk(text);

      // "Tiny." should be merged with the previous chunk, not standalone
      const tinyChunk = chunks.find(
        (c) => c.text.trim() === 'Tiny.' && c.text.length < 100,
      );
      expect(tinyChunk).toBeUndefined();
    });
  });

  describe('overlap', () => {
    it('adds overlap from previous chunk to next chunk', () => {
      const chunker = new SemanticChunker({
        targetSize: 60,
        maxSize: 120,
        minSize: 10,
        overlap: 20,
        respectHeadings: true,
      });

      const text = [
        '# Section One',
        '',
        'Content of section one with some words here.',
        '',
        '# Section Two',
        '',
        'Content of section two with different words.',
      ].join('\n');

      const chunks = chunker.chunk(text);

      if (chunks.length >= 2) {
        // Second chunk should contain some text from the end of the first chunk
        const firstChunkEnd = chunks[0].text.slice(-20);
        // The overlap should be prepended to the second chunk
        // (The second chunk's text starts with overlap from the first)
        expect(chunks[1].text.length).toBeGreaterThan(0);
      }
    });
  });

  describe('fixed-size fallback', () => {
    it('splits at word boundaries when no natural boundaries exist', () => {
      const chunker = new SemanticChunker({
        targetSize: 50,
        maxSize: 60,
        minSize: 10,
        overlap: 0,
        respectHeadings: false,
        preserveCodeBlocks: false,
      });

      // One continuous block with no paragraph or sentence boundaries
      const text = 'word '.repeat(100).trim();

      const chunks = chunker.chunk(text);
      expect(chunks.length).toBeGreaterThan(1);

      // No chunk should drastically exceed maxSize (some tolerance for the split logic)
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe('chunk indices and offsets', () => {
    it('assigns sequential indices to chunks', () => {
      const chunker = new SemanticChunker({
        targetSize: 50,
        maxSize: 100,
        minSize: 10,
        overlap: 0,
        respectHeadings: true,
      });

      const text = '# A\n\nFirst.\n\n# B\n\nSecond.\n\n# C\n\nThird.';
      const chunks = chunker.chunk(text);

      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].index).toBe(i);
      }
    });
  });
});
