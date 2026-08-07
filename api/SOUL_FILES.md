# Soul Files & the Markdown Memory Wiki

AgentOS supports a markdown-based identity convention for agents, modeled after
the OpenClaw workspace pattern and the [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)
spec. Identity, voice, procedural rules, and long-term memory all live in plain
markdown files inside a per-agent workspace directory. The runtime loads them at
boot, parses YAML frontmatter into structured [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) fields, and
injects the prose as system messages.

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
├── IDENTITY.md   display card: name, role, agent-ID, avatar   (optional, derived from SOUL frontmatter when absent)
├── AGENTS.md     procedural rules: workflows, file access     (optional)
├── memory/       long-term memory wiki: index.md + entities/ + concepts/ + log/  (auto-managed)
└── examples/     good-outputs.md + bad-outputs.md             (optional)
```

| File | What it controls | What happens if you skip it |
|---|---|---|
| **SOUL.md** | Personality, values, tone, behavioral boundaries | Agent runs as a generic LLM with no character |
| **STYLE.md** | Voice patterns, vocabulary, register | Default style from `SOUL.md` body only |
| **IDENTITY.md** | Display card: name, role, agent-ID, avatar | Derived from SOUL.md frontmatter |
| **AGENTS.md** | Procedural rules, session-start checks, workflow steps | No proactive behavior; manual triggers only |
| **memory/** | Long-term memory wiki (markdown pages the agent compiles and reads) | Cold start every session |
| **examples/** | Good/bad output calibration for emergent training | No automated voice calibration |

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
rather than clobbering human edits; git versions every change.

A legacy single-file `MEMORY.md` auto-migrates into `memory/index.md` on first load
and is left untouched on disk.

## SOUL.md Format

SOUL.md is markdown with YAML frontmatter. The frontmatter holds structured
config (HEXACO scores, voice, mood, hard limits) that maps to existing AgentOS
persona machinery. The body is prose injected as the first system message.

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

A starter template ships at [`packages/agentos/src/cognition/substrate/personas/SOUL.template.md`](../src/cognition/substrate/personas/SOUL.template.md).

## Loading a Soul

```ts
import { loadSoul } from '@framers/agentos/cognition/substrate/personas/SoulLoader';
import { agent } from '@framers/agentos';

const soul = await loadSoul({ source: '~/.agentos/agents/aria' });

const aria = agent({
  provider: 'anthropic',
  instructions: soul.soulContent,    // SOUL.md prose as system prompt
  persona: soul.personaDefinition,    // structured fields (HEXACO, voice, mood, hardLimits)
});

await aria.send('I need help with my invoice.');
```

`loadSoul` accepts either a workspace directory or a direct file path:

```ts
// Directory: scans all 6 standard files
await loadSoul({ source: '~/.agentos/agents/aria' });

// Direct file: loads SOUL.md only
await loadSoul({ source: '~/.agentos/agents/aria/SOUL.md' });

// Inline: for tests and ephemeral agents
const soulMarkdown = `---\nname: Tester\n---\nYou are a test agent.`;
// ... write to temp file then loadSoul; or use IPersonaDefinition directly
```

## Loading Order at Agent Boot

1. **SOUL.md** → first system message (the "character sheet")
2. **STYLE.md** → second system message (appended)
3. **IDENTITY.md** → display surfaces (UI, multi-agent routing)
4. **AGENTS.md** → session-start procedures and workflow rules
5. **MEMORY.md** → seeded into long-term memory store
6. **examples/** → fed to emergent calibration (when enabled)

## HEXACO + AgentOS Persona Machinery

The `hexaco:` block in SOUL.md frontmatter maps directly to AgentOS's existing
[HEXACO personality model](./HEXACO_PERSONALITY.md). The same six-trait scores
flow into:

- `PersonaDriftMechanism`: long-term trait drift across sessions
- [`PersonalityMutationStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts): per-trait mutation history
- [`AdaptPersonalityTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/AdaptPersonalityTool.ts): runtime personality adjustment via emergent capabilities
- [`PersonaOverlayManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/persona_overlays/PersonaOverlayManager.ts): mood-based system-prompt overlays

All existing persona surfaces (mood adaptation, voice routing, avatar generation)
work identically whether the persona was loaded from JSON or from SOUL.md.

## Migrating from JSON Personas

The legacy [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) JSON format works alongside SOUL.md: they
both produce the same [`IPersonaDefinition`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/personas/IPersonaDefinition.ts) runtime object. To migrate:

```ts
import { renderSoulMarkdown } from '@framers/agentos/cognition/substrate/personas/SoulLoader';
import * as fs from 'node:fs/promises';

const persona = JSON.parse(await fs.readFile('legacy-persona.json', 'utf-8'));
const soulMarkdown = renderSoulMarkdown(persona);
await fs.writeFile('~/.agentos/agents/migrated/SOUL.md', soulMarkdown);
```

The renderer preserves all structured fields in YAML frontmatter and uses
`baseSystemPrompt` as the markdown body.

## Cross-Framework Compatibility

SOUL.md files are plain markdown. Any agent runtime that reads files can embody
the same identity. Tested compatible:

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
- [HEXACO Personality model in AgentOS](./HEXACO_PERSONALITY.md)
