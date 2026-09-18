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

Three operational subsystems live on top of the AgentOS memory facade: an **auto-ingest pipeline** that extracts and stores facts from each conversation turn, **six agent-facing tools** that let an agent read and write its own memory at runtime, and a **lossless import/export** layer across six formats. They all share the same `Memory` instance and the same vector / FTS index, so a fact added by one path is retrievable through any other.

| Subsystem | Trigger | Direction |
|---|---|---|
| **Auto-Ingest** | Every conversation turn, non-blocking | Conversation → vector store |
| **Agent Tools** | LLM tool call (`memory_add`, `memory_search`, …) | Agent ↔ memory |
| **Import/Export** | Explicit `memory.export()` / `memory.import()` | Memory ↔ external format |

---

## Auto-Ingest Pipeline

After every conversation turn, the auto-ingest pipeline uses a cheap LLM (gpt-4o-mini or claude-haiku) to extract structured facts from the exchange and store them in the agent's vector database. The pipeline runs non-blocking so it never slows down the conversation.

### What It Does

The pipeline watches each user–assistant exchange, sends it through LLM-as-judge fact extraction, scores each fact's importance against a personality-derived threshold, and persists qualifying facts into the `auto_memories` vector collection for future retrieval.

### How It Works

```mermaid
graph LR
    A["User message +\nAssistant response"]:::primary
    B["LLM Fact Extraction\n(cheap model)"]:::processing
    C["Personality Scoring\n(HEXACO thresholds)"]:::processing
    D["Vector Store\n(auto_memories collection)"]:::memory

    A --> B --> C --> D

    classDef primary fill:#1c1c28,stroke:#c9a227,color:#f2f2fa
    classDef memory fill:#1c1c28,stroke:#00f5ff,color:#f2f2fa
    classDef processing fill:#1c1c28,stroke:#8b5cf6,color:#f2f2fa
```

1. **Extract** — The LLM receives the latest turn and outputs candidate facts, each tagged with a category and raw importance score (0–1).
2. **Score** — The personality scoring layer modulates raw importance using the agent's HEXACO traits (see below).
3. **Filter** — Facts below the importance threshold (default 0.4) are discarded.
4. **Deduplicate** — Remaining facts are compared against existing memories via cosine similarity (default threshold 0.85). Near-duplicates are dropped.
5. **Store** — Qualifying facts are embedded and written to the `auto_memories` vector collection with metadata (category, importance, timestamp, source turn).

### Fact Categories

| Category | What it captures |
|----------|-----------------|
| `user_preference` | Likes, dislikes, stated preferences |
| `episodic` | What happened in the conversation |
| `goal` | What the user wants to achieve |
| `knowledge` | Technical or domain facts learned |
| `correction` | Corrections to prior beliefs or statements |

### HEXACO Personality Modulation

Each HEXACO trait adjusts which categories get boosted, the importance threshold, and extraction volume:

| Trait (> 0.6) | Effect |
|---------------|--------|
| **Openness** | Lowers importance threshold (catches more marginal facts), +1 max facts per turn, enables emotional context tracking |
| **Conscientiousness** | Boosts `goal` and action-item importance, tighter deduplication (0.92), more frequent compaction |
| **Agreeableness** | Boosts `user_preference` importance, increases retrieval topK by 2 |
| **Emotionality** | Enables sentiment tracking, boosts `episodic` and emotional context categories |
| **Honesty** | Boosts `correction` category priority, loosens deduplication (0.75) to preserve nuance |

The modulation is automatic — derived from the agent's `personality` block in `agent.config.json`. No manual tuning required.

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
| `importanceThreshold` | `0.4` | Minimum importance score to store a fact (before personality modulation) |
| `maxPerTurn` | `3` | Maximum facts extracted per conversation turn |

### Integration Points

The pipeline is wired into two entry points:

- **Chat runtime** — runs after each assistant response via the `afterTurn()` hook in `AgentStorageManager`.
- **Chat runtime API** (`/api/chat`) — triggered by the same hook when conversations run through the HTTP API.

