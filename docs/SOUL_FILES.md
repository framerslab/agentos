# Soul Files & the Markdown Memory Wiki

AgentOS supports a markdown-based identity convention for agents, modeled after
the OpenClaw workspace pattern and the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)
spec. Identity, voice, procedural rules, and long-term memory all live in plain
markdown files inside a per-agent workspace directory. The loader parses YAML frontmatter into structured [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) fields, and
`agent({ soul })` puts the prose at the head of the system prompt.

The agent's long-term memory is an **LLM wiki** in two layers (the "LLM keeps a wiki" pattern). The pages under `memory/` are the operator's: markdown files written by hand, shared by everyone the agent talks with, and never written by the runtime. What people say to the agent is kept per subject (a user, or a session that names none) in a store under `memory/.store/`, and compiled into that subject's own pages, which are rows of the store and never files. [`souledAgent()`](https://docs.agentos.sh/getting-started/high-level-api) wires both end to end. Full detail in [The `memory/` Wiki](#the-memory-wiki) below.

![Soul file anatomy: the loader reads SOUL.md, the optional STYLE.md, IDENTITY.md and AGENTS.md, and the memory/ wiki, but not examples/. SOUL.md splits into persona fields and the prose that opens the system prompt unless systemBlocks replace it. Hard limits are prompt text, not a check. loadSoul() returns AGENTS.md and IDENTITY.md without applying them.](/img/diagrams/soul-files-anatomy.svg)

## Prior art & references

The soul-file convention and the `memory/` LLM wiki build on prior work:

- **[Andrej Karpathy, "LLM Wiki"](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)**: the pattern of an LLM that incrementally maintains a persistent, interlinked markdown wiki (entity pages, concept pages, cross-references) instead of retrieving raw chunks at query time. AgentOS's `memory/` directory is a runtime implementation of this idea.
- **[aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)** and the **OpenClaw** workspace pattern: the markdown identity-file convention (`SOUL.md` plus companion files) the soul workspace follows.
- **[MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)** (Packer et al., 2023): LLM-managed, self-editing memory across an in-context window and an external store.
- **[Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442)** (Park et al., UIST 2023): the memory-stream-plus-reflection design for long-running agent memory.

