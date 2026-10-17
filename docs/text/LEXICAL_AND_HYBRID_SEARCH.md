---
description: "Keyword search in AgentOS: LexicalIndex, the BM25 index that loads in a browser and saves as JSON; BM25Index, with AgentOS's tokenizer or a text pipeline; FuzzyIndex, which finds words typed with a typo or only begun and ranks them by field; HybridSearcher, which fuses BM25 with vector search; and the rank-fusion and deduplication functions."
---

# Lexical and Hybrid Search

A lexical index finds the documents that hold a query's words and ranks them by BM25; a fuzzy index also finds words typed with a typo or only begun, and ranks them by the field they are in. A hybrid search runs a BM25 index beside a vector search and fuses the two rankings.

```typescript
import { BM25Index } from '@framers/agentos/cognition/rag';

const index = new BM25Index();
index.addDocuments([
  { id: 'faq-1', text: 'Reset a password from the sign-in page.' },
  { id: 'faq-2', text: 'Passwords expire after ninety days.' },
  { id: 'faq-3', text: 'Two-factor codes arrive by text message.' },
]);

index.search('password reset').map((hit) => hit.id); // ['faq-1']
index.search('pass', 10, { prefix: true }).map((hit) => hit.id); // ['faq-1', 'faq-2']
index.search('password expire', 10, { match: 'all' }); // []: no document holds both words
index.search('password expire', 10, { match: 'all', prefix: true }).map((hit) => hit.id); // ['faq-2']

const saved = JSON.stringify(index.toJSON());
const restored = BM25Index.fromJSON(JSON.parse(saved));
restored.search('password reset').map((hit) => hit.id); // ['faq-1']
```

| Class | Reads words with | Import | Runs in |
|---|---|---|---|
| [`LexicalIndex`](../../src/cognition/rag/search/LexicalIndex.ts) | The function you give it | `@framers/agentos/cognition/library/browser`; also `@framers/agentos/cognition/library`, `@framers/agentos/cognition/rag` and the package root | A browser or Node |
| [`BM25Index`](../../src/cognition/rag/search/BM25Index.ts) | `tokenize` when given, else a [text pipeline](./TEXT_PROCESSING.md) given as `pipeline`, else its built-in tokenizer | `@framers/agentos/cognition/rag`; also the package root | Node |
| [`FuzzyIndex`](../../src/cognition/rag/search/FuzzyIndex.ts) | The library's word rule with an apostrophe inside a word kept, or the function you give it | `@framers/agentos/cognition/library/browser`; also `@framers/agentos/cognition/library`, `@framers/agentos/cognition/rag` and the package root | A browser or Node |
| [`HybridSearcher`](../../src/cognition/rag/search/HybridSearcher.ts) | A `BM25Index` beside a vector store and an embedder | `@framers/agentos/cognition/rag`; also the package root | Node, with an embedder |

## Scoring

`LexicalIndex` and `BM25Index` score a document `D` for a query with BM25:

```
score(D) = Σ over the query's words t of  IDF(t) × tf(t, D) × (k1 + 1) / (tf(t, D) + k1 × (1 - b + b × |D| / avgdl))
IDF(t)   = ln((N - n(t) + 0.5) / (n(t) + 0.5) + 1)
```

`tf(t, D)` is how often `t` occurs in `D`, `|D|` the document's length in tokens, `avgdl` the average length, `N` the number of documents and `n(t)` the number that hold `t`. `k1` is 1.2 and `b` 0.75 unless given. A word the query repeats adds its score each time.

## LexicalIndex

`LexicalIndex` imports nothing, so a page can hold a search index of its own.

| Member | What it does |
|---|---|
| `new LexicalIndex({ tokenize, k1, b })` | An empty index that reads text with `tokenize(text): string[]`. |
| `addDocument(id, text, metadata?)` | Indexes the text's words. An id the index holds is replaced; an empty id or text throws. |
| `addDocuments(docs)` | `addDocument` for each `{ id, text, metadata }`. |
| `search(query, topK = 10, { match, prefix })` | The documents that match, highest score first, at most `topK`, as `{ id, score, metadata }`. |
| `removeDocument(id)` | Removes the document; answers whether it was there. |
| `getStats()` | `{ documentCount, termCount, avgDocLength }`. |
| `toJSON()` | The index as plain JSON. |
| `LexicalIndex.fromJSON(json, { tokenize })` | A saved index restored. |

`match: 'any'` (the default) ranks every document that holds at least one of the query's words; `match: 'all'` keeps only those that hold every one. `prefix: true` lets a stored word match when it begins with a query word, so `pass` finds `password`; when several stored words begin with one query word, a document scores by the best of them for that word. A query the tokenizer reads no words in answers `[]`.

