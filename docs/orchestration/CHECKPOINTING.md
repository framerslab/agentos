# Checkpointing and Time-Travel

The AgentOS Unified Orchestration Layer has built-in support for checkpoints, resume after failure, and time-travel debugging via the [`ICheckpointStore`](https://github.com/framersai/agentos/blob/master/src/orchestration/checkpoint/ICheckpointStore.ts) interface. [`InMemoryCheckpointStore`](https://github.com/framersai/agentos/blob/master/src/orchestration/checkpoint/InMemoryCheckpointStore.ts) is the default implementation; swap in a persistent store by passing your own implementation to `compile({ checkpointStore })`.

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
| `InMemoryCheckpointStore` | `@framers/agentos/orchestration/checkpoint` | Development, testing, ephemeral runs |
| Custom | Implement `ICheckpointStore` | Postgres, Redis, object storage, or any durable backend |

```typescript
import {
  InMemoryCheckpointStore,
} from '@framers/agentos/orchestration/checkpoint';

// In-memory (default when no store is specified)
const graph = new AgentGraph(...).compile();
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

  // Optional: memory subsystem snapshot
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

The `memory` partition is excluded from `state` — it is always rehydrated fresh from the memory store on resume (unless a `memorySnapshot` is present, which restores the exact in-flight state).

## Checkpoint Policies

Control when checkpoints are persisted:

| Policy | Description |
|---|---|
| `every_node` | Persist after every node completes. Maximum durability. Used by `workflow()` by default. |
| `explicit` | Persist only for nodes with `checkpoint: 'before'`, `'after'`, or `'both'`. |
| `none` | Never persist. Lowest overhead. Used by [`AgentGraph`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) by default. |

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

When a run is resumed from a checkpoint, the runtime replays or re-executes nodes depending on their `effectClass`:

| effectClass | Resume behavior | Rationale |
|---|---|---|
| `pure` | Re-execute | Deterministic; safe to run again |
| `read` | Re-execute | Idempotent; may return fresher data |
| `write` | Replay recorded output from `nodeResults` | Not idempotent — would duplicate DB writes |
| `external` | Replay recorded output from `nodeResults` | Not idempotent — would duplicate API calls |
| `human` | Replay recorded output from `nodeResults` | Cannot ask a human the same question again |

This means you should always declare `effectClass` accurately on tool nodes:

```typescript
// web_search makes external calls — declare it so resume replays the result
toolNode('web_search', {}, { effectClass: 'external' })

// A pure transform — safe to re-run
toolNode('json_formatter', {}, { effectClass: 'pure' })

// A database insert — mark as write so resume replays it
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
    lastCheckpointId = event.checkpointId; // present when a checkpoint was saved
  }
}

// Resume after crash / human approval / timeout.
// You can pass either the run id or an exact checkpoint id.
const result = await graph.resume(lastCheckpointId!);
```

The same API applies to `workflow()` and `mission()`:

```typescript
const result = await workflow.resume(checkpointId);
const result = await missionCompiled.resume(checkpointId);
```

## Time-Travel with fork()

`fork()` creates a new run branching from any past checkpoint, with optional state overrides. The original run is untouched.

```typescript
const store = new InMemoryCheckpointStore();

// List checkpoints for a graph to find the right branch point
const checkpoints = await store.list('my-graph-id', { runId: 'run-abc' });
// checkpoints: CheckpointMetadata[], sorted by timestamp descending

// Fork from checkpoint with patched state
const newRunId = await store.fork(checkpoints[2].id, {
  scratch: { confidence: 0.95 },  // override confidence so the loop exits
});

// Resume the forked run
const result = await graph.resume(newRunId);
```

The `fork()` operation:
1. Deep-clones the source checkpoint
2. Assigns a fresh `runId` and checkpoint `id`
3. Applies `patchState` overrides
4. Persists the new checkpoint
5. Returns the new `runId`

Common uses:
- Debug a failed run by patching the state that caused the failure
- Test alternative routing decisions from a shared starting point
- Replay a human-gated step with a different human response

## Memory Consistency and Checkpointing

The [`MemoryConsistencyMode`](https://github.com/framersai/agentos/blob/master/src/orchestration/ir/types.ts) interacts with checkpointing:

| Mode | Memory snapshot saved? | On resume |
|---|---|---|
| `live` | No | Memory is read fresh from the store |
| `snapshot` | Yes (reads only) | Restores the in-flight reads; writes re-queued |
| `journaled` | Yes (reads + pending writes) | Journal replayed atomically |

Set the mode per-node or graph-wide:

```typescript
// Graph-wide
new AgentGraph(state, { memoryConsistency: 'snapshot' })

// Per-node via MemoryPolicy
gmiNode({ instructions: '...' }, {
  memory: { consistency: 'journaled' },
})
```

## Custom Backend

To use Postgres, Redis, or any other store, implement `ICheckpointStore`:

```typescript
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
      'SELECT id, run_id, graph_id, node_id, timestamp, length(payload) as state_size FROM checkpoints WHERE graph_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [graphId, options?.limit ?? 100]
    );
    return rows.map(r => ({ id: r.id, runId: r.run_id, graphId: r.graph_id, nodeId: r.node_id, timestamp: r.timestamp, stateSize: r.state_size, hasMemorySnapshot: false }));
  }

  async delete(checkpointId: string): Promise<void> {
    await this.pool.query('DELETE FROM checkpoints WHERE id = $1', [checkpointId]);
  }

  async fork(checkpointId: string, patchState?: Partial<GraphState>): Promise<string> {
    const checkpoint = await this.load(checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${checkpointId} not found`);
    const newCheckpoint: Checkpoint = {
      ...structuredClone(checkpoint),
      id: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      timestamp: Date.now(),
      state: patchState ? { ...checkpoint.state, ...patchState } : checkpoint.state,
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

- [AgentGraph](./agent-graph.md) — per-node checkpoint config, compile options
- [workflow() DSL](./workflow-dsl.md) — `every_node` default policy
- [Unified Orchestration](./unified-orchestration.md) — architecture overview