The cognitive-memory mechanisms layered on top (decay, retrieval-induced forgetting, reconsolidation) carry their own citations in the [Cognitive Memory docs](https://docs.agentos.sh/features/cognitive-memory).

## The 6-File Workspace

```
~/.agentos/agents/<agent-id>/
├── SOUL.md       identity, values, tone, hard limits         (REQUIRED)
├── STYLE.md      voice, syntax, vocabulary patterns           (optional)
├── IDENTITY.md   display card: name, role, agent-ID, avatar   (optional)
├── AGENTS.md     procedural rules: workflows, file access     (optional)
├── memory/       long-term memory wiki: index.md + entities/ + concepts/ + log/  (auto-managed)
└── examples/     good-outputs.md + bad-outputs.md             (optional)
```

| File | What it holds | What AgentOS does with it |
|---|---|---|
| **SOUL.md** | Personality, values, tone, behavioral boundaries | The body opens the system prompt; the frontmatter becomes `personaDefinition`. Without it, `loadSoul()` throws, and so does building an agent on it: `agent()` and `gmi()` throw `SoulLoadError`, and `souledAgent()` rejects with it. A front matter field of the wrong type throws the same error, naming the field. `soul: { path, optional: true }` runs the agent without the soul and writes one `soul.load_failed` log line. |
| **STYLE.md** | Voice patterns, vocabulary, register | Appended to the system prompt as a `## Style` section. |
| **IDENTITY.md** | Display card: name, role, agent-ID, avatar | Returned as `identityContent`; nothing in the runtime reads it. |
| **AGENTS.md** | Procedural rules, session-start checks, workflow steps | Returned as `agentsContent`; nothing in the runtime reads or runs it. |
| **memory/** | The operator's wiki pages (markdown written by hand, shared by every user), and the store of per-user memory under `.store/` | The index of the operator's pages joins the system prompt; [`souledAgent()`](./getting-started/HIGH_LEVEL_API.md) wires the wiki and per-user memory end to end. Without it, each session starts cold. |
| **examples/** | Good/bad output calibration | Not read by the loader. |

The principle from OpenClaw: **personality in SOUL.md, procedures in AGENTS.md.**
Don't mix them.

## The `memory/` Wiki

Long-term memory is an **LLM wiki** in two layers:

- **Operator pages** are markdown files under `memory/`, written by hand. They are
  shared by every user of the agent, listed in `index.md` and in the system prompt,
  indexed for recall under the operator's own key, and never written by the runtime:
  the files are the source of truth for themselves.
- **Per-user pages** are compiled from one subject's conversation alone (a user, or a
  session that names none). They are rows of the store (`memory_pages`), never files,
  never in `index.md` or in any prompt, and reached through that subject's recall and
  through `read_memory_page`.

```
<agent-id>/memory/
├── index.md        catalog of the operator's pages, written by the wiki
├── entities/       operator pages: one per person, place, thing, or project
├── concepts/       operator pages: one per topic or fact-cluster
├── log/            operator pages: daily logs (log/YYYY-MM-DD.md)
├── .meta/          the operator pages' hashes and index entries
└── .store/         the store: every subject's traces and pages, with a .gitignore
```

`.store/` holds what people said to the agent, so it is kept out of version control:
the store's folder is made with a `.gitignore` holding `*`, and one already there is
left as it is.

Pages are markdown with YAML frontmatter and `[[wikilinks]]`. The agent reads
the index from its prelude, then opens any page with the `read_memory_page` tool.

The LLM folds new conversation into pages when memory consolidates, once a subject:
a compile runs for each subject (a user, or a session that named none) that has new
traces, reads that subject's traces alone, and writes that subject's own pages. Those
pages are rows of the store (`memory_pages`), never files under `memory/`: a compile
writes nothing into the folder, and a page the operator wrote there is never read or
rewritten by one, even when a subject's page has the same id. Each subject has its own
watermark, in its row of the store's scope registry, so one subject's compile neither
waits for nor repeats another's. A [`souledAgent`](getting-started/HIGH_LEVEL_API.md)
compiles the subjects its turns wrote to on the agent's `close()`, and
`agent.memory.compileWiki()` compiles every subject with new traces mid-session
(`compileWiki({ scopes })` the named ones alone). A merge integrates new facts into
the subject's page rather than replacing it, and each page written is dated with the
time of the compile. The runtime does not version the pages.

`read_memory_page` takes `{ "id": "<page id>" }` or `{ "list": true }`. Whose pages
it reads is decided by the turn the call runs in, never by the call: the asker is the
subject the runtime put in the tool context (`context.userContext.memorySubject`, the
key the turn's memory is filed under), whatever the context's user id holds, so a
session whose id or user id is one of the anonymous words below reads its own pages;
with no subject, the asker is the user `context.userContext.userId` names. The tool
reads the asker's own pages, which are kept as rows of the store under the asker's
key (`UserWikiStore`), and the operator's pages; `{ "list": true }` lists both, each
marked `own` or `operator`. Another user's page answers exactly as a page that does
not exist, and so does a page an earlier version compiled into the folder when a user
asks for it. A call that carries `scope`, `scopeId`, `userId`, `turnUserId` or
`subject` is refused with an invalid-arguments result (`details.code` is
`INVALID_ARGS`) and reads nothing. With no user (no subject, and no user id or one of
`system`, `anonymous`, `anonymous_user` and `guest`), the tool reads the pages of the folder
alone: the operator's, and the pages an earlier version compiled. Each refusal writes
one `memory.page_read_refused` log line that carries its reason (`other_user`,
`no_user`, `legacy` or `caller_filter`) and no id.

The traces a `souledAgent`'s own observer stores carry no entities, so the default
clusterer merges them into the page `concepts/notes`: one such page a subject, since
the clusterer runs over one subject's traces at a time. Entity pages come from traces
stored with entities through `agent.memory.remember()` under a subject's key, or
from a clusterer passed to `attachMemoryWiki()`.

Each trace the observer stores records who spoke it in the trace's metadata
(`speaker: 'user'` or `speaker: 'assistant'`), outside its text and its tags, which
the store's full-text search reads, so recall never matches a trace by who spoke it.
The recall a souled agent adds to a turn sends each trace as one record of the
`<memory_recall>` data block, with its speaker and the date it was stored:
`{"speaker":"user","when":"26 days ago, 2026-10-14","text":"I^moved^to^Lisbon"}`.
A chunk of a wiki page has the speaker `note` and its page id
(`"speaker":"note","page":"concepts/notes"`), and a trace stored before speakers were
recorded carries the date alone. A trace's text is a JSON string with each run of
whitespace, line breaks included, sent as `^`, so what someone said can never open a
record of its own. The block keeps to the turn's memory token budget, whole traces
first; when even the first trace's label is larger than the budget, its record is the
trace's text alone.

A page the compiler creates gets a summary named from its page id, never copied from
a trace: `concepts/notes` is `Notes compiled from conversations`, and
`entities/johnny` is `Notes on johnny compiled from conversations`. A page that has a
summary keeps it, whoever wrote it, and a compile rewrites no existing summary.

The pages `index.md` lists are the operator's: markdown files written by hand under
`memory/`, shared by everyone the agent talks with. The wiki tells whose a page file
is by its front matter. A compile lists the traces a page was made from in `sources`,
and a page written by hand lists none, so:

- a page with no `sources`, or an empty list, is an operator page;
- a page whose `sources` holds an entry is a page a compile wrote;
- a page whose front matter does not parse, or whose `sources` is there and is not a
  list, cannot be told.

Only an operator page is listed in `index.md`, shown in the system prompt and indexed
for recall. A page file of the other two kinds stays on disk exactly as it is: it has
no line in `index.md`, its summary and its id reach no prompt, and its text is not
indexed for recall. This is the rule for pages an earlier version compiled into the
folder, whose summary or body could carry what one person said into the prompt of
every agent built from the soul. When a souled agent starts and the folder holds such
files, one `memory.legacy_pages` log line gives their count.

Memory an earlier version stored is left where it is and read by no user's turn: the
traces it filed under the agent's plain id (one `memory.legacy_traces` log line counts
them at start), the chunks of the pages it indexed there, and the page files it
compiled into the folder. A call with no user still reads those page files through
`read_memory_page`. Nothing of it is moved, rewritten or deleted by the library, since
whose words it holds is not recorded. To remove it, delete the earlier traces and
chunks under the agent's plain id for good, in both forms the line counts (they are
one id unless the agent id holds `/`, `%` or `:`):

```ts
import { encodePlainScopeId } from '@framers/agentos';

await agent.memory.deleteScope('persona', agentId);
const encoded = encodePlainScopeId('persona', agentId);
if (encoded !== agentId) await agent.memory.deleteScope('persona', encoded);
```

Then delete the compiled page files (the ones whose front matter lists `sources`), and
the next start writes `index.md` again and logs no `memory.legacy_traces` line.

On a single person's own machine, `legacyMemory: { attributeTo, reason:
'one-persons-machine' }` on `souledAgent()` attributes that older memory to one user:
the user recalls the old traces, reads and lists the old compiled pages, gets both in an
export, and a deletion you request for that user removes them. The option is a statement
you make. The library refuses it when the store records another user, any anonymous
session, a trace that names another user, another forgotten subject or another learner,
and it cannot check more than that. The attribution is recorded in the store, stands for
the store's life whether later opens pass the option or not, and is never moved to
another user; one `memory.legacy_attributed` log line counts the traces and pages it
attributed. A page whose front matter does not parse is never attributed: it stays
withheld from every user, and a deletion report goes on naming it as legacy memory nobody
attributed. A person who uses the agent later is another subject and never reads the
attributed memory.

The memory index in the system prompt is rendered from the operator's page files and
the text migrated from `MEMORY.md` (below), not read from `index.md`; `loadSoul()` and
`loadSoulSync()` return it as `wikiIndex`. A line written by hand into `index.md`
outside the migrated block does not reach the prompt, and the next catalog write
replaces it. To put a line in the index, write a page: its `summary:` front matter is
its line.

A souled agent writes `index.md` again from the operator's pages when it starts (a
failure to write it is a warning, and the start goes on), then indexes those pages for
recall under a key of their own, the operator's conversation scope of the agent
(`conversationScopeKey(agentId, { kind: 'operator' })`). `.meta/index.json` records
the version of that key as `keyVersion`. A folder an earlier version indexed has no
`keyVersion`: its operator pages are indexed again under the operator key at the first
start, and the chunks the earlier version filed under the agent's plain scope are left
in the store. It records the key itself as `operatorKey`: a folder opened under another
agent id (its `agentId` or `name` changed, or another agent opened it) has its operator
pages indexed again under the current agent's key, and the chunks filed under the other
key are deleted. When an operator page is edited, its old chunks are deleted from the
store for good and the page is indexed again; the chunks of a page whose file is gone
are deleted the same way.

`souledAgent()`'s `close()` runs in this order: the agent's own close (with
`runtime: 'gmi'` it stops the session turns still running; the default runtime's
lets them run on); one wait, up to 5 seconds (`pendingWritesTimeoutMs` sets it, 0
waits for none, `Infinity` for all of them), first for the turns still running (a
`generate()`, a `stream()`, a session's `send()` or `stream()`, on either runtime),
then for the memory writes of its turns; the compile; then the store's close. A turn
never waits for its memory writes; only `close()` does. When the wait ends with turns
or writes still pending, the compile takes what is stored and one `console.warn`
line gives the number still pending; a turn or a write that ends after that is not
folded into the wiki, and a write that reaches the store once it is closed is not
stored. A stream whose `abortSignal` aborts before anything was read from it is not
waited for; on the default runtime a stream runs only once it is read, so one nobody
reads and nobody aborts keeps the wait until the deadline: read or abort each stream
before `close()`.
The compile's model calls go on the agent's route with its fallback settings (`fallbackProviders`,
`onFallback`, `router`, `policyTier`), carry the agent's completion cap (`maxTokens`,
or `controls.maxTotalTokens`; the budget's check estimates a call without one at 4,096
output tokens), are checked against and charged to the agent's `budget` like its own
calls, and are written to its usage ledger under the source `souledAgent.compileWiki`. A call the budget refuses skips that subject:
one `memory.compile_skipped` log line gives the reason (`budget`) and no subject, the
subject's watermark stays where it was, so the next compile takes the same traces up
again, and the other subjects compile. A compile that fails for any other reason
keeps that subject's watermark too, lets the other subjects compile, and then fails
the call, which `close()` logs as a warning.

A page's id is its path under `memory/` without `.md`, with `/` between folders:
`entities/johnny` is `memory/entities/johnny.md`. An id is one or more names joined
by `/`. No name is empty or starts with a dot, so `.` and `..` are never names, and
no name starts or ends with a space or ends with a dot, which Windows drops from a
name; the id holds no backslash, no colon, none of `"`, `*`, `<`, `>`, `?` and `|`,
which Windows refuses in a name, and no control character, a NUL byte among them; it
is at most 512 characters, and each name in it at most 200 bytes in UTF-8, so a
page's file name, with `.md`, stays under the 255 bytes Linux allows in a name; and it
is not `index`, in any case, which names the catalog. The store checks every id
against this rule, and checks that the path the id names lies inside `memory/`,
before it reads or writes anything. `readPage` and `writePage` throw an
`InvalidWikiPageIdError` for any other id, `read_memory_page` answers one with an
error result whose `details.code` is `INVALID_WIKI_PAGE_ID`, and a compile skips a
cluster assignment whose page id is refused and reports it in the result's
`conflicts`. A `WikiCompiler` run against the folder's own store also reports there a
page the file system refuses for its path, such as a name too long or a file where a
folder must be, and goes on with the other pages; any other failed write stops that
subject's compile, and the next compile takes up the same traces again. `isWikiPageId` tells whether an id
has this form. A file whose path makes no valid id, such as any file in a folder whose
name starts with a dot (`.meta/`, `.store/`), is not a page: the store does not list
or index it.

Both checks are on the path the id names, not on where a link leads. The store
follows a link inside `memory/` like any other file there, for reads and for writes:
what it points to, inside the folder or outside it, is part of the wiki, and a write
to a page that is a link (`WikiMemoryStore.writePage`) rewrites the file the link
points to. A compile writes no file under `memory/`. The store
never makes a link, and no page id makes one, so only whoever can write the folder
can add one. Let only people and tools you trust as much as the agent's own process
write to `memory/`, and check a `memory/` folder you did not make for links before an
agent uses it. A check on where links lead would refuse every link that points
outside the folder, which a wiki that links shared notes in on purpose relies on, so
the store does not check where links lead. The soul loader, which renders the memory
index of the system prompt from `index.md` and the page files and starts the folder,
follows no link: see [Loading a Soul](#loading-a-soul).

A legacy single-file `MEMORY.md` auto-migrates into `memory/index.md` on first load
and is left untouched on disk. The copied text sits between the markers
`<!-- migrated from MEMORY.md -->` and `<!-- end of MEMORY.md -->`, right under
the index's `# Memory Index` heading. An end marker that `MEMORY.md` itself
holds is copied as `<!-- end of MEMORY.md (quoted) -->`, so it closes no block.
When the wiki writes its catalog into `index.md`, it keeps that block and writes the catalog after it, so the text
stays in the system prompt. An `index.md` with the start marker and no end marker
(as earlier versions wrote it) is read as a block that runs to the end of the
file, and gets its end marker on the first catalog write. A start marker anywhere
else, such as in a page summary, opens no block, and an
`index.md` with no block is replaced by the catalog. The end marker itself stays
out of the system prompt, and out of the `wikiIndex` that `loadSoul()` and
`loadSoulSync()` return.

When the wiki refreshes its catalog, it reads `index.md` never through a symbolic
link and writes it whole, through a new file beside it and a rename, so a catalog
written by another agent on the same workspace at the same moment never finds it
half written. (`WikiMemoryStore.getCatalog()` is a plain read of `index.md` and
follows a link.) Where the platform refuses the new file or the rename (`EACCES`,
`EPERM`, `EBUSY`), the catalog is written into `index.md` in place instead, and a
refresh running at that moment can then read it half written. A symbolic link at
`index.md` is not read: the refresh replaces the link with the catalog file and
leaves the link's target as it is. An `index.md` the wiki cannot read for any
other reason is left as it is: the page write that would refresh it fails. A
compile writes each subject's pages as rows of the store and refreshes no catalog.

## SOUL.md Format

SOUL.md is markdown with YAML frontmatter. The frontmatter holds structured
config (HEXACO scores, voice, mood, hard limits) that maps to existing AgentOS
persona machinery. The body is prose placed at the head of the system prompt.
The frontmatter is read as data: a block marked as JavaScript (`---js`) gives
no fields and is never evaluated.

```markdown
---
name: Aria
agentId: support-bot
role: Customer support agent for Meridian SaaS

hexaco:
  honestyHumility: 0.85
  emotionality: 0.55
  extraversion: 0.70
  agreeableness: 0.85
  conscientiousness: 0.90
  openness: 0.65

voice:
  provider: elevenlabs
  voiceId: rachel-warm

defaultMood: helpful_engaged
allowedMoods:
  - helpful_engaged
  - empathetic
  - focused

hardLimits:
  - Never share internal pricing formulas
  - Always recommend human review for refunds over €100
---

## Who You Are

You are Aria, the customer support agent for Meridian SaaS.

## Tone

Direct, friendly, patient. Never condescending.

## How You Help

You teach first and recommend a human handoff when an issue
exceeds your scope.
```

A starter template ships at [`src/cognition/substrate/personas/SOUL.template.md`](../src/cognition/substrate/personas/SOUL.template.md).

## Loading a Soul

```ts
import { agent } from '@framers/agentos';

// agent() loads the workspace: SOUL.md opens the system prompt, STYLE.md and
// the memory index follow it.
const aria = agent({ provider: 'anthropic', soul: '~/.agentos/agents/aria' });

const reply = await aria.session('customer-42').send('I need help with my invoice.');
console.log(reply.text);
```

Every path applies the front matter through one mapping. `agent()` and `souledAgent()` render the hard limits, the `hexaco` trait paragraph and the name; `gmi()` builds its persona from the id, name, role, traits, mood, reasoning-trace limits and hard limits; and the full runtime takes the whole `personaDefinition` that `loadSoul()` returns:

```ts
import { loadSoul } from '@framers/agentos/cognition/substrate/personas/SoulLoader';
import { AgentOS } from '@framers/agentos';

const soul = await loadSoul({ source: '~/.agentos/agents/aria' });
const agentos = await AgentOS.create({ personas: [soul.personaDefinition] });
```

`loadSoul` accepts either a workspace directory or a direct file path:

```ts
// Directory: reads SOUL.md, STYLE.md, IDENTITY.md, AGENTS.md and MEMORY.md
await loadSoul({ source: '~/.agentos/agents/aria' });

// Direct file: reads that file as SOUL.md and the companion files beside it
await loadSoul({ source: '~/.agentos/agents/aria/SOUL.md' });

// Inline: for tests and ephemeral agents
import { parseSoul } from '@framers/agentos/cognition/substrate/personas/SoulLoader';
const inline = parseSoul(`---\nname: Tester\n---\nYou are a test agent.`);
```

Both file forms create `memory/` beside SOUL.md (seeding `memory/index.md` from a legacy `MEMORY.md`) when it does not exist.

The loader reads the soul's files (SOUL.md, STYLE.md, IDENTITY.md, AGENTS.md, MEMORY.md, `memory/index.md` and each page file under `memory/`, which it reads to render the memory index) never through a symbolic link at the soul's folder or below it, never waiting, and only when each is a regular file. A file that is a link, or a named pipe or anything else that is not a regular file, is skipped with a warning; a skipped SOUL.md throws as a missing one does, unless `requireSoul` is `false`. The soul's folder itself may not be a link; the folder that holds it may. When the loader starts `memory/`, it makes `memory/` and `memory/.meta/` one folder at a time and `memory/index.md` and `memory/.meta/index.json` only where nothing is, so it writes through no link and opens no file already there. A link or anything else that is not a folder in the place of `memory/` or `memory/.meta/`, or a link or anything else that is not a regular file in the place of `memory/index.md`, `memory/.meta/index.json` or `MEMORY.md`, is left as it is, with a warning, and nothing is made through it or in it.

## What Applies on Each Path

What a soul gives an agent depends on how it is loaded:

| Path | Soul prose and style in the prompt | Index of the operator's pages in the prompt | Front matter applied (traits, mood, hard limits, `agentId`) | Recall each turn (a data block in a user-role message) | `read_memory_page` tool | Wiki compiled |
|---|---|---|---|---|---|---|
| `agent({ soul })` | Yes | Yes | Hard limits as the last block of the system prompt; the `hexaco` paragraph unless `personality` is set; the soul's `name` unless `name` is set. Mood, voice, avatar and reasoning-trace limits have no renderer here | No (only from a `memoryProvider` you pass) | No | No |
| `souledAgent()` | Yes | Yes | As `agent({ soul })`; the soul's id (`agentId`, else the slug of its `name`, which for a name with no Latin letters or digits is `agent-` and a hash of the name, else the agent's `name`) scopes the wiki's traces, and a soul with none of the three is rejected | Yes, per subject: the memory of the turn's subject (the session's `userId`, else the session) and the operator's pages, from the wiki's store | Yes: the asker's own pages and the operator's | Yes, per subject, into the store: on `close()` for the subjects its turns wrote to, and by `agent.memory.compileWiki()` |
| `agent({ runtime: 'gmi', soul })`, `gmi({ soul })` | Yes | Yes | The persona's id, name, role, traits, mood, reasoning-trace limits and hard limits, the limits as the last block; `voice` and `avatar` are left out with one log line | With cognitive memory on, from cognitive memory; off, only from a `memoryProvider` you pass | No | No |
| `souledAgent({ runtime: 'gmi' })`, cognitive memory off | Yes | Yes | As `gmi({ soul })`; one id for the persona and the wiki | Yes, per subject, from the wiki's store | Yes: the asker's own pages and the operator's | Yes, per subject, into the store |
| `souledAgent({ runtime: 'gmi' })`, cognitive memory on | Yes | Yes | As the row above | From cognitive memory; the wiki store's recall is skipped, with a warning, and its turns are still stored, each under its subject | Yes: the asker's own pages and the operator's, and the listing (`{ "list": true }`) is how a user reaches their own | Yes, per subject, into the store |
| The full runtime given `loadSoul().personaDefinition` | Yes (the persona's `baseSystemPrompt`) | No | Yes, every field | From the runtime's own memory, when configured; not from the wiki | No | No |

The exceptions:

- `systemBlocks` replace the prompt the agent assembles, so an agent given a soul and `systemBlocks` has none of the soul's prose, style or memory index in its prompt; the build says so in one `console.warn` line. The hard limits still close the prompt, as one more block after yours with no cache breakpoint of its own. A souled agent in that state still records its turns into the wiki.
- A named tool map (an object, not an array) is passed through as given, without `read_memory_page`.
- An inline soul (`{ content }`) has no workspace folder: `souledAgent()` builds a plain `agent()` with no wiki memory, no `read_memory_page` tool and no compile, and says so in one `console.warn` line.
- One-shot `generate()` and `stream()` on a GMI run the light profile, so they use the memory provider's recall, the wiki store's on a souled agent, even when sessions run with cognitive memory on. On a souled agent a one-shot call names no user: nothing is filed for it and it recalls the operator's pages alone, unless `sharedMemory` runs it as one user.
- A seat of a launched team uses neither memory hook (no recall from the provider, nothing stored with it) and is refused the memory tools, `read_memory_page` among them.
- `souledAgent()`'s `memoryPolicy`, `screen` and `sharedMemory` act on the wiki's store alone, so a souled agent with cognitive memory on is refused any of them at its open: its GMI files and recalls in a store of its own that none of them reaches.
- A souled agent's memory is kept apart per subject on every path this page tables: recall, the page tool, the compile and the store's own reads take one subject's key and match it by equality. The agent's export (`exportAgentConfig`) carries its configuration and no trace and no page.
- A `memoryProvider`'s recall is sent as a `<memory_recall>` block of JSON in a user-role message before the turn's own, each text datamarked, with one static line of the system prompt that says it is data. It is never a system message, so the hard limits stay the last system text. The framing lowers the chance that a stored sentence is followed as an instruction; it does not remove it. Cognitive memory's own block is rendered by the GMI and is not this block.
- `agent.session(id, { userId })` scopes what the hooks and the tools are told on both runtimes: the user id, else the session id (an anonymous id such as `system`, `anonymous` or `guest`, or one `learning.anonymousUserIds` lists, counts as none). One session is one user; for a conversation several people share, pass one id for the group. On a souled agent that subject is the key the turn's memory is filed and recalled under, so two users, or two sessions that name none, never read each other's.
- Hard limits are a block of prompt text every path renders last, after `systemBlocks` too, with one exception: the plan of a call with `planning` on is a system message after the limits. A memory provider's recall (the wiki's recall on a souled agent) is a data block in a user-role message, never a system message. It tells the model; it is not a check that enforces the limits.
- A `personality` or `name` option set in code wins over the soul's `hexaco` and `name`. The id is the exception: the soul's `agentId` wins over the agent's `name`, since the id keys the agent's memory and must not move when the agent is renamed.
- `gmi()` accepts guardrails, RAG and approval settings without applying them, and says so in one warning line at construction.
- A soul that fails to load throws `SoulLoadError` when the agent is built, unless it is given as `{ path, optional: true }` or `{ content, optional: true }`.
- On the full runtime, the trait paragraph from the `hexaco:` scores reaches the prompt with or without a learning layer; with one, the layer prepares it each turn ([GMI.md](./GMI.md#learning)).

## Loading Order at Agent Boot

1. **SOUL.md** → the first section of the system prompt (the "character sheet")
2. **STYLE.md** → a `## Style` section after it
3. **memory/index.md** → a "Long-Term Memory (index)" section, when the index holds more than its heading; a legacy **MEMORY.md** seeds it on first load
4. `instructions`, `name`, `personality` and `skills` from the agent options follow
5. **IDENTITY.md** and **AGENTS.md** → returned on the loaded soul (`identityContent`, `agentsContent`); nothing in the runtime reads them
6. **examples/** → not read

## HEXACO + AgentOS Persona Machinery

The `hexaco:` block in SOUL.md frontmatter maps directly to AgentOS's existing
[HEXACO personality model](./memory/HEXACO_PERSONALITY.md). The scores land in
`personaDefinition.personalityTraits`. On the full runtime they are the GMI's traits, and their trait paragraph is part of its system prompt:

- [`AdaptPersonalityTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts): with `emergentConfig.selfImprovement.enabled`, changes a trait for the session's GMI within a per-session budget
- [`PersonalityMutationStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/PersonalityMutationStore.ts): records those changes when a storage adapter is configured
- [`PersonaOverlayManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/persona_overlays/PersonaOverlayManager.ts): patches traits and mood when a workflow agency's persona evolution rules fire

`agent({ soul })` renders the scores as its trait paragraph unless `personality` is set, which wins. `PersonaDriftMechanism` works from the traits a cognitive memory manager is configured with.

Loaded personas store Honesty-Humility as `personalityTraits.honesty`, the key
that `agent({ personality })`, `AdaptPersonalityTool`, and the memory system read.
The frontmatter accepts either `honestyHumility` or `honesty`; when both are set,
`honesty` wins. `renderSoulMarkdown` writes the trait back as `honestyHumility`,
so a render-then-load round trip keeps every score.

All existing persona surfaces (mood adaptation, voice routing, avatar generation)
work identically whether the persona was loaded from JSON or from SOUL.md.

## Migrating from JSON Personas

The legacy [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) JSON format works alongside SOUL.md: they
both produce the same [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) runtime object. To migrate:

```ts
import { renderSoulMarkdown } from '@framers/agentos/cognition/substrate/personas/SoulLoader';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const persona = JSON.parse(await fs.readFile('legacy-persona.json', 'utf-8'));
const dir = path.join(os.homedir(), '.agentos', 'agents', 'migrated');
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, 'SOUL.md'), renderSoulMarkdown(persona));
```

The renderer writes the name, id (as `agentId`), description (as `role`), HEXACO
traits, voice, mood defaults, reasoning-trace limits, hard limits, avatar and
metadata to the frontmatter, and `baseSystemPrompt` as the body. Other fields
(model defaults, metaprompts, sentiment tracking, tools, contextual elements) are
not written. A persona with none of the written fields has no frontmatter to
write; when its prompt opens with three dashes that a fourth does not follow,
which the loader would read as the start of a frontmatter block, the renderer
puts an empty frontmatter block (two lines of `---`) in front of it, so that the
loader reads the whole prompt as the body.

## Cross-Framework Compatibility

SOUL.md files are plain markdown. Any agent runtime that reads files can embody
the same identity. For example:

- **OpenClaw**: same workspace convention
- **OpenSouls Soul Engine**: Tanaki and similar agents accept SOUL.md as input
- **LangChain / CrewAI / Mastra**: pass `soulContent` as system prompt
- **Claude Code, OpenCode, Codex, Goose**: point the agent at the workspace folder

Cross-model calibration tip: run the same prompts through both a strong model
(Claude Opus, GPT-4) and a cheap one (GPT-4o-mini, Llama). Where the cheap
model drifts off-character, your SOUL.md is too vague: tighten those sections
and re-test.

## What Goes Where

| In SOUL.md | In AGENTS.md | In USER.md (caller) | In MEMORY.md |
|---|---|---|---|
| "You are Aria, a support agent" | "Every session: read MEMORY.md for known patterns" | "User: Roberto, Bali timezone, prefers concise" | "Bug X reported 3× this week" |
| "Tone: direct, friendly, patient" | "Ticket workflow: greet, confirm, resolve or escalate" | "User has refund authority up to €50" | "User mentioned moving to Postgres next month" |
| "Never share internal pricing" | "Memory rules: log resolved tickets with outcome" | | "Server migration scheduled for March 15" |

A common mistake is dumping procedural rules into SOUL.md. SOUL.md describes who
the agent IS; AGENTS.md describes what the agent DOES.

## Reference

- [SoulLoader source](../src/cognition/substrate/personas/SoulLoader.ts)
- [SOUL.template.md](../src/cognition/substrate/personas/SOUL.template.md)
- [aaronjmars/soul.md spec](https://github.com/aaronjmars/soul.md)
- [OpenClaw workspace files explained](https://capodieci.medium.com/ai-agents-003-openclaw-workspace-files-explained-soul-md-agents-md-heartbeat-md-and-more-5bdfbee4827a)
- [HEXACO Personality model in AgentOS](./memory/HEXACO_PERSONALITY.md)
