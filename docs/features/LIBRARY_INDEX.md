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

`indexSource(source)` deletes whatever the collection holds under the source's id, then embeds the passages and writes them `batchSize` at a time (64 unless given). A failed batch leaves the passages written before it; indexing the source again replaces them. A source with no tenant or no access group is refused. The index makes no collection: create it on the store first.

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

`setSourceScope(sourceId, { aclGroups, folderId, tags, title })` writes the keys it is given onto every passage of the source through the store's `updateMetadata` and answers how many passages changed. `folderId: null` takes the source out of its folder; an empty `aclGroups` is refused. `removeSource(sourceId)` and `removeTenant(tenantId)` delete by filter and answer how many passages went.

## Search

`search({ text, scope, mode, topK, kinds, folderId, tags, sourceIds, match, prefix })` answers passages, at most `topK` (10 unless given).

| `mode` | What runs | The store member it calls |
|---|---|---|
| `lexical` | The store's lexical index alone, with no embedding. | `lexicalSearch` |
| `hybrid` (the default) | One embedding of the query; the store fuses its dense and lexical legs. | `hybridSearch`, or `query` (the dense search alone) on a store without it |
| `dense` | One embedding of the query; the nearest passages. | `query` |

`match` asks for any word of the query (`'any'`, the default) or every word (`'all'`), and `prefix` (false by default) lets a stored word match when it begins with a query word; both go to the lexical leg of a `lexical` or `hybrid` search.

Every search names its scope, `{ tenantId, aclGroups }`. A scope with no tenant or no group is refused before the store is asked. The filter the store receives keeps the passages of that tenant whose `aclGroups` hold at least one of the scope's groups and whose `status` is `active`. The narrowing options add to it: `kinds` keeps any of those kinds, `folderId` that folder, `tags` passages that hold every one of those tags, and `sourceIds` any of those sources. An empty `kinds` or `tags` narrows nothing; an empty `sourceIds` finds nothing.

Each passage found has `id`, `sourceId`, `kind`, `index`, `text`, `score` (the store's, for the mode, read as a number), `title` and `folderId` when the passage holds them, `tags`, and its whole `metadata`.

## Stores

The index replaces and removes sources with `delete` by `DeleteOptions.filter`, so the store must honour that filter.

- `PostgresVectorStore` has every member the index calls, the optional ones included: `lexicalSearch`, `hybridSearch` with `match` and `prefix`, `updateMetadata` and `delete` by filter. Its options, its text search configuration and its filter rules are in [Postgres + pgvector Backend](../memory/POSTGRES_BACKEND.md). `removeSource`, `removeTenant` and `setSourceScope` filter on `metadata_json->>'sourceId'` or `metadata_json->>'tenantId'`, which the store's GIN index on `metadata_json` does not serve: without an index of your own on that expression, each reads every row of the collection.
- `InMemoryVectorStore` honours `delete` by filter and runs `dense` and `hybrid` searches, the latter as its dense search. It has no `lexicalSearch` and no `updateMetadata`, so a `lexical` search or `setSourceScope` throws on it.

## A transcript's passages

`chunkTurns(turns, { maxChars, overlapTurns })` cuts a transcript's turns, in order, into passages of consecutive turns joined by one line feed. A turn is never cut: a passage holds at most `maxChars` characters (1,200 unless given), unless one turn alone is longer, which then has a passage of its own. Each next passage opens with up to `overlapTurns` turns (1 unless given) from the end of the passage before, never its first turn, and keeps only as many of them as fit within `maxChars` together with the next new turn. Every passage after the first therefore holds at least one turn the passage before did not, and the last passage is the one that holds the last turn. Turns that are empty or white space alone are left out.

Each passage has `index` (from 0), `text`, `firstSeq`, `lastSeq`, `itemIds`, `startMs` (the first turn's start) and `endMs` (the last turn's end), `null` when not known, and `turns`: each turn's `seq`, `itemId`, and its `start` and `end` in `text`. A quote that lies inside one turn's place in a passage is a verbatim span of that turn.

## Words and snippets

`lexicalTokens(text)` answers a text's words: lower-case runs of letters and digits, in order, in any script, nothing stemmed. `lexicalTokens("Q3's budget: 1,200 units")` is `['q3', 's', 'budget', '1', '200', 'units']`. `PostgresVectorStore` builds its lexical query from the same runs.

`snippetAround(text, words, { before, after })` finds the first word of `text` that begins with one of `words` and answers `{ at, text }`. `at` is where that word starts in the text as given, or -1 when no word matches. `text` is the snippet in whole words, with white space collapsed: it runs from just after the last white space (a space, a tab or a line break, such as the one between two turns of a passage) at or before `before` characters (80 unless given) ahead of the word, or from the text's start, to the first white space at or after `after` characters (120 unless given) past the word's start, or to the text's end. A text with no white space, as Chinese and Japanese are written, comes back whole. With no match, the snippet is the text's start.
