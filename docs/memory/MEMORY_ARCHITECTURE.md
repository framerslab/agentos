---
title: 'Memory Architecture Overview'
sidebar_position: 20
description: 'How the three memory layers compose — standalone Memory, AgentCognitiveMemory, and the CLI — plus cognitive science foundations and competitor comparison.'
---

> The AgentOS memory system is a composable, SQLite-first architecture that layers cognitive-science-inspired memory management atop a single-file brain database. Three progressive API tiers let you choose the right abstraction for your use case.

---

## The Three Layers

AgentOS memory ships as three concentric API tiers. Each tier wraps the one below it and adds its own concerns:

```
┌─────────────────────────────────────────────────────────────────────┐
│                       CLI / Host Layer                              │
│  Programmatic: Memory.export(), Memory.consolidate(), Memory.health│
│  (agent.config.json auto-wiring, preset skills)                    │
└──┬──────────────────────────────────────────────────────────────────┘
   │
┌──▼──────────────────────────────────────────────────────────────────┐
│                 AgentCognitiveMemory Layer                          │
│  CognitiveMemoryManager + AgentMemory facade                       │
│  (HEXACO encoding, PAD mood, Ebbinghaus decay, observer/reflector, │
│   Baddeley working memory, spreading activation, prospective mem)  │
└──┬──────────────────────────────────────────────────────────────────┘
   │
┌──▼──────────────────────────────────────────────────────────────────┐
│                    Memory Facade Layer                              │
│  await Memory.createSqlite({ path: './brain.sqlite' })                   │
│  (remember, recall, ingest, export, import, consolidate, tools)    │
│                                                                     │
│  Composes:                                                          │
│    Brain → SqlKnowledgeGraph → SqlMemoryGraph           │
│    LoaderRegistry → FolderScanner → ChunkingEngine                  │
│    RetrievalFeedbackSignal → ConsolidationLoop                      │
│    I/O exporters/importers (JSON, Markdown, Obsidian, SQLite, etc.) │
└─────────────────────────────────────────────────────────────────────┘
```

### When to Use Each Layer

| Layer | Import | Best For | LLM Required |
|-------|--------|----------|--------------|
| **Memory** | `await Memory.create(config)` | Any TypeScript app, CLI tools, scripts, ingestion pipelines | No |
| **AgentCognitiveMemory** | `CognitiveMemoryManager` or `AgentMemory.wrap()` | Agents with HEXACO personality, PAD mood, observer/reflector | Optional (Batch 2) |
| **CLI / Host** | `Memory.export()`, `Memory.health()` | End-user interaction, shell scripts, CI pipelines | No |

---

## Memory Facade Composition

The `Memory` class is the primary standalone entry point. It wires together every subsystem at initialization time:

```ts
import { Memory } from '@framers/agentos';

const mem = await Memory.createSqlite({
  path: './brain.sqlite',
  graph: true,
  selfImprove: true,
});
```

`Memory.create()` currently opens the SQLite-backed memory facade at runtime. The lower-level storage-adapter abstractions and RAG/vector-store backends cover Postgres and browser-specific paths separately.

### Memory Archive

The archive provides lossless cold storage for verbatim memory content that consolidation mechanisms (temporal gist, lifecycle archival) would otherwise destroy. Two-tier model:

| Tier | Content | Decay? | Searchable? |
|------|---------|--------|-------------|
| Working (MemoryStore) | Gisted summaries after consolidation | Yes | Yes (vector + FTS) |
| Archive (IMemoryArchive) | Original verbatim content | No (age-based retention only) | By ID only |

The archive is strictly **write-ahead**: any mechanism that would lose verbatim content calls `archive.store()` and awaits success before mutating the trace. If the archive write fails, the destructive operation is aborted.

Rehydration (`archive.rehydrate(traceId)`) returns the original content on demand. It is a transient read (no encoding strength boost, no retrieval count increment, no reconsolidation). A lightweight access log tracks which traces are actively rehydrated so the retention sweep doesn't drop them.

`SqlStorageMemoryArchive` wraps `@framers/sql-storage-adapter`'s `StorageAdapter` interface. When sharing the brain's adapter, archive tables live in the same database file. Supported backends: better-sqlite3, sql.js, IndexedDB, Capacitor SQLite, PostgreSQL.

### Subsystem Wiring

