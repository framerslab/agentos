# Library Index

A library of sources over any vector store. A source, such as a kept transcript or a document, is held as one unit: its passages are indexed under a tenant and access groups, filed in a folder, tagged and titled; it is replaced whole, re-scoped or removed; and a search reads only what its scope may see.

```typescript
import { embedText } from '@framers/agentos';
import { InMemoryVectorStore } from '@framers/agentos/cognition/rag';
import { LibraryIndex, chunkTurns, lexicalTokens, snippetAround } from '@framers/agentos/cognition/library';

const store = new InMemoryVectorStore();
await store.initialize({ id: 'library', type: 'in_memory' });
await store.createCollection('library', 1536);

const index = new LibraryIndex({
  store,
  collection: 'library',
  embed: async (texts) =>
    (await embedText({ provider: 'openai', model: 'text-embedding-3-small', input: texts })).embeddings,
});

const turns = [
  { seq: 1, itemId: 'item_1', text: 'The budget grows by ten percent next quarter.', startMs: 0, endMs: 4200 },
  { seq: 2, itemId: 'item_2', text: 'Hiring opens in May.', startMs: 4200, endMs: 6100 },
];

await index.indexSource({
  sourceId: 'session:s1',
  kind: 'session',
  tenantId: 'org1',
  aclGroups: ['acct:ann'],
  tags: ['q3'],
  title: 'Budget review',
  passages: chunkTurns(turns).map((chunk) => ({
    text: chunk.text,
    metadata: { firstSeq: chunk.firstSeq, lastSeq: chunk.lastSeq },
  })),
});

const [hit] = await index.search({
  text: 'budget',
  scope: { tenantId: 'org1', aclGroups: ['acct:ann', 'org:org1'] },
  topK: 3,
});
if (hit) console.log(hit.title, snippetAround(hit.text, lexicalTokens('budget')).text);
```

The module is `@framers/agentos/cognition/library`; its names are also exported from `@framers/agentos/cognition/rag` and the package root. Nothing in it imports a Node module.

## Sources

A source is an id unique in the collection (`session:<id>`, `document:<id>`), a kind, a tenant, the access groups that may see it, an optional folder, tags and title, metadata copied onto every passage, and its passages.

`indexSource(source)` deletes whatever the collection holds under the source's id, then embeds the passages and writes them `batchSize` at a time (64 unless given). A failed batch leaves the passages written before it; indexing the source again replaces them. A delete or a write the store reports as failed in its result (`failedCount` or `errors`), instead of throwing, fails the call as well. A source with no tenant or no access group is refused. The index makes no collection: create it on the store first.

Every passage carries these metadata keys:

| Key | Value |
|---|---|
| `tenantId` | The source's tenant. |
| `aclGroups` | The groups that may see it. |
| `status` | `'active'`, the status `scopeToMetadataFilter` asks for unless told otherwise. |
| `sourceId` | The source's id. |
| `kind` | The source's kind. |
| `index` | The passage's number in the source, from 0. The passage's id is `<sourceId>#<index>`. |
| `folderId` | The folder, when the source has one. |
| `tags` | The source's tags, `[]` when it has none. |
| `title` | The title, when the source has one. |

The keys in this table come from the source's own fields: they win over the same keys in the source's `metadata` and in a passage's, and a `folderId` or `title` held only there is dropped, so a source indexed without a folder is in none. The source's `metadata` wins over a passage's own.

`setSourceScope(sourceId, { aclGroups, folderId, tags, title })` writes the keys it is given onto every passage of the source through the store's `updateMetadata` and answers how many passages changed. `folderId: null` takes the source out of its folder; an empty `aclGroups` is refused. `removeSource(sourceId)` and `removeTenant(tenantId)` delete by filter and answer the store's `deletedCount`: how many passages went on a store that counts a delete by filter, and the store's own value on one that does not (see [Stores](#stores)). A delete the store reports as failed throws.

## Search

`search({ text, scope, mode, topK, kinds, folderId, folderIds, tags, sourceIds, anyOf, match, prefix })` answers passages, at most `topK` (10 unless given).

| `mode` | What runs | The store member it calls |
|---|---|---|
| `lexical` | The store's lexical index alone, with no embedding. | `lexicalSearch` |
| `hybrid` (the default) | One embedding of the query; the store fuses its dense and lexical legs. | `hybridSearch`, or `query` (the dense search alone) on a store without it |
| `dense` | One embedding of the query; the nearest passages. | `query` |

