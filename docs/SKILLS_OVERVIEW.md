# Skills Overview

Skills are prompt-level capability modules for AgentOS. They are not runtime extensions; they teach an agent when and how to use tools, workflows, and external systems through [`SKILL.md`](https://github.com/framersai/agentos-skills/tree/master/registry/curated) content.

## The 3-Tier Skills Architecture

AgentOS skills are split into three public layers, each in its own GitHub repository:

1. [`@framers/agentos/cognition/skills`](https://github.com/framersai/agentos/tree/master/src/cognition/skills)
   The runtime engine. This is where [`SkillLoader`](https://github.com/framersai/agentos/blob/master/src/cognition/skills/SkillLoader.ts), [`SkillRegistry`](https://github.com/framersai/agentos/blob/master/src/cognition/skills/SkillRegistry.ts), snapshots, and [path helpers](https://github.com/framersai/agentos/blob/master/src/cognition/skills/paths.ts) live.
2. [`@framers/agentos-skills`](https://github.com/framersai/agentos-skills)
   The curated content package. It ships [`SKILL.md` files](https://github.com/framersai/agentos-skills/tree/master/registry/curated) plus the generated [`registry.json`](https://github.com/framersai/agentos-skills/blob/master/registry.json) index.
3. [`@framers/agentos-skills-registry`](https://github.com/framersai/agentos-skills-registry)
   The catalog SDK. It provides query helpers, lazy loading, and factories over the curated content package.

## Start Here

- Use [Skills (SKILL.md)](./extensions/SKILLS.md) to author and structure skills.
- Use [`@framers/agentos-skills`](https://github.com/framersai/agentos-skills) when you need the curated content pack.
- Use [`@framers/agentos-skills-registry`](/skills/agentos-skills-registry) when you need catalog search, lazy loading, or factories.

## Skills vs Extensions

- Extensions are runtime code: tools, guardrails, workflows, and providers.
- Skills are prompt content: they explain operating procedures, decision rules, and tool-usage patterns to the model.

Both can participate in discovery, but they solve different layers of the system.
