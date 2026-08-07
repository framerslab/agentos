---
title: 'Memory System Overview'
sidebar_position: 1
description: 'How AgentOS memory works end-to-end — classifier-driven dispatch, BM25 + dense + Cohere rerank, Ebbinghaus decay, consolidation — and how each piece earned its place on the 85.6% LongMemEval-S / 70.2% LongMemEval-M result.'
keywords: [agentos memory, llm memory architecture, longmemeval, cognitive memory, bm25 dense rerank, cohere rerank, ebbinghaus decay, sql storage adapter, agent memory benchmark, hybrid retrieval]
---

> A study-grade walkthrough of the AgentOS memory stack: ingest, recall, read, decay, consolidation, multimodal, the classifier-driven dispatch pipeline, the Cohere neural rerank, the LLM-as-judge orchestration tiers, and the path from "embed everything" to **85.6% on LongMemEval-S at $0.0090 per correct** with full provenance.

## TL;DR

AgentOS memory composes six operations per turn, and the central design decision is *which* of them run on a given query.

Three classifier calls per turn (sharing one classification pass). A canonical hybrid retrieval pipeline: BM25 + dense + Cohere rerank-v3.5. A six-signal cognitive composite scorer on top of the rerank. An Ebbinghaus decay loop running in the background. A consolidation pass that prunes, merges, and re-strengthens traces while the agent is otherwise quiet. Underneath, a portable SQL brain — [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter) — that runs on SQLite (better-sqlite3), Postgres (pg + pgvector), IndexedDB (sql.js, browser/PWA), Capacitor SQLite (iOS/Android), Electron IPC, or in-memory, without a callsite change.

Same code, six backends, six judgement points per turn, one set of benchmarks: **85.6% on LongMemEval-S at $0.0090 per correct**, **70.2% on LongMemEval-M**.

| Headline | Number | Compared with |
|---|---|---|
| LongMemEval-S accuracy (gpt-4o reader, N=500) | **85.6%** [82.4%, 88.6%] | Mastra OM gpt-4o 84.23%, EmergenceMem Internal 86.0% (closed-source SaaS), Supermemory gpt-4o 81.6% |
| LongMemEval-S cost per correct | **$0.0090** | EmergenceMem Simple Fast measured $0.0581 (6.5x more) |
| LongMemEval-S p50 latency | **3,558 ms** | EmergenceMem Internal 5,650 ms |
| LongMemEval-M accuracy (1.5M-token haystacks, N=500) | **70.2%** [66.0%, 74.0%] | LongMemEval paper Top-5 round 65.7%, paper Top-10 round 72.0%, AgentBrain (closed) 71.7% |
| Open-source memory libraries on LongMemEval-M above 65% | **AgentOS only** | Every other vendor (Mem0, Mastra, Supermemory, Hindsight, Zep, EmergenceMem, MemMachine, agentmemory) publishes only the easier S variant |
| License | Apache-2.0 | EmergenceMem Internal closed SaaS, EmergenceMem Simple Fast no LICENSE file |

The next sections explain each piece, why it earned its place, and which adjacent ideas were tested and dropped.

> **Markdown memory (the LLM wiki).** This overview covers the vector and graph memory stack. For the markdown-as-source-of-truth model, where the agent reads and rewrites its own markdown knowledge base, see [Soul Files & the Markdown Memory Wiki](/features/soul-files).

---

## How it connects (60-second summary)

The whole stack is three small classifier calls plus a hybrid retriever, on top of a SQL-backed brain with a decay loop running in the background. Every concept that sounds like a separate thing in this doc plugs into one of those four parts.

![AgentOS memory pipeline: user query enters QueryClassifier (T0 short-circuits, T1+ proceeds), MemoryRouter picks retrieval architecture, canonical-hybrid retrieval runs BM25 + dense embeddings, fuses via RRF, then Cohere rerank-v3.5 cross-encoder, then a six-signal cognitive composite scorer (optional HyDE). Reranked traces feed ReaderRouter (gpt-4o vs gpt-5-mini) then ReadRouter (5 intents to 5 strategies) for the grounded answer. A background consolidation loop runs prune-merge-strengthen-derive-compact-reindex on the same brain, plus 8 cognitive mechanisms.](/img/diagrams/memory-system-overview.svg)

The verbatim archive is write-ahead — destructive consolidation ops cannot lose content unless the archive write succeeds first.

If a term in the doc below sounds new, here's where it plugs in:

