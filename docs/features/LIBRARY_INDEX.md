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

`lexicalTokens(text)` answers a text's words: the text read in NFC and in lower case, each word a letter or a digit followed by letters, digits and combining marks, in order, in any script, nothing stemmed. `lexicalTokens("Q3's budget: 1,200 units")` is `['q3', 's', 'budget', '1', '200', 'units']`. A mark stays inside its word, so an accent written as a combining mark or a Devanagari vowel sign does not split one, and a text reads the same words composed or decomposed: `lexicalTokens('Re\u0301sume\u0301')` is `['résumé']`, as `lexicalTokens('Résumé')` is. A mark with no letter or digit before it starts no word. `PostgresVectorStore` builds its lexical query from runs of letters and digits in lower case; on a text in NFC that holds no combining mark once in lower case, as precomposed Latin, Greek and Cyrillic, Chinese and Japanese are written, it reads the same words. A capital I with a dot (U+0130) is the exception: lower case turns it into an i and a combining dot, which the word rule keeps in its word and the store's runs split at.

`snippetAround(text, words, { before, after })` finds the first word of `text`, by the same rule, that begins with one of `words`, each word and query word compared in NFC and in lower case, and answers `{ at, text }`. `at` is where that word starts in the text as given, or -1 when no word matches. `text` is the snippet in whole words, with white space collapsed: it runs from just after the last white space (a space, a tab or a line break, such as the one between two turns of a passage) at or before `before` characters (80 unless given) ahead of the word, or from the text's start, to the first white space at or after `after` characters (120 unless given) past the word's start, or to the text's end. A text with no white space, as Chinese and Japanese are written, comes back whole. With no match, the snippet is the text's start.

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

`toJSON()` answers the index as plain JSON, version 1: `k1`, `b`, each document's id, its length in tokens and its metadata, and each term's postings. `LexicalIndex.fromJSON(json, { tokenize })` restores it. A saved index holds terms, not texts, so give it the tokenizer it was made with. `lexicalTokens` reads a text in NFC and keeps a combining mark inside its word from 0.13.143 on, where it used to read the text as given and end a word at a mark. An index that an earlier version saved with it can hold other words than the rule reads now in a text that holds a combining mark once in lower case (an accent written as a letter and a mark, a Devanagari vowel sign, a capital I with a dot) or that NFC changes, such as the pieces between the marks, and a search for the words the rule reads now does not find that text by them. Build such an index again from its texts. A saved index of another version throws, and so does one that `toJSON()` could not have written, with an error that names what is wrong: a part out of shape, an id, a term or a position given twice, or a count under 1. Metadata is saved as given, so keep it to values JSON can hold.

`BM25Index`, in `@framers/agentos/cognition/rag`, is a `LexicalIndex` with AgentOS's tokenizer: `tokenize` when its options give one, else its `pipeline`, else the built-in tokenizer, which reads its stop words on first use. It is saved with `toJSON()` and restored with `BM25Index.fromJSON(json, config)`, which takes `k1` and `b` from the saved index and the tokenizer from `config`. Its module reaches `node:module`, which loads `natural`, so a page imports `LexicalIndex` instead.

