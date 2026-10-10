import { describe, expect, it } from 'vitest';

import { chunkTurns, type LibraryTurn } from '../chunkTurns.js';
import { lexicalTokens, snippetAround } from '../tokens.js';

const turn = (seq: number, text: string, startMs = seq * 1000): LibraryTurn => ({ seq, itemId: `item_${seq}`, text, startMs, endMs: startMs + 900 });

describe('lexicalTokens', () => {
  it('answers lower-case runs of letters and digits, in order, in any script', () => {
    expect(lexicalTokens("Don't cut Q3's budget: 1,200 units. Über-fast, señor!")).toEqual(['don', 't', 'cut', 'q3', 's', 'budget', '1', '200', 'units', 'über', 'fast', 'señor']);
    expect(lexicalTokens('  ...  ')).toEqual([]);
  });

  it('places a snippet in whole words around the first word a query word begins', () => {
    const text = `${'alpha '.repeat(30)}the Budgets grew ${'omega '.repeat(40)}`;
    const snippet = snippetAround(text, ['budget']);
    expect(snippet.at).toBe(184);
    expect(snippet.text).toMatch(/^alpha( alpha)* the Budgets grew( omega)+$/);
    expect(snippet.text).toHaveLength(202);
    expect(snippetAround('a chart of art', ['art']).at).toBe(11);
    expect(snippetAround('no match here', ['zebra'])).toEqual({ at: -1, text: 'no match here' });
  });
});

describe('chunkTurns', () => {
  it('keeps every turn whole, in order, under the size, with one turn of overlap', () => {
    const turns = [turn(1, 'a'.repeat(40)), turn(2, 'b'.repeat(40)), turn(3, 'c'.repeat(40)), turn(4, 'd'.repeat(40))];
    const chunks = chunkTurns(turns, { maxChars: 100, overlapTurns: 1 });
    expect(chunks.map((chunk) => [chunk.firstSeq, chunk.lastSeq])).toEqual([[1, 2], [2, 3], [3, 4]]);
    expect(chunks[0].text).toBe(`${'a'.repeat(40)}\n${'b'.repeat(40)}`);
    expect(chunks.every((chunk) => chunk.text.length <= 100)).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  });

  it('records where each turn sits in its chunk, and the chunk\'s times', () => {
    const [chunk] = chunkTurns([turn(7, 'first words'), turn(8, 'second words')]);
    expect(chunk.turns).toEqual([
      { seq: 7, itemId: 'item_7', start: 0, end: 11 },
      { seq: 8, itemId: 'item_8', start: 12, end: 24 },
    ]);
    expect(chunk.text.slice(12, 24)).toBe('second words');
    expect([chunk.startMs, chunk.endMs]).toEqual([7000, 8900]);
    expect(chunk.itemIds).toEqual(['item_7', 'item_8']);
  });

  it('gives a turn longer than the size a chunk of its own, uncut', () => {
    const long = 'x'.repeat(250);
    const chunks = chunkTurns([turn(1, 'short'), turn(2, long), turn(3, 'tail')], { maxChars: 100, overlapTurns: 1 });
    expect(chunks.map((chunk) => chunk.text)).toEqual(['short', long, 'tail']);
  });

  it('skips turns with no words and answers nothing for none', () => {
    expect(chunkTurns([])).toEqual([]);
    expect(chunkTurns([turn(1, '   '), turn(2, 'kept')]).map((chunk) => chunk.itemIds)).toEqual([['item_2']]);
  });

  it('ends when the last turn is in a chunk, without a chunk of overlap alone', () => {
    const chunks = chunkTurns([turn(1, 'a'.repeat(60)), turn(2, 'b'.repeat(60))], { maxChars: 100, overlapTurns: 1 });
    expect(chunks.map((chunk) => [chunk.firstSeq, chunk.lastSeq])).toEqual([[1, 1], [2, 2]]);
  });

  it('opens a chunk at the overlap turn only when a new turn fits beside it', () => {
    const lengths = [500, 600, 700, 400, 300];
    const chunks = chunkTurns(lengths.map((length, at) => turn(at + 1, 'w'.repeat(length))));
    expect(chunks.map((chunk) => [chunk.firstSeq, chunk.lastSeq])).toEqual([[1, 2], [3, 4], [4, 5]]);
    expect(chunks.every((chunk) => chunk.text.length <= 1200)).toBe(true);
  });
});
