---
title: "Choose an agent for character and per-user memory"
description: "Choose souledAgent(), gmi() or agent() for a character. See what each stores by user id, how to export or delete memory, and how to upgrade an existing store."
---

# Choose an agent for character and per-user memory

Use `souledAgent()` for a character that remembers each user across visits and lets you export, correct and delete memory by user id. A **soul** is a character's identity, style and limits written in Markdown. A **GMI** (Generalized Mind Instance) is the runtime that serves a session with the agent's persona, working memory, mood and reasoning trace.

| What you need | Call |
|---|---|
| A character with durable memory and readable notes for each user | `await souledAgent({ soul })` |
| The same character and notes, with cognitive recall from the same store | `await souledAgent({ soul, runtime: 'gmi', memory: { embedding: { provider } } })` |
| A character with a mind whose memory you manage yourself | `gmi({ soul })` or `agent({ runtime: 'gmi', soul })` |
| A character's voice and limits for the conversation | `agent({ soul })` |

## Remember each player by user id

Give a game character a workspace folder and pass the same player id on each visit. The default runtime is `'legacy'`. To add cognitive recall to this example, set `runtime: 'gmi'` and name the embedding provider in `memory.embedding.provider`.

```ts
import { souledAgent } from '@framers/agentos';

const innkeeper = await souledAgent({
  soul: './characters/innkeeper',
  retention: { traces: { days: 90 } },
  tombstoneKey: process.env.INNKEEPER_TOMBSTONE_KEY!,
});
const visit = innkeeper.session('visit-118', { userId: 'player-7f3a' });
await visit.send('Save the room above the stable for my next visit.');
await innkeeper.close();
```

A workspace-backed agent opens `memory/.store/memory.sqlite` by path inside the soul's folder. Run one process per SQLite store. With `soulStore: { adapter }`, the agent uses your SQLite database or PostgreSQL schema. Give each agent its own database or schema, a separate `tombstoneCopy`, a retention policy and a tombstone key. You own encryption at rest for the main store, its backups and the second copy. The default SQLite file is plaintext.

There is no file-to-`soulStore` import call. The file's brain id comes from its path. Opening a database copied from that file under the adapter's agent id fails the ownership check. The open also refuses a workspace with a store file left behind. An inline soul or an optional soul that fails to load yields a plain agent without the workspace or its per-user calls.

### What each workspace-backed agent keeps

| Question | Default runtime, or GMI with cognitive memory off | A souled agent on the GMI runtime with cognitive memory on |
|---|---|---|
| What is stored, and where? | The soul's store files each speaker's text and time as a conversation trace. | The same store holds each accepted side of a session turn once, marked `filedBy: 'mind'`. The turn result's `memoryWrite` reports each side's outcome. |
| Under which key? | `conversationScopeKey(agentId, subject)` uses the session's named user or, for an anonymous session, its session id. `sharedMemory: { as }` assigns unnamed calls to one user. | The mind uses the same key. Its recall reads marked rows. The soul's provider reads the remaining rows for that user and the operator's pages. |
| For how long? | `retention.traces` sets days or `'until-deletion'`. Anonymous sessions can have their own period. Schedule `sweepRetention()` on a server that stays open. Closing the agent also sweeps. | The same sweep reaches mind-filed traces. Closing a session leaves its stored memory under its existing key. |
| What is derived? | Per-user wiki pages and their chunks, a search index and graph records. The deletion ledger records tombstones, deleted trace ids and live corrections. | Cognitive recall adds vectors, trace strengths, access records and graph links. Stored emotional context defaults to neutral. Each user's traces feed that user's wiki compile. |
| Who receives text? | The chat model receives the conversation and recalled text. The compile model receives the user's screened traces when compilation runs. `compile: false` disables it. | The named embedding provider also receives recall queries and text accepted for embedding. `agent.recipients()` lists configured and recorded routes. Session requests withhold the end-user id unless you set `sendUserIdToProvider: true` on a GMI path whose provider accepts it. |
| How do I export or correct it? | `exportUserMemory(userId)` returns traces and pages. `correctUserMemory(userId, { traceIds, text })` replaces the selected memories. Omit `text` to delete them. | The same calls include mind-filed rows. Inspect the export's `unread` entries for stores that could not be read. |
| How do I restrict or delete it? | Return `{ longTerm: 'off' }` from `memoryPolicy` to stop personal filing, recall and compilation. Stored traces remain. `forgetUser(userId, { linkedSessions })` erases the user's memory and the anonymous sessions you identify. Check `complete`. | The same policy also stops mechanisms working on that person's memory. The same deletion reaches the live mind and clears this handle's sessions for the user. The host handles other processes, recipients and backups. |

A one-shot call without a user reads operator pages and files nothing unless you set `sharedMemory`. A seat session runs without cognitive memory. For the difference between screening text for storage and blocking a turn before its first provider call, see [input guards](./safety/GUARDRAILS_USAGE.md).

## Give a tutor a mind with cognitive recall

```ts
import { gmi } from '@framers/agentos';

const tutor = gmi({
  soul: './characters/tutor',
  memory: { embedding: { provider: 'ollama' } },
});
await tutor.session('lesson-1', { userId: 'student-42' }).send('Help me practise fractions.');
await tutor.close();
```

## Give a support agent a character

