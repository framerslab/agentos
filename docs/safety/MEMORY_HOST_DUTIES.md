---
title: Your Duties as the Controller
description: What @framers/agentos does with per-user memory, what your product must do itself as the party that controls its users' data, how to set the options, and what the library does not do.
---

# Your Duties as the Controller

A soul gives an agent an identity. Per-user memory gives it a record of what each person said. The library files, recalls, compiles, exports and deletes that record. It does not decide why your product keeps it, who may see it, or how long. Those are the duties of the party that runs the product, which privacy law calls the controller. This page says which part is the library's and which part is yours.

This page describes the library's behaviour. It is not legal advice. Whether a law applies to your product, and what it asks of you, is a question for your counsel.

**Who this page is for.** A product that runs an agent for other people: a chat product, a tutor, a support agent, a coach. A person who runs a soul on their own machine, for themselves alone, is in a different position; if your product is what such a person runs, this page is for you.

## What memory stores, and where

| What | Where it lives |
|---|---|
| Conversation traces: each message a person sent and each reply, with who spoke and when; on `runtime: 'gmi'` with cognitive memory on, each with an emotional state too, which is neutral unless you set `emotionalStamp: 'mood'` | Rows of the memory store, filed under the person's own scope |
| Per-user pages: notes compiled from one person's traces, and the chunks recall searches | Rows of the memory store, under the same scope |
| The scope registry: one row per person or session, with the time of its last compile | The memory store |
| Tombstones: one hash per forgotten person or session, never an id or any text | The memory store, and a second copy outside it |
| Deleted traces: one row per trace a correction or a single deletion deleted, holding the trace's random id and no text | The memory store, and the second copy |
| Kept corrections: the text of each live correction, with the person's key, its trace's id and its time | The second copy alone |
| Operator pages: pages you write by hand, shared by every user | Markdown files under the soul's `memory/` folder |