A search with `anyOf` calls the store's legs apart and ranks them itself: see [Several narrowings at once](#several-narrowings-at-once).

`match` asks for any word of the query (`'any'`, the default) or every word (`'all'`), and `prefix` (false by default) lets a stored word match when it begins with a query word; both go to the lexical leg of a `lexical` or `hybrid` search.

Every search names its scope, `{ tenantId, aclGroups }`. A scope with no tenant or no group is refused before the embedder or the store is asked. The filter the store receives keeps the passages of that tenant whose `aclGroups` hold at least one of the scope's groups and whose `status` is `active`. The narrowing options add to it, each joined to the others with "and": `kinds` keeps any of those kinds, `folderId` that folder, `folderIds` any of those folders, `tags` passages that hold every one of those tags, and `sourceIds` any of those sources. Given `folderId` and `folderIds` together, both apply. An empty `kinds` or `tags` narrows nothing; an empty `sourceIds` or `folderIds` finds nothing, as does a `folderId` that is not in `folderIds`, and the index answers these without asking the embedder or the store. The index then checks every passage the store answers against the same tenant, groups, status and narrowing, and drops any that fails them: a store whose filter drops or ignores a condition cannot widen a search, and on such a store a search can answer fewer than `topK` passages.

Each passage found has `id`, `sourceId`, `kind`, `index`, `text`, `score` (the store's, for the mode, read as a number; a hybrid search with `anyOf` on a store with `lexicalSearch` answers the index's fused score instead), `title` and `folderId` when the passage holds them, `tags`, and its whole `metadata`.

### Several narrowings at once

`anyOf` joins several narrowings with "or": a passage is found when any one of them holds. Each entry takes `kinds`, `folderId`, `folderIds`, `tags` and `sourceIds`, which replace the search's own options of the same name; the text, the scope and the other options are the search's for every entry. A person who chose two folders and one document as the sources of a search, and turned past sessions on, is searched as:

```typescript
const passages = await index.search({
  text: 'when does hiring open',
  scope: { tenantId: 'org1', aclGroups: ['acct:ann', 'org:org1'] },
  topK: 8,
  anyOf: [
    { kinds: ['document'], folderIds: ['folder:plans', 'folder:budget'] },
    { kinds: ['document'], sourceIds: ['document:d7'] },
    { kinds: ['session'] },
  ],
});
```

A choice is ranked as one search. A `dense` or `hybrid` choice embeds the text once for every entry. Each entry is searched under the scope leg by leg, the dense leg with the store's `query` and the lexical leg with its `lexicalSearch`; the store's `hybridSearch` is not called. A passage that two entries find is kept once. Each leg ranks its passages across every entry by their own score, the similarity to the text or the lexical rank of the text's words in the passage, and keeps as many as it asked of each entry: three times `topK` when a hybrid search runs both legs, `topK` otherwise. A hybrid search then fuses the two rankings once by reciprocal rank fusion, and each passage's `score` is `1/(60 + its dense rank) + 1/(60 + its lexical rank)`, a leg that did not rank it adding nothing; a search that runs one leg keeps the store's score. `PostgresVectorStore`'s own hybrid score is a rank among the passages one filter leaves (it ranks each leg within the filter, then fuses the ranks), so with each entry fused by itself, the best passage of one short document would rank level with the best passage of a large folder. Ranked as one search, a narrow entry's weak passage does not outrank a wide entry's stronger ones.

An empty `anyOf` finds nothing, as does one whose every entry finds nothing by its own narrowing (an empty `sourceIds` or `folderIds`, or a `folderId` outside its `folderIds`), without a call to the embedder or the store. On a store without `lexicalSearch`, which is every store in `@framers/agentos/cognition/rag` but `PostgresVectorStore`, a `hybrid` search with `anyOf` runs the dense leg alone, even on a store that has `hybridSearch`, and a `lexical` one throws. A choice of three entries asks the store at most six times.

## Stores

The index asks the store's own filter for the scope and the narrowing, checks what the store answers, and replaces and removes sources with `delete` by `DeleteOptions.filter`. A store serves it fully when it honours these `MetadataFilter` rules:

