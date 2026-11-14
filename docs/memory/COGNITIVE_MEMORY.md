---
description: "Cognitive memory for AI agents: Ebbinghaus decay, HEXACO-modulated encoding, Baddeley working memory, ACT-R spreading activation, 8 neuroscience-grounded mechanisms. 85.6% on LongMemEval-S, 70.2% on LongMemEval-M."
keywords: [cognitive memory ai, llm memory architecture, ebbinghaus decay, hexaco personality, baddeley working memory, longmemeval, agent memory, semantic memory, episodic memory]
---

# Cognitive Memory System

> **Memory benchmarks (full N=500, `gpt-4o` and `gpt-5-mini` readers routed per question type):** **85.6% on LongMemEval-S** at $0.0090 per correct; with `gpt-4o` reading every question, the same retrieval scores 84.2%, level with Mastra Observational Memory (84.23%). **70.2% on LongMemEval-M** on the 1.5M-token / 500-session haystack variant. Competitive with the strongest published M results in the LongMemEval paper ([Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813): round Top-5 65.7%, session Top-5 71.4%, round Top-10 72.0%). [Benchmarks](https://docs.agentos.sh/benchmarks) · [Run JSONs](https://github.com/framerslab/agentos-bench/tree/master/results/runs) · [SOTA writeup](https://agentos.sh/en/blog/agentos-memory-sota-longmemeval/)

:::tip See also
[HEXACO Personality](./HEXACO_PERSONALITY.md) for the trait-by-trait reference covering encoding weights, working-memory capacity, prompt formatting, observer/reflector bias, and runtime self-modification.
:::

![CognitiveMemoryManager architecture: orchestrator dispatches to 8 subsystems, each backed by its substrate](/img/diagrams/cognitive-memory-architecture.svg)

---

## Why memory should forget

A pure vector-similarity memory — embed every message, return the cosine-nearest neighbors at retrieval — works for a few thousand turns. Past that scale, undifferentiated retrieval treats every recorded experience as equally available, equally trustworthy, and equally relevant. The cognitive-science literature treats forgetting as the mechanism by which what mattered yesterday continues to matter today, not as a bug to be patched out. AgentOS encodes that principle directly: traces decay, retrieval bias shifts with mood, and consolidation rewrites the store between turns.

The cognitive memory system in AgentOS is built on that argument. Encoding strength is set per-trace, modulated by the personality traits of the agent doing the encoding and by the emotional intensity of the moment ([Brown & Kulik, 1977](https://psycnet.apa.org/record/1977-29748-001) on flashbulb memories; [Yerkes & Dodson, 1908](https://onlinelibrary.wiley.com/doi/abs/10.1002/cne.920180503) on the inverted-U arousal curve). Strength then decays exponentially with time on Hermann Ebbinghaus's 1885 forgetting curve `S(t) = S₀ · e^(-Δt / stability)`, and each successful retrieval grows the stability (the desirable-difficulty effect: weaker traces gain more). Working memory is bounded by [Baddeley's slot model](https://www.sciencedirect.com/science/article/pii/S1364661303002479): seven slots, one more or one fewer by traits, between five and nine. Retrieval composites six signals — vector similarity, current strength, recency, emotional congruence with the agent's mood, graph spreading-activation in the [ACT-R](https://act-r.psy.cmu.edu/) tradition (Anderson, 1983), and importance. The graph itself learns: co-retrieval of two traces tightens the edge between them via Hebbian weight updates ("neurons that fire together wire together").

:::tip Eight cognitive mechanisms layered on top
On top of the encoding/decay/retrieval substrate, the runtime ships eight optional neuroscience-grounded mechanisms — reconsolidation, retrieval-induced forgetting, involuntary recall, metacognitive feeling-of-knowing, temporal gist, schema encoding, source-confidence decay, and emotion regulation. All HEXACO-personality-modulated and individually configurable via `cognitiveMechanisms` on [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts). See the [Mechanism Implementation Reference](#mechanism-implementation-reference) below for hook points, APIs, and testing.
:::

## What it actually does, in five lines

- **Encoding** is shaped by the agent's HEXACO personality traits and current emotional state (PAD model: valence, arousal, dominance)
- **Forgetting** follows the Ebbinghaus exponential decay curve, with retrieval-induced reinforcement via spaced repetition
- **Retrieval** combines six weighted signals (strength, embedding similarity, recency, emotional congruence, graph activation, importance) into a composite score
- **Working memory** enforces Baddeley's slot-based capacity limits (7±2), modulated by traits
- **Consolidation** runs periodically to prune weak traces, link related traces in the graph, summarize clusters into schemas, resolve contradictions, and reinforce traces due for review

Core encoding, decay and retrieval make no LLM call with the `keyword` feature detector (retrieval embeds the query). In the Batch-2 layer, the observer and reflector run only when their config carries an `llmInvoker`. The memory graph is on unless `graph.disabled` is `true`, and with a graph (or a `consolidation` config) the manager builds the consolidation pipeline and starts its hourly timer unless `consolidation.enabled` is `false`. The manager takes its vector store and knowledge graph as interfaces, so the same calls run over any implementation of them.

### Cognitive science foundations

Each model below has a one-to-one analogue in the source. The point of the table is not to claim the runtime "uses" these papers in the loose sense — the point is that the constants, formulas, and weights you'll see in the code lines below come straight from this literature.

| Model | Reference | Application in AgentOS |
|-------|-----------|----------------------|
| Multi-store memory | [Atkinson & Shiffrin, 1968](https://en.wikipedia.org/wiki/Atkinson%E2%80%93Shiffrin_memory_model) | Sensory input → working memory → long-term memory pipeline |
| Working memory model | [Baddeley & Hitch, 1974](https://www.sciencedirect.com/science/article/pii/S0079742108604521); Baddeley 2003 | Slot-based capacity limits (7±2) with activation levels |
| LTM taxonomy | [Tulving, 1972](https://psycnet.apa.org/record/1973-08477-001) | Episodic / semantic / procedural / prospective memory types |
| Forgetting curve | [Ebbinghaus, 1885](https://www.gutenberg.org/files/55518/55518-h/55518-h.htm) | `S(t) = S₀ · e^(-Δt / stability)` exponential decay |
| Arousal curve | [Yerkes & Dodson, 1908](https://onlinelibrary.wiley.com/doi/abs/10.1002/cne.920180503) | Encoding quality peaks at moderate arousal (inverted-U) |
| Flashbulb memories | [Brown & Kulik, 1977](https://psycnet.apa.org/record/1977-29748-001) | High-emotion events create vivid, persistent traces |
| Mood-congruent encoding | [Bower, 1981](https://psycnet.apa.org/doi/10.1037/0003-066X.36.2.129) | Content matching current mood valence encodes more strongly |
| Spreading activation | [Anderson, 1983](https://psycnet.apa.org/record/1984-00248-001) (ACT-R) | BFS through associative graph with activation decay |
| Hebbian learning | [Hebb, 1949](https://en.wikipedia.org/wiki/Organization_of_Behavior) | Co-retrieval strengthens graph edges |
| HEXACO personality | [Ashton & Lee, 2007](https://doi.org/10.1177/1088868306294907) | Trait-driven encoding weights and memory capacity modulation |
| Source-monitoring framework | [Johnson, Hashtroudi & Lindsay, 1993](https://psycnet.apa.org/record/1993-18254-001) | Different memory sources decay at different rates (provenance-aware) |
| HyDE retrieval | [Gao et al., 2022](https://arxiv.org/abs/2212.10496) | Generate hypothetical answer, embed *that*, search for matches |
| GraphRAG | [Microsoft Research, 2024](https://arxiv.org/abs/2404.16130) | Entity-graph + community summaries for multi-hop retrieval |
| Generative agents | [Park et al., 2023](https://arxiv.org/abs/2304.03442) | Persona + memory + reflection as the long-running agent pattern |
| CoALA framework | [Sumers et al., 2023](https://arxiv.org/abs/2309.02427) | Cognitive architectures for language agents — episodic / semantic / procedural memory typology |

---

## Architecture

**Per-turn data flow (GMI integration):**

```
User message arrives
  1. assembleForPrompt — retrieve() (vector store + 6-signal composite score), then
                         token-budgeted context assembly → the prompt's retrieved
                         context, in front of the user's message (first model call)
  2. [LLM generates the response; tool rounds run]
  3. observe() + encode() — after the turn: the user's message, then the reply
                         (personality-modulated strength)

Outside the turn:
  - checkProspective   — time/event/context triggers, for the host to check directly
                         (assembleForPrompt also checks them each turn)
  - runConsolidation   — periodic background sweep (timer-based when consolidation is enabled)
```

---

## Memory Types

Based on Tulving's long-term memory taxonomy with extensions:

| Type | Cognitive Model | AgentOS Usage | Example |
|------|----------------|---------------|---------|
| `episodic` | Autobiographical events | Conversation events, interactions | "User asked about deployment on Tuesday" |
| `semantic` | General knowledge/facts | Learned facts, preferences, schemas | "User prefers TypeScript over Python" |
| `procedural` | Skills and how-to | Workflows, tool usage patterns | "To deploy, run the deployment pipeline" |
| `prospective` | Future intentions | Goals, reminders, planned actions | "Remind user about the PR review" |
| `relational` | Relationship knowledge | Trust signals, boundaries, emotional bonds | "User asked not to be contacted after 9pm" |

---

## Memory Scopes

Each trace is scoped to control visibility and ownership:

| Scope | Visibility | Persistence | Use Case |
|-------|-----------|-------------|----------|
| `thread` | Single conversation | Conversation lifetime | In-conversation working context |
| `user` | All conversations with a user | Long-term | User preferences, facts, history |
| `persona` | All users of a persona | Long-term | Persona's learned knowledge |
| `organization` | All agents in an org | Long-term | Shared organizational knowledge |

Collections in the vector store are named `{prefix}_{scope}_{scopeId}` (default prefix: `cogmem`).

---

## The MemoryTrace Envelope

Every memory is wrapped in a [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts), the envelope carrying content, provenance, emotional context, and decay parameters:

| Field Group | Key Fields | Purpose |
|-------------|-----------|---------|
| **Identity** | `id`, `type`, `scope`, `scopeId` | Classification and routing |
| **Content** | `content`, `structuredData`, `entities`, `tags` | The actual memory data |
| **Provenance** | `sourceType`, `sourceId`, `confidence`, `verificationCount`, `contradictedBy` | Source monitoring to prevent confabulation |
| **Emotional Context** | `valence`, `arousal`, `dominance`, `intensity`, `gmiMood` | PAD snapshot at encoding time |
| **Decay Parameters** | `encodingStrength` (S0), `stability` (tau), `importance`, `retrievalCount`, `accessCount`, `lastAccessedAt` | Ebbinghaus curve inputs |
| **Spaced Repetition** | `reinforcementInterval`, `nextReinforcementAt` | Interval doubling schedule |
| **Graph** | `associatedTraceIds` | Links to related traces |
| **Trust** | `policy` | Whether the trace may be used for authorization, personalization or fact claims |
| **Lifecycle** | `createdAt`, `updatedAt`, `consolidatedAt`, `isActive` | Timestamps and soft-delete flag |

Source types: `user_statement`, `agent_inference`, `tool_result`, `observation`, `reflection`, `external`, `fact_graph`, `typed_network`, `retrieved_document`, `human_approval`, `identity_provider`, `system_config`, `external_api`, `memory_summary`.

---

## Encoding Model

Source: `src/cognition/memory/core/encoding/EncodingModel.ts`

Encoding decides **how hard a new trace gets stamped in**. Four cognitive mechanisms compose into one strength score:

### 1. HEXACO Personality -> Encoding Weights

Each HEXACO trait modulates attention to specific content features:

| Trait | Attention Weight | Formula | Effect |
|-------|-----------------|---------|--------|
| Openness | `noveltyAttention` | `0.3 + O * 0.7` | High O notices novel, creative content |
| Conscientiousness | `proceduralAttention` | `0.3 + C * 0.7` | High C notices procedures, structure |
| Emotionality | `emotionalSensitivity` | `0.2 + E * 0.8` | High E amplifies emotional content |
| Extraversion | `socialAttention` | `0.2 + X * 0.8` | High X notices social dynamics |
| Agreeableness | `cooperativeAttention` | `0.2 + A * 0.8` | High A notices cooperation cues |
| Honesty | `ethicalAttention` | `0.2 + H * 0.8` | High H notices ethical/moral content |

The **composite attention multiplier** starts at 0.5 and adds, for each detected feature, its weight times 0.15 (novelty, procedure) or 0.10 (emotion, social, cooperation, ethics), plus 0.15 for a contradiction and `topicRelevance × 0.15`, capped at 1.0.

### 2. Yerkes-Dodson Arousal Curve

Encoding quality peaks at moderate arousal (inverted U):

```
f(a) = 1 - 4 * (a - 0.5)^2

where a = arousal normalised to [0, 1]
```

Returns a multiplier in `[0.3, 1.0]`, peaking at `a = 0.5`. Very low arousal (bored) and very high arousal (panicked) both impair encoding.

### 3. Mood-Congruent Encoding

Content whose emotional valence matches the current mood is encoded more strongly:

```
boost = 1 + max(0, currentValence * contentValence) * emotionalSensitivity * 0.3
```

Positive product means mood and content are congruent (both positive or both negative).

### 4. Flashbulb Memories

When emotional intensity exceeds the threshold (default: 0.8), the memory becomes a **flashbulb memory**:

- Strength multiplier: `2.0x` (default)
- Stability multiplier: `5.0x` (default)

These model the vivid, persistent memories formed during highly emotional events (Brown & Kulik, 1977).

### Composite Encoding Strength

```
S₀ = min(1.0, base * arousalBoost * emotionalBoost * attentionMultiplier * congruenceBoost * flashbulbBoost)
```

Default `base = 0.5`. The stability (time constant for decay) is computed as:

```
stability = baseStabilityMs * (1 + S₀ * 6) * flashbulbStabilityMultiplier
```

Default `baseStabilityMs = 3,600,000` (1 hour). Stronger memories are inherently more stable.

---

## Content Feature Detection

The encoding model needs to know **what features** the content contains. Three detection strategies are available:

| Strategy | LLM calls | Behavior |
|----------|-----------|----------|
| `keyword` | 0 | Keyword rules |
| `llm` | 1 per encode | The model classifies the content; `featureDetectionLlmInvoker` is required, and the detector throws without it |
| `hybrid` | 0 | Keyword rules on encode; its LLM path (`detectWithLlm()`) has no caller in the runtime |

Detected features ([`ContentFeatures`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts)): `hasNovelty`, `hasProcedure`, `hasEmotion`, `hasSocialContent`, `hasCooperation`, `hasEthicalContent`, `hasContradiction`, `topicRelevance`.

Configure via `featureDetectionStrategy` in [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts).

---

## Forgetting & Decay

Source: `src/cognition/memory/core/decay/DecayModel.ts`

### Ebbinghaus Forgetting Curve

Memory strength decays exponentially over time:

```
S(t) = S₀ * e^(-dt / stability)

where:
  S₀       = initial encoding strength
  dt       = time elapsed since last access (ms)
  stability = time constant (ms); grows with each retrieval
```

### Spaced Repetition

Each successful retrieval updates the trace via the **desirable difficulty** effect:

- **Difficulty bonus**: `max(0.1, 1 - currentStrength)` — weaker memories get larger stability boosts
- **Diminishing returns**: `1 / (1 + 0.1 * retrievalCount)` — logarithmic saturation
- **Emotional bonus**: `1 + intensity * 0.3` — emotional memories consolidate faster
- **Growth factor**: `(1.5 + difficultyBonus * 2.0) * diminish * emotionalBonus`
- **Interval doubling**: `reinforcementInterval *= 2` after each retrieval
- **Strength**: `encodingStrength + 0.1`, capped at 1.0

### Interference

`computeInterference()` computes interference between a new trace and existing traces above the similarity threshold (default 0.7): a retroactive strength reduction for each old trace (0.15 at similarity 1.0) and a proactive reduction for the new one (capped at 0.3). The memory manager does not call it, so encoding applies no interference.

### Pruning

Traces with `currentStrength < pruningThreshold` (default: 0.05) are soft-deleted during consolidation, **unless** their emotional intensity exceeds 0.3 (emotional memories are protected from pruning).

The retention sweeps of `MemoryLifecycleManager` read traces through a vector store's `scanByMetadata()`; on a store without it they cannot enumerate traces.

---

## Retrieval Priority Scoring

Source: `src/cognition/memory/core/decay/RetrievalPriorityScorer.ts`

Retrieval combines six signals into a composite score:

| Signal | Weight | Range | Computation |
|--------|--------|-------|-------------|
| `strength` | 0.25 | 0-1 | `S₀ * e^(-dt / stability)` |
| `similarity` | 0.35 | 0-1 | Cosine similarity from vector search |
| `recency` | 0.10 | 0-1 | `e^(-elapsed / recencyHalfLifeMs)` |
| `emotionalCongruence` | 0.15 | 0-1 | `max(0, moodValence * traceValence)` |
| `graphActivation` | 0.10 | 0-1 | Spreading activation score (0 without graph) |
| `importance` | 0.05 | 0-1 | `confidence * 0.5 + 0.5` |

**Composite score:**

```
score = clamp(0, 1,
  w_str * strengthScore +
  w_sim * similarityScore +
  w_rec * recencyNorm +
  w_emo * emotionalNorm +
  w_graph * graphActivation +
  w_imp * importanceScore
)
```

Setting `neutralMood: true` in retrieval options disables emotional congruence bias (useful for factual lookups).

### Tip-of-the-Tongue Detection

Traces with high vector similarity (>0.6) but low strength (<0.3) or low confidence (<0.4) are returned as [`PartiallyRetrievedTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts) — the agent "almost" remembers them. These include `suggestedCues` (tags) to help the user provide more context.

---

## Working Memory (Baddeley's Model)

Source: `src/cognition/memory/core/working/CognitiveWorkingMemory.ts`

Working memory is a **slot-based, capacity-limited** buffer that tracks what the agent is currently "thinking about."

### Capacity

Base capacity follows Miller's number (7), modulated by personality:

- High openness (>0.6): **+1 slot** (broader attention span)
- High conscientiousness (>0.6): **-1 slot** (deeper focus per item)
- Result clamped to `[5, 9]` (Miller's 7 plus/minus 2)

### Slot Mechanics

Each [`WorkingMemorySlot`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts) tracks:

| Field | Range | Purpose |
|-------|-------|---------|
| `activationLevel` | 0-1 | How "in focus" this item is |
| `attentionWeight` | 0-1 | Proportional share of attention (normalised) |
| `rehearsalCount` | 0+ | Maintenance rehearsal bumps (+0.15 per rehearse) |
| `enteredAt` | Unix ms | When the trace entered working memory |

### Activation Lifecycle

1. **Focus**: `focus(traceId, initialActivation)` adds a slot (default activation 0.8). The manager focuses each new trace at its encoding strength and each of the top five retrieved traces at its retrieval score. At capacity, the lowest-activation slot is evicted first.
2. **Rehearsal**: `rehearse(slotId)` bumps activation by 0.15 (capped at 1.0).
3. **Decay**: Each `retrieve()` lowers every slot's activation by `activationDecayRate` (default 0.1).
4. **Eviction**: Slots below `minActivation` (default 0.15) are evicted. The `onEvict` callback can encode evicted items back to long-term memory.

### Prompt Formatting

`formatForPrompt()` outputs slots sorted by activation:

```
- [ACTIVE] mt_1234 (activation: 0.85)
- [fading] mt_1235 (activation: 0.52)
- [weak]   mt_1236 (activation: 0.20)
```

---

## Memory Store

Source: `src/cognition/memory/retrieval/store/MemoryStore.ts`

The [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts) wraps [`IVectorStore`](https://github.com/framerslab/agentos/blob/master/src/core/vector-store/IVectorStore.ts) + [`IKnowledgeGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/knowledge/IKnowledgeGraph.ts) into a unified persistence layer:

- **Store**: Embeds content via [`IEmbeddingManager`](https://github.com/framerslab/agentos/blob/master/src/core/embeddings/IEmbeddingManager.ts), upserts into vector store, records as episodic memory in knowledge graph
- **Query**: Vector search -> decay-aware scoring -> tip-of-the-tongue detection
- **Access tracking**: Updates spaced repetition parameters on each retrieval
- **Soft delete**: Sets `isActive = false` and keeps the Brain row as a tombstone; the trace leaves every vector index and its episodic copy leaves the knowledge graph ([Deleting traces](#deleting-traces))

### Access state across restarts

With a Brain attached (`CognitiveMemoryConfig.brain`), `store()` writes each trace's row and every access updates it. An access writes `last_accessed`, `retrieval_count` and `strength`, and merges the trace's stability, access count, reinforcement interval and next reinforcement time into the row's metadata JSON under `decay`, the object the `Memory` facade, its consolidation and the memory tools read and write; the row's other keys stay. Another writer can change that object while a store holds the trace: the `Memory` facade's recall or feedback on the same Brain, another store on the same Brain, a consolidation merge. An access that finds the row's `decay` changed since the store took the trace or last wrote the row counts the store's accesses since then on top of the row's state and its three columns, and the store's copy of the trace takes the result, so the other writer's reinforcement or penalty stays. A change the store made to its copy in memory alone since then (retrieval-induced forgetting, a consolidation's source-confidence decay) gives way to the row's state in that case. A store that loads the row, after a restart or in another process, reads them back, so a trace keeps every reinforcement, and the consolidation's spaced-repetition sweep reinforces the traces whose next reinforcement time has passed. The merge is a compare-and-set on the JSON text the access read. When another writer changes the row in between, the access reads it again, and after a second lost race it writes the three columns alone; a row whose metadata is not a JSON object keeps it and gets the three columns.

With no Brain, the vector store is the store's only record. Each vector document's metadata carries the trace's stability, access count, reinforcement interval and next reinforcement time, and a store started later over the same vector store (a durable index after a restart) restores them with the trace, through `getByScope()` and through `query()`. A document that holds no interval restores with one hour, which the trace's next access doubles. With no trace of the scope cached, `getByScope()` reads the index with a zero vector of the embedding model's size, as the embedding manager reports it (`getEmbeddingDimension()`) or as one probe embedding measures it, since an index refuses a query vector of another size; the traces restore whatever size the model returns (768 for `nomic-embed-text`, 1536 for `text-embedding-3-small`).

`persistAccessState: false` (on `CognitiveMemoryConfig`, and `memory.persistAccessState` on `gmi()`) restores the earlier behaviour for one release of before-and-after measurement. An access then writes the three columns alone, and a load gives the access count 0, the reinforcement interval one hour and the stability `store()` wrote; with no Brain, the vector metadata carries no schedule, and a trace restored from it has no next reinforcement time and the interval 0 through `getByScope()` or one hour through `query()`.

### Loading and moving one scope

A store loads the 1,000 most recent traces of its Brain at its first recall, whatever their scope, newest first by `createdAt`. On the in-process vector index that `agent()` and `gmi()` build, two traces of a scope that a recall scores equally on every signal come back in the order the store loaded them. Traces stored in the same millisecond load by id, compared character code by character code (`B` before `a`), on SQLite and on PostgreSQL alike (there under the `C` collation, since a database's default collation sorts by language), so every load of the same traces gives two equally scored ones one order in the block. `MemoryStore.hydrateScope(scope, scopeId, limit?)` loads one scope's most recent traces by the `scope_id` column, 1,000 by default, in the same order, and skips the traces the store holds already, so a returning user's older memories are recallable however many traces other scopes hold. It returns how many traces it loaded, and refuses a `limit` that is not a positive integer with a `RangeError`. It reads by the column, so a row a release older than the column wrote since the Brain opened, which holds `''` there until the next open files it, is loaded by the whole-brain hydration while it is among the brain's 1,000 most recent.

`MemoryStore.refileScope(scope, fromScopeId, toScopeId)` moves one scope id's traces to another, as a host does once when it starts passing an organization id: a learner under a namespace reads `user:<namespace>/<userId>`, not the plain form filed before. Every Brain row filed under the old id moves (`scope_id` and the metadata's `scopeId`), soft-deleted rows included, so a later delete of the new id finds them all. Each live trace the store holds moves with its vector document, from the old collection into the new one, with the vector the store holds, the one its Brain row or the index holds, or a new embedding of its text. A trace the store does not hold leaves the old collection, and a store files it in the new one when it loads it (`hydrateScope`, or the whole-brain hydration). A live trace's knowledge-graph copy moves where the graph holds one; a trace with no copy gets none. With no Brain, the old collection is walked from its start as `deleteScope` walks it, and the documents another store filed into a durable index before a restart move too; a stale document there, of a trace the store holds under another scope, is deleted from it, as `deleteScope` deletes one. Each Brain row's metadata is written with a compare against what the move read, so a write another writer makes to the row meanwhile, such as a facade's recall or feedback, is read again and kept. A hydration of this store, or of another store on the same Brain in this process, that read a row before the move reads it again before it loads it, so the trace loads under the new id. It returns the number of traces it moved. An empty scope id on either side is refused with a `TypeError`, so a caller's missing id never moves the traces filed under no scope id or files a scope's traces under none. Each trace's row moves before its vector document, as a Brain's re-file moves its rows: a store on the same Brain or vector index that reads the new id meanwhile finds no document there yet, where a document whose row still named the old id would read as stale, and such a read deletes a stale document. It throws when a live trace's vector cannot be embedded or written into the new collection, or when a row changes under each of three reads; the traces moved before it stay moved, and a call made again moves the rest. A trace whose vector could not be written has its row under the new id already, and the store reads it under neither id until that call moves its vector. A trace the store holds under the old id whose row another store or process moved to another scope or a third id, or deleted for good, before this move or while it runs, stays as the store holds it, and the move does not count it: the words of a deleted trace go into no collection.

A document the index fails to delete from the old collection stays there, with a warning. Recall under the old id skips it, and a delete of the old id leaves the trace and deletes the document: `query()`, `getByScope()` and the collection walk of `deleteScope` and `refileScope` read a document as its trace only when the store does not hold the trace under another scope than the document's collection. Another store open on the same Brain keeps what it holds under the old id until it re-files the scope itself or loads it again, and meanwhile none of its reads return the trace under the old id, since the trace's row is filed under the new one (the next section). Its `deleteScope` of the old id leaves that trace too: the trace is the new id's.

### The written form of a plain id, and a Brain's re-file

Where a learning layer exists, a plain id that holds a `/`, a `%` or a `:` is written percent-encoded in every `user` and `persona` scope id (`encodeURIComponent`, with a lone surrogate written `%u` and four uppercase hexadecimal digits), and every other id keeps its form: `team/ana` is written `team%2Fana`, `a:b` is written `a%3Ab`, and `ana` stays `ana`. A `persona` id is split at its last `::`, and each part is encoded on its own. The rule lives in [`scopeIdForm.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/scopeIdForm.ts) (`encodeScopeIdPart`, `encodePlainScopeId`); an encoded id holds a `%` and an unchanged one holds none, so no two ids share a written form.

The first time a layer opens a Brain (`CognitiveMemoryManager.ensureEncodedScopeIds`, `Memory.ensureEncodedScopeIds`), `refileBrainScopeIds` re-files the Brain's plain `user` and `persona` scope ids that hold one of the three characters, in one transaction that writes the record `brain_meta (brain_id, 'scope_id_form', 'encoded')` whatever the Brain holds. Every row moves, its `scope_id` and its metadata's `scopeId` together, soft-deleted rows included, and a row a release older than the `scope_id` column wrote since the Brain opened is filed first, so it moves with the rest. The knowledge-graph memory nodes the Brain holds under such an id (a trace's copy, and a copy whose trace is gone) move in the same transaction, their stored context and their participants, and keep their relations. Each row and node is written with a compare against what the re-file read, so on Postgres a write another process commits meanwhile is read again and kept. On Postgres the transaction also takes an advisory lock on the brain first, so two processes that open one Brain together re-file it once. The SQLite re-files of one process take turns; a second process's transaction on the same file fails, and a later call finds the record. A Brain that holds the record is left as it is. Once the record is written, a scope id that holds a `/` is a layer's namespaced id: `team/ana` names user `ana` of namespace `team`.

Once the re-file has committed, every live `MemoryStore` in this process on the same Brain (a handle opened on the same file, the same connection string or the same adapter) moves what it holds of the traces the re-file moved, and of those alone. A trace it holds under the old id moves with its vector document, and its knowledge-graph copy is recorded again under the new id where its graph holds the copy under another (an in-memory or a Neo4j graph); one whose row is gone by then, deleted for good by another store or process once the re-file committed, stays as the store holds it, and none of its words are written. The old collection's document of a moved trace it does not hold goes. A row filed under an old id after the re-file is a namespaced learner's, and stays where it is. A hydration under way loads its rows as the Brain holds them after the re-file. Then `ensureEncodedScopeIds` follows the Brain's rows, whoever re-filed it (this call, another handle or another process): each trace the store holds under a `user` or `persona` id that the encoded form would change moves to the scope id its row holds, and one whose row holds the id as it is stays, since a namespaced id holds a `/` too. A move the re-file's own pass could not make is made there, and one that fails throws. `ensureEncodedScopeIds` returns how many rows its own re-file moved: none when the Brain held the record.

Until a store follows a move, its reads skip what the move left behind. `query()`, `getByScope()` and `filterRecallableTraceIds()` check each trace they would return against its Brain row, and a trace whose row is filed under another scope or another scope id than the one the read reaches it under is not returned there; `query()` and `getByScope()` delete such a document from the collection when the store does not hold its trace. The same holds after a move by `refileScope` in another store or another process. A row that names no scope id (a release older than the column wrote it with no `scopeId` in its metadata) is read as filed where the read reaches it. A trace snapshot read before the re-file (`readTraceSnapshot`, whose `scopeIdForm` is `'plain'`) is restored under the encoded id (`Memory.restoreTrace`), so a ledger revert never files the plain user's trace under the namespaced id its plain form now names. A delete follows the rows too: `deleteScope` of an old id deletes none of the traces the store holds under it whose rows moved, so a delete of user `ana` of namespace `team` (`team/ana`) through a store that has not followed the re-file leaves the plain user `team/ana`'s traces, now filed under `team%2Fana`; and `deleteTraces` of a trace the store holds under the old id takes its document from the collection its row names as well, where another process's store moved it.

An import keeps a Brain's form, and takes its source's form from the source's own record: a JSON export's `meta`, the `brain_meta` of the brain a SQLite file holds, or `scopeIdForm: encoded` in the front matter of a note an encoded Brain's Markdown export wrote; a source without one, a CSV file included, is plain, and so is a source with the record whose `user` and `persona` scope ids hold none of the three characters, since they read the same in both forms: a Brain without the record stays without it, and a layer that opens it later re-files the plain ids filed there meanwhile. A plain source goes into a Brain that holds the record with its `user` and `persona` scope ids encoded as they are written, each trace's knowledge-graph copy with them. A source with the record goes into a Brain without it only when that Brain holds no plain id the encoded form changes, in a trace or a copy, and the Brain then gets the record; otherwise the import is refused, naming the record. A Brain that takes the record from an import holds the encoded form from then on, so serve it with a learning layer: a host with no layer files its plain ids as they are, which the record then reads as encoded or namespaced. The import reads the Brain's form in the transaction it writes in, after the brain's advisory lock on Postgres, so it follows a re-file that commits first. An export reads its record and its rows in one form. The RAG `MigrationEngine` copies rows as they are, so it refuses, naming the record, where an import would encode. A Qdrant source or target takes part through its SQLite sidecar's `brain_meta`: its traces are in Qdrant, where the handshake reads no scope id, so a brain the sidecar holds counts as holding ids the two forms read apart. A source that names no brain (a Pinecone index, a Qdrant source with no sidecar) is refused into a target that holds the encoded form and traces, and a Qdrant target with no sidecar takes no source brain that holds the record. [Import and Export](../MEMORY_OPERATIONS.md#a-brains-scope-id-form) gives each format's rule.

Two limits hold. A knowledge graph outside the Brain (Neo4j) keeps under the plain id the copies of the traces no store in the process held, and the copies whose trace is gone; a delete of a trace by its id still takes its copy. Two handles on one SQLite file in one process are two connections: a re-file that meets a write transaction of the other handle waits for it with the event loop stopped, for the driver's busy timeout of 5 seconds, and fails when the other outlasts it; a later call re-files the Brain.

The re-file reads the Brain alone. A store with no Brain has no record to write and is not re-filed, since a vector index cannot list its collections: a durable index that holds documents filed under such a plain id before a layer existed keeps them under it, where the namespaced id of the same text (`team/ana`) reads them, so a host that keeps such ids in a durable index with no Brain moves each one to its encoded form with `refileScope`, which walks the old collection, before a layer serves the index. A namespaced id filed in a Brain that holds no record yet reads to the re-file as a plain one, and the re-file encodes it: `refileScope('user', 'ana', 'team/ana')` before the re-file leaves user `ana`'s traces under `team%2Fana`, which a learner of namespace `team` does not read. A host re-files the Brain (`ensureEncodedScopeIds`) before it moves a user's traces under a namespace.

### Deleting traces

`store()` records each trace in the knowledge graph as an episodic memory holding the trace's full text, with a context that names the trace (`memoryTraceId`), its scope and its scope id. A soft delete (`MemoryStore.softDelete`: a superseded trace, a pruned one, the loser of a conflict) marks the Brain row `deleted = 1` and keeps it as a tombstone, evicts the trace from every vector index on the same backing store, and deletes its episodic copy (`IKnowledgeGraph.deleteMemories`). The facade's soft deletes do the same on a Brain a manager files into: `Memory.forget()` and the memory tools' `memory_delete` and `memory_merge` delete each deleted trace's copy (`Memory.deleteGraphCopies`). The in-memory, SQL and Neo4j knowledge graphs implement `deleteMemories`; a graph without it keeps its copies. Each of the three keeps one copy per trace and finds it with no scan: the in-memory and SQL graphs key the copy by its trace (node id `trace:<traceId>`) and the Neo4j graph writes the trace id on it (`traceId`, indexed), so recording a trace again replaces its copy. A copy an older release recorded has a random node id (SQL) or no `traceId` (Neo4j); a graph instance's first delete by trace id gives such copies their key or their trace id. In SQL the copy is written under its key and the relations that name it move with it before its older node goes, so a move that fails, which the graph warns of, leaves the copy for the next instance, and a delete by its trace id in the meantime deletes it where it is. A pass that fails as a whole (the SQL graph's read of such copies, a Neo4j read or write), which the graph warns of, leaves each delete by trace id reading the trace's older copies by the text their stored context holds (`"memoryTraceId":"<id>"`, matched exactly in code), and the next delete by trace id makes the pass again. An import into a Brain (`SqliteImporter`, `Brain.importFromSqlite`, a JSON import) files each copy it writes under its key, with the relations that name it, and deletes one whose key the brain's own copy of the trace holds, so a delete by trace id finds what it brings in. `SqliteImporter` and a JSON import bring a trace's copy in with the trace alone: a trace they merge into one the brain holds as a duplicate, or write under another id because its id names another trace, comes with no copy and none of the copy's relations, so the delete of the trace the brain holds leaves none of its words. A copy a release older than keyed copies writes into the same database after that, while both releases run on it, gets its key or trace id from the next instance, and a delete by its scope finds it at any time. A copy's relations (a host can relate one, `upsertRelation`) are deleted with it. The SQL graph matches a scope id by its text in the stored JSON with an escaped `LIKE`, so a scope id that holds a quote, a backslash, `%` or `_` finds its own copies on SQLite and Postgres alike. The SQL graph keeps each brain's copies apart by brain id; the Neo4j graph files no brain id on a copy, so one Neo4j database holds one agent's graph, and a delete by scope there takes every copy filed under that scope and scope id, whichever agent recorded it. With `enableGraphActivation`, the entity nodes a trace named stay, with the co-occurrence edges between them: an entity node is shared by every trace that names it.

`CognitiveMemoryManager.deleteTraces(traceIds)` and `deleteScope(scope, scopeId)` delete for good. For every trace the store finds (a Brain row, or a trace the store holds), each first removes what the manager keeps of it: the memory graph's node, with the node's edges; its original in the configured archive (`archive`, through `IMemoryArchive.drop`, which takes its access log too), so `rehydrate()` finds nothing; and the typed facts the manager extracted from it at encode (`typedNetwork.extractAtEncode`, the facts `<traceId>-fact-<n>`, with their edges). It then deletes the traces' knowledge-graph copies, which hold their full text: a graph that cannot delete them fails the call before any trace is deleted, with every row kept, so a later call finds the same traces. It then soft-deletes each trace and deletes its Brain row, so no store, in this process or another, loads it again, and every store on the same Brain or vector index in the process keeps of it only where it was filed, none of its words (`getTrace` and `listTraces` give its id and scope with no content). What the manager keeps goes first, so a call that fails can be made again and finds the same traces. An id the store finds no trace of is skipped: nothing the manager keeps under that id is touched, a knowledge-graph entity of that id included. The rows that name a trace go before its row, as the Brain's foreign keys require: its `retrieval_feedback` rows, which hold the query that recalled it, are deleted, and a `document_chunks` row the trace was filed from stops naming it and keeps its text, which belongs to its document. `deleteScope` takes every trace of the scope the store holds and every Brain row filed under the scope (`memory_traces.scope_id`), soft-deleted rows and another process's included, then every episodic copy filed under the scope, a copy whose trace is already gone included: a graph that cannot delete those fails the call, once the scope's traces are deleted, so a second call deletes the copies. A trace the store holds under the scope whose row a move filed under another scope id (`refileScope` in another store or process, a Brain's re-file the store has not followed) stays: it belongs to that scope id. A trace deleted for good that the store holds under another scope than its row names leaves the collection its row names too, where the store that moved it filed its document. Before it reads the rows it files the brain's rows that hold `scope_id` `''` while their metadata names a scope id, as an open and an import do: a release older than the column writes such rows to a brain this process holds open. On SQLite the full-text index is rebuilt from the rows that remain; a rebuild that fails is repaired when the Brain next opens. Both return `{ deleted, graph }`: `deleted` counts the traces that had a Brain row or were live in the store (with no Brain, a live document of the vector index counts), so a call made again counts none, and `graph` is `'not_supported'` when the knowledge graph has no `deleteMemories`.

A trace a second user filed on another user's session carries that user's id, `MemoryTrace.turnUserId` (set through `encode`'s `turnUserId`), in its Brain row's metadata and, with no Brain, in its vector document's metadata. `deleteScope(scope, scopeId, { turnUserId })` deletes only the traces of the scope that user filed, with their memory-graph nodes and episodic copies, and leaves the scope's other traces and copies. An empty `turnUserId` is refused with a `TypeError`, so a caller's missing id never widens the delete to the whole scope, and so is an empty scope id, so it never deletes every trace filed under no scope id.

With no Brain, the vector index is the scope's record, and a store started over a durable index caches none of what another store filed into it before a restart. `deleteScope` then walks the scope's collection from its start, 500 documents a read, and deletes each page's traces with their memory-graph nodes and episodic copies. It reads through the index's metadata scan (`scanByMetadata`), following the cursor the scan returns, or, for an index without one, through similarity queries with a zero vector of the embedding model's size, which an approximate index answers with the documents its search reaches. It walks the collection again while a walk finds a document the call has not read, since a delete moves the documents after it past a cursor that counts positions. A document whose eviction fails stays in the index, with a warning, and the next call reads it again. A document of a trace the store holds under another scope (stored again under another scope id, or moved by `refileScope` when its delete from the old collection failed) is a stale copy of the trace's words: `deleteScope` deletes it from the collection and keeps the trace (with `turnUserId`, only a copy of that user's trace), and neither `getByScope()` nor `query()` returns the trace for the scope whose collection holds the copy. The store's cache decides which copy is current: a store started over a durable index that first reads a trace from its stale copy holds the trace under that copy's scope until it stores, loads or moves the trace again. With no Brain, `deleteTraces` reaches the traces the store holds: an id alone names no collection, so a trace another store filed into the index before a restart is deleted through `deleteScope`. An index that reports the collection missing (`collectionExists`) holds nothing of the scope; a read that fails on an index holding the collection fails the call, and on an index that cannot say whether it holds it, the read counts as finding nothing, with a warning.

### Collection Naming

Collections follow the pattern `{prefix}_{scope}_{scopeId}`:

```
cogmem_user_agent-123
cogmem_thread_conv-456
cogmem_persona_helper-bot
cogmem_organization_acme-org
```

---

## Memory Graph

Source: `src/cognition/memory/retrieval/graph/IMemoryGraph.ts`

The [`IMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts) interface abstracts over two backends:

| Backend | Implementation | Use Case |
|---------|---------------|----------|
| `graphology` | [`GraphologyMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/GraphologyMemoryGraph.ts) | Dev/testing, in-memory, fast |
| `knowledge-graph` | [`KnowledgeGraphMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/KnowledgeGraphMemoryGraph.ts) | Production, wraps [`IKnowledgeGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/knowledge/IKnowledgeGraph.ts) |

Configure via `graph.backend` (default: `'knowledge-graph'`).

### Edge Types

| Edge Type | Meaning | Weight |
|-----------|---------|--------|
| `SHARED_ENTITY` | Traces mention the same entity | 0.5 |
| `TEMPORAL_SEQUENCE` | Traces created within 5 minutes | 0.3 |
| `SAME_TOPIC` | Traces share topic cluster | varies |
| `CONTRADICTS` | Traces contain conflicting information | varies |
| `SUPERSEDES` | One trace replaces another | varies |
| `CAUSED_BY` | Causal relationship | varies |
| `CO_ACTIVATED` | Traces retrieved together (Hebbian) | grows |
| `SCHEMA_INSTANCE` | Episodic trace is instance of semantic schema | 0.6 |

Consolidation creates the `SHARED_ENTITY`, `TEMPORAL_SEQUENCE` and `SCHEMA_INSTANCE` edges; `recordCoActivation()` creates and strengthens `CO_ACTIVATED` edges.

---

## Spreading Activation

Source: `src/cognition/memory/retrieval/graph/SpreadingActivation.ts`

Implements Anderson's ACT-R spreading activation model. Given seed nodes (top retrieval results), activation spreads through the graph to surface associated memories.

### Algorithm (BFS)

1. Seed nodes start at `activation = 1.0`
2. Each hop: `neighbor_activation = current * edge_weight * decayPerHop`
3. Multi-path summation (capped at 1.0) — traces reachable by multiple paths get boosted
4. BFS with `maxDepth` (default 3) and `activationThreshold` (default 0.1) cutoffs
5. Results sorted by activation descending, capped at `maxResults` (default 20)

### Configuration

| Parameter | Default | Effect |
|-----------|---------|--------|
| `maxDepth` | 3 | Maximum hops from seed nodes |
| `decayPerHop` | 0.5 | Activation multiplier per hop |
| `activationThreshold` | 0.1 | Minimum activation to continue |
| `maxResults` | 20 | Maximum activated nodes returned |

### Hebbian Learning

After retrieval, the top five retrieved memories are recorded via `recordCoActivation()`. This strengthens `CO_ACTIVATED` edges between memories that are frequently retrieved together, implementing the Hebbian rule: "neurons that fire together wire together."

The learning rate (default 0.1) controls how quickly edge weights grow.

---

## Observer/Reflector System

### Memory Observer

Source: `src/cognition/memory/pipeline/observation/MemoryObserver.ts`

The observer monitors accumulated conversation tokens via a buffer. When the threshold is reached (default: 30,000 tokens), it extracts concise observation notes via a persona-configured LLM.

**Personality bias in observation:**

| High Trait | Observer Focus |
|-----------|---------------|
| Emotionality | Emotional shifts, tone changes, sentiment transitions |
| Conscientiousness | Commitments, deadlines, action items, structured plans |
| Openness | Creative tangents, novel ideas, exploratory topics |
| Agreeableness | User preferences, rapport cues, communication style |
| Honesty | Corrections, retractions, contradictions |

Observation notes are typed: `factual`, `emotional`, `commitment`, `preference`, `creative`, `correction`.

### Memory Reflector

Source: `src/cognition/memory/pipeline/observation/MemoryReflector.ts`

The reflector consolidates accumulated observation notes into long-term memory traces. Activates when note tokens exceed threshold (default: 40,000 tokens).

**Pipeline** (the reflector's instructions to its model):
1. Merge redundant observations
2. Elevate important facts to long-term traces
3. Detect conflicts against existing memories
4. Resolve conflicts based on personality:
   - High honesty: prefer newer information, supersede old
   - High agreeableness: keep both versions, note discrepancy
   - Default: prefer higher confidence

**Target compression:** 5-40x (many observations -> few high-quality traces).

Personality also controls **memory style**:
- High conscientiousness: structured, well-organized traces
- High openness: rich, associative traces with connections
- Default: concise, factual traces

---

## Prospective Memory

Source: `src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts`

Prospective memory handles **future intentions** — "remember to do X when Y happens."

### Trigger Types

| Type | Fires When | Example |
|------|-----------|---------|
| `time_based` | Current time >= `triggerAt` | "Remind me at 3pm" |
| `event_based` | Named event in `context.events` | "When user mentions deployment" |
| `context_based` | Query embedding similarity > threshold | "When we discuss pricing" |

### Registration

```typescript
await manager.register({
  content: 'Remind user about the PR review',
  triggerType: 'time_based',
  triggerAt: Date.now() + 3_600_000, // 1 hour
  importance: 0.8,
  recurring: false,
});
```

### Checking

`assembleForPrompt()` checks the items each turn and puts the triggered ones in the "Reminders" section of the assembled memory context. Commitment notes from the observer (importance 0.5 or more) and future-intent preference notes are registered as items automatically. Items can be `recurring` (re-trigger) or one-shot (marked `triggered` after firing).

Context-based triggers use cosine similarity between the cue embedding and the current query embedding, with a configurable `similarityThreshold` (default 0.7).

---

## Consolidation Pipeline

Source: `src/cognition/memory/pipeline/consolidation/ConsolidationPipeline.ts`

Runs periodically (default: every hour) to maintain memory health. Five steps:

### Step 1: Decay Sweep

Apply Ebbinghaus curve to all traces, soft-delete those below `pruningThreshold` (default 0.05). Emotional memories (intensity > 0.3) are protected.

### Step 2: Co-Activation Replay

Process recent traces (last 24 hours) to create graph edges:
- **SHARED_ENTITY**: Traces mentioning the same entity get connected (weight 0.5)
- **TEMPORAL_SEQUENCE**: Traces created within 5 minutes get connected (weight 0.3)

### Step 3: Schema Integration

Use `detectClusters()` on the memory graph (minimum cluster size: 5). For each cluster, invoke an LLM to summarize member traces into a single semantic knowledge node. Connect via `SCHEMA_INSTANCE` edges.

### Step 4: Conflict Resolution

Scan `CONTRADICTS` edges and resolve based on personality:
- High honesty (>0.6): Prefer newer information, soft-delete the older trace
- Default: Prefer higher confidence (only if confidence difference >0.2)

### Step 5: Spaced Repetition

Find traces past their `nextReinforcementAt` timestamp and boost them via `recordAccess()`, which increases stability and doubles the reinforcement interval.

### Result

```typescript
interface ConsolidationResult {
  prunedCount: number;        // Traces soft-deleted
  edgesCreated: number;       // Graph edges created
  schemasCreated: number;     // Semantic schemas from clusters
  conflictsResolved: number;  // Contradictions resolved
  reinforcedCount: number;    // Traces reinforced
  totalProcessed: number;     // Total traces examined
  durationMs: number;         // Cycle duration
}
```

---

## Prompt Assembly

Source: `src/cognition/memory/core/prompt/MemoryPromptAssembler.ts`

Assembles memory context into a single formatted string within a token budget, split across seven sections with overflow redistribution. The preamble's tokens come off the budget first; each section is granted its share of the rest. `tokensUsed` counts the headers and blank lines too, and never exceeds the budget.

### Default Budget Allocation

A share is the least a section with content gets, not a cap (see [Overflow Redistribution](#overflow-redistribution)). Shares set through `tokenBudget` that add up to more than 1 are scaled down, and a share that is not a finite positive number counts as 0. A share set to exactly 0 turns its section off: it gets no grant, takes none of the budget other sections leave unused, and is left out of the block. A key left out of `tokenBudget`, or set to `undefined` or `null`, keeps its default share. The `allocation` the assembly returns holds the shares it used: the defaults with the configured shares over them, 0 for the ones that count as 0, scaled down when they add up to more than 1.

```typescript
// Never show recent episodic memories; every other section keeps its default share.
await memory.initialize({ ...deps, tokenBudget: { recentEpisodic: 0 } });
```

A persona sets the same shares in `cognitiveMemoryConfig.tokenBudget`. [`createAgentCognitiveMemory`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/agentCognitiveMemory.ts) passes the shares of the persona it is given to the manager it builds as `tokenBudget`, and the persona's `encoding`, `decay`, `workingMemoryCapacity`, `observer`, `reflector`, `graph` and `infiniteContext` under the same names. A host that builds its manager from a persona itself, in `gmiManagerConfig.cognitiveMemoryFactory`, passes `persona.cognitiveMemoryConfig?.tokenBudget` the same way. `agent({ runtime: 'gmi' })` and `gmi()` build their persona from their options, which set only `cognitiveMemoryConfig.recall` (from `memory.recall`) and no shares, so their memory runs on the default shares.

```typescript
const persona: IPersonaDefinition = {
  ...basePersona,
  cognitiveMemoryConfig: { tokenBudget: { recentEpisodic: 0 } },
};
const { manager } = await createAgentCognitiveMemory({ persona, memory: { embedding: { provider: 'openai' } } });
```

| Section | Budget % | Content |
|---------|---------|---------|
| Persistent Memory | 5% | The persistent markdown working memory, truncated to fit |
| Working Memory | 15% | Active context from slot buffer |
| Semantic Recall | 40% | Retrieved traces other than episodic |
| Recent Episodic | 25% | Retrieved episodic traces |
| Prospective Alerts | 5% | Triggered reminders (Batch 2) |
| Graph Associations | 5% | Spreading activation context (Batch 2) |
| Observation Notes | 5% | Recent observer notes (Batch 2) |
| Recall (`recall`) | unset: Semantic Recall's and Recent Episodic's together (65% at the defaults) | The one section of `retrieval: 'hybrid'`, in their place ([Recall](#recall)); not read under `'dense'` |

### Overflow Redistribution

Budget a section leaves unused (it is empty, or its content is shorter than its share) flows to the sections that still have content, in `MEMORY_BUDGET_SPILL_ORDER`: Semantic Recall, Recent Episodic, Persistent Memory, Working Memory, Prospective Alerts, Graph Associations, Observation Notes. Each section in that order renders with its own share plus whatever the sections before it left unspent. A second pass in the same order gives what is still unspent (for example the share of a working memory too long for it) to the sections that still have content left out, so the block can fill the whole budget. The second pass only adds to the block. It adds a later line that now fits whole, at its place in the order, adds lines to a section that rendered none, and lengthens the persistent-memory text when the first pass cut it. Every line the first pass rendered stays, in its section and its order. A store that holds only episodic traces, assembled at the configured budget the GMI's memory bridge asks for, 1,600 tokens by default ([Recall Budget](#recall-budget)), fills the block with episodic traces rather than stopping at their 25%. Sections still appear in the block in the order shown under [Output Sections](#output-sections). When a host passes the mechanisms engine, the involuntary memory is chosen first, from the traces the turn did not retrieve, and a tenth of the budget after the preamble is set aside for it before the sections are granted theirs. A memory that does not fit that tenth whole is tried again on what the sections leave unspent, and is left out when it does not fit that whole either.

### Overflow: whole memories only

A line that shows a memory renders whole or not at all: a retrieved trace in Relevant Memories or Recent Experiences, a graph association in Related Context, and the involuntary memory. One that does not fit whole in what is left of its section is left out, never cut, and the lines after it in the section's order are still tried, so its room goes to the next line that fits. What drops when the block overflows is whole memories, the ones that find no room. No memory line carries `…[cut]`.

A section with 200 characters left and two traces to place, the first with a 500-character line and the second with a 150-character line, leaves the first out and shows the second whole:

```typescript
const context = assembleMemoryContext({ totalTokenBudget, traits, retrievedTraces: [long, short] });

context.includedMemoryIds; // ['short']
context.lineOutcomes;
// [
//   { id: 'long',  section: 'semanticRecall', outcome: 'left_out', reason: 'section_full', tokens: 126 },
//   { id: 'short', section: 'semanticRecall', outcome: 'included', tokens: 38 },
// ]
```

`lineOutcomes` reports what became of each such line, one entry a trace, in the block's order: the retrieved traces of Relevant Memories and Recent Experiences, the graph associations that carry a trace id, then the involuntary memory. Each entry is an [`AssembledLineOutcome`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts):

| Field | Value |
|-------|-------|
| `id` | The id of the trace the line shows, or leads to |
| `section` | `semanticRecall`, `recentEpisodic`, `recall` (the one Relevant Memories section of `retrieval: 'hybrid'`), `graphAssociations` or `involuntary`: the section that shows the trace, or, for a trace left out, the first section in the block's order that had a line for it |
| `outcome` | `included` or `left_out` |
| `reason` | Set only for a line left out. `section_full`: the whole line did not fit what its section was offered. `budget`: its section was offered no tokens at all (its share is 0, or the budget had none for it) |
| `tokens` | Tokens of the line with its newline, about 4 characters a token: as rendered when included, as it would render whole when left out |

A trace is reported once, under the section that shows it. A trace the block shows only through its graph association is reported as included under `graphAssociations` and is not listed in `includedMemoryIds`, which holds the traces rendered in their own sections and the involuntary memory. An association left out because the block already holds its trace adds no entry. `assembleForPrompt()` returns `lineOutcomes` with every block it assembles; a memory manager that builds its context another way may leave the field out.

The persistent-memory section is the exception. Its text is one document, not a ranked memory: when it does not fit it is cut to fit and ends with `<!-- truncated -->`.

### Trace Lines

A trace's content is rendered whole. A trace that does not fit whole in what is left of its section is left out, and the traces after it are still tried, in order, while the section has room (see [Overflow: whole memories only](#overflow-whole-memories-only)). Graph associations follow the same rule. Lines of the other sections are whole or skipped too; only the persistent-memory text is cut to fit. An association that leads to a trace the block already holds, in Relevant Memories, Recent Experiences or the involuntary memory, is left out of Related Context, and the associations after it take its room: spreading activation leaves out only the top three retrieved traces, so a fourth can come back as an association of the first, and it then appears once, in its own section. In the second pass a trace section leaves out a trace that Related Context already shows through its association, so the trace still appears once and the room goes to the lines after it. As the second pass drops no line, a trace whose association was left out stays in the block. `assembleMemoryContext()` takes a graph association as `{ traceId, text }` (`MemoryGraphAssociation`) for this; a plain string line carries no id and is never left out for it. Persistent memory's text, when cut to fit, is never cut inside a surrogate pair, so an emoji is kept or dropped whole. Working memory keeps its leading slots when the whole list does not fit: its slots are sorted by activation, so the first slot that does not fit ends the section and no lower slot takes its place.

Every line carries the trace's age and the UTC date it was stored (`createdAt`): `just now`, `Nm ago` and `Nh ago` under a day; from a day on, the number of UTC calendar days between the stored date and the turn's date, as `Nd ago` under a week and `N days ago` from a week on; then `, YYYY-MM-DD`. Counted in calendar days, the age always agrees with the date: a trace stored at 23:00 UTC on 2026-10-12 reads `27 days ago, 2026-10-12` at 00:30 UTC on 2026-11-08, though fewer than 27 whole 24-hour periods have passed. A trace stored 26 days before the turn reads:

```
- [episodic] user: which locker did we pick? ... (26 days ago, 2026-10-13 | moderate confidence | relevance: 0.62)
```

### Personality -> Formatting Style

The assembler selects a formatting style by comparing conscientiousness, openness and emotionality (ties go in that order):

| Dominant Trait | Style | Output |
|---------------|-------|--------|
| Conscientiousness | `structured` | Bullet points, categories |
| Openness | `narrative` | Flowing prose, connections |
| Emotionality | `emotional` | Emphasis on feelings, tone |

### Output Sections

```
## How To Use Your Memories
...

## Persistent Memory
...

## Active Context (in focus — reference directly)
- [ACTIVE] mt_1234 (activation: 0.85)

## Relevant Memories (facts — use as background truth, don't announce)
...

## Recent Experiences (events — weave in naturally, never list)
...

## Reminders (act on these — bring up naturally)
- [time_based] PR review is due

## Related Context (connected memories — use for depth)
...

## Observations
...

## Something This Reminds Me Of
[spontaneous memory] ...
```

Under `retrieval: 'hybrid'` the two recall sections are one, in Relevant Memories' place, and Recent Experiences is not shown:

```
## Relevant Memories (facts and past events, most relevant first — use as background, don't announce)
...
```

The preamble appears when the budget has room for it and 100 more tokens. `assembleForPrompt()` never fills the last two sections: it passes no observer notes (their 5% flows to the sections with content), and it passes neither the mechanisms engine nor the trace pool that the involuntary-recall section needs. Both sections appear only when a host calls `assembleMemoryContext()` (from `@framers/agentos/cognition/memory`) itself, with `observationNotes`, or with `mechanismsEngine` and `allTraces`. How each trace line reads depends on the formatting style.

Token estimation uses ~4 chars per token heuristic.

### Upgrading from 0.17.3 or earlier

- A store loads traces stored in the same millisecond by id, compared character code by character code, in the whole-brain hydration of its first recall and in `hydrateScope`. Through 0.17.3 they loaded in an order each engine's query plan left open: on SQLite it followed how the rows were read (in the order they were stored in one store, the newest first in another), and on PostgreSQL it also changed as rows were updated, so two loads of the same traces could differ. A host sees it in the memory block a GMI sends (`agent({ runtime: 'gmi' })`, `gmi()`) and in a turn's `memoryRecall.candidates`: equally scored traces of one millisecond are listed by id, and the same traces give the same block on SQLite and on PostgreSQL, and from one load to the next. On either engine, two such traces can come back in the other order than before. Traces stored in different milliseconds load as before.

### Upgrading from 0.17.2 or earlier

- `recall.rerank` refuses at construction two values 0.17.2 accepted, with a `RecallOptionError` (reason `invalid_value`) and one `memory.recall.option_rejected` line naming the field. A `local` one's `revision` in upper or mixed case (`rerank.revision`): give the commit id in lower case, as Hugging Face Hub shows it; 0.17.2 matched the id case-insensitively and loaded the files from the id as written, which finds the lower-case folder on a case-insensitive file system and misses it on a case-sensitive one. A `timeoutMs` above 2,147,483,647 (`rerank.timeoutMs`): a timer set past it runs after 1 ms, so on 0.17.2 such a rerank timed out on every turn and the turns answered unreranked. `agent()`, `gmi()`, a persona's `cognitiveMemoryConfig.recall`, `CognitiveMemoryManager.initialize()` and `applyRecallConfig()` all refuse them.

### Upgrading from 0.17.1 or earlier

- `CognitiveMemoryConfig.rerankerService` is no longer read for memory recall: set `recall.rerank` (`'none'`, the default; `{ kind: 'local', model, revision }`; `{ kind: 'llm', invoke, model }`; see [Recall](#recall)). Through 0.17.1 a manager given a `rerankerService` reranked every recall with the service's default provider, a remote one included. It now calls no provider but the one `recall.rerank` names, writes one `memory.recall.option_ignored` line (`option: 'remote_provider'`) when it initialises with a service, and returns the service from `getRerankerService()` as before. The capture's `reranker.provider` is `none`, `local` or `llm`; the manager no longer records `other`. A reranked recall scores the best 20 candidates (`maxCandidates`; through 0.17.1, the first 100), and under `retrieval: 'hybrid'` the rerank now orders the cut and leaves each line's relevance as it was.
- `LOCAL_RERANKER_MODELS` no longer lists `BAAI/bge-reranker-large` and `sentence-transformers/ce-ms-marco-TinyBERT-L-4`, and names the MiniLM models by their repositories' current ids, `cross-encoder/ms-marco-MiniLM-L6-v2` and `cross-encoder/ms-marco-MiniLM-L12-v2`; `LocalRerankerModel` narrows with it, so code that types one of the removed or earlier ids as a `LocalRerankerModel` no longer compiles. `LocalCrossEncoderReranker` loads any id it is given, the removed and earlier ones included.
- `LocalCrossEncoderReranker`'s default model id is `cross-encoder/ms-marco-MiniLM-L6-v2` (it was `cross-encoder/ms-marco-MiniLM-L-6-v2`, the same repository's earlier id). A host that fetched the model's files ahead into a cache folder named for the earlier id, and builds the provider without a `defaultModelId`, names the earlier id or moves the folder.
- `memory.recall` gains `rerank` (a `local` one's `revision` a whole commit id in lower case; `timeoutMs` at most 2,147,483,647); `LocalCrossEncoderConfig` gains `revision` and `localFilesOnly`; `LlmJudgeReranker`'s `diagnostics.providerMetrics` gains `scoringFailures` and `listwiseFailed`; `CognitiveMemoryManager` gains `recallReady()` and `applyRecallConfig()`. `MEMORY_RERANK_MAX_DOCUMENTS` is deprecated and read by nothing.
- `memory.recall` (and a manager's `recall`) gains `retrieval`, `'dense'` by default: a memory that sets none, or sets `'dense'`, recalls and renders as before, byte for byte. `'hybrid'` fuses the dense, exact-words and recency legs into one deduped pool and shows it as one Relevant Memories section ([Recall](#recall)). A value other than the two, or `retrieval` on the default runtime, is refused at construction (`RecallOptionError`, `option: 'retrieval'`). The capture's `LegAbsentReason` gains `no_scopes`, which a hybrid recall with no `scopes` reports for its exact-words and recency legs: a `switch` or `Record` over the reasons needs it.
- Under `'hybrid'`, a memory question reserves room for exact-words hits past the cut, so `retrieve()` can return up to `topK` plus one in ten of it; a manager's `recall.memoryQuestion` replaces the English rule. `CognitiveRetrievalOptions` gains `supplied`, `MemoryAssemblerInput` gains `reservedIds`, and `diagnostics.recall` gains `reserve` and `suppliedRejected`. A call that passes nothing new recalls and renders as before.
- `MemoryBudgetAllocation` gains the optional `recall` share; an allocation of the seven fields still type-checks. A hybrid block's `allocation` sets it, with `semanticRecall` and `recentEpisodic` at 0, and its lines report `section: 'recall'`, so `AssembledLineOutcome['section']` and the capture's `section` include `'recall'`: a `Record` keyed by every section needs a `recall` entry.
- `retrieve()`'s `diagnostics.recall` gains `retrieval`, and under `'hybrid'` the pool (`ranked`), the `lexicalBackend` and the fusion's `timings`. `MemoryStore` gains `scoreForRecall(traces, mood, options)`, and `@framers/agentos/cognition/memory` exports `fuseRankedLists` (reciprocal rank fusion over any number of lists; `reciprocalRankFusion` is unchanged) and `RECALL_CONSTANTS`.
- A Brain row whose metadata names no `scopeId` loads under its `scope_id` column in a store's hydration and in a scope's hydration (`hydrateScope`), as the by-id load (`loadTracesForRecall`) reads it. Through 0.17.1 the two hydrations loaded it under `''`, so after a restart a recall of its scope did not return it, and a by-id load of it then answered nothing. Rows this store and the `Memory` facade write name both, and load as before.

### Upgrading from 0.17.0 or earlier

- A trace's trust policy is written into its Brain row's metadata (`policy`) and read back when a store loads the row. Through 0.17.0 a trace loaded from the Brain (a fresh store's hydration) had no policy, so a `retrieve()` with `usableFor` let it through whatever policy it was stored with; a user statement, stored with `usableForAuthorization: false`, passed an `authorization` check after a restart. A row an earlier release wrote holds no policy and loads as before.
- A recall whose query the embedding manager gives no vector reports the dense leg as `{ ran: false, reason: 'no_embedder' }` in the recall capture's `legs`, and the process writes one `memory.recall.leg_absent` line (`leg: 'dense'`, `reason: 'no_embedder'`). Through 0.17.0 the leg read `ran: true` with no candidates. The recall returns no traces, as before. `MemoryStore.query` sets `emptyQueryVector: true` on its result then, and an error the embedding call throws is rethrown unchanged, known by `isQueryEmbeddingFailure(error)`.
- The capture's dense leg counts in `ineligible` the traces the `usableFor` trust-policy check dropped; through 0.17.0 it read 0. `retrieve()`'s `diagnostics.recall` carries the `legs` the capture reports.
- `MemoryStore` gains `loadTracesForRecall(ids)` and `addTraceListener(listener)`; see [Lexical and Hybrid Search](../text/LEXICAL_AND_HYBRID_SEARCH.md#reading-memory-traces-by-id-and-following-a-store). The ranking `retrieve()` returns and the block are unchanged.

### Upgrading from 0.16.0 or earlier

- A GMI turn sizes the memory block for the model each hop is sent to. When what the model's retrieved-context share (20% of its context) leaves after the turn's RAG and long-term-memory text is smaller than the block, the block is rendered again at that remainder from the turn's one recall: no second retrieval and no embedding call, and memories drop whole. Through 0.16.0 every model was sent the block assembled at the full budget, joined to the other context, and PromptEngine cut or summarised the joined text when the share was smaller. A model whose share holds the block gets the same block as before. See [Budget and the prompt share](#budget-and-the-prompt-share).
- PromptEngine takes the memory block as `PromptComponents.memoryContextText`, counts it into the prompt and never reduces it: when the prompt must be reduced, only `retrievedContext` is summarised or truncated, to what the share leaves beside the block. Through 0.16.0 the GMI joined the block into `retrievedContext`, so a reduction could cut or summarise it. A prompt nothing was reduced in is the same byte for byte: the block goes first, joined to the other context with `\n\n---\n\n`, as the GMI joined it.
- For a host that calls PromptEngine itself: the `anthropic_messages` and `generic_completion` templates send `retrievedContext`, and with it the memory block, in front of the query (`Context:`), as `openai_chat` does; through 0.16.0 they left it out. A prompt over its budget whose other context already fits beside the block leaves that context as it is and reports no cut.
- For a host that calls PromptEngine itself: on a prompt over its budget, `retrievedContext` is truncated to what the summariser is asked for (the share less the overrun), where through 0.16.0 the truncation kept the whole share; a target of 0 removes it (`removedComponents`) instead of asking the summariser for an empty summary. `PromptEngineResult.metadata.contextTokens` holds PromptEngine's counts of the memory block and of the other context before and after the budget step.
- A GMI turn's recall record (`GMIOutput.memoryRecall`, a session's `memoryRecall`) is the record of the hop that served the turn: its `budget` names the hop, the share and any clamp or re-render, and `delivery` says what reached the model. The `MEMORY_SOURCES_AVAILABLE` chunk and the runtime stream's `memorySources` update carry the assembly's record, without those fields. See [Recall Capture](#recall-capture).
- `ICognitiveMemoryManager` gains the optional `reassembleForBudget(context, tokenBudget)`, which `CognitiveMemoryManager` implements; the bridge asks a manager without it through `assembleForPrompt` again, at the lower budget, with the turn's query and scopes. A manager whose `reassembleForBudget` rejects is not asked again: the hop is sent no block.
- `IPromptEngine` gains the optional `acceptsMemoryContextText`, which PromptEngine sets. A host's own prompt engine without it is handed the memory block joined in front of `retrievedContext` with `\n\n---\n\n`, as through 0.16.0, so it still sends the block; such an engine can cut or summarise the block, and the record's `delivery.memoryBlockTokens` is 0, since only PromptEngine reports its counts.
- The bridge's trace entries "Cognitive memory assembly failed." and "Cognitive memory re-render for a model hop failed." carry the error's class (`errorName`), not its message, which can quote the turn's words. Through 0.16.0 the first carried `error` with the message.
- On `agent({ runtime: 'gmi' })` and `gmi()`, a `memory.recall` set beside a `cognition.memory` of the agent's own is not applied, as through 0.16.0, and the construction now writes one `memory.recall.option_ignored` line (`option: 'memory_recall'`). Set `recall` inside `cognition.memory`.
- On `gmi()`, `memory: null` is the option unset, as on the rest of `agent()`: on the `'light'` profile, and on a `CognitionConfig` that sets no memory, it leaves cognitive memory off. Through 0.16.0 the sessions ran without memory while the learning manifest reported the memory loop live, and a `memoryProviderOptions.tokenBudget` beside it wrote a `token_budget` `option_ignored` line.

### Upgrading from 0.15.124 or earlier

- `memory.recall` on `agent()` and `gmi()` sets the memory block's budget (`budget.totalTokens`, the whole block, 1,600 by default) and the capture (`capture`, `'metadata'` by default), and the GMI's memory bridge asks for the manager's `recall.budget.totalTokens` in place of a fixed 1,600. With none set the block is the same byte for byte. See [Recall Budget](#recall-budget).
- `CognitiveMemoryManager.initialize()` and `createAgentCognitiveMemory()` refuse a `recall` that holds a value of the wrong kind, or that is not an object or holds a `budget` that is not one, with a `RecallOptionError` naming the field. Through 0.15.124 they took any value.
- `createAgentCognitiveMemory()` puts `memory.recall` over the persona's `cognitiveMemoryConfig.recall` field by field, `budget.totalTokens` included: an agent budget that leaves the total unset keeps the persona's.
- On a GMI agent with cognitive memory on, `memoryProviderOptions.tokenBudget` never sized the memory block; when it is set and no `memoryProvider.getContext` reads it, the agent's construction writes one `memory.recall.option_ignored` line (`option: 'token_budget'`). On the default runtime, or with memory off, a `memory.recall.budget.totalTokens` that no `memoryProvider.getContext` reads writes one with `option: 'recall_budget'`.
- A GMI turn that fails after its memory assembly carries that assembly's capture on its error output (`GMIOutput.memoryRecall`), so a session's `stream()` settles `memoryRecall` with it. Through 0.15.124 the error output carried none.
- The capture record's `embedder` names the embedding provider and model of a memory `agent()` or `gmi()` builds.
- The GMI's reasoning-trace entry "Cognitive memory context assembled." no longer lists `includedMemoryIds`. It carries `tokensUsed`, `candidates`, `included`, `leftOut`, `retrieval`, `reranker` and `legsAbsent`, and lists the ids again with `recall: { traceIds: true }` on the memory manager's configuration. See [Recall Capture](#recall-capture).
- `assembleForPrompt()` returns a recall capture on `capture` unless the manager's `recall.capture` is `'off'`, and a GMI turn carries it as `GMIOutput.memoryRecall` and on a session's `send()` result as `memoryRecall`. The fields are optional, so a memory manager or an `IGMI` that sets none compiles unchanged. The runtime stream carries the record only under `'metadata+stream'`, so a stream consumer sees nothing new by default. The block is the same byte for byte with any capture setting.
- `LlmJudgeReranker` answers with `diagnostics` (`providerId: 'llm-judge'`, its `rankingModel` or `''`, latency, the passages it scored), so the capture names it `llm`. A manager's memory recall passes `maxDocuments: 100` on its rerank call, the limit `RerankerService` applied when the call named none.

### Upgrading from 0.15.122 or earlier

- A memory line that does not fit whole in what is left of its section is left out and its room goes to the next line that fits; no memory line carries ` …[cut]` (the persistent-memory text keeps its own `<!-- truncated -->` marker). The rule covers a retrieved trace, a graph association and the involuntary memory, for every caller of `assembleMemoryContext()` and `assembleForPrompt()`. In 0.15.121 and 0.15.122 such a line was cut at a word boundary to fit and ended with `…[cut]`, so a block that held a cut line now holds one memory fewer, or a shorter one that fits in its place. A block whose memories all fit is unchanged. See [Overflow: whole memories only](#overflow-whole-memories-only).
- The assembled context carries `lineOutcomes`: for each trace the block was given a line for, whether the block shows it (`included`) or not (`left_out`, with the reason `section_full` or `budget`), and the line's tokens. The field is optional on `AssembledMemoryContext`, so a memory manager that returns its own context compiles unchanged.

### Upgrading from 0.15.121 or earlier

- A graph association that leads to a trace the block already holds (a retrieved trace past the three that seed the graph walk, or the involuntary memory) is left out of Related Context, so the trace appears once and the next association takes its room. In 0.15.121 such a trace appeared in its own section and again, whole, in Related Context; through 0.15.120 the repeat was cut to 150 characters.
- The second pass, which spends the budget the first pass left unspent, only adds to the block: every line the first pass rendered stays, in its section and its order. In 0.15.121 the second pass rendered a section again from the start on its larger room, and a long item the first pass skipped could be cut to fit and push out a shorter line the first pass showed (a Related Context line, or a recalled trace).
- `MemoryAssemblerInput.graphContext`, which `assembleMemoryContext()` takes, is `(string | MemoryGraphAssociation)[]`: an entry is a plain line or `{ traceId, text }`. Through 0.15.121 it was `string[]`. Code that reads its elements as strings no longer type-checks; narrow each one first:

  ```typescript
  const lines = (input.graphContext ?? []).map((item) => (typeof item === 'string' ? item : item.text));
  ```

- `createAgentCognitiveMemory` passes the `cognitiveMemoryConfig` of the persona it is given to the manager it builds: `tokenBudget`, `encoding`, `decay`, `workingMemoryCapacity`, `observer`, `reflector`, `graph` (laid over its `{ backend: 'knowledge-graph' }`) and `infiniteContext`, a field or key set to `undefined` or `null` keeping the default. The persona loaders drop the `null` values a persona read from JSON holds inside `cognitiveMemoryConfig` (a field, a key inside a field, or the whole config set to `null`), so a host's `cognitiveMemoryFactory` gets a persona that matches `CognitiveMemoryPersonaConfig`. Through 0.15.121 the fields were declared and nothing read them, so the manager ran on the default shares and settings. `featureDetectionStrategy` is still not read: `createAgentCognitiveMemory` runs `'keyword'`. `infiniteContext` takes effect only with `maxContextTokens`, which `createAgentCognitiveMemory` does not set.

### Upgrading from 0.15.120 or earlier

What callers see differently in the memory block and its formatters:

- `assembleForPrompt()` renders each recalled trace whole. A trace that does not fit what is left of its section is left out (in 0.15.121 and 0.15.122 it was cut at a word boundary and ended with `…[cut]`; see [Upgrading from 0.15.122 or earlier](#upgrading-from-015122-or-earlier)), and budget a section leaves unused flows to the sections with content (see [Overflow Redistribution](#overflow-redistribution)), so a section can hold more than its share. Through 0.15.120 each trace was cut to about 300 characters (350 in the narrative style), and only Semantic Recall took budget other sections left unused.
- `formatMemoryTrace` and `formatMemoryTraces` (exported from `@framers/agentos/cognition/memory`) return the whole content of a trace when called without `maxChars`. Through 0.15.120 they cut it to about 300 characters (350 in the narrative style). A caller that needs a bound passes `formatMemoryTrace(trace, style, { maxChars })`.
- `assembleForPrompt()` puts a graph association's whole content in Related Context, and leaves the association out when it does not fit what is left of the section (in 0.15.121 and 0.15.122 it was cut to fit). Through 0.15.120 every association was cut to 150 characters.
- The involuntary memory is chosen from the traces the turn did not retrieve: every retrieved trace is left out of its pool, including one that did not fit the block. Through 0.15.120 only the traces that made it into the block were left out.
- A `tokenBudget` share of exactly 0 turns its section off. With the budget other sections leave unused flowing to the sections with content, a 0 share would otherwise still render its section. The default allocation has no zero share, so a host that sets none sees no change.
- Each line carries the UTC date the trace was stored after its age, and an age from a week on reads `N days ago`. Through 0.15.120 a line carried no date and an age from a week on read `Nw ago`. Ages of a day or more count UTC calendar days between the stored date and the turn's date, so the age and the date agree: a trace stored at 23:00 UTC on 2026-10-12 reads `27 days ago, 2026-10-12` at 00:30 UTC on 2026-11-08, one more than the whole 24-hour periods between them.
- The returned `allocation` holds the shares the assembly used, not the configured ones.

## Recall

A memory's `recall` setting holds four fields. On `agent({ runtime: 'gmi' })` and `gmi()` it is `memory.recall`; on a persona, `cognitiveMemoryConfig.recall`; on a manager, the `recall` of its configuration, which a host of `AgentOS.create` sets on the manager its `gmiManagerConfig.cognitiveMemoryFactory` builds.

```typescript
const assistant = agent({
  runtime: 'gmi',
  provider: 'openai',
  memory: {
    embedding: { provider: 'openai' },
    store: { path: './brain.sqlite' },
    recall: {
      budget: { totalTokens: 2400 },
      retrieval: 'hybrid',
      rerank: { kind: 'local', model: 'cross-encoder/ms-marco-MiniLM-L6-v2', revision: '233902d25c440f23af6f7d6e94d2946bac0bee0a' },
      capture: 'metadata',
    },
  },
  learning: { agentKey: 'assistant', mode: 'off' },
});

// The same fields on a manager:
await manager.initialize({ ...config, recall: { budget: { totalTokens: 2400 }, retrieval: 'hybrid', capture: 'metadata' } });
```

| Field | Values | Default | What it changes |
|---|---|---|---|
| `budget.totalTokens` | An integer of at least 0 | 1,600 | The size of the whole memory block a GMI turn sends, its preamble included ([Recall Budget](#recall-budget)) |
| `retrieval` | `'dense'`, `'hybrid'` | `'dense'` | How a turn finds its memories, and whether the block shows them in two sections or in one (the legs, the pool and the rules below) |
| `rerank` | `'none'`, `{ kind: 'local', model, revision }`, `{ kind: 'llm', invoke, model }` | `'none'` | Whether a model reorders the recall's best candidates before the block is assembled (Rerank, below, and [Memory rerank](../text/RERANKING.md#memory-rerank)) |
| `capture` | `'metadata'`, `'metadata+stream'`, `'off'` | `'metadata'` | What a turn records of its recall and where the record goes, never what the block holds ([Recall Capture](#recall-capture)) |

A memory that sets none of the four recalls, renders and records as one that sets each to its default. A manager's `recall` also takes `constants` and `memoryQuestion` (both below), `traceIds` ([Recall Capture](#recall-capture)) and `embedder`, a label the capture copies. `agent()` and `gmi()` refuse a value of the wrong kind when the agent is built, and a manager when it initialises, naming the field ([Sessions served by GMIs](../getting-started/HIGH_LEVEL_API.md#sessions-served-by-gmis-runtime-gmi) lists the construction rules).

**A host with no embedding model.** Cognitive memory embeds every trace it stores and every query it recalls for, whatever the recall setting. A manager is built on an `embeddingManager`, and an `agent()` or `gmi()` memory that finds no embedding model fails the session's first turn with an error naming `memory.embedding`. `'hybrid'` does not lift that: its exact-words and recency legs run beside the dense leg and carry a turn alone whenever the dense leg returns nothing, which happens when the embedder gives the turn's query no vector or throws, and when the vector search finds no memory in the turn's scopes (When something is missing, below). Set `memory.embedding`.

`recall.retrieval` sets how a turn finds its memories. `'dense'`, the default, is the vector recall: the store's query by meaning and its six-signal ranking ([Retrieval Priority Scoring](#retrieval-priority-scoring)), shown in Relevant Memories and Recent Experiences. `'hybrid'` adds two legs and fuses all three into one pool:

| Leg | What it reads | How many |
|---|---|---|
| `dense` | The vector index, as `'dense'` reads it: the query embedded once, the six-signal ranking, the memory graph's activation | `topK × overFetch` (60) |
| `exact_words` | The store's full-text index (`memory_traces_fts`, or Postgres's tsvector column) through the storage adapter's full-text query; on a store with no Brain, an in-process index of the words of the traces this process filed or loaded (with a vector store that outlives the process, a trace another process filed is not in it), a query word matching the words that begin with it | `topK × overFetch` (60) |
| `recency` | The newest traces | `recentTopK` (10) |

The turn's scopes, types and `timeRange.after` are inside each leg's query, so another user's or organization's rows are never read, and a trace under `minConfidence` or one whose trust policy refuses the asked `usableFor` passes no leg (`legs[].ineligible` counts them, with no id). A `retrieve()` with no `scopes` gets the dense leg over the store's known scopes and nothing from the other two, which never read without a scope: the capture reports them `{ ran: false, reason: 'no_scopes' }` and `lexicalBackend: 'none'`.

**The pool.** Every candidate of every leg stays in the pool, an exact-words-only one included, ordered by reciprocal rank fusion: `0.7 / (60 + dense rank) + 0.3 / (60 + exact-words rank) + 0 / (60 + recency rank)`, a leg that did not return a trace adding nothing. Equal scores keep a fixed order: by exact-words rank, then by recency rank (newest first), then by id, so recency-only candidates follow every other candidate. A trace only the exact-words or recency leg found carries the store's cognitive score with similarity 0 (`MemoryStore.scoreForRecall`), which its line shows as its relevance. A trace deleted while the legs ran leaves the pool. A rerank (`recall.rerank`, below) orders the cut pool and leaves every fused score and each line's relevance as they were. A recall the retrieval policy suppresses (`diagnostics.suppressed`) returns no memory and its capture records no recalled candidate, as under `'dense'`; it returns the call's supplied candidates alone (Supplied candidates, below). The pool is cut at `topK` (20) and shown as one section, `## Relevant Memories (facts and past events, most relevant first — use as background, don't announce)`, in fused order, on the `recall` share (unset: the Semantic Recall and Recent Episodic shares together; see [Default Budget Allocation](#default-budget-allocation)).

| Constant | Start | |
|---|---|---|
| `rrfK` | 60 | The rank smoothing |
| `denseWeight` | 0.7 | |
| `sparseWeight` | 0.3 | The exact-words leg's weight |
| `recencyWeight` | 0 | The recency leg adds candidates and moves no fused score |
| `overFetch` | 3 | The dense and exact-words legs return `topK × overFetch` |
| `topK` | 20 | The pool's cut (a turn's `topK` sets it) |
| `nearDuplicate` | 0.80 | The token-set Jaccard index at which two memories are one |
| `recentTopK` | 10 | The recency leg's size |

They are `RECALL_CONSTANTS`; a manager's `recall.constants` lays values over them by name, for a bench that tunes them, and they move only through measured runs. A name that is not one of the eight, a count (`topK`, `overFetch`, `recentTopK`) that is not an integer from 1 to 1,000, a `nearDuplicate` outside (0, 1], or any other value that is not a finite number of at least 0 is refused at construction.

**When exact words changes the block.** At these constants an exact-words-only candidate does not reach the block of a large store: at exact-words rank 1 it scores 0.3 / 61 = 0.0049, below a dense-only candidate at rank 60 (0.7 / 120 = 0.0058), so with sixty dense candidates it sorts after them and the cut at 20 leaves it out (the capture records it `left_out`, reason `budget`). Exact words changes the block where a candidate is in both lists, since its two terms add, and where the dense leg returned fewer than sixty.

**Dedupe.** Two candidates whose words (runs of letters, digits and `_`, lower-cased, stop words dropped) are equal or have a Jaccard index of at least `nearDuplicate` are one memory: a trace a consolidation pass rewrote, or two writers filed from one exchange, differ in a few words, while two memories of one subject that differ in a fifth of their words stay apart. A changed value keeps two texts apart in two ways. A one-character word counts, a stop word among them (`a`, `i`), though the exact-words leg drops it, so "My locker number is 7" and "My locker number is 9" are two memories, and so are "We meet in room A" and "We meet in room I". Two texts that each hold a word with a digit the other lacks (a different number, code, date or amount) are two memories whatever else they share, so a correction of such a value is never dropped as a duplicate, however long the text. A correction that changes one word with no digit is one memory with the text it corrects when the two share eight or more other words (8 of 10 is 0.80), and the newer text stays: of two near-duplicates whose words differ, the one with the newer `createdAt` is kept, since such a pair is most often one memory after a correction or a rewrite and the later text is its current state. It takes the better of the two fused scores and the higher-ranked one's place, and keeps its own `ranks` (the legs that found its text), so "My sister Ana moved out of the old riverside flat last spring and now lives in Lisbon" is shown where the older text ending "Porto" ranked, and the Porto text is not shown. Two candidates with the same words, or a pair of which one has no `createdAt` (a supplied candidate given none), keep the higher fused score; on equal scores the newer, in the older one's place, and with no time to compare, the one earlier in the pool. A candidate dropped against a text that a newer one then replaced is looked at again: it stays dropped only when it repeats a kept text, so `duplicateOf` always names a text it repeats. Each kept text then carries the best fused score and the highest place of the texts it stands for (its own and those dropped against it), so a text kept again takes its score and place back. A memory corrected twice, each correction one word apart from the text before and the first and last two words apart, shows its first text beside its last: the middle text is dropped against the last, and the first repeats no kept text, so it is kept. Under `'dense'` all three show. The capture records the other `left_out` with reason `dedupe` and `duplicateOf`, the id it repeats, and a re-render for a model hop keeps that record. A graph association whose memory the cut pool holds, in the same words or nearly, is not shown in Related Context. The check reads the pool after its cut at `topK`, so when the memory a dropped candidate repeats is past the cut, the graph can still lead to the dropped one: Related Context then shows it, and the capture records it `included` under `graphAssociations`, with its `duplicateOf`.

**Memory questions.** A turn that asks about something said before gets room for what only its exact words found. The rule, `isMemoryQuestion(turnText)` (exported from `@framers/agentos/cognition/memory`), lower-cases the turn's text and matches, each at a word boundary, one of: `remember`, `recall`, `remind me`, `did i (say|tell|mention)`, `have i (told|mentioned|said)`, `what did i (say|tell)`, `what was my`, `what('s| is) my … (name|favou?rite|birthday)`, `last time`, `earlier (i|you) (said|mentioned)`, `you (said|told me)`. A typographic apostrophe (`’`, as a phone keyboard types it) reads as `'`. It is deterministic, calls no model, and reads English only. A host replaces it on the manager with a function of the turn's text (a JSON persona cannot hold one); one that throws, returns a promise (its rejection is handled), or answers anything but `true`, is read as no:

```typescript
await manager.initialize({ ...config, recall: { retrieval: 'hybrid', memoryQuestion: (text) => /\b(remember|lembra)\b/i.test(text) } });
```

When it fires, the candidates found by exact words and not by meaning that the cut at `topK` left out are reserved, in exact-words rank order, at most one in ten of `topK` and at least one (2 at `topK` 20). They follow the cut in `retrieve()`'s `retrieved`. A reserve is room, never a promise: before the recall section fills, it sets aside each reserved line's whole tokens while they fit, in reserve order; the other lines then fill what is left in fused order, and the reserved lines render after them. A reserved line that does not fit whole is left out (`section_full`, or `budget` when the section had no room at all), and a line that lost its room to a reserve is `section_full`. The capture records `memoryQuestionReserve: { fired, added }` every turn (`fired` when the rule said yes, whatever it found; `added`, the reserved lines the block shows), marks each reserved candidate `reserve: true`, and the process writes `memory.recall.reserve_fired` with `added` at debug level. With the capture `'off'` the block reserves the same room. At the starting constants an exact-words-only candidate never reaches the cut of a store with sixty dense candidates ([When exact words changes the block](#recall)), so on a large store the reserve is how a memory question shows such a memory.

**Supplied candidates.** A caller adds facts it holds outside the memory (an account's plan, an attachment's text) to one call's pool with `supplied`, on `assembleForPrompt()` or `retrieve()`:

```typescript
const context = await manager.assembleForPrompt('Which plan am I on?', 1600, mood, {
  scopes: [{ scope: 'user', scopeId: 'u1' }, { scope: 'organization', scopeId: 'acme' }],
  supplied: [{ id: 'acct-plan', text: 'The account is on the Team plan, renewed 2026-10-01.', scope: { scope: 'organization', scopeId: 'acme' }, score: 0.5, createdAt: Date.UTC(2026, 9, 1) }],
});
```

- **Scope.** `scope` is required and must equal one of the call's `scopes`, `scope` and `scopeId` as passed on both sides (`'acme'` and `'Acme'` are two). A candidate outside them, and every candidate on a call with no `scopes`, is dropped before the pool, so it is never shown and its id is never recorded: the capture counts it in `suppliedRejected.outOfScope` and the process writes `memory.recall.supplied_rejected` with the counts alone. A caller's data for another user or organization cannot reach a turn that does not read that scope.
- **What drops one.** A supplied candidate has no type, confidence or trust policy, so a call that sets `types`, `minConfidence` or `usableFor` drops every one; so does a blank `id` or `text`, an `id` given twice, and a `createdAt` before `timeRange.after`. A call adds at most `topK × overFetch` (60), as many as a leg returns, the best-scored first and the unscored after them. These count as `suppliedRejected.ineligible`. One whose `id` names a memory the pool or the store holds is that memory and is not added, so a caller's text never takes a stored memory's id and hides its Related Context line: one the pool holds is shown as that memory and not counted, and one only the store holds counts as `ineligible`.
- **Score.** `score` is on the caller's own scale and is compared with the fused scores as it is; a retrieval policy's `minScore` reads the recalled memories alone, so a supplied score neither lifts weak hits past it nor is suppressed with them. Those are at most 0.0164 at the starting constants (`1 / 61` with both weights), so a score above about 0.02 puts the candidate ahead of every recalled memory; without one it takes the lowest fused score of the pool. The capture records it with `ranks: { supplied: n }` and that score.
- **Shown, never stored.** A kept candidate joins the pool before the dedupe and the cut and is shown as a semantic memory line with its own age (`createdAt`, or now) and the relevance of a fact the caller vouches for, `1.00`; its `score` orders the pool and is not shown. Nothing supplied is written to the store, recorded as accessed, focused in working memory or used to seed the memory graph's walk.
- **Hybrid only.** Under `'dense'` there is no pool: supplied candidates are not read, and are counted as `ineligible` with the same line. `agent()` and `gmi()` pass none: a host that builds its own manager passes them to `assembleForPrompt()`.

**When something is missing.** The turn goes on with what can run. The capture names each leg that did not run with its reason, and the process writes one `memory.recall.leg_absent` line per leg and reason. A reranker that does not answer leaves the recall in its own order, and the capture's `reranker` gives the reason.

| Missing | What runs | The capture | Log line |
|---|---|---|---|
| No `memory.store` (no Brain) | Meaning, exact words in process, recency | `lexicalBackend: 'in_process'` | none |
| An embedder that gives the query no vector, or throws | Exact words and recency | `dense`: `no_embedder` | `memory.recall.leg_absent` |
| A Brain with no full-text index | Meaning and recency | `exact_words`: `no_index`, `lexicalBackend: 'none'` | `memory.recall.leg_absent` |
| A leg whose query throws | The other legs | that leg: `query_error` | `memory.recall.leg_absent` |
| A recall with no `scopes` | Meaning | `exact_words` and `recency`: `no_scopes`, `lexicalBackend: 'none'` | `memory.recall.leg_absent`, one for each leg |
| Every leg | The other sections; no recall section | every leg absent, no candidates | `memory.recall.leg_absent`, one for each leg and reason |
| The local rerank model, while it loads | The recall, in its own order | `reranker`: `loading` | `memory.recall.rerank_skipped` |
| The local rerank model, after a failed load or with Transformers.js not installed | The recall, in its own order; the load is not tried again | `reranker`: `unavailable` | `memory.recall.rerank_unavailable` (`load_failed` or `missing_dependency`), once per process for each |
| A rerank's answer within `timeoutMs` | The recall, in its own order | `reranker`: `timeout` | `memory.recall.rerank_skipped` |
| A usable answer from the reranker: it threw, left out a candidate it was sent, or put a score in for one it could not compute | The recall, in its own order | `reranker`: `error` | `memory.recall.rerank_skipped`; `memory.recall.rerank_failed_scoring` with the count for a substituted score |
| A reranker after three failures or timeouts in a row | The recall, in its own order, for 60 seconds | `reranker`: `backoff` | `memory.recall.rerank_skipped`, once when the back-off begins |

The leg rows are `'hybrid'`'s. Under `'dense'` the dense leg is the only one: a query the embedder gives no vector recalls no memory, with the same `no_embedder` reason and line, and an embedding call that throws fails the turn's memory assembly, which the GMI records in its reasoning trace ("Cognitive memory assembly failed.") before it sends the turn with no block. The rerank rows hold under both ([Memory rerank](../text/RERANKING.md#memory-rerank) has each reason in full). No line carries a memory's text, the turn's text or an id.

The dense leg reads a scope whose vector query throws as a scope with no memories, under `'hybrid'` as under `'dense'`: the store's query cannot tell that failure from a scope that has no collection yet, so the leg runs with that scope's candidates missing and reports no reason.

**No new call.** Hybrid embeds the query once, as dense does, and calls no vendor: the exact-words and recency legs read the store and the process.

**Not `HybridRetriever`.** [`HybridRetriever`](../architecture/hybrid-retriever.md) is a separate class a caller builds beside a manager, with a BM25 index of its own and the `rerankerService` it is given. The manager's recall does not use it, and `recall.retrieval` changes nothing in it. [Lexical and Hybrid Search](../text/LEXICAL_AND_HYBRID_SEARCH.md#other-lexical-search-in-the-package) sets the two beside the package's other lexical search.

**Rerank.** `recall.rerank` reranks the recalled memories, under `'dense'` and `'hybrid'` alike. `'none'`, the default, runs no reranker. `{ kind: 'local', model, revision }` scores with a cross-encoder in the process, at a pinned commit of the model's repository (`revision` is a whole commit id in lower case; a branch, a tag or an upper-case id is refused): the memories never leave the process. `{ kind: 'llm', invoke, model }` has the host's own model call judge them, which sends the turn's text and the first 200 characters of each candidate to that model's provider. No remote reranking service is offered for memories, no environment variable turns a rerank on, and a `rerankerService` on the manager's configuration is not read for memory recall ([Memory rerank](../text/RERANKING.md#memory-rerank) holds the settings, the bounds and the notes on memories and remote services).

```typescript
await manager.initialize({
  ...config,
  recall: { rerank: { kind: 'local', model: 'cross-encoder/ms-marco-MiniLM-L6-v2', revision: '233902d25c440f23af6f7d6e94d2946bac0bee0a' } },
});
await manager.recallReady(); // the model has loaded, or was found unavailable
```

The reranker scores the recall's best 20 candidates (`maxCandidates`) against the turn's own text inside `timeoutMs` (1,500 ms for `local`, 10,000 for `llm`), and they are reordered by `0.7 × the score each holds + 0.3 × its rerank score`; the candidates past `maxCandidates` keep their order after them. Under `'dense'` the score is the trace's retrieval score, and the blend replaces it. Under `'hybrid'` it is the fused score as a share of the best fused score among the cut's recalled candidates, at most 1: the cut at `topK` is what is reranked, the fused scores and each line's relevance stay, and a memory question's reserved candidates follow the cut, unscored. A supplied candidate in the cut is scored with the rest; its `score` is on the caller's scale, so it is never read as the best, and one above every fused score counts as the best recalled candidate does. A memory deleted while the reranker runs leaves the recall and its record, as one deleted while the legs ran does. A rerank never fails a turn. Until the local model has loaded (`loading`), after a failed load or with Transformers.js missing (`unavailable`), past the timeout (`timeout`), on a provider's error, an answer that leaves a candidate out or a substituted score (`error`) and for 60 seconds after three failures in a row (`backoff`), the order stands and the capture's `reranker` gives the reason. The model loads when the manager initialises, never inside a turn. An `agent({ runtime: 'gmi' })` or `gmi()` agent builds its manager inside its first session's first turn and has no `recallReady()`, so its first turns can record `loading` ([Memory rerank](../text/RERANKING.md#memory-rerank)). A built manager's rerank changes through `applyRecallConfig({ rerank })`, never by writing its configuration: the provider is built once.

## Recall Budget

A GMI's memory bridge assembles each turn's block within the manager's `recall.budget.totalTokens`: the whole block, the preamble included, in tokens of about four characters. Unset, it is 1,600 (`DEFAULT_RECALL_BUDGET_TOKENS`), the budget the bridge asked for before the setting existed, so a manager that sets none assembles the same block. At 0 the turn sends no block and its capture records every candidate left out with the reason `budget`; the turn goes on.

```typescript
await manager.initialize({ ...config, recall: { budget: { totalTokens: 2400 } } });

// The same setting on an agent's memory:
const assistant = agent({ runtime: 'gmi', provider: 'openai', memory: { embedding: { provider: 'openai' }, recall: { budget: { totalTokens: 2400 } } } });
```

`initialize()` checks the recall settings before it builds anything: a `budget.totalTokens` that is not an integer of at least 0, a `capture` other than `'off'`, `'metadata'` and `'metadata+stream'`, a `retrieval` other than `'dense'` and `'hybrid'`, or a `rerank` that is neither `'none'` nor a `local` or `llm` setting with its fields, is refused with a `RecallOptionError` naming the field (`option`, with `reason: 'invalid_value'`, or `'unsupported_provider'` for a `rerank` of another `kind`), after one `memory.recall.option_rejected` line. A host of `AgentOS.create` sets `recall` on the manager its `gmiManagerConfig.cognitiveMemoryFactory` builds; `agent()` and `gmi()` set it from `memory.recall` ([GMIs from agent()](../GMI.md#gmis-from-agent)). The bridge reads it at each turn, so a change to a built manager's configuration applies from its next turn. A direct `assembleForPrompt()` call passes a budget of its own, and `AgentMemory.getContext()` passes its caller's `tokenBudget`, 2,000 by default.

### Budget and the prompt share

PromptEngine gives retrieved context 20% of a model's context (`PROMPT_CONTEXT_SHARE`; the context is the model's `optimalContextTokens`, else its `maxContextTokens`). The memory block shares that room with the turn's other retrieved context, the RAG text and the long-term-memory text, which the share holds first. For each model hop of a turn, the GMI works out the block's budget with `effectiveRecallBudget`:

```
effective = max(0, min(budget.totalTokens, floor(0.20 × context) − other context))
```

An 8,000-token model has a share of 1,600 tokens. A turn with 1,400 tokens of long-term-memory text leaves 200 for memory, so the block, assembled at 1,600, is rendered again at 200: the same candidates and sections through the assembler alone (`reassembleForBudget`), with no retrieval, embedding or rerank call, and the memories that do not fit drop whole. The other context is sized with the assembler's estimate of about four characters a token. PromptEngine counts with its own estimate, 3.8 characters a token for a model id containing `gpt-4` and 4.2 for one containing `claude`, so on a `gpt-4` model a block and other context that the clamp fit into the share can be over it by PromptEngine's count: the difference comes from the other context, never the block, and the record's `delivery.otherContext.cutBy` names the cut.

- A hop whose share holds the block gets the turn's first rendering unchanged.
- Each fallback hop is sized for its own model, always from the turn's first rendering and its one recall: a turn whose primary fails before any output and whose fallback has a smaller context sends the fallback a smaller block, and a fallback with a larger context gets the first rendering whole.
- A remainder of 0 sends the hop no block; the record lists every candidate left out for the budget.
- A manager without `reassembleForBudget` is asked through `assembleForPrompt()` again, at the lower budget, with the turn's query and scopes. A re-render that fails, a rejected `reassembleForBudget` included, sends the hop no block and starts no second recall, and the turn goes on: the record's `budget` has `renderFailed: true` and no `reassembled`, and each memory the first rendering showed is left out with the reason `render_failed`.
- A context size or count that is not a finite number in range skips the clamp, and the block is sent as assembled.

PromptEngine counts the block into the prompt and never reduces it. When a prompt is over its budget, or the block and the other context are over the share, only the other context is summarised or truncated, to what the share leaves beside the block less the prompt's overrun, and a target of 0 removes it.

Each clamp writes one `memory.recall.budget_clamped` line (`requested`, `effective`, `hop`, `reason`: `prompt_share`, `zero_remaining`, or `invalid` for a skipped clamp), and a remainder of 0 also one `memory.recall.allocation_exhausted` line (`requested`, `candidates`). The turn's recall record names the clamp ([Recall Capture](#recall-capture)).

## Recall Capture

Every `assembleForPrompt()` returns, beside the block, a record of what the assembly recalled and what became of each candidate: `context.capture`, a [`MemoryRecallCapture`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/recall/capture.ts) of version `memory-recall-capture/1`.

```typescript
const context = await manager.assembleForPrompt('which locker holds the stove?', 1600, mood, { scopes });

context.capture;
// {
//   version: 'memory-recall-capture/1',
//   retrieval: 'dense',
//   budget: { requested: 1600, effective: 1600 },
//   tokensUsed: 412,
//   allocation: { workingMemory: 0.15, semanticRecall: 0.4, ... },
//   legs: [{ leg: 'dense', ran: true, candidates: 6, ineligible: 0, ms: 3 }],
//   lexicalBackend: 'none',
//   reranker: { provider: 'none', reason: 'none_configured' },
//   memoryQuestionReserve: { fired: false, added: 0 },
//   candidates: [
//     { id: 'mt_7', ranks: { dense: 1 }, fusedScore: 0.71, outcome: 'included', tokens: 38, section: 'semanticRecall' },
//     { id: 'mt_2', ranks: { dense: 2 }, fusedScore: 0.64, outcome: 'left_out', reason: 'section_full', tokens: 126, section: 'semanticRecall' },
//     ...
//   ],
//   timings: { legsMs: 4, fuseMs: 0, dedupeMs: 0, rerankMs: 0, assembleMs: 1, totalMs: 5 },
// }
```

Each candidate is a memory the recall returned, in the order it ranked them. Under `dense` that is the recalled list, after a rerank when one answered; under `hybrid` it is the whole pool in fused order, the candidates past the cut at `topK` and the ones the dedupe dropped included, and when a rerank answered the cut's candidates stand in the order it gave them, in the places the cut holds in that list:

| Field | Value |
|-------|-------|
| `id` | The trace's id |
| `ranks` | Its 1-based rank in each leg that returned it. Under `dense`, `{ dense: n }`, the rank the vector recall's cognitive scores gave it, before any rerank; under `hybrid`, a rank for each of `dense`, `exact_words` and `recency` that returned it, or `supplied` for a caller's candidate. |
| `fusedScore` | The score the candidates were ordered by. Under `dense`, the trace's retrieval score, after the blend with its rerank score when a rerank scored it; under `hybrid`, its reciprocal-rank-fusion score ([Recall](#recall)), at most 0.7 / 61 + 0.3 / 61 = 0.0164 at the starting constants, and not a retrieval score: a kept candidate that took the place of a near-duplicate with a better score carries that score, and a supplied candidate its own `score` (or the pool's lowest) |
| `rerankScore` | The score the reranker gave it before the blend; set only for a candidate a rerank scored |
| `outcome` | `included` when the block shows it, `left_out` otherwise |
| `reason` | Set only for a candidate left out: `section_full` when its line did not fit whole in what its section was offered, `budget` when its section was offered no tokens (or no section had a line for it; under `hybrid`, a candidate past the cut at `topK`), `dedupe` under `hybrid` when another candidate holds the same memory, `render_failed` on a GMI hop sent no block because rendering it again for the hop failed |
| `reserve` | `true` on a candidate a memory question reserved room for, past the cut ([Recall](#recall), Memory questions) |
| `duplicateOf` | Under `hybrid`, for a candidate the dedupe dropped: the id of the candidate that holds the same memory. Set with `reason: 'dedupe'`, or with `outcome: 'included'` on one the block shows only through its graph association ([Recall](#recall)) |
| `tokens` | Tokens of its line, about 4 characters a token: as rendered when included, as it would render whole when left out |
| `section` | The section of the block its line belongs to, as in [`lineOutcomes`](#overflow-whole-memories-only): `recall` for the one Relevant Memories section under `hybrid` |

The included candidates are every memory the block shows. A memory the block shows that the recall did not return (a trace reached only through its graph association) comes after the ranked ones, with empty `ranks` and a `fusedScore` of 0.

The rest of the record:

| Field | Value |
|-------|-------|
| `retrieval` | `dense` (the default) or `hybrid`, as the manager's `recall.retrieval` sets ([Recall](#recall)) |
| `budget` | `requested` and `effective`: the token budget the block was asked for and assembled in. A GMI turn's record adds the serving hop's sizing ([Budget and the prompt share](#budget-and-the-prompt-share)): `hop` (0 for the route's primary), `promptShareTokens` and `otherContextTokens` (the model's share and the other context it holds first), `clampReason` (`prompt_share`, or `zero_remaining` when nothing was left) when `effective` is below `requested`, `reassembled: true` when the block was rendered again at `effective`, and `renderFailed: true` when rendering it again failed and the hop was sent no block |
| `delivery` | A GMI turn's record only: what reached the model. `memoryBlockTokens` (PromptEngine's count of the block, which it never reduces); `otherContext`, when the turn had RAG or long-term-memory text, with `ragTokens` and `longTermMemoryTokens` (the assembler's estimate), `deliveredTokens` (PromptEngine's count of what it sent) and `cutBy` (`prompt_engine_truncate` or `prompt_engine_summarize`) when PromptEngine reduced it; `issueCodes`, PromptEngine's `RAG_SUMMARIZATION_FAILED` or `TOKEN_BUDGET_EXCEEDED_POST_OPT`; `promptReplacedByHook: true` when the host's `beforeModelCall` replaced the hop's prompt, so the counts are of the prompt PromptEngine built |
| `tokensUsed`, `allocation` | As on the assembled context |
| `legs` | Each recall leg: whether it ran, why not (`reason`), how many candidates it returned, how many the eligibility checks dropped (`ineligible`, a count with no id) and how long it took. The vector recall is one leg, `dense`; its time covers the query's embedding, the vector search, the scoring and the memory graph's activation, not the rerank, and its `ineligible` counts the traces the `usableFor` trust-policy check dropped. When the embedding manager gives the query no vector, the dense leg is `{ ran: false, reason: 'no_embedder' }` with no candidates, and the process writes one `memory.recall.leg_absent` line for it. Under `hybrid` the exact-words and recency legs follow, and a call that passed `supplied` adds a `supplied` entry: the candidates it added to the pool, and in `ineligible` the ones it refused as ineligible |
| `lexicalBackend` | The full-text backend the exact-words leg read: `fts5` or `fts4` (SQLite), `postgres_tsvector`, `in_process` (a store with no Brain), or `none` when the leg did not run and under `dense`, which reads none |
| `reranker` | The reranker that scored the candidates: `{ provider: 'none', reason: 'none_configured' }` with no `recall.rerank`; with one, `local` (the cross-encoder, with its `model` and `revision`) or `llm` (the LLM judge over the host's model call, with its `model`), the `candidates` it was sent (the recall's best, at most `maxCandidates`, 20) and its `ms`; or `{ provider: 'none', reason }` when it did not answer and the order stood: `loading`, `unavailable`, `timeout`, `error` or `backoff` ([Recall](#recall), Rerank) |
| `memoryQuestionReserve` | `{ fired, added }`: whether the turn was a memory question, and how many reserved candidates the block shows ([Recall](#recall), Memory questions). Always `{ fired: false, added: 0 }` under `dense` |
| `suppliedRejected` | Set when the call refused a supplied candidate: `{ outOfScope, ineligible }`, counts with no id ([Recall](#recall), Supplied candidates) |
| `timings` | Milliseconds of each stage, rounded: `legsMs` (recall, the persistent-memory read and the prospective check, which run together), `fuseMs` and `dedupeMs` (under `hybrid`; 0 under `dense`), `rerankMs` (the rerank, whether it answered or not), `assembleMs` (the graph walk and the assembler), `totalMs` |

`embedder` is the manager's `recall.embedder`, a label of the embedding provider and model the memory was built with: `agent()` and `gmi()` set it to the ones their memory resolved, and it is unset on a manager that names none.

**Which stage a record shows.** `assembleForPrompt()` returns the assembly's record. A GMI turn's record (`GMIOutput.memoryRecall`, a session's `memoryRecall`, a runtime stream's `FINAL_RESPONSE.memoryRecall`) is the record of the hop that served the turn: the same candidates, with that hop's `budget` and its `delivery`, and, when the block was rendered again for the hop, that rendering's outcomes and `tokensUsed`. The stream's `MEMORY_SOURCES_AVAILABLE` chunk, and the `memorySources` update it becomes, carry the assembly's record, sent before the model call, so they hold neither `hop` nor `delivery`. A hop whose share held the block was sent the first rendering: its record has no `reassembled`, even when an earlier hop of the turn was sent a re-render.

**What it holds.** Ids, ranks, scores, counts and timings, never a memory's text or the query's.

**Who may read a capture.** Ids and scores can concern memories of other scopes the turn reads (an organization's, a persona's), so the host decides who sees a capture, under its logging allow-list: a capture handed to the user a turn served can name memories that user's own scope does not hold. Whether ids and scores alone expose anything across those scopes is not established; evidence that they do turns the default to `'off'`.

**Where it goes.** The manager's `recall.capture` decides; on `agent()` and `gmi()` it is `memory.recall.capture`:

| `recall.capture` | `AssembledMemoryContext.capture` | GMI turn: `GMIOutput.memoryRecall`, a session's `send()` result `memoryRecall`, its `stream()` result's `memoryRecall` promise | Runtime stream: `METADATA_UPDATE` with `memorySources`, `FINAL_RESPONSE.memoryRecall` |
|---|---|---|---|
| `'metadata'` (default) | Set | Set | Not sent |
| `'metadata+stream'` | Set | Set | Sent, the update before the reply's text; a turn that stops for the host's tool calls ends, after the host's results, with a `FINAL_RESPONSE` that carries the capture the turn announced. The runtime stream is the one `AgentOS.create()`'s `processRequest()` returns: a session of `agent({ runtime: 'gmi' })` or `gmi()` records under `'metadata+stream'` what it records under `'metadata'`, and its `stream()` parts carry no memory part |
| `'off'` | Unset | Unset | Not sent |

```typescript
await manager.initialize({ ...config, recall: { capture: 'metadata+stream' } });

// The same setting on an agent's memory:
const assistant = agent({ runtime: 'gmi', provider: 'openai', memory: { embedding: { provider: 'openai' }, recall: { capture: 'off' } } });
```

The setting is read at each `assembleForPrompt()` and `retrieve()`, so a change to a built manager's configuration applies from its next turn. The block is the same byte for byte whatever it says. Under `'off'` the manager builds no part of the record: a `retrieve()` result carries neither `diagnostics.recall` (the dense ranks, the reranker's scores, the dense leg's time, the `legs` the capture reports) nor `diagnostics.reranker`, and the assembly takes no timings. A configured reranker still orders the traces.

**The reasoning trace.** With a memory block assembled, the GMI's reasoning trace gets the entry "Cognitive memory context assembled." with `tokensUsed`, `candidates`, `included`, `leftOut`, `retrieval`, `reranker` (the provider) and `legsAbsent` (each leg that did not run, with its reason). `recall: { traceIds: true }` adds `includedMemoryIds`. With the capture `'off'` the counts come from the block's `lineOutcomes`, so `leftOut` still counts the memories the block left out, and `retrieval` from the manager's `recall.retrieval`. The entry never holds text.

---

## Infinite Context Window

With `infiniteContext.enabled` and a `maxContextTokens`, the manager keeps the conversation inside the model's window: `trackMessage()` records each message, and `compactIfNeeded(systemPromptTokens, memoryBudgetTokens)`, called before the prompt is assembled, summarizes the oldest messages once the system prompt, the memory budget and the conversation reach `compactionThreshold` of the window (0.75 by default). It returns the messages to send: one summary message in place of the summarized ones, then the rest as they were.

```typescript
await memory.initialize({
  ...deps,
  maxContextTokens: 128_000,
  infiniteContext: { enabled: true, strategy: 'sliding', preserveRecentTurns: 20 },
});

memory.trackMessage('user', text);
const messages = await memory.compactIfNeeded(systemPromptTokens, memoryBudgetTokens);
const history = memory.getSummaryContext(); // the summaries, oldest first
```

- **Turns.** Each user message opens the next turn, and the replies and tool messages after it share its number; messages before the first user message are turn 0.
- **What is kept.** The newest `preserveRecentTurns` turns (two messages a turn) stay as they are while older messages remain to summarize. A shorter conversation over the threshold gives up its two oldest messages. The newest message, the one the next call answers, is never summarized: when it is all that is left, nothing is compacted and no compaction is logged.
- **Strategies.** `sliding` (the default) writes one summary of the oldest messages. `hierarchical` keeps a summary per segment and, with a summarizer, merges six of them into a level-1 summary and four level-1 summaries into a level-2 one; its summary message holds the newest summary whole and the older ones, cut from their end, only as far as the window's room under the compaction threshold allows, so without a summarizer, which merges nothing, they do not pile up in the window (the summary chain keeps them all). `hybrid` also runs the observer, when one is configured, over the segment and the reflector over its notes, and hands the resulting traces to `encode()`; their ids go into the compaction's log entry.
- **Summarizer.** `infiniteContext.llmInvoker` takes a prompt and answers the summary; without it the manager uses the reflector's, the observer's or the feature-detection invoker, with the system prompt `You are a conversation summarizer.` With none of them, or when a call fails or answers nothing, compaction writes an extractive summary from the conversation itself: the segment's first and last user messages (`sliding`), its user messages cut to 80 characters (`hierarchical`), or the ten most important observation notes, else its first three user messages (`hybrid`). In `sliding` and `hybrid` the summary an earlier compaction left in the segment comes first, carried forward, so the window keeps the condensed history from the start. The strategy's own extract is cut to the tokens the segment held less the summary message's header (25 at the least), and the earlier summary is cut from its end to what is left of the window's room under the compaction threshold once the system prompt, the memory budget, the kept turns, the header and that extract are counted; each cut falls at a space when one lies in the second half of the length. So the summary takes no more of the window than the turns it replaces, and carried history never grows the window past the threshold. The manager logs one line when it runs without a summarizer.
- **Transparency.** `getCompactionHistory()`, `searchCompactionHistory(keyword)`, `getContextWindowStats()` and `getContextTransparencyReport()` read the compaction log; `transparencyLevel` `'full'` keeps each entry's dropped fragments and observation notes, `'summary'` (the default) drops them, and `'silent'` keeps no entries. The summaries form a chain (`RollingSummaryChain`) that merges its oldest summaries once it passes `maxSummaryChainTokens` (2,000 by default), with the summarizer or, without one, by joining and cutting them.

Source: [`pipeline/context/`](https://github.com/framerslab/agentos/tree/master/src/cognition/memory/pipeline/context).

---

## Configuration

### CognitiveMemoryConfig (Top-Level)

```typescript
interface CognitiveMemoryConfig {
  // --- Required dependencies ---
  workingMemory: IWorkingMemory;      // Existing AgentOS working memory
  knowledgeGraph: IKnowledgeGraph;    // Existing AgentOS knowledge graph
  vectorStore: IVectorStore;          // Vector store for embeddings
  embeddingManager: IEmbeddingManager; // Embedding generation

  // --- Agent identity ---
  agentId: string;
  traits: HexacoTraits;              // { honesty, emotionality, extraversion, agreeableness, conscientiousness, openness }
  moodProvider: () => PADState;      // Callback to get current mood

  // --- Feature detection ---
  featureDetectionStrategy: 'keyword' | 'llm' | 'hybrid';
  featureDetectionLlmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;

  // --- Tuning ---
  encoding?: Partial<EncodingConfig>;        // See defaults below
  decay?: Partial<DecayConfig>;              // See defaults below
  workingMemoryCapacity?: number;            // Default: 7 (Miller's number)
  tokenBudget?: Partial<MemoryBudgetAllocation>;
  collectionPrefix?: string;                 // Default: 'cogmem'

  // --- Batch 2 (optional, no-op when absent) ---
  observer?: Partial<ObserverConfig>;
  reflector?: Partial<ReflectorConfig>;
  graph?: Partial<MemoryGraphConfig>;
  consolidation?: Partial<ConsolidationConfig>;

  // --- Further options ---
  persistentMemory?: PersistentMemorySource;   // the persistent markdown working memory
  cognitiveMechanisms?: CognitiveMechanismsConfig;
  infiniteContext?: Partial<InfiniteContextConfig>;
  maxContextTokens?: number;                   // required for infiniteContext
  enableGraphActivation?: boolean;
  brain?: Brain;
  persistAccessState?: boolean;                // Default: true (see Access state across restarts)
  recall?: ManagerRecallConfig;               // See Recall Budget and Recall Capture
}

interface ManagerRecallConfig {
  budget?: { totalTokens?: number };           // Default: 1600, the whole block (see Recall Budget)
  capture?: 'metadata' | 'metadata+stream' | 'off'; // Default: 'metadata' (see Recall Capture)
  retrieval?: 'dense' | 'hybrid';              // Default: 'dense' (see Recall)
  rerank?:                                     // Default: 'none' (see Recall, Rerank)
    | 'none'
    | { kind: 'local'; model: string; revision: string; timeoutMs?: number; maxCandidates?: number }
    | { kind: 'llm'; invoke: (system: string, user: string, model?: string) => Promise<string>; model: string; timeoutMs?: number; maxCandidates?: number };
  traceIds?: boolean;                          // Default: false
  embedder?: { provider: string; model: string }; // A label for the capture record
  constants?: Partial<RecallConstants>;        // The hybrid recall's constants (see Recall)
  memoryQuestion?: (turnText: string) => boolean; // Replaces the memory-question rule (see Recall)
}
```

### Encoding Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `baseStrength` | 0.5 | Base encoding strength before modulation |
| `flashbulbThreshold` | 0.8 | Emotional intensity threshold for flashbulb |
| `flashbulbStrengthMultiplier` | 2.0 | Strength boost for flashbulb memories |
| `flashbulbStabilityMultiplier` | 5.0 | Stability boost for flashbulb memories |
| `baseStabilityMs` | 3,600,000 | Base stability (1 hour) |

### Decay Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pruningThreshold` | 0.05 | Strength below which traces are pruned |
| `recencyHalfLifeMs` | 86,400,000 | Recency boost half-life (24 hours) |
| `interferenceThreshold` | 0.7 | Cosine similarity threshold for interference |

### Graph Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `backend` | `'knowledge-graph'` | Graph backend selection |
| `maxDepth` | 3 | Spreading activation max hops |
| `decayPerHop` | 0.5 | Activation decay per hop |
| `activationThreshold` | 0.1 | Minimum activation to continue |
| `hebbianLearningRate` | 0.1 | Co-activation edge strengthening rate |

### Consolidation Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `intervalMs` | 3,600,000 | Run interval (1 hour) |
| `maxTracesPerCycle` | 500 | Max traces per cycle |
| `mergeSimilarityThreshold` | 0.92 | Similarity threshold for merging |
| `minClusterSize` | 5 | Min cluster size for schema integration |

---

## Quick Start

Minimal setup with core features (no LLM calls, no Batch 2):

```typescript
import { CognitiveMemoryManager } from '@framers/agentos/memory';

const memory = new CognitiveMemoryManager();

await memory.initialize({
  workingMemory: existingWorkingMemory,
  knowledgeGraph: existingKnowledgeGraph,
  vectorStore: existingVectorStore,
  embeddingManager: existingEmbeddingManager,
  agentId: 'my-agent',
  traits: { openness: 0.7, conscientiousness: 0.8, emotionality: 0.5 },
  moodProvider: () => ({ valence: 0, arousal: 0.3, dominance: 0 }),
  featureDetectionStrategy: 'keyword',
});

// Encode a user message
const mood = { valence: 0.2, arousal: 0.4, dominance: 0 };
const trace = await memory.encode(
  'I prefer deploying with Docker Compose',
  mood,
  'content',
  { type: 'semantic', scope: 'user', tags: ['deployment', 'docker'] },
);

// Retrieve relevant memories before prompt construction
const result = await memory.retrieve('How should I deploy?', mood, { topK: 5 });

// Assemble for prompt injection (1000 token budget)
const context = await memory.assembleForPrompt('How should I deploy?', 1000, mood);
console.log(context.contextText);    // Formatted memory context
console.log(context.tokensUsed);     // Actual tokens used
```

Full setup with all Batch 2 features:

```typescript
const llmInvoker = async (system: string, user: string) => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return response.choices[0].message.content ?? '';
};

await memory.initialize({
  // ... core config as above ...
  observer: { activationThresholdTokens: 30_000, llmInvoker },
  reflector: { activationThresholdTokens: 40_000, llmInvoker },
  graph: { backend: 'knowledge-graph', maxDepth: 3, decayPerHop: 0.5 },
  consolidation: { intervalMs: 3_600_000, minClusterSize: 5 },
});

// Observer: feed each message
await memory.observe('user', 'I need to deploy by Friday', mood);
await memory.observe('assistant', 'I can help with that deployment.', mood);

// Prospective: register a reminder
const pm = memory.getProspective()!; // built by initialize()
await pm.register({
  content: 'User needs deployment done by Friday',
  triggerType: 'time_based',
  triggerAt: fridayTimestamp,
  importance: 0.9,
  recurring: false,
});

// Consolidation runs automatically on timer, or manually:
const consolidation = await memory.runConsolidation();
console.log(`Pruned ${consolidation.prunedCount}, created ${consolidation.schemasCreated} schemas`);
```

---

## Integration with GMI

A GMI with cognitive memory calls the manager through [`CognitiveMemoryBridge`](https://github.com/framerslab/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts) at two points of its turn. The calls below are the bridge's, in outline; `mood` is the GMI's PAD state and `gmiMood` its mood label.

### Before Prompt Construction (Retrieve + Assemble)

```typescript
// Before the turn's first model call, with the user's message as the query:
const memoryContext = await cognitiveMemory.assembleForPrompt(
  userMessage,
  cognitiveMemory.getConfig().recall?.budget?.totalTokens ?? 1600, // token budget: the configured budget, 1,600 by default
  mood,
  { scopes }, // the scopes of the turn's user, session, conversation, persona and organization
);
// memoryContext.contextText joins the prompt's retrieved context
```

### After the Turn (Observe + Encode)

```typescript
// After the turn, for the user's message:
await cognitiveMemory.observe('user', userMessage, mood);
await cognitiveMemory.encode(userMessage, mood, gmiMood, {
  type: 'episodic',
  scope: 'user',
  scopeId: userId,
  sourceType: 'user_statement',
});

// Then for the reply:
await cognitiveMemory.observe('assistant', assistantResponse, mood);
await cognitiveMemory.encode(assistantResponse, mood, gmiMood, {
  type: 'semantic',
  scope: 'user',
  scopeId: sessionId,
  sourceType: 'agent_inference',
});
```

With a learning layer the GMI reads and files under the scope ids its learner session gives the turn: the user's message and the reply both go under the turn's own user scope id (the learner's, or the session's form on a turn with no learner), each encode runs inside the user's write chain with the tombstone read before it and once it has committed, and the recall lists only the turn's own scopes ([Where a turn's memory is filed and read](../GMI.md#where-a-turns-memory-is-filed-and-read)).

---

## What the layer adds to a vector store

| # | Plain vector memory | Cognitive memory |
|---|-------------------|-------------------|
| 1 | Every memory equally strong | Encoding strength from HEXACO traits, arousal (Yerkes-Dodson) and mood |
| 2 | No forgetting | Ebbinghaus decay with per-trace stability |
| 3 | No spaced repetition | Retrieval grows stability (desirable difficulty) and doubles the review interval |
| 4 | No working memory limit | Slot-based working memory, 5 to 9 slots by traits |
| 5 | No emotional context | PAD snapshot at encoding, mood-congruent retrieval bias |
| 6 | One retrieval signal (similarity) | Six-signal score (strength, similarity, recency, emotion, graph, importance) |
| 7 | No memory graph | `IMemoryGraph` with 8 edge types and spreading activation |
| 8 | No consolidation | Five steps: decay sweep, replay, schema integration, conflict resolution, reinforcement |
| 9 | No prospective memory | Time, event and context triggers, one-shot or recurring |
| 10 | No observer or reflector | Personality-biased observation notes, reflected into traces by an LLM |
| 11 | No provenance | Source type, confidence, verification count and contradictions on each trace |

---

## Source Files

All source lives in `src/cognition/memory/`:

| File | Export |
|------|--------|
| `core/types.ts` | [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts), [`MemoryType`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts), [`MemoryScope`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts), [`ScoredMemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts) and the other shared types |
| `core/config.ts` | [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts), [`EncodingConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts), [`DecayConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts), defaults |
| `CognitiveMemoryManager.ts` | [`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts), [`ICognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) |
| `core/encoding/EncodingModel.ts` | [`computeEncodingStrength`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts), [`yerksDodson`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts), [`buildEmotionalContext`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts) |
| `core/encoding/ContentFeatureDetector.ts` | [`createFeatureDetector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/ContentFeatureDetector.ts), [`IContentFeatureDetector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/ContentFeatureDetector.ts) |
| `core/decay/DecayModel.ts` | [`computeCurrentStrength`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts), [`updateOnRetrieval`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts), [`computeInterference`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts) |
| `core/decay/RetrievalPriorityScorer.ts` | [`scoreAndRankTraces`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/RetrievalPriorityScorer.ts), [`detectPartiallyRetrieved`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/RetrievalPriorityScorer.ts) |
| `core/working/CognitiveWorkingMemory.ts` | [`CognitiveWorkingMemory`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/working/CognitiveWorkingMemory.ts) |
| `retrieval/store/MemoryStore.ts` | [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts) |
| `core/prompt/MemoryPromptAssembler.ts` | [`assembleMemoryContext`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryPromptAssembler.ts) |
| `core/prompt/MemoryFormatters.ts` | [`formatMemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryFormatters.ts), [`FormattingStyle`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryFormatters.ts) |
| `retrieval/graph/IMemoryGraph.ts` | [`IMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts), [`MemoryEdgeType`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts), [`ActivatedNode`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts) |
| `retrieval/graph/SpreadingActivation.ts` | `spreadActivation` |
| `retrieval/graph/GraphologyMemoryGraph.ts` | [`GraphologyMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/GraphologyMemoryGraph.ts) |
| `retrieval/graph/KnowledgeGraphMemoryGraph.ts` | [`KnowledgeGraphMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/KnowledgeGraphMemoryGraph.ts) |
| `pipeline/observation/MemoryObserver.ts` | [`MemoryObserver`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts), [`ObservationNote`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) |
| `pipeline/observation/MemoryReflector.ts` | [`MemoryReflector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts), [`MemoryReflectionResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts) |
| `pipeline/observation/ObservationBuffer.ts` | [`ObservationBuffer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/ObservationBuffer.ts) |
| `retrieval/prospective/ProspectiveMemoryManager.ts` | [`ProspectiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts), [`ProspectiveMemoryItem`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts) |
| `pipeline/consolidation/ConsolidationPipeline.ts` | [`ConsolidationPipeline`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/consolidation/ConsolidationPipeline.ts), [`ConsolidationResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/consolidation/ConsolidationPipeline.ts) |

---

## Relationship to Persistent Working Memory

AgentOS provides two complementary working memory systems:

| | Baddeley Cognitive Working Memory | Persistent Markdown Working Memory |
|---|---|---|
| Purpose | In-session attention modeling | Cross-session user context |
| Lifespan | Single session (in-memory) | Persists in a markdown file the host names (Wunderland: `agents/<agent id>/working-memory.md` in its workspace) |
| Updates | Automatic activation decay | Agent calls `update_working_memory` tool |
| Format | Capacity-limited slots (7±2) | Free-form markdown template |
| Budget | 15% of prompt tokens | 5% of prompt tokens |

Both are injected into the system prompt simultaneously. The persistent memory appears as `## Persistent Memory` before the cognitive slots. See [Persistent Working Memory](./WORKING_MEMORY.md) for details.

---

## Mechanism Implementation Reference {#mechanism-implementation-reference}

The eight cognitive mechanisms live under `src/cognition/memory/mechanisms/`. Each mechanism is a pure function with one mutation responsibility on a [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts). The [`CognitiveMechanismsEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/CognitiveMechanismsEngine.ts) binds them to lifecycle hooks on [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts) and `MemoryPromptAssembler`.

### Source-tree layout

```
src/cognition/memory/mechanisms/
├── types.ts                          # CognitiveMechanismsConfig + shared types
├── defaults.ts                       # DEFAULT_MECHANISMS_CONFIG + resolveConfig()
├── CognitiveMechanismsEngine.ts      # Lifecycle hook orchestrator
├── PersonaDriftMechanism.ts          # Trait drift proposals during consolidation
├── retrieval/
│   ├── Reconsolidation.ts            # Emotional drift on access
│   ├── RetrievalInducedForgetting.ts # Competitor suppression
│   ├── InvoluntaryRecall.ts          # Random memory surfacing
│   └── MetacognitiveFOK.ts           # Feeling-of-knowing scoring
├── consolidation/
│   ├── TemporalGist.ts               # Verbatim→gist compression
│   ├── SchemaEncoding.ts             # Schema-congruent detection
│   ├── SourceConfidenceDecay.ts      # Source-type decay multipliers
│   └── EmotionRegulation.ts          # Reappraisal & suppression
└── index.ts                          # Barrel exports
```

### Lifecycle hook points

| File | Method | Hook | When |
|---|---|---|---|
| `store/MemoryStore.ts` | `recordAccess()` | `engine.onAccess(trace, mood)` | After spaced-repetition update |
| `store/MemoryStore.ts` | `query()` | `engine.onRetrieval(scored, candidates, cutoff, entities)` | After scoring, before return |
| `prompt/MemoryPromptAssembler.ts` | `assembleMemoryContext()` | `engine.onPromptAssembly(allTraces, retrievedIds)` | Before final return, when the input carries `mechanismsEngine` and `allTraces`; `assembleForPrompt()` passes neither |
| `CognitiveMemoryManager.ts` | `encode()` | `engine.onEncoding(trace, embedding)` | After the trace is embedded |
| `CognitiveMemoryManager.ts` | `initialize()` | Engine construction | Dynamic import when config present |

`ConsolidationPipeline` calls `engine.onConsolidation()` in each run when the manager was initialized with `cognitiveMechanisms`.

### Per-mechanism API

Retrieval-time (synchronous):

```typescript
applyReconsolidation(trace: MemoryTrace, currentMood: PADState, config): void
applyRetrievalInducedForgetting(retrieved, competitors, config): { suppressedIds: string[] }
selectInvoluntaryMemory(allTraces, alreadyRetrievedIds, config): MemoryTrace | null
detectFeelingOfKnowing(scoredCandidates, retrievalCutoff, config, queryEntities): MetacognitiveSignal[]
```

Consolidation-time (async; LLM gist extraction is opt-in):

```typescript
applyTemporalGist(traces, config, llmFn?): Promise<number>
applySchemaEncoding(trace, traceEmbedding, clusterCentroids, config): SchemaEncodingResult
applySourceConfidenceDecay(traces, config): number
applyEmotionRegulation(traces, config): number
```

### HEXACO modulation

[`CognitiveMechanismsEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/CognitiveMechanismsEngine.ts) accepts optional [`HexacoTraits`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts) at construction. When provided, mechanism parameters are scaled by personality dimensions before any hook fires:

```typescript
this.mechanismsEngine = new CognitiveMechanismsEngine(config.cognitiveMechanisms, config.traits);
```

Modulation runs once via `applyPersonalityModulation()`. Trait-to-parameter scaling formulas live in `CognitiveMechanismsEngine.ts`.

### Guard conditions

- **Flashbulb immunity:** traces with `encodingStrength >= 0.9` are skipped by RIF, temporal gist and emotion regulation. Reconsolidation skips a trace whose `encodingStrength` is at least `immuneAboveImportance`, whose default of 9 no strength (0 to 1) reaches, so by default no trace is immune to it.
- **Dead-trace protection:** RIF skips traces with `encodingStrength < 0.1`.
- **Inactive skip:** all consolidation mechanisms skip `isActive === false` traces.
- **Disabled bypass:** every mechanism returns immediately when `config.enabled === false`.

### Rehydration

`CognitiveMemoryManager.rehydrate(traceId)` returns a trace's archived verbatim content from the manager's `archive`. The manager passes that archive to neither the temporal-gist mechanism nor its consolidation pipeline, so gisting through the manager keeps no archived copy to rehydrate; the temporal-gist mechanism archives first only when its own config carries an archive. The archive is backed by [`IMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/IMemoryArchive.ts) (default [`SqlStorageMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts)), which uses the same [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) contract as [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts). Archive tables (`archived_traces`, `archive_access_log`) live in the same database when the adapter is shared. `MemoryToolsExtension` declares an `includeRehydrate` option and does not read it, so no `rehydrate_memory` tool is registered.

### Perspective encoding

[`PerspectiveObserver`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/PerspectiveObserver.ts)`.rewrite()` rewrites an event witnessed by several agents through each witness's HEXACO personality, mood and relationships, and returns one first-person trace per witness; the host encodes each with `encode(..., { perspectiveSource })`. The observer does not archive the objective event. Perspective-encoded traces have their reconsolidation `driftRate` halved so retrieval-time drift does not compound the encoding-time shift. The `maxDriftPerTrace` cap (0.4) still bounds total drift. Gating: only `important`-tier witnesses with `event.importance >= 0.3` (`importanceThreshold`) and entity overlap receive LLM rewrites; others fall back to objective encoding.

### Metadata storage

Mechanism metadata is stored in `trace.structuredData.mechanismMetadata` (type [`MechanismMetadata`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/types.ts)), avoiding changes to the core `MemoryTrace` interface. The metadata persists in the vector store's metadata JSON column.

### Testing

Each mechanism is a pure function testable in isolation:

```bash
npx vitest run src/cognition/memory/mechanisms/
npx vitest run src/cognition/memory/mechanisms/__tests__/retrieval.test.ts
npx vitest run src/cognition/memory/mechanisms/__tests__/consolidation.test.ts
npx vitest run src/cognition/memory/mechanisms/__tests__/engine.test.ts
npx vitest run src/cognition/memory/mechanisms/__tests__/types.test.ts
```

---

## References

The runtime constants, formulas, weights, and design decisions in this page are grounded in the cognitive-science and information-retrieval literature listed below. Citations are inline throughout the doc; this section consolidates them for review and audit.

### Cognitive science foundations

- Atkinson, R. C., & Shiffrin, R. M. (1968). [*Human memory: A proposed system and its control processes.*](https://en.wikipedia.org/wiki/Atkinson%E2%80%93Shiffrin_memory_model) In K. W. Spence & J. T. Spence (Eds.), *The psychology of learning and motivation* (Vol. 2, pp. 89–195). Academic Press. — Multi-store memory model.
- Baddeley, A. D., & Hitch, G. (1974). [*Working memory.*](https://www.sciencedirect.com/science/article/pii/S0079742108604521) In G. H. Bower (Ed.), *The psychology of learning and motivation* (Vol. 8, pp. 47–89). Academic Press. — Working memory model with slot-based capacity.
- Baddeley, A. D. (2003). [*Working memory: Looking back and looking forward.*](https://doi.org/10.1038/nrn1201) *Nature Reviews Neuroscience*, 4(10), 829–839. — Updated synthesis.
- Tulving, E. (1972). [*Episodic and semantic memory.*](https://psycnet.apa.org/record/1973-08477-001) In E. Tulving & W. Donaldson (Eds.), *Organization of memory* (pp. 381–403). Academic Press. — LTM taxonomy (episodic / semantic / procedural).
- Ebbinghaus, H. (1885). [*Über das Gedächtnis: Untersuchungen zur experimentellen Psychologie*](https://www.gutenberg.org/files/55518/55518-h/55518-h.htm) (English: *Memory: A Contribution to Experimental Psychology*, 1913 trans. Ruger & Bussenius). Duncker & Humblot. — The original forgetting curve `S(t) = S₀ · e^(-Δt / stability)`.
- Yerkes, R. M., & Dodson, J. D. (1908). [*The relation of strength of stimulus to rapidity of habit-formation.*](https://onlinelibrary.wiley.com/doi/abs/10.1002/cne.920180503) *Journal of Comparative Neurology and Psychology*, 18(5), 459–482. — Inverted-U arousal curve.
- Brown, R., & Kulik, J. (1977). [*Flashbulb memories.*](https://psycnet.apa.org/record/1977-29748-001) *Cognition*, 5(1), 73–99. — Flashbulb memory phenomenon.
- Bower, G. H. (1981). [*Mood and memory.*](https://doi.org/10.1037/0003-066X.36.2.129) *American Psychologist*, 36(2), 129–148. — Mood-congruent encoding.
- Anderson, J. R. (1983). [*A spreading activation theory of memory.*](https://psycnet.apa.org/record/1984-00248-001) *Journal of Verbal Learning and Verbal Behavior*, 22(3), 261–295. — ACT-R spreading activation. See also the [ACT-R home page](https://act-r.psy.cmu.edu/).
- Hebb, D. O. (1949). [*The Organization of Behavior: A Neuropsychological Theory.*](https://en.wikipedia.org/wiki/Organization_of_Behavior) Wiley. — "Cells that fire together, wire together."
- Johnson, M. K., Hashtroudi, S., & Lindsay, D. S. (1993). [*Source monitoring.*](https://psycnet.apa.org/record/1993-18254-001) *Psychological Bulletin*, 114(1), 3–28. — Source-monitoring framework underpinning the per-source decay multipliers.

### Personality structure

- Ashton, M. C., & Lee, K. (2007). [*Empirical, theoretical, and practical advantages of the HEXACO model of personality structure.*](https://doi.org/10.1177/1088868306294907) *Personality and Social Psychology Review*, 11(2), 150–166. — HEXACO six-factor model.

### Retrieval-augmented generation

- Gao, L., Ma, X., Lin, J., & Callan, J. (2022). [*Precise zero-shot dense retrieval without relevance labels.*](https://arxiv.org/abs/2212.10496) arXiv:2212.10496. — HyDE retrieval (opt-in; see [HyDE Retrieval](./HYDE_RETRIEVAL.md) for when it helps).
- Lei, F., et al. (2025). [*Never come up empty: Adaptive HyDE retrieval for improving LLM developer support.*](https://arxiv.org/abs/2507.16754) arXiv:2507.16754. — Adaptive HyDE thresholding on a 3M-post Stack Overflow corpus.
- Edge, D., Trinh, H., Cheng, N., Bradley, J., Chao, A., Mody, A., Truitt, S., & Larson, J. (2024). [*From local to global: A graph RAG approach to query-focused summarization.*](https://arxiv.org/abs/2404.16130) arXiv:2404.16130. — Microsoft GraphRAG.

### Cognitive architectures for language agents

- Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P., & Bernstein, M. S. (2023). [*Generative agents: Interactive simulacra of human behavior.*](https://arxiv.org/abs/2304.03442) arXiv:2304.03442. — Smallville generative agents; the canonical "persona + memory + reflection" demo.
- Sumers, T. R., Yao, S., Narasimhan, K., & Griffiths, T. L. (2023). [*Cognitive architectures for language agents.*](https://arxiv.org/abs/2309.02427) arXiv:2309.02427. — CoALA framework that AgentOS's memory taxonomy follows.

### Benchmarks

- Wu, D., Wang, J., Hu, P., et al. (2024). [*LongMemEval: Benchmarking chat assistants on long-term interactive memory.*](https://arxiv.org/abs/2410.10813) ICLR 2025. — The benchmark agentos-bench reports against.

### Implementation references

Source files cited inline:

- [`src/cognition/memory/CognitiveMemoryManager.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) — top-level orchestrator
- [`src/cognition/memory/core/decay/DecayModel.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts) — Ebbinghaus formula + spaced repetition
- [`src/cognition/memory/mechanisms/defaults.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/defaults.ts) — eight cognitive mechanism defaults
- [`src/cognition/memory/retrieval/hyde/MemoryHydeRetriever.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/hyde/MemoryHydeRetriever.ts) — HyDE retriever
- [`src/cognition/memory/retrieval/graph/graphrag/GraphRAGEngine.ts`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/graphrag/GraphRAGEngine.ts) — GraphRAG implementation
