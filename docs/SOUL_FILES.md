# Soul Files & the Markdown Memory Wiki

AgentOS supports a markdown-based identity convention for agents, modeled after
the OpenClaw workspace pattern and the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)
spec. Identity, voice, procedural rules, and long-term memory all live in plain
markdown files inside a per-agent workspace directory. The loader parses YAML frontmatter into structured [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) fields, and
`agent({ soul })` puts the prose at the head of the system prompt.

The `memory/` directory is the agent's **LLM wiki**: a markdown knowledge base the agent reads and rewrites itself (the "LLM keeps a wiki" pattern). Markdown is the source of truth and the vector/graph index is rebuilt from it; [`souledAgent()`](https://docs.agentos.sh/getting-started/high-level-api) wires it end to end. Full detail in [The `memory/` Wiki](#the-memory-wiki) below.

![Soul file anatomy: a six-entry workspace (SOUL.md required; STYLE.md, IDENTITY.md, AGENTS.md and examples/ optional; the auto-managed memory/ wiki) that the loader reads when the agent is built, splitting SOUL.md into persona fields and the prose that opens the system prompt unless systemBlocks replace it; the agent renders the HEXACO traits as its trait paragraph, with mood on gmi and the full runtime, places the hard limits last in the system prompt, where only recalled memory or a plan follows them, and puts memory/index.md in the prompt; loadSoul() returns AGENTS.md and IDENTITY.md without applying them, and examples/ is not read](/img/diagrams/soul-files-anatomy.svg)

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
| **memory/** | Long-term memory wiki (markdown pages the agent compiles and reads) | `index.md` joins the system prompt; [`souledAgent()`](./getting-started/HIGH_LEVEL_API.md) wires the wiki end to end. Without it, each session starts cold. |
| **examples/** | Good/bad output calibration | Not read by the loader. |

The principle from OpenClaw: **personality in SOUL.md, procedures in AGENTS.md.**
Don't mix them.

## The `memory/` Wiki

Long-term memory is a directory of markdown pages: the **LLM wiki**. It is a knowledge
base the agent compiles from what it learns and reads back on demand. Markdown is the
source of truth, and the vector and graph index is rebuilt from it.

```
<agent-id>/memory/
├── index.md        catalog of every page, injected into the system prelude
├── entities/       one page per person, place, thing, or project
├── concepts/       one page per topic or fact-cluster
├── log/            append-only daily logs (log/YYYY-MM-DD.md)
└── .meta/          page hashes, backlinks, and the compile watermark
```

Pages are markdown with YAML frontmatter and `[[wikilinks]]`. The agent reads
`index.md` from its prelude, then opens any page with the `read_memory_page` tool.
The LLM folds new conversation into pages when memory consolidates: a
[`souledAgent`](getting-started/HIGH_LEVEL_API.md) runs this on the agent's `close()`,
and `agent.memory.compileWiki()` triggers it mid-session. Merges integrate new facts
rather than clobbering human edits, and each page written is dated with the time
of the compile. The runtime does not version the pages.

The traces a `souledAgent`'s own observer stores carry no entities, so the default
clusterer merges them into the page `concepts/notes`. Entity pages come from traces
stored with entities through `agent.memory.remember()`, or from a clusterer passed
to `attachMemoryWiki()`.

Each trace the observer stores records who spoke it in the trace's metadata
(`speaker: 'user'` or `speaker: 'assistant'`), outside its text and its tags, which
the store's full-text search reads, so recall never matches a trace by who spoke it.
The recall block a souled agent adds to a turn gives each trace one line that opens
with its speaker and the date it was stored, in the wording the memory block uses:
`[user, 26 days ago, 2026-10-14] I moved to Lisbon`. A chunk of a wiki page is
labelled `note` and its page id (`[note concepts/notes, 2d ago, 2026-11-07]`), and a
trace stored before speakers were recorded carries the date alone. A line break in a
trace's text is rendered as a space, so what someone said can never open a line of
the block with a label of its own. The block keeps to the turn's memory token budget,
whole lines first; when even the first line's label is larger than the budget, the
line is the trace's text alone.

A page the compiler creates gets a summary named from its page id, never copied from
a trace: `concepts/notes` is `Notes compiled from conversations`, and
`entities/johnny` is `Notes on johnny compiled from conversations`. That summary is
the page's line in `index.md`, and `index.md` joins the system prompt of every agent
built from the soul, so no sentence someone says in a conversation becomes a standing
line of that prompt. A page's id can still carry a name taken from the conversation:
the default clusterer names an entity page after the entity it found (`entities/johnny`),
and a custom clusterer may derive an id from a trace, so such a name stands in the
index, and in the prompt, as a page id. A page that has a summary
keeps it, whoever wrote it, and a compile rewrites no existing summary. An
`index.md` written by an earlier version may still carry a summary taken from the
first message folded into a page: open the page's file (`memory/concepts/notes.md`
for the notes page), set its `summary:` front matter to the line you want, and the
next compile writes that line into the catalog; or edit the line in `index.md`
directly, which the next catalog write replaces with the page's summary.

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
calls, and are written to its usage ledger under the source `souledAgent.compileWiki`. A call the budget refuses fails the compile, which
`close()` logs as any failed compile; the watermark stays where it was, so the next
compile takes the same traces up again.

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
`conflicts`. A compile also reports there a page the file system refuses for its
path, such as a name too long or a file where a folder must be, and goes on with the
other pages; any other failed write, such as on a full disk, stops the compile, and
the next compile takes up the same traces again. `isWikiPageId` tells whether an id
has this form. A file whose path makes no valid id, such as any file in a folder whose
name starts with a dot (`.meta/`, `.store/`), is not a page: the store does not list
or index it.

Both checks are on the path the id names, not on where a link leads. The store
follows a link inside `memory/` like any other file there, for reads and for writes:
what it points to, inside the folder or outside it, is part of the wiki, and a compile
that merges into a page that is a link rewrites the file the link points to. The store
never makes a link, and no page id makes one, so only whoever can write the folder
can add one. Let only people and tools you trust as much as the agent's own process
write to `memory/`, and check a `memory/` folder you did not make for links before an
agent uses it. A check on where links lead would refuse every link that points
outside the folder, which a wiki that links shared notes in on purpose relies on, so
the store does not check where links lead. The soul loader, which reads `index.md`
into the system prompt and starts the folder, follows no link: see
[Loading a Soul](#loading-a-soul).

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
other reason is left as it is: the page write that would refresh it fails, and so
does the compile, which takes the same traces up again the next time.

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
// memory/index.md follow it.
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

The loader reads the soul's files (SOUL.md, STYLE.md, IDENTITY.md, AGENTS.md, MEMORY.md and `memory/index.md`) never through a symbolic link at the soul's folder or below it, never waiting, and only when each is a regular file. A file that is a link, or a named pipe or anything else that is not a regular file, is skipped with a warning; a skipped SOUL.md throws as a missing one does, unless `requireSoul` is `false`. The soul's folder itself may not be a link; the folder that holds it may. When the loader starts `memory/`, it makes `memory/` and `memory/.meta/` one folder at a time and `memory/index.md` and `memory/.meta/index.json` only where nothing is, so it writes through no link and opens no file already there. A link or anything else that is not a folder in the place of `memory/` or `memory/.meta/`, or a link or anything else that is not a regular file in the place of `memory/index.md`, `memory/.meta/index.json` or `MEMORY.md`, is left as it is, with a warning, and nothing is made through it or in it.

## What Applies on Each Path

What a soul gives an agent depends on how it is loaded:

| Path | Soul prose and style in the prompt | Memory index in the prompt | Front matter applied (traits, mood, hard limits, `agentId`) | A recall block each turn | `read_memory_page` tool | Wiki compiled |
|---|---|---|---|---|---|---|
| `agent({ soul })` | Yes | Yes | Hard limits as the last block of the system prompt; the `hexaco` paragraph unless `personality` is set; the soul's `name` unless `name` is set. Mood, voice, avatar and reasoning-trace limits have no renderer here | No (only from a `memoryProvider` you pass) | No | No |
| `souledAgent()` | Yes | Yes | As `agent({ soul })`; the soul's id (`agentId`, else the slug of its `name`, which for a name with no Latin letters or digits is `agent-` and a hash of the name, else the agent's `name`) scopes the wiki's traces, and a soul with none of the three is rejected | Yes, from the wiki's store | Yes | Yes, on `close()` and by `agent.memory.compileWiki()` |
| `agent({ runtime: 'gmi', soul })`, `gmi({ soul })` | Yes | Yes | The persona's id, name, role, traits, mood, reasoning-trace limits and hard limits, the limits as the last block; `voice` and `avatar` are left out with one log line | With cognitive memory on, from cognitive memory; off, only from a `memoryProvider` you pass | No | No |
| `souledAgent({ runtime: 'gmi' })`, cognitive memory off | Yes | Yes | As `gmi({ soul })`; one id for the persona and the wiki | Yes, from the wiki's store | Yes | Yes |
| `souledAgent({ runtime: 'gmi' })`, cognitive memory on | Yes | Yes | As the row above | From cognitive memory; the wiki store's recall is skipped, with a warning, and its turns are still stored | Yes | Yes |
| The full runtime given `loadSoul().personaDefinition` | Yes (the persona's `baseSystemPrompt`) | No | Yes, every field | From the runtime's own memory, when configured; not from the wiki | No | No |

The exceptions:

- `systemBlocks` replace the prompt the agent assembles, so an agent given a soul and `systemBlocks` has none of the soul's prose, style or memory index in its prompt; the build says so in one `console.warn` line. The hard limits still close the prompt, as one more block after yours with no cache breakpoint of its own. A souled agent in that state still records its turns into the wiki.
- A named tool map (an object, not an array) is passed through as given, without `read_memory_page`.
- An inline soul (`{ content }`) has no workspace folder: `souledAgent()` builds a plain `agent()` with no wiki memory, no `read_memory_page` tool and no compile, and says so in one `console.warn` line.
- One-shot `generate()` and `stream()` on a GMI run the light profile, so they use the memory provider's recall, the wiki store's on a souled agent, even when sessions run with cognitive memory on.
- A seat of a launched team uses neither memory hook (no recall from the provider, nothing stored with it) and is refused the memory tools, `read_memory_page` among them.
- Hard limits are a block of prompt text every path renders last, after `systemBlocks` too, with one exception: on a turn where a memory provider's `getContext` returns text (the wiki's recall on a souled agent), that text is a system message after the limits, and so is the plan of a call with `planning` on. It tells the model; it is not a check that enforces the limits.
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
