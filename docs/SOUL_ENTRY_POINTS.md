---
title: "A Character That Remembers Each User: Which Call to Use"
description: "Which AgentOS call gives an agent character long-term memory of each user: souledAgent(), gmi({ soul }) or agent({ soul }). What each one stores, where, under which key and for how long, who receives the text, and which call exports, corrects and deletes one user's memory."
---

# A Character That Remembers Each User: Which Call to Use

Three calls build an agent from a soul. A soul is a folder of Markdown files that holds a character's identity: who it is, how it speaks and what it never does ([Soul Files](./SOUL_FILES.md)). A GMI (Generalized Mind Instance) is the engine that serves a session with the agent's persona, a working memory, a mood and a reasoning trace, and, when memory is on, cognitive memory ([GMIs](./GMI.md)). The three calls differ in what the agent remembers about each user, and in which calls reach that memory.

| You are building | Call | What it gives |
|---|---|---|
| A character that remembers each user: a game character, a companion, a tutor, a support agent | `await souledAgent({ soul })` | Long-term memory kept under each user id in a store beside the soul; notes compiled from each user's own conversation; one call each to delete, export and correct a user's memory; a retention period; the wiki pages you write for every user |
| The character as a mind | `gmi({ soul })`, or `agent({ runtime: 'gmi', soul })` | The agent's persona on a GMI and, with `memory` set, cognitive memory scoped by user id. With the learning layer on, a user's memory is deleted through it; no call exports or corrects it |
| The character's identity, with nothing kept | `agent({ soul })` | The soul's prose, style, traits and hard limits in the system prompt. Long-term memory only from a `memoryProvider` you pass |

