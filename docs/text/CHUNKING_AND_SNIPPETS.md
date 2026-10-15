---
description: "Cutting text into passages for an index with SemanticChunker, chunkTurns and ChunkingEngine, and placing a search hit's words in a passage with lexicalTokens and snippetAround."
---

# Chunking and Snippets

A chunker cuts a document into the passages an index stores; a snippet shows where a hit's words fall in one of them.

```typescript
import { SemanticChunker, lexicalTokens, snippetAround } from '@framers/agentos/cognition/rag';

const handbook = [
  '# Refunds',
  '',
  'Refunds go back to the card that paid. They take five to ten business days.',
  '',
  '# Shipping',
  '',
  'Orders ship within two days of payment.',
].join('\n');

const chunks = new SemanticChunker({ overlap: 0 }).chunk(handbook, { source: 'handbook.md' });
chunks.map((chunk) => [chunk.index, chunk.boundaryType]); // [[0, 'heading'], [1, 'heading']]

snippetAround('The refund goes back to the card that paid.', lexicalTokens('refunds'));
// { at: -1, text: 'The refund goes back to the card that paid.' }: no word begins with "refunds"
snippetAround('The refund goes back to the card that paid.', lexicalTokens('refund'));
// { at: 4, text: 'The refund goes back to the card that paid.' }
```

| Chunker | What it cuts | Import |
|---|---|---|
| [`SemanticChunker`](../../src/cognition/rag/chunking/SemanticChunker.ts) | Markdown and prose, at headings, then paragraphs, then sentences, keeping fenced code whole | `@framers/agentos/cognition/rag`; also the package root |
| [`chunkTurns`](../../src/cognition/library/chunkTurns.ts) | A transcript's turns, never cutting a turn | `@framers/agentos/cognition/library/browser`; also `@framers/agentos/cognition/library`, `@framers/agentos/cognition/rag` and the package root |
| [`ChunkingEngine`](../../src/cognition/memory/io/ingestion/ChunkingEngine.ts) | A document by a fixed size, by embedding similarity, by Markdown headings, or around code blocks and tables | `@framers/agentos/cognition/memory`; also the package root |

## SemanticChunker

`new SemanticChunker(config)` takes:

| Option | Default | What it sets |
|---|---|---|
| `targetSize` | 1000 | The characters a chunk gathers before a blank line ends it, and the size the splits below pack to |
| `maxSize` | 2000 | The characters above which a chunk is split again |
| `minSize` | 200 | The characters below which a chunk joins the one before it |
| `overlap` | 100 | The characters of the chunk before that each chunk starts with |
| `preserveCodeBlocks` | true | Keep each fenced code block as one chunk |
| `respectHeadings` | true | Start a chunk at each Markdown heading |

`chunk(text, metadata)` answers the chunks in order, `[]` for an empty text:

1. It reads the text line by line. With `preserveCodeBlocks`, a line that starts with three backticks opens a block that runs to the next such line and becomes one `code-block` chunk; a block left open runs to the end. With `respectHeadings`, a heading line (`#` to `######`, then a space) starts a `heading` chunk. A blank line ends the current chunk only once it holds `targetSize` characters; until then paragraphs gather.
2. A chunk longer than `maxSize` is split again: at blank lines, packing paragraphs up to `targetSize` (`paragraph`); a part still longer than `maxSize`, or a chunk with no blank line, at sentence ends (`.`, `!` or `?` and white space), packing sentences up to `targetSize` (`sentence`); a part still longer, or with no sentence end, every `targetSize` characters, moved back to the last space when that space lies more than `minSize` characters in (`fixed`).
3. A chunk shorter than `minSize`, white space aside, is added to the chunk before it after a blank line, unless it is a heading or code-block chunk.
4. Each chunk after the first starts with the last `overlap` characters of the chunk before it, cut by character count.

Each chunk is `{ text, index, startOffset, endOffset, boundaryType, metadata }`. `boundaryType` is `heading`, `paragraph`, `sentence`, `code-block` or `fixed`, and `metadata` is the object passed to `chunk()`, on every chunk. `startOffset` is where the chunk's own text starts in the input, before the overlap, and `endOffset` is `startOffset` plus the length of that text. The offsets assume one blank line between paragraphs and one space between sentences, so after a split at longer white space, or a merge, they can be off by a few characters.

## A transcript's turns

`chunkTurns(turns, { maxChars, overlapTurns })` cuts `[{ seq, itemId, text, startMs, endMs }]` into passages of whole turns joined by line feeds, at most `maxChars` characters (1,200 unless given) unless one turn alone is longer, each next passage opening with up to `overlapTurns` turns (1 unless given) from the end of the one before. Each passage records its first and last `seq`, its item ids, its time span and where each turn sits in its text. [Library Index: A transcript's passages](../features/LIBRARY_INDEX.md#a-transcripts-passages) has the full rules.

## Documents for a memory brain

`new ChunkingEngine().chunk(content, { strategy, chunkSize, chunkOverlap, embedFn })` answers a promise of `{ content, index, heading, metadata }` chunks, with `chunkSize` 512 and `chunkOverlap` 64 characters unless given. `strategy` is `'fixed'`, `'semantic'` (cuts where the cosine similarity of two neighbouring sentences' embeddings falls below 0.3, and runs as `'fixed'` without `embedFn`), `'hierarchical'` (at Markdown headings) or `'layout'` (keeps code blocks and tables whole). A `chunkSize` under 1 throws a `RangeError`. `Memory.ingest()` cuts documents with it: [Document Ingestion: Chunking Strategies](../memory/MEMORY_DOCUMENT_INGESTION.md#chunking-strategies) describes each strategy.

## Snippets

`lexicalTokens(text)` answers a text's words: lower-case runs of letters and digits, in order, in any script, nothing stemmed. `lexicalTokens("Q3's budget: 1,200 units")` is `['q3', 's', 'budget', '1', '200', 'units']`.

`snippetAround(text, words, { before, after })` finds the first word of `text` that begins with one of `words`, and answers `{ at, text }`: where that word starts in `text` (-1 when none does), and the whole words around it, with white space collapsed. The snippet runs from just after the last white space at or before `before` characters (80 unless given) ahead of the word, or from the text's start, to the first white space at or after `after` characters (120 unless given) past the word's start, or to the text's end. With no match, the snippet is the text's start. A text with no white space, as Chinese and Japanese are written, comes back whole. [Library Index: Words and snippets](../features/LIBRARY_INDEX.md#words-and-snippets) describes both functions beside the library's search.

## Where it runs

`chunkTurns`, `lexicalTokens` and `snippetAround` load in a browser from `@framers/agentos/cognition/library/browser`. The modules of `SemanticChunker` and `ChunkingEngine` import nothing at run time, but the entries above that export them, `@framers/agentos/cognition/rag` and `@framers/agentos/cognition/memory`, load modules that need Node. A page that needs `SemanticChunker` alone imports `@framers/agentos/cognition/rag/chunking/SemanticChunker`, which the `./cognition/rag/*` entry of the package's `exports` map serves. None of them calls a model; `ChunkingEngine`'s `'semantic'` strategy calls the `embedFn` you pass.

## Examples

- [`examples/text-search-bm25.mjs`](../../examples/text-search-bm25.mjs) places a snippet around each hit of a `LexicalIndex` with `snippetAround`.
- [`examples/text-hybrid-search.mjs`](../../examples/text-hybrid-search.mjs) indexes the chunks of a short handbook made by `SemanticChunker`.