### Relationship to Observer / Reflector

The auto-ingest pipeline and the Observer/Reflector system are complementary but operate differently:

| | Auto-Ingest | Observer / Reflector |
|---|---|---|
| **Trigger** | Every turn | Token threshold (30K / 40K) |
| **Granularity** | Per-turn fact extraction | Batch observation + consolidation |
| **LLM cost** | Cheap model, small prompt | Larger prompt with conversation history |
| **Output** | Individual facts in vector store | Observation notes + long-term memory traces |
| **Purpose** | Capture details before they scroll out of context | Compress and consolidate accumulated knowledge |

Both systems feed the same retrieval pipeline — auto-ingested facts are surfaced by RAG queries alongside Observer/Reflector traces, scored by the same composite retrieval formula (vector similarity, Ebbinghaus strength, emotional congruence, recency, graph activation, importance).

### Key Files

| File | Purpose |
|------|---------|
| `src/memory/auto-ingest/MemoryAutoIngestPipeline.ts` | Pipeline orchestrator |
| `src/memory/auto-ingest/PersonalityMemoryConfig.ts` | HEXACO-to-config mapping |
| `src/memory/auto-ingest/AgentStorageManager.ts` | Wires pipeline into afterTurn() |

---

## Agent Memory Tools


> Six ITool implementations let agents read, write, search, and consolidate their own memory traces at runtime. Register them as a pack or individually.


### Overview

| Tool | Name | Description | Side Effects |
|------|------|-------------|-------------|
| [`MemoryAddTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryAddTool.ts) | `memory_add` | Store a new memory trace | Write |
| [`MemoryUpdateTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryUpdateTool.ts) | `memory_update` | Update content or tags of an existing trace | Write |
| [`MemoryDeleteTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryDeleteTool.ts) | `memory_delete` | Soft-delete a trace by ID | Write |
| [`MemoryMergeTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryMergeTool.ts) | `memory_merge` | Merge multiple traces into one | Write |
| [`MemorySearchTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemorySearchTool.ts) | `memory_search` | FTS5 full-text search over traces | Read-only |
| [`MemoryReflectTool`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/tools/MemoryReflectTool.ts) | `memory_reflect` | Trigger on-demand consolidation | Write |

All tools implement the [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) interface and belong to the `memory` category.


### Registration

### Extension Pack (Recommended)

```ts
import { createMemoryToolsPack, Memory } from '@framers/agentos';

const memory = await Memory.createSqlite({ path: './brain.sqlite', selfImprove: true });

// Register all 6 tools at once
for (const tool of memory.createTools()) {
  await agentos.getToolOrchestrator().registerTool(tool);
}
```

### Via AgentOS Initialize

```ts
import { AgentOS, Memory } from '@framers/agentos';

const memory = await Memory.createSqlite({ path: './brain.sqlite', selfImprove: true });
const agentos = new AgentOS();

await agentos.initialize({
  memoryTools: {
    memory,
    includeReflect: true,     // Include memory_reflect tool
    identifier: 'primary-memory-tools',
    manageLifecycle: true,    // AgentOS closes Memory on shutdown
  },
});
```

### Extension-Based Registration

```ts
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
| `type` | `string` | No | `'episodic'` | Tulving memory type: `episodic`, `semantic`, `procedural`, `prospective` |
| `scope` | `string` | No | `'user'` | Visibility scope: `thread`, `user`, `persona`, `organization` |
| `tags` | `string[]` | No | `[]` | Free-form tags for filtering |

**Output:**

```json
{ "traceId": "mt_abc123-def4-5678-9abc-def012345678" }
```

**Behaviour:**
- Creates a trace with strength 1.0 (full encoding strength at creation time).
- Computes SHA-256 content hash for deduplication --- if an identical trace exists with the same type and scope, the existing trace ID is returned instead.
- ID format: `mt_<UUID>` (crypto.randomUUID for collision safety).
- The trace is indexed in FTS5 and optionally added to the memory graph.

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
- Locates the trace by ID in `memory_traces`.
- Updates only the specified fields (content, tags, or both).
- Recomputes the content hash if content changed.
- Re-syncs the FTS5 index entry.
- Returns `{ "updated": false }` if the trace was not found.

**Example:**

```json
{
  "name": "memory_update",
  "arguments": {
    "traceId": "mt_abc123-def4-5678-9abc-def012345678",
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
    "traceId": "mt_abc123-def4-5678-9abc-def012345678"
  }
}
```


### `memory_merge`

Merge multiple memory traces into a single consolidated trace.

**Input Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `traceIds` | `string[]` | Yes | IDs of traces to merge (minimum 2) |
| `content` | `string` | No | Override content for the merged trace (if omitted, content is concatenated) |

**Output:**

```json
{
  "mergedTraceId": "mt_new-merged-id",
  "sourcesDeleted": 3
}
```

**Behaviour:**
- Creates a new trace combining the content of all source traces.
- Tags from all source traces are unioned.
- Source traces are soft-deleted with a reference to the merged trace.
- The merged trace inherits the highest strength among the sources.
- Knowledge graph edges from source traces are re-pointed to the merged trace.

**Example:**

```json
{
  "name": "memory_merge",
  "arguments": {
    "traceIds": ["mt_aaa", "mt_bbb", "mt_ccc"],
    "content": "User's deployment preferences: Docker Compose, blue-green strategy, Friday deploys."
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
- Optional `type` and `scope` filters are applied via SQL WHERE clauses on the join.
- Natural language queries are automatically converted to FTS5 syntax.

### FTS5 Query Syntax

The tool accepts natural language queries which are internally converted to FTS5 format. You can also use FTS5 operators directly:

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
  "durationMs": 42
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

Retrieves the original verbatim content of a memory trace whose content has been compressed by temporal gist. Register by passing `{ includeRehydrate: true }` to `MemoryToolsExtension`. Requires an [`IMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/IMemoryArchive.ts) to be configured.

