/**
 * @fileoverview Tests for ChunkingEngine — all four chunking strategies.
 *
 * Test coverage:
 *   fixed strategy:
 *     1. 1000-char string, chunkSize=300, overlap=50 → 4 chunks, each ≤300 chars, overlapping
 *     2. word-boundary enforcement (no mid-word splits)
 *   semantic strategy:
 *     3. with embedFn — mock embeddings drive topic-boundary splits
 *     4. without embedFn — falls back to fixed strategy
 *   hierarchical strategy:
 *     5. markdown with H1/H2 headings → correct heading metadata
 *     6. long section exceeding chunkSize → sub-split correctly
 *   layout strategy:
 *     7. content with code block → atomic chunk with type:'code'
 *     8. content with table → atomic chunk with type:'table'
 *     9. mixed prose + code + prose → 3 chunks in correct order
 *
 * @module memory/ingestion/__tests__/chunking.test
 */

import { Buffer } from 'node:buffer';
import * as vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { ChunkingEngine } from '../ChunkingEngine.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic string of `n` characters using a repeating alphabet
 * pattern with word separators so word-boundary logic has something to work
 * with.
 *
 * @param n - Total character count desired.
 * @returns A string of exactly `n` characters.
 */
function buildWordyString(n: number): string {
  // Each "word" is 8 chars followed by a space = 9 chars per word cycle.
  const word = 'abcdefgh';
  const parts: string[] = [];
  let built = 0;
  while (built < n) {
    const remaining = n - built;
    if (remaining >= 9) {
      parts.push(word + ' ');
      built += 9;
    } else {
      parts.push(word.slice(0, remaining));
      built += remaining;
    }
  }
  return parts.join('').slice(0, n);
}

describe('ChunkingEngine fixed cut progress', () => {
  const prose = buildWordyString(2_700);
  const unbrokenRun = Buffer.from(
    Array.from({ length: 975 }, (_, index) => index % 256),
  ).toString('base64');
  const longContent = `${prose}${unbrokenRun} ${prose}`;

  it('finishes fixed cuts around a long base64 run', async () => {
    const engine = new ChunkingEngine();
    const run = () => engine.chunk(longContent, {
      strategy: 'fixed',
      chunkSize: 1_200,
      chunkOverlap: 150,
    });
    // These strategies cut synchronously, so the VM timeout bounds the loop.
    const chunks = await (vm.runInNewContext('run()', { run }, { timeout: 1_000 }) as ReturnType<typeof run>);

    expect(chunks.length).toBeLessThan(20);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1_200);
    }
    expect(chunks.some((chunk) => chunk.content.includes(unbrokenRun.slice(0, 100)))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes(unbrokenRun.slice(-100)))).toBe(true);
    expect(chunks[0].content.startsWith('abcdefgh')).toBe(true);
    expect(chunks[chunks.length - 1].content.endsWith('abcdefgh')).toBe(true);
  });

  it('finishes hierarchical cuts around a long base64 run', async () => {
    const engine = new ChunkingEngine();
    const run = () => engine.chunk(`# Notes\n\n${longContent}`, {
      strategy: 'hierarchical',
      chunkSize: 1_200,
      chunkOverlap: 150,
    });
    const chunks = await (vm.runInNewContext('run()', { run }, { timeout: 1_000 }) as ReturnType<typeof run>);

    expect(chunks.length).toBeLessThan(20);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1_200);
      expect(chunk.heading).toBe('Notes');
    }
    expect(chunks.some((chunk) => chunk.content.includes(unbrokenRun.slice(0, 100)))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes(unbrokenRun.slice(-100)))).toBe(true);
    expect(chunks[0].content.startsWith('abcdefgh')).toBe(true);
    expect(chunks[chunks.length - 1].content.endsWith('abcdefgh')).toBe(true);
  });

  it('finishes fixed cuts over long rows without spaces', async () => {
    const engine = new ChunkingEngine();
    const content = `${'y'.repeat(1_051)}\n`.repeat(20);
    const run = () => engine.chunk(content, {
      strategy: 'fixed',
      chunkSize: 1_200,
      chunkOverlap: 150,
    });
    const chunks = await (vm.runInNewContext('run()', { run }, { timeout: 1_000 }) as ReturnType<typeof run>);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1_200);
    }
  });

  it('finishes when overlap equals chunk size and rejects zero chunk size', async () => {
    const engine = new ChunkingEngine();
    const content = buildWordyString(1_000);
    const run = () => engine.chunk(content, {
      strategy: 'fixed',
      chunkSize: 100,
      chunkOverlap: 100,
    });
    const chunks = await (vm.runInNewContext('run()', { run }, { timeout: 1_000 }) as ReturnType<typeof run>);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(100);
    }

    const runWithZeroSize = () => engine.chunk(content, {
      strategy: 'fixed',
      chunkSize: 0,
      chunkOverlap: 0,
    });
    const result = vm.runInNewContext(
      'run()', { run: runWithZeroSize }, { timeout: 1_000 },
    ) as ReturnType<typeof runWithZeroSize>;
    await expect(result).rejects.toThrow(RangeError);
    await expect(result).rejects.toThrow('chunkSize');
  });

  it('rejects zero chunk size for a single semantic sentence', async () => {
    const engine = new ChunkingEngine();
    const run = () => engine.chunk('One sentence.', {
      strategy: 'semantic',
      chunkSize: 0,
      embedFn: async (texts) => texts.map(() => [1, 0]),
    });
    const result = vm.runInNewContext(
      'run()', { run }, { timeout: 1_000 },
    ) as ReturnType<typeof run>;

    await expect(result).rejects.toThrow(RangeError);
    await expect(result).rejects.toThrow('chunkSize must be at least 1, got 0');
  });

  it('preserves eight prose cuts with whole-word ends and 50-character overlap', async () => {
    const engine = new ChunkingEngine();
    const run = () => engine.chunk(buildWordyString(1_998), {
      strategy: 'fixed',
      chunkSize: 300,
      chunkOverlap: 50,
    });
    const chunks = await (vm.runInNewContext('run()', { run }, { timeout: 1_000 }) as ReturnType<typeof run>);

    expect(chunks).toHaveLength(8);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/(?:^|\s)abcdefgh$/);
      expect(chunk.content.length).toBeLessThanOrEqual(300);
    }
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].content.startsWith(chunks[index - 1].content.slice(-50))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ChunkingEngine — fixed strategy
// ---------------------------------------------------------------------------