The index keeps no text: a hit carries its id, score and metadata, and the caller keeps the texts and places a snippet with [`snippetAround`](./CHUNKING_AND_SNIPPETS.md#snippets).

`toJSON()` answers version 1 of the format: `{ v: 1, k1, b, documents, terms }`, with each document as `[id, length]` or `[id, length, metadata]` and each term as `[term, postings]`, a posting being `[the document's position in documents, the term's count in it]`. It holds terms, not texts, so `fromJSON` is given the tokenizer the index was made with. A saved index of another version throws, and so does one with any of these faults: `k1` or `b` not a finite number, a part out of shape, a document id or a term given twice, a document position given twice in one term's postings, a position that is not a document's, a length that is not a whole number of 0 or more, or a count that is not a whole number of 1 or more. The error names what is wrong. The restore does not check for an empty document id or a term with no postings, neither of which `addDocument()` produces. Metadata is saved as given, so keep it to values JSON can hold.

### In a browser

A page imports `@framers/agentos/cognition/library/browser`. It exports `LexicalIndex`, `FuzzyIndex`, `withinOneEdit`, `lexicalTokens`, `snippetAround` and `chunkTurns` with their types, the page's own storage: a key-value store over IndexedDB or memory, an outbox and `reconcileList`, and the readers of transcript files from other notetakers with the plan of an archive's entries. Nothing it reaches imports a Node module or a package, which a test holds by walking its import graph. [Library Index: On a device](../features/LIBRARY_INDEX.md#on-a-device) lists every export and builds a page's index from a transcript's passages with `lexicalTokens`.

## BM25Index

`BM25Index` is a `LexicalIndex` with AgentOS's tokenizer. `new BM25Index({ k1, b, pipeline, tokenize })` reads text with `tokenize` when given; else with `pipeline.processToStrings`, so `new BM25Index({ pipeline: createRagPipeline() })` stores Porter stems and finds `running` for `run`; else with its built-in tokenizer.

The built-in tokenizer lower-cases the text, splits it at white space and at ASCII punctuation (`-`, `_`, `.`, `,`, `'`, brackets, `/` and the rest), and drops tokens shorter than two characters and the stop words of `getNaturalStopWords()`, read on its first use ([Stop words](./TEXT_PROCESSING.md#stop-words)). It does not stem: `password` does not find `passwords` without `prefix`.

`BM25Index.fromJSON(json, config)` restores a saved index with the `k1` and `b` it was saved with and the tokenizer that `config` selects, which must read text as the one the index was made with. `toJSON()`, `search()` and the other members are `LexicalIndex`'s.

`BM25Index` imports the stop-word module, which loads `natural` through `node:module`, so it runs in Node; a page uses `LexicalIndex`.

## FuzzyIndex

`FuzzyIndex` is a search box's index over records such as a person's notes: it finds a word typed with a typo or only begun, ranks a match by the field it is in, and answers each hit with its matched words marked and the sentences that hold them.

```typescript
import { FuzzyIndex } from '@framers/agentos/cognition/library/browser';

const index = new FuzzyIndex({ fields: { title: 10, body: 1 } });
index.addDocuments([
  { id: 'refunds', fields: { title: 'Refunds', body: 'A refund goes back to the card that paid.' } },
  { id: 'shipping', fields: { title: 'Shipping', body: 'Orders ship within two business days.' } },
]);

index.search('refnud')[0].score; // 0.5: the body's "refund" with two letters swapped, 0.5 times the weight 1
index.search('ref')[0].score; // 7.5: the title's "Refunds" begins with "ref", 0.75 times the weight 10
index.search('refund')[0].passages;
// [{ text: 'A refund goes back to the card that paid.', marks: [{ start: 2, end: 8 }] }]
```

A query word matches a stored word that is the same (it counts 1), a word it begins (0.75), or a word one edit away (0.5): a letter added, dropped or changed, or two letters side by side swapped, where both words have `editMinLength` letters or more. A document's score is, for each query word, its best match's count times the weight of the field that match is in, summed over the query's words. The score does not weigh a word by how rare it is, as BM25 does.

| Member | What it does |
|---|---|
| `new FuzzyIndex({ fields, passageFields, tokenize, editMinLength, passages, passageWidth })` | `fields` maps each field's name to its weight, a finite number above 0. `passageFields` is the fields of the lowest weight unless given, `editMinLength` 4, `passages` 3 and `passageWidth` 160. A setting out of range throws a `RangeError`. |
| `addDocument({ id, fields })`, `addDocuments(documents)` | Each field is a text or a list of short texts, such as keywords; a field the index was not made with is left out. An id the index holds is replaced, and the document counts as added last. |
| `search(query, { topK, match })` | At most `topK` hits (10 unless given, `Infinity` for every hit), highest score first, a tie in the order the documents were added. `match: 'all'`, the default here, keeps the documents in which every query word matches; `'any'` keeps those in which at least one does. Each hit is `{ id, score, fields, passages }`: every field with its matched words marked as `{ text, marks }`, and up to `passages` sentences or lines of the passage fields, each clipped to about `passageWidth` characters around its first match. |
| `removeDocument(id)` | Removes the document; answers whether it was there. |
| `toJSON()`, `FuzzyIndex.fromJSON(json, { tokenize })` | Version 1 of the format: the settings and each document's texts, which a restore reads again with the tokenizer given, the default unless one is. |
| `withinOneEdit(a, b)` | The one-edit test alone, a Damerau-Levenshtein distance of 1 or less, on the words as given. |

The texts and the query are read in NFC and cut into words by the library's word rule with an apostrophe inside a word kept, and words are compared in lower case with the accents of U+0300 to U+036F dropped, so `resume` finds `résumé`. A search looks each query word up among the index's words sorted two ways, by how they begin and by how they end, which the first search after a document is added brings up to date. A query word of `editMinLength` letters or more reads the words that begin with its first half or end with its second half, and the one word with the two letters on either side of its middle swapped; a shorter query word reads only the words it begins, and a one-letter word, with an `editMinLength` of 1, reads every word. The module imports nothing but the word rule, so a page can hold it, and it is exported from `@framers/agentos/cognition/library/browser`, `@framers/agentos/cognition/library`, `@framers/agentos/cognition/rag` and the package root. [Library Index: Fuzzy search on a device](../features/LIBRARY_INDEX.md#fuzzy-search-on-a-device) has the full rules for the lookup, marks, passages and sentence ends.

## HybridSearcher

```typescript
import { BM25Index, HybridSearcher, InMemoryVectorStore } from '@framers/agentos/cognition/rag';

const store = new InMemoryVectorStore();
await store.initialize({ id: 'docs', type: 'in_memory' });
await store.createCollection('docs', 1536);

const bm25 = new BM25Index();
// Add each document to the store, with its embedding and textContent, and to bm25 under the same id.

// embeddings: an EmbeddingManager, or any object with generateEmbeddings({ texts }) answering { embeddings }.
const searcher = new HybridSearcher(store, embeddings, bm25, { denseWeight: 0.7, sparseWeight: 0.3 });

const results = await searcher.search('reset a password', 'docs', 5);
// [{ id, score, denseScore, denseRank, sparseScore, sparseRank, textContent, metadata }, ...]
```

`new HybridSearcher(vectorStore, embeddingManager, bm25Index, config)` takes any [`IVectorStore`](../../src/core/vector-store/IVectorStore.ts), an embedder it calls as `generateEmbeddings({ texts: [query] })` and reads `embeddings[0]` from (an `EmbeddingManager` set up as [RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md) shows, or an object of your own), and a `BM25Index` that holds the same documents under the same ids. The config's defaults are `denseWeight` 0.7, `sparseWeight` 0.3, `rrfK` 60 and `fusionMethod` `'rrf'`.

`search(query, collectionName, topK = 10, queryOptions)`:

1. Embeds the query, and throws `HybridSearcher: Failed to generate query embedding.` when the embedder answers no vector.
2. Asks the store for `topK × 3` nearest documents with their text and metadata, and the BM25 index for its `topK × 3` best. `queryOptions` go to the store: a `filter` there narrows the vector leg only, since the BM25 index has no filter.
3. Fuses the two lists and keeps `topK`:

| `fusionMethod` | Each result's `score` |
|---|---|
| `'rrf'` | `denseWeight / (rrfK + dense rank) + sparseWeight / (rrfK + sparse rank)`, with ranks from 1; a leg that did not find the document adds nothing. Sets `denseRank` and `sparseRank`. |
| `'weighted-sum'` | `denseWeight × the normalized similarity + sparseWeight × the normalized BM25 score`, each leg normalized as `(score - min) / (max - min)` over its own results, with `min` taken no higher than 0 and `max` no lower than 1. Sets no ranks. |
| `'interleave'` | No fusion: the next new document from the vector leg, then from the BM25 leg, in turn, each with its own leg's score and rank. |

4. A result only the BM25 leg found has no `textContent`. On a store with `fetchByIds` (`PostgresVectorStore`), the searcher fetches those documents' text and metadata by id; on other stores, `InMemoryVectorStore` among them, it leaves them without.

[`HybridRetriever`](../architecture/hybrid-retriever.md) is the memory-domain sibling: it fuses `MemoryStore.query` with a `BM25Index` it owns, and is not built on `HybridSearcher`.

## Fusing ranked lists

`reciprocalRankFusion(dense, sparse, { denseWeight, sparseWeight, k })` fuses two lists of `{ id, rank }`, ranks from 1, with the defaults 0.7, 0.3 and 60, and answers `{ id, score, denseRank, sparseRank }` best first; equal scores are ordered by id. It is exported from `@framers/agentos/cognition/memory` (also `@framers/agentos/memory` and the package root), and its module imports nothing; `LibraryIndex` fuses with it at weights 1 and 1.

```typescript
import { reciprocalRankFusion } from '@framers/agentos/cognition/memory';

reciprocalRankFusion(
  [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }],
  [{ id: 'b', rank: 1 }, { id: 'c', rank: 2 }],
);
// b: 0.7/62 + 0.3/61 ≈ 0.0162, then a: 0.7/61 ≈ 0.0115, then c: 0.3/62 ≈ 0.0048
```

`@framers/agentos/cognition/web-search` exports the fusion and deduplication that `WebSearchService` runs over the results of several search providers. They are pure functions:

| Function | What it does |
|---|---|
| `normalizeUrl(url)` | Drops the `http://` or `https://`, a leading `www.`, the slashes the URL ends with, and each `utm_*`, `ref`, `source`, `fbclid` and `gclid` parameter with the `?` or `&` before it, then a `?` left at the end. |
| `computeRRF(candidates, k = 60)` | Sets each candidate's `rrfScore` to the sum of `1 / (k + rank)` over its `providerRanks`, and sorts the array best first. |
| `computeWeightedRRF(candidates, weights, k = 60)` | The same, with each term multiplied by `weights[provider]`, 1 for a provider not in `weights`. |
| `semanticDedup(candidates, threshold = 0.85)` | Merges candidates whose normalized URLs are equal, then those whose snippets' term-frequency vectors have a cosine of at least `threshold`. A merged candidate keeps every provider's rank, the first one's text, the other's `content` when it had none, and the higher `relevanceScore`. |
| `buildVocabulary(texts)`, `buildTfVector(text, vocabulary)` | The vocabulary and the vectors `semanticDedup` compares: lower-cased words split at every character other than an ASCII letter, digit or underscore (so `café` gives `caf`), each count divided by the text's word count. |

`WebSearchService` records each provider's ranks from 0 and weighs each provider by its `weight`, so a provider's first result adds `weight / 60`.

## Other lexical search in the package

- [`LibraryIndex`](../features/LIBRARY_INDEX.md) searches the sources of a library over a vector store, lexical, dense or hybrid, inside a tenant and access groups.
- `PostgresVectorStore.lexicalSearch()` and `hybridSearch()` rank with PostgreSQL full-text search (`ts_rank`, not BM25) ([Postgres + pgvector Backend](../memory/POSTGRES_BACKEND.md#lexical-search-and-the-words-of-a-hybrid-search)).
- `SqlVectorStore.hybridSearch()` scores BM25 over the collection's rows itself and fuses it with the dense ranking, by RRF unless asked for a weighted sum ([RAG Memory Configuration](../memory/RAG_MEMORY_CONFIGURATION.md#retrieval-strategies-implemented)).
- The SQLite brain keeps an FTS5 index over its memory traces, which `recall()` and the `memory_search` tool query ([SQLite Brain Storage](../memory/MEMORY_STORAGE.md)).
- The `QueryRouter` falls back to keyword matching over its corpus when it has no embeddings ([Query Router](../QUERY_ROUTER.md)).

## Where it runs

`LexicalIndex` and `FuzzyIndex`, through `@framers/agentos/cognition/library/browser`, run in a browser; nothing that entry reaches imports a Node module or a package. `BM25Index`, `HybridSearcher`, `InMemoryVectorStore` and `@framers/agentos/cognition/rag` run in Node. No index calls a model; `HybridSearcher` calls the embedder it is given once per search, and a hosted embedder needs its provider's key.

## Examples

- [`examples/text-search-bm25.mjs`](../../examples/text-search-bm25.mjs): a `BM25Index` searched with any and all words and by prefix, saved as JSON and restored; the same documents with a stemming pipeline; and a `LexicalIndex` with `lexicalTokens` and a snippet for each hit.
- [`examples/text-hybrid-search.mjs`](../../examples/text-hybrid-search.mjs): `HybridSearcher` over an `InMemoryVectorStore` and a `BM25Index`, with a stand-in embedder written in the example, and each result's dense and BM25 ranks.