With `souledAgent()` the memory store is a SQLite file, `memory/.store/memory.sqlite`, and the tombstone copy is a second file beside it, `memory/.store/forgotten.sqlite`. The folder gets a `.gitignore` holding `*` when it has none, so git leaves both files out of a commit. A `.gitignore` already there is left as it is, and git goes on tracking a file it tracked before the `.gitignore` existed ([git's own docs](https://git-scm.com/docs/gitignore)). If you keep the soul folder in git, run `git ls-files memory/.store` and remove each file it lists from the index with `git rm --cached`. With `soulStore: { adapter }` the memory store is your own database instead, SQLite or PostgreSQL, and the tombstone copy is the file or adapter `tombstoneCopy` names, which is then required. A host that wires the wiki onto its own storage adapter (`Memory.createWithAdapter`, `Memory.createPostgres`) gets the same tables in its own database.

The forgotten-user ledger is database-wide, including older learning-layer tombstones. Give each agent its own database, or its own PostgreSQL schema, and a separate tombstone copy outside restores. Different brain ids do not isolate tombstones: forgetting a user in a shared ledger applies to every brain that reads it. The open refuses a copy that is the store's own database with `COPY_UNAVAILABLE`: the same adapter, the same native SQLite file, or on PostgreSQL the same database and schema through a second pool. It cannot tell two handles of another kind on one file apart (sql.js among them), so give the copy a file of its own. Past those checks the library cannot tell whether the copy is truly independent of the store, on another disk or server and out of what a restore of the store replaces: that is yours to arrange.

A souled agent on your database (`soulStore`) refuses to open on a database that already holds another agent's memory, before it writes anything there, so the agent whose database it is opens as before. Two agents opened at the same moment on an empty database are caught once each has made its tables: at least one is refused, and takes back the rows its open made. Give it a database or PostgreSQL schema of its own, apart from your product's tables, and an adapter object of its own: on PostgreSQL the agent runs its own transactions on that adapter one after another, and a transaction your code runs on the same adapter object is outside that order. `close()` and every refusal leave the adapter open: closing it is yours. A store file still at `memory/.store/memory.sqlite` refuses the open, since the people it holds would be out of reach of every call on the new store: move that memory into your database, or delete it, first. The agent counts the people and sessions it holds memory of in its own process, and several processes can serve one database, so with `soulStore` it requires `retention` and `tombstoneKey` at the open, with or without `sharedMemory`.

## What leaves your process

Memory makes these calls out of your process, and no others:

| Call | When | What leaves | To whom |
|---|---|---|---|
| The compile | On `close()` and on `agent.memory.compileWiki()`, once per page of each person with new traces | The page's current text and that one person's new traces | The agent's own provider and model, or the one you name with `compile`; nobody, with `compile: false` |
| Embedding | Only when you give the store an embedder: each trace when it is stored, each query at recall | The trace's text; the query's text | The embedding provider you configured |
| Embedding, on `runtime: 'gmi'` with cognitive memory on | Each side of a session turn when it is stored; each turn's text, as the query of its recall; a stored trace a recall reads while the process holds no vector of it; one fixed test text when the first session turn builds the memory | The text of each side as `screen` kept it; the turn's text; the stored trace's text | The provider `memory.embedding.provider` names, and no other |
| The end user's id | With each model request of a `gmi()` session opened with a `userId`, in the end-user field and as the name of the user's messages; on a souled agent, only with `sendUserIdToProvider: true` | The id you passed | The model provider |

Memory text goes to the agent's provider or to the compile provider you named, and to no other recipient. With cognitive memory off, which is the default, a souled agent sends nothing to an embedding provider. With it on, on `runtime: 'gmi'`, the agent does not open until `memory.embedding.provider` names the provider: none is picked from a default provider or from a key in your environment, so a person's words are embedded only where you named, and the open itself sends nothing.

`await agent.recipients()` lists every outside recipient of a person's text from a souled agent: the agent's provider and model, a model router's pick when you set `router` (one entry, `picked by the model router at each call`, and each provider and model the router has picked, recorded when it picks; on `runtime: 'gmi'`, recorded as each call is sent, where the call's own credentials take it), each `fallbackProviders` hop (one entry, `the automatic fallback chain`, when you set none), the compile's target (none with `compile: false`), `compile.minors`, the embedding provider and model of cognitive memory on `runtime: 'gmi'`, as the memory resolves them (the provider and model it was built with are recorded when it is built, so a default provider changed after the agent opened is named, and one changed after the build is not), and every route a call took that the options do not name: a `generate()` or `stream()` with its own `provider`, `model`, router or `fallbackProviders`. Each entry names where the text goes, not only what the options say: a model whose `provider:` prefix names another provider goes to that provider (`{ provider: 'anthropic', model: 'openrouter:anthropic/claude-sonnet-4.5' }` is OpenRouter), and an Anthropic route with no Anthropic key or base URL of its own while `OPENROUTER_API_KEY` is set goes to OpenRouter. The store records each route the options do not name, a route the credential layer sent elsewhere included, as one row (`recipient:<role>:<provider>:<model>` in `brain_meta`, holding no person, no text and no time of use), so the list still names it after a restart or a change of keys. A provider the options leave to the environment reads `from the environment at each call`. An entry names a provider, not an endpoint: a `baseUrl` you set on the agent, a hop or a call sends that provider's text to the server at that address, which you name in your notice yourself. The list is agent-wide: it names where the agent sends text, the same for every person, not which person's text went where. `exportUserMemory` carries it. The library sends these recipients nothing: telling them of a deletion or a correction is yours.

## What the library does for you

Each of these is on by default.

### Per-user scope

Every conversation trace and every compiled page is filed under two ids: the soul's `agentId` and the user id you pass with `agent.session(id, { userId })`. Recall reads the asker's own scope and the operator's shared pages, and nothing else. One person's words do not reach another person's prompt through memory.

- A session opened with no user id gets a scope of its own, keyed by the session id. It is never a shared scope. An id that names no one (blank, `anonymous`, `anonymous_user`, `system`, `guest`) is treated as no id.
- Both the person's messages and the assistant's replies are filed under the person's scope. A reply restates what the person said, so it goes with them.
- Scopes are compared by equality only. A user id that is the start of another, or that holds a separator character, cannot collide with another user's.
- The soul's `agentId` is the agent's one stable id. A store with no stable agent id refuses per-user memory with an error.
- Memory shared across sessions exists only as an option you turn on by name (`sharedMemory`), for one person's own machine or an operator's own notes.

### Two layers of pages

Operator pages are the pages you write under `memory/`. They are shared by every user, read-only to the runtime, and listed in the catalog that joins the system prompt. The runtime never compiles conversation into them.

Per-user pages are compiled from one person's traces alone and stored as rows of the memory store. They are never listed in the shared catalog. The agent reaches them through recall and through the page tool, under the asker's own id. No compiled page is shared between people, so no page has to be split when one of them leaves.

### The asker check

`read_memory_page` reads the user of the session it runs in. It returns the asker's own pages and the operator's pages. For another person's page it answers exactly as it does for a page that does not exist. A call that tries to name a scope or a user of its own is rejected. Each refusal writes one log line with no text.

### One deletion call, and its report

`await agent.forgetUser(userId, { linkedSessions })` deletes one person from a store. In order:

1. It waits for the person's writes and compiles still running, up to the agent's `pendingWritesTimeoutMs`.
2. It records a tombstone for the person, in the copy first and then in the store, and deletes the corrections the copy keeps of them in the copy's same write. From then on a write for them is refused, and a write that lands late is taken back.
3. It deletes for good the person's traces (soft-deleted rows included), their graph copies and full-text entries, the document chunks filed from those traces, their page chunks, their pages (each whole) and their registry row; it also deletes every trace elsewhere that names them, and each page of another person compiled from such a trace, whole. The next compile builds that page again from the other person's own traces. While such a page is left, the trace it was built from stays, so the next try finds the page. One case is left to you: a trace your own code filed in another person's conversation that names this person, read by a compile of that conversation that was running when the deletion came. The deletion deletes the page that compile writes once the trace is gone; when that one delete fails, the report lists the page and says `complete: false`, and a later try no longer finds the page by the trace and says `complete: true`. Delete that page yourself: `Memory.listScopes({ scope: 'conversation' })` and `Memory.listPageRows(scopeId)` find the conversation that holds the page id the report names, and `Memory.deletePageRows(scopeId, pageId)` deletes it. Then it rebuilds the full-text index where a delete's own rebuild failed, so no deleted word stays in it, and rewrites the vector index, so no deleted vector stays in its files.
4. It empties the sessions the handle holds open for the person: their messages, and on `runtime: 'gmi'` the history, the reasoning trace, the sentiment trend, the working-memory slots and the metaprompt imprints of each session's GMI, waiting up to `pendingWritesTimeoutMs` for a turn still running on one.
5. It returns a report: each store with what was deleted there, or why it was not reached; each page it could not delete; how many writes it waited for and how many were still running at the deadline; `complete`; the time it ended, the agent's id and the library's version; the deletion's four parts; and who receives a person's text.

Read the report. `complete: false` means the deletion is not finished: a write was still running at the deadline, or one of its four parts was missed. `parts` lists them in the order they run, each reached with a count or missed with its reason: the tombstone; the copies the agent's mind holds of the person (reached with 0 on an agent whose mind holds none); the store's own pass, missed when a store or a page failed or the store holds older memory nobody has attributed (see "Memory from before per-user scope"); and the sessions the handle holds open for the person, each emptied and counted. On the default runtime a session's history is cleared. On `runtime: 'gmi'` a session's messages go at once, and once no turn of the session runs its GMI drops its conversation history with what it recorded about those turns, its reasoning trace, its sentiment trend and the last sentiment it read, the working-memory slots of its cognitive memory and the memory imprints its metaprompts wrote to working memory, and a metaprompt still running applies none of its results; its mood and the skill level a metaprompt set for the session's user stay until the session closes. The deletion waits for a running turn up to `pendingWritesTimeoutMs`. A session still running a turn at that deadline leaves the part missed, with the number of such sessions as its reason; the turn's messages are not kept, its writes to the soul's memory store are refused, and the session is emptied when the turn ends. A session opened with `history: false` keeps nothing between its turns and is not counted. Called from a hook or a tool of a turn of the person's, `forgetUser` does not wait for that turn, which ends only once the call returns: the sessions part is missed, and the session is emptied when the turn ends. An incomplete deletion of a person, or of a linked session, writes one `memory.forget_incomplete` warn line through your logger, with each part as `reached` or `missed`, the writes still running and the pages left, and no id or text; alert on it. `agent.forgetUser()` made again resumes it and returns a new report. The next open and `agent.applyTombstones()` resume a store part left, since they find the person by what the store still holds; a missed sessions part is finished by `agent.forgetUser()` made again once the turn has ended.

The report is the receipt you keep. It holds when the deletion ended (`completedAt`), `agentId`, `libraryVersion`, the four `parts`, `complete` and `recipients`, the list `agent.recipients()` returns, read once the deletion has waited for the person's writes and compiles. The library puts no id of the person, no hash of it and none of their text in it: a hash of an id can be matched by hashing a guess. Two values come from elsewhere: a `reason` is the failing store's own error message, as the store wrote it, and `pages.failed` names each page left by its id, which a compile builds from what the page is about. Read both before you keep a report where the person's name must not reach. Keep the report beside your own record of the request, which is what links it to the person, and check `complete` before you answer the request.

`agent.forgetUser` is the call for a deletion. On a souled agent that runs a learning layer, `agent.learning.forgetUser(userId)` runs the same deletion, the soul's memory store included, and returns the same report with the layer's `userId`, `namespace` and `plainFormLeft` beside its fields, and the layer's own `learning store` entry with its count of each table. Once the agent is closed, both calls reject and delete nothing: open the agent again to delete. That report names the user: keep `agent.forgetUser`'s as the receipt.

Deletion never uses `Memory.forget()`, which is a soft delete that keeps the text. The library never asks a model to take one person out of a page: a page is deleted whole.

Every SQLite memory store the library opens from a file path, and the tombstone copy, are opened with `secure_delete` on, so a deleted row is overwritten in the file once the deletion checkpoints the write-ahead log. The deletion report names a log it could not empty. There is no option to turn it off. On PostgreSQL a deleted row stays in the table file until `VACUUM` removes it; the schedule is yours. A souled agent turns `secure_delete` on for a SQLite adapter you pass as `soulStore`; any other store on an adapter you pass is opened by you: set the pragma yourself. The same holds for a learning store you pass as `learning.store`: the deletion deletes its rows, and without the pragma their bytes stay in that file. Encryption at rest of a database you run, the memory store on your adapter included, is yours as well. A tombstone copy on an adapter you pass (`tombstoneCopy: { adapter }`) keeps the text of each live correction: a deletion empties the memory store's log and not the copy's, so on SQLite in WAL mode run `PRAGMA wal_checkpoint(TRUNCATE)` on the copy after a deletion, and run it again while it answers busy (its first column is 1).

### Tombstones that survive a restore

A tombstone outlives the deletion. It is a hash of the person's id, with no text, no email and no name. With `tombstoneKey`, a secret from your own secret store, it is a keyed hash (HMAC-SHA-256); without a key it is a plain SHA-256 hash, which can be matched by hashing a guessed id. The ledger holds these hashes, a keyed or an unkeyed one for each person forgotten, and the time of each; a marker row for each key that wrote one, which holds no key; a row for each trace a correction or a single deletion deleted, which holds that trace's random id (`t1:` and the id) and the time; and the ledger's identity and state mark. It holds no person's id and no text.

The second copy holds one table the store does not: `memory_corrections`, the text of each live correction with the key of the person it is filed under, its trace's id and the time it was stored. A row stays until the correction is deleted or corrected again, the person is deleted (in the tombstone's own write to the copy), or the trace expires under `retention`; an open deletes a row whose person is forgotten, whose trace was deleted or whose period has ended. No row is written for a person the copy holds a tombstone of: a correction that reaches the copy after its person's deletion rejects and leaves none of their words there. The table is never copied into the store. So the copy holds people's words: a host that keeps the copy on its own adapter (`tombstoneCopy: { adapter }`) keeps the text of every live correction in its own database. Name the copy beside the memory store in your records of where personal data lives, give it the same access control and encryption at rest, and keep it out of what a restore of the store replaces. `exportUserMemory` names a person's kept corrections in `held.restoreCopies`, with the words of each one the store holds no trace of.

