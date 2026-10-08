# Checkpointing and Time-Travel

The AgentOS Unified Orchestration Layer saves checkpoints, resumes a run after an interruption or a failure, and forks a run from a past checkpoint through the [`ICheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/ICheckpointStore.ts) interface. [`InMemoryCheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/InMemoryCheckpointStore.ts) is the default implementation; swap in a persistent store by passing your own implementation to `compile({ checkpointStore })`.

## ICheckpointStore

All checkpoint persistence is done through this interface. Swap implementations without changing any graph code.

```typescript
import type { ICheckpointStore, Checkpoint, CheckpointMetadata } from '@framers/agentos/orchestration/checkpoint';

interface ICheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  get(checkpointId: string): Promise<Checkpoint | null>;
  load(runId: string, nodeId?: string): Promise<Checkpoint | null>;
  latest(runId: string): Promise<Checkpoint | null>;
  list(graphId: string, options?: { limit?: number; runId?: string }): Promise<CheckpointMetadata[]>;
  delete(checkpointId: string): Promise<void>;

  // Time-travel
  fork(checkpointId: string, patchState?: Partial<GraphState>): Promise<string>;
}
```

## Implementations

| Store | Import path | Use case |
|---|---|---|
| [`InMemoryCheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/InMemoryCheckpointStore.ts) | `@framers/agentos/orchestration/checkpoint` | Development, testing, ephemeral runs |
| Custom | Implement [`ICheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/ICheckpointStore.ts) | Postgres, Redis, object storage, or any durable backend |

```typescript
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration/checkpoint';

// In-memory (the default when no store is passed)
const graph = new AgentGraph(...).compile();

// The same store passed explicitly, so the caller can read it
const store = new InMemoryCheckpointStore();
const graphWithStore = new AgentGraph(...).compile({ checkpointStore: store });
```

## What Gets Saved

Each checkpoint is a full, serialisable snapshot taken at a node boundary:

```typescript
interface Checkpoint {
  id: string;       // UUIDv4 assigned by the runtime
  graphId: string;  // CompiledExecutionGraph id
  runId: string;    // Graph run id
  nodeId: string;   // The node at whose boundary this was captured
  timestamp: number;

  // GraphState partitions
  state: {
    input: unknown;      // Original user input (frozen)
    scratch: unknown;    // Node-to-node communication bag
    artifacts: unknown;  // Accumulated outputs
    diagnostics: DiagnosticsView;
  };

  // Optional: memory subsystem snapshot (the runtime does not set it)
  memorySnapshot?: {
    reads: Array<{ traceId: string; content: string; strength: number }>;
    pendingWrites: Array<{ type: string; content: string; scope: string }>;
  };

  // Node results for non-idempotent replay
  nodeResults: Record<string, {
    effectClass: EffectClass;
    output: unknown;
    durationMs: number;
  }>;

  visitedNodes: string[]; // Nodes completed at checkpoint time
  skippedNodes?: string[]; // Branches bypassed by routing decisions
  pendingEdges: string[]; // Edges emitted but not yet executed
}
```

`state` holds the `input`, `scratch`, `artifacts` and `diagnostics` partitions; the `memory` partition is not saved. The runtime never sets `memorySnapshot`, and a resumed run starts with an empty memory view and fresh diagnostics. `pendingEdges` lists the edges a node chose when its checkpoint was taken after it ran, and is empty otherwise.

## Checkpoint Policies

The graph-wide `checkpointPolicy` and each node's `checkpoint` setting decide when checkpoints are saved:

| Policy | Description |
|---|---|
| `every_node` | Save after every node completes. The policy of `workflow()` and `mission()`. |
| `explicit` | Save only around nodes with `checkpoint: 'before'`, `'after'`, or `'both'`. |
| `none` | The same as `explicit`: the runtime saves around nodes that set `checkpoint`, and no others. The default of [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts). |

Whatever the policy, the runtime also saves a checkpoint when a node fails (after its retries) and when a node interrupts the run for human approval, so a failed or interrupted run can always be resumed.