- a plain value and `$eq` (`tenantId`, `folderId`, and the `sourceId` or `tenantId` of a removal);
- `$in`, which on an array field keeps a passage whose field holds at least one of the values (the scope's `aclGroups`), and on a plain field one whose value is among them (`status`, `kinds`, `folderIds`, `sourceIds`);
- `$all` on an array field, which keeps a passage whose field holds every value (`tags`);
- `delete` by `DeleteOptions.filter`, answering how many passages went.

`PostgresVectorStore` and `InMemoryVectorStore` honour all of them. The other stores in `@framers/agentos/cognition/rag` fall short of at least one:

| Store | Where it falls short | What the index does on it |
|---|---|---|
| `SqlVectorStore`, `HnswlibVectorStore` | `$in` compares an array field as one value. | Dense and hybrid searches find nothing: no passage's `aclGroups` passes. |
| `Neo4jVectorStore` | `$in` compares an array field as one value, and `delete` with a filter alone deletes nothing and answers 0. | A dense search finds nothing, and a hybrid search answers only what its lexical leg finds within the scope; a hybrid search with `anyOf`, which runs the dense leg alone there, finds nothing. `removeSource` and `removeTenant` leave the passages, and indexing a source again leaves those past its new count. |
| `PineconeVectorStore`, `QdrantVectorStore` | Their filters drop `$all`, and a delete by filter answers -1 (Pinecone) or 0 (Qdrant) in place of a count. | A search with `tags` can answer fewer than `topK` passages, since the index drops those without every tag. `removeSource` and `removeTenant` answer the store's value. |

- `PostgresVectorStore` has every member the index calls, the optional ones included: `lexicalSearch`, `hybridSearch` with `match` and `prefix`, `updateMetadata` and `delete` by filter. Its options, its text search configuration and its filter rules are in [Postgres + pgvector Backend](../memory/POSTGRES_BACKEND.md). `removeSource`, `removeTenant` and `setSourceScope` filter on `metadata_json->>'sourceId'` or `metadata_json->>'tenantId'`, which the store's GIN index on `metadata_json` does not serve: without an index of your own on that expression, each reads every row of the collection.
- `InMemoryVectorStore` honours `delete` by filter and runs `dense` and `hybrid` searches, the latter as its dense search. It has no `lexicalSearch` and no `updateMetadata`, so a `lexical` search or `setSourceScope` throws on it.

## A transcript's passages

`chunkTurns(turns, { maxChars, overlapTurns })` cuts a transcript's turns, in order, into passages of consecutive turns joined by one line feed. A turn is never cut: a passage holds at most `maxChars` characters (1,200 unless given), unless one turn alone is longer, which then has a passage of its own. Each next passage opens with up to `overlapTurns` turns (1 unless given) from the end of the passage before, never its first turn, and keeps only as many of them as fit within `maxChars` together with the next new turn. Every passage after the first therefore holds at least one turn the passage before did not, and the last passage is the one that holds the last turn. Turns that are empty or white space alone are left out.

Each passage has `index` (from 0), `text`, `firstSeq`, `lastSeq`, `itemIds`, `startMs` (the first turn's start) and `endMs` (the last turn's end), `null` when not known, and `turns`: each turn's `seq`, `itemId`, and its `start` and `end` in `text`. A quote that lies inside one turn's place in a passage is a verbatim span of that turn.

## Words and snippets

`lexicalTokens(text)` answers a text's words: lower-case runs of letters and digits, in order, in any script, nothing stemmed. `lexicalTokens("Q3's budget: 1,200 units")` is `['q3', 's', 'budget', '1', '200', 'units']`. `PostgresVectorStore` builds its lexical query from the same runs.

`snippetAround(text, words, { before, after })` finds the first word of `text` that begins with one of `words` and answers `{ at, text }`. `at` is where that word starts in the text as given, or -1 when no word matches. `text` is the snippet in whole words, with white space collapsed: it runs from just after the last white space (a space, a tab or a line break, such as the one between two turns of a passage) at or before `before` characters (80 unless given) ahead of the word, or from the text's start, to the first white space at or after `after` characters (120 unless given) past the word's start, or to the text's end. A text with no white space, as Chinese and Japanese are written, comes back whole. With no match, the snippet is the text's start.