```ts
import { agent } from '@framers/agentos';

const support = agent({ soul: './characters/support' });
await support.session('ticket-42').send('Where can I find my invoice?');
await support.close();
```

| Question | `gmi({ soul })` with cognitive memory | `agent({ soul })` on the default runtime |
|---|---|---|
| What, where and for how long? | User messages, replies, vectors and graph data live in process. A passed `memory.store` persists traces in SQLite or on your adapter. It requires a learning configuration and a stable brain key. It has no retention sweep. | The session holds message history in process. If you pass a `memoryProvider`, you choose its storage, keys, retention and derived data. |
| Under which key? | With a named user and no learner, user messages use the user scope and replies use the session scope. An unnamed session uses its session scope. A learner supplies its own scoped ids. | The session id keys conversation history. The provider receives the session context. |
| Who receives text? | The chat model receives the conversation and recalled memories. The embedding provider receives queries and trace text. A model adapter that supports the end-user field can receive the session's user id. | The model receives the character prompt and conversation, including any context your provider supplies. |
| How do I manage personal data? | With learning on, `learning.forgetUser(userId)` reaches the learner's memory and learning rows. `exportLearnedState` exports learning data only. The host supplies trace export, correction, per-user restrictions and retention. | The host supplies export, correction, restrictions and deletion for any data it keeps. |

## Replacing an outdated fact

A newer statement can be recalled alongside an older one. Pass the older trace id and the replacement text to `correctUserMemory`. This removes the old trace and any pages built from it. The next compile rebuilds those pages from the remaining traces.

## Letting a user read and fix what the agent remembers

Show the user the `pages` from their `exportUserMemory` result. Each page's `sources` identifies the traces behind it. Send the user's edits through those trace ids. The agent reads its operator pages and the asker's own pages through `read_memory_page`.

```ts
const memory = await innkeeper.exportUserMemory!(playerId);
const statements = memory.traces.filter(trace => memory.pages[0]?.sources.includes(trace.id));
await innkeeper.correctUserMemory!(playerId, { traceIds: [selectedTraceId], text: correctedText });
```

See [the high-level API](./getting-started/HIGH_LEVEL_API.md) for signatures and [host duties](./safety/MEMORY_HOST_DUTIES.md) for deletion receipts, restores and recipients.

## Before you serve users

Keep sentiment off for an EU workplace or education institution until your counsel clears its use. Design your product’s AI disclosure for the first interaction. For children, set `minor: true`, choose a retention period in days and handle parent requests with the same export and deletion calls. For a California companion chatbot, implement a crisis protocol of your own. Read the [host duties and official sources](./safety/MEMORY_HOST_DUTIES.md#eu-ai-act), including the [video game exclusion](./safety/MEMORY_HOST_DUTIES.md#california-companion-chatbots-and-game-characters).

## Upgrading

A workspace-backed `souledAgent({ runtime: 'gmi' })` gives each user one durable memory. The wiki and cognitive recall read the same store. Export, correction, retention and deletion reach the turns the mind files there. The default runtime stays `'legacy'`.

- **Configure cognitive memory.** Name the provider that receives text in `memory.embedding.provider`. Enabling cognitive memory without it, or setting `memory.consolidation.enabled: true`, throws at open. `session.close()` ends the conversation in process. An anonymous session reopened with the same id keeps the same stored memory, subject to retention and forgetting. Use a fresh session id for a different anonymous visitor.
- **Move traces from a passed GMI store.** Turns stop reading and writing traces in `memory.store`. Keep it attached while moving its data. Preview the move with `agent.copyLegacyGmiMemory()`, pass known user ids in `users` to identify more rows, then pass `dryRun: false` to file eligible traces in the soul's store and remove their source rows. Check the report for traces left behind.
- **Set a tombstone key before adding a second person or anonymous session.** A multi-person store needs `retention` and, when its ledger holds no tombstones, `tombstoneKey`.
- **Choose a period in days for a minor's memory.** With `minor: true` on an `'until-deletion'` store, the session keeps no long-term memory, even with a shorter `retentionDays` policy answer.
- **Choose what leaves the process.** GMI session requests omit the end user's id unless you set `sendUserIdToProvider: true`. Use an opaque id if you enable it.
- **Choose what stays with a trace.** The mind stores a neutral emotional stamp by default. Set `emotionalStamp: 'mood'` to store the agent's mood. A minor's traces and those of a user with `profiling: 'off'` stay neutral.
- **Team seats.** A seat session on a souled agent runs without cognitive memory.
- **Update policy on open sessions.** On either runtime, a later `memoryPolicy` answer for a user on the same agent object replaces an open session's answer from its next turn.
- **Route warnings through your logger.** Four former `console.warn` calls in `souledAgent()` emit `soul.inline_no_wiki`, `memory.close_pending`, `memory.close_sweep_failed` and `memory.close_compile_failed`. In `gmi()`, a skipped provider context emits `memory.provider_context_skipped`.
- **Protect the second copy and plan a rollback.** The tombstone copy also holds the text of each live correction. When rolling back to 0.19.x, drop the `memory_corrections` table from that copy. Version 0.19.x reads mind-filed rows as ordinary conversation rows and recalls them through the provider. If you opened the agent with `soulStore`, moving back to the file store requires moving your data.