A store that holds, or would hold, the memory of more than one person or session needs the key. With no `tombstoneKey`, a souled agent whose ledger holds no tombstone refuses to open a store that already holds two people's or sessions' memory, and refuses the session that would be the second (`souledAgent: this store would hold memory of more than one person or session; set tombstoneKey ...`), so its first deletion writes a keyed tombstone. A ledger that already holds unkeyed tombstones, from a deletion made before the key was set, lets the second person in, and an agent writes one `memory.tombstones_unkeyed` log line an open, at the second person or session, until you set the key. Setting the key later keeps every earlier tombstone in force: a person forgotten under no key stays forgotten, and so does a person forgotten under a key you have since rotated, as long as you pass the previous keys. One stable `userId`, or `sharedMemory`, is one person and needs no key. `agent.learning.forgetUser` and `agent.forgetUser` write one ledger. On a souled agent `agent.learning.forgetUser` deletes the learner's rows and leaves the person's memory in the store until the next open or `agent.applyTombstones()`, and its report does not name the store: answer a deletion request with `agent.forgetUser`, which runs the layer's own deletion first.

The tombstones are kept twice: in the memory store, and in a copy outside it. Every open copies the copy back into the store and deletes again whatever the store holds of a forgotten person, before the agent serves anyone. So a store restored from a backup taken before a deletion does not bring the person back. The same open, and `agent.applyTombstones()`, then delete again each trace a correction or a single deletion deleted that the store holds again, with each page built from it, which the next compile builds again; and they file again each kept correction the store lacks, under its own id and time, tagged `correction`; a filing that lands after its person was deleted is taken back. So a store restored from a backup taken before a correction brings back neither the old text nor loses the correction. One `memory.tombstone_reapplied` line counts what was deleted again (`traces`), what could not be (`tracesMissed`), what was filed again (`correctionsRefiled`) and what could not be (`correctionsMissed`, when a write or an embedding of the store fails); each missed one is tried again at the next open, and the open goes on, so a trace counted in `tracesMissed` can still be recalled until then: alert on either missed count. A store whose copy is missing or unreadable does not open, and neither does a store whose tombstones are keyed when the key is not given: without the record of who was forgotten, no memory is served.

