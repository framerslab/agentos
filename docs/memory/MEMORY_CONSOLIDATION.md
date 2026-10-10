---
title: 'Memory Consolidation'
sidebar_position: 23
description: 'How the Memory facade consolidates a brain (prune, merge, strengthen, derive, compact, re-index), how retrieval feedback changes trace decay, and how the observer extracts, compresses and reflects conversation notes.'
---

> Consolidation is background maintenance on a memory brain: it soft-deletes weak traces, merges duplicates, records co-activation edges from retrieval feedback, promotes old episodic traces to semantic ones, and rebuilds the search index.

AgentOS has two consolidation implementations. [`ConsolidationLoop`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/consolidation/ConsolidationLoop.ts) serves the `Memory` facade and is the subject of this page. [`ConsolidationPipeline`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/consolidation/ConsolidationPipeline.ts) serves `CognitiveMemoryManager`; the [Memory System Overview](../MEMORY_SYSTEM_OVERVIEW.md) describes it.

---

## Overview

| Component | What it does | LLM |
|-----------|--------------|-----|
| `ConsolidationLoop` | One consolidation cycle over a `Memory` brain, in six steps | Only the derive step, which the `Memory` facade never enables |
| `RetrievalFeedbackSignal` | Marks each injected trace `'used'` or `'ignored'` from the reply text and updates its decay state | No |
| `MemoryObserver`, `ObservationCompressor`, `ObservationReflector` | Extract notes from conversation, compress them, and reflect them into patterns | Yes |

All of them are exported from `@framers/agentos` and `@framers/agentos/cognition/memory`.

---

## ConsolidationLoop

`Memory.consolidate()` runs one cycle with the facade's `consolidation` config, then recompiles the wiki when the facade has one. The `memory_reflect` tool from `memory.createTools()` runs one cycle with the default thresholds. A cycle called while another is running returns at once with zero counts.

The facade builds the loop with no options: no LLM invoker, no embedding function and no personality mutation store. Through `Memory`, the merge step therefore compares content hashes, the derive step never runs, and no personality decay happens. A host that constructs `ConsolidationLoop` itself passes them:

```ts
import { Brain, SqlMemoryGraph, ConsolidationLoop } from '@framers/agentos';

const brain = await Brain.openSqlite('./brain.sqlite');
const memoryGraph = new SqlMemoryGraph(brain);
await memoryGraph.initialize();

const loop = new ConsolidationLoop(brain, memoryGraph, {
  llmInvoker: async (prompt) => callYourModel(prompt), // enables step 4
  embedFn: async (texts) => embedAll(texts),            // cosine merge in step 2
});
const result = await loop.run({ pruneThreshold: 0.05, mergeThreshold: 0.95 });
```

`callYourModel` and `embedAll` stand for your own model and embedding calls. The options also take `personalityMutationStore` and `personalityDecayRate` for the personality decay step.

`run()` reads four config fields: `pruneThreshold`, `mergeThreshold`, `maxDerivedPerCycle` and `minClusterSize`.

### Step 1: Prune

Each undeleted trace's current strength is computed from its stored strength, stability and last access time:

```
S(t) = S0 * e^(-(now - lastAccessedAt) / stability)
```

A trace with `S(t)` below `pruneThreshold` (default 0.05) gets `deleted = 1`. This step reads no emotional data, so emotional traces are pruned like any other.

### Step 2: Merge

Duplicates are found one of two ways:

| Method | When | Match |
|--------|------|-------|
| Cosine similarity of embeddings | The loop has an `embedFn` (it embeds every undeleted trace on each run and compares every pair) | similarity `>= mergeThreshold` (default 0.95) |
| SHA-256 of the content | No `embedFn`, which is always the case through `Memory` | identical content |

For a matched pair, the trace with more retrievals survives (the first one on a tie) and keeps its content. It takes the union of both tag lists, the average of both emotion records, the higher strength, the sum of the retrieval counts, the later access time, the larger stability and reinforcement interval, and a `verificationCount` raised by one plus the other trace's count. The other trace is soft-deleted; no link to the survivor is stored.

### Step 3: Strengthen

The step reads every `retrieval_feedback` row with `signal = 'used'` and groups the rows by `query`. For each query with at least two distinct traces, it adds missing graph nodes and calls `recordCoActivation()` on the memory graph: every pair of those traces gets a `CO_ACTIVATED` edge of weight 0.1, or 0.1 more on an existing edge, capped at 1.0. The step keeps no record of rows it has read, so each run adds 0.1 to the same pairs again. Rows without a `query` are skipped.