**Input:** `{ traceId: string }` — the ID of the gisted/archived trace.

**Output:** `{ verbatimContent: string | null, archivedAt: number | null }` — the original content before gisting, or null if the trace is not archived or integrity verification fails.

**Side effects:** writes a row to `archive_access_log` so the retention sweep knows which traces are still in use.


### Source Files

| File | Purpose |
|------|---------|
| `memory/tools/MemoryAddTool.ts` | `memory_add` implementation |
| `memory/tools/MemoryUpdateTool.ts` | `memory_update` implementation |
| `memory/tools/MemoryDeleteTool.ts` | `memory_delete` implementation |
| `memory/tools/MemoryMergeTool.ts` | `memory_merge` implementation |
| `memory/tools/MemorySearchTool.ts` | `memory_search` implementation |
| `memory/tools/MemoryReflectTool.ts` | `memory_reflect` implementation |
| `memory/tools/RehydrateMemoryTool.ts` | `rehydrate_memory` implementation (opt-in) |
| `memory/tools/index.ts` | Barrel exports for all tools |
| `memory/tools/scopeContext.ts` | Scope ID resolution from execution context |

---

## Import and Export


> The Memory I/O subsystem provides lossless round-trip serialisation across four export formats and six import formats. JSON round-trips traces, graph rows, documents, chunks, images, conversations, and messages, and trace deduplication is enabled by default on import.


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

Each trace entry contains fields like:

```json
{
  "id": "mt_abc123",
  "type": "semantic",
  "scope": "user",
  "content": "User prefers TypeScript over Python",
  "strength": 0.87,
  "tags": ["preference", "language"],
  "emotions": {},
  "metadata": { "source": "user_statement" },
  "createdAt": 1711234567890,
  "lastAccessed": 1711234600000,
  "retrievalCount": 3
}
```

### Markdown (Human-Readable)

