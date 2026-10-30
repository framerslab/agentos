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

`nodeResults` holds the results recorded when the checkpoint was saved: those of the nodes in `visitedNodes` and, in the checkpoint of a run that a node interrupted, that node's. A result recorded later reaches only the checkpoints saved after it, so a resume or a fork from an earlier checkpoint runs the nodes after it again, and a human node among them asks again.

## Checkpoint Policies

The graph-wide `checkpointPolicy` and each node's `checkpoint` setting decide when checkpoints are saved:

| Policy | Description |
|---|---|
| `every_node` | Save after every node completes. The policy of `workflow()` and `mission()`. |
| `explicit` | Save only around nodes with `checkpoint: 'before'`, `'after'`, or `'both'`. |
| `none` | The same as `explicit`: the runtime saves around nodes that set `checkpoint`, and no others. The default of [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts). |

Whatever the policy, the runtime also saves a checkpoint when a node fails (after its retries) and when a node interrupts the run for human approval, so a failed or interrupted run can always be resumed. It saves that checkpoint before it yields any event that reports the node's result, so a host that leaves its `for await` loop over `stream()` or `streamResume()` at `interrupt` or `error` can still resume the run. The `checkpoint_saved` event for that checkpoint comes after `interrupt` or `error`, so such a host resumes by the run id from `run_start` (see [Resuming a Run](#resuming-a-run)).

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
- A node with a recorded result in `nodeResults` that is not in `visitedNodes` (the node that interrupted the run) is handled by its `effectClass`:

| effectClass | Resume behavior | Rationale |
|---|---|---|
| `pure` | Re-execute | Deterministic; safe to run again |
| `read` | Re-execute | Idempotent; may return fresher data |
| `write` | Mark complete with the recorded output | Not idempotent — would duplicate DB writes |
| `external` | Mark complete with the recorded output | Not idempotent — would duplicate API calls |
| `human` | Mark complete with the recorded output | Cannot ask a human the same question again |

- Every other node runs as in a fresh run.

