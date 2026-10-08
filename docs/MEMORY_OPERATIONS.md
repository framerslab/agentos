---
title: Memory Operations
description: How agents read, write, and serialize their own memory — auto-ingest pipeline, 6 agent-facing memory tools, and import/export across 6 formats (SQLite, JSON, Markdown, Obsidian, ChatGPT, CSV).
keywords:
  - agent memory operations
  - memory auto ingest
  - agent memory tools
  - memory import export
  - obsidian memory export
  - chatgpt memory import
  - llm fact extraction
  - personality memory threshold
  - hexaco memory modulation
  - memory tools pack
---

# Memory Operations

Three operational subsystems sit around the AgentOS memory facade: Wunderland's **auto-ingest pipeline**, which extracts facts from conversation turns, **six agent-facing tools** that let an agent read and write its own memory at runtime, and an **import/export** layer (four export formats, six import formats). The tools and the import/export layer work on one `Memory` instance's SQLite brain, so a trace added by one is found by the other.

| Subsystem | Trigger | Direction |
|---|---|---|
| **Auto-Ingest** (Wunderland) | `processConversationTurn()` after a turn | Conversation → vector store or cognitive memory |
| **Agent Tools** | LLM tool call (`memory_add`, `memory_search`, …) | Agent ↔ memory |
| **Import/Export** | Explicit `memory.export()` / `memory.import()` | Memory ↔ external format |

---

## Auto-Ingest Pipeline

`MemoryAutoIngestPipeline` (Wunderland) takes one user message and one assistant reply, asks an LLM for facts worth keeping, filters them by the agent's HEXACO-derived memory config, and stores the rest. The host supplies the LLM call (`llmCaller`), so the model is the host's choice.

### How It Works

```mermaid
graph LR
    A["User message +\nAssistant response"]:::primary
    B["LLM Fact Extraction\n(host-supplied llmCaller)"]:::processing
    C["Category, boost and\nthreshold filter"]:::processing
    D["CognitiveMemoryManager.encode()\nor auto_memories collection"]:::memory

    A --> B --> C --> D

    classDef primary fill:#1c1c28,stroke:#c9a227,color:#f2f2fa
    classDef memory fill:#1c1c28,stroke:#00f5ff,color:#f2f2fa
    classDef processing fill:#1c1c28,stroke:#8b5cf6,color:#f2f2fa
```

1. **Extract**: `llmCaller` returns candidate facts, each with a category, an importance score (0-1) and entities. When the call fails, the turn stores nothing.
2. **Filter**: a fact whose category the personality config does not enable is skipped. The category's boost is added to the importance, and a fact below the threshold is skipped; the threshold is the lower of the personality-derived value and `storage.autoIngest.importanceThreshold` (default 0.4). At most `maxPerTurn` facts are kept, the lower of the two limits (default 3).
3. **Store**: with a cognitive memory manager attached, each fact goes through `CognitiveMemoryManager.encode()` as a trace tagged with its category and `auto_ingest`. Without one, the facts are upserted into the `auto_memories` collection of the agent's vector store, with category, importance, entities, conversation id and timestamp as metadata, and embedded only when the host passes `embedFn`.

The pipeline does no deduplication.

### Fact Categories

| Category | What it captures |
|----------|-----------------|
| `user_preference` | Likes, dislikes, stated preferences |
| `episodic` | What happened in the conversation |
| `goal` | What the user wants to achieve |
| `knowledge` | Technical or domain facts learned |
| `correction` | Corrections to prior beliefs or statements |

### HEXACO Personality Modulation

`derivePersonalityMemoryConfig()` starts from a threshold of 0.4, three facts per turn and the five categories above, then adjusts them for each trait above 0.6:

| Trait (> 0.6) | Effect |
|---------------|--------|
| **Openness** | Lowers the importance threshold (floor 0.2), allows one more fact per turn (up to 5), enables the `emotional_context` category. Openness below 0.4 raises the threshold (cap 0.7) and allows one fact fewer. |
| **Conscientiousness** | Enables the `action_item` category with a 0.15 boost, adds 0.1 to `goal` |
| **Agreeableness** | Adds 0.15 to `user_preference` |
| **Emotionality** | Enables `emotional_context` with a 0.1 boost, adds 0.1 to `episodic` |
| **Honesty** | Adds 0.2 to `correction` |

