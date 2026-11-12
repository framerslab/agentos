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
| Conversation traces: each message a person sent and each reply, with who spoke and when | Rows of the memory store, filed under the person's own scope |
| Per-user pages: notes compiled from one person's traces, and the chunks recall searches | Rows of the memory store, under the same scope |
| The scope registry: one row per person or session, with the time of its last compile | The memory store |
| Tombstones: one hash per forgotten person or session, never an id or any text | The memory store, and a second copy outside it |
| Operator pages: pages you write by hand, shared by every user | Markdown files under the soul's `memory/` folder |

With `souledAgent()` the memory store is a SQLite file, `memory/.store/memory.sqlite`, and the tombstone copy is a second file beside it, `memory/.store/forgotten.sqlite`. A `.gitignore` in that folder keeps both out of version control, so a soul folder you keep in git never carries a person's conversation. A host that wires the wiki onto its own storage adapter (`Memory.createWithAdapter`, `Memory.createPostgres`) gets the same tables in its own database.

The forgotten-user ledger is database-wide, including older learning-layer tombstones. Give each agent its own database, or its own PostgreSQL schema, and a separate tombstone copy outside restores. Different brain ids do not isolate tombstones: forgetting a user in a shared ledger applies to every brain that reads it.

## What leaves your process

Memory makes these calls out of your process, and no others:

| Call | When | What leaves | To whom |
|---|---|---|---|
| The compile | On `close()` and on `agent.memory.compileWiki()`, once per page of each person with new traces | The page's current text and that one person's new traces | The agent's own provider and model, or the one you name with `compile`; nobody, with `compile: false` |
| Embedding | Only when you give the store an embedder: each trace when it is stored, each query at recall | The trace's text; the query's text | The embedding provider you configured |
| The end user's id | With each model request of a GMI session opened with a `userId` | The id you passed | The model provider |

Memory text goes to the agent's provider or to the compile provider you named, and to no other recipient.

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
2. It records a tombstone for the person, in the copy first and then in the store. From then on a write for them is refused, and a write that lands late is taken back.
3. It deletes for good the person's traces (soft-deleted rows included), their graph copies and full-text entries, the document chunks filed from those traces, their page chunks, their pages (each whole) and their registry row; it also deletes every trace elsewhere that names them. Then it rewrites the vector index, so no deleted vector stays in its files.
4. It returns a report: each store with what was deleted there, or why it was not reached; each page it could not delete; how many writes it waited for and how many were still running at the deadline; and `complete`.

Read the report. `complete: false` means the deletion is not finished: a write was still running, a store or a page failed, or the store holds older memory nobody has attributed (see "Memory from before per-user scope"). The next open, or `agent.applyTombstones()`, resumes it. The report holds no id and no text.

Deletion never uses `Memory.forget()`, which is a soft delete that keeps the text. The library never asks a model to take one person out of a page: a page is deleted whole.

Every SQLite memory store the library opens from a file path, and the tombstone copy, are opened with `secure_delete` on, so a deleted row is overwritten in the file once the deletion checkpoints the write-ahead log. The deletion report names a log it could not empty. There is no option to turn it off. On PostgreSQL a deleted row stays in the table file until `VACUUM` removes it; the schedule is yours. A store on an adapter you pass is opened by you: set the pragma yourself.

### Tombstones that survive a restore

A tombstone outlives the deletion. It is a hash of the person's id, with no text, no email and no name. With `tombstoneKey`, a secret from your own secret store, it is a keyed hash; without a key it is a plain hash, and a plain hash of a guessable id can be matched by hashing candidates, so supply the key. `agent.learning.forgetUser` and `agent.forgetUser` write one ledger.

The tombstones are kept twice: in the memory store, and in a copy outside it. Every open copies the copy back into the store and deletes again whatever the store holds of a forgotten person, before the agent serves anyone. So a store restored from a backup taken before a deletion does not bring the person back. A store whose copy is missing or unreadable does not open, and neither does a store whose tombstones are keyed when the key is not given: without the record of who was forgotten, no memory is served.

Each store's tombstones carry a random identity, made once. An open compares the identity of the store with the identity of its copy and refuses a copy that belongs to another store (`LEDGER_IDENTITY_MISMATCH`). A store put back from an older backup takes its state from its copy; a copy put back from an older backup is repaired from its store.

### Retention

`retention` sets how long traces are kept from the time they were stored, with a period of its own for anonymous sessions if you want one. A sweep deletes expired traces for good on `close()` and on `agent.sweepRetention()`. When a trace expires, a page compiled from it is deleted whole, or rebuilt from the traces that survive when you set `pages: 'rebuild'`. A store that holds, or would hold, more than one person or session refuses to open a session until you choose: a period, or `'until-deletion'`. Operator pages are never swept.

