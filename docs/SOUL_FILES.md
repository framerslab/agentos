# Soul Files & the Markdown Memory Wiki

AgentOS supports a markdown-based identity convention for agents, modeled after
the OpenClaw workspace pattern and the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)
spec. Identity, voice, procedural rules, and long-term memory all live in plain
markdown files inside a per-agent workspace directory. The loader parses YAML frontmatter into structured [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) fields, and
`agent({ soul })` puts the prose at the head of the system prompt.

The `memory/` directory is the agent's **LLM wiki**: a markdown knowledge base the agent reads and rewrites itself (the "LLM keeps a wiki" pattern). Markdown is the source of truth and the vector/graph index is rebuilt from it; [`souledAgent()`](https://docs.agentos.sh/getting-started/high-level-api) wires it end to end. Full detail in [The `memory/` Wiki](#the-memory-wiki) below.

![Soul file anatomy: six-file workspace (SOUL.md required, STYLE/IDENTITY/AGENTS/MEMORY/examples optional) loads at boot into structured persona fields and a prose system prelude, resolving per-turn to a persona card, behavioral rules, persistent memory, and output calibration](/img/diagrams/soul-files-anatomy.svg)

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
| **SOUL.md** | Personality, values, tone, behavioral boundaries | The body opens the system prompt; the frontmatter becomes `personaDefinition`. Without it, `loadSoul()` throws and `agent({ soul })` boots without a soul. |
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
rather than clobbering human edits. The runtime does not version the pages.

A legacy single-file `MEMORY.md` auto-migrates into `memory/index.md` on first load
and is left untouched on disk.

## SOUL.md Format

SOUL.md is markdown with YAML frontmatter. The frontmatter holds structured
config (HEXACO scores, voice, mood, hard limits) that maps to existing AgentOS
persona machinery. The body is prose placed at the head of the system prompt.

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

`agent()` uses the prose; the structured fields (HEXACO scores, voice, mood, hard limits) live on the `personaDefinition` that `loadSoul()` returns, which the full runtime takes as a persona:

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
`personaDefinition.personalityTraits`. On the full runtime they are the GMI's traits:

- [`AdaptPersonalityTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts): with `emergentConfig.selfImprovement.enabled`, changes a trait for the session's GMI within a per-session budget
- [`PersonalityMutationStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/PersonalityMutationStore.ts): records those changes when a storage adapter is configured
- [`PersonaOverlayManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/persona_overlays/PersonaOverlayManager.ts): patches traits and mood when a workflow agency's persona evolution rules fire

`agent({ soul })` does not read the scores; pass `personality` for its trait paragraph. `PersonaDriftMechanism` works from the traits a cognitive memory manager is configured with.

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
not written.

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