`souledAgent()` gives this memory when `soul` names a folder; an inline soul, or an optional one that does not load, gives a plain agent with no store and none of the per-user calls ([`souledAgent.ts` L604-L612](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L604-L612)). It runs on either engine: `runtime: 'legacy'`, the default ([`agent.ts` L400-L405](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/agent.ts#L400-L405)), or `runtime: 'gmi'`.

## `souledAgent()`: a character that remembers each user

A game character that remembers each player by the player's id:

```ts
import { souledAgent } from '@framers/agentos';

const innkeeper = await souledAgent({
  provider: 'anthropic',
  soul: '~/.agentos/agents/innkeeper', // the folder that holds SOUL.md
  retention: { traces: { days: 90 } }, // required once a second player shares the store
  tombstoneKey: process.env.INNKEEPER_TOMBSTONE_KEY!, // required with it: a deleted player's tombstone is then a keyed hash
});

// One session a visit, opened with the player's id.
const visit = innkeeper.session('visit-118', { userId: 'player-7f3a' });
const reply = await visit.send('Is the room I asked about still free?');
console.log(reply.text);

// The per-user calls are typed optional: they are absent when the soul does not load from a folder.
if (!innkeeper.exportUserMemory || !innkeeper.forgetUser) throw new Error('the soul did not load from its folder');

// The player's own memory: a copy of what the store holds now, then its deletion.
// The turn just sent is filed in the background, so the copy can be missing it.
const copy = await innkeeper.exportUserMemory('player-7f3a');
const report = await innkeeper.forgetUser('player-7f3a');
console.log(copy.traces.length, report.complete);

await innkeeper.close();
```

What the agent keeps of a user, on the default runtime:

| | `souledAgent()` |
|---|---|
| What is stored | Each message a user sends and each reply, as one trace with who spoke and when; a text the user's memory already holds word for word is not filed again ([`souledAgent.ts` L970-L986](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L970-L986)). A one-shot `generate()` or `stream()` names no user and files nothing, unless `sharedMemory` runs it as its one user ([L759-L767](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L759-L767)) |
| Where | `memory/.store/memory.sqlite` in the soul's folder, a SQLite file `souledAgent()` opens by path ([L640](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L640), [L678-L682](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L678-L682)). The second copy of the tombstones is `forgotten.sqlite` beside it, or the file or adapter `tombstoneCopy` names ([L646-L649](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L646-L649)). With `soulStore: { adapter }`, your own database, SQLite or PostgreSQL, under the soul's `agentId`, with `tombstoneCopy` required, `retention` and `tombstoneKey` ([L755-L770](https://github.com/framerslab/agentos/blob/452afce99e33293536ffeb665ef5c161b1f79fab/src/api/souledAgent.ts#L755-L770), [L767-L851](https://github.com/framerslab/agentos/blob/1950161471c6f83666dc683296bb48e675d3bc57/src/api/souledAgent.ts#L767-L851)) |
| Under which key | `conversationScopeKey(agentId, subject)` ([`conversationScopeKey.ts` L39-L70](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/memory/retrieval/store/conversationScopeKey.ts#L39-L70)). The subject is the user a session names with `userId`, else the session itself: `c1:u:<n>:<agentId>:<m>:<userId>;` for a user and `c1:s:<n>:<agentId>:<m>:<sessionId>;` for a session that names none, where `<n>` and `<m>` are the lengths of the two ids. An anonymous id (`anonymous`, `guest` and the like) names no user. With `sharedMemory: { as }`, every session that names no user is filed as the user `as`. Keys are matched by equality |
| For how long | Until `agent.sweepRetention()` or `close()`, which runs it, deletes what is older than the period `retention` sets, a number of days or `'until-deletion'`; recall reads a trace until then, so a long-running process calls `sweepRetention()` on a schedule. A sweep that fails on `close()` logs one warning and leaves the expired traces for the next sweep ([L1637-L1647](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1637-L1647)). With no `retention`, until `forgetUser` deletes them; a session that named no user is deleted only when its id is in `linkedSessions` ([L1496-L1534](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1496-L1534)). Without `retention`, or without `tombstoneKey` while the tombstone ledger holds no tombstone, a store that holds a second user or session refuses to open, and a session for a second one is refused ([L1340-L1346](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1340-L1346), [L1695](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1695)) |
| Data derived from it | The user's pages, compiled by a model from that user's traces alone, and the chunks of those pages that recall searches; a full-text index entry and a memory-graph node for each trace; the user's row of the scope registry, with the time of the last compile; after a deletion, one tombstone, a hash of the id |
| Who receives text | The model provider, each turn: the conversation, with what recall reads for the turn, up to eight matches from the user's own memory (and up to eight from each form of the memory from before per-user scope, for the user `legacyMemory` names) and up to eight from the operator's pages (the Markdown pages you write under `memory/`), kept to the turn's memory token budget, 2,000 tokens by default ([L1132-L1195](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1132-L1195), [`memoryProviderHooks.ts` L27](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/runtime/memoryProviderHooks.ts#L27)). The compile: the agent's own provider and model on its route, fallback providers included; with `compile` set to a provider or model, that one alone; nobody with `compile: false` ([L1203-L1253](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1203-L1253)). No embedding provider: the store is opened with no embedder, so recall is full-text search ([L678-L682](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L678-L682)). No user id is sent to the model provider ([`agent.ts` L643-L659](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/agent.ts#L643-L659)) |
| Export | `agent.exportUserMemory(userId)`: the user's traces and pages as JSON ([L1576-L1593](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1576-L1593)) |
| Correct | `agent.correctUserMemory(userId, { traceIds, text })` ([L1594-L1610](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1594-L1610)) |
| Restrict | `memoryPolicy` answers for the account a turn serves: `{ longTerm: 'off' }` files nothing and recalls the operator's pages alone, and `{ longTerm: 'raw' }` files and recalls and compiles no page. `screen` is given each text before it is filed and again before it is compiled |
| Delete | `agent.forgetUser(userId, { linkedSessions })`, with a report of each store it reached ([L1496-L1534](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1496-L1534)); `agent.sweepRetention()` for what `retention` no longer keeps ([L1565-L1575](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1565-L1575)) |

`souledAgent()` opens the store's file itself unless `soulStore` names a storage adapter of yours; on the file, run one process per store. On your adapter, give the agent a database or PostgreSQL schema of its own: the open refuses a database that already holds another agent's memory ([L781-L783](https://github.com/framerslab/agentos/blob/1950161471c6f83666dc683296bb48e675d3bc57/src/api/souledAgent.ts#L781-L783)), and `close()` leaves the adapter open. A host that wires the same parts itself, over `Memory.createWithAdapter()` or `Memory.createPostgres()` with `attachMemoryWiki()`, calls `forgetUserMemory()`, `reapplyTombstones()`, `sweepRetention()`, `exportSubjectMemory()` and `correctSubjectMemory()` itself.

Each option and call is described in [`souledAgent()`](./getting-started/HIGH_LEVEL_API.md) and [One person's memory](./MEMORY_OPERATIONS.md#one-persons-memory). Before you serve other people with memory on, read [Your Duties as the Controller](./safety/MEMORY_HOST_DUTIES.md).

## `souledAgent({ runtime: 'gmi' })`: the same memory on a GMI

`runtime: 'gmi'` serves the agent's sessions with GMIs. Everything in the table above holds, with three differences:

- The soul's mood and reasoning-trace limits apply, through the agent's persona ([What Applies on Each Path](./SOUL_FILES.md#what-applies-on-each-path)).
- A `userId` passed to `session()` goes with each model request as the end user's id ([`gmi.ts` L1253](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/gmi.ts#L1253)) on the adapters that send one: OpenAI's (`user`, or `safety_identifier` on the Responses API) and the adapters built on it, OpenRouter's and Requesty's (`user`); the Anthropic and Gemini adapters send none ([`OpenAIProvider.ts` L2390](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/core/llm/providers/implementations/OpenAIProvider.ts#L2390), [`OpenRouterProvider.ts` L778](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/core/llm/providers/implementations/OpenRouterProvider.ts#L778)). Pass an opaque or hashed id, never an email address.
- `forgetUser` leaves a session's own message history, and the report says so. A GMI session holds it in process memory until you call `session.clear()`, or close the session and drop its handle: `close()` does not empty it ([`souledAgent.ts` L1428-L1435](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1428-L1435)).

Cognitive memory is off on this runtime until you set `memory`, choose `cognition: 'full'` or set `cognition.memory`. While it is off, recall, the pages, the compile and every per-user call work on the soul's store alone.

### With cognitive memory on, the agent keeps two memories

A souled agent on the GMI runtime with cognitive memory on files each turn twice, in two stores that share no key:

| | The soul's store | The GMI's cognitive memory |
|---|---|---|
| What a turn files | The user's message and the reply, under the subject's key, through the memory provider `souledAgent()` gives the agent ([`souledAgent.ts` L1117](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1117), [L1290](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1290)) | The user's message under the session's `userId` and the reply under the session's own scope id; with `learning` on, both under the scope ids the learning layer gives the turn ([Where a turn's memory is filed and read](./GMI.md#where-a-turns-memory-is-filed-and-read)) |
| Where | `memory/.store/memory.sqlite`, or your database with `soulStore` | Process memory, which ends with the process or `agent.close()`; with `memory.store`, a SQLite file or your storage adapter |
| What a session turn recalls | Nothing: the GMI skips this store's recall, and one warning at construction says so ([`gmi.ts` L666-L668](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/gmi.ts#L666-L668)) | The turn's memory block |
| `read_memory_page` | Reads the asker's pages and the operator's | Not read |
| The wiki compile | Reads each user's traces | Not read |
| `agent.exportUserMemory(userId)` | Returns the user's traces and pages | Not read |
| `agent.correctUserMemory(userId, ...)` | Deletes the named traces and files the correction | Not changed |
| `agent.sweepRetention()` | Deletes what `retention` no longer keeps | Not swept: no retention period applies to it |
| `agent.forgetUser(userId)` | Deletes the user's traces, chunks, pages and registry row, and writes the tombstone | With `learning` on, the learning layer's own `forgetUser` runs first: it deletes the user's traces in the agent's memory, and the report names what it did not reach, the memory archive among them ([`LearningLayer.ts` L88-L99](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/learning/LearningLayer.ts#L88-L99)). With `learning` off it is not reached: the report's `learning store` entry reads `reached: false` with the reason `this agent runs no learning layer` ([`souledAgent.ts` L1476-L1483](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1476-L1483)) |
| A forgotten user's later turns | Refused, with one `memory.write_refused` log line (`reason: 'forgotten'`) | With `learning` on, refused: each filing reads the user's tombstone, which the learning layer's `forgetUser` wrote. With `learning` off, filed: the filing reads no tombstone ([`CognitiveMemoryBridge.ts` L57-L59](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/substrate/CognitiveMemoryBridge.ts#L57-L59)) |
| `memoryPolicy`, `screen`, `sharedMemory` | Act on it | Do not reach it, so `souledAgent()` refuses all three at its open with a `TypeError` ([`souledAgent.ts` L595-L603](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L595-L603)) |

A one-shot `generate()` or `stream()` on a GMI agent runs the light profile with no cognitive memory and reads the memory provider ([`gmi.ts` L1048-L1062](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/gmi.ts#L1048-L1062)), so on a souled agent it recalls the operator's pages from the soul's store.

With cognitive memory off, on either runtime, the soul's store is the agent's only long-term memory, and each per-user call reaches all of it. Issue [#845](https://github.com/framerslab/agentos/issues/845) tracks one memory for a souled agent on the GMI runtime.

## `gmi({ soul })`: the character as a mind

`gmi({ soul })` and `agent({ runtime: 'gmi', soul })` build the same agent ([GMIs from agent()](./GMI.md#gmis-from-agent)). The soul becomes the agent's persona: its id, name, role, HEXACO traits, mood, reasoning-trace limits and hard limits. The agent has no wiki compile, no `read_memory_page` tool and none of `souledAgent()`'s per-user calls.

```ts
import { agent } from '@framers/agentos';

const tutor = agent({
  runtime: 'gmi',
  provider: 'openai',
  soul: '~/.agentos/agents/tutor',
  memory: { embedding: { provider: 'openai', model: 'text-embedding-3-small' } },
});

const lesson = tutor.session('lesson-1', { userId: 'student-7f3a' });
const reply = await lesson.send('Where did we stop last time?');
console.log(reply.text);

await tutor.close();
```

What the agent keeps of a user:

| | `gmi({ soul })` with `memory` set |
|---|---|
| What is stored | Each user message and each reply, encoded as a memory trace with the emotional context of its turn ([What a GMI adds over a plain agent](./GMI.md#what-a-gmi-adds-over-a-plain-agent)) |
| Where | Process memory: an in-memory vector store and knowledge graph. With `memory.store`, a SQLite file or your storage adapter; that option needs `learning` and a key that names the store, `learning.agentKey` or the soul's id ([`gmi.ts` L594-L598](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/gmi.ts#L594-L598)) |
| Under which key | The user's messages under the session's `userId`, the replies under the session's own scope id; a session opened with no `userId` files both under its scope id. With `learning` on, under the scope ids the learning layer gives the turn ([Where a turn's memory is filed and read](./GMI.md#where-a-turns-memory-is-filed-and-read)) |
| For how long | Process memory: until the process ends or `agent.close()`. `memory.store`: no retention period and no sweep; a user's traces stay until `agent.learning.forgetUser(userId)` |
| Data derived from it | An embedding vector and a copy in the knowledge graph for each trace; what the eight mechanisms write, such as the gist an old trace is reduced to ([The eight mechanisms](./GMI.md#the-eight-mechanisms)); with `learning` on, the user's trait row and its ledger |
| Who receives text | The model provider, each turn: the conversation with the turn's memory block. The embedding provider: each trace as it is filed and each turn's query. `memory.embedding` names that provider; without it the agent takes the global default provider, else the first of OpenAI, Gemini and Ollama whose key or URL is in the environment ([`agentCognitiveMemory.ts` L129-L144](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/runtime/agentCognitiveMemory.ts#L129-L144)). A `userId` passed to `session()` goes with each request as the end user's id on the adapters that send one, as above ([`gmi.ts` L1253](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/gmi.ts#L1253)) |
| Export | With `learning` on, `agent.learning.exportLearnedState(userId)` returns the user's learned state: the trait state, lessons, skills, ledger rows and outcomes ([`LearningLayer.ts` L831-L861](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/learning/LearningLayer.ts#L831-L861)). No call returns a user's memory traces |
| Correct | No call corrects one user's memory |
| Restrict | Cognitive memory is on or off for the whole agent (`memory`, `cognition`); no option turns it off for one user. `agent.learning.freeze({ userId })` and `agent.learning.suspend({ userId })` act on the user's learned state ([Modes and the process switches](./GMI.md#modes-and-the-process-switches)) |
| Delete | With `learning` on, `agent.learning.forgetUser(userId)` deletes the user's traces in the agent's memory, then the user's learning-store rows, and its report names each store it did not reach: a knowledge graph with no delete call keeps its copies, and while a store fails the learning-store rows stay for the next call ([`LearningLayer.ts` L925-L1062](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/learning/LearningLayer.ts#L925-L1062)). With `learning` off the agent has no deletion call ([`gmi.ts` L1490-L1495](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/gmi.ts#L1490-L1495)) |

With `memory` unset on the default `'light'` profile the agent runs no cognitive memory and stores nothing about a user beyond each session's message history, which lives in process memory.

## `agent({ soul })`: identity alone

```ts
import { agent } from '@framers/agentos';

const aria = agent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });
const reply = await aria.session('customer-42').send('I need help with my invoice.');
console.log(reply.text);
```

The soul's prose opens the system prompt, its style and the index of the operator's pages follow, the `hexaco` scores render as the trait paragraph, and the hard limits close the prompt. The agent files no trace and sends no user id to the model provider; a session's message history lives in process memory. Long-term memory comes only from a `memoryProvider` you pass, and what that provider stores, where and for how long is the provider's own. The library holds nothing of a user to export, correct or delete.

## Replacing an outdated fact

`souledAgent()` files a new statement as a new trace and leaves the older one in place ([`Memory.ts` L773-L872](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/memory/io/facade/Memory.ts#L773-L872)). A user who said "I live in Lisbon" in March and "I moved to Porto" in June has both statements in memory, and recall can return either. Two calls change that:

- `agent.correctUserMemory(userId, { traceIds, text })` deletes the named traces for good, files `text` as a trace tagged `correction` (a `text` equal word for word to one of the named traces is deleted with it: [#865](https://github.com/framerslab/agentos/issues/865)), and deletes each page built from a deleted trace, which the next compile of the user's pages builds again from the traces that are left: `agent.memory.compileWiki()` at once, or the `close()` of a process in which the user had a turn; on an agent opened with `compile: false`, no compile runs, and with `memoryPolicy` or `screen` set, a compile waits for a turn of the user in that process, one the policy answered `compiled` ([L1000-L1024](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/api/souledAgent.ts#L1000-L1024)) ([`userMemoryExport.ts` L139-L224](https://github.com/framerslab/agentos/blob/f181338e45e19bde535541b1a614f20182ccd0d8/src/cognition/memory/io/userMemoryExport.ts#L139-L224)).
- `agent.forgetUser(userId)` deletes what the store holds of the user; its report reads `complete: false` when something stayed in a store it reached, such as a page that failed to delete or a write still running at its deadline. `complete` covers only the stores the call reached: read each entry's `reached`, which names a store it did not reach, such as the cognitive memory of an agent with no learning layer.

## Letting a user read and fix what the agent remembers

A user's notes are pages compiled from that user's own traces and kept as rows of the store. The agent reads them through `read_memory_page`, whose listing names the asker's pages and the operator's. Your product shows them from the export, and sends a fix through the traces a page was built from, which the page lists as `sources`:

```ts
if (!agent.exportUserMemory || !agent.correctUserMemory) throw new Error('the soul did not load from its folder');
const memory = await agent.exportUserMemory(userId);

// Each page with the statements it was compiled from.
const notes = memory.pages.map((page) => ({
  page,
  statements: memory.traces.filter((trace) => page.sources.includes(trace.id)),
}));

// The user marks the statements that are wrong and writes the right one.
await agent.correctUserMemory(userId, {
  traceIds: wrongTraceIds,
  text: 'I moved from Lisbon to Porto in June.',
});
```

No call edits a page. A page is compiled from traces, and a compile that folds new traces into it writes it again, so a correction changes the traces: it deletes the wrong ones, files the right statement, and the next compile builds the page from what is left (`agent.memory.compileWiki()`, or the close of a process in which the user had a turn). A page is written by a model, so read the user's export again after that compile. A trace from before per-user scope, which the export of the user `legacyMemory` names holds, is not one `correctUserMemory` accepts: it rejects the call.

## Reference

- [Soul Files](./SOUL_FILES.md): the workspace, the `memory/` wiki, and [what applies on each path](./SOUL_FILES.md#what-applies-on-each-path)
- [GMIs](./GMI.md): [GMIs from agent()](./GMI.md#gmis-from-agent), cognitive memory and [the learning layer](./GMI.md#learning)
- [High-Level API](./getting-started/HIGH_LEVEL_API.md): `souledAgent()`, its options and its calls
- [Your Duties as the Controller](./safety/MEMORY_HOST_DUTIES.md): what the library does with per-user memory and what your product does itself
- [Cognitive Memory](./memory/COGNITIVE_MEMORY.md): encoding, decay, recall and the memory block
- [Memory Operations](./MEMORY_OPERATIONS.md): [one person's export and correction](./MEMORY_OPERATIONS.md#one-persons-memory)
