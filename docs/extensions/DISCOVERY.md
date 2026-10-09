# Capability Discovery — Token-Efficient Tool Context

> Per-turn semantic retrieval of tools, skills, extensions and channels, held to token budgets, in place of a static dump of every schema.

---

## Table of Contents

1. [Overview](#overview)
2. [Three-Tier Context Model](#three-tier-context-model)
3. [CapabilityDescriptor](#capabilitydescriptor)
4. [CapabilityGraph Relationships](#capabilitygraph-relationships)
5. [CAPABILITY.yaml Format](#capabilityyaml-format)
6. [Agent Self-Discovery via Meta-Tool](#agent-self-discovery-via-meta-tool)
7. [Integration with the Prompt](#integration-with-the-prompt)
8. [Configuration](#configuration)

---

## Overview

Putting every tool schema into the system prompt grows the prompt with each tool, skill and channel, and the model reads all of it on every turn, most of it irrelevant to the turn. This is **context rot**: output quality degrades as irrelevant context accumulates.

The Capability Discovery Engine builds each turn's capability context from the user's message instead:

```
User message
    ↓
CapabilityIndex.search(userMessage)            // semantic vector search
    ↓
CapabilityGraph.rerank(results)                // boost related capabilities via graph
    ↓
CapabilityContextAssembler.assemble(reranked)  // token-budgeted tier assembly
    ↓
CapabilityDiscoveryResult → system prompt
```

| Tier | Default budget | Content |
|------|----------------|---------|
| Tier 0 | 200 tokens | Category summaries, on every turn |
| Tier 1 | 800 tokens | Top-5 capability summaries for this turn |
| Tier 2 | 2,000 tokens | Full schema or skill content for the top 2 |
| Total | at most 3,000 tokens | |

The assembler counts four characters as one token.

---

## Three-Tier Context Model

### Tier 0 — Always in Context

Category summaries, grouped by each capability's `category`, largest group first, with the first four names of each. The text is cached and rebuilt only when the index changes.

```
Available capability categories:
- Communication: telegram, discord, slack, whatsapp (+16 more) (20)
- Information: web-search, news-search, web-browser (3)
- Developer-tools: github, git, cli-executor (3)
Use discover_capabilities tool to get details on any capability.
Use load_capability_extension to activate a loadable curated extension at runtime.
```

### Tier 1 — Semantic Matches

The top 5 capabilities by similarity to the user's message (relevance at least 0.3), as one-line summaries without schemas.

```
Relevant capabilities:
1. web-search (tool). Search the web for current information. Params: query, max_results
2. news-search (tool). Search news articles by keyword. Params: query, date_range
3. web-browser (tool). Browse a URL and extract content. Params: url, selector
4. github (skill). Use the GitHub CLI for issues, PRs, repos. Requires: gh
5. summarizer (skill). Summarize long documents into key points
```

### Tier 2 — Full Details

The full input schema of a tool, or the `SKILL.md` content of a skill, for the top 2 of Tier 1.

---

## CapabilityDescriptor

The unified shape that normalizes tools, skills, extensions, channels and manifest entries into one searchable type:

```typescript
import type { CapabilityDescriptor } from '@framers/agentos/discovery';

const descriptor: CapabilityDescriptor = {
  // Identity
  id:          'tool:web-search',       // "${kind}:${name}"
  kind:        'tool',
  name:        'web-search',
  displayName: 'Web Search',

  // For embedding: describes when and why to use it
  description: 'Search the web for current information, news, and facts. Use when the answer requires up-to-date information not in training data.',

  // Classification
  category: 'information',
  tags:     ['search', 'web', 'real-time'],

  // Requirements
  requiredSecrets: ['SERPER_API_KEY'],
  requiredTools:   [],

  // State
  available: true,

  // Source reference (for lazy-loading the full schema)
  sourceRef: { type: 'tool', toolName: 'web_search' },

  // Tier 2 data: the tool's input schema
  fullSchema: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'Search query' },
      numResults: { type: 'number', default: 5 },
    },
    required: ['query'],
  },
};
```

`fullContent` holds a skill's `SKILL.md` text, and `hasSideEffects` is optional.

### Capability Kinds

`CapabilityKind` is `'tool' | 'skill' | 'extension' | 'channel' | 'voice' | 'productivity' | 'emergent-tool'`. The index builds `tool`, `skill`, `extension` and `channel` descriptors from its sources; a `CAPABILITY.yaml` manifest names its own kind.

| Kind | Examples |
|------|---------|
| `tool` | web_search, github_create_issue, send_email |
| `skill` | research-assistant, code-reviewer, linkedin-bot |
| `extension` | extension packs from the catalog |
| `channel` | telegram, discord, slack, whatsapp |
| `emergent-tool` | tools forged at run time |

---

## CapabilityGraph Relationships

The [`CapabilityGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/discovery/CapabilityGraph.ts) builds a graphology graph from the descriptors' metadata in `buildGraph()`; it has no API for adding edges by hand. Four edge types:

| Edge Type | Built from | Weight |
|-----------|------------|--------|
| `DEPENDS_ON` | a skill's `requiredTools` | 1.0 |
| `COMPOSED_WITH` | preset co-occurrences passed to `initialize()` | 0.5 |
| `TAGGED_WITH` | two or more shared tags | 0.3 per shared tag |
| `SAME_CATEGORY` | same kind and category, in groups of 2 to 8 | 0.1 |

Edges drive the **re-ranking** after the vector search: two results joined by an edge each gain `graphBoostFactor × weight`, and a capability linked to a result by `DEPENDS_ON` or `COMPOSED_WITH` joins the results with the score `parentScore × graphBoostFactor × weight`.

```typescript
import { CapabilityGraph } from '@framers/agentos/discovery';

const graph = new CapabilityGraph();
await graph.buildGraph(descriptors, [
  { presetName: 'research', capabilityIds: ['tool:web-search', 'skill:summarize'] },
]);

const related = graph.getRelated('tool:web-search');
// [{ id: 'skill:summarize', weight: 0.5, relationType: 'COMPOSED_WITH' }, ...] by weight
```

---

## CAPABILITY.yaml Format

Place a folder with a `CAPABILITY.yaml` (or `CAPABILITY.yml`) under `~/.wunderland/capabilities/`, `./.wunderland/capabilities/` or a directory in `$WUNDERLAND_CAPABILITY_DIRS` (colon-separated); [`CapabilityManifestScanner`](https://github.com/framerslab/agentos/blob/master/src/cognition/discovery/CapabilityManifestScanner.ts) reads those by default, `scan(dirs)` and `watch(dirs, onChange)` take your own list, and `watch()` reports changes after a 500 ms debounce. The runtime does not run the scanner: a host scans and passes the descriptors to `turnPlanning.discovery.sources.manifests` or to `refreshIndex({ manifests })`.

```yaml
# ~/.wunderland/capabilities/my-custom-search/CAPABILITY.yaml
id: tool:my-custom-search
kind: tool
name: my-custom-search
displayName: My Custom Search
description: Search our internal knowledge base for company-specific information. Use when the user asks about internal processes, policies, or documentation.
category: information
tags:
  - search
  - internal
  - knowledge-base
requiredSecrets:
  - MY_SEARCH_API_KEY
hasSideEffects: false
inputSchema: {"type": "object", "properties": {"query": {"type": "string"}, "department": {"type": "string", "enum": ["engineering", "product", "design", "finance", "hr"]}}, "required": ["query"]}
```

The fields read are `id`, `kind`, `name`, `displayName`, `description`, `category`, `tags`, `requiredSecrets`, `requiredTools`, `hasSideEffects`, `inputSchema` and `skillContent`. `name`, `kind` and `description` are required. `id` defaults to `${kind}:${name}`, `displayName` to the name and `category` to `custom`; a manifest capability is always `available`. The scanner reads a simple YAML subset: one-line scalars, lists (inline, or one indented `- item` per line), and objects written inline as JSON; folded (`>`) and nested block values are not read.

Optionally, place a `SKILL.md` alongside the YAML for full prompt content (or point `skillContent` at another file), and a `schema.json` for the input schema when `inputSchema` is not set:

```markdown
<!-- ~/.wunderland/capabilities/my-custom-search/SKILL.md -->
# My Custom Search Skill

You have access to the internal knowledge base search tool.

When answering questions about company policies or internal processes:
1. Search the knowledge base first
2. Cite the relevant policy document
3. If no results, say "I couldn't find that in our documentation"
```

---

## Agent Self-Discovery via Meta-Tool

The `discover_capabilities` meta-tool lets the agent search for capabilities during a conversation, when the passive tiers are not enough. Its input is `query` (required), `kind` (`tool`, `skill`, `extension`, `channel` or `any`, default `any`) and `category`; it returns `{ capabilities: [{ id, name, kind, description, category, relevance, available, ... }], totalIndexed }`.

The AgentOS runtime registers it, and `load_capability_extension`, when its turn planner builds the discovery engine ([Capability Discovery](./CAPABILITY_DISCOVERY.md#agentos-turn-planner-core-integration)). A host with its own tool orchestrator registers it itself:

```typescript
import {
  CapabilityDiscoveryEngine,
  createDiscoverCapabilitiesTool,
} from '@framers/agentos/discovery';

// embeddingManager and vectorStore come from your memory wiring; sources are your
// catalog entries in the CapabilityIndexSources shape.
const engine = new CapabilityDiscoveryEngine(embeddingManager, vectorStore);
await engine.initialize(sources);

// With the orchestrator, each result also says whether it is loadable at run time.
await toolOrchestrator.registerTool(createDiscoverCapabilitiesTool(engine, toolOrchestrator));
```

The agent uses the tool when it needs something the passive tiers did not surface:

```
User: "Can you post this announcement to our Slack and email the team?"

Agent calls: discover_capabilities({ query: "send email", kind: "tool" })

Response: { capabilities: [{ id: "tool:send_email", relevance: 0.86, ... }], totalIndexed: 66 }

Agent calls: send_email({ to: "team@example.com", subject: "...", body: "..." })
```

---

## Integration with the Prompt

On the AgentOS runtime the turn planner runs discovery before each GMI turn, and the rendered tiers reach the GMI in the turn's `metadata.capabilityDiscovery.promptContext`; the GMI adds them to the system prompt under the heading `Capability Discovery Context`. With `toolSelectionMode` `discovered`, the turn's tool list holds the discovered tools and the meta-tools. A host with its own loop renders the result itself:

```typescript
const result = await engine.discover(userMessage);
const capabilityContext = engine.renderForPrompt(result);   // text for the system prompt
const tools = await toolOrchestrator.listDiscoveredTools(result);
```

---

## Configuration

The engine's third constructor argument, or `turnPlanning.discovery.config` on the runtime, takes a partial `CapabilityDiscoveryConfig`; `discover(query, { config })` overrides it for one query.

```typescript
import { CapabilityDiscoveryEngine } from '@framers/agentos/discovery';

const engine = new CapabilityDiscoveryEngine(embeddingManager, vectorStore, {
  tier0TokenBudget: 200,          // category summaries (always)
  tier1TokenBudget: 800,          // semantic match summaries
  tier2TokenBudget: 2000,         // full schemas
  tier1TopK: 5,                   // summaries per turn
  tier2TopK: 2,                   // full schemas per turn
  tier1MinRelevance: 0.3,         // 0-1
  useGraphReranking: true,
  graphBoostFactor: 0.15,         // 0-1
  collectionName: 'capability_index',
});
```

The values shown are the defaults. Manifest hot-reload is the scanner's `watch()`, not an engine option.

---

## Related Guides

- [CAPABILITY_DISCOVERY.md](./CAPABILITY_DISCOVERY.md) — full architecture reference
- [TOOL_CALLING_AND_LOADING.md](./TOOL_CALLING_AND_LOADING.md) — registering and using tools
- [SKILLS.md](./SKILLS.md) — SKILL.md prompt modules and registration
- [RFC_EXTENSION_STANDARDS.md](./RFC_EXTENSION_STANDARDS.md) — extension packaging