describe('ChunkingEngine — fixed strategy', () => {
  it('produces ~4 chunks from a 1000-char string with chunkSize=300, overlap=50', async () => {
    const engine = new ChunkingEngine();
    const content = buildWordyString(1000);
    const chunks = await engine.chunk(content, {
      strategy: 'fixed',
      chunkSize: 300,
      chunkOverlap: 50,
    });

    // With chunkSize=300 and overlap=50 the effective stride is 250 chars,
    // so a 1000-char string needs ceil(1000/250) = 4 chunks.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(6); // generous upper bound

    // Every chunk must not exceed chunkSize.
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(300);
    }

    // Consecutive chunks must share an overlapping tail/head.
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i].content.slice(-30);
      const head = chunks[i + 1].content.slice(0, 60);
      // The tail of chunk[i] must appear somewhere near the start of chunk[i+1].
      const sharedWords = tail.trim().split(/\s+/).filter((w) => w.length > 2);
      if (sharedWords.length > 0) {
        const firstSharedWord = sharedWords[0];
        expect(head).toContain(firstSharedWord);
      }
    }

    // Indices must be sequential starting at 0.
    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });

  it('never splits a word in the middle', async () => {
    const engine = new ChunkingEngine();
    // Craft content where a naive cut at exactly chunkSize would land mid-word.
    // "word" = 4 chars.  With chunkSize=10 and content "1234 5678 abcd efgh",
    // a naive cut at position 10 lands at "a" in "abcd".
    // The engine should back off to the space before "abcd".
    const content = '1234 5678 abcd efgh ijkl';
    const chunks = await engine.chunk(content, {
      strategy: 'fixed',
      chunkSize: 10,
      chunkOverlap: 0,
    });

    // No chunk may end or start mid-word (i.e. chunk boundaries must be at
    // word separators, not inside a token).
    for (const chunk of chunks) {
      const trimmed = chunk.content.trim();
      // The chunk content itself should match only complete words.
      const words = trimmed.split(/\s+/);
      for (const word of words) {
        // Every "word" in our fixture is exactly 4 digits or letters.
        expect(word).toMatch(/^[a-z0-9]+$/i);
        // Confirm it is one of the original words (not a sliced fragment).
        expect(['1234', '5678', 'abcd', 'efgh', 'ijkl']).toContain(word);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ChunkingEngine — semantic strategy
// ---------------------------------------------------------------------------

describe('ChunkingEngine — semantic strategy', () => {
  it('splits at topic boundaries when embedFn is provided', async () => {
    const engine = new ChunkingEngine();

    // Two clearly separated topics joined by a topic-boundary sentence.
    // Sentences about topic A will receive similar embeddings; sentence about
    // topic B will receive a different embedding, causing a split.
    const topicASentences = [
      'The cat sat on the mat.',
      'Cats are known for their independence.',
      'A cat can sleep up to 16 hours a day.',
    ];
    const topicBSentences = [
      'Quantum mechanics describes subatomic behaviour.',
      'Particles exhibit wave-particle duality.',
      'The uncertainty principle limits simultaneous measurements.',
    ];

    const content = [...topicASentences, ...topicBSentences].join(' ');

    /**
     * Mock embedFn:
     *   - Sentences containing "cat" → embedding close to [1, 0, 0]
     *   - Sentences containing "quantum" / "particle" / "uncertainty" → close to [0, 1, 0]
     * This guarantees the cosine similarity between the last cat sentence and
     * the first quantum sentence drops well below the 0.3 threshold.
     */
    const mockEmbedFn = async (texts: string[]): Promise<number[][]> => {
      return texts.map((t) => {
        const lower = t.toLowerCase();
        if (lower.includes('cat') || lower.includes('mat') || lower.includes('sleep')) {
          return [0.99, 0.01, 0.0];
        }
        if (
          lower.includes('quantum') ||
          lower.includes('particle') ||
          lower.includes('uncertainty') ||
          lower.includes('wave') ||
          lower.includes('subatomic') ||
          lower.includes('mechanics') ||
          lower.includes('measurements')
        ) {
          return [0.01, 0.99, 0.0];
        }
        // Neutral sentence (shouldn't appear in this test).
        return [0.5, 0.5, 0.0];
      });
    };

    const chunks = await engine.chunk(content, {
      strategy: 'semantic',
      chunkSize: 512,
      chunkOverlap: 64,
      embedFn: mockEmbedFn,
    });

    // We expect the content to be split into at least 2 groups (A and B).
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // The first chunk should contain cat-related content.
    expect(chunks[0].content.toLowerCase()).toContain('cat');

    // A later chunk should contain quantum-related content.
    const quantumChunk = chunks.find((c) => c.content.toLowerCase().includes('quantum'));
    expect(quantumChunk).toBeDefined();

    // Indices sequential.
    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });

  it('falls back to fixed strategy when embedFn is not provided', async () => {
    const engine = new ChunkingEngine();
    // Long enough content to guarantee multiple fixed chunks.
    const content = buildWordyString(800);
    const chunks = await engine.chunk(content, {
      strategy: 'semantic',
      chunkSize: 200,
      chunkOverlap: 30,
      // No embedFn — should fall back.
    });

    // Fixed fallback for 800 chars with stride 170 → at least 4 chunks.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
    }
    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });
});

// ---------------------------------------------------------------------------
// ChunkingEngine — hierarchical strategy
// ---------------------------------------------------------------------------

describe('ChunkingEngine — hierarchical strategy', () => {
  it('assigns correct heading metadata for H1 and H2 sections', async () => {
    const engine = new ChunkingEngine();
    const markdown = [
      '# Introduction',
      '',
      'This is the introduction paragraph.',
      '',
      '## Background',
      '',
      'Some background information here.',
      '',
      '## Methods',
      '',
      'Describing the methods used.',
      '',
      '# Conclusion',
      '',
      'Final thoughts and conclusions.',
    ].join('\n');

    const chunks = await engine.chunk(markdown, {
      strategy: 'hierarchical',
      chunkSize: 512,
      chunkOverlap: 64,
    });

    // We expect at least 4 chunks: Introduction, Background, Methods, Conclusion.
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // Find chunks by their heading.
    const introChunk = chunks.find((c) => c.heading === 'Introduction');
    const bgChunk = chunks.find((c) => c.heading === 'Background');
    const methodsChunk = chunks.find((c) => c.heading === 'Methods');
    const conclusionChunk = chunks.find((c) => c.heading === 'Conclusion');

    expect(introChunk).toBeDefined();
    expect(bgChunk).toBeDefined();
    expect(methodsChunk).toBeDefined();
    expect(conclusionChunk).toBeDefined();

    // H1 sections: headingLevel = 1.
    expect(introChunk?.metadata?.headingLevel).toBe(1);
    expect(conclusionChunk?.metadata?.headingLevel).toBe(1);

    // H2 sections: headingLevel = 2.
    expect(bgChunk?.metadata?.headingLevel).toBe(2);
    expect(methodsChunk?.metadata?.headingLevel).toBe(2);

    // H2 chunks should record the H1 ancestor.
    expect(bgChunk?.metadata?.ancestorHeadings).toContain('Introduction');
    expect(methodsChunk?.metadata?.ancestorHeadings).toContain('Introduction');

    // Content checks.
    expect(introChunk?.content).toContain('introduction paragraph');
    expect(bgChunk?.content).toContain('background information');
    expect(methodsChunk?.content).toContain('methods used');
    expect(conclusionChunk?.content).toContain('Final thoughts');

    // Indices sequential.
    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });

  it('sub-splits a long section that exceeds chunkSize', async () => {
    const engine = new ChunkingEngine();
    // Build a section body that is ~600 chars (exceeds chunkSize=200).
    const longBody = buildWordyString(600);
    const markdown = `# Long Section\n\n${longBody}`;

    const chunks = await engine.chunk(markdown, {
      strategy: 'hierarchical',
      chunkSize: 200,
      chunkOverlap: 20,
    });

    // The long section body should produce at least 3 sub-chunks.
    const sectionChunks = chunks.filter((c) => c.heading === 'Long Section');
    expect(sectionChunks.length).toBeGreaterThanOrEqual(3);

    // Every sub-chunk must respect chunkSize.
    for (const sc of sectionChunks) {
      expect(sc.content.length).toBeLessThanOrEqual(200);
    }

    // Heading metadata preserved across sub-chunks.
    for (const sc of sectionChunks) {
      expect(sc.heading).toBe('Long Section');
      expect(sc.metadata?.headingLevel).toBe(1);
    }

    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });
});

// ---------------------------------------------------------------------------
// ChunkingEngine — layout strategy
// ---------------------------------------------------------------------------

describe('ChunkingEngine — layout strategy', () => {
  it('emits a fenced code block as a single chunk with type:"code"', async () => {
    const engine = new ChunkingEngine();
    const content = [
      'Some introductory prose.',
      '',
      '```typescript',
      'function hello(): void {',
      '  console.log("hello world");',
      '}',
      '```',
      '',
      'Closing prose.',
    ].join('\n');

    const chunks = await engine.chunk(content, {
      strategy: 'layout',
      chunkSize: 512,
      chunkOverlap: 0,
    });

    const codeChunks = chunks.filter((c) => c.metadata?.type === 'code');
    expect(codeChunks).toHaveLength(1);

    // The entire code block (including fences) must be in a single chunk.
    expect(codeChunks[0].content).toContain('```typescript');
    expect(codeChunks[0].content).toContain('console.log');
    expect(codeChunks[0].content).toContain('```');

    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });

  it('emits a pipe-delimited table as a single chunk with type:"table"', async () => {
    const engine = new ChunkingEngine();
    const content = [
      'Here is a table:',
      '',
      '| Name  | Age | City    |',
      '|-------|-----|---------|',
      '| Alice | 30  | London  |',
      '| Bob   | 25  | Paris   |',
      '',
      'After the table.',
    ].join('\n');

    const chunks = await engine.chunk(content, {
      strategy: 'layout',
      chunkSize: 512,
      chunkOverlap: 0,
    });

    const tableChunks = chunks.filter((c) => c.metadata?.type === 'table');
    expect(tableChunks).toHaveLength(1);

    // The full table must be preserved in one chunk.
    expect(tableChunks[0].content).toContain('| Name');
    expect(tableChunks[0].content).toContain('Alice');
    expect(tableChunks[0].content).toContain('Bob');

    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });

  it('handles mixed content: prose + code + prose → 3 ordered chunks', async () => {
    const engine = new ChunkingEngine();
    const PROSE_A = 'First prose block before the code snippet.';
    const CODE_BLOCK = ['```python', 'x = 1 + 1', 'print(x)', '```'].join('\n');
    const PROSE_B = 'Second prose block after the code snippet.';

    const content = [PROSE_A, '', CODE_BLOCK, '', PROSE_B].join('\n');

    const chunks = await engine.chunk(content, {
      strategy: 'layout',
      chunkSize: 512,
      chunkOverlap: 0,
    });

    // Exactly 3 chunks: prose A, code, prose B.
    expect(chunks).toHaveLength(3);

    // Order must be preserved.
    expect(chunks[0].content).toContain('First prose block');
    expect(chunks[0].metadata?.type).toBeUndefined();

    expect(chunks[1].metadata?.type).toBe('code');
    expect(chunks[1].content).toContain('x = 1 + 1');

    expect(chunks[2].content).toContain('Second prose block');
    expect(chunks[2].metadata?.type).toBeUndefined();

    // Indices sequential.
    chunks.forEach((c, idx) => expect(c.index).toBe(idx));
  });
});