The function also sets a deduplication threshold, a compaction interval, a retrieval top-K and a sentiment flag from the traits; nothing reads those four fields. Wunderland derives the config from the agent's `personality` block in `agent.config.json`.

### Configuration

Add a `storage.autoIngest` section to `agent.config.json`:

```json
{
  "storage": {
    "autoIngest": {
      "enabled": true,
      "importanceThreshold": 0.4,
      "maxPerTurn": 3
    }
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Toggle the pipeline on/off |
| `importanceThreshold` | `0.4` | Minimum boosted importance to store a fact; the pipeline uses the lower of this and the personality-derived threshold |
| `maxPerTurn` | `3` | Maximum facts stored per turn; the pipeline uses the lower of this and the personality-derived limit |

### Integration Points

`wunderland chat` builds the pipeline from the agent's storage config and traits and calls `processConversationTurn()` after each reply without awaiting it. It builds the pipeline with a placeholder `llmCaller` that returns no facts, so a chat session stores nothing through it. Wunderland's tool-failure learner also passes tool failures through the pipeline.

### Relationship to Observer / Reflector

The auto-ingest pipeline and the Observer/Reflector system are complementary but operate differently:

| | Auto-Ingest | Observer / Reflector |
|---|---|---|
| **Trigger** | Every turn | Token threshold (30K / 40K) |
| **Granularity** | Per-turn fact extraction | Batch observation + consolidation |
| **LLM cost** | Cheap model, small prompt | Larger prompt with conversation history |
| **Output** | Individual facts in vector store | Observation notes + long-term memory traces |
| **Purpose** | Capture details before they scroll out of context | Compress and consolidate accumulated knowledge |

With a cognitive memory manager attached, auto-ingested facts become traces and are retrieved with the same composite score as the observer's notes (vector similarity, Ebbinghaus strength, emotional congruence, recency, graph activation, importance). Without one, they stay in the `auto_memories` collection.

### Key Files

The auto-ingest pipeline ships in [Wunderland](https://github.com/jddunn/wunderland), not in the `@framers/agentos` package.

| File (in `jddunn/wunderland`) | Purpose |
|------|---------|
| [`src/memory/auto-ingest/MemoryAutoIngestPipeline.ts`](https://github.com/jddunn/wunderland/blob/master/src/memory/auto-ingest/MemoryAutoIngestPipeline.ts) | Pipeline orchestrator |
| [`src/memory/storage/PersonalityMemoryConfig.ts`](https://github.com/jddunn/wunderland/blob/master/src/memory/storage/PersonalityMemoryConfig.ts) | HEXACO-to-config mapping |
| [`src/memory/storage/AgentStorageManager.ts`](https://github.com/jddunn/wunderland/blob/master/src/memory/storage/AgentStorageManager.ts) | Holds the per-agent vector store and the pipeline (`setAutoIngestPipeline()`) |
| [`src/cli/commands/chat.ts`](https://github.com/jddunn/wunderland/blob/master/src/cli/commands/chat.ts) | Builds the pipeline and calls it after each reply |

---

## Agent Memory Tools


> Six ITool implementations let agents read, write, search, and consolidate their own memory traces at runtime. `Memory.createTools()` returns them; register them one by one, as a pack, or through `AgentOS.create({ memoryTools })`.


### Overview

| Tool | Name | Description | Side Effects |
|------|------|-------------|-------------|
| [`MemoryAddTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryAddTool.ts) | `memory_add` | Store a new memory trace | Write |
| [`MemoryUpdateTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryUpdateTool.ts) | `memory_update` | Update content or tags of an existing trace | Write |
| [`MemoryDeleteTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryDeleteTool.ts) | `memory_delete` | Soft-delete a trace by ID | Write |
| [`MemoryMergeTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryMergeTool.ts) | `memory_merge` | Merge two or more traces into the most-retrieved one | Write |
| [`MemorySearchTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemorySearchTool.ts) | `memory_search` | FTS5 full-text search over traces | Read-only |
| [`MemoryReflectTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryReflectTool.ts) | `memory_reflect` | Trigger on-demand consolidation | Write |

`createTools()` leaves out `memory_reflect` when the `Memory` was created with `selfImprove: false` (there is no consolidation loop) or when called with `{ includeReflect: false }`. All tools implement the [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) interface and belong to the `memory` category.


### Registration

### Register the tools directly

```ts
import { AgentOS, Memory } from '@framers/agentos';

const memory = await Memory.createSqlite({ path: './brain.sqlite', selfImprove: true });
const agentos = await AgentOS.create();

for (const tool of memory.createTools()) {
  await agentos.getToolOrchestrator().registerTool(tool);
}
```

### Through the AgentOS configuration

```ts
import { AgentOS, Memory } from '@framers/agentos';

const memory = await Memory.createSqlite({ path: './brain.sqlite', selfImprove: true });

const agentos = await AgentOS.create({
  memoryTools: {
    memory,
    includeReflect: true,     // Include memory_reflect tool
    identifier: 'primary-memory-tools',
    manageLifecycle: true,    // AgentOS closes Memory on shutdown
  },
});
```

### As an extension pack

```ts
import { createMemoryToolsPack } from '@framers/agentos';

await agentos.getExtensionManager().loadPackFromFactory(
  createMemoryToolsPack(memory),
  'memory-tools',
);
```


### Tool Reference

### `memory_add`

Store a new memory trace in the agent's brain database.

**Input Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | `string` | Yes | --- | The text content to remember |
| `type` | `string` | No | `'episodic'` | Memory type: `episodic`, `semantic`, `procedural`, `prospective`, `relational` |
| `scope` | `string` | No | `'user'` | Visibility scope: `thread`, `user`, `persona`, `organization` |
| `tags` | `string[]` | No | `[]` | Free-form tags for filtering |

**Output:**

```json
{ "traceId": "mt_1711234567890_0" }
```

**Behaviour:**
- Creates a trace with strength 1.0 (full encoding strength at creation time) and no embedding.
- Stores the SHA-256 hash of the content in the trace's metadata. It does not check for an existing trace with the same content: calling it twice stores two traces.
- ID format: `mt_<epoch ms>_<counter>`, the counter counting up within the process.
- Records the scope id resolved from the execution context (for example the user id for `user` scope) in the metadata.
- Indexes the trace in FTS5.

**Example:**

```json
{
  "name": "memory_add",
  "arguments": {
    "content": "User prefers dark mode and TypeScript.",
    "type": "semantic",
    "tags": ["preference", "ui", "language"]
  }
}
```


### `memory_update`

Update the content or tags of an existing memory trace.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `traceId` | `string` | Yes | ID of the trace to update |
| `content` | `string` | No | New text content (replaces old) |
| `tags` | `string[]` | No | New tags array (replaces old) |

**Output:**

```json
{ "updated": true }
```

**Behaviour:**
- Locates the active (not deleted) trace by ID in `memory_traces`.
- Updates only the specified fields (content, tags, or both).
- When the content changes, recomputes the content hash and clears the stored embedding.
- Rebuilds the FTS5 index.
- Returns `{ "updated": false }` if the trace was not found, was deleted, or neither field was given.

**Example:**

```json
{
  "name": "memory_update",
  "arguments": {
    "traceId": "mt_1711234567890_0",
    "content": "User prefers dark mode, TypeScript, and VS Code.",
    "tags": ["preference", "ui", "language", "editor"]
  }
}
```


### `memory_delete`

Soft-delete a memory trace by ID.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `traceId` | `string` | Yes | ID of the trace to delete |

**Output:**

```json
{ "deleted": true }
```

**Behaviour:**
- Sets `deleted = 1` on the trace (soft-delete, not physical removal).
- Soft-deleted traces are excluded from search results and retrieval.
- The trace remains in the database for audit/provenance purposes.
- Returns `{ "deleted": false }` if the trace was not found.

**Example:**

```json
{
  "name": "memory_delete",
  "arguments": {
    "traceId": "mt_1711234567890_0"
  }
}
```


### `memory_merge`

Merge two or more memory traces into one surviving trace.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `traceIds` | `string[]` | Yes | IDs of traces to merge (minimum 2) |
| `mergedContent` | `string` | No | Content for the merged trace (if omitted, the contents are joined with ` \| `) |

**Output:**

```json
{
  "survivorId": "mt_aaa",
  "deletedIds": ["mt_bbb", "mt_ccc"]
}
```

**Behaviour:**
- Fails when fewer than two of the IDs name active traces.
- The trace with the highest retrieval count survives and takes the merged content; its embedding is cleared.
- Tags from all source traces are unioned onto the survivor.
- Retrieval counts are summed, and the survivor keeps the latest access time and the highest decay stability among the sources.
- The other traces are soft-deleted, and the FTS5 index is rebuilt.

**Example:**

```json
{
  "name": "memory_merge",
  "arguments": {
    "traceIds": ["mt_aaa", "mt_bbb", "mt_ccc"],
    "mergedContent": "User's deployment preferences: Docker Compose, blue-green strategy, Friday deploys."
  }
}
```


### `memory_search`

Full-text search over memory traces using the FTS5 index with BM25 ranking.

**Input Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | --- | Full-text search query |
| `type` | `string` | No | --- | Filter by memory type |
| `scope` | `string` | No | --- | Filter by visibility scope |
| `limit` | `number` | No | `10` | Maximum results to return |

**Output:**

```json
{
  "results": [
    {
      "id": "mt_abc123",
      "content": "User prefers dark mode and TypeScript.",
      "type": "semantic",
      "scope": "user",
      "strength": 0.87,
      "tags": ["preference", "ui"]
    }
  ]
}
```

**Behaviour:**
- Queries the `memory_traces_fts` FTS5 virtual table.
- Results are ranked by BM25 relevance score.
- Only active traces are returned (soft-deleted traces are excluded).
- Optional `type` and `scope` filters are applied via SQL WHERE clauses on the join; a `scope` filter also matches the scope id resolved from the execution context.
- `limit` takes 1 to 100.
- The query runs as FTS5 syntax first; when SQLite rejects it as a syntax error, the tool converts it to a natural-language FTS5 query and runs it again.

### FTS5 Query Syntax

The tool accepts FTS5 operators directly, and falls back to a converted query for natural-language input that FTS5 rejects:

| Syntax | Meaning | Example |
|--------|---------|---------|
| `word` | Match any form (Porter stemming) | `deploy` matches "deployment", "deployed" |
| `"phrase query"` | Exact phrase match | `"dark mode"` |
| `word1 AND word2` | Both terms required | `docker AND compose` |
| `word1 OR word2` | Either term | `typescript OR javascript` |
| `word1 NOT word2` | Exclude term | `deploy NOT staging` |
| `prefix*` | Prefix match | `type*` matches "typescript", "types" |

**Example:**

```json
{
  "name": "memory_search",
  "arguments": {
    "query": "deployment preferences",
    "type": "semantic",
    "limit": 5
  }
}
```


### `memory_reflect`

Trigger on-demand memory consolidation --- the analogue of slow-wave sleep. Runs the full 6-step ConsolidationLoop.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | `string` | No | Reserved for future topic-scoped consolidation (currently ignored) |

**Output:**

```json
{
  "pruned": 3,
  "merged": 1,
  "derived": 0,
  "compacted": 2,
  "durationMs": 42,
  "personalityDecayed": 0
}
```

**Behaviour:**

Runs the 6 consolidation steps in order:

1. **Prune** --- soft-delete traces below strength threshold (default 0.05).
2. **Merge** --- deduplicate near-identical traces (similarity > 0.95).
3. **Strengthen** --- record Hebbian co-activation edges from retrieval feedback.
4. **Derive** --- synthesise insight traces from memory clusters (LLM-backed, skipped if no LLM).
5. **Compact** --- promote old high-retrieval episodic traces to semantic type.
6. **Re-index** --- rebuild FTS5 index and log run to `consolidation_log`.

If a consolidation cycle is already in progress (mutex), returns immediately with zero counts.

**Example:**

```json
{
  "name": "memory_reflect",
  "arguments": {}
}
```


### When Agents Should Use Each Tool

| Situation | Recommended Tool |
|-----------|-----------------|
| Agent learns a new fact about the user | `memory_add` with `type: 'semantic'` |
| Agent wants to record a conversation event | `memory_add` with `type: 'episodic'` |
| Agent discovers a previous memory is outdated | `memory_update` to correct the content |
| Agent finds a memory is wrong or harmful | `memory_delete` to soft-remove it |
| Agent notices several memories say the same thing | `memory_merge` to consolidate them |
| Agent needs to look up what it knows about a topic | `memory_search` with relevant keywords |
| Agent has been running for a while and wants to clean up | `memory_reflect` to trigger consolidation |
| Agent needs to remember a future task | `memory_add` with `type: 'prospective'` |
| Agent sees a gisted memory and needs the full original text | `rehydrate_memory` with the trace ID |

### rehydrate_memory (opt-in)

Retrieves the original verbatim content of a memory trace whose content has been compressed by temporal gist. Neither `Memory.createTools()` nor `createMemoryToolsPack()` adds it (`MemoryToolsExtensionOptions.includeRehydrate` is declared but not read): build it with `new RehydrateMemoryTool(archive)`, passing an [`IMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/IMemoryArchive.ts), and register it yourself. The package entry points do not export the class; import it from `@framers/agentos/memory/io/tools/RehydrateMemoryTool`.