| Step | Subsystem Created | Purpose |
|------|-------------------|---------|
| 1 | `await Brain.openSqlite(path)` | Single brain connection, schema bootstrap, storage feature bundle |
| 2 | `SqlKnowledgeGraph(brain)` | Entity and relationship store for knowledge graph |
| 3 | `SqlMemoryGraph(brain)` | Memory association graph with spreading activation |
| 4 | `LoaderRegistry()` | File-type detection and document parsing |
| 5 | `FolderScanner(registry)` | Recursive directory walking with glob filters |
| 6 | `ChunkingEngine()` | Four chunking strategies (fixed, semantic, hierarchical, layout) |
| 7 | `RetrievalFeedbackSignal(brain)` | Used/ignored detection for Hebbian reinforcement |
| 8 | `ConsolidationLoop(brain, graph)` | 6-step self-improving consolidation pipeline |

When `selfImprove` is `false`, steps 7 and 8 are skipped and the feedback/consolidation subsystems are set to `null`.

### Data Flow

```
Input (text / file / URL / folder)
  │
  ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  LoaderRegistry  │───▶│  ChunkingEngine  │───▶│  Brain     │
│  (parse to text) │    │  (split chunks)  │    │  (store traces)  │
└──────────────────┘    └──────────────────┘    └────────┬─────────┘
                                                         │
  ┌──────────────────────────────────────────────────────┘
  │
  ▼                         ▼                         ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  FTS5 Index      │  │  KnowledgeGraph  │  │  MemoryGraph     │
│  (BM25 search)   │  │  (entities/edges)│  │  (associations)  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
  │                         │                         │
  └────────────────┬────────┘─────────────────────────┘
                   ▼
             ┌──────────────────┐
             │  recall() result │
             │  (scored traces) │
             └──────────────────┘
                   │
                   ▼
             ┌──────────────────┐
             │  Feedback Signal │
             │  (used/ignored)  │
             └──────────────────┘
                   │
                   ▼
             ┌──────────────────┐
             │ ConsolidationLoop│
             │ (prune/merge/...) │
             └──────────────────┘
```

---

## AgentCognitiveMemory Layer

The `CognitiveMemoryManager` adds personality-modulated cognition on top of the base Memory. When used inside AgentOS, it powers the full per-turn memory pipeline:

```ts
// Inside AgentOS turn loop:
// 1. encode()          → Create MemoryTrace (personality-modulated strength)
// 2. retrieve()        → Query vector store + 6-signal composite scoring
// 3. assembleForPrompt → Token-budgeted context assembly → system prompt
// 4. [LLM generates response]
// 5. observe()         → Feed response to observer buffer
// 6. checkProspective  → Check time/event/context triggers
// 7. runConsolidation  → Periodic background sweep
```

Lifecycle note: the retention/decay sweep is now operational on the built-in
vector stores that support `scanByMetadata()`, rather than being placeholder-only.

Key additions over the standalone `Memory` facade:

| Feature | Description |
|---------|-------------|
| HEXACO encoding | Personality traits modulate attention weights and encoding strength |
| PAD mood state | Current valence/arousal/dominance affects encoding and retrieval |
| Ebbinghaus decay | Exponential forgetting curve with spaced repetition reinforcement |
| Baddeley working memory | Slot-based capacity (7 plus/minus 2), activation decay per turn |
| Spreading activation | ACT-R-style graph traversal from seed nodes |
| Observer/Reflector | LLM-backed observation compression (3-10x) and reflection |
| Prospective memory | Time, event, and context-based future-intention triggers |
| 6-signal retrieval | Strength + similarity + recency + emotion + graph + importance |

See [Cognitive Memory](./cognitive-memory) for the full technical reference.

---

## Cognitive Science Foundations

The memory system is grounded in established cognitive science models rather than ad-hoc engineering:

| Model | Year | Application in AgentOS |
|-------|------|----------------------|
| Atkinson-Shiffrin (1968) | 1968 | Sensory input -> working memory -> long-term memory pipeline |
| Baddeley & Hitch (1974) | 1974 | Slot-based working memory with capacity limits |
| Tulving's LTM taxonomy (1972) | 1972 | Episodic, semantic, procedural, prospective memory types |
| Ebbinghaus forgetting curve (1885) | 1885 | Exponential strength decay: `S(t) = S0 * e^(-dt / stability)` |
| Yerkes-Dodson law (1908) | 1908 | Encoding quality peaks at moderate arousal (inverted U) |
| Brown & Kulik flashbulb memories (1977) | 1977 | High-emotion events create vivid, persistent traces (2x strength, 5x stability) |
| Mood-congruent encoding (Bower, 1981) | 1981 | Content matching current mood valence is encoded more strongly |
| Anderson's ACT-R (1983) | 1983 | Spreading activation through associative memory graph |
| Hebbian learning (1949) | 1949 | Co-retrieved memories strengthen associative edges |
| HEXACO personality model (2004) | 2004 | Trait-driven attention weights and capacity modulation |
| Collins & Quillian (1969) | 1969 | Semantic network structure for knowledge nodes/edges |