Exports each trace as a standalone `.md` file with YAML front-matter. The output directory structure groups traces by type:

```ts
await mem.export('./memory-export', { format: 'markdown' });
```

Produces files like:

```
memory-export/
  episodic/
    mt_abc123.md
    mt_def456.md
  semantic/
    mt_ghi789.md
  procedural/
    mt_jkl012.md
```

Each file:

```markdown
id: mt_abc123
type: semantic
scope: user
strength: 0.87
tags:
  - preference
  - language
createdAt: 2024-03-24T12:34:56Z

User prefers TypeScript over Python
```

### Obsidian (Wikilinks + Tags)

Extends the Markdown exporter with Obsidian-specific features for integration with Obsidian knowledge vaults:

```ts
await mem.export('./vault', { format: 'obsidian' });
```

Produces:

- `[[wikilinks]]` between related traces (graph edges become internal links).
- `#tags` in the body for every tag on the trace.
- YAML front-matter with all metadata fields.
- Folder structure matching Tulving memory types.

Example output:

```markdown
id: mt_abc123
type: semantic
scope: user
strength: 0.87
tags:
  - preference
  - language

User prefers TypeScript over Python

#preference #language

### Related
- [[mt_def456]] — deployment preferences
- [[mt_ghi789]] — tooling choices
```


### Import Formats

### SQLite

Merges another brain database into the current one. Smart deduplication compares content hashes; conflicting traces are resolved by tag union.

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

Walks a directory of Markdown files with YAML front-matter. Each file becomes one memory trace. The `id`, `type`, `scope`, `tags`, and `strength` fields are read from front-matter; the body becomes the trace content.

```ts
const result = await mem.importFrom('./notes/', { format: 'markdown' });
```

### Obsidian Vault

Extends the Markdown importer with Obsidian-specific parsing:

```ts
const result = await mem.importFrom('./my-vault/', { format: 'obsidian' });
```

- `[[wikilinks]]` are parsed and converted to knowledge graph edges between traces.
- YAML front-matter fields are mapped to trace metadata.
- `#tags` in the body are extracted and added to the trace's tag array.
- Folder structure is used to infer memory type when not specified in front-matter.

### ChatGPT Export

Imports from ChatGPT's `conversations.json` export file. Each user/assistant message pair becomes an episodic memory trace:

```ts
const result = await mem.importFrom('./conversations.json', { format: 'chatgpt' });
```

- Conversation titles become trace tags.
- Each message pair (user question + assistant answer) becomes one episodic trace.
- Timestamps from the export are preserved as `createdAt`.
- Long conversations produce many traces, which can then be consolidated via `mem.consolidate()`.

### CSV

Imports flat CSV files. Requires a `content` column; all other columns are treated as metadata:

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

1. Before inserting a new trace, the importer computes `SHA-256(content)`.
2. The hash is compared against existing traces in the `memory_traces.metadata` JSON column (field: `import_hash`).
3. If a matching hash exists with the same `type` and `scope`, the trace is skipped.
4. Deduplication is enabled by default (`dedup: true`) and can be disabled per-import.

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

| File | Purpose |
|------|---------|
| `memory/io/JsonExporter.ts` | JSON export (NDJSON or array) |
| `memory/io/JsonImporter.ts` | JSON import with dedup |
| `memory/io/MarkdownExporter.ts` | Markdown directory export with YAML front-matter |
| `memory/io/MarkdownImporter.ts` | Markdown directory import |
| `memory/io/ObsidianExporter.ts` | Obsidian vault export (wikilinks + tags) |
| `memory/io/ObsidianImporter.ts` | Obsidian vault import (wikilinks -> graph edges) |
| `memory/io/SqliteExporter.ts` | `VACUUM INTO` byte-perfect backup |
| `memory/io/SqliteImporter.ts` | SQLite merge with smart dedup + tag union |
| `memory/io/ChatGptImporter.ts` | ChatGPT `conversations.json` parser |
| `memory/io/CsvImporter.ts` | CSV import with required `content` column |