The memory hooks fire once per turn, so one turn is filed once.

### Export and correction

`await agent.exportUserMemory(userId)` returns one person's traces and pages as JSON, each page with its sources and dates. It reads the person's own scope alone. `await agent.correctUserMemory(userId, { traceIds, text })` deletes the wrong traces for good, files the corrected statement, and has the next compile rebuild the pages from what is left, so a later compile cannot bring the wrong statement back. A correction that failed partway is finished by the same call made again. It refuses, and changes nothing, when any trace named is not that person's.

### Recalled text as data

Remembered text enters the prompt as data: a user-role block of JSON, marked, labelled as conversation data and not instructions, placed after the cacheable prefix. The compile receives its records the same way. This makes it harder for text a person wrote, or text injected into it, to act as an instruction. It does not prevent that. Do not describe it to anyone as a guarantee.

### Hard limits last

The soul's `hardLimits` close the assembled system prompt, after your own `systemBlocks` too. A call with `planning` on adds its plan as a system message after the limits. A configured soul that fails to load throws; `soul: { path, optional: true }` is the option for an agent that may run without one. Hard limits are prompt text the model reads, not a check that enforces them.

### A policy per account, and a screen

`memoryPolicy` answers, for the account a turn serves: no long-term memory, raw traces with no compiled pages, or full memory, each with an optional shorter retention. `screen` sees each text before it is filed, embedded or compiled, and returns the text to use or `null` to drop it; `redactPii()` from `@framers/agentos-ext-pii-redaction` fits it. Both fail closed: when your function throws, times out or returns something else, the memory operation is refused and the turn goes on.

### One line per refusal

Each refusal and fallback writes one line through your logger, with no message text and no id: a refused page read, a refused or taken-back write, a skipped compile, a finished deletion, a sweep, tombstones re-applied.

## What you must do yourself

The library gives you the calls. The duties below are the controller's.

### Say why you keep memory, and write it in your privacy notice

Processing a person's conversation needs a lawful reason, and your notice must tell people what you do. For memory it names at least: the purposes; the recipients (the model provider the compile calls, and the embedding provider if you use one); any transfer to another country and what it rests on; the retention period you chose; that compiled pages are a profile of the person, and how to object where that right applies; that you keep a record of deletions so a deleted person is not filed again, and what that record holds; and what happens to backups after a deletion.

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
| A correction | `agent.correctUserMemory(userId, { traceIds, text })` | A page is written by a model and can state wrong things; check the person's export afterwards. |
| Deletion | `agent.forgetUser(userId, { linkedSessions })`; read its report | Delete what the report says it did not reach, tell each provider and recipient, and deal with backups. |

The deletion does not reach: a conversation history your product keeps outside memory, a `gmi()` session's own history, the learning store of an agent that runs no learning layer, memory under the organization scope, documents you ingested outside the person's scope, a memory provider of your own, your logs, your analytics and your backups. Delete those on your own path.

Two questions the library cannot settle and your counsel should: how to answer a person who is not a user but is named inside a user's pages, whom the library cannot find by name; and whether rebuilding a page from the traces that survive (`pages: 'rebuild'`) is right for your product.

### Choose how long memory is kept

Keep personal data no longer than your purpose needs. Pick the period from the purpose, set `retention`, write the period in your notice and keep to it. `'until-deletion'` is a choice you make by name, never a default for a shared store.

### Backups and restores

The library keeps no backups. Yours hold every deleted person's words until they are replaced.

- Treat backup data as beyond use: held only until the schedule replaces it, and read for no other purpose.
- When you restore, restore the memory store (`memory.sqlite`, or your database) and never the tombstone copy from an older backup. Keep the copy outside what a restore replaces; `tombstoneCopy` moves it.
- The library cannot tell when the store and the copy were both put back to an older state, or when two running stores use byte copies of one copy: both look valid. Keep the copy outside everything a restore replaces. On PostgreSQL a point-in-time restore replaces the whole cluster, so a copy in another database of the same cluster is inside it. Where the copy lives does not by itself make it durable.
- Put `await agent.applyTombstones()` in your restore runbook. An open through `souledAgent()` runs it for you; a restore that bypasses the library's open does not get that for free.
- Keep the tombstone key in your secret store, with the previous keys after a rotation. A keyed store does not open without them.
- A host that holds the health data of people in Washington state should check with counsel its reading of that state's rule for deletions delayed by backups; the common reading is that such a delay may not run past six months, which means rotating or scrubbing those backups within six months.

### Pass an opaque user id on every session

Pass `{ userId }` to every `session()` your product opens: one id per person, unique across all your tenants, not per tenant. Make it opaque: a random or hashed id, never an email address or a phone number. The id is the memory scope, the tombstone's input and the end user's id sent to the provider.

### Anonymous sessions are people too

