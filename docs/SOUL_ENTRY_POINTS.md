---
title: "Choose a character that remembers each user"
description: "Choose souledAgent(), gmi() or agent() for a character. See what each stores by user id, how to export or delete memory, and how to upgrade an existing store."
---

# Choose a character that remembers each user

Use `souledAgent()` to remember each user across visits. Pass the same user id to export, correct or delete that person’s memory. A **soul** is a character's identity, style and limits written in Markdown. A **GMI** (Generalized Mind Instance) is the runtime that serves a session with the agent's persona, working memory, mood and reasoning trace.

| What you need | Call |
|---|---|
| A character with durable memory and readable notes for each user | `await souledAgent({ soul })` |
| The same character and notes, with cognitive recall from the same store | `await souledAgent({ soul, memory: { embedding: { provider } } })` |
| A character with a mind whose memory you manage yourself | `gmi({ soul })` or `agent({ runtime: 'gmi', soul })` |
| A character's voice and limits for the conversation | `agent({ soul })` |

## Remember each player by user id with `souledAgent()`

Give a game character a workspace folder and pass the same player id on each visit. `souledAgent()` runs on the GMI runtime with the `light` profile: cognitive memory is off, and the soul's store files and recalls each player's turns. To add cognitive recall to this example, name the embedding provider in `memory.embedding.provider`. `runtime: 'legacy'` selects the legacy runtime.

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

| Question | Cognitive memory off: the default, and `runtime: 'legacy'` | A souled agent on the GMI runtime with cognitive memory on |
|---|---|---|
| What is stored, and where? | The soul's store files each speaker's text and time as a conversation trace. | The same store holds each accepted side of a session turn once, marked `filedBy: 'mind'`. The turn result's `memoryWrite` reports each side's outcome. |
| Under which key? | `conversationScopeKey(agentId, subject)` uses the session's named user or, for an anonymous session, its session id. With `sharedMemory`, unnamed calls use the user id in `as`. | The mind uses the same key. Its recall reads marked rows. The soul's provider reads the remaining rows for that user and the operator's pages. |
| For how long? | `retention.traces` sets days or `'until-deletion'`. Anonymous sessions can have their own period. Schedule `sweepRetention()` on a server that stays open. Closing the agent also sweeps. | The same sweep reaches mind-filed traces. Closing a session leaves its stored memory under its existing key. |
| What is derived? | Per-user wiki pages and their chunks, a search index and graph records. The deletion ledger records tombstones, deleted trace ids and live corrections. | Cognitive recall adds vectors, trace strengths, access records and graph links. Stored emotional context defaults to neutral. Each user's traces feed that user's wiki compile. |
| Who receives text? | The chat model receives the conversation and recalled text. The compile model receives the user's screened traces when compilation runs. `compile: false` disables it. | The named embedding provider also receives recall queries and text accepted for embedding. `agent.recipients()` lists configured and recorded routes. Session requests withhold the end-user id unless you set `sendUserIdToProvider: true` on a GMI path whose provider accepts it. |
| How do I export or correct it? | `exportUserMemory(userId)` returns traces and pages. `correctUserMemory(userId, { traceIds, text })` replaces the selected memories. Omit `text` to delete them. | The same calls include mind-filed rows. Inspect the export's `unread` entries for stores that could not be read. |
| How do I restrict or delete it? | Return `{ longTerm: 'off' }` from `memoryPolicy` to stop personal filing, recall and compilation. Stored traces remain. `forgetUser(userId, { linkedSessions })` erases the user's memory and the anonymous sessions you identify. Check `complete`. | The same policy also stops mechanisms working on that person's memory. With sentiment on (`cognition: 'full'`), `longTerm: 'off'` still scores the person's messages; `profiling: 'off'` stops that. The same deletion reaches the live mind and clears this handle's sessions for the user. The host handles other processes, recipients and backups. |

A one-shot call without a user reads operator pages and files nothing unless you set `sharedMemory`. A seat session runs without cognitive memory. For the difference between screening text for storage and blocking a turn before its first provider call, see [input guards](./safety/GUARDRAILS_USAGE.md).

## Give a tutor cognitive recall with `gmi()`