**Input:** `{ traceId: string }` — the ID of the gisted/archived trace.

**Output:** `{ verbatimContent: string | null, archivedAt: number | null }` — the original content before gisting, or null if the trace is not archived or integrity verification fails.

**Side effects:** writes a row to `archive_access_log` so the retention sweep knows which traces are still in use.


### Source Files

All under [`src/cognition/memory/io/tools/`](https://github.com/framerslab/agentos/tree/master/src/cognition/memory/io/tools):

| File | Purpose |
|------|---------|
| `MemoryAddTool.ts` | `memory_add` implementation |
| `MemoryUpdateTool.ts` | `memory_update` implementation |
| `MemoryDeleteTool.ts` | `memory_delete` implementation |
| `MemoryMergeTool.ts` | `memory_merge` implementation |
| `MemorySearchTool.ts` | `memory_search` implementation |
| `MemoryReflectTool.ts` | `memory_reflect` implementation |
| `RehydrateMemoryTool.ts` | `rehydrate_memory` implementation (opt-in) |
| `index.ts` | Barrel exports for all tools |
| `scopeContext.ts` | Scope ID resolution from execution context |

---

## Import and Export


> The Memory I/O subsystem exports to four formats and imports from six. The SQLite and JSON exports carry the whole brain: JSON holds traces, graph rows, documents, chunks, images, conversations, and messages. Markdown and Obsidian exports carry the active traces only. Trace deduplication is on by default on import.


### Overview

| Direction | Formats | Use Case |
|-----------|---------|----------|
| **Export** | SQLite, JSON, Markdown, Obsidian | Backup, sharing, human review, Obsidian knowledge management |
| **Import** | SQLite, JSON, Markdown, Obsidian, ChatGPT, CSV | Restore, migrate, ingest existing knowledge, import chat history |

All operations are available via the `Memory` facade API.


### Export Formats

### SQLite (Byte-Perfect Backup)

The highest-fidelity export. Uses SQLite's `VACUUM INTO` to produce a clean, self-contained copy of the entire brain database including all traces, embeddings, graph edges, documents, chunks, and consolidation logs.

```ts
await mem.export('./backup.sqlite', { format: 'sqlite' });
```

- Produces an exact copy of the brain file.
- Includes raw embedding BLOBs (no re-embedding needed on import).
- Suitable for disaster recovery, agent cloning, or migration.

### JSON (Programmatic)

A single structured JSON document containing the full portable brain payload. Designed for programmatic consumption, browser-safe transfer, and cross-runtime restore.

```ts
await mem.export('./memories.json', { format: 'json' });

// Optional: include raw embedding vectors (increases file size significantly)
await mem.export('./memories-with-embeddings.json', {
  format: 'json',
  includeEmbeddings: true,
});
```

Each trace entry is the raw `memory_traces` row, with snake_case columns and JSON-encoded `tags`, `emotions` and `metadata` strings:

```json
{
  "brain_id": "brain",
  "id": "mt_1711234567890_0",
  "type": "semantic",
  "scope": "user",
  "content": "User prefers TypeScript over Python",
  "embedding": null,
  "strength": 0.87,
  "created_at": 1711234567890,
  "last_accessed": 1711234600000,
  "retrieval_count": 3,
  "tags": "[\"preference\",\"language\"]",
  "emotions": "{}",
  "metadata": "{\"source\":\"user_statement\"}",
  "deleted": 0
}
```

`includeConversations: false` leaves out the conversation and message rows.

### Markdown (Human-Readable)

Exports each active trace as a standalone `.md` file with YAML front-matter, in a `{scope}/{type}/` folder:

```ts
await mem.export('./memory-export', { format: 'markdown' });
```

Produces files like:

```
memory-export/
  user/
    episodic/
      mt_1711234567890_0.md
    semantic/
      mt_1711234567890_1.md
  thread/
    procedural/
      mt_1711234567890_2.md
```

Each file:

```markdown
---
id: mt_1711234567890_1
type: semantic
scope: user
strength: 0.87
tags:
  - preference
  - language
createdAt: 1711234567890
---
User prefers TypeScript over Python
```

### Obsidian (Wikilinks + Tags)

Extends the Markdown exporter with Obsidian-specific features for integration with Obsidian knowledge vaults:

```ts
await mem.export('./vault', { format: 'obsidian' });
```

Produces:

- `#tags` in the body for every tag on the trace.
- A **Related:** list of `[[wikilinks]]` to the labels of the knowledge-graph nodes the trace's node links to (empty when the graph has no edges for it).
- The same YAML front-matter and `{scope}/{type}/` folders as the Markdown export.

Example output:

```markdown
---
id: mt_1711234567890_1
type: semantic
scope: user
strength: 0.87
tags:
  - preference
  - language
createdAt: 1711234567890
---
User prefers TypeScript over Python

#preference #language

**Related:**
- [[TypeScript]]
- [[tooling]]
```


### Import Formats

### SQLite

Merges another brain database into the current one. A source trace whose content hash or content already exists in the brain is not inserted: its tags are unioned into the existing trace, which keeps the newer `created_at`. Knowledge nodes are matched by label and type, edges by source, target and type.

```ts
const result = await mem.importFrom('./backup.sqlite', { format: 'sqlite' });
console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}`);
```

### JSON

Parses a [`JsonExporter`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/JsonExporter.ts)-format JSON file and restores traces plus any included graph/document/conversation rows.

```ts
const result = await mem.importFrom('./memories.json', { format: 'json' });
```

### Markdown

Walks a directory of Markdown files with YAML front-matter. Each file with a non-empty body becomes one memory trace. The `id`, `type`, `scope`, `tags`, `strength` and `createdAt` fields are read from front-matter (defaults: a new id, `episodic`, `user`, no tags, 1.0, now); the body becomes the trace content.

```ts
const result = await mem.importFrom('./notes/', { format: 'markdown' });
```

### Obsidian Vault

Extends the Markdown importer with Obsidian-specific parsing:

```ts
const result = await mem.importFrom('./my-vault/', { format: 'obsidian' });
```

- Each `[[wikilink]]` (or `[[Target|Alias]]`) becomes a `related_to` knowledge-graph edge from the note's node to a node for the target label, created when missing.
- YAML front-matter fields are read as in the Markdown importer.
- `#tags` in the body are extracted and added to the trace's tag array.
- Embedded images (`![[image.png]]`) are not imported.
- The folder a note sits in does not set its type: a note without `type` in its front-matter is imported as `episodic`.