Each store's tombstones carry a random identity, made once. An open compares the identity of the store with the identity of its copy and refuses a copy that belongs to another store (`LEDGER_IDENTITY_MISMATCH`). A store put back from an older backup takes its state from its copy; a copy put back from an older backup is repaired from its store.

### Retention

`retention` sets how long traces are kept from the time they were stored, with a period of its own for anonymous sessions if you want one. A sweep deletes expired traces for good on `close()` and on `agent.sweepRetention()`, with the text the tombstone copy keeps of an expired correction. Each person and session is swept on its own: one whose page cannot be deleted keeps its expired traces until a later sweep, the others are swept, and the call rejects with the first error once every one was tried. When a trace expires, a page compiled from it is deleted whole, or rebuilt from the traces that survive when you set `pages: 'rebuild'`. A store that holds, or would hold, more than one person or session refuses to open a session until you choose: a period, or `'until-deletion'`. Operator pages are never swept.

The memory hooks fire once per turn, so one turn is filed once.

### Export and correction

`await agent.exportUserMemory(userId)` returns one person's traces and pages as JSON, each page with its sources and dates. It reads the person's own scope alone. Beside them it holds what the person provided (`provided.messages`, their own messages and none of the agent's replies), what is held about them (`held`: each trace with its speaker, entities, filing side, emotional context, strength, stability, recall count and last recall; the memory graph's links between two of their own traces; their pages; their learned state when the agent runs a learning layer), who receives a person's text (`recipients`), the retention period (`retention`), whether their messages are scored for sentiment and how many traces carry a mood (`profiling`), and each store it could not read (`unread`, with the kind of error and never its text). `await agent.correctUserMemory(userId, { traceIds, text })` deletes the wrong traces for good, files the corrected statement, and has the next compile rebuild the pages from what is left, so a later compile cannot bring the wrong statement back. With no `text` it deletes the named traces and files nothing, which is how one memory is deleted with no replacement. Before it deletes anything, the call keeps the corrected statement's text in the tombstone copy and records each trace it deletes in both copies of the ledger, so a restore of the store from before the call is corrected again at the next open. A write to the copy that fails rejects the call before any named trace is recorded or deleted; the pages built from them may be deleted by then, and the next compile builds them again. A call that failed partway is finished by the same call made again, and by the next open or `agent.applyTombstones()`. It refuses, and changes nothing, when any trace named is not that person's. Its result names who received a person's text (`recipients`, the list `agent.recipients()` returns), and the call sends them nothing. A session turn of the person that was running when the call changed their memory does not file its reply, which can repeat what the turn recalled before; an open session still holds what it already said in its own message history, which the call does not edit.