A node marked complete with its recorded output does not run again, but its edges still decide where the run goes. They are evaluated on the state the run resumes with, which records the node's visit as the state after a node runs does: `currentNodeId` names the node and `visitedNodes` lists it. The run follows the targets they pick and skips the others, and the resumed stream yields their `edge_transition` events after the node's `node_end`. A condition on such an edge can read a decision the host writes into the checkpoint it forks (see [Time-Travel with fork()](#time-travel-with-fork)).

A node that fails records no result and writes nothing to `scratch` or `artifacts`, as an attempt its `retryPolicy` runs again does. The checkpoint of a failed run therefore holds the state the node ran on, and a resume executes the node again, whatever its `effectClass`. What a failed attempt did outside the graph, such as a call a tool made before it failed, is not undone, so a `write` or `external` node that runs again, by its `retryPolicy` or on resume, repeats it: such a node should be safe to repeat. Declare `effectClass` on tool nodes to match what the node does; `toolNode()` defaults to `'external'` and `gmiNode()` to `'read'`:

```typescript
// web_search makes external calls (the toolNode default)
toolNode('web_search', {}, { effectClass: 'external' })

// A pure transform — safe to re-run
toolNode('json_formatter', {}, { effectClass: 'pure' })

// A database insert — mark it as a write
toolNode('create_record', {}, { effectClass: 'write' })
```

Nodes that become ready together run as one parallel batch (see [Scheduling](./ORCHESTRATION.md#scheduling)). A node of the batch that saves a checkpoint after it runs, as every node does under `every_node`, lists in `visitedNodes` every node completed by then, which can include nodes of the batch that finished before it, and its `scratch` and `artifacts` hold what each of those nodes wrote, merged in the order the nodes are declared, with their results alone in `nodeResults`: a resume from it does not run them again and loses none of their outputs, and runs the nodes of the batch that had not completed, so one that waits for a person asks. Once the batch has merged, the runtime saves one more checkpoint, of the merged state and named for the batch's last node in the order the nodes are declared, so the last checkpoint of the batch holds what every node wrote. It saves that checkpoint before it yields any of the batch's events, so a host that stops reading during them, or a process that stops there, resumes by the run id from what every node wrote.

The checkpoint each node of the batch saves after it runs merges again what every node completed by then wrote, and holds all of it, so under `every_node` the work of saving a batch's checkpoints grows with the square of the number of its nodes, and faster with a reducer that copies the value it extends, such as `concat`. A graph built with `AgentGraph` that has a wide batch saves less under `explicit`, with `checkpoint: 'before'` on the node after the batch: that node saves one checkpoint, of what every node of the batch wrote, before it runs.

When a node of the batch interrupts or fails, the others in the batch have run too, and the ones that completed are in the checkpoint's `visitedNodes`, so a resume does not run them again. The checkpoint's `scratch` and `artifacts` hold what each of them wrote, merged with what the halting node wrote in the order the nodes are declared, so the nodes after the batch read their outputs when the run resumes. The run reports every node of the batch that completed, in the order the nodes are declared, then the halting node, the first in that order that interrupted or failed, and the stop. Another node of the batch that interrupted has not been asked, so the checkpoint holds neither its writes nor its result: a resume executes it again, and it interrupts the resumed run with its own `interrupt`. Another node that failed, like the halting one when it fails, wrote nothing and left no result, so a resume executes it again too.

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

A host that stops reading at `interrupt` or `error` has not seen the `checkpoint_saved` that follows it, and resumes by the run id from `run_start`:

```typescript
let runId: string | undefined;
for await (const event of graph.stream(input)) {
  if (event.type === 'run_start') runId = event.runId;
  if (event.type === 'interrupt' || event.type === 'error') break;
}

const result = await graph.resume(runId!);
```

The same API applies to compiled `workflow()` and `mission()` graphs. The `resume()` of `AgentGraph` and `mission()` accepts a second `patch` argument and does not apply it; patch state with `fork()` instead:

```typescript
const result = await workflow.resume(checkpointId);
const result = await missionCompiled.resume(checkpointId);
```

## When a Save or an Edge Throws

A store backed by a database or a network can refuse a save, and its `save()` rejects. A function on a conditional edge is the host's code, and it can throw. Either ends the run with that error: the runtime does not retry the save or pass over the edge, `stream()` and `streamResume()` throw the error where the runtime asked for the checkpoint or evaluated the edge, and `invoke()` and `resume()` reject with it.

- The checkpoint of a node that interrupts or fails is saved before the node's events, so that a host that stops reading at `interrupt` or `error` can resume. When the store refuses that save, the error comes before those events, and the host reads the store's error instead of `interrupt` or `error`.
- In a parallel batch, the other nodes of the batch run to the end, and save the checkpoints they save, before the error reaches the host, so no node of the run still runs once `stream()` has thrown. The error is the first in the order the nodes are declared, and none of the batch's events is yielded.
- A node of a batch counts as completed once its edges are decided. A checkpoint another node of the batch saves before then leaves it out, so a node whose edges threw is in no checkpoint's `visitedNodes`, and a resume runs it again and follows the edge it picks then.

A resume by the run id from `run_start` continues from the last checkpoint the store saved, and runs again every node that completed after it.

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
      'INSERT INTO checkpoints (id, run_id, graph_id, node_id, timestamp, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, graph_id = EXCLUDED.graph_id, node_id = EXCLUDED.node_id, timestamp = EXCLUDED.timestamp, payload = EXCLUDED.payload, seq = DEFAULT',
      [checkpoint.id, checkpoint.runId, checkpoint.graphId, checkpoint.nodeId, checkpoint.timestamp, JSON.stringify(checkpoint)]
    );
  }

  async get(checkpointId: string): Promise<Checkpoint | null> {
    const { rows } = await this.pool.query('SELECT payload FROM checkpoints WHERE id = $1', [checkpointId]);
    return rows[0] ? JSON.parse(rows[0].payload) : null;
  }

  async load(runId: string, nodeId?: string): Promise<Checkpoint | null> {
    const query = nodeId
      ? 'SELECT payload FROM checkpoints WHERE run_id = $1 AND node_id = $2 ORDER BY timestamp DESC, seq DESC LIMIT 1'
      : 'SELECT payload FROM checkpoints WHERE run_id = $1 ORDER BY timestamp DESC, seq DESC LIMIT 1';
    const { rows } = await this.pool.query(query, nodeId ? [runId, nodeId] : [runId]);
    return rows[0] ? JSON.parse(rows[0].payload) : null;
  }

  async latest(runId: string): Promise<Checkpoint | null> {
    return this.load(runId);
  }

  async list(graphId: string, options?: { limit?: number; runId?: string }): Promise<CheckpointMetadata[]> {
    // Return lightweight metadata, not full payloads
    const { rows } = await this.pool.query(
      'SELECT id, run_id, graph_id, node_id, timestamp, length(payload) as state_size FROM checkpoints WHERE graph_id = $1 AND ($2::text IS NULL OR run_id = $2) ORDER BY timestamp DESC, seq DESC LIMIT $3',
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

The runtime can save several checkpoints of one run in the same millisecond, such as the checkpoints of a parallel batch's nodes and the one it saves after the batch, so `load()` and `latest()` return the checkpoint saved last of those with the latest `timestamp`, and `list()` puts it first. The example's `checkpoints` table has a `seq bigserial` column to order them: it takes the next value at each insert, and `save()` sets it again (`seq = DEFAULT`) when it saves a checkpoint again under its id, so that save counts as the last. `InMemoryCheckpointStore` orders them by each checkpoint's last save.

A `save()` that rejects ends the run with its error (see [When a Save or an Edge Throws](#when-a-save-or-an-edge-throws)).

The order a store has to keep is that of saves that do not overlap. The runtime starts each save once the one before it has finished, except the saves of a parallel batch's nodes, which run together; a checkpoint it saves after them, such as the one after the batch or the one of a batch that halts, starts once they have all finished. In the example, a save that starts after another has finished takes the larger `seq`, since a sequence with the default `CACHE 1` hands out its values in the order they are asked for.

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