| You hear... | It's the... | And it lives in... |
|---|---|---|
| **BM25 / FTS5** | lexical leg of canonical-hybrid | retrieval, runs over the brain's full-text index |
| **Cohere rerank-v3.5** | cross-encoder rerank pass after RRF merge | the most load-bearing retrieval signal; v4.0-pro tested and dropped |
| **HyDE** | hypothesis-then-embed retrieval mode | optional retrieval augmentation; on for M, off for S |
| **Six-signal composite** | the cognitive memory layer's scorer on top of similarity | encoding strength, recency, mood, graph, importance, similarity |
| **Ebbinghaus decay** | the forgetting curve that ages every trace | runs at retrieve time; consolidation prunes traces below threshold |
| **HEXACO modulation** | personality vector that biases encoding + retrieval weights | optional; runtime works personality-neutral by default |
| **Spreading activation (ACT-R)** | graph BFS that pulls in concept-adjacent traces | seeded by retrieval, augments the candidate pool |
| **OM-v10 / OM-v11** | observational-memory backends MemoryRouter can dispatch to | currently underperform canonical-hybrid in sem-embed era; preserved for cost-tolerant workloads |
| **LLM-as-judge** | how every router's classifier picks a category | one classifier call per query, shared across 3 routers |
| **Tiered presets** | shipped routing tables — `minimize-cost` / `balanced` / `maximize-accuracy` | calibrated from Phase B per-category cost-accuracy points |
| **Adaptive variant** | [`AdaptiveMemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/adaptive.ts) self-calibrates from your workload | use when your category mix or reader differs from LongMemEval-S |
| **Storage substrate** | `@framers/sql-storage-adapter` — same brain code, multiple backends | SQLite default, Postgres / IndexedDB / Capacitor / Electron all swap in |
| **Eight cognitive mechanisms** | optional neuroscience-grounded layers (RIF, gist, schema, etc.) | each maps to a published paper; HEXACO-modulated; individually toggleable |

The deep sections below trace each of those into the actual code paths and the Phase B run JSONs that justify the choice.

---

## What AgentOS Memory Actually Is

A "memory library" can mean very different things. AgentOS ships:

1. A **storage substrate** (`Memory.createSqlite()` / `Memory.createPostgres()` / `Memory.createWithAdapter()`): traces, embeddings, FTS5 (or Postgres tsvector + GIN) index, knowledge graph, memory graph, retrieval feedback, consolidation log, and an optional verbatim archive — all sitting on top of [`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter). The adapter auto-selects the best backend per runtime (better-sqlite3 on Node, sql.js+IndexedDB in the browser, Capacitor SQLite on mobile, Postgres in production, in-memory for tests) so the same brain code runs everywhere. Zero infrastructure for the SQLite default, scales to multi-tenant Postgres without rewriting a callsite.
2. A **cognitive layer** ([`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts)): personality-modulated encoding, Ebbinghaus decay, Baddeley working memory, ACT-R spreading activation, six-signal retrieval scoring, optional observer/reflector pipelines for conversation compression.
3. A **classifier-driven orchestration layer** (the Cognitive Pipeline): three small `gpt-5-mini` classifier calls share one classification pass to route every message through the cheapest, most accurate path for that specific query.
4. A **benchmark harness** ([`@framers/agentos-bench`](https://github.com/framerslab/agentos-bench)): the same primitives, run against LongMemEval-S, LongMemEval-M, LOCOMO, BEAM, and a battery of cognitive-mechanism micro-benchmarks. Per-case run JSONs at fixed seed, 95% confidence intervals from 10k bootstrap resamples, judge false-positive-rate probes per benchmark.

Most "memory libraries" stop at layer 1 with a vector index pinned to one backend. AgentOS treats backend portability and orchestration (layer 3) as first-class, which is where it pulls ahead on the cost-accuracy frontier without sacrificing reproducibility or deployment flexibility.

---

## The Storage Substrate ([`@framers/sql-storage-adapter`](https://www.npmjs.com/package/@framers/sql-storage-adapter))

The brain doesn't speak SQLite directly. It speaks [`IStorageAdapter`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/EmergentToolRegistry.ts), an abstraction over six concrete backends that auto-selects per runtime:

| Adapter | Package | Where it runs | Use case |
|---|---|---|---|
| `better-sqlite3` | `better-sqlite3` | Node, Electron, CLI | Local agents, dev, CI, single-process production |
| `postgres` | `pg` (with `pgvector`) | Hosted Postgres, RDS, Supabase | Multi-tenant SaaS, shared connection pools, fan-out |
| `electron` | bundled | Electron desktop apps | IPC bridge between main/renderer, multi-window WAL, auto-migrations |
| `indexeddb` | bundled (sql.js wrapper) | Browsers, PWAs | Offline-first web apps with 50 MB to 1 GB+ quota |
| `sqljs` | `sql.js` | Browsers, edge runtimes, native fallback | Pure WASM SQLite, no native deps, ephemeral by default |
| `capacitor` | `@capacitor-community/sqlite` | iOS, Android | Native mobile SQLite with optional encryption |
| `memory` | built-in | Unit tests, sandboxes | Zero-dependency, single-process, non-durable |

`createDatabase()` inspects environment signals (`window.indexedDB`, `process.versions.electron`, `Capacitor`, etc.) and picks the best adapter. Override by env var (`STORAGE_ADAPTER=postgres`) or by explicit priority list:

```ts
const db = await createDatabase({ priority: ['better-sqlite3', 'sqljs'] });
```

### How memory plugs into the adapter

Three entry points on the [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) class:

```ts
import { Brain } from '@framers/agentos/memory';

// 1. Default — SQLite file per agent
const sqliteBrain = await Brain.openSqlite('./brain.sqlite');

// 2. Postgres for multi-tenant production
const pgBrain = await Brain.openPostgres(
  'postgresql://user:pass@host:5432/db',
  { brainId: 'companion-alice', poolSize: 10 },
);

// 3. Bring your own adapter (share connection pool with the rest of your app)
import { createDatabase } from '@framers/sql-storage-adapter';
const adapter = await createDatabase({
  postgres: { connectionString: process.env.DATABASE_URL },
});
const sharedBrain = await Brain.openWithAdapter(adapter, { brainId: 'companion-alice' });
```

Three things the adapter abstracts away so the brain code stays identical:

1. **SQL Dialect.** `INSERT OR IGNORE`, `json_extract(...)`, `ifnull(...)`, `PRAGMA` get translated automatically between SQLite and Postgres via the [`SqlDialect`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/dialect.ts) interface. The brain writes one set of queries; the dialect rewrites them per backend.
2. **Full-text search.** [`IFullTextSearch`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/fts.ts) abstracts FTS5 (SQLite Porter tokenizer) and tsvector + GIN (Postgres) behind one `createIndex` / `matchClause` / `rankExpression` / `rebuildCommand` API. The hybrid retriever's BM25 lexical leg works on both backends without branching.
3. **BLOB codec.** Embeddings are stored as raw `Float32Array` BLOBs. [`NodeBlobCodec`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/codecs/NodeBlobCodec.ts) uses `Buffer`; [`BrowserBlobCodec`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/codecs/BrowserBlobCodec.ts) uses `DataView`. The 1536-dim `text-embedding-3-small` vector takes ~6 KB per trace on disk and round-trips byte-identical across backends.

### Multi-tenant Postgres mode

In Postgres mode every brain-owned table carries a `brain_id` discriminator:

```sql
CREATE TABLE memory_traces (
  brain_id    TEXT  NOT NULL,
  id          TEXT  NOT NULL,
  type        TEXT  NOT NULL,
  scope       TEXT  NOT NULL,
  content     TEXT  NOT NULL,
  embedding   BYTEA,
  ...
  PRIMARY KEY (brain_id, id)
);
```

Two brains in the same database stay isolated by the discriminator. SQLite mode skips the column because each brain has its own file.

The first call to `Brain.openPostgres` (or `openSqlite`) on an existing v1 database runs an idempotent v1→v2 migration that adds `brain_id` to every brain-owned table and updates primary keys to `(brain_id, id)`. Postgres uses `ALTER TABLE ADD COLUMN` + `ALTER TABLE ADD PRIMARY KEY`; SQLite uses the recreate-table dance. Subsequent opens are no-ops.

A `pg_advisory_xact_lock` per `brainId` serializes concurrent first-opens so two workers booting the same brain don't race on schema migration.

### Pool sizing

Sharing a [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) across N brains shares the underlying connection pool. Five brains opened against a `max: 10` pool compete for the same 10 connections; one slow query starves the others. Size for total concurrent query load across all brains, not per-brain. For high-fan-out deployments (one process serving 50+ active brains), use a dedicated pool per brain via `Brain.openPostgres(connStr, { brainId, poolSize: N })` instead of sharing.

### Portable export and import

Live storage and portability are decoupled. Run Postgres in production, snapshot to SQLite for backup or fork:

```ts
const liveBrain = await Brain.openPostgres(connStr, { brainId: 'alice' });
await liveBrain.exportToSqlite('/tmp/alice-snapshot.sqlite');

// Later, fork into a different brain (importing rewrites brain_id)
const forkBrain = await Brain.openPostgres(connStr, { brainId: 'alice-fork' });
await forkBrain.importFromSqlite('/tmp/alice-snapshot.sqlite');
```

The adapter's [`IDatabaseExporter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/exporter.ts) ships [`SqliteFileExporter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/exporters/SqliteFileExporter.ts) (`VACUUM INTO`) and [`PostgresExporter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/exporters/PostgresExporter.ts) (`pg_dump`) for backend-native export paths.

### Why this matters for the benchmarks

Every LongMemEval-S / LongMemEval-M run in the bench uses the SQLite adapter because the bench is a single-process harness measuring a single brain at a time. The same brain code runs over Postgres in production deployments (Wilds.ai, Paracosm, this voice-chat-assistant repo). The SQL dialect translation, full-text search abstraction, and BLOB codec are designed to preserve query semantics across backends, so retrieval-quality metrics (recall@K, NDCG@K, MRR) are expected to transfer; latency floors differ (Postgres has higher per-query network overhead than embedded SQLite, but scales horizontally on connection count where SQLite serializes).

For the full adapter architecture, capability matrix, and lifecycle hooks, see [`@framers/sql-storage-adapter`](https://github.com/framerslab/sql-storage-adapter) (README, `ARCHITECTURE.md`, `PLATFORM_STRATEGY.md`).

---

## The End-to-End Flow

```mermaid
flowchart TB
    subgraph ingest["INGEST"]
        direction TB
        I1["new content"]:::input
        I2["IngestRouter<br/><i>kind classifier</i>"]:::process
        I3["Memory store + archive + graph"]:::data
        I4["Consolidation Loop<br/><i>6 steps + 8 cognitive mechanisms</i>"]:::process
        I1 --> I2 --> I3
        I3 -. background .-> I4
    end

    subgraph recall["RECALL"]
        direction TB
        R1["user query"]:::input
        R2["QueryClassifier<br/><i>T0 / T1 / T2 / T3</i>"]:::process
        R3["context-only<br/><i>skips memory</i>"]:::output
        R4["MemoryRouter<br/><i>category → backend</i>"]:::process
        R5["canonical-hybrid retrieval<br/><i>BM25 + dense + Cohere rerank</i>"]:::process
        R6["scored evidence chunks"]:::data
        R1 --> R2
        R2 -- T0 --> R3
        R2 -- T1+ --> R4
        R4 --> R5 --> R6
    end

    subgraph read["READ"]
        direction TB
        D1["query + evidence"]:::input
        D2["ReaderRouter<br/><i>gpt-4o (TR/SSU) vs gpt-5-mini</i>"]:::process
        D3["ReadRouter<br/><i>intent → strategy</i>"]:::process
        D4["grounded answer"]:::output
        D5["Output guardrails<br/><i>(separate)</i>"]:::external
        D1 --> D2 --> D3 --> D4 --> D5
    end

    R6 --> D1

    classDef input fill:#cffafe,stroke:#0891b2,color:#0e7490
    classDef process fill:#eef2ff,stroke:#6366f1,color:#3730a3
    classDef data fill:#fef3c7,stroke:#f59e0b,color:#92400e
    classDef output fill:#dcfce7,stroke:#10b981,color:#047857
    classDef external fill:#f3e8ff,stroke:#8b5cf6,color:#5b21b6
```

Three classifier calls happen during a query (one in QueryClassifier, one in MemoryRouter, one in ReadRouter), but Stages 2 and 3 reuse Stage 1's classification, so the realized cost is **one classifier call per query** plus the retrieval and reader calls. Trivial queries (greetings, small talk, questions answerable from context alone) terminate at Stage 1 with no retrieval.

---

## Stage 0: Ingest

[`IngestRouter`](./INGEST_ROUTER.md) classifies incoming content into one of six kinds and picks an ingest strategy:

| Content kind | Typical strategy | Cost (illustrative) |
|---|---|---:|
| short-conversation (1-3 turns) | `raw-chunks` | $0.0001 |
| long-conversation (extended thread) | `observational` | $0.020 |
| long-article (blog, paper) | `summarized` (Anthropic contextual retrieval) | $0.005 |
| code (source files, configs) | `summarized` | $0.005 |
| structured-data (CSV, JSON) | `raw-chunks` | $0.0001 |
| multimodal | `hybrid` (text representation indexed; modality embeddings optional) | $0.030 |

Why this matters: a 3-turn chat snippet does not justify the LLM cost of observation extraction. A 50-turn customer support thread does. Picking the wrong strategy at ingest costs accuracy or money downstream. The bench's Phase B sweeps showed `observational` ingest on short conversations regresses on every category and pays a 200x cost premium for nothing.

The strategies map to canonical patterns in the literature:

- `summarized` is Anthropic's [contextual retrieval](https://www.anthropic.com/news/contextual-retrieval) (every chunk prepended with a dense session/document summary before embedding).
- `observational` is Mastra's [Observational Memory](https://mastra.ai/research/observational-memory) (LLM-extracted observation log replacing raw turns).
- `fact-graph` is the original Mem0 v2 / Hindsight pattern (typed entity-relation graph + facts).
- `hybrid` runs raw + summarized + observational in parallel for cost-tolerant workloads with heterogeneous retrieval needs.
- `skip` discards content entirely (used for ephemera that should not enter long-term memory).

---

## Stage 1: QueryClassifier (the memory-or-not gate)

[`QueryClassifier`](./QUERY_ROUTER.md) is the novel piece most memory libraries skip. It assigns every incoming query a tier:

| Tier | Meaning | What runs |
|---|---|---|
| T0 | answerable from context alone | no retrieval, no embedding, no rerank |
| T1 | simple recall | shallow retrieval (top-K small, no rerank if cheap) |
| T2 | moderate recall | full canonical-hybrid retrieval |
| T3 | complex synthesis | full retrieval plus optional GraphRAG / multi-hop |

T0 is the load-bearing decision. Greetings, small talk, general-knowledge questions ("what's 2+2"), and questions whose answer is already in the running context window do not need to touch the memory database. Skipping retrieval for those queries saves the embedding cost, the rerank cost, and reduces the answer latency from ~3.5s to whatever the reader's TTFT is.

The classifier is a `gpt-5-mini` call with corpus topics, recent conversation history, and optional tool names in context. Live demonstration: see the QueryRouter initialize a 1,720-chunk corpus across 50 topics and 333 sources on the [agentos.sh demo gallery](https://agentos.sh/#live-demo).

---

## Stage 2: MemoryRouter (architecture dispatch)

[`MemoryRouter`](./MEMORY_ROUTER.md) decides, per T1+ query, which retrieval architecture handles it. Three backends ship:

| Backend ID | What it does |
|---|---|
| `canonical-hybrid` | BM25 + dense embedding + RRF merge + Cohere rerank-v3.5 over the cognitive-memory composite score |
| `observational-memory-v10` | gpt-5-mini per-question classifier routes to canonical for single-session/temporal questions and to v5 Observational Memory ingest for knowledge-update/multi-session |
| `observational-memory-v11` | v10 plus a conditional verbatim citation rule appended to the OM reader prompt for `knowledge-update` and `single-session-user` categories |

The classifier emits one of six query categories, each captured from LongMemEval's category taxonomy:

- `single-session-user` (SSU): a fact stated by the user in one session ("what's my email?")
- `single-session-assistant` (SSA): a fact the assistant said in one session
- `single-session-preference` (SSP): a stated preference ("I prefer dark mode")
- `knowledge-update` (KU): a fact that changed over time ("what's my current job title?")
- `multi-session` (MS): a fact requiring synthesis across sessions ("what topics did we discuss?")
- `temporal-reasoning` (TR): time-arithmetic questions ("how many days since X?")

Why route at all: per-category Phase B N=500 measurements show different architectures dominate different categories. Flat "always canonical-hybrid" loses 6.8 pp on multi-session. Flat "always OM-v11" loses 5.4 pp on single-session-assistant and pays a 1.7-1.8x cost premium on every other category. Per-query routing extracts the best of both.

### Three shipping presets

| Preset | Strategy | Result on LongMemEval-S Phase B N=500 |
|---|---|---|
| `minimize-cost` | cheapest Pareto-dominant per category. Originally MS+SSP routed to OM-v11 under the CharHash-era calibration. | 76.6% / $0.058 per correct (CharHash baseline) |
| `balanced` | trade 1.6x cost for 10x latency wins on KU/TR | 74.5% / $0.205 per correct (sim) |
| `maximize-accuracy` | highest-accuracy backend per category | 75.6% / $0.243 per correct |

The current production-validated config, however, is **canonical-hybrid for every category** paired with the ReaderRouter and `text-embedding-3-small`. That hits 85.6% at $0.0090 per correct, which is +9 pp above the `minimize-cost` CharHash baseline because:

1. Wiring `text-embedding-3-small` instead of the bench's CharHash fallback. CharHash is a lexical-hash stub the bench falls back to when no embedder is configured. It is not the documented production path. Real consumers wire a real embedder; doing so on the same router lifts the same row from 76.6% to 83.2% (an extra +6.6 pp, concentrated on temporal-reasoning +14.5 pp and multi-session +14.5 pp, where semantic retrieval finds paraphrase-rich and multi-hop bridges that lexical hashing missed).
2. Dropping the `minimize-cost` preset's MS+SSP-to-OM-v11 routing in favor of canonical-hybrid for all categories, paired with Stage 3 ReaderRouter dispatch. At gpt-4o reader, OM-v11 routing produces a mixed per-category effect: it costs SSP 13.4 pp (63.3% on OM-v11 vs 76.7% canonical) and gains MS 4 pp. The case-weighted aggregate favors canonical because SSP's 13.4 pp loss outweighs MS's 4 pp gain, and OM-v11's per-session observer pipeline imposes 60-120 seconds per OM-routed case, producing a 111,535 ms p95 in the prior 84.8% headline. Without OM-v11 routing, p95 drops to 7,264 ms (15.4x faster on the tail).

For sem-embed deployments, use canonical-only plus ReaderRouter. The `minimize-cost` preset table targets CharHash retrieval and shouldn't be used in sem-embed mode.

### Self-calibrating variant

[`AdaptiveMemoryRouter`](./ADAPTIVE_MEMORY_ROUTER.md) takes a calibration sample list and derives the routing table from your own workload. Use it when:

1. Your category distribution diverges from LongMemEval-S.
2. Your reader, judge, or cost profile differs.
3. You want the router to optimize for YOUR per-category cost-accuracy points instead of a static table baked from someone else's measurement.

Three preset rules: `minimize-cost` (cheapest backend within a 2pp accuracy tolerance of the best), `balanced` (best $/correct ratio), `maximize-accuracy` (highest meanAccuracy, ties broken by lower cost). 50-200 samples per (category, backend) cell are enough.

---

## Stage 3: ReaderRouter and ReadRouter (read-stage dispatch)

Two sibling primitives, both at the read stage, both classifier-driven, both orthogonal. They compose: ReaderRouter picks the model, ReadRouter picks the strategy that model follows.

### ReaderRouter (model dispatch)

[`ReaderRouter`](./READ_ROUTER.md#reader-router--reader-model-selection) reuses Stage 2's category classification (zero extra LLM calls) to dispatch the answer call to the best reader for that category. Calibrated from per-category Phase B accuracies:

| Category | Best gpt-4o accuracy | Best gpt-5-mini accuracy | Pick |
|---|---:|---:|---|
| temporal-reasoning (TR) | 86.5% | 80.5% | gpt-4o (long-context arithmetic) |
| single-session-user (SSU) | 95.7% | 90.0% | gpt-4o (exact recall) |
| single-session-assistant (SSA) | 96.4% | 100% | gpt-5-mini |
| single-session-preference (SSP) | 76.7% | 86.7% | gpt-5-mini (+10 pp on SSP alone) |
| knowledge-update (KU) | 88.5% | 91.0% | gpt-5-mini |
| multi-session (MS) | 78.2% | 74.4% | gpt-5-mini (cost-Pareto, 12x cheaper) |

The shipping `min-cost-best-cat-2026-04-28` preset routes 53% of LongMemEval-S queries to gpt-5-mini and 47% to gpt-4o. The single-session-preference lift alone is +23.4 pp on a reader-tier swap (63.3% gpt-4o → 86.7% gpt-5-mini at the same retrieval).

### ReadRouter (strategy dispatch)

[`ReadRouter`](./READ_ROUTER.md#read-router--read-strategy-selection) classifies a query+evidence pair into a read intent and picks a reader strategy:

| Intent | Strategy | Why |
|---|---|---|
| precise-fact | `single-call` | one reader call; clear evidence rules out ambiguity |
| multi-source-synthesis | `two-call-extract-answer` | claim extraction call followed by answer call (Emergence Simple Fast pattern) reduces distractor influence |
| time-interval | `scratchpad-then-answer` | explicit reasoning scratchpad for date arithmetic before the commit |
| preference-recommendation | `verbatim-citation` | quote the user's stated preference verbatim |
| abstention-candidate | `commit-vs-abstain` | binary commit/abstain gate before the answer attempt |

ReadRouter ships its own `precise-fact`, `synthesis`, and `temporal` presets. Workloads heavy in time-interval questions pick `temporal`; multi-doc Q&A picks `synthesis`.

---

## Inside Canonical-Hybrid Retrieval

Stage 2's default backend is the production retrieval pipeline:

```
Query
  │
  ▼  expand to lexical and semantic
┌─────────────┐                          ┌─────────────┐
│ BM25 search │                          │ Embed query │
│  (FTS5)     │                          │ (text-      │
│             │                          │  embedding- │
│             │                          │  3-small)   │
└──────┬──────┘                          └──────┬──────┘
       │ top-K candidates                       │
       ▼                                        ▼
       └─── RRF merge (rank fusion) ────────────┘
                       │
                       ▼  candidate pool (multiplier x5 by default)
       ┌──────────────────────────────────────┐
       │ Cohere rerank-v3.5 cross-encoder      │
       │ scores every (query, candidate) pair  │
       └──────────────────────┬───────────────┘
                              │  top-K rerank winners
                              ▼
       ┌──────────────────────────────────────┐
       │ Six-signal composite scorer (cognitive│
       │ memory layer, optional)               │
       │  • similarity (rerank score)          │
       │  • encoding strength                  │
       │  • recency (Ebbinghaus age)           │
       │  • emotional congruence (PAD mood)    │
       │  • graph activation (ACT-R BFS)       │
       │  • importance                         │
       └──────────────────────┬───────────────┘
                              │  reranked top-K
                              ▼
                          to reader
```

### Why each retrieval signal earns its place

- **BM25 + dense embedding fusion**: BM25 catches rare terms and exact matches that dense embeddings miss; dense embeddings catch paraphrase-rich and multi-hop bridges that BM25 misses. RRF (Reciprocal Rank Fusion) merges the two ranked lists without per-corpus tuning.
- **Cohere rerank-v3.5 cross-encoder**: this is the load-bearing one. The cross-encoder reads (query, candidate) jointly and reranks the merged candidate pool. Without it, top-K from BM25+dense alone misses bridge sessions and gets diluted by topically adjacent but irrelevant chunks. Cohere rerank-v3.5 sits on the cost-accuracy frontier; **rerank-v4.0-pro was tested at full N=500 and regresses 1.0 pp at point estimate while costing more per call** (see Negative Findings below).
- **Six-signal composite**: the cognitive memory layer adds five signals on top of similarity. Encoding strength rewards traces that were attended-to at write time. Recency enforces Ebbinghaus decay. Emotional congruence biases toward memories that match the agent's current mood. Graph activation pulls in concept-adjacent traces via ACT-R spreading activation. Importance reflects explicit annotation or derived heuristics.

The composite is HEXACO-modulated when personality is configured. High Openness raises the graph-activation weight (concept-adjacent retrieval). High Conscientiousness raises the importance weight (rule-following retrieval). Low Emotionality flattens the emotional-congruence weight.

### Embedder choice

`text-embedding-3-small` is the validated production default. Phase B negative finding: `text-embedding-3-large` (3072-dim) regresses 2.2 pp on accuracy AND adds a 20x latency catastrophe (avg 81,195 ms vs 4,001 ms baseline; p50 23x slower; p95 19x slower). Recall@10 is 0.984 vs 0.981 for `text-embedding-3-small`, so the larger embedding does not meaningfully lift retrieval recall on this benchmark; canonical-hybrid + Cohere rerank already saturates retrieval at the smaller model. Bigger embeddings cost compute for no benefit on this stack.

### HyDE (Hypothetical Document Embedding)

[`HydeRetriever`](./memory/HYDE_RETRIEVAL.md) is an optional retrieval mode based on Gao et al. 2023. Instead of embedding the raw query, HyDE first asks an LLM to produce a plausible answer, then embeds the *hypothesis* and searches against that. The intuition is that questions and answers live in different regions of embedding space; a hypothesized answer is closer to stored answer-form documents than the original question is.

HyDE is a Pareto-cost win on LongMemEval-M temporal-reasoning (+3.7 pp at Phase B). It is **not** a win on LongMemEval-S or LongMemEval-M multi-session: at S scale the canonical pipeline already saturates retrieval and HyDE dilutes the rerank pool with hallucinated chunks; at M scale on multi-session, HyDE alone regressed 52.2 pp at Phase A (CIs do not overlap with the baseline) because hypothetical-document chunks displace the real bridge sessions below the top-K cutoff.

Recommended use: enable HyDE only on temporal-reasoning queries, or at ingest time for knowledge-base material where the answer phrasing differs systematically from question phrasing.

---

## The Cognitive Memory Layer

The standalone `Memory` facade is sufficient for any TypeScript app that needs persistent retrieval. The cognitive layer wraps it for agents that benefit from personality-modulated encoding, decay, and consolidation.

### Encoding (write time)

Every trace is created with a [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SelfEvaluateTool.ts) shape that records:

- the content
- the embedding
- the source (which agent, which session, which message)
- the encoding timestamp
- an `encodingStrength` in [0, 1] modulated by:
  - the agent's HEXACO traits at encoding time (Conscientiousness raises strength on policy-relevant content; Openness raises it on novel content)
  - the agent's current PAD mood (Pleasure/Arousal/Dominance from Mehrabian's Pleasure-Arousal-Dominance model)
  - the emotional intensity of the moment (Brown & Kulik's flashbulb-memory model: high-emotion events get 2x strength and 5x stability multipliers)
  - the Yerkes-Dodson arousal curve (encoding quality peaks at moderate arousal in an inverted U)

`encodingStrength` plus a per-trace `stability` parameter feed into the Ebbinghaus forgetting curve.

### Decay (read time)

Strength decays exponentially with time on Hermann Ebbinghaus's 1885 forgetting curve:

```
S(t) = S₀ · e^(-Δt / stability)
```

`stability` is the half-life parameter. Successful retrieval grows stability (the desirable-difficulty effect: harder retrievals consolidate more). Co-retrieval of two traces tightens the edge between them via Hebbian weight updates ("neurons that fire together wire together"). The retrieval-feedback signal (used vs ignored) feeds the Strengthen step of the consolidation loop.

When decay drops a trace below `pruneThreshold` (default 0.05), the consolidation loop soft-deletes it. Emotional memories with intensity > 0.3 are protected from pruning regardless of strength. This matches the empirical finding that high-arousal memories persist longer than neutral ones (Cahill & McGaugh, 1998; LaBar & Cabeza, 2006).

### Working memory (Baddeley slots)

The runtime enforces a slot-based working-memory capacity following Baddeley's model. The default is `7±2` slots, modulated by HEXACO traits: Conscientiousness raises the floor, Honesty-Humility narrows the range. Each slot has its own activation level that decays per turn unless re-attended.

When the working memory is full, the lowest-activation slot is evicted (or written through to long-term memory if its strength exceeds a threshold). This implements the Atkinson-Shiffrin (1968) sensory→working→long-term pipeline directly.

### Spreading activation (ACT-R)

The memory graph stores edges between traces (same-session, same-entity, co-retrieved, derived-from). When a query retrieves a seed trace, the graph traversal performs a BFS up to `maxDepth` (default 2) with activation decay per hop. The activated set is added to the candidate pool before reranking.

Spreading activation is what makes "the thing that's adjacent in concept-space, not just adjacent in vector-space" work. Pure vector retrieval misses entity-linked but vocabulary-divergent traces. ACT-R-style activation finds them through the graph structure.

### Six-signal retrieval scoring

When the cognitive layer is active, the final retrieval score is a weighted composite:

```
score = w_sim · cosine(query, trace)
      + w_str · trace.encodingStrength
      + w_rec · ebbinghausDecayedRecency(trace)
      + w_emo · padCongruence(trace.mood, agent.currentMood)
      + w_grp · spreadingActivation(trace, queryEntities)
      + w_imp · trace.importance
```

Default weights are calibrated from LongMemEval-S Phase B sweeps. HEXACO modulation overrides the defaults.

---

## The Eight Cognitive Mechanisms

On top of the encoding/decay/retrieval substrate, the runtime ships eight optional neuroscience-grounded mechanisms. Each is HEXACO-personality-modulated and individually configurable via `cognitiveMechanisms` on [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts).

### Retrieval-time (synchronous)

| Mechanism | Effect | Reference |
|---|---|---|
| Reconsolidation | Mutates `trace.emotionalContext` on access; the trace's emotional valence drifts toward the agent's current mood | Nader, Schafe & LeDoux 2000 |
| Retrieval-induced forgetting (RIF) | Suppresses the stability of competitor traces that were retrieved-but-not-cited | Anderson, Bjork & Bjork 1994 |
| Involuntary recall | With small probability (default 1%), surfaces a random unretrieved memory alongside the deliberate retrieval set | Berntsen 2009 |
| Metacognitive feeling-of-knowing (FOK) | Detects when the retrieval cutoff is too tight (multiple candidates at similar scores near the boundary) and emits a signal the host can use to widen retrieval | Koriat 1993 |

### Consolidation-time (background)

| Mechanism | Effect | Reference |
|---|---|---|
| Temporal gist | Compresses verbatim content into a dense gist after a configurable retention window; preserves verbatim in archive on demand | Reyna & Brainerd 1995 (fuzzy-trace theory) |
| Schema encoding | Detects schema-congruent traces against cluster centroids and encodes them with elevated strength | Bartlett 1932; Anderson 1981 |
| Source confidence decay | Decays `trace.stability` at different rates per source type (user > assistant > tool-output > inferred) | Johnson, Hashtroudi & Lindsay 1993 source-monitoring framework |
| Emotion regulation | Reappraises high-arousal traces over time (suppression and reappraisal pathways from Gross's emotion-regulation model) | Gross 1998 |

The flashbulb-immunity guard skips reconsolidation, RIF, temporal gist, and emotion regulation on traces with `encodingStrength >= 0.9`. The dead-trace guard skips RIF on traces with `encodingStrength < 0.1`. Disabled mechanisms return immediately.

---

## Memory Consolidation (the background loop)

[`ConsolidationLoop`](./memory/MEMORY_CONSOLIDATION.md) is the analogue of slow-wave sleep: background maintenance that prunes, merges, strengthens, derives, compacts, and reindexes. It runs in 6 (now 7) ordered steps with a boolean mutex preventing concurrent runs.

| Step | Action | LLM required |
|---|---|---|
| 1. Prune | Soft-delete traces below `pruneThreshold`. Emotional memories (intensity > 0.3) protected. | No |
| 2. Merge | Deduplicate near-identical traces (cosine ≥ 0.95 with `embedFn`, or SHA-256 content match without). Tags unioned, older trace soft-deleted with a survivor reference. | No |
| 3. Strengthen | Read retrieval-feedback co-usage signals; record `CO_ACTIVATED` Hebbian edges in the memory graph (learning rate 0.1). | No |
| 4. Derive | Detect clusters of related memories (`detectClusters`, min size 5); LLM-synthesize a higher-level insight trace per cluster as `type: 'semantic'`. Bounded by `maxDerivedPerCycle` (default 5). Skipped entirely without an LLM invoker. | Yes |
| 5. Compact | Episodic-to-semantic migration: traces older than 7 days with retrieval count >= 3 change `type` to `semantic`. | No |
| 6. Re-index | Rebuild the FTS5 full-text index over `memory_traces`. Log the consolidation run. | No |
| 7. Prune Archive | Sweep archived traces past their retention age (default 365 days), respecting recent rehydration access. | No |

The verbatim archive is **write-ahead**: any mechanism that would lose verbatim content (Step 5 compact, the temporal-gist mechanism) calls `archive.store()` and awaits success before mutating the trace. If the archive write fails, the destructive operation aborts. Rehydration (`archive.rehydrate(traceId)`) returns the original on demand without boosting encoding strength or incrementing retrieval count.

[`SqlStorageMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts) wraps the same `@framers/sql-storage-adapter` interface as the brain, so archive tables (`archived_traces`, `archive_access_log`) live in the same database file by default. Postgres, IndexedDB, Capacitor SQLite, and sql.js are all supported through the shared adapter substrate (see [The Storage Substrate](#the-storage-substrate-framerssql-storage-adapter) above).

---

## Multimodal RAG

AgentOS's core RAG APIs are text-first. Multimodal support is a composable pattern on top:

1. Store the **binary asset** (optional) plus metadata in `media_assets`.
2. Derive a **text representation**: caption (image), transcript (audio), OCR (scanned doc), or extracted text (PDF, DOCX, HTML, Markdown, CSV).
3. Index the derived text as a normal RAG document so the existing retrieval pipeline (vector, BM25, reranking, GraphRAG, HyDE) operates without any "special" multimodal database.
4. Optionally add **modality-specific embeddings** (image-to-image, audio-to-audio) as an acceleration path.

The unified `retrievalMode` contract supports `auto` (text-first plus native modality when available), `text` (derived text only), `native` (modality embeddings only), and `hybrid` (fuse both). Query-by-image and query-by-audio go through the same flow: derive text from the query (caption/transcript/OCR), then route through the standard pipeline, with optional modality-native nearest-neighbor as a fast path.

This is a strong production baseline, not a claim to ship the full current frontier of multimodal retrieval research. Direct visual late-interaction retrievers and page-native document retrieval remain follow-up work.

---

## How the 85.6% Was Earned (Decomposition of the Lift)

Starting from the prior 76.6% headline (Tier 3 minimize-cost preset, CharHashEmbedder fallback, no reader router), the path to 85.6% decomposes into three independent contributions:

| Step | Lift | What changed |
|---|---:|---|
| 1. Wire `text-embedding-3-small` instead of CharHashEmbedder | +6.6 pp | TR +14.5 pp, MS +14.5 pp; semantic embedding finds paraphrase-rich and multi-hop bridges that lexical hashing missed |
| 2. Drop OM-v11 routing, route everything through canonical-hybrid | +1.0 pp at gpt-4o reader | Avoids the SSP -13.4 pp loss from OM routing while accepting -4 pp on MS at gpt-4o (that gets recovered in step 3) |
| 3. Add ReaderRouter dispatch (gpt-5-mini for SSA/SSP/KU/MS, gpt-4o for TR/SSU) | +1.4 pp | SSP +10 pp dominates: 86.7% gpt-5-mini vs 76.7% gpt-4o on canonical |
| **Total** | **+9.0 pp** (76.6 → 85.6) | |

**Cost-Pareto improvements at the same accuracy delta:**

- 4.6x cheaper per correct ($0.0410 → $0.0090) by dropping OM-v11's per-session observer pipeline and routing to gpt-5-mini for 53% of queries.
- 5.3x faster average latency (21,042 ms → 4,001 ms) for the same reason.
- 15.4x faster p95 latency (111,535 ms → 7,264 ms): OM-v11 routing imposed 60-120 seconds per OM-routed case as the per-session observer pipeline ran; canonical-only avoids that tail entirely.

The configuration was stress-tested with 7 adjacent knobs at full Phase B: every adjacent setting (`--reader-top-k 30`, `--hyde`, `--rerank-candidate-multiplier 5`, `--retrieval-config-router minimize-cost-augmented`, `--policy-router-preset balanced`, `--policy-router-preset maximize-accuracy`, `text-embedding-3-large`) regresses. The 85.6% configuration is empirically Pareto-optimal in the tested parameter space.

---

## How the 70.2% on M Was Earned

LongMemEval-M's haystacks exceed every production LLM context window (1.5M tokens > GPT-4o's 128K). Retrieval saturates differently than at S scale: smaller chunk pools per session, more sessions per haystack, and a much harder multi-session bridge problem.

The M-tuned headline configuration:

```bash
NODE_OPTIONS="--max-old-space-size=8192" pnpm exec tsx src/cli.ts run longmemeval-m \
  --reader gpt-4o \
  --memory full-cognitive --replay ingest \
  --hybrid-retrieval --rerank cohere \
  --embedder-model text-embedding-3-small \
  --reader-router min-cost-best-cat-2026-04-28 \
  --reader-top-k 5 \
  --concurrency 5 \
  --bootstrap-resamples 10000
```

Key M-specific knobs:

- **`--reader-top-k 5`** (was 50 in the prior 57.6% headline). The single biggest M-specific lift: +12.6 pp from 57.6% to 70.2%. Wider top-K dilutes the reader prompt with topically adjacent but irrelevant sessions; M's session count (500 per haystack) means the rerank pool already over-prunes, and feeding 50 chunks to the reader introduces more noise than signal.
- **HyDE enabled** for multi-session bridge queries. Cost-Pareto win on TR; on M, ablation showed HyDE-off is within statistical noise of the headline (69.2% vs 70.2%), so HyDE is *cost-neutral* on M, not a clear win.
- **Cohere rerank-v3.5 candidate multiplier x5**. Wider candidate pool gives the cross-encoder more sessions to disambiguate among. At multiplier x10 (Phase B ablation), accuracy drops to 60.0% at higher cost.
- **Reader Router** picking gpt-5-mini for SSA/SSP/KU/MS, gpt-4o for TR/SSU. Same calibration as S.

Compared with the LongMemEval paper's GPT-4o configurations from [Wu et al., ICLR 2025, Table 3](https://arxiv.org/abs/2410.10813):

| Configuration | Accuracy |
|---|---:|
| Round-level Top-5 K=V+fact | 65.7% |
| Session-level Top-5 K=V+fact | 71.4% |
| Round-level Top-10 K=V+fact (paper's strongest) | 72.0% |
| **AgentOS at Top-5 reader budget** | **70.2%** |

AgentOS at Top-5 sits 4.5 above the round-level baseline (65.7%) and 1.2 below the session-level (71.4%). At the harder Top-5 reader budget, AgentOS is 1.8 below the paper's strongest GPT-4o result (72.0%, Top-10).

Among open-source memory libraries with publicly reproducible runs (per-case run JSONs at fixed seed, single-CLI reproduction), **AgentOS is the only one on the public record above 65% on M**. Every other vendor (Mem0 v3 93.4%, Mastra OM 84.2-94.9%, Hindsight 91.4%, Zep 71.2%, EmergenceMem 86%, Supermemory 81.6-85.2%, MemMachine 93%, Memoria 88.78%, agentmemory 96.2%, Backboard 93.4%, ByteRover 92.8%) publishes only the easier S variant. M's 1.5M-token haystacks exceed every production LLM context window, so vendors with prompt-stuffing or compression-based architectures avoid the variant.

---

## Negative Findings (What Was Tried and Dropped)

Every sentence above is paired with at least one Phase B negative finding that disqualifies the alternative. The 8 documented architecture-level negative findings:

| Probe | Outcome | Why dropped |
|---|---|---|
| Stage L Anthropic Contextual Retrieval at S | Within CI of canonical-hybrid baseline; no measurable lift | Pre-pending session summaries to every chunk did not extract retrieval signal not already captured by Cohere rerank |
| Stage I Mem0-v3-style entity-linking re-rank | Regressed 1-2 pp at Phase B | Entity-link extraction at re-rank time added latency without recall improvement on this category mix |
| Stage H hierarchical retrieval | Within CI; cost premium | Two-stage retrieval (session-level then chunk-level) didn't beat single-stage canonical |
| Two-call reader compounded with M-tuned | Regressed 11.6 pp on M (58.6% vs 70.2%) | Extract-then-answer adds reader cost without lifting M accuracy past Top-5 baseline |
| M-tuned flags compounded on S | Regressed | M-specific tuning (top-K=50, candidate x5, HyDE) over-prunes S's smaller chunk pool |
| All-OM Mastra-architecture clone on S | Regressed on SSP -13.4 pp | OM observer pipeline costs SSP accuracy at gpt-4o reader |
| gpt-4o classifier upgrade (vs gpt-5-mini) | Regressed 0.4-1.6 pp aggregate; +44% cost | More aggressive category re-categorization didn't help on this category mix |
| `text-embedding-3-large` (3072-dim) | -2.2 pp accuracy + 20x latency | Larger embedding does not lift recall at this stack |

Other Phase B negatives:

- **Cohere rerank-v4.0-pro** vs rerank-v3.5: -1.0 pp at point estimate, more expensive per call. Definitively dropped.
- **HyDE-on-MS-only S-tuned router** (pre-validation hypothesis): -52.2 pp on multi-session at S. HyDE alone hurts MS at every haystack scale; the dispatch primitive ships in source for future calibration but the HyDE-on-MS preset is refuted.
- **Wider rerank pool on MS-only at S** (`topk50-mult5-on-MS`): -41.1 pp on MS. At S scale the canonical pipeline is at the empirical accuracy ceiling for MS; broadening the candidate pool dilutes more than it helps. To push MS at S scale, the next architectural lever needs to be a different signal (typed graph traversal) or a model-tier swap (gpt-5 reader).
- **gpt-5 reader on TR/SSU**: Phase A small-sample lift (87.0% at N=54) compressed to -2.4 pp at full N=500. Definitively dropped.
- **`top-K 3`** on M: -5.0 pp vs Top-K=5. Floor on M reader-top-K is 5.
- **`rerank-candidate-multiplier 10`** on M: -10.2 pp vs multiplier x5. Wider candidate pool over-prunes M's session count.

Every dropped probe ships its run JSON under `agentos-bench/results/runs/` for independent inspection.

---

## Vendor Comparison and Caveats

Direct accuracy comparison (LongMemEval-S, gpt-4o reader, full N=500 except where noted):

| System | Accuracy | $/correct | p50 latency | License | Notes |
|---|---:|---:|---:|---|---|
| **AgentOS canonical-hybrid + ReaderRouter** | **85.6%** | **$0.0090** | **3,558 ms** | Apache-2.0 | This stack |
| EmergenceMem Internal | 86.0% | not published | 5,650 ms | closed-source SaaS | Hosted at emergence.ai; cannot install, fork, or self-host |
| Mastra OM gpt-4o (gemini-flash observer) | 84.23% | not published | not published | Apache-2.0 | -1.4 pp aggregate, but cross-provider observer pipeline |
| EmergenceMem Simple Fast (rerun in agentos-bench) | 80.6% | $0.0581 | 3,703 ms | no LICENSE file | Apache-2.0 grants no license to redistribute the upstream `main.py`; we measured it for accuracy comparison only |
| Supermemory gpt-4o | 81.6% | not published | not published | proprietary | -4.0 pp |
| Zep (self / independent reproduction) | 71.2% / 63.8% | not published | not published | varied | Self-reported number gamed; independent reproduction far below |

**Cross-provider numbers** are excluded from the headline cell because their methodology disclosures don't admit reproduction:

- Mastra OM 94.87% with gpt-5-mini reader + gemini-2.5-flash observer (different reader and observer)
- agentmemory 96.2% with Claude Opus 4.6 (different reader)
- MemMachine 93.0% with GPT-5-mini (different reader)
- Hindsight 91.4% (unspecified backbone)

The cross-reader frontier across all reader tiers and judge configurations spans 89-96%. AgentOS at gpt-4o reader is one band below that cross-reader frontier; pinning the reader to gpt-4o keeps the comparison apples-to-apples.

### Methodology hygiene we ship

- **Bootstrap 95% confidence intervals** at 10,000 Mulberry32 resamples (seed 42) for every reported aggregate
- **Judge false-positive-rate probes** per benchmark: LongMemEval-S 1% [0%, 3%], LongMemEval-M 2% [0%, 5%], LOCOMO 0% [0%, 0%]
- **Per-cell run JSON at seed 42** under `results/runs/` (LongMemEval-M run JSONs exceed GitHub's 100 MB recommendation and are gitignored; their `--summary.json` siblings are committed)
- **Per-vendor caveats** on every cross-vendor row (which dimensions are apples-to-apples, which are not)
- **No claims without complete standalone runnables** in the headline table. Vendors that publish only blog-post numbers without a single-CLI reproduction appear in narrative paragraphs as published numbers with explicit provenance, not in measured cells.

### LOCOMO caveat

LOCOMO's answer key has [6.4% ground-truth errors per Penfield Labs](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg) and the default judge accepts 62.81% of intentionally wrong answers. Any LOCOMO score gap below ~6 pp is inside judge noise. AgentOS reports LOCOMO with that caveat or not at all.

### Feature comparison vs. other memory libraries

The vendor table above measures accuracy at a matched reader. The table below measures *feature coverage*: which cognitive and operational concerns each library handles at all.

| Feature | AgentOS Memory | mem0 | Cognee | Letta (MemGPT) | Mastra |
|---|---|---|---|---|---|
| **Storage** | SQLite/Postgres/IndexedDB/Capacitor via one adapter | Qdrant/Chroma/Postgres | Neo4j + vector | Postgres + Chroma | Postgres + Pinecone |
| **Personality modulation** | HEXACO 6-trait encoding bias | — | — | — | — |
| **Forgetting curve** | Ebbinghaus exponential | — | — | — | — |
| **Spaced repetition** | Interval doubling, desirable difficulty | — | — | — | — |
| **Working memory** | Baddeley slots (5-9, trait-modulated) | — | — | FIFO context window | Fixed sliding window |
| **Mood-aware retrieval** | PAD mood congruence (0.15 weight) | — | — | — | — |
| **Memory graph** | SQLite-backed with spreading activation | Simple key-value | Neo4j graph | — | — |
| **Self-improvement** | 6-step consolidation (prune/merge/strengthen/derive/compact/reindex) | Manual CRUD | Batch re-processing | Edit-based | — |
| **Retrieval signals** | 6-signal composite | Cosine similarity | Cosine + graph | Cosine similarity | Cosine similarity |
| **Document ingestion** | 3-tier (PDF, DOCX, HTML, Markdown, CSV, JSON, URLs) | Text only | PDF, text | Text only | Text only |
| **Import/Export** | SQLite, JSON, Markdown, Obsidian, ChatGPT, CSV | JSON | — | JSON | — |
| **Offline-first** | Zero network required | Requires vector DB | Requires Neo4j | Requires server | Requires cloud |
| **Provenance tracking** | Full source type, confidence, verification count | — | Basic | — | — |

---

## Reproducing the Numbers

Single-CLI reproduction. The bench is source-only (clone and run via local CLI; not published to npm).

```bash
git clone https://github.com/framerslab/agentos-bench
cd agentos-bench
pnpm install
pnpm build

# Set OPENAI_API_KEY and COHERE_API_KEY in your environment
# Download LongMemEval-S dataset per upstream instructions at
# https://github.com/xiaowu0162/LongMemEval into data/longmemeval/longmemeval_s.json

# Reproduce the LongMemEval-S 85.6% headline:
NODE_OPTIONS="--max-old-space-size=8192" pnpm exec tsx src/cli.ts run longmemeval-s \
  --reader gpt-4o \
  --memory full-cognitive --replay ingest \
  --hybrid-retrieval --rerank cohere \
  --embedder-model text-embedding-3-small \
  --reader-router min-cost-best-cat-2026-04-28 \
  --concurrency 5 \
  --bootstrap-resamples 10000

# Reproduce the LongMemEval-M 70.2% headline:
NODE_OPTIONS="--max-old-space-size=8192" pnpm exec tsx src/cli.ts run longmemeval-m \
  --reader gpt-4o \
  --memory full-cognitive --replay ingest \
  --hybrid-retrieval --rerank cohere \
  --embedder-model text-embedding-3-small \
  --reader-router min-cost-best-cat-2026-04-28 \
  --reader-top-k 5 \
  --concurrency 5 \
  --bootstrap-resamples 10000
```

Expected wall-clock (S): ~10-15 min at concurrency 5. Expected cost: ~$3.84 in OpenAI/Cohere fees.

The same primitives ([`MemoryRouter`](https://github.com/framerslab/agentos/blob/master/src/orchestration/pipeline/memory/MemoryRouter.ts), `ReaderRouter`) are re-exported through `@framers/agentos` so a consuming app gets the same routing decisions:

```ts
import { Memory } from '@framers/agentos';
import { ReaderRouter } from '@framers/agentos/memory-router';
import { OpenAIEmbedder } from '@framers/agentos-bench/cognitive';

const mem = await Memory.createSqlite({
  path: './memory.sqlite',
  embedder: new OpenAIEmbedder('text-embedding-3-small'),
  // canonical-hybrid for all categories; no policy router, no observational memory
  readerRouter: new ReaderRouter({
    preset: 'min-cost-best-cat-2026-04-28',
    classifier: gpt5miniClassifier,
    readers: { 'gpt-4o': gpt4o, 'gpt-5-mini': gpt5mini },
  }),
});
```

---

## Source File Map

For readers who want to trace the architecture into code:

| Subsystem | Path |
|---|---|
| Memory facade | `packages/agentos/src/memory/io/facade/Memory.ts` |
| Brain (SQLite + Postgres + adapter entry points) | `packages/agentos/src/memory/retrieval/store/Brain.ts` |
| Storage adapter (cross-platform substrate) | [`packages/sql-storage-adapter/src/`](https://github.com/framerslab/sql-storage-adapter/tree/master/src/) ([repo](https://github.com/framerslab/sql-storage-adapter)) |
| SQL Dialect / FTS abstraction / BLOB codec | `packages/sql-storage-adapter/src/dialect/`, `src/fts/`, `src/blob/` |
| Cognitive memory orchestrator | `packages/agentos/src/memory/CognitiveMemoryManager.ts` |
| Encoding model | `packages/agentos/src/memory/core/encoding/EncodingModel.ts` |
| Decay model (Ebbinghaus) | `packages/agentos/src/memory/core/decay/DecayModel.ts` |
| Working memory (Baddeley) | `packages/agentos/src/memory/core/working/CognitiveWorkingMemory.ts` |
| Memory graph + spreading activation | `packages/agentos/src/memory/retrieval/store/SqlMemoryGraph.ts` |
| Eight cognitive mechanisms | `packages/agentos/src/memory/mechanisms/` |
| Consolidation loop (6-step) | `packages/agentos/src/memory/pipeline/consolidation/ConsolidationLoop.ts` |
| Verbatim archive | `packages/agentos/src/memory/archive/SqlStorageMemoryArchive.ts` |
| Hybrid retriever (BM25 + dense + Cohere) | `packages/agentos/src/memory/retrieval/hybrid/HybridRetriever.ts` |
| HyDE retriever | `packages/agentos/src/rag/HydeRetriever.ts` |
| Multimodal indexer | `packages/agentos/src/rag/multimodal/MultimodalIndexer.ts` |
| Ingest router (`IngestRouter.ts`) | `packages/agentos/src/ingest-router/` |
| Memory router + adaptive variant (`MemoryRouter.ts`, `adaptive.ts`) | `packages/agentos/src/memory-router/` |
| Reader router model dispatch (`reader-router.ts`) | `packages/agentos/src/memory-router/reader-router.ts` |
| Read router strategy dispatch (`ReadRouter.ts`) | `packages/agentos/src/read-router/` |
| Cognitive pipeline (composition) | `packages/agentos/src/cognitive-pipeline/` |
| Bench harness | `packages/agentos-bench/src/` |
| Run JSONs | `packages/agentos-bench/results/runs/` |
| Leaderboard | `packages/agentos-bench/results/LEADERBOARD.md` |

Every public entrypoint has TSDoc; type-checked via `pnpm exec tsc --noEmit`.

---

## Further Reading

- [Cognitive Memory](./memory/COGNITIVE_MEMORY.md) — full primary-source citations for every cognitive-science model used, plus the 8-mechanism implementation reference
- [Memory Operations](./MEMORY_OPERATIONS.md) — auto-ingest pipeline, agent-facing memory tools, import/export across 6 formats
- [Cognitive Pipeline](./COGNITIVE_PIPELINE.md) — the classifier-driven dispatch composition
- [Ingest Router](./INGEST_ROUTER.md), [Memory Router](./MEMORY_ROUTER.md), [Read Router](./READ_ROUTER.md) — per-stage primitives
- [Adaptive Memory Router](./ADAPTIVE_MEMORY_ROUTER.md) — self-calibration for non-LongMemEval workloads
- [HyDE Retrieval](./memory/HYDE_RETRIEVAL.md), [Multimodal RAG](./memory/MULTIMODAL_RAG.md), [Memory Consolidation](./memory/MEMORY_CONSOLIDATION.md) — specialty topics
- [SQLite Brain Storage](./memory/MEMORY_STORAGE.md), [Postgres + pgvector Backend](./memory/POSTGRES_BACKEND.md) — backend-specific schema, WAL/MVCC tradeoffs, multi-tenant patterns
- [`@framers/sql-storage-adapter`](https://github.com/framerslab/sql-storage-adapter) — full storage substrate: adapter matrix, SQL dialect translation, FTS abstraction, BLOB codec, cross-platform sync
- [Bench Leaderboard](https://github.com/framerslab/agentos-bench/blob/master/results/LEADERBOARD.md) — full benchmark tables with confidence intervals and per-category breakdowns
- [Transparency Audit](https://agentos.sh/en/blog/memory-benchmark-transparency-audit/) — what the headline numbers don't say (LOCOMO answer-key error, judge bias, vendor comparison gaming)
