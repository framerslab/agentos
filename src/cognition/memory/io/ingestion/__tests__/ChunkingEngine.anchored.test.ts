/**
 * @fileoverview The `'anchored'` chunking strategy: passages whose boundaries survive an edit elsewhere in the text,
 * each with its offsets in the text given and whether its edges are whole.
 *
 * The anchor rule is read here with Node's own SHA-256, apart from the engine's: a piece is an anchor when the first
 * byte of its digest is divisible by 4. The fixtures pick paragraph texts that are anchors, or are not, so each case
 * knows where its passages end.
 *
 * @module memory/ingestion/__tests__/ChunkingEngine.anchored.test
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { DocumentChunk } from '../../facade/types.js';
import { ChunkingEngine } from '../ChunkingEngine.js';

const engine = new ChunkingEngine();
const SIZE = 1200;

/** Whether a piece ends its passage: the first byte of its SHA-256 (of its UTF-8) is divisible by 4. */
function anchor(piece: string): boolean {
  return createHash('sha256').update(piece, 'utf8').digest()[0] % 4 === 0;
}

const WORDS = [
  'budget', 'review', 'river', 'lantern', 'harbor', 'meadow', 'signal', 'copper',
  'orbit', 'velvet', 'thistle', 'canyon', 'ember', 'glacier', 'quarry', 'saddle',
];

/** A sentence of at most `length` units, its words picked by `seed`, with a capital first and a full stop last. */
function sentence(seed: number, length: number): string {
  let state = (seed * 2654435761) >>> 0 || 1;
  const words: string[] = [];
  let size = 0;
  for (;;) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const word = WORDS[(state >>> 8) % WORDS.length];
    if (size + word.length + 1 > length) break;
    words.push(word);
    size += word.length + 1;
  }
  const text = `${words.join(' ')}.`;
  return text[0].toUpperCase() + text.slice(1);
}

/** A paragraph of `count` sentences of about `length` units each, an anchor or not as asked. */
function paragraph(seed: number, isAnchor: boolean, count = 5, length = 100): string {
  for (let variant = 0; ; variant += 1) {
    const text = Array.from({ length: count }, (_, n) => sentence(seed * 1000 + variant * 10 + n, length)).join(' ');
    if (anchor(text) === isAnchor) return text;
  }
}

const join = (paragraphs: string[]): string => paragraphs.join('\n\n');
const contents = (chunks: DocumentChunk[]): string[] => chunks.map((chunk) => chunk.content);
const anchored = (text: string, markdown = false): Promise<DocumentChunk[]> =>
  engine.chunk(text, { strategy: 'anchored', chunkSize: SIZE, markdown });

/**
 * Each chunk is its own slice of `text`, trimmed and no longer than the size; chunks come in order without overlap,
 * and only white space lies between or around them, so every other character is in exactly one chunk.
 */
function expectOffsets(text: string, chunks: DocumentChunk[]): void {
  let previousEnd = 0;
  for (const chunk of chunks) {
    expect(typeof chunk.start).toBe('number');
    expect(typeof chunk.end).toBe('number');
    const start = chunk.start ?? -1;
    const end = chunk.end ?? -1;
    expect(start).toBeGreaterThanOrEqual(previousEnd);
    expect(text.slice(start, end)).toBe(chunk.content);
    expect(chunk.content.length).toBeLessThanOrEqual(SIZE);
    expect(chunk.content).toBe(chunk.content.trim());
    expect(text.slice(previousEnd, start).trim()).toBe('');
    previousEnd = end;
  }
  expect(text.slice(previousEnd).trim()).toBe('');
  expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, n) => n));
}