### Recalled text as data

Remembered text enters the prompt as data: a user-role block of JSON, marked, labelled as conversation data and not instructions, placed after the cacheable prefix. The compile receives its records the same way. This makes it harder for text a person wrote, or text injected into it, to act as an instruction. It does not prevent that. Do not describe it to anyone as a guarantee.

### Hard limits last

The soul's `hardLimits` close the assembled system prompt, after your own `systemBlocks` too. A call with `planning` on adds its plan as a system message after the limits. A configured soul that fails to load throws; `soul: { path, optional: true }` is the option for an agent that may run without one. Hard limits are prompt text the model reads, not a check that enforces them.

### A policy per account, and a screen

`memoryPolicy` answers, for the account a turn serves: no long-term memory, raw traces with no compiled pages, or full memory, each with an optional shorter retention, and two marks: a child's account (`minor: true`) and a person who objects to profiling (`profiling: 'off'`). A session follows a later answer for the same account, given to the same agent object, from its next turn. `screen` sees each text before it is filed, embedded or compiled, and returns the text to use or `null` to drop it; `redactPii()` from `@framers/agentos-ext-pii-redaction` fits it. Both fail closed: when your function throws, times out or returns something else, the memory operation is refused and the turn goes on.

### One line per refusal

Each refusal and fallback writes one line through your logger, with no message text and no id: a refused page read, a refused or taken-back write, a skipped compile, a finished deletion, a sweep, tombstones re-applied.

## What you must do yourself

The library gives you the calls. The duties below are the controller's.

### Say why you keep memory, and write it in your privacy notice

Processing a person's conversation needs a lawful reason, and your notice must tell people what you do. For memory it names at least: the purposes; the recipients (the model provider the compile calls, and the embedding provider if you use one; `agent.recipients()` lists your agent's); any transfer to another country and what it rests on; the retention period you chose; that compiled pages are a profile of the person, and how to object where that right applies; that you keep a record of deletions so a deleted person is not filed again, and what that record holds; and what happens to backups after a deletion.

### Hold a contract with each provider memory reaches

Each provider in the table above processes personal data on your behalf. Hold the contract your law requires with each, and a transfer mechanism for a provider in another country. Set `compile` when the compile should run on another provider or a local model, or not at all. Your notice can only name calls you know about: the table above is the whole list.

### Assess the risk first

A companion, a tutor for young people or a health coach that remembers what people tell it is the kind of product to assess before memory is turned on. Where your law requires a written impact assessment for such processing, do it first.

### Have a breach procedure

Recalled text reaching a person it does not belong to is a disclosure of personal data. Know before it happens whom you must tell, and by when. If you ran an earlier release of `souledAgent()` with more than one person on one agent, that release recalled from one shared scope: assess whether one person's words reached another.

### Answer people's requests

Verifying that the person asking is the person the data is about, and answering in time, is yours. The library gives one call per request.

