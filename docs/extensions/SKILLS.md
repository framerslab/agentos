# Skills (SKILL.md)

AgentOS supports **skills**: modular prompt modules defined by a `SKILL.md` file.

Skills are intended to complement tools/extensions:

- **Tools** are atomic operations ([`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts)) that the runtime can execute.
- **Skills** are higher-level instructions/workflows injected into the agent’s prompt.

## File format

Each skill lives in its own folder containing `SKILL.md`:

```md
---
name: github
description: Use the GitHub CLI (gh) for issues, PRs, and repos.
metadata:
  agentos:
    emoji: "🐙"
    primaryEnv: GITHUB_TOKEN
    requires:
      bins: ["gh"]
    install:
      - id: brew
        kind: brew
        formula: gh
        bins: ["gh"]
---

# GitHub (gh CLI)

Use the `gh` CLI to interact with GitHub repositories.
```

## Runtime API

Load skills from one or more directories:

```ts
import { SkillRegistry } from '@framers/agentos/cognition/skills';

const registry = new SkillRegistry();
await registry.loadFromDirs(['./skills']);

const snapshot = registry.buildSnapshot({ platform: process.platform });
console.log(snapshot.prompt);
```

Source: [`SkillRegistry`](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts), [`SkillLoader`](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillLoader.ts).

## Curated registry (optional)

- [`@framers/agentos-skills-registry`](https://github.com/framerslab/agentos-skills-registry) — catalog SDK with typed query helpers and snapshot factories
- [`@framers/agentos-skills`](https://github.com/framerslab/agentos-skills) — 88 curated SKILL.md files + [`registry.json`](https://github.com/framerslab/agentos-skills/blob/master/registry.json)

The curated content holds **88 skills** spanning developer tools, productivity, information, communication, memory, social media, and voice. See [`@framers/agentos-skills/registry.json`](https://github.com/framerslab/agentos-skills/blob/master/registry.json) for the canonical list and [`registry/curated/`](https://github.com/framerslab/agentos-skills/tree/master/registry/curated) for the SKILL.md content.

[`@framers/agentos-skills-registry`](https://github.com/framerslab/agentos-skills-registry) supports two usage modes:

- Lightweight catalog queries (no `@framers/agentos` peer dependency)
- Factory helpers that **lazy-load** [`@framers/agentos/cognition/skills`](https://github.com/framerslab/agentos/tree/master/src/cognition/skills) only when called (to build a [`SkillRegistry`](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts) or snapshot)

Agents can discover curated skills via the **Capability Discovery Engine** (`@framers/agentos/discovery`), which indexes them as [`CapabilityDescriptor`](https://github.com/framerslab/agentos/blob/master/src/cognition/discovery/types.ts) entries with `kind: 'skill'`. The `skills_list`, `skills_read`, `skills_enable`, `skills_status` and `skills_install` tools come from the `@framers/agentos-ext-skills` extension pack, not from [`SkillRegistry`](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts), which loads skills and builds the prompt snapshot. Curated skill content (the SKILL.md files) ships in [`@framers/agentos-skills`](https://github.com/framerslab/agentos-skills).

## Agentic discovery

Skills are discoverable at runtime via:

- [`@framers/agentos/cognition/skills`](https://github.com/framerslab/agentos/tree/master/src/cognition/skills) — the engine: [`SkillRegistry`](https://github.com/framerslab/agentos/blob/master/src/cognition/skills/SkillRegistry.ts) loads SKILL.md folders and builds the prompt snapshot.
- `@framers/agentos-ext-skills` — the extension pack with the `skills_list`, `skills_read`, `skills_enable`, `skills_status` and `skills_install` tools.
- [`@framers/agentos-skills`](https://github.com/framerslab/agentos-skills) — the content package (88 SKILL.md files + [`registry.json`](https://github.com/framerslab/agentos-skills/blob/master/registry.json)).
- [`@framers/agentos-skills-registry`](https://github.com/framerslab/agentos-skills-registry) — catalog SDK with typed query helpers and snapshot factories.