### Step 4: Derive (needs an LLM)

With an `llmInvoker`, the step asks the memory graph for clusters (`detectClusters(minClusterSize)`, default 5), takes the largest `maxDerivedPerCycle` (default 5), and sends the undeleted member contents of each cluster with at least two of them to the LLM with the prompt `Given these related memories, derive one concise higher-level insight:`. A non-empty answer is stored as a new trace: `type: 'semantic'`, scope `user`, strength 0.7, tags `derived` and `insight`, and the cluster id in its metadata. The step adds no graph edges. An LLM error skips that cluster. Without an `llmInvoker`, the step returns 0.

### Step 5: Compact

Episodic traces created more than 7 days ago with a retrieval count of 3 or more change `type` to `semantic`. Their content does not change.

### Personality decay

With a `personalityMutationStore`, the store's `decayAll(personalityDecayRate)` runs between Compact and Re-index (default rate 0.05; mutations at or below 0.1 after decay are removed). A failure is ignored.

### Step 6: Re-index

The step rebuilds the `memory_traces_fts` full-text index (a failure is ignored) and writes a row to `consolidation_log` with the counts and the duration.

### Result

```ts
interface ConsolidationResult {
  pruned: number;             // traces soft-deleted in step 1
  merged: number;             // pairs merged in step 2
  derived: number;            // insight traces from step 4 plus query groups strengthened in step 3
  compacted: number;          // episodic traces promoted in step 5
  durationMs: number;
  personalityDecayed?: number; // mutations decayed or removed (0 without a store)
}
```

`derived` adds the step-3 count to the step-4 count, and the `consolidation_log` row records the same sum.

---

## Running consolidation

```ts
import { Memory } from '@framers/agentos';

const mem = await Memory.createSqlite('./brain.sqlite', {
  consolidation: { pruneThreshold: 0.05, mergeThreshold: 0.95 },
});

const result = await mem.consolidate();
console.log(result.pruned, result.merged, result.derived, result.compacted, result.durationMs);

const health = await mem.health();
console.log(health.lastConsolidation, health.activeTraces, health.avgStrength.toFixed(2));
```

`selfImprove` defaults to `true`. With `selfImprove: false`, `consolidate()` throws and `createTools()` leaves out `memory_reflect`. `health().lastConsolidation` is the ISO time of the newest `consolidation_log` row, or `null`.

The facade schedules nothing. `ExtendedConsolidationConfig` declares `trigger` (`'interval'`, `'turns'`, `'manual'`), `every`, `intervalMs`, `deriveInsights`, `maxTracesPerCycle` and `mergeSimilarityThreshold`, and the facade reads none of them: a cycle runs only when `consolidate()` or the `memory_reflect` tool runs it. To consolidate on a schedule, call `consolidate()` from a timer or after every N turns in the host.

---

## Retrieval Feedback Signal

Source: [`src/cognition/memory/retrieval/feedback/RetrievalFeedbackSignal.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/feedback/RetrievalFeedbackSignal.ts)

`memory.feedbackFromResponse(injectedTraces, reply, query)` decides, for each trace that was injected into the prompt, whether the reply used it:

1. The trace's content is lower-cased, split on whitespace, stripped of every character outside `a-z0-9`, and reduced to the distinct words longer than 4 characters.
2. The match ratio is the share of those words found anywhere in the lower-cased reply.
3. A ratio above 0.30 marks the trace `'used'`; a lower ratio, or a trace with no such words, marks it `'ignored'`.

The constructor accepts a `similarityFn`, and `detect()` does not call it. The facade passes none.

`memory.feedback(traceId, signal, query)` records an application-level signal for one trace by id.

### Effect on decay

| Signal | Change to the trace (from `DecayModel.ts`) |
|--------|--------------------------------------------|
| `'used'` | `updateOnRetrieval()`: strength +0.1 (at most 1), stability multiplied by a growth factor that is larger when the trace had decayed more, retrieval count +1, last access now, reinforcement interval doubled |
| `'ignored'` | `penalizeUnused()`: strength set to 90% of its current decayed value, stability halved (at least one minute), last access now |

Every ignored signal applies the penalty, the first one included.

### Persistence

`feedbackFromResponse()` writes one `retrieval_feedback` row per trace and the trace updates in one transaction. The table in the brain:

```sql
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  brain_id   TEXT    NOT NULL,
  trace_id   TEXT    NOT NULL,
  signal     TEXT    NOT NULL,    -- 'used' or 'ignored'
  query      TEXT,                -- the query passed with the feedback
  created_at INTEGER NOT NULL,
  FOREIGN KEY (brain_id, trace_id) REFERENCES memory_traces(brain_id, id)
);
```

The strengthen step of consolidation reads the `'used'` rows that carry a query.

---

## Observation notes, compression and reflection

[`MemoryObserver`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) runs three tiers, each an LLM call through the `llmInvoker` in its config:

```
messages --observe()--> notes --compressIfNeeded()--> compressed observations --reflectIfNeeded()--> reflections
```

1. **Notes.** `observe(role, content)` buffers messages. When the buffer reaches `activationThresholdTokens` (default 30,000) or `activationThresholdMessages` (default 20), the observer sends the buffered conversation to the LLM with a personality-biased prompt and parses one JSON note per line (`type`, `content`, `importance`, `entities`). `extractNotes()` does the same on demand.
2. **Compressed observations.** `compressIfNeeded()` runs [`ObservationCompressor`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/ObservationCompressor.ts) once 50 notes have accumulated. The prompt asks the LLM to group related notes, write one summary of 1-3 sentences per group, and give each a priority: `critical`, `important` or `informational` (an unknown value becomes `informational`). The prompt targets 3-10x compression; the code does not measure it.
3. **Reflections.** `reflectIfNeeded()` runs [`ObservationReflector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/ObservationReflector.ts) once the compressed summaries reach an estimated 40,000 tokens. Each `Reflection` has an `insight`, a `patternType` (`preference`, `behavior`, `capability`, `relationship` or `goal`), a `confidence` from 0 to 1, the source ids and a time span.