describe("ChunkingEngine — 'anchored' strategy", () => {
  it('keeps the other passages of a 40-passage text when a 200-unit sentence goes into the third, where fixed keeps at most 3', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, n) => paragraph(n + 1, true));
    const third = paragraphs[2];
    // After the third paragraph's second sentence, a sentence of 200 units that leaves the paragraph an anchor.
    const at = third.indexOf('. ', third.indexOf('. ') + 2) + 2;
    let edited = '';
    for (let variant = 0; ; variant += 1) {
      const inserted = `Added ${String(variant).padStart(3, '0')} ${'note '.repeat(37)}over.`;
      expect(inserted).toHaveLength(200);
      edited = `${third.slice(0, at)}${inserted} ${third.slice(at)}`;
      if (anchor(edited)) break;
    }
    const before = join(paragraphs);
    const afterParagraphs = [...paragraphs.slice(0, 2), edited, ...paragraphs.slice(3)];
    const after = join(afterParagraphs);

    const was = await anchored(before);
    const now = await anchored(after);
    expect(contents(was)).toEqual(paragraphs);
    expect(contents(now)).toEqual(afterParagraphs);
    expect(was.filter((chunk, n) => now[n]?.content === chunk.content).length).toBeGreaterThanOrEqual(36);
    expect(now.every((chunk) => chunk.edges?.first === true && chunk.edges?.last === true)).toBe(true);
    expectOffsets(before, was);
    expectOffsets(after, now);

    // The fixed cut places each chunk from the end of the one before, so every chunk after the edit moves.
    const fixedBefore = await engine.chunk(before, { strategy: 'fixed', chunkSize: SIZE, chunkOverlap: 150 });
    const fixedAfter = new Set(contents(await engine.chunk(after, { strategy: 'fixed', chunkSize: SIZE, chunkOverlap: 150 })));
    expect(fixedBefore.length).toBeGreaterThan(10);
    expect(fixedBefore.filter((chunk) => fixedAfter.has(chunk.content)).length).toBeLessThanOrEqual(3);
  });

  it('merges only the two runs beside an anchor that an edit removes', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, n) => paragraph(n + 101, true));
    const edited = paragraph(9105, false);
    const after = join([...paragraphs.slice(0, 4), edited, ...paragraphs.slice(5)]);
    const now = await anchored(after);
    expect(contents(now)).toEqual([...paragraphs.slice(0, 4), `${edited}\n\n${paragraphs[5]}`, ...paragraphs.slice(6)]);
    expectOffsets(after, now);
  });

  it('changes only the run of a paragraph pushed past the chunk size', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, n) => paragraph(n + 201, true));
    const longer = `${paragraphs[9]} ${Array.from({ length: 8 }, (_, n) => sentence(7000 + n, 100)).join(' ')}`;
    expect(longer.length).toBeGreaterThan(SIZE);
    const after = join([...paragraphs.slice(0, 9), longer, ...paragraphs.slice(10)]);
    const now = await anchored(after);
    expect(contents(now.slice(0, 9))).toEqual(paragraphs.slice(0, 9));
    expect(contents(now.slice(-29))).toEqual(paragraphs.slice(11));
    // Between them, the longer paragraph and the next one, cut into passages no longer than the size.
    const run = now.slice(9, now.length - 29);
    expect(run.length).toBeGreaterThanOrEqual(2);
    expect(after.slice(run[0].start, run[run.length - 1].end)).toBe(`${longer}\n\n${paragraphs[10]}`);
    expectOffsets(after, now);
  });

  it('changes only its own run when an edit falls in a run with no anchor', async () => {
    // Paragraphs 21 to 30 are not anchors, so they pack by size alone until paragraph 31, which is.
    const paragraphs = Array.from({ length: 40 }, (_, n) => (n >= 20 && n < 30 ? paragraph(n + 301, false, 3) : paragraph(n + 301, true)));
    let edited = '';
    for (let seed = 8000; ; seed += 1) {
      edited = `${paragraphs[21]} ${sentence(seed, 100)}`;
      if (!anchor(edited)) break;
    }
    const before = join(paragraphs);
    const afterParagraphs = [...paragraphs.slice(0, 21), edited, ...paragraphs.slice(22)];
    const after = join(afterParagraphs);
    const was = await anchored(before);
    const now = await anchored(after);
    for (const chunks of [was, now]) {
      expect(contents(chunks.slice(0, 20))).toEqual(paragraphs.slice(0, 20));
      expect(contents(chunks.slice(-9))).toEqual(paragraphs.slice(31));
    }
    const run = now.slice(20, now.length - 9);
    expect(after.slice(run[0].start, run[run.length - 1].end)).toBe(join(afterParagraphs.slice(20, 31)));
    expectOffsets(before, was);
    expectOffsets(after, now);
  });

  it('gives offsets into the text given, with emoji and CRLF line breaks', async () => {
    const lines = Array.from({ length: 60 }, (_, n) => `  ${sentence(400 + n, 80)} \u{1F600} ${n % 7 === 0 ? 'Ünïcödé' : 'plain'}  `);
    const blocks: string[] = [];
    for (let n = 0; n < lines.length; n += 3) blocks.push(lines.slice(n, n + 3).join('\r\n'));
    // Blocks of three lines, CRLF inside them, and between them an empty line, one that holds spaces.
    const text = `\r\n${blocks.join('\r\n  \r\n')}\r\n\r\n`;
    const chunks = await anchored(text);
    expect(chunks.length).toBeGreaterThan(3);
    expectOffsets(text, chunks);
    // All the lines as one block, longer than the size, so it is cut at sentence ends.
    const one = lines.join('\r\n');
    expect(one.length).toBeGreaterThan(SIZE);
    const cut = await anchored(one);
    expect(cut.length).toBeGreaterThan(1);
    expectOffsets(one, cut);
  });

  it('cuts a sentence longer than the chunk size at white space, with edges false on the cut sides', async () => {
    const words = Array.from({ length: 500 }, (_, n) => WORDS[(n * 5) % WORDS.length]).join(' ');
    const text = `${words[0].toUpperCase()}${words.slice(1)}.`;
    expect(text.length).toBeGreaterThan(2 * SIZE);
    const chunks = await anchored(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expectOffsets(text, chunks);
    chunks.forEach((chunk, n) => {
      expect(chunk.edges).toEqual({ first: n === 0, last: n === chunks.length - 1 });
      if (n > 0) expect(text[(chunk.start ?? 0) - 1]).toBe(' ');
    });
  });

  it('cuts a 1,201-unit word at 1,200 units, or at 1,199 where 1,200 would split a surrogate pair', async () => {
    const shape = (chunks: DocumentChunk[]) => chunks.map(({ start, end, edges }) => ({ start, end, edges }));
    expect(shape(await anchored('x'.repeat(1201)))).toEqual([
      { start: 0, end: 1200, edges: { first: true, last: false } },
      { start: 1200, end: 1201, edges: { first: false, last: true } },
    ]);
    const pair = `${'x'.repeat(1199)}\u{1F600}`;
    expect(pair).toHaveLength(1201);
    const chunks = await anchored(pair);
    expect(shape(chunks)).toEqual([
      { start: 0, end: 1199, edges: { first: true, last: false } },
      { start: 1199, end: 1201, edges: { first: false, last: true } },
    ]);
    expect(chunks[1].content).toBe('\u{1F600}');
  });

  it("starts a passage at each Markdown heading and gives the headings as 'hierarchical' does", async () => {
    const text = [
      'A preamble before any heading.',
      '',
      '# Guide',
      paragraph(501, false, 2),
      '',
      '## Setup',
      'Install the tools first.',
      '',
      '### Linux',
      'Use the package manager.',
      '',
      '## Usage',
      paragraph(502, true, 2),
      '',
      '# Appendix',
      'The end.',
    ].join('\n');
    const chunks = await anchored(text, true);
    expectOffsets(text, chunks);
    for (const line of ['# Guide', '## Setup', '### Linux', '## Usage', '# Appendix']) {
      const at = text.indexOf(`${line}\n`);
      expect(chunks.some((chunk) => chunk.start === at), line).toBe(true);
    }
    expect(chunks[0].heading).toBeUndefined();
    expect(new Set(chunks.map((chunk) => chunk.heading))).toEqual(new Set([undefined, 'Guide', 'Setup', 'Linux', 'Usage', 'Appendix']));
    const hierarchical = await engine.chunk(text, { strategy: 'hierarchical', chunkSize: SIZE });
    const sections = new Map(hierarchical.map((chunk) => [chunk.heading, chunk.metadata]));
    for (const chunk of chunks) expect(chunk.metadata, chunk.heading).toEqual(sections.get(chunk.heading));

    // Without markdown the heading lines are text like any other.
    const plain = await anchored(text);
    expect(plain.every((chunk) => chunk.heading === undefined && chunk.metadata === undefined)).toBe(true);
    expectOffsets(text, plain);
  });

  it('cuts a Markdown heading longer than the chunk size, with its section on every passage', async () => {
    for (const [text, size] of [
      [`# ${'heading '.repeat(200)}\nBody.`, 100],
      [`# ${'x'.repeat(600)}\n\nThe text under it.`, 512],
    ] as const) {
      const chunks = await engine.chunk(text, { strategy: 'anchored', chunkSize: size, markdown: true });
      const title = text.slice(2, text.indexOf('\n')).trim();
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].start).toBe(0);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(size);
        expect(text.slice(chunk.start, chunk.end)).toBe(chunk.content);
        expect(chunk.heading).toBe(title);
        expect(chunk.metadata).toEqual({ headingLevel: 1 });
      }
      expect(chunks.map((chunk) => chunk.content).join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
    }
  });

  it('finds the sentence ends of a long run of punctuation in linear time', async () => {
    const text = `${'!'.repeat(64_000)}`;
    const began = performance.now();
    const chunks = await anchored(text);
    const took = performance.now() - began;
    expectOffsets(text, chunks);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(text);
    expect(took).toBeLessThan(1_000);
  }, 60_000);

  it('floors a fractional chunk size and needs room for a surrogate pair', async () => {
    const text = '\u{1F600}\u{1F600}\u{1F600}';
    const chunks = await engine.chunk(text, { strategy: 'anchored', chunkSize: 2.5 });
    expect(chunks.map((chunk) => chunk.content)).toEqual(['\u{1F600}', '\u{1F600}', '\u{1F600}']);
    expect(chunks.every((chunk) => Number.isInteger(chunk.start) && Number.isInteger(chunk.end))).toBe(true);
    expect(chunks.map(({ start, end }) => [start, end])).toEqual([[0, 2], [2, 4], [4, 6]]);
    for (const chunkSize of [1, 1.5, 1.99]) {
      await expect(engine.chunk('\u{1F600}x', { strategy: 'anchored', chunkSize })).rejects.toThrow(RangeError);
    }
    // The other strategies still take a size of 1.
    await expect(engine.chunk('abc', { strategy: 'fixed', chunkSize: 1, chunkOverlap: 0 })).resolves.toBeInstanceOf(Array);
  });
});