`@framers/agentos/cognition/library/browser` is the entry a page imports. It exports `LexicalIndex`, `FuzzyIndex`, `withinOneEdit`, `lexicalTokens`, `snippetAround` and `chunkTurns`, with the types `LexicalIndexConfig`, `LexicalIndexJSON`, `LexicalSearchOptions`, `BM25Result`, `BM25Stats`, `FuzzyIndexConfig`, `FuzzyIndexJSON`, `FuzzySearchOptions`, `FuzzyDocument`, `FuzzyHit`, `FuzzyToken`, `FuzzyTokenizer`, `Marked`, `Snippet`, `ChunkTurnsOptions`, `LibraryTurn` and `TurnChunk`, and everything `@framers/agentos/core/storage/browser` exports: the page's key-value store over IndexedDB or memory, the outbox and `reconcileList` ([A Page's Own Records](../memory/CLIENT_SIDE_STORAGE.md#a-pages-own-records)). It also exports the readers of transcript files, `readTranscript`, `readWordTranscript`, `transcriptFormatOf` and `TranscriptReadError`, with the types `ReadTranscript`, `TranscriptFileTurn`, `TranscriptFileLabel`, `TranscriptFormat`, `ExtractRawText` and `ReadWordTranscriptOptions` ([Transcript files from other notetakers](#transcript-files-from-other-notetakers)), and `planEntries` and `sha256Hex`, with the types `PlanEntryInput`, `PlanRules`, `PlannedEntry`, `PlannedKind` and `PlanSkipReason` ([An archive's plan](#an-archives-plan)). Nothing it reaches imports a Node module or a package, which a test holds by walking its import graph, and none of it uses the DOM but for IndexedDB, which it reaches only when a page opens a store or calls `idb()`. `LibraryIndex` is not in it: it stays in `@framers/agentos/cognition/library`.

## Fuzzy search on a device

```typescript
import { FuzzyIndex } from '@framers/agentos/cognition/library/browser';

const index = new FuzzyIndex({ fields: { title: 100, keywords: 10, body: 1 } });
index.addDocuments([
  {
    id: 'n1',
    fields: {
      title: 'Enclosure samples',
      keywords: ['enclosure', 'factory'],
      body: 'The samples leave the factory on Friday; the moulds are confirmed on Wednesday.',
    },
  },
  {
    id: 'n2',
    fields: {
      title: 'Project Atlas status',
      keywords: ['atlas', 'launch'],
      body: 'Beta ships 3 Oct. Two open blockers: the billing webhook and load testing.',
    },
  },
]);

const [hit] = index.search('factory firday');
// hit.id === 'n1' and hit.score === 10.5: "factory" is a keyword (1 times 10), and "firday" is the body's "Friday"
// with two letters swapped (0.5 times 1).
// hit.fields.keywords: [{ text: 'enclosure', marks: [] }, { text: 'factory', marks: [{ start: 0, end: 7 }] }]
// hit.passages: [{ text: 'The samples leave the factory on Friday; the moulds are confirmed on Wednesday.',
//                  marks: [{ start: 22, end: 29 }, { start: 33, end: 39 }] }]

const saved = JSON.stringify(index.toJSON());
const restored = FuzzyIndex.fromJSON(JSON.parse(saved));
```

`FuzzyIndex` is a search box's index over a page's own records, such as a person's notes: it finds a word typed with a typo or only begun, ranks a match by the field it is in, and answers each hit with its matched words marked and the sentences that hold them. A document is `{ id, fields }`, each field a text or a list of short texts such as keywords, and the index is made with each field's weight, a finite number above 0. A query is read in NFC and cut into words by the library's word rule with an apostrophe inside a word kept, so "Professor's" is one word. Each word, in lower case with the accents of the Combining Diacritical Marks block (U+0300 to U+036F) dropped, so that `resume` finds `résumé`, matches a word of a document that is:

| The stored word | Counts |
|---|---|
| The same word | 1 |
| A word the query word begins: `fact` finds `factory` | 0.75 |
| One edit away, where both words have `editMinLength` letters or more (4 unless given): a letter added, dropped or changed, or two letters side by side swapped, a [Damerau-Levenshtein distance](https://en.wikipedia.org/wiki/Damerau%E2%80%93Levenshtein_distance) of 1. `firday` finds `Friday`; `teh` finds nothing, since `the` has three letters | 0.5 |

A document's score is, for each query word, its best match's count times the weight of the field it is in, summed over the query's words: `score = sum over query words q of max over fields f and their words t of weight(f) * count(q, t)`, each query word counted once. With the weights above, a match in the title outranks one in the keywords, which outranks one in the body, and within a field the same word outranks a word it begins, which outranks a word an edit away. `search(query, { topK, match })` answers at most `topK` hits (10 unless given, `Infinity` for every hit), highest score first, a tie in the order the documents were added. `match: 'all'` (the default) keeps the documents in which every query word matches somewhere; `match: 'any'` keeps those in which at least one does. A query with no word in it finds nothing.

A hit is `{ id, score, fields, passages }`. `fields` holds each field of the document with its matched words marked: a `Marked`, `{ text, marks }`, for a text and a list of them for a list. A mark is a whole word, `{ start, end }` in UTF-16 units of the text as the index holds it, in NFC; a text's marks are in order and never overlap. `passages` holds up to `passages` (3 unless given) sentences or lines of the passage fields that hold a match: those that hold the most query words, then the earliest, shown in the order of the text, each clipped to about `passageWidth` characters (160 unless given) around its first match, at white space, with `…` where text was left out. A document matched only in another field shows the opening of its text, unmarked. The passage fields are those `passageFields` names, in its order, or else the fields of the lowest weight. A sentence ends at a run of full stops, question marks or exclamation marks (or of the Devanagari danda, the Arabic question mark or the Urdu full stop) before white space, or at an ideographic full stop or a full-width exclamation or question mark, and every line break ends one.

`withinOneEdit(a, b)` is the one-edit test alone: true when two words are at most one edit apart, letter by letter over code points, compared as given.

Adding a document under an id the index holds replaces it, and it then counts as added last; a document that is refused leaves the index as it was. A field the index was not made with is neither searched nor kept. `removeDocument(id)` answers whether the id was there. `tokenize` takes the place of the word rule: it answers each word of a text with its `start` and `end`, and the index hands it every text and query in NFC.

A search reads the words near each query word's, not every word the index holds. It keeps the index's words in two orders, by how they begin and by how they end, which the first search after a document is added brings up to date. The query word itself and the words it begins stand together in the first order. A word one edit from the query word keeps one of its halves whole, letter by letter: an edit in the second half leaves the first half as the word's start, and an edit in the first half leaves the second half as its end, but for the two letters on either side of the middle swapped, which makes one more word to look up. So a query word of `editMinLength` letters or more reads the words that begin with its first half or end with its second, and the word with its middle letters swapped; a shorter one reads only the words it begins, and one of a single letter, with an `editMinLength` of 1, reads every word. The search then reads the fields of the hits it answers again to mark them.

`toJSON()` answers the index as plain JSON, version 1: its settings and each document's id and fields, in the order they were added. `FuzzyIndex.fromJSON(json, { tokenize })` restores it and reads the texts again with the tokenizer given, the word rule unless one is. A saved index of another version throws, and so does one that `toJSON()` could not have written, with an error that names what is wrong.

## Transcript files from other notetakers

```typescript
import mammoth from 'mammoth';
import { readTranscript, readWordTranscript, transcriptFormatOf } from '@framers/agentos/cognition/library/browser';

// A file a person picked in a page: its name and its bytes.
const bytes = new Uint8Array(await file.arrayBuffer());
const format = transcriptFormatOf(file.name, bytes.subarray(0, 4096));

const read =
  format === 'docx'
    ? await readWordTranscript(bytes, { extractRawText: mammoth.extractRawText })
    : format === null
      ? null
      : readTranscript(bytes, format);

// read.turns:  [{ seq: 1, startMs: 1000, endMs: 4200, text: 'Good morning. Shall we start with the budget?' }, ...]
// read.labels: [{ seq: 1, label: 'Ana Silva' }, { seq: 2, label: 'Leo Park' }, ...]
// read.durationMs: 28900
```

`readTranscript(input, format)` reads a transcript file's text, or its bytes, in one of five formats, and `readWordTranscript(bytes, { extractRawText })` reads a Word file. Each answers `{ format, turns, labels, durationMs }`:

- `turns`: the turns in the file's order, numbered from 1, each `{ seq, startMs, endMs, text }`. Times are milliseconds from the recording's start where the file gives them, else `null`. A turn's text has its white space collapsed and no speaker's name in it. A turn with no words is left out.
- `labels`: `{ seq, label }` for each turn whose speaker the file names, kept apart from the turns, so a page can keep the names on the device and send only the turns.
- `durationMs`: the last turn's end, `null` when the last turn has none.

Bytes are read as UTF-16 when they open with its byte order mark, in either byte order, and as UTF-8 otherwise. A leading byte order mark is dropped and CRLF line ends are read as line feeds, so a file saved on Windows reads the same. A file with no turn reads as none. The readers set no bound on a file's length: that bound is the caller's.

| `format` | What is read |
|---|---|
| `srt` | SubRip. A cue is a timing line, `00:00:01,000 --> 00:00:04,200`, and the lines after it up to a blank line or the next timing line, so cues written with no blank line between them read as cues. A line of digits just before a timing line is that cue's number, unless it is the only line of the cue before it, and the lines of a block before its first timing line, a cue's number among them, are left out. A cue's text is its lines joined with spaces, with the `<b>`, `<i>`, `<u>` and `<font>` tags removed. Speakers by the `Name: words` rule below. |
| `vtt` | WebVTT. The first line is `WEBVTT`, else `TranscriptReadError`. The header, the lines after the first up to a blank line or the first timing line, is left out, and so are the blocks that are no cue (`NOTE`, `STYLE`, `REGION`). A cue is a timing line and the lines after it up to a blank line or the next timing line, as [WebVTT's parser](https://www.w3.org/TR/webvtt1/#file-parsing) cuts cues, so a cue written with no blank line before it is a cue; a block's lines before its first timing line, such as a cue's identifier, are left out. Cue settings are ignored, and a time may leave out its hours. A cue's speaker is its [voice span](https://www.w3.org/TR/webvtt1/#webvtt-cue-voice-span), `<v Ana Silva>` or `<v.loud Ana Silva>`, and two voice spans in one cue are two turns with the cue's times. Every other tag (class, italics, bold, underline, ruby, language, timestamp) is removed with its words kept. `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&lrm;`, `&rlm;` and the numeric references are decoded once; any other reference stays as written. A file with no voice span anywhere, as a tool writes that puts the speaker's name into the cue text, is read by the `Name: words` rule. |
| `otter` | Otter's text export. A turn is a header line, the speaker's name, two spaces or more and the time the turn starts (`0:01`, or `1:02:10` past the hour), then its paragraph up to the next header. The lines before the first header, a header with no words, and a closing `Transcribed by https://otter.ai` are left out. A header gives a start and no end, so `endMs` and `durationMs` are `null`. A text with no header reads as plain lines. |
| `fireflies` | Fireflies's JSON: the `sentences` of an object, each with `text`, `speaker_name`, `start_time` and `end_time`, the fields of a [Sentence](https://docs.fireflies.ai/schema/sentence) in Fireflies's API, the times read as seconds from a number or a numeric text; or a list at the top, each entry with `sentence`, `speaker_name`, and `startTime` and `endTime` as clocks (`00:04`, `75:30`, `01:15:32`). An entry with no words, or one that is no object, is left out. A text that is not JSON throws `TranscriptReadError`; JSON of another shape has no turns. |
| `lines` | Plain text: one turn a line, no times, speakers by the `Name: words` rule. |

In both caption formats, a line that holds `-->` but not two times is a line of words.

The `Name: words` rule finds a speaker at the start of a turn's text: the name before the first colon, trimmed, of at most forty characters, starting with a capital letter or a letter of a script with no case, such as Chinese. An ASCII colon is followed by white space and words, so `At 10:30 we met` names no one; the full-width colon `：` of Chinese and Japanese text is followed by words, with or without a space, so `张伟：你好` is `你好` said by `张伟`. It holds for a file only when at least four turns in five open with such a name and the names are at most twelve; otherwise no turn has a speaker and every text stays whole, so a caption that says `Note: the budget` keeps its words.

`transcriptFormatOf(name, head)` names a file's format from its name's extension and its first bytes (4 KB is enough) or its text, and the bytes must be what the name claims: a `.srt` holds a timing line, a `.vtt` opens with `WEBVTT`, a `.json` opens with `{` or `[` and holds a `"sentences"` or `"speaker_name"` key, a `.docx` opens as a ZIP archive, and a `.txt` or `.md` is `otter` when it is laid out as Otter's export and `lines` otherwise. It answers `null` for anything else: a PDF under any name, a ZIP archive under a text file's name, a text with a NUL character, a file with no extension. Bytes are read as `readTranscript` reads them, so a file saved as UTF-16 with its byte order mark is named too.

A text is laid out as Otter's export when, from its first header on, each line of words comes straight after a header, blank lines aside, and at least two headers have their line of words. The lines before the first header and the closing line are not weighed. So one line that looks like a header in other text, such as `Break  10:30` in an agenda, does not make the text Otter's, nor does a column of names and times with no words under them, and an export whose turns run to two lines or more reads as plain lines unless it is read with `otter`. The last line of a head is weighed only when a line feed ends it, since the first bytes of a file can stop inside a line.

A Word file's text comes from the extractor the caller passes, so the browser entry imports no package. A page passes mammoth's browser build, whose `extractRawText` reads `{ arrayBuffer }`. In Node, mammoth reads `{ buffer }`: pass `({ arrayBuffer }) => mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) })`. The extractor is handed a copy of the file's own bytes. The text it answers is read by Otter's headers when it is laid out as Otter's export, each header and its paragraph a paragraph of their own, with the format `docx`; any other text is read as plain lines by the `Name: words` rule. When the extractor throws, `readWordTranscript` throws `TranscriptReadError` with what it threw as `cause`, and when it answers no text, `TranscriptReadError` too.

`TranscriptReadError` has the `format` the input was read as, and its message opens with it: `vtt: the first line is not WEBVTT`. It is thrown for a WebVTT text whose first line is not `WEBVTT`, a Fireflies text that is not JSON, a Word file the extractor could not read or read into no text, and `readTranscript` called with `docx`, since a Word file is read from its bytes by `readWordTranscript`.

## An archive's plan

```typescript
import { planEntries, sha256Hex } from '@framers/agentos/cognition/library/browser';

const plan = await planEntries(
  [
    { path: 'Notes/Plan 0123456789abcdef0123456789abcdef.md', size: 2_048 },
    { path: 'Calls/standup.vtt', size: 9_000 },
    { path: 'Calls/voice.m4a', size: 8_000_000 },
    { path: 'Calls/weird.xyz', size: 10 },
    { path: 'Notes/Scan.pdf', size: 12_000_000 },
    { path: '../outside.md', size: 100 },
  ],
  {
    documentTypes: { '.md': 'text/markdown', '.pdf': 'application/pdf' },
    transcriptExtensions: ['.srt', '.vtt'],
    recordingExtensions: ['.m4a', '.mp3'],
    maxBytes: (kind) => (kind === 'recording' ? 500_000_000 : 10_000_000),
  },
);
// plan[0]: { path: 'Notes/Plan 0123…cdef.md', within: null, title: 'Plan', folder: 'Notes',
//            becomes: 'document', mediaType: 'text/markdown', reason: null }
// plan[1].becomes === 'transcript', plan[2].becomes === 'recording'
// plan[3], plan[4], plan[5]: becomes 'skipped' with the reasons 'type', 'size' and 'path'

await sha256Hex('a\n'); // '87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7'
```

`planEntries(entries, rules)` says what each entry of a ZIP archive or a folder becomes before anything is read or sent: a document of a type the caller reads, a transcript, a recording, or skipped with its reason. It holds no rule of its own about types or sizes, and reads no file: the caller passes its rules and the entries as it lists them, each `{ path, size }` with `/` between the parts of a path and the size in bytes. The rules are:

- `documentTypes`: a document's extension, in lower case with its dot, to its media type.
- `transcriptExtensions` and `recordingExtensions`: the extensions read as transcripts and as recordings.
- `maxBytes(kind)`: the most bytes an entry of the kind `document`, `transcript` or `recording` may hold.
- `archiveExtensions`: the extensions of an archive, `['.zip']` unless given.
- `openArchive(path)`: lists a nested archive's entries, which the plan places where the archive stood, each with the archive's path as `within`. Without it, a nested archive is skipped with the reason `nested`, and an archive inside a nested archive is always skipped so, so the plan opens one level. What `openArchive` throws rejects the plan.
- `maxEntries`: the most entries planned, skipped ones and a nested archive's entries included; the entries past it are skipped with the reason `count`.

Each entry of the plan is `{ path, within, title, folder, becomes, mediaType, reason }`, in the order of the entries. Its title is the file's name with its extension dropped, and its folder the parts of the path before the name, `null` at the top; both drop a Notion export's trailing 32-character id, so `Notes/Plan 0123456789abcdef0123456789abcdef.md` is `Plan` in `Notes`. `mediaType` is a document's type from `documentTypes`, `null` for anything else. The checks run in this order, and the first that fails gives the reason: the count (`count`), a path that leaves its archive or folder, absolute, with a backslash, a `..` part or an empty part (`path`), an archive the plan does not open (`nested`), an extension in none of the rules (`type`), and the size (`size`). A folder's own entry, a path that ends with `/` as a ZIP archive lists one, is left out.

Two copies of one text are planned alike, since the plan reads no file. `sha256Hex(input)` answers the SHA-256 of a text's UTF-8 bytes, or of bytes, in lower-case hexadecimal, by which a caller finds two copies of one text once it reads them. It uses the platform's `crypto.subtle` where there is one, and the library's own SHA-256 where there is none, as in a page outside a secure context, with the same digest.
