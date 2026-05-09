# Cognitive Memory — Human-Like Memory for Agents

> Personality-modulated, decay-aware memory grounded in cognitive science: Ebbinghaus forgetting curves, Baddeley's working memory, spreading activation, and HEXACO-driven encoding.

---

## Table of Contents

1. [Overview](#overview)
2. [Memory Types](#memory-types)
3. [Working Memory](#working-memory)
4. [Encoding and Retrieval](#encoding-and-retrieval)
5. [Spreading Activation](#spreading-activation)
6. [Memory Consolidation](#memory-consolidation)
7. [Prospective Memory](#prospective-memory)
8. [Knowledge Graph Integration](#knowledge-graph-integration)
9. [Configuration Reference](#configuration-reference)

---

## Overview

Traditional agent memory is a flat vector store: ingest text, embed it,
retrieve by similarity. The AgentOS Cognitive Memory System replaces this
with a biologically-grounded model where:

- **Encoding strength** varies with the agent's HEXACO personality and current PAD mood
- **Forgetting** follows the Ebbinghaus exponential decay curve
- **Retrieval** scores six signals simultaneously: strength, similarity, recency, emotional congruence, graph activation, and importance
- **Working memory** enforces Baddeley's slot-limited capacity (7 ± 2 items, personality-modulated)
- **Consolidation** runs as a background sweep that prunes weak traces and merges clusters into schemas

### Cognitive Science Foundations

| Model | Application |
|-------|-------------|
| Atkinson-Shiffrin | Sensory → working → long-term memory pipeline |
| Baddeley's working memory | Slot-based capacity with activation levels |
| Tulving's LTM taxonomy | Episodic, semantic, procedural, prospective |
| Ebbinghaus forgetting curve | Exponential strength decay over time |
| Yerkes-Dodson law | Encoding peaks at moderate arousal |
| PAD emotional model | Mood-congruent encoding and retrieval bias |
| Anderson's ACT-R | Spreading activation through memory graph |
| HEXACO personality model | Trait-driven attention weights and capacity |

---

## Memory Types

Based on Tulving's long-term memory taxonomy:

| Type | What it stores | Example |
|------|----------------|---------|
| `episodic` | Autobiographical events — specific interactions | "User asked about deployment on Tuesday" |
| `semantic` | General knowledge — learned facts and preferences | "User prefers TypeScript over Python" |
| `procedural` | Skills and workflows — how-to knowledge | "To deploy, run the deployment pipeline" |
| `prospective` | Future intentions — goals and reminders | "Remind user about the PR review at 3pm" |

### Memory Scopes

| Scope | Visibility | Use Case |
|-------|-----------|---------|
| `thread` | Single conversation | In-conversation working context |
| `user` | All conversations with a user | User preferences and history |
| `persona` | All users of a persona | Persona's accumulated knowledge |
| `organization` | All agents in an org | Shared organizational knowledge |

---

## Working Memory

Working memory is the agent's active mental workspace — a bounded set of
traces currently held in immediate attention.

```typescript
import { CognitiveMemoryManager } from '@framers/agentos/memory';

const memory = new CognitiveMemoryManager({
  workingMemory: {
    capacity: 7,              // slots (Baddeley's 7 ± 2)
    activationDecayRate: 0.1, // per-turn decay of activation
    hexacoOpenness: 0.7,      // high openness → more slots available
  },
});

// The working memory automatically manages activation levels
// Encode a new experience
await memory.encode({
  content: 'User mentioned they prefer short responses',
  type:    'semantic',
  scope:   'user',
  scopeId: 'user-123',
  source:  { type: 'user_statement' },
});

// The lowest-activation trace is evicted to make room
// when capacity is reached — no manual management needed
```

### Inspecting Working Memory

```typescript
const wm = await memory.getWorkingMemory('user-123');

console.log(wm.slots.length);    // number of active items
console.log(wm.utilization);     // 0–1 fill ratio
console.log(wm.slots[0]);
// {
//   traceId: 'trace-abc',
//   content: 'User prefers short responses',
//   activation: 0.92,
//   slot: 0,
// }
```

---

## Encoding and Retrieval

### Encoding

```typescript
const trace = await memory.encode({
  content: 'User mentioned they are building a Discord bot in TypeScript.',
  type:    'episodic',
  scope:   'user',
  scopeId: 'user-456',
  source: {
    type:       'user_statement',
    sourceId:   'turn-001',
    confidence: 0.95,
  },
  // Optional: override emotion at encoding time
  emotionalContext: {
    valence:   0.6,   // positive (user seemed excited)
    arousal:   0.5,
    dominance: 0.0,
    intensity: 0.3,
    gmiMood:   'engaged',
  },
});

console.log(trace.id);
console.log(trace.encodingStrength);  // 0–1, influenced by personality and mood
```

### Retrieval

```typescript
const results = await memory.retrieve({
  query:   'What does the user prefer for language and framework?',
  scopeId: 'user-456',
  filters: {
    types:  ['semantic', 'episodic'],
    scope:  'user',
    minStrength: 0.2,    // filter out nearly-forgotten traces
  },
  maxResults: 10,
});

for (const result of results) {
  console.log(result.content);
  console.log(result.compositeScore);  // weighted sum of 6 signals
  console.log(result.strengthScore);   // Ebbinghaus current strength
  console.log(result.similarityScore); // vector cosine similarity
  console.log(result.recencyScore);    // time since last access
}
```

### Retrieval Scoring

The composite score combines six signals with weights that adapt to the
agent's personality:

```
compositeScore =
  w_strength    * strengthScore     +   // Ebbinghaus current strength
  w_similarity  * similarityScore   +   // vector cosine similarity
  w_recency     * recencyScore      +   // time-decay recency
  w_emotion     * emotionalScore    +   // mood congruence match
  w_activation  * activationScore   +   // graph spreading activation boost
  w_importance  * importanceScore       // manually tagged importance
```

---

## Spreading Activation

Co-retrieved traces strengthen associations between each other, forming a
memory graph where related concepts cluster:

```typescript
// This happens automatically during retrieval — no API needed.
// After retrieval, edges between co-retrieved traces are strengthened.
// On the next retrieval, strongly associated traces surface together.

// You can inspect the graph directly:
const graph = await memory.getMemoryGraph('user-456');
const neighbors = await graph.neighbors('trace-abc');

console.log(neighbors);
// [
//   { traceId: 'trace-def', edgeWeight: 0.82, coRetrievals: 5 },
//   { traceId: 'trace-xyz', edgeWeight: 0.44, coRetrievals: 2 },
// ]
```

**Activation mechanics:**

1. A query activates matching traces (vector search)
2. Activation spreads to their graph neighbors (Hebbian reinforcement)
3. Reranked results include both direct matches and their associates
4. Co-retrieved pairs have their edge weight incremented

---

## Memory Consolidation

Consolidation is a periodic background process (like sleep in humans) that:

- **Prunes** traces whose strength has decayed below `minRetentionStrength`
- **Merges** semantically similar episodic traces into semantic schemas
- **Resolves** contradictions between traces
- **Transfers** high-importance episodic memories to semantic store

Runtime note: lifecycle retention/decay sweeps are operational on the built-in
vector stores that implement `scanByMetadata()` (`InMemory`, `SQL`,
`Postgres`, `Hnswlib`, `Qdrant`, `Neo4j`, and `Pinecone`). Providers without
metadata-scan support still need adapter work for full lifecycle parity.

```typescript
const memory = new CognitiveMemoryManager({
  consolidation: {
    enabled:               true,
    intervalMs:            1000 * 60 * 60,  // every hour
    minRetentionStrength:  0.05,            // prune below this
    mergeSimilarityThreshold: 0.85,         // merge if > 85% similar
    maxTracesPerRun:       500,
  },
});

// Trigger consolidation manually (e.g., at session end):
const report = await memory.consolidate('user-456');
console.log(report.pruned);   // number of traces removed
console.log(report.merged);   // number of clusters merged to schemas
console.log(report.resolved); // number of contradictions resolved
```

### Episodic → Semantic Transfer

After enough episodic encounters, a pattern becomes a semantic fact:

```
[episodic] "User said 'I prefer TypeScript'" (turn 12)
[episodic] "User said 'let's use TypeScript for this'" (turn 47)
[episodic] "User switched a file from JS to TS unprompted" (turn 83)
       ↓ consolidation
[semantic] "User strongly prefers TypeScript" (confidence: 0.91)
```

---

## Prospective Memory

Prospective memory holds future intentions — things the agent should do
at a specific time, after a specific event, or when a certain context arises.

```typescript
import { ProspectiveMemoryManager } from '@framers/agentos/memory/prospective';

const prospective = new ProspectiveMemoryManager({ memoryManager: memory });

// Time-based trigger
await prospective.add({
  scopeId:    'user-789',
  intention:  'Remind user to review the PR that expires today',
  trigger: {
    type:    'time',
    fireAt:  '2026-03-25T15:00:00Z',
  },
});

// Event-based trigger
await prospective.add({
  scopeId:   'user-789',
  intention: 'When user mentions deployment, ask if they want to run tests first',
  trigger: {
    type:     'event',
    eventKey: 'user_mentions_deploy',
  },
});

// Context-based trigger
await prospective.add({
  scopeId:   'user-789',
  intention: 'If user asks about billing, mention the new pricing page',
  trigger: {
    type:         'context',
    contextMatch: 'billing OR pricing OR subscription',
  },
});

// Check triggers before each turn
const fired = await prospective.check({
  scopeId:        'user-789',
  currentContext: 'How do I deploy to production?',
  now:            new Date(),
});

for (const intention of fired) {
  console.log(intention.intention);
  // → "When user mentions deployment, ask if they want to run tests first"
}
```

---

## Knowledge Graph Integration

Memories can be linked to a knowledge graph (Neo4j or in-memory graphology)
for rich relational retrieval beyond vector similarity:

```typescript
const memory = new CognitiveMemoryManager({
  knowledgeGraph: {
    enabled: true,
    adapter: 'neo4j',  // or 'graphology' (in-memory)
    neo4j: {
      uri:      process.env.NEO4J_URI,
      username: process.env.NEO4J_USERNAME,
      password: process.env.NEO4J_PASSWORD,
    },
  },
});

// Traces with named entities are automatically linked in the graph
// Entity extraction runs during encoding:
await memory.encode({
  content:  'Alice works with Bob on the AgentOS project at Frame.dev.',
  type:     'semantic',
  scope:    'organization',
  scopeId:  'org-001',
  entities: ['Alice', 'Bob', 'AgentOS', 'Frame.dev'],  // or extracted automatically
  source:   { type: 'observation' },
});

// Graph-augmented retrieval: surfaces traces connected to "Frame.dev"
const results = await memory.retrieve({
  query:     'Who works on AgentOS?',
  scopeId:   'org-001',
  graphHops: 2,   // traverse up to 2 hops from matched entities
});
```

---

## Configuration Reference

```typescript
import { CognitiveMemoryManager, type CognitiveMemoryConfig } from '@framers/agentos/memory';

const config: CognitiveMemoryConfig = {
  // Ebbinghaus decay model
  decay: {
    enabled:            true,
    baseDecayRateMs:    7 * 24 * 60 * 60 * 1000,   // 7-day half-life
    minStrength:        0.01,                        // floor before pruning
    retrievalBoost:     1.5,                         // stability multiplier on recall
  },

  // Baddeley's working memory
  workingMemory: {
    capacity:           7,
    activationDecayRate: 0.1,
    hexacoOpenness:     0.6,   // 0–1, high = more capacity
  },

  // Retrieval scoring weights (must sum to 1.0)
  retrieval: {
    weights: {
      strength:    0.25,
      similarity:  0.30,
      recency:     0.15,
      emotion:     0.10,
      activation:  0.10,
      importance:  0.10,
    },
    maxResults: 20,
    minStrength: 0.05,
  },

  // Consolidation sweep
  consolidation: {
    enabled:                  true,
    intervalMs:               3_600_000,   // hourly
    minRetentionStrength:     0.05,
    mergeSimilarityThreshold: 0.85,
    maxTracesPerRun:          500,
  },

  // Prospective memory
  prospective: {
    enabled:         true,
    checkIntervalMs: 60_000,   // check every minute
  },

  // Vector store backend
  vectorStore: {
    type:       'hnsw',    // 'hnsw' | 'in-memory'
    dimensions: 1536,
    efSearch:   50,
    M:          16,
  },

  // Optional knowledge graph
  knowledgeGraph: {
    enabled: false,
    adapter: 'graphology',
  },
};

const memory = new CognitiveMemoryManager(config);
```

---

## Long-Running Agents: Archive & Rehydration

For agents that run across hundreds of sessions, `TemporalGist` compresses old memories to summaries after 60 days. Without the archive, this compression is destructive. With it, the original content is preserved in cold storage and available on demand.

```ts
import { SqlStorageMemoryArchive } from '@framers/agentos/memory/archive';

// Share the brain's adapter — archive tables live in the same SQLite file
const archive = new SqlStorageMemoryArchive(brain.adapter, brain.features);
await archive.initialize();

// Pass archive to CognitiveMemoryManager
const manager = new CognitiveMemoryManager();
await manager.initialize({
  ...config,
  archive,
});

// Later — the LLM sees a gisted memory and wants the original:
const verbatim = await manager.rehydrate('mt_trace_abc123');
// verbatim → "The ancient dragon Vex attacked the village of Millhaven at dawn..."
```

The archive uses the same `@framers/sql-storage-adapter` `StorageAdapter` contract as `Brain`. When shared, soul exports bundle one file. The `rehydrate_memory` LLM tool is opt-in via `MemoryToolsExtension({ includeRehydrate: true })`.

Retention is usage-aware: if a trace has been rehydrated recently, the consolidation sweep keeps it regardless of age. Default retention: 365 days.

---

## Related Guides

## Multi-Agent Memory: PerspectiveObserver

When multiple agents witness the same event, each gets a first-person rewrite through their personality and relationships.

```ts
import { PerspectiveObserver } from '@framers/agentos/memory/pipeline/observation/PerspectiveObserver';

const observer = new PerspectiveObserver({
  llmInvoker: (sys, usr) => callHaiku(sys, usr),
  importanceThreshold: 0.3,
});

const result = await observer.rewrite(
  [{ eventId: 'evt_1', content: 'The dragon attacked the village.', ... }],
  [
    { agentId: 'lyra', agentName: 'Lyra', hexaco: { emotionality: 0.9, ... }, tier: 'important', ... },
    { agentId: 'holt', agentName: 'Holt', hexaco: { emotionality: 0.2, ... }, tier: 'important', ... },
  ],
);
// Lyra: "I watched in horror as flames consumed our home..."
// Holt: "The beast attacked. Predictable. I assessed our defensive options."
```

Each `SubjectiveTrace` carries a `perspectiveMetadata` snapshot and an `originalEventHash` linking back to the archived objective event. Reconsolidation halves its drift rate for perspective-encoded traces.

---

## Related Guides

- [COGNITIVE_MEMORY.md](./COGNITIVE_MEMORY.md) — full architecture and internals reference
- [WORKING_MEMORY.md](./WORKING_MEMORY.md) — detailed Baddeley working memory reference
- [MEMORY_AUTO_INGEST.md](./MEMORY_AUTO_INGEST.md) — automatic memory ingestion from conversations
- [RAG_MEMORY_CONFIGURATION.md](./RAG_MEMORY_CONFIGURATION.md) — vector store and RAG setup