```typescript
// Graph-wide policy
const graph = new AgentGraph(state, { checkpointPolicy: 'every_node' }).compile();

// Per-node override
gmiNode(
  { instructions: '...' },
  { checkpoint: 'after' }  // 'before' | 'after' | 'both' | 'none'
)
```

## Resume Semantics

A resumed run restores `input`, `scratch`, `artifacts` and the list of completed nodes from the checkpoint, then schedules the nodes that have not completed:

- A node in `visitedNodes` does not run again, whatever its `effectClass`.
- A node with a recorded result in `nodeResults` that is not in `visitedNodes` (the node that failed or interrupted the run) is handled by its `effectClass`:

| effectClass | Resume behavior | Rationale |
|---|---|---|
| `pure` | Re-execute | Deterministic; safe to run again |
| `read` | Re-execute | Idempotent; may return fresher data |
| `write` | Mark complete with the recorded output | Not idempotent — would duplicate DB writes |
| `external` | Mark complete with the recorded output | Not idempotent — would duplicate API calls |
| `human` | Mark complete with the recorded output | Cannot ask a human the same question again |

- Every other node runs as in a fresh run.

A `write` or `external` node that failed is therefore not retried on resume: its recorded output, from the failed attempt, stands as its result. Declare `effectClass` on tool nodes to match what the node does; `toolNode()` defaults to `'external'` and `gmiNode()` to `'read'`:

```typescript
// web_search makes external calls (the toolNode default)
toolNode('web_search', {}, { effectClass: 'external' })

// A pure transform — safe to re-run
toolNode('json_formatter', {}, { effectClass: 'pure' })

// A database insert — mark it as a write
toolNode('create_record', {}, { effectClass: 'write' })
```

## Resuming a Run

```typescript
// With AgentGraph
const graph = new AgentGraph(...).compile({
  checkpointStore: new InMemoryCheckpointStore(),
});

// Capture the latest checkpoint id during streaming
let lastCheckpointId: string | undefined;
for await (const event of graph.stream(input)) {
  if (event.type === 'checkpoint_saved') {
    lastCheckpointId = event.checkpointId;
  }
}

// Resume after a failure, a human approval or a timeout.
// Pass either the run id (its latest checkpoint) or an exact checkpoint id.
const result = await graph.resume(lastCheckpointId!);
```

The same API applies to compiled `workflow()` and `mission()` graphs. The `resume()` of `AgentGraph` and `mission()` accepts a second `patch` argument and does not apply it; patch state with `fork()` instead:

```typescript
const result = await workflow.resume(checkpointId);
const result = await missionCompiled.resume(checkpointId);
```

## Time-Travel with fork()

`fork()` creates a new run branching from any past checkpoint, with optional state overrides. The original run is untouched.

```typescript
// `store` is the store the graph was compiled with
const graphId = graph.toIR().id;

// List checkpoints for a graph to find the right branch point
const checkpoints = await store.list(graphId, { runId: 'run-abc' });
// checkpoints: CheckpointMetadata[], sorted by timestamp descending

// Fork from checkpoint with patched state
const newRunId = await store.fork(checkpoints[2].id, {
  scratch: { confidence: 0.95 },  // override confidence so the loop exits
});

// Resume the forked run
const result = await graph.resume(newRunId);
```

The `fork()` operation of `InMemoryCheckpointStore`:
1. Deep-clones the source checkpoint
2. Assigns a fresh `runId` and checkpoint `id`
3. Merges each `patchState` partition (`input`, `scratch`, `artifacts`, `diagnostics`) into the clone's partition
4. Persists the new checkpoint
5. Returns the new `runId`

Common uses:
- Debug a failed run by patching the state that caused the failure
- Test alternative routing decisions from a shared starting point
- Replay a human-gated step with a different human response

## Memory Consistency and Checkpointing

