# workflow() DSL

`workflow()` builds an execution graph from steps declared in the order they run. The compiler connects each step to the one before it, adds a router node for a branch and one node per parallel step, and returns the same [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) IR the other builders produce, run by the same [`GraphRuntime`](https://github.com/framerslab/agentos/blob/master/src/orchestration/runtime/GraphRuntime.ts).

Use `workflow()` when the steps are known and ordered. Use [`AgentGraph`](../architecture/AGENT_GRAPH.md) when a node's output decides which node runs next (a `routerNode` with static edges). Use [`mission()`](./MISSION_API.md) to build the graph from a goal and a plan template.

## Quick Start

```typescript
import { workflow, LoopController } from '@framers/agentos/orchestration';
import type { WorkflowRuntimeDeps } from '@framers/agentos/orchestration/builders/WorkflowBuilder';
import { z } from 'zod';

// Your application's own tool runner and model call.
declare function runMyTool(name: string, args: Record<string, unknown>): Promise<unknown>;
declare function callMyModel(instructions: string, context: unknown): Promise<string>;

const deps: WorkflowRuntimeDeps = {
  toolOrchestrator: {
    async processToolCall({ toolCallRequest }) {
      return { success: true, output: await runMyTool(toolCallRequest.toolName, toolCallRequest.arguments) };
    },
  },
  loopController: new LoopController(),
  async *providerCall(instructions, state) {
    const text = await callMyModel(instructions, { input: state.input, artifacts: state.artifacts });
    yield { type: 'text_delta', content: text };
    return { responseText: text, toolCalls: [], finishReason: 'stop' };
  },
};

const wf = workflow('summarize-and-tag')
  .input(z.object({ url: z.string() }))
  .returns(z.object({ summary: z.string(), tags: z.string() }))
  .step('fetch', { tool: 'web_fetch', effectClass: 'external' })
  .step('summarize', { gmi: { instructions: 'Summarize the document in 3 sentences.' }, outputAs: 'summary' })
  .step('tag', { gmi: { instructions: 'Extract 5 topic tags.' }, outputAs: 'tags' })
  .compile({ deps });

const result = await wf.invoke({ url: 'https://example.com/article' });
// { fetch: <tool output>, summary: '...', tags: '...' }
```

`deps` holds the node executors ([`WorkflowRuntimeDeps`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts)): a `tool` step needs `toolOrchestrator` and fails without it; a `gmi` step needs `loopController` and `providerCall` and otherwise succeeds with the output `'gmi-placeholder'`. The [Orchestration Guide](./ORCHESTRATION.md#how-a-run-works) lists every node type's executor.

## Factory Function

```typescript
workflow(name: string): WorkflowBuilder
```

Returns a new [`WorkflowBuilder`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts). The compiled graph's `name` is `name` and its id is `graph-<name>-<timestamp>`; run ids and checkpoint ids are UUIDs.

## Schema Declaration

Both `.input()` and `.returns()` are required. Compilation throws if either is missing.

```typescript
workflow('my-pipeline')
  .input(z.object({ query: z.string(), limit: z.number() }))
  .returns(z.object({ results: z.array(z.string()), count: z.number() }))
```

The compiler lowers a Zod schema to JSON Schema and stores it in the IR; a plain JSON Schema object is accepted and stored as `{}`. The runtime does not validate the input or the result against either schema and does not apply Zod defaults. `invoke(input)` puts `input` in `state.input`, and the run returns `state.artifacts`: each step's output under the step id, or under `outputAs` when the step sets it.

## Step Primitives

### step() / then()

Appends a single named step. `then()` is an alias for `step()`.

```typescript
wf.step('fetch', { tool: 'web_search' })
  .then('extract', { gmi: { instructions: 'Extract the key facts.' } })
  .then('approve', { human: { prompt: 'Approve these facts?' } })
```

**StepConfig: what the step runs (the first one set wins, in this order):**

| Field | Description |
|---|---|
| `tool` | Name of a tool, run through `deps.toolOrchestrator` with the arguments `{}`: a step has no field for tool arguments |
| `gmi` | `{ instructions, maxTokens? }`. Runs `deps.providerCall` inside the `LoopController` loop, up to 10 turns while `providerCall` returns tool calls. The step is recorded as `single_turn`, and the runtime does not read the mode; `maxTokens` is stored and not passed to `providerCall` |
| `human` | Interrupts the run with `prompt` ([Human step](#human-step)) |
| `extension` | `{ extensionId, method }`, run through `deps.extensionExecutor`; an object output is merged into `scratch` |
| `subgraph` | A [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) run as a child graph through `deps.subgraphResolver` and `deps.createSubgraphRuntime` (no input or output mapping) |
| `voice` | A `VoiceNodeConfig`, run through `deps.voiceExecutor` |

A step with none of these becomes a tool node for a tool named `unknown`.

**StepConfig: the other fields:**

```typescript
{
  tool: 'web_search',
  outputAs: 'results',      // artifact key for the output (default: the step id)
  effectClass: 'external',  // 'pure' | 'read' | 'write' | 'external' | 'human'; on resume, a recorded
                            // 'write', 'external' or 'human' step keeps its output instead of running again
  timeout: 30_000,          // the step fails with NODE_TIMEOUT after 30 s
  retryPolicy: { maxAttempts: 3, backoff: 'exponential', backoffMs: 500 }, // re-runs a failed step

  // Stored in the IR and not read by the runtime:
  memory: { consistency: 'snapshot', read: { types: ['episodic'], maxTraces: 5 } },
  guardrails: { output: ['pii-redaction'], onViolation: 'sanitize' },
  discovery: { enabled: true },
  onFailure: 'retry',       // retryPolicy applies whatever this says
  requiresApproval: true,   // adds no approval; use a human step
}
```

`retryPolicy` reaches only `tool` steps, and the runtime retries only nodes that carry one (every failure, or the failures whose message contains an entry of `retryPolicy.retryOn`). `timeout` reaches every step but `gmi` and `subgraph` steps. Any failed step that is not retried, or that fails every attempt, stops the run: the runtime saves a checkpoint and emits `error`, `interrupt` and `run_end`.

### branch()

`branch(condition, routes)` takes a function and a map from route key to step config. The compiler adds a router node that runs `condition(state)`, one node per route (id `branch-<key>-<n>`), and a conditional edge from the router to each route node.

```typescript
wf.step('classify', { tool: 'classifier' })
  .branch(
    (state) => String(state.artifacts.classify), // returns a route key
    {
      premium: { gmi: { instructions: 'Generate premium-tier response.' } },
      standard: { gmi: { instructions: 'Generate standard response.' } },
      rejected: { tool: 'log_rejection' },
    }
  )
  .step('send', { tool: 'send_email' }) // connects from all three route nodes
```

The router node returns the route key, and the runtime takes a router's return value as the id of the node to run next. No node has the route key as its id, so the runtime runs none of the route nodes: it marks every one skipped and continues with the next declared step (`send` above), which runs because all its predecessors are skipped. To choose a step from a value, build the graph with [`AgentGraph`](../architecture/AGENT_GRAPH.md) and a `routerNode` that returns node ids.

### parallel()

`parallel(steps, join)` adds one node per step config (id `parallel-<i>-<n>`), each connected from the previous step, and registers `join.merge` as reducers for the run's state.

```typescript
wf.step('fetch', { tool: 'web_fetch' })
  .parallel(
    [
      { gmi: { instructions: 'Summarize in English.' } },
      { gmi: { instructions: 'Summarize in French.' } },
      { gmi: { instructions: 'Summarize in German.' } },
    ],
    {
      strategy: 'all',                       // stored, not read
      merge: { 'scratch.summaries': 'concat' },
    }
  )
  .step('combine', { gmi: { instructions: 'Pick the best summary.' } })
```

The parallel nodes become ready together and run concurrently, and the next step runs after all of them. `join.strategy`, `join.quorumCount` and `join.timeout` are stored and not read: the runtime always waits for every node. After the batch the runtime merges the nodes' `scratch` updates with the reducers and keeps `state.artifacts` as it was before the batch, so the outputs of the parallel steps are not in the result and `combine` does not see them in `state.artifacts`. A `gmi` or `tool` step writes no `scratch`; an `extension` step whose output is an object does.

## Cycles

The builder connects each step to the steps before it, so it cannot express a cycle, and `compile()` validates the graph with cycles rejected (`Workflow validation failed: Graph contains a cycle ...`). A `subgraph` step is not inspected. A node runs at most once per run in any graph; repeated work belongs inside a step (a `gmi` step's tool loop) or in a new run.

## Compilation

```typescript
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration';

const compiled = wf.compile({
  checkpointStore: new InMemoryCheckpointStore(), // optional; the default is a new in-memory store
  deps,
});
```

A compiled workflow checkpoints after every step (`checkpointPolicy: 'every_node'`) and after a step that fails or interrupts the run.

## Execution

```typescript
// Run to completion: resolves to state.artifacts
const result = await compiled.invoke({ url: 'https://example.com' });

// Stream events
let runId: string | undefined;
for await (const event of compiled.stream({ url: 'https://example.com' })) {
  if (event.type === 'run_start') runId = event.runId;
  console.log(event.type);
}

// Resume from the run's latest checkpoint (a run id or a checkpoint id)
const resumed = await compiled.resume(runId!);

// Export IR for subgraph embedding
const ir = compiled.toIR();
```

### Human step

A `human` step interrupts the run: the runtime saves a checkpoint, emits `interrupt` with the reason `human_approval`, and ends the run. `resume(runId)` marks the step complete with its recorded output (`{ prompt }`) and runs the rest. To carry the reviewer's answer into the run, fork the checkpoint with the answer in its state and resume the fork ([Checkpointing](./CHECKPOINTING.md)).

## Complete Example — Onboarding Workflow

```typescript
import { workflow, InMemoryCheckpointStore } from '@framers/agentos/orchestration';
import { z } from 'zod';

const store = new InMemoryCheckpointStore();

const onboarding = workflow('user-onboarding')
  .input(z.object({
    userId: z.string(),
    plan: z.enum(['free', 'pro', 'enterprise']),
  }))
  .returns(z.object({
    profile: z.unknown(),
    checklist: z.string(),
    summary: z.string(),
  }))

  // Step 1: fetch the user profile (the tool receives no arguments; your
  // toolOrchestrator reads the user id from its own context)
  .step('fetch-user', { tool: 'get_user', effectClass: 'read', outputAs: 'profile' })

  // Step 2: provision, with retries on failure
  .step('provision', {
    tool: 'provision_account',
    effectClass: 'write',
    retryPolicy: { maxAttempts: 3, backoff: 'exponential', backoffMs: 1000 },
  })

  // Step 3: a checklist from the model
  .step('checklist', {
    gmi: { instructions: 'Generate a personalised getting-started checklist.' },
    outputAs: 'checklist',
  })

  // Step 4: a reviewer approves before the welcome mail goes out
  .step('approve', { human: { prompt: 'Approve the onboarding for this user?' } })

  // Step 5: send the welcome mail and summarise
  .step('welcome', { tool: 'send_welcome_email', effectClass: 'external' })
  .step('confirm', {
    gmi: { instructions: 'Confirm onboarding is complete and summarise what was created.' },
    outputAs: 'summary',
  })

  .compile({ checkpointStore: store, deps });

// Run until the approval step interrupts it
let runId: string | undefined;
for await (const event of onboarding.stream({ userId: 'u_123', plan: 'pro' })) {
  if (event.type === 'run_start') runId = event.runId;
  if (event.type === 'interrupt') console.log(`waiting at ${event.nodeId}`);
}

// After the reviewer approves: resume runs welcome and confirm
const result = await onboarding.resume(runId!);
```

## See Also

- [AgentGraph](../architecture/AGENT_GRAPH.md): router nodes and full graph control
- [mission() API](./MISSION_API.md): graphs from a goal and a plan template
- [Checkpointing](./CHECKPOINTING.md): `ICheckpointStore`, resume, forks
- [Orchestration Guide](./ORCHESTRATION.md): how a run schedules, routes and records outputs
- [Unified Orchestration](./UNIFIED_ORCHESTRATION.md): architecture overview

---

## References

### DAG workflow engines

- Apache Airflow contributors. [*Apache Airflow: Programmatically author, schedule and monitor workflows.*](https://airflow.apache.org/) — Reference DAG-execution semantics for a graph of steps that runs each step once its upstream steps finish.
- Prefect contributors. [*Prefect.*](https://www.prefect.io/) — Python workflow engine with fail-fast and resume semantics.
- Temporal contributors. [*Temporal: Microservices orchestration platform.*](https://temporal.io/) — Durable-execution patterns behind the checkpoint and resume design shared with `mission()` and [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts).

### LLM-pipeline composition

- Khattab, O., Singhvi, A., Maheshwari, P., Zhang, Z., Santhanam, K., Vardhamanan, S., Haq, S., Sharma, A., Joshi, T., Moazam, H., Miller, H., Zaharia, M., & Potts, C. (2023). [*DSPy: Compiling declarative language model calls into self-improving pipelines.*](https://arxiv.org/abs/2310.03714) arXiv:2310.03714. — The "compile-then-run" approach to LLM pipelines that informed the [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) IR design.

### Implementation references

- [`src/orchestration/builders/WorkflowBuilder.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts) — `workflow()` factory + chain builder
- [`src/orchestration/ir/types.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) — shared IR