### ChatGPT Export

Imports from ChatGPT's `conversations.json` export file. Each conversation becomes a row in the `conversations` table, and each user/assistant message pair becomes an episodic memory trace:

```ts
const result = await mem.importFrom('./conversations.json', { format: 'chatgpt' });
```

- Each message pair becomes one `episodic` trace in `user` scope whose content is `[user]: ...` followed by `[assistant]: ...`, with no tags; its metadata names the conversation row.
- System and tool messages are skipped.
- The user message's timestamp from the export becomes the trace's `created_at`.
- Long conversations produce many traces, which can then be consolidated via `mem.consolidate()`.

### CSV

Imports flat CSV files with a header row. A `content` column is required. The optional columns `id`, `type`, `scope`, `strength`, `created_at` (or `createdAt`), `last_accessed`, `retrieval_count`, `deleted`, `tags` (a JSON array, or comma- or pipe-separated) and `metadata` (a JSON object) map onto the trace's fields:

```ts
const result = await mem.importFrom('./knowledge-base.csv', { format: 'csv' });
```

Expected CSV structure:

```csv
content,type,tags
"User prefers dark mode",semantic,"preference,ui"
"Deploy with Docker Compose",procedural,"deployment,docker"
```


### SHA-256 Deduplication

All import paths use SHA-256 content hashing to prevent duplicate traces:

1. Before inserting a trace, the importer computes `SHA-256(content)` and stores it in the trace's metadata as `import_hash`.
2. When a trace in the brain already carries that hash, the row is skipped (counted in `skipped`), whatever its type and scope. The CSV and SQLite importers also match a trace's own `content_hash`, and the SQLite importer an identical `content`.
3. Deduplication is enabled by default (`dedup: true`) and can be disabled per-import.

```ts
// Disable dedup (allows duplicate content)
const result = await mem.importFrom('./data.json', {
  format: 'json',
  dedup: false,
});
```


### ImportResult

Every import operation returns a summary:

```ts
interface ImportResult {
  imported: number;  // Traces successfully written
  skipped: number;   // Traces skipped (dedup or format mismatch)
  errors: string[];  // Human-readable error messages for failures
}
```


### ExportOptions Reference

```ts
interface ExportOptions {
  /** Serialisation format. Default: 'json'. */
  format?: 'sqlite' | 'json' | 'markdown' | 'obsidian';

  /** Include raw embedding vectors. Default: false. */
  includeEmbeddings?: boolean;

  /** Include conversation turn traces. Default: true. */
  includeConversations?: boolean;
}
```

### ImportOptions Reference

```ts
interface ImportOptions {
  /** Source format. Default: 'auto' (detect from extension/magic bytes). */
  format?: 'auto' | 'sqlite' | 'json' | 'markdown' | 'obsidian' | 'chatgpt' | 'csv';

  /** Skip traces whose content hash already exists. Default: true. */
  dedup?: boolean;
}
```


### Source Files

All under [`src/cognition/memory/io/`](https://github.com/framerslab/agentos/tree/master/src/cognition/memory/io):

| File | Purpose |
|------|---------|
| `JsonExporter.ts` | JSON export (one document) |
| `JsonImporter.ts` | JSON import with dedup |
| `MarkdownExporter.ts` | Markdown directory export with YAML front-matter |
| `MarkdownImporter.ts` | Markdown directory import |
| `ObsidianExporter.ts` | Obsidian vault export (wikilinks + tags) |
| `ObsidianImporter.ts` | Obsidian vault import (wikilinks -> graph edges) |
| `SqliteExporter.ts` | `VACUUM INTO` byte-perfect backup |
| `SqliteImporter.ts` | SQLite merge with smart dedup + tag union |
| `ChatGptImporter.ts` | ChatGPT `conversations.json` parser |
| `CsvImporter.ts` | CSV import with required `content` column |
