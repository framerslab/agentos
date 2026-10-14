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

The module is `@framers/agentos/cognition/library`; its names are also exported from `@framers/agentos/cognition/rag` and the package root. Nothing in it imports a Node module but `SqlSourceDerivationStore`, which imports `node:crypto`; a page imports the [browser entry](#on-a-device).

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

A choice is ranked as one search. A `dense` or `hybrid` choice embeds the text once, and that one embedding serves every entry. Each entry is searched under the scope leg by leg, the dense leg with the store's `query` and the lexical leg with its `lexicalSearch`; the store's `hybridSearch` is not called. A passage that two entries find is kept once. Each leg ranks its passages across every entry by their own score, the similarity to the text or the lexical rank of the text's words in the passage, and keeps as many as it asked of each entry: three times `topK` when a hybrid search runs both legs, `topK` otherwise. A hybrid search that runs both legs then fuses the two rankings once by reciprocal rank fusion, and each passage's `score` is `1/(60 + its dense rank) + 1/(60 + its lexical rank)`, a leg that did not rank it adding nothing; a search that runs one leg keeps the store's score. `PostgresVectorStore`'s own hybrid score is a rank among the passages one filter leaves (it ranks each leg within the filter, then fuses the ranks), so with each entry fused by itself, the best passage of one short document would rank level with the best passage of a large folder. Ranked as one search, a narrow entry's weak passage does not outrank a wide entry's stronger ones.

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

## Results from private sources

```typescript
import { canDeliverSourceDerivation, createSourceDerivation } from '@framers/agentos/cognition/library';

const read = {
  tenantId: 'tenant-1',
  ownerId: 'account-1',
  connectionId: 'connection-1',
  generation: 4,
  sourceId: 'source-1',
  messageIds: ['message-7', 'message-9'],
  version: 'v-2f6c',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
};

// The answer's record: one entry for every private input, quoted in the answer or not.
const answer = createSourceDerivation([read]);

// At delivery, against the sources' state read in the same transaction that delivers.
const current = [{ ...read, connected: true, paused: false, searchAskEnabled: true, liveEnabled: false }];
const deliverable = canDeliverSourceDerivation(
  answer,
  { tenantId: 'tenant-1', ownerId: 'account-1', surface: 'ask', liveOptIn: false },
  current,
  Date.now(),
);
// true; with surface 'share', or once the source is paused, removed or expired, false
```

A result made from private sources, such as an answer drawn from the documents of a connected account, keeps a record of every source version it was made from, and goes only to its owner's private use while each of those sources is unchanged and unexpired.

`createSourceDerivation(dependencies)` makes the record. Each dependency names a tenant, an owner, a connection and its `generation`, a source, the `messageIds` of the source that the result used, the source's `version` and `expiresAt`, when the source's copy expires. Identifiers are opaque keys, never display text; `generation` and `expiresAt` are nonnegative safe integers, `expiresAt` in UTC epoch milliseconds. Pass one dependency for every private input of the result, whether or not the result quotes it. Dependencies on the same tenant, owner, connection and source are merged into one: their message ids are joined and sorted, and the earlier expiry is kept. The record is `{ tenantId, ownerId, visibility: 'personal', expiresAt, dependencies }`. Its `expiresAt` is the earliest of its dependencies', its dependencies are in a fixed order, sorted by the JSON text of each one's `[tenantId, ownerId, connectionId, sourceId]` compared by UTF-16 code units, and the record, each dependency and each list of message ids are frozen copies, which later changes to the arrays passed in do not reach. It throws a `RangeError` with the message `invalid_source_dependency` for an empty list; a dependency with an empty identifier, version or message id, no message ids, or a `generation` or `expiresAt` that is not a nonnegative safe integer; dependencies of more than one tenant or owner; and two dependencies on one source with different generations or versions.

`canDeliverSourceDerivation(derivation, context, current, now)` answers whether the record's result may be delivered at `now`, in UTC epoch milliseconds. `context` names the receiver's `tenantId` and `ownerId`, the destination `surface`, and `liveOptIn`, whether the receiving live session chose these sources. `current` holds each source's state now: a dependency's fields with `connected`, `paused`, `searchAskEnabled` and `liveEnabled`. It answers true only when all of these hold:

- the receiver is the record's tenant and owner;
- the surface is `search` or `ask`, or `live` with `liveOptIn` true. `team`, `guest`, `share`, `export` and `outbound` refuse the whole result, however little of it a private source made;
- `now` is before the record's expiry and before each dependency's, and the record's expiry is the earliest of its dependencies';
- each dependency has one row in `current`, matched by tenant, owner, connection and source, and that row is connected, not paused and unexpired, holds the dependency's generation, version and every one of its message ids, and has the surface's switch on: `liveEnabled` for `live`, `searchAskEnabled` for `search` and `ask`.

A record, row or dependency with a malformed field, a source given twice in `current` or in the record, a dependency of another tenant or owner than the record's, a record with no dependencies and a `now` that is not a nonnegative safe integer each answer false. Where a check meets a `null` or `undefined` record, context, row or dependency, a record whose `dependencies` is missing or cannot be iterated, or a `current` that cannot be iterated, it throws a `TypeError` instead; either way nothing is delivered. A source read again with a later expiry does not extend a record made before: the record keeps its own expiry.

`canDeliverSourceDerivation` reads no database and takes no lock. Read `current` in the transaction that commits or delivers the result, serialized with disconnection, pausing, removal, expiry and changes to the switches: a check against rows read earlier can deliver a result whose source is gone. `SqlSourceDerivationStore`, below, does this on PostgreSQL.

## Stored results and deletion fences

```typescript
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import {
  SqlSourceDerivationStore,
  createSourceDerivation,
  sourceDerivationSchema,
} from '@framers/agentos/cognition/library';

const db = createPostgresAdapter({ connectionString: process.env.DATABASE_URL });
await db.open();
// Once, from your migration: the store never creates its tables.
for (const statement of sourceDerivationSchema()) await db.exec(statement);

// Your own functions, each working on the transaction it is given.
const store = new SqlSourceDerivationStore(db, {
  bindings: {
    readCurrent: (tx, derivation) => readSourceStates(tx, derivation),
    purgeResults: (tx, owner, resultIds) => deleteSavedCopies(tx, owner, resultIds),
    purgeSources: (tx, owner, affected) => deleteSourceContent(tx, owner, affected),
  },
});

const owner = { tenantId: 'tenant-1', ownerId: 'account-1' };
await store.activateOwner(owner, (tx) => accountIsActive(tx, owner));

const ticket = await store.capture(owner); // before the model call
const text = await answer(question, passages); // outside the store
const context = { ...owner, surface: 'ask', liveOptIn: false } as const;
if (ticket && await store.commit(ticket, 'answer-1', createSourceDerivation(reads), text, context)) {
  await store.deliver('answer-1', context, (payload) => {
    outbox.push(payload);
    return true;
  });
}

// Disconnecting a connection: the fence first, then the purge.
await store.blockOwner(owner, (tx) => markDisconnecting(tx, owner));
await store.invalidate(owner, { kind: 'connection', connectionId: 'connection-1' }, (tx) => markDisconnected(tx, owner));
```

`SqlSourceDerivationStore` keeps results made from private sources in PostgreSQL, with the sources each one depends on, and serializes committing and delivering them with the removal of those sources. It takes a PostgreSQL `StorageAdapter` with transactions; any other adapter throws `derivations_require_postgres_transactions`. `sourceDerivationSchema(prefix)` answers the statements that create its tables, which your migration runs: the store never does. The prefix is `agentos_source_derivation` unless given, and is a lower-case letter followed by at most 39 lower-case letters, digits or underscores; another throws `invalid_derivation_table_prefix`. Give the store the same prefix as `tablePrefix`, and `clock` when its time is not `Date.now`.

Each call that reads or writes an owner's state runs in a transaction of its own that first locks the owner's row, so one owner's commits, deliveries, removals and expiry run one at a time, and different owners run independently but for one shared row, locked last and briefly, while a deletion record is written. A store made on a transaction view, the adapter a `transaction` callback receives, runs each call inside that caller's transaction instead, since the view's own `transaction` runs a callback in the transaction it belongs to: the owner's row, and after a deletion record the shared row, stay locked until the caller commits or rolls back, and the caller's rollback undoes the call. The three bindings run inside that transaction and must work only on the adapter they are given:

- `readCurrent(tx, derivation)` answers the current state of the derivation's sources, read now from your own rows: generation, version, held message ids, expiry, `connected`, `paused` and the two use switches. It leaves out a source that is gone, and answers none for an account you are deleting. An answer from a cache defeats the fence.
- `purgeResults(tx, owner, resultIds)` deletes every copy you hold of those results, such as a saved mark or a summary, whole.
- `purgeSources(tx, owner, affected)` deletes the source content in the affected scope: text, metadata, passages and vectors.

Reads from a provider, parsing, embedding, model calls and revocation never run inside a binding or a callback the store runs.

An owner starts inactive and is active once `activateOwner(owner, authorize)` runs `authorize` in the transaction and it answers true; check there that the account is active and has no deletion pending. Each owner has an epoch: activating an inactive owner, `blockOwner`, an applied `invalidate` and a replayed deletion each advance it.

- `capture(owner)` answers a ticket holding the current epoch, or null while the owner is inactive. Capture it before the work outside the store begins.
- `commit(ticket, id, derivation, payload, context)` stores the whole result and its dependencies only while the owner is active at the ticket's epoch, `context` and the record name the ticket's tenant and owner, the record is personal with the earliest expiry of its dependencies, and `canDeliverSourceDerivation` allows it for `context` against what `readCurrent` reads in the same transaction. It answers whether it stored the result: an id the owner already holds and a payload longer than 1,048,576 UTF-16 code units answer false.
- `deliver(id, context, enqueue)` reads the stored result and its sources' state under the lock and, while the owner is active and `canDeliverSourceDerivation` allows `context`, calls `enqueue(payload)` before the lock is released. `enqueue` hands the payload on at once and answers a boolean: any other answer throws `source_delivery_must_be_synchronous`, and when `enqueue` throws, `deliver` rejects with its error. `deliver` answers what `enqueue` answered, or false, and never returns the payload. Each separately generated part of an answer is committed and delivered on its own.
- `apply(ticket, work)` runs short storage work in the transaction while the owner is active at the ticket's epoch, and answers `{ kind: 'applied', value, ticket }`; otherwise it answers `{ kind: 'stale' }` without calling `work`. It is for installing first content and job records, not for changing content results depend on.
- `invalidate(owner, affected, mutate, { expected, disableOwner })` advances the epoch, deletes every whole result that depends on the affected owner, connection or source (with your copies, through `purgeResults`) and the source content (through `purgeSources`), runs `mutate`, and writes a deletion record, all in one transaction: a binding or `mutate` that throws undoes all of it. With `expected`, it changes nothing and answers `stale` unless the owner is active at that ticket's epoch. `disableOwner` leaves the owner inactive and needs `{ kind: 'owner' }`. Replacing or removing a source's content goes through `invalidate`, so results made from the old content go with it.
- `blockOwner(owner, mutate)` makes the owner inactive with a new epoch, runs `mutate` and writes an owner-wide deletion record. Commit it before a purge: if the purge then fails, nothing of the owner's is committed or delivered until `activateOwner` succeeds again. After a purge of one connection, `activateOwner` makes the owner's other sources deliverable again.
- `expireResults(owner, limit)` removes at most `limit` expired results (1 to 1,000, 100 unless given), earliest first, with your copies, and answers how many it removed. A result is never delivered past its expiry, whether this runs or not.

A deletion record holds its sequence and id, the owner, the affected scope's kind and opaque keys, the epoch it set, when it was written and whether it left the owner inactive: never a result, a payload, a message id or any other property of the scope object passed to `invalidate` or `replayTombstones`. `readTombstones(afterSequence, limit)` pages through the records in the order they committed, after `afterSequence` (0 for the first page), at most `limit` at a time (1 to 1,000, 100 unless given). It reads every owner's records, for an operator's recovery: never hand it to an account's session. After a database is restored, `replayTombstones(records)` with every record newer than the backup makes each affected owner inactive and purges all of that owner's results and source content, whatever the record's scope; replaying the same records again is harmless, and the owner needs `activateOwner` again. The records live in the same database as the results, so a backup holds only the records older than itself: keep a copy of them outside it to replay from.

## On a device

```typescript
import { LexicalIndex, chunkTurns, lexicalTokens } from '@framers/agentos/cognition/library/browser';

const turns = [
  { seq: 1, itemId: 'item_1', text: 'The chapters on the budget review come first.' },
  { seq: 2, itemId: 'item_2', text: 'Hiring opens in May.' },
];

const index = new LexicalIndex({ tokenize: lexicalTokens });
for (const chunk of chunkTurns(turns)) {
  index.addDocument(`session:s1#${chunk.index}`, chunk.text, { firstSeq: chunk.firstSeq });
}