---

## Comparison with Competitors

| Feature | AgentOS Memory | mem0 | Cognee | Letta (MemGPT) | Mastra |
|---------|---------------|------|--------|----------------|--------|
| **Storage** | Single SQLite file per agent | Qdrant/Chroma/Postgres | Neo4j + vector | Postgres + Chroma | Postgres + Pinecone |
| **Personality modulation** | HEXACO 6-trait encoding bias | None | None | None | None |
| **Forgetting curve** | Ebbinghaus exponential decay | None | None | None | None |
| **Spaced repetition** | Interval doubling with desirable difficulty | None | None | None | None |
| **Working memory** | Baddeley slots (5-9, personality-modulated) | None | None | FIFO context window | Fixed sliding window |
| **Mood-aware retrieval** | PAD mood congruence (0.15 weight) | None | None | None | None |
| **Memory graph** | SQLite-backed with spreading activation | Simple key-value | Neo4j graph | None | None |
| **Self-improvement** | 6-step consolidation (prune/merge/strengthen/derive/compact/reindex) | Manual CRUD | Batch re-processing | Edit-based | None |
| **Retrieval signals** | 6-signal composite (strength, similarity, recency, emotion, graph, importance) | Cosine similarity | Cosine + graph | Cosine similarity | Cosine similarity |
| **Document ingestion** | 3-tier PDF, DOCX, HTML, Markdown, CSV, JSON, URLs | Text only | PDF, text | Text only | Text only |
| **Import/Export** | SQLite, JSON, Markdown, Obsidian, ChatGPT, CSV | JSON | None | JSON | None |
| **Offline-first** | Zero network calls required | Requires vector DB | Requires Neo4j | Requires server | Requires cloud |
| **Provenance tracking** | Full source type, confidence, verification count | None | Basic | None | None |

Key differentiators:

1. **Zero-dependency local operation** --- A single SQLite file contains everything (traces, graph, embeddings, FTS5 index, feedback signals, consolidation log). No external vector database, graph database, or cloud service required.

2. **Cognitive science grounding** --- Rather than treating memory as a flat key-value store, every operation is modulated by established cognitive models (encoding strength, forgetting curves, mood congruence, personality bias).

3. **Progressive complexity** --- The standalone `Memory` facade works with zero LLM calls. Cognitive features (observer, reflector, derive) activate only when an LLM invoker is provided.

---

## Source File Map

| Path | Module |
|------|--------|
| `memory/facade/Memory.ts` | Standalone Memory facade |
| `memory/facade/types.ts` | Public API types |
| `memory/store/Brain.ts` | SQLite connection manager (12-table DDL) |
| `memory/store/SqlKnowledgeGraph.ts` | IKnowledgeGraph over SQLite |
| `memory/store/SqlMemoryGraph.ts` | IMemoryGraph with spreading activation |
| `memory/ingestion/` | LoaderRegistry, FolderScanner, ChunkingEngine, loaders |
| `memory/feedback/RetrievalFeedbackSignal.ts` | Used/ignored detection |
| `memory/consolidation/ConsolidationLoop.ts` | 6-step consolidation pipeline |
| `memory/io/` | JSON, Markdown, Obsidian, SQLite, ChatGPT, CSV importers/exporters |
| `memory/archive/` | IMemoryArchive contract, SqlStorageMemoryArchive (cold storage for verbatim content) |
| `memory/tools/` | 7 agent-facing ITool implementations (including opt-in rehydrate_memory) |
| `memory/observation/` | ObservationCompressor, ObservationReflector, PerspectiveObserver, temporal |
| `memory/encoding/` | EncodingModel, ContentFeatureDetector |
| `memory/decay/` | DecayModel, RetrievalPriorityScorer |
| `memory/working/` | CognitiveWorkingMemory (Baddeley) |
| `memory/graph/` | IMemoryGraph, SpreadingActivation, GraphologyMemoryGraph |
| `memory/prospective/` | ProspectiveMemoryManager |
| `memory/consolidation/` | ConsolidationPipeline |
| `memory/prompt/` | MemoryPromptAssembler, MemoryFormatters |