```ts
import { gmi } from '@framers/agentos';

const tutor = gmi({
  soul: './characters/tutor',
  memory: { embedding: { provider: 'ollama' } },
});
await tutor.session('lesson-1', { userId: 'student-42' }).send('Help me practise fractions.');
await tutor.close();
```

## Give a support agent a voice with `agent()`

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
const page = memory.pages.find(page => page.id === selectedPageId);
if (page?.sources.includes(selectedTraceId)) {
  await innkeeper.correctUserMemory!(playerId, { traceIds: [selectedTraceId], text: correctedText });
}
```

With `legacyMemory`, the export also holds traces from before per-user scope and the older pages built from them. Show those as read-only: `correctUserMemory` rejects their trace ids.

See [the high-level API](./getting-started/HIGH_LEVEL_API.md) for signatures and [host duties](./safety/MEMORY_HOST_DUTIES.md) for deletion receipts, restores and recipients.

## Before you serve users

### EU workplaces and education

As a precaution, keep sentiment off in an EU workplace or education institution unless your counsel clears the use. `cognition: 'full'` enables sentiment.

If you provide an agent that interacts directly with people, design it to disclose that it is an AI unless that is obvious, in the circumstances and context of use, to a reasonably well-informed, observant and circumspect person. [Article 50(1)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02024R1689-20260727)

Give that information clearly and distinguishably, at the latest at the first interaction. [Article 50(5)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02024R1689-20260727)

The EU AI Act's exclusion for AI systems released under free and open-source licences does not cover a system placed on the market or put into service as a high-risk AI system, or as one that falls under Article 5 or 50. [Article 2(12)](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02024R1689-20260727)

### Children

Return `minor: true` in the account’s memory policy. Choose a retention period in days if you keep its traces. Use the same export and deletion calls to handle a verified parent's request.

If the US children's privacy rule applies to your service, give a parent who asks, once you have confirmed they are the child's parent, a description of the kinds of information you collect from children, a way to review their child's personal information, and the choice at any time to stop further use or collection of it and to have it deleted. [16 CFR § 312.6](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312)

Under that rule, maintain a written retention policy that states why you collect children's information, why you need to keep it and when you will delete it, and include the policy in your online notice. [16 CFR § 312.10](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312)

### California companion chatbots and game characters

Implement a crisis protocol of your own. Sentiment events describe the tone of text. Use a separate mechanism for crisis detection.

If you are an operator of a companion chatbot as California Business and Professions Code section 22601 defines it, section 22602(b) bars the chatbot from engaging users unless you maintain a protocol for preventing the production of suicidal ideation, suicide or self-harm content, including a notification that refers a user who expresses suicidal ideation, suicide or self-harm to crisis service providers such as a suicide hotline or crisis text line, and requires you to publish details of the protocol on your website. [BPC § 22602(b)](https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=BPC&division=8.&title=&part=&chapter=22.6.&article=)

The video game exclusion reads as follows.

> A bot that is a feature of a video game and is limited to replies related to the video game that cannot discuss topics related to mental health, self-harm, sexually explicit conduct, or maintain a dialogue on other topics unrelated to the video game. [BPC § 22601(b)(2)(B)](https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=BPC&division=8.&title=&part=&chapter=22.6.&article=)

## Upgrading

### From 0.20: `souledAgent()` runs on the GMI runtime by default

`souledAgent()` with no `runtime` runs on the GMI runtime with the `light` profile. `runtime: 'legacy'` keeps the legacy runtime, and `agent()` keeps its own default. An app that sets no other option meets these changes.

- **Set `memory` only for cognitive memory.** Cognitive memory stays off unless `memory`, `cognition.memory` or `cognition: 'full'` turns it on. With it on, name the provider that receives text in `memory.embedding.provider`, or the open throws. The GMI runtime does not read the legacy runtime's `memory.working` callback.
- **Expect the same recall for each user.** With cognitive memory off, the soul's store files each turn and recalls each user's memory and the operator's pages, as on the legacy runtime.
- **Read `historyOmitted` on long sessions.** A request gives the session's history 35 percent of the model's context window. Messages over that share are left out, oldest first, with no summary in their place, and the turn's result reports them in `historyOmitted`. The legacy runtime sends the whole stored history and throws `ContextWindowExceededError` when a request does not fit a model whose window is in the model catalog.
- **Check replies against the soul's front matter.** The GMI's persona applies the soul's traits, mood, reasoning-trace limits and hard limits. The legacy runtime renders the traits and the hard limits and has no renderer for the mood and the trace limits, so replies can differ.
- **Expect a log line for a front-matter `voice` or `avatar`.** The GMI runtime leaves each out, as the legacy runtime does, and says so in one `soul.field_ignored` line for each.
- **Remove the `channels`, `voice` and `avatar` options, or set `runtime: 'legacy'`.** The GMI runtime throws at open when one is set, naming the option.
- **Pass a schema to a session's `send()`, or set `runtime: 'legacy'`.** The GMI runtime does not validate `generate()` against the agent's `responseSchema`, so `souledAgent()` throws at open when one is set, before anything opens. A session's `send()` takes `responseSchema` and returns the value in `result.object`.
- **Let a turn finish before `close()`.** `close()` stops the session turns still running. The legacy runtime lets them finish within the close's wait.
- **Keep your keys as they are.** The default needs no embedding model, and no session request sends the end user's id to the model provider unless you set `sendUserIdToProvider: true`.

An agent that sets other `agent()` options meets the GMI runtime's handling of each. [GMIs from agent()](./GMI.md#gmis-from-agent) lists them, the per-call options `generate()` and `stream()` take among them: a call that passes any other throws, naming it.

A store written under either runtime opens under the other. To go back, set `runtime: 'legacy'` or install 0.20; neither needs a data move.

### From 0.19: one memory for a souled agent on the GMI runtime

A workspace-backed `souledAgent({ runtime: 'gmi' })` gives each user one durable memory. The wiki and cognitive recall read the same store. Export, correction, retention and deletion reach the turns the mind files there. 0.20 keeps `'legacy'` as the default runtime.

- **Configure cognitive memory.** Name the provider that receives text in `memory.embedding.provider`. Enabling cognitive memory without it, or setting `memory.consolidation.enabled: true`, throws at open. `session.close()` ends the conversation in process. An anonymous session reopened with the same id keeps the same stored memory, subject to retention and forgetting. Use a fresh session id for a different anonymous visitor.
- **Migrate `memory.store` with `copyLegacyGmiMemory`.** Turns stop reading and writing traces in `memory.store`. Keep it attached while moving its data. Preview the move with `agent.copyLegacyGmiMemory()`, pass known user ids in `users` to identify more rows, then pass `dryRun: false` to file eligible traces in the soul's store and remove their source rows. Check the report for traces left behind.
- **Set a tombstone key before adding a second person or anonymous session.** A multi-person store needs `retention` and, when its ledger holds no tombstones, `tombstoneKey`.
- **Choose a period in days for a minor's memory.** With `minor: true` on an `'until-deletion'` store, the session keeps no long-term memory, even with a shorter `retentionDays` policy answer.
- **Send the user id only when needed.** GMI session requests omit the end user's id unless you set `sendUserIdToProvider: true`. Use an opaque id if you enable it.
- **Set the emotional stamp.** The mind stores a neutral emotional stamp by default. Set `emotionalStamp: 'mood'` to store the agent's mood. A minor's traces and those of a user with `profiling: 'off'` stay neutral.
- **Account for team sessions.** A seat session on a souled agent runs without cognitive memory.
- **Update policy on open sessions.** On either runtime, a later `memoryPolicy` answer for a user on the same agent object replaces an open session's answer from its next turn.
- **Route warnings through your logger.** Four former `console.warn` calls in `souledAgent()` emit `soul.inline_no_wiki`, `memory.close_pending`, `memory.close_sweep_failed` and `memory.close_compile_failed`. In `gmi()`, a skipped provider context emits `memory.provider_context_skipped`.
- **Protect the second copy and plan a rollback.** The tombstone copy also holds the text of each live correction. When rolling back to 0.19.x, drop the `memory_corrections` table from that copy: 0.19.x neither replays nor deletes its rows, so a person it forgets would keep their corrections' text there. Version 0.19.x reads mind-filed rows as ordinary conversation rows and recalls them through the provider. If you opened the agent with `soulStore`, moving back to the file store requires moving your data.