const [hit] = index.search('chap budg', 10, { prefix: true, match: 'all' });
// hit.id === 'session:s1#0'

const saved = JSON.stringify(index.toJSON());
const restored = LexicalIndex.fromJSON(JSON.parse(saved), { tokenize: lexicalTokens });
restored.search('hiring', 5); // the same passage
```

`LexicalIndex` is the BM25 engine with no import, so a page can hold a search index of its own. It reads text with the tokenizer it is given; with `lexicalTokens` it reads words by the rule of [Words and snippets](#words-and-snippets). Its scores are BM25 with `k1` 1.2 and `b` 0.75 unless given. Adding a document under an id the index holds replaces it, `removeDocument(id)` answers whether the id was there, and `getStats()` answers `documentCount`, `termCount` and `avgDocLength`. A hit is `{ id, score, metadata }`: the index keeps no text, so the page keeps its passages' texts and places a snippet with `snippetAround`.

`search(query, topK, { match, prefix })` answers at most `topK` documents (10 unless given), highest score first:

- `match: 'any'` (the default) ranks every document that holds at least one of the query's words; `match: 'all'` keeps only the documents that hold every one of them.
- `prefix: true` lets a stored word match when it begins with a query word, so `chapter` finds `chapters`. When several stored words begin with one query word, a document scores by the best of them for that word. With `prefix` left out, a word matches only itself.

`toJSON()` answers the index as plain JSON, version 1: `k1`, `b`, each document's id, its length in tokens and its metadata, and each term's postings. `LexicalIndex.fromJSON(json, { tokenize })` restores it. A saved index holds terms, not texts, so give it the tokenizer it was made with. A saved index of another version throws, and so does one that `toJSON()` could not have written, with an error that names what is wrong: a part out of shape, an id, a term or a position given twice, or a count under 1. Metadata is saved as given, so keep it to values JSON can hold.

`BM25Index`, in `@framers/agentos/cognition/rag`, is a `LexicalIndex` with AgentOS's tokenizer: `tokenize` when its options give one, else its `pipeline`, else the built-in tokenizer, which reads its stop words on first use. It is saved with `toJSON()` and restored with `BM25Index.fromJSON(json, config)`, which takes `k1` and `b` from the saved index and the tokenizer from `config`. Its module reaches `node:module`, which loads `natural`, so a page imports `LexicalIndex` instead.

`@framers/agentos/cognition/library/browser` is the entry a page imports. It exports `LexicalIndex`, `lexicalTokens`, `snippetAround` and `chunkTurns`, with the types `LexicalIndexConfig`, `LexicalIndexJSON`, `LexicalSearchOptions`, `BM25Result`, `BM25Stats`, `Snippet`, `ChunkTurnsOptions`, `LibraryTurn` and `TurnChunk`, and everything `@framers/agentos/core/storage/browser` exports: the page's key-value store over IndexedDB or memory, the outbox and `reconcileList` ([A Page's Own Records](../memory/CLIENT_SIDE_STORAGE.md#a-pages-own-records)). Nothing it reaches imports a Node module or a package, which a test holds by walking its import graph, and none of it uses the DOM but for IndexedDB, which it reaches only when a page opens a store or calls `idb()`. `LibraryIndex` is not in it: it stays in `@framers/agentos/cognition/library`.