Nothing in AgentOS calls `compressIfNeeded()` or `reflectIfNeeded()`; the host calls them. Reflections are returned to the caller, not stored as traces. `CognitiveMemoryManager` uses the observer's notes with a different class, [`MemoryReflector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts), which turns notes into memory traces.

### Personality bias

The note and compression prompts add an instruction for each HEXACO trait above 0.6 (a missing trait counts as 0.5):

| High trait | Instruction to preserve |
|------------|-------------------------|
| Emotionality | Emotional context and sentiment shifts |
| Conscientiousness | Commitments, deadlines, action items |
| Openness | Creative ideas and exploratory tangents |
| Agreeableness | Rapport cues and user preferences |
| Honesty | Corrections, retractions, factual updates |

`MemoryReflector`'s prompt picks one contradiction rule from the traits: honesty above 0.6 prefers the newer information and flags the old trace for supersession; otherwise agreeableness above 0.6 keeps both versions and notes the discrepancy; otherwise it keeps the version with higher confidence. The rule is an instruction to the LLM. `ObservationReflector` has no contradiction rule.

### Time fields

Notes and compressed observations carry three time fields:

| Field | Value |
|-------|-------|
| `observedAt` | When the note or summary was produced |
| `referencedAt` | For a note, the timestamp of the earliest buffered message; for a compressed observation, the earliest timestamp of its source notes |
| `relativeLabel` | `relativeTimeLabel(referencedAt, observedAt)` |

`relativeTimeLabel(timestamp, now?)` returns `just now` (under a minute), `N minutes ago`, `1 hour ago` or `earlier today` (same calendar day), `yesterday`, `last <weekday>` (2-6 days), `last week` (7-13 days), `N weeks ago` (14-27), `last month` (28-59), `N months ago` (60-364, months of 30 days), `last year` (365-729), `N years ago`, and `in the future` for a later timestamp.

---

## Source Files

| File | Purpose |
|------|---------|
| [`pipeline/consolidation/ConsolidationLoop.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/consolidation/ConsolidationLoop.ts) | The facade's consolidation cycle |
| [`io/facade/Memory.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/facade/Memory.ts) | `consolidate()`, `feedback()`, `feedbackFromResponse()`, `health()`, `createTools()` |
| [`retrieval/feedback/RetrievalFeedbackSignal.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/feedback/RetrievalFeedbackSignal.ts) | Used and ignored detection |
| [`core/decay/DecayModel.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts) | `computeCurrentStrength`, `updateOnRetrieval`, `penalizeUnused` |
| [`pipeline/observation/MemoryObserver.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) | Notes and the compression and reflection triggers |
| [`pipeline/observation/ObservationCompressor.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/ObservationCompressor.ts) | Note compression |
| [`pipeline/observation/ObservationReflector.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/ObservationReflector.ts) | Pattern reflections |
| [`pipeline/observation/temporal.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/temporal.ts) | `relativeTimeLabel()` |

All paths are under `src/cognition/memory/`.
