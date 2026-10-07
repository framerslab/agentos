---
description: "Cognitive memory for AI agents: Ebbinghaus decay, HEXACO-modulated encoding, Baddeley working memory, ACT-R spreading activation, 8 neuroscience-grounded mechanisms. 85.6% on LongMemEval-S, 70.2% on LongMemEval-M."
keywords: [cognitive memory ai, llm memory architecture, ebbinghaus decay, hexaco personality, baddeley working memory, longmemeval, agent memory, semantic memory, episodic memory]
---

# Cognitive Memory System

> **Memory benchmarks (full N=500, gpt-4o reader):** **85.6% on LongMemEval-S** at $0.0090 per correct, **+1.4 points above Mastra Observational Memory (84.23%)**. **70.2% on LongMemEval-M** on the 1.5M-token / 500-session haystack variant — the only open-source library on the public record above 65% on M with publicly reproducible methodology. Competitive with the strongest published M results in the LongMemEval paper ([Wu et al., ICLR 2025](https://arxiv.org/abs/2410.10813): round Top-5 65.7%, session Top-5 71.4%, round Top-10 72.0%). [Benchmarks](https://docs.agentos.sh/benchmarks) · [Run JSONs](https://github.com/framerslab/agentos-bench/tree/master/results/runs) · [SOTA writeup](https://agentos.sh/en/blog/agentos-memory-sota-longmemeval/)

:::tip See also
[HEXACO Personality](./HEXACO_PERSONALITY.md) for the trait-by-trait reference covering encoding weights, working-memory capacity, prompt formatting, observer/reflector bias, and runtime self-modification.
:::

![CognitiveMemoryManager architecture: orchestrator dispatches to 8 subsystems, each backed by its substrate](/img/diagrams/cognitive-memory-architecture.svg)

---

## Why memory should forget

A pure vector-similarity memory — embed every message, return the cosine-nearest neighbors at retrieval — works for a few thousand turns. Past that scale, undifferentiated retrieval treats every recorded experience as equally available, equally trustworthy, and equally relevant. The cognitive-science literature treats forgetting as the mechanism by which what mattered yesterday continues to matter today, not as a bug to be patched out. AgentOS encodes that principle directly: traces decay, retrieval bias shifts with mood, and consolidation rewrites the store between turns.

The cognitive memory system in AgentOS is built on that argument. Encoding strength is set per-trace, modulated by the personality traits of the agent doing the encoding and by the emotional intensity of the moment ([Brown & Kulik, 1977](https://psycnet.apa.org/record/1977-29748-001) on flashbulb memories; [Yerkes & Dodson, 1908](https://onlinelibrary.wiley.com/doi/abs/10.1002/cne.920180503) on the inverted-U arousal curve). Strength then decays exponentially with time on Hermann Ebbinghaus's 1885 forgetting curve `S(t) = S₀ · e^(-Δt / stability)`, accelerated by interference from new similar memories and slowed by successful retrieval (the desirable-difficulty effect — harder retrievals grow stability more). Working memory is bounded by [Baddeley's slot model](https://www.sciencedirect.com/science/article/pii/S1364661303002479) of seven-plus-or-minus-two, modulated by traits. Retrieval composites six signals — vector similarity, current strength, recency, emotional congruence with the agent's mood, graph spreading-activation in the [ACT-R](https://act-r.psy.cmu.edu/) tradition (Anderson, 1983), and importance. The graph itself learns: co-retrieval of two traces tightens the edge between them via Hebbian weight updates ("neurons that fire together wire together").

The result is a memory that behaves more like a person remembering. The agent forgets the irrelevant. It holds onto what hit it hard. It pulls the thing that's adjacent in concept-space, not just the thing that's adjacent in vector-space. And — because every mechanism is HEXACO-modulated — the same input encodes differently depending on who is doing the remembering.

:::tip Eight cognitive mechanisms layered on top
On top of the encoding/decay/retrieval substrate, the runtime ships eight optional neuroscience-grounded mechanisms — reconsolidation, retrieval-induced forgetting, involuntary recall, metacognitive feeling-of-knowing, temporal gist, schema encoding, source-confidence decay, and emotion regulation. All HEXACO-personality-modulated and individually configurable via `cognitiveMechanisms` on [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts). See the [Mechanism Implementation Reference](#mechanism-implementation-reference) below for hook points, APIs, and testing.
:::

## What it actually does, in five lines

- **Encoding** is shaped by the agent's HEXACO personality traits and current emotional state (PAD model: valence, arousal, dominance)
- **Forgetting** follows the Ebbinghaus exponential decay curve, with retrieval-induced reinforcement via spaced repetition
- **Retrieval** combines six weighted signals (strength, embedding similarity, recency, emotional congruence, graph activation, importance) into a composite score
- **Working memory** enforces Baddeley's slot-based capacity limits (7±2), modulated by traits
- **Consolidation** runs periodically to prune weak traces, merge clusters into schemas, resolve contradictions, and feed observations back into long-term storage

Core encoding / decay / retrieval runs without any LLM calls. The optional Batch-2 layer (observer, reflector, graph, consolidation) activates when its config is wired in and falls through gracefully when it isn't. Same code runs over local SQLite + HNSW or against Postgres + Neo4j — no callsite changes.

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
User Message arrives
  1. encode()          — Create MemoryTrace from input (personality-modulated strength)
  2. retrieve()        — Query vector store + score with 6-signal composite
  3. assembleForPrompt — Token-budgeted context assembly → inject into system prompt
  4. [LLM generates response]
  5. observe()         — Feed response to observer buffer (Batch 2)
  6. checkProspective  — Check time/event/context triggers (Batch 2)
  7. runConsolidation   — Periodic background sweep (Batch 2, timer-based)
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

Every memory is wrapped in a [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SelfEvaluateTool.ts) — the universal envelope carrying content, provenance, emotional context, and decay parameters:

| Field Group | Key Fields | Purpose |
|-------------|-----------|---------|
| **Identity** | `id`, `type`, `scope`, `scopeId` | Classification and routing |
| **Content** | `content`, `structuredData`, `entities`, `tags` | The actual memory data |
| **Provenance** | `sourceType`, `sourceId`, `confidence`, `verificationCount`, `contradictedBy` | Source monitoring to prevent confabulation |
| **Emotional Context** | `valence`, `arousal`, `dominance`, `intensity`, `gmiMood` | PAD snapshot at encoding time |
| **Decay Parameters** | `encodingStrength` (S0), `stability` (tau), `retrievalCount`, `lastAccessedAt` | Ebbinghaus curve inputs |
| **Spaced Repetition** | `reinforcementInterval`, `nextReinforcementAt` | Interval doubling schedule |
| **Graph** | `associatedTraceIds` | Links to related traces |
| **Lifecycle** | `createdAt`, `updatedAt`, `consolidatedAt`, `isActive` | Timestamps and soft-delete flag |

Source types: `user_statement`, `agent_inference`, `tool_result`, `observation`, `reflection`, `external`.

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

The **composite attention multiplier** starts at 0.5 and adds weighted bonuses for each detected content feature (0.10-0.15 each), plus a base 0.15 for contradictions and topic relevance.

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

| Strategy | Speed | Quality | LLM Calls | Best For |
|----------|-------|---------|-----------|----------|
| `keyword` | Fast | Moderate | 0 | Default; low-latency agents |
| `llm` | Slow | High | 1 per encode | High-fidelity agents with budget |
| `hybrid` | Medium | High | Periodic | Best balance; keyword first, LLM re-classification during consolidation |

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

### Interference

When a new trace overlaps with existing traces (cosine similarity > threshold, default 0.7):

- **Retroactive interference**: New trace weakens old similar traces (strength reduction ~0.15 at similarity 1.0)
- **Proactive interference**: Old traces impair new encoding (capped at 0.3 total reduction)

### Pruning

Traces with `currentStrength < pruningThreshold` (default: 0.05) are soft-deleted during consolidation, **unless** their emotional intensity exceeds 0.3 (emotional memories are protected from pruning).

Lifecycle note: these retention/decay sweeps are now operational on the
built-in vector stores that implement `scanByMetadata()`. Adapters without
metadata-scan support still need provider-specific work before they can
participate fully in lifecycle enforcement.

---

## Retrieval Priority Scoring

Source: `src/cognition/memory/core/decay/RetrievalPriorityScorer.ts`

Retrieval combines six signals into a composite score:

| Signal | Weight | Range | Computation |
|--------|--------|-------|-------------|
| `strength` | 0.25 | 0-1 | `S₀ * e^(-dt / stability)` |
| `similarity` | 0.35 | 0-1 | Cosine similarity from vector search |
| `recency` | 0.10 | 0-1 | `(e^(-elapsed / halfLife)) / 0.2` (normalised) |
| `emotionalCongruence` | 0.15 | 0-1 | `max(0, moodValence * traceValence) / 0.25` (normalised) |
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

1. **Focus**: New trace enters at `initialActivation` (default 0.8). If at capacity, lowest-activation slot is evicted first.
2. **Rehearsal**: `rehearse(slotId)` bumps activation by 0.15 (capped at 1.0).
3. **Decay**: Each turn, all activations decrease by `activationDecayRate` (default 0.1).
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
- **Soft delete**: Sets `isActive = false` without removing from store

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

After retrieval, co-retrieved memories are recorded via `recordCoActivation()`. This strengthens `CO_ACTIVATED` edges between memories that are frequently retrieved together, implementing the Hebbian rule: "neurons that fire together wire together."

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

**Pipeline:**
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

Checked each turn before prompt construction. Triggered items are injected into the "Reminders" section of the assembled memory context. Items can be `recurring` (re-trigger) or one-shot (marked `triggered` after firing).

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

Assembles memory context into a single formatted string within a token budget, split across six sections with overflow redistribution.

### Default Budget Allocation

| Section | Budget % | Content |
|---------|---------|---------|
| Working Memory | 15% | Active context from slot buffer |
| Semantic Recall | 45% | Retrieved semantic/procedural traces |
| Recent Episodic | 25% | Retrieved episodic traces |
| Prospective Alerts | 5% | Triggered reminders (Batch 2) |
| Graph Associations | 5% | Spreading activation context (Batch 2) |
| Observation Notes | 5% | Recent observer notes (Batch 2) |

### Overflow Redistribution

If a section uses less than its budget, the overflow flows to Semantic Recall. If Batch 2 sections are empty (no observer, no graph, no prospective items), their budgets are also redistributed to Semantic Recall.

### Personality -> Formatting Style

The assembler selects a formatting style based on the dominant HEXACO trait:

| Dominant Trait | Style | Output |
|---------------|-------|--------|
| Conscientiousness | `structured` | Bullet points, categories |
| Openness | `narrative` | Flowing prose, connections |
| Emotionality | `emotional` | Emphasis on feelings, tone |

### Output Sections

```
## Active Context
- [ACTIVE] mt_1234 (activation: 0.85)

## Relevant Memories
- [semantic, score=0.82] User prefers TypeScript...

## Recent Experiences
- [episodic, score=0.71] Discussed deployment on Tuesday...

## Reminders
- [time_based] PR review is due

## Related Context
- [associated, activation=0.45] Related discussion about CI/CD...

## Observations
- User tends to ask follow-up questions about error handling
```

Token estimation uses ~4 chars per token heuristic.

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
  featureDetectionStrategy: 'keyword' | 'llm' | 'hybrid'; // Default: 'keyword'
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
const pm = memory.getProspective();
await pm.register({
  content: 'User needs deployment done by Friday',
  triggerType: 'time_based',
  triggerAt: fridayTimestamp,
  importance: 0.9,
  recurring: false,
});

// Consolidation runs automatically on timer, or manually:
const result = await memory.runConsolidation();
console.log(`Pruned ${result.prunedCount}, created ${result.schemasCreated} schemas`);
```

---

## Integration with GMI

The Cognitive Memory System integrates into the GMI turn loop at three points:

### After User Message (Encode)

```typescript
// In the GMI turn handler, after receiving user input:
const mood = moodEngine.getCurrentState();
await cognitiveMemory.encode(userMessage, mood, gmiMood, {
  type: 'episodic',
  scope: 'user',
  scopeId: userId,
  sourceType: 'user_statement',
});
```

### Before Prompt Construction (Retrieve + Assemble)

```typescript
// Before building the system prompt:
const memoryContext = await cognitiveMemory.assembleForPrompt(
  userMessage,
  tokenBudget,
  mood,
);
// Inject memoryContext.contextText into the prompt via PromptBuilder
```

### After Response (Observe)

```typescript
// After the LLM generates a response:
await cognitiveMemory.observe('assistant', assistantResponse, mood);

// Also feed user messages to observer for conversation monitoring:
await cognitiveMemory.observe('user', userMessage, mood);
```

---

## What's missing from flat-vector memory (vs. Mastra)

Twelve specific gaps in Mastra's memory architecture that the cognitive memory layer fills. Each row maps to a paper, a primitive, and runtime code:

| # | Mastra Limitation | AgentOS Improvement |
|---|-------------------|-------------------|
| 1 | Flat strength (all memories equal) | HEXACO-modulated encoding strength with Yerkes-Dodson arousal curve |
| 2 | No forgetting | Ebbinghaus exponential decay with configurable stability |
| 3 | No spaced repetition | Desirable difficulty effect with interval doubling |
| 4 | No working memory limits | Baddeley's model with personality-modulated capacity (5-9 slots) |
| 5 | No emotional context | PAD model snapshot at encoding, mood-congruent retrieval bias |
| 6 | Single retrieval signal (similarity) | 6-signal composite scoring (strength, similarity, recency, emotion, graph, importance) |
| 7 | No memory graph | IMemoryGraph with 8 edge types and spreading activation |
| 8 | No interference modeling | Proactive and retroactive interference with configurable thresholds |
| 9 | No consolidation | 5-step pipeline: decay sweep, replay, schema integration, conflict resolution, reinforcement |
| 10 | No prospective memory | Time, event, and context-based triggers with recurring support |
| 11 | No observer/reflector | Personality-biased observation + LLM-driven consolidation into traces |
| 12 | No provenance tracking | Full source monitoring with confidence, verification count, and contradiction detection |

---

## Source Files

All source lives in `src/cognition/memory/`:

| File | Export |
|------|--------|
| `types.ts` | All types: [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SelfEvaluateTool.ts), [`MemoryType`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts), [`MemoryScope`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts), [`ScoredMemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/types.ts), etc. |
| `config.ts` | [`CognitiveMemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts), [`EncodingConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts), [`DecayConfig`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/config.ts), defaults |
| `CognitiveMemoryManager.ts` | [`CognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts), [`ICognitiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) |
| `encoding/EncodingModel.ts` | [`computeEncodingStrength`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts), [`yerksDodson`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts), [`buildEmotionalContext`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/EncodingModel.ts) |
| `encoding/ContentFeatureDetector.ts` | [`createFeatureDetector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/ContentFeatureDetector.ts), [`IContentFeatureDetector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/encoding/ContentFeatureDetector.ts) |
| `decay/DecayModel.ts` | [`computeCurrentStrength`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts), [`updateOnRetrieval`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts), [`computeInterference`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/DecayModel.ts) |
| `decay/RetrievalPriorityScorer.ts` | [`scoreAndRankTraces`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/RetrievalPriorityScorer.ts), [`detectPartiallyRetrieved`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/decay/RetrievalPriorityScorer.ts) |
| `working/CognitiveWorkingMemory.ts` | [`CognitiveWorkingMemory`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/working/CognitiveWorkingMemory.ts) |
| `store/MemoryStore.ts` | [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts) |
| `prompt/MemoryPromptAssembler.ts` | [`assembleMemoryContext`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryPromptAssembler.ts) |
| `prompt/MemoryFormatters.ts` | [`formatMemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryFormatters.ts), [`FormattingStyle`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/core/prompt/MemoryFormatters.ts) |
| `graph/IMemoryGraph.ts` | [`IMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts), [`MemoryEdgeType`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts), [`ActivatedNode`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/IMemoryGraph.ts) |
| `graph/SpreadingActivation.ts` | `spreadActivation` |
| `graph/GraphologyMemoryGraph.ts` | [`GraphologyMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/GraphologyMemoryGraph.ts) |
| `graph/KnowledgeGraphMemoryGraph.ts` | [`KnowledgeGraphMemoryGraph`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/graph/KnowledgeGraphMemoryGraph.ts) |
| `observation/MemoryObserver.ts` | [`MemoryObserver`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts), [`ObservationNote`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryObserver.ts) |
| `observation/MemoryReflector.ts` | [`MemoryReflector`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts), [`MemoryReflectionResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/MemoryReflector.ts) |
| `observation/ObservationBuffer.ts` | [`ObservationBuffer`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/observation/ObservationBuffer.ts) |
| `prospective/ProspectiveMemoryManager.ts` | [`ProspectiveMemoryManager`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts), [`ProspectiveMemoryItem`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/prospective/ProspectiveMemoryManager.ts) |
| `consolidation/ConsolidationPipeline.ts` | [`ConsolidationPipeline`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/pipeline/consolidation/ConsolidationPipeline.ts), [`ConsolidationResult`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/io/facade/types.ts) |

---

## Relationship to Persistent Working Memory

AgentOS provides two complementary working memory systems:

| | Baddeley Cognitive Working Memory | Persistent Markdown Working Memory |
|---|---|---|
| Purpose | In-session attention modeling | Cross-session user context |
| Lifespan | Single session (in-memory) | Persists on disk (~/.agentos/agents/{id}/working-memory.md) |
| Updates | Automatic activation decay | Agent calls `update_working_memory` tool |
| Format | Capacity-limited slots (7±2) | Free-form markdown template |
| Budget | 15% of prompt tokens | 5% of prompt tokens |

Both are injected into the system prompt simultaneously. The persistent memory appears as `## Persistent Memory` before the cognitive slots. See [Persistent Working Memory](./WORKING_MEMORY.md) for details.

---

## Mechanism Implementation Reference {#mechanism-implementation-reference}

The eight cognitive mechanisms live under `src/cognition/memory/mechanisms/`. Each mechanism is a pure function with one mutation responsibility on a [`MemoryTrace`](https://github.com/framerslab/agentos/blob/master/src/cognition/emergent/SelfEvaluateTool.ts). The [`CognitiveMechanismsEngine`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/mechanisms/CognitiveMechanismsEngine.ts) binds them to lifecycle hooks on [`MemoryStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/MemoryStore.ts) and `MemoryPromptAssembler`.

### Source-tree layout

```
src/cognition/memory/mechanisms/
├── types.ts                          # CognitiveMechanismsConfig + shared types
├── defaults.ts                       # DEFAULT_MECHANISMS_CONFIG + resolveConfig()
├── CognitiveMechanismsEngine.ts      # Lifecycle hook orchestrator
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
| `prompt/MemoryPromptAssembler.ts` | `assembleMemoryContext()` | `engine.onPromptAssembly(allTraces, retrievedIds)` | Before final return |
| `CognitiveMemoryManager.ts` | `initialize()` | Engine construction | Dynamic import when config present |

The consolidation hook (`engine.onConsolidation()`) is wired into `ConsolidationLoop.run()` only when the loop is instantiated with a mechanisms-aware config.

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

- **Flashbulb immunity:** traces with `encodingStrength >= 0.9` are skipped by reconsolidation, RIF, temporal gist, and emotion regulation.
- **Dead-trace protection:** RIF skips traces with `encodingStrength < 0.1`.
- **Inactive skip:** all consolidation mechanisms skip `isActive === false` traces.
- **Disabled bypass:** every mechanism returns immediately when `config.enabled === false`.

### Rehydration

Gisted or archived content can be inflated on demand via `CognitiveMemoryManager.rehydrate(traceId)`. Content does not decay while archived; age-based retention applies. The archive is backed by [`IMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/IMemoryArchive.ts) (default [`SqlStorageMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/SqlStorageMemoryArchive.ts)), which uses the same [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) contract as [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts). Archive tables (`archived_traces`, `archive_access_log`) live in the same database when the adapter is shared. The `rehydrate_memory` LLM tool is opt-in via `MemoryToolsExtension({ includeRehydrate: true })`.

### Perspective encoding

Events witnessed by multiple agents are rewritten through each witness's HEXACO personality, current mood, and relationships before encoding. The objective event is archived via [`IMemoryArchive`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/archive/IMemoryArchive.ts); each witness receives an independent first-person trace. Perspective-encoded traces have their reconsolidation `driftRate` halved so retrieval-time drift does not compound the encoding-time shift. The `maxDriftPerTrace` cap (0.4) still bounds total drift. Gating: only `important`-tier witnesses with `event.importance >= 0.3` and entity overlap receive LLM rewrites; others fall back to objective encoding. Cost: ~$0.025/session on Haiku 4.5 for 5 NPCs.

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