A session with no user id is a subject of its own. A product that opens one anonymous session per visitor holds many people's memory: it must choose a retention period, and when a person asks for deletion it must know which sessions were theirs and pass them as `linkedSessions`.

A `generate()` or `stream()` call on the agent that names no user is not a session. It files nothing into long-term memory and recalls operator pages only, so an agent used through such calls alone holds nobody's memory and needs no retention choice. With `sharedMemory`, such a call files and recalls as that one user.

### A group conversation is one subject

One session is one user. If you put several people into one conversation, pass one id for the group. Its memory is the group's, and a deletion asked for by any one of them deletes the group's traces and pages whole. The library files no speaker inside a session.

### One process per store

Run one process per `souledAgent()` store on SQLite. Where several processes share one store on PostgreSQL, a process learns of another's tombstone at its next open or at `agent.applyTombstones()`: call it on a schedule.

On PostgreSQL each tombstone write and each `applyTombstones()` takes a lock on the ledger table for one short transaction on each side, so two processes cannot lose each other's tombstones or lower the state mark. Give each part of your program that opens transactions its own adapter object, or run their transactions one at a time.

### Children

The library does not know a person's age. If children may use your product, settle age assurance and any consent a parent must give before memory is on for them. Use `memoryPolicy` for such accounts: no long-term memory, raw traces only, or a short retention. "Until deletion" is not a setting for a child's account.

### Health data

A fitness coach, a sleep tracker or a companion people confide in holds health data, whether or not that was the plan. A compiled page that infers a condition is health data even when the words that fed it were not. Settle consent before memory is on, treat pages as health data in your notice and your retention, and use `memoryPolicy` (raw traces only) and `screen` (redaction) where they fit. Whether a health privacy law covers your product is a question for your counsel.

### Tell people they are talking to an AI

Give that notice in your product, at the first interaction. A hard limit in the soul such as "Say you are an AI whenever asked" backs the notice and does not replace it.

### Memory from before per-user scope

A store that an earlier release of `souledAgent()` wrote holds traces under the agent's one shared scope and compiled pages under `memory/`. The library leaves them in place. It keeps them out of every user's prompt, recall and page reads, and every deletion report names them as not reached, with `complete: false`, until you deal with them. The data is yours, so the choice is yours:

- Delete them, before real users share the agent: `await agent.memory.deleteScope('persona', '<agentId>')` deletes the old traces and chunks; then remove the compiled page files (those whose front matter lists `sources`); the next open refreshes the catalog.
- Or, on a single person's own machine, attribute them to that person: `legacyMemory: { attributeTo, reason: 'one-persons-machine' }`. The person then recalls, reads and exports that memory, and a deletion for them removes it. This is a statement you make. The library refuses it when the store records another user, any anonymous session, another forgotten subject or another learner, and it cannot check more than that.

## The options

| Option or call | What it does | Default |
|---|---|---|
| `agentId` in the soul's front matter | The one stable id of the persona and of the memory scope. | Set it. Without it the slug of the soul's name is used. |
| `session(id, { userId })` | The user the session serves. | None: the session is its own subject. |
| `retention` | How long traces are kept; what happens to a page when a source expires. | Required once a second person or session shares the store. |
| `memoryPolicy` | Per account: no long-term memory, raw traces only, or full memory; a shorter retention. | Full memory under `retention`. |
| `screen` | Screens or redacts text before it is filed, embedded or compiled. | None. |
| `compile` | The provider and model the compile runs on, or `false` for no compile. | The agent's own provider and model. |
| `tombstoneKey` | A secret; tombstones become keyed hashes. | Plain hashes. Supply one. |
| `tombstoneCopy` | Where the second copy of the tombstones lives. | `memory/.store/forgotten.sqlite` |
| `sharedMemory` | One user for every session that names none: one person's own machine, or an operator's notes. | Off. |
| `legacyMemory` | Attributes memory from before per-user scope to one user, on one person's own machine. | Off. |
| `soul: { path, optional: true }` | Lets an agent start when its soul fails to load. | Off: a failed load throws. |
| `agent.forgetUser`, `agent.applyTombstones`, `agent.sweepRetention`, `agent.exportUserMemory`, `agent.correctUserMemory` | The calls your request handling, your schedule and your restore runbook use. | Present on a souled agent with a workspace folder. |

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
- [GMI](../GMI.md): sessions, the user id, the learning layer's `forgetUser`
- [High-Level API](../getting-started/HIGH_LEVEL_API.md): `souledAgent()`, its options and its handle
- [SQLite Brain Storage](../memory/MEMORY_STORAGE.md): the tables, the forgotten-user ledger, `secure_delete`
- [Memory Operations](../MEMORY_OPERATIONS.md): one person's export and correction
- [PII Redaction](./PII_REDACTION.md)