| Request | What to call | What else is yours |
|---|---|---|
| A copy of their data | `agent.exportUserMemory(userId)` | Add what you hold outside memory. |
| Their data in a portable form | `agent.exportUserMemory(userId)` | The export is JSON. |
| A correction | `agent.correctUserMemory(userId, { traceIds, text })` | A page is written by a model and can state wrong things; check the person's export afterwards. Tell each recipient the result's `recipients` lists. |
| Deletion of single memories | `agent.correctUserMemory(userId, { traceIds })` | Find the traces in the person's export. Tell each recipient the result's `recipients` lists, and clear or close a session of the person that already repeated what was deleted. |
| Deletion | `agent.forgetUser(userId, { linkedSessions })`; check `complete` and keep its report | Delete what the report says it did not reach, tell each provider and recipient (the report's `recipients` lists them, as `agent.recipients()` does), keep the report beside your record of the request, and deal with backups. |

The deletion does not reach: a conversation history your product keeps outside memory, a session another agent object or another process holds open for the person, the learning store of an agent that runs no learning layer, the cognitive memory of a souled agent on the GMI runtime that runs no learning layer ([the two memories of that agent](../SOUL_ENTRY_POINTS.md#with-cognitive-memory-on-the-agent-keeps-two-memories)), memory under the organization scope, documents you ingested outside the person's scope, a memory provider of your own, your logs, your analytics and your backups. Delete those on your own path. A memory provider of your own is asked about the tombstone before each write, and a write that passed that check just before the deletion can land after it: delete the provider's rows of the person once `forgetUser` has returned and the turns that were running have ended. A write still running at the deletion's deadline makes the report say `pendingAtDeadline` above 0 and `complete: false`; such a write that fails after its row is stored stays until `forgetUser` runs again or the tombstones are applied again (`agent.applyTombstones()`, which each open runs).

Two questions the library cannot settle and your counsel should: how to answer a person who is not a user but is named inside a user's pages, whom the library cannot find by name; and whether rebuilding a page from the traces that survive (`pages: 'rebuild'`) is right for your product.

### Choose how long memory is kept

Keep personal data no longer than your purpose needs. Pick the period from the purpose, set `retention`, write the period in your notice and keep to it. `'until-deletion'` is a choice you make by name, never a default for a shared store.

### Backups and restores

The library keeps no backups. Yours hold every deleted person's words until they are replaced.

- Treat backup data as beyond use: held only until the schedule replaces it, and read for no other purpose.
- When you restore, restore the memory store (`memory.sqlite`, or your database) and never the tombstone copy from an older backup. Keep the copy outside what a restore replaces; `tombstoneCopy` moves it. The copy holds the deleted traces' ids and the text of each live correction, so a store put back from before a correction or a single deletion is corrected again at its next open.
- The library cannot tell when the store and the copy were both put back to an older state, or when two running stores use byte copies of one copy: both look valid. Keep the copy outside everything a restore replaces. On PostgreSQL a point-in-time restore replaces the whole cluster, so a copy in another database of the same cluster is inside it. Where the copy lives does not by itself make it durable.
- A `gmi()` agent's cognitive memory (`memory.store`) and a learning store are stores of their own. An open applies the tombstones by what the soul's memory store holds: once that store holds nothing more of a person, the person's cognitive memory that a restore of those stores puts back is not deleted again. Restore them only from a backup taken after the last deletion, or call `agent.forgetUser(userId)` again for each person deleted since the backup was taken.
- Put `await agent.applyTombstones()` in your restore runbook. An open through `souledAgent()` runs it for you; a restore that bypasses the library's open does not get that for free.
- Keep the tombstone key in your secret store, with the previous keys after a rotation. A keyed store does not open without them.
- A host that holds the health data of people in Washington state should check with counsel its reading of that state's rule for deletions delayed by backups; the common reading is that such a delay may not run past six months, which means rotating or scrubbing those backups within six months.

### Pass an opaque user id on every session

Pass `{ userId }` to every `session()` your product opens: one id per person, unique across all your tenants, not per tenant. Make it opaque: a random or hashed id, never an email address or a phone number. The id is the memory scope and the tombstone's input. A souled agent sends it to no model provider unless you set `sendUserIdToProvider: true`; a `gmi()` agent sends it as the end user's id with each request, and so does a souled agent that opts in, so the provider receives exactly what you pass.

### Anonymous sessions are people too

A session with no user id is a subject of its own. A product that opens one anonymous session per visitor holds many people's memory: it must choose a retention period, and when a person asks for deletion it must know which sessions were theirs and pass them as `linkedSessions`.

A `generate()` or `stream()` call on the agent that names no user is not a session. It files nothing into long-term memory and recalls operator pages only, so an agent used through such calls alone holds nobody's memory and needs no retention choice. With `sharedMemory`, such a call files and recalls as that one user.

### A group conversation is one subject

One session is one user. If you put several people into one conversation, pass one id for the group. Its memory is the group's, and a deletion asked for by any one of them deletes the group's traces and pages whole. The library files no speaker inside a session.

### One process per store

Run one process per `souledAgent()` store on SQLite. Where several processes share one store on PostgreSQL, a process learns of another's tombstone at its next open or at `agent.applyTombstones()`: call it on a schedule. A correction or a deletion of named traces keeps out the reply of a turn running in the process that made the call, not in another: such a turn files its reply, which can restate what was deleted, so read the person's export after the call and delete what it filed.

On PostgreSQL each tombstone write and each `applyTombstones()` takes a lock on the ledger table for one short transaction on each side, so two processes cannot lose each other's tombstones or lower the state mark. Give each part of your program that opens transactions its own adapter object, or run their transactions one at a time. This holds for a copy on PostgreSQL, or in a SQLite file opened with the native driver (`better-sqlite3`). Where that driver is not installed, `openForgottenCopy()` opens the file with sql.js, which reads the file once when it opens and writes all of it back after each write: two processes that share such a copy drop each other's tombstones from it. Give them a copy on PostgreSQL, or install `better-sqlite3`.

### Children

The library does not know a person's age. If children may use your product, settle age assurance and any consent a parent must give before memory is on for them. Answer `minor: true` from `memoryPolicy` for such accounts, beside `longTerm` and an optional shorter retention. "Until deletion" is not a setting for a child's account, and the library holds to that: on a store that keeps the account's memory until deletion, or with no `retention`, a child's account keeps no long-term memory whatever the answer says, and its turns recall your operator pages alone. On a store with a period in days, its turns are kept for that period, and its pages are compiled only on the provider and model you name in `compile.minors`, and not at all without it; with no key for that provider the compile does not run, and no other provider takes its place. Name a provider whose terms cover a child's data, and say it in your notice. On `runtime: 'gmi'` a child's turns are not scored for sentiment; with cognitive memory on there, they are stored with a neutral emotional state whatever `emotionalStamp` says, and what they recall keeps its emotional context with reconsolidation on.

### A person who objects to profiling

Compiled pages are a profile of the person. Where a person objects to profiling and that right applies, answer `profiling: 'off'` for their account, and `longTerm: 'raw'` or `'off'` so that no page is compiled for them. On the default runtime, and on `runtime: 'gmi'` with cognitive memory off, the store keeps no mood or emotional context of anyone. On `runtime: 'gmi'` with sentiment tracking on (`cognition: 'full'`), their turns are not scored for sentiment, so no trend of theirs is kept. With cognitive memory on there, their turns are stored with a neutral emotional state under `emotionalStamp: 'mood'` too, and with reconsolidation on, what their turns recall keeps its emotional context. The answer holds from the session's next turn: a trace stored with a mood before it keeps that mood. `agent.exportUserMemory(userId)` gives each trace's emotional context, and `agent.correctUserMemory(userId, { traceIds })` deletes the traces you name.

### Mood and sentiment

On `runtime: 'gmi'` the agent's GMI holds a mood of its own. With sentiment tracking on (`cognition: 'full'`, or `sentiment: true` in a `cognition` config), it also scores each message a person sends from the message's words and keeps the session's trend of those scores, and its metaprompts can change its mood in answer. Sentiment tracking is off unless you turn it on. Treat turning it on as profiling of the people the agent talks to: say so in your notice, and answer `profiling: 'off'` for a person who objects.

A mood, a sentiment score and a sentiment event exist to set the tone of a reply. Never make one of them the sole basis of a decision about a person that has legal effects for them or affects them in a similarly significant way. Article 22 of the GDPR gives a person the right not to be subject to a decision based solely on automated processing, profiling included, that has such effects. The regulations under California's CCPA set requirements for a business that uses automated decisionmaking technology to make a significant decision about a consumer, which they define as one that grants or denies financial or lending services, housing, education, employment or healthcare. Meeting those rules is yours: the library makes no decision about anyone.

By default the library keeps no history of how a person felt. A session's sentiment trend lives in that session's working memory, in process, and is never written to the memory store. A stored trace carries a neutral emotional state unless you set `emotionalStamp: 'mood'`, and then it carries the agent's mood, which under sentiment tracking can follow the mood of the conversation. If you keep a person's sentiment trend or mood history yourself (`emotionalStamp: 'mood'` with sentiment tracking on, a log of your own, or a GMI you build with a working memory that outlives the process), you hold a record of a person's emotional state over time, and such a record can be data about their health. Have a basis of your own for it before you keep it: under the GDPR, one of the conditions of Article 9(2); in California, treat it as sensitive personal information.

### A restriction that must hold at once

A session keeps the answer it was given until a later answer for the same account, given to any session or call of the same agent object, replaces it from its next turn. Another agent object, in the same process or another, reads your answer at its own sessions' next ask. Where a restriction must hold at once in every one of them (an objection, an age you learn), close that person's open sessions in each, or call `agent.forgetUser(userId)`, which deletes what is stored and keeps it deleted. A compile already running reads your latest answer before each of its model calls.

### Health data

A fitness coach, a sleep tracker or a companion people confide in holds health data, whether or not that was the plan. A compiled page that infers a condition is health data even when the words that fed it were not. Settle consent before memory is on, treat pages as health data in your notice and your retention, and use `memoryPolicy` (raw traces only) and `screen` (redaction) where they fit. Whether a health privacy law covers your product is a question for your counsel.

### Tell people they are talking to an AI

Give that notice in your product, at the first interaction. A hard limit in the soul such as "Say you are an AI whenever asked" backs the notice and does not replace it.

### Memory from before per-user scope

A store that an earlier release of `souledAgent()` wrote holds traces under the agent's one shared scope and compiled pages under `memory/`. A trace soft-deleted there (`memory.forget(id)`) still holds its words and counts as one of them. The library leaves them in place. It keeps them out of every user's prompt, recall and page reads, and every deletion report names them as not reached, with `complete: false`, until you deal with them. The data is yours, so the choice is yours:

- Delete them, before real users share the agent. The traces sit under the agent's id and, for an id that holds `/`, `%` or `:`, under its encoded form too (`encodePlainScopeId('persona', agentId)`). For each form, list the scope's traces, soft-deleted ones included, with `agent.memory.tracesStoredBefore('persona', scopeId, Number.MAX_SAFE_INTEGER)`, delete them with `agent.memory.deleteTraces(ids, { documentChunks: 'delete' })` so the text of the document chunks they were filed from goes with them, then call `agent.memory.deleteScope('persona', scopeId)`. Then `await agent.memory.finishErasure()` writes the vector index again from what is left and empties the write-ahead log. Then remove the compiled page files (those whose front matter lists `sources`); the next open refreshes the catalog.
- Or, on a single person's own machine, attribute them to that person: `legacyMemory: { attributeTo, reason: 'one-persons-machine' }`. The person then recalls, reads and exports that memory, and a deletion for them removes it. This is a statement you make. The library refuses it when the store records another user, any anonymous session, another forgotten subject or another learner, and it cannot check more than that.

## The options

| Option or call | What it does | Default |
|---|---|---|
| `agentId` in the soul's front matter | The one stable id of the persona and of the memory scope. | Set it. Without it the slug of the soul's name is used. |
| `session(id, { userId })` | The user the session serves. | None: the session is its own subject. |
| `retention` | How long traces are kept; what happens to a page when a source expires. | Required once a second person or session shares the store, and always with `soulStore`. |
| `memoryPolicy` | Per account: no long-term memory, raw traces only, or full memory; a shorter retention; a child's account (`minor: true`); an objection to profiling (`profiling: 'off'`). | Full memory under `retention`. |
| `screen` | Screens or redacts text before it is filed, embedded or compiled. | None. |
| `compile` | The provider and model the compile runs on, or `false` for no compile; `minors`, the provider and model a child's pages are compiled on. | The agent's own provider and model; no page for a child. |
| `tombstoneKey` | A secret; tombstones become keyed hashes. | Plain hashes. Required once a second person or session shares the store, unless the ledger already holds plain hashes; always required with `soulStore`. |
| `tombstoneCopy` | Where the second copy of the tombstones lives. | `memory/.store/forgotten.sqlite`; required with `soulStore` |
| `soulStore` | Keeps the memory store in your own database, on a storage adapter you pass and close. | `memory/.store/memory.sqlite` |
| `sharedMemory` | One user for every session that names none: one person's own machine, or an operator's notes. | Off. |
| `sendUserIdToProvider` | Sends the session's `userId` to the model provider as the end user's id, on `runtime: 'gmi'`. Pass an opaque or hashed id when you set it. | Off: no provider receives the id. |
| `emotionalStamp` | The emotional state each turn is stored with on `runtime: 'gmi'` with cognitive memory on: `'neutral'`, or `'mood'` for the agent's own mood. A child's account and a person who objects to profiling are stored neutral either way. | `'neutral'`. |
| `memory.embedding.provider` | The provider that embeds what people say, on `runtime: 'gmi'` with cognitive memory on. | None: with cognitive memory on, the agent does not open without it. |
| `legacyMemory` | Attributes memory from before per-user scope to one user, on one person's own machine. | Off. |
| `soul: { path, optional: true }` | Lets an agent start when its soul fails to load. | Off: a failed load throws. |
| `agent.forgetUser`, `agent.applyTombstones`, `agent.sweepRetention`, `agent.exportUserMemory`, `agent.correctUserMemory`, `agent.recipients` | The calls your request handling, your schedule and your restore runbook use. | Present on a souled agent with a workspace folder. |

A host that wires `attachMemoryWiki()` itself calls `forgetUserMemory()`, `reapplyTombstones()`, `sweepRetention()`, `exportSubjectMemory()` and `correctSubjectMemory()` with a `ForgottenLedger` of its own, and wraps a memory provider of its own with `guardMemoryProvider()`.

## What the library does not do

- It does not know who a person is, how old they are, or where they live. It takes the id you pass.
- It does not verify that the person asking for an export or a deletion is the person the data is about.
- It does not choose your reason for keeping memory, write your notice, sign a contract with a provider, or decide whether a law applies to you.
- It does not back up or restore a store, and it does not delete your conversation history, your logs or your backups.
- It does not prevent prompt injection through remembered text. It frames that text as data, which reduces the risk.
- It does not enforce hard limits. They are prompt text the model reads last.
- It does not tell your users they are talking to an AI. Your product does.
- It does not split a page between people. Each compiled page is one person's, and it is deleted whole.

## Reference

- [Soul Files](../SOUL_FILES.md): the workspace, the `memory/` wiki, [what applies on each path](../SOUL_FILES.md#what-applies-on-each-path)
- [Which Call to Use](../SOUL_ENTRY_POINTS.md): `souledAgent()`, `gmi({ soul })` and `agent({ soul })` side by side, and which call reaches which memory
- [GMI](../GMI.md): sessions, the user id, the learning layer's `forgetUser`
- [High-Level API](../getting-started/HIGH_LEVEL_API.md): `souledAgent()`, its options and its handle
- [SQLite Brain Storage](../memory/MEMORY_STORAGE.md): the tables, the forgotten-user ledger, `secure_delete`
- [Memory Operations](../MEMORY_OPERATIONS.md): one person's export and correction
- [PII Redaction](./PII_REDACTION.md)