A graph declares a [`MemoryConsistencyMode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) (`live`, `snapshot` or `journaled`) graph-wide or per node:

```typescript
// Graph-wide (AgentGraph's default is 'snapshot')
new AgentGraph(state, { memoryConsistency: 'snapshot' })

// Per-node via MemoryPolicy
gmiNode({ instructions: '...' }, {
  memory: { consistency: 'journaled' },
})
```

The mode is recorded in the compiled graph, and `GraphRuntime` does not read it: in every mode the runtime saves no memory snapshot and replays no memory journal on resume.

## Custom Backend

To use Postgres, Redis, or any other store, implement [`ICheckpointStore`](https://github.com/framerslab/agentos/blob/master/src/orchestration/checkpoint/ICheckpointStore.ts):

```typescript
import type { Pool } from 'pg';
import type { ICheckpointStore, Checkpoint, CheckpointMetadata } from '@framers/agentos/orchestration/checkpoint';
import type { GraphState } from '@framers/agentos/orchestration';

class PostgresCheckpointStore implements ICheckpointStore {
  constructor(private readonly pool: Pool) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    await this.pool.query(
      'INSERT INTO checkpoints (id, run_id, graph_id, node_id, timestamp, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET payload = $6',
      [checkpoint.id, checkpoint.runId, checkpoint.graphId, checkpoint.nodeId, checkpoint.timestamp, JSON.stringify(checkpoint)]
    );
  }

  async get(checkpointId: string): Promise<Checkpoint | null> {
    const { rows } = await this.pool.query('SELECT payload FROM checkpoints WHERE id = $1', [checkpointId]);
    return rows[0] ? JSON.parse(rows[0].payload) : null;
  }

  async load(runId: string, nodeId?: string): Promise<Checkpoint | null> {
    const query = nodeId
      ? 'SELECT payload FROM checkpoints WHERE run_id = $1 AND node_id = $2 ORDER BY timestamp DESC LIMIT 1'
      : 'SELECT payload FROM checkpoints WHERE run_id = $1 ORDER BY timestamp DESC LIMIT 1';
    const { rows } = await this.pool.query(query, nodeId ? [runId, nodeId] : [runId]);
    return rows[0] ? JSON.parse(rows[0].payload) : null;
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    return this.load(runId);
  }

  async list(graphId: string, options?: { limit?: number; runId?: string }): Promise<CheckpointMetadata[]> {
    // Return lightweight metadata, not full payloads
    const { rows } = await this.pool.query(
      'SELECT id, run_id, graph_id, node_id, timestamp, length(payload) as state_size FROM checkpoints WHERE graph_id = $1 AND ($2::text IS NULL OR run_id = $2) ORDER BY timestamp DESC LIMIT $3',
      [graphId, options?.runId ?? null, options?.limit ?? 100]
    );
    return rows.map(r => ({ id: r.id, runId: r.run_id, graphId: r.graph_id, nodeId: r.node_id, timestamp: r.timestamp, stateSize: r.state_size, hasMemorySnapshot: false }));
  }

  async delete(checkpointId: string): Promise<void> {
    await this.pool.query('DELETE FROM checkpoints WHERE id = $1', [checkpointId]);
  }

  async fork(checkpointId: string, patchState?: Partial<GraphState>): Promise<string> {
    const checkpoint = await this.get(checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
    const state = structuredClone(checkpoint.state);
    if (patchState?.scratch) Object.assign(state.scratch as object, patchState.scratch);
    if (patchState?.artifacts) Object.assign(state.artifacts as object, patchState.artifacts);
    const newCheckpoint: Checkpoint = {
      ...structuredClone(checkpoint),
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      timestamp: Date.now(),
      state,
    };
    await this.save(newCheckpoint);
    return newCheckpoint.runId;
  }
}
```

Then pass it to any graph:

```typescript
const graph = new AgentGraph(...).compile({
  checkpointStore: new PostgresCheckpointStore(pool),
});
```

## See Also

- [AgentGraph](../architecture/AGENT_GRAPH.md) — per-node checkpoint config, compile options
- [workflow() DSL](./WORKFLOW_DSL.md) — `every_node` default policy
- [Unified Orchestration](./UNIFIED_ORCHESTRATION.md) — architecture overview
