# workflow() DSL

The right way to ship a multi-step agent is rarely the most flexible way. A graph that can loop and replan is great when you don't know what shape the work takes; it's overkill — and harder to operate — when you do know. `workflow()` exists for the second case. You declare the steps in the order they run, the compiler builds the execution graph, and a static cycle check rejects anything that would loop. The output is the same [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) the cyclic builders produce, so you can swap a `workflow()` for an [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) later without re-architecting the runtime around it.

Use `workflow()` when the steps are known and ordered. Use [`AgentGraph`](../architecture/AGENT_GRAPH.md) when you need cycles, conditional branches, or fan-out/fan-in patterns the linear `then()` chain can't express. Use [`mission()`](./MISSION_API.md) when you want to declare intent first and let the planner decide the steps.

## Quick Start

```typescript
import { workflow } from '@framers/agentos/orchestration';
import { z } from 'zod';

const wf = workflow('summarize-and-tag')
  .input(z.object({ url: z.string() }))
  .returns(z.object({ summary: z.string(), tags: z.array(z.string()) }))
  .step('fetch', { tool: 'web_fetch', effectClass: 'external' })
  .step('summarize', { gmi: { instructions: 'Summarize the document in 3 sentences.' } })
  .step('tag', { gmi: { instructions: 'Extract 5 topic tags.' } })
  .compile();

const result = await wf.invoke({ url: 'https://example.com/article' });
```

## Factory Function

```typescript
workflow(name: string): WorkflowBuilder
```

Returns a new [`WorkflowBuilder`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts). The name is used as the compiled graph's display name and as a prefix for run ids and checkpoint keys.

## Schema Declaration

Both `.input()` and `.returns()` are required. Compilation throws if either is missing.

```typescript
workflow('my-pipeline')
  .input(z.object({ query: z.string(), limit: z.number().default(10) }))
  .returns(z.object({ results: z.array(z.string()), count: z.number() }))
```

Both accept Zod schemas or plain JSON Schema objects.

## Step Primitives

### step() / then()

Appends a single named step. `then()` is an alias for `step()` — it reads more naturally when chaining.

```typescript
wf.step('fetch', { tool: 'web_search' })
  .then('extract', { gmi: { instructions: 'Extract the key facts.' } })
  .then('approve', { human: { prompt: 'Approve these facts?' } })
```

**StepConfig — execution strategies (pick one):**

| Field | Description |
|---|---|
| `tool` | Name of a registered [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) to invoke |
| `gmi` | LLM call with `instructions` string. Always runs as `single_turn` |
| `human` | Suspend and surface `prompt` to a human operator |
| `extension` | Call `method` on registered `extensionId` |
| `subgraph` | Delegate to a [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) |

**StepConfig — optional policies:**

```typescript
{
  tool: 'web_search',

  // Side-effect classification
  effectClass: 'external',  // 'pure' | 'read' | 'write' | 'external' | 'human'

  // Memory
  memory: {
    consistency: 'snapshot',
    read: { types: ['episodic'], maxTraces: 5 },
    write: { autoEncode: true, type: 'episodic', scope: 'session' },
  },

  // Guardrails
  guardrails: {
    output: ['pii-redaction'],
    onViolation: 'sanitize',
  },

  // Failure handling
  // Note: `retryPolicy` is part of the compiled IR today, but automatic retry
  // execution is still being wired into the shared runtime.
  onFailure: 'retry',
  retryPolicy: { maxAttempts: 3, backoff: 'exponential', backoffMs: 500 },

  // Timeout
  timeout: 30_000,

  // Human approval gate before proceeding
  requiresApproval: true,
}
```

### branch()

Appends a conditional fan-out. The `condition` function evaluates [`GraphState`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) at runtime and returns a route key. Each route key maps to a step config. All branches become the new tail — the next declared step connects from all of them.

```typescript
wf.step('classify', { tool: 'classifier' })
  .branch(
    (state) => state.scratch.category, // returns a route key
    {
      premium: { gmi: { instructions: 'Generate premium-tier response.' } },
      standard: { gmi: { instructions: 'Generate standard response.' } },
      rejected: { tool: 'log_rejection' },
    }
  )
  .step('send', { tool: 'send_email' }) // connects from all three branches
```

The condition function must return one of the route keys. Returning an unrecognised key causes a `BRANCH_ROUTE_NOT_FOUND` runtime error.

### parallel()

Appends a concurrent fan-out. All steps execute simultaneously (subject to runtime scheduling). After all complete, their outputs are merged using the `join.merge` reducers.

```typescript
wf.step('fetch', { tool: 'web_fetch' })
  .parallel(
    [
      { gmi: { instructions: 'Summarize in English.' } },
      { gmi: { instructions: 'Summarize in French.' } },
      { gmi: { instructions: 'Summarize in German.' } },
    ],
    {
      strategy: 'all',     // 'all' | 'any' | 'quorum'
      quorumCount: 2,      // only used when strategy is 'quorum'
      merge: {
        'scratch.summaries': 'concat',  // arrays get concatenated
      },
      timeout: 60_000,
    }
  )
  .step('combine', { gmi: { instructions: 'Pick the best summary.' } })
```

**Join strategies:**

| Strategy | Description |
|---|---|
| `all` | Wait for all parallel branches to complete |
| `any` | Continue as soon as the first branch completes |
| `quorum` | Wait for `quorumCount` branches to complete |

## DAG Enforcement

`workflow()` enforces acyclicity at compile time. Any attempt to create a cycle (even via subgraphs) throws a `WorkflowValidationError`:

```
Workflow validation failed: cycle detected involving nodes: fetch → process → fetch
```

If you need agent loops, use [AgentGraph](../architecture/AGENT_GRAPH.md) instead.

GMI steps inside `workflow()` always run in `single_turn` mode — the `executionMode` field in `gmi` config is accepted in the type but ignored at runtime. This is a deliberate design choice: workflow steps must be cost-bounded and deterministic.

## Compilation

```typescript
const compiled = wf.compile({
  checkpointStore: new InMemoryCheckpointStore('./runs.db'), // optional
});
```

The workflow compiler automatically sets `checkpointPolicy: 'every_node'` — every step is checkpointed by default, making long-running workflows resumable after any failure.

## Execution

```typescript
// Run to completion
const result = await compiled.invoke({ url: 'https://example.com' });

// Stream events
for await (const event of compiled.stream({ url: 'https://example.com' })) {
  console.log(event.type, event.nodeId);
}

// Resume after failure (checkpointId from GraphState.checkpointId)
const result = await compiled.resume(checkpointId);

// Export IR for subgraph embedding
const ir = compiled.toIR();
```

## Complete Example — Onboarding Workflow

```typescript
import { workflow } from '@framers/agentos/orchestration';
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration/checkpoint';
import { z } from 'zod';

const onboarding = workflow('user-onboarding')
  .input(z.object({
    userId: z.string(),
    plan: z.enum(['free', 'pro', 'enterprise']),
  }))
  .returns(z.object({
    welcomed: z.boolean(),
    resourcesCreated: z.array(z.string()),
  }))

  // Step 1: fetch the new user profile
  .step('fetch-user', {
    tool: 'get_user',
    effectClass: 'read',
  })

  // Step 2: branch on plan type
  .branch(
    (state) => state.scratch.plan,
    {
      free: {
        tool: 'provision_free_tier',
        effectClass: 'write',
      },
      pro: {
        tool: 'provision_pro_tier',
        effectClass: 'write',
        // Declared now, runtime-managed retries still pending.
        retryPolicy: { maxAttempts: 3, backoff: 'exponential', backoffMs: 1000 },
      },
      enterprise: {
        human: { prompt: 'Manually configure enterprise account for this user.' },
        requiresApproval: true,
      },
    }
  )

  // Step 3: parallel welcome actions
  .parallel(
    [
      { tool: 'send_welcome_email', effectClass: 'external' },
      { tool: 'create_default_workspace', effectClass: 'write' },
      { gmi: { instructions: 'Generate a personalised getting-started checklist.' } },
    ],
    {
      strategy: 'all',
      merge: {
        'scratch.provisioned': 'concat',
      },
    }
  )

  // Step 4: confirm
  .step('confirm', {
    gmi: {
      instructions: 'Confirm onboarding is complete and summarise what was created.',
      maxTokens: 256,
    },
  })

  .compile({
    checkpointStore: new InMemoryCheckpointStore('./onboarding.db'),
  });

// Run
const result = await onboarding.invoke({ userId: 'u_123', plan: 'pro' });

// Stream with progress UI
for await (const event of onboarding.stream({ userId: 'u_456', plan: 'free' })) {
  if (event.type === 'node_start') updateProgressBar(event.nodeId);
}

// Resume a human-gated enterprise onboarding after approval
const result2 = await onboarding.resume(savedCheckpointId);
```

## See Also

- [AgentGraph](../architecture/AGENT_GRAPH.md) — for cyclic graphs and full graph control
- [mission() API](./MISSION_API.md) — for goal-driven orchestration
- [Checkpointing](./checkpointing.md) — ICheckpointStore, resume semantics
- [Unified Orchestration](./UNIFIED_ORCHESTRATION.md) — architecture overview

---

## References

### DAG workflow engines

- Apache Airflow contributors. [*Apache Airflow: Programmatically author, schedule and monitor workflows.*](https://airflow.apache.org/) — Reference DAG-execution semantics that informed `workflow()`'s topological-sort + tier-execution model.
- Prefect contributors. [*Prefect: The new standard in dataflow automation.*](https://www.prefect.io/) — Modern Python workflow engine with similar fail-fast and resume semantics.
- Temporal contributors. [*Temporal: Microservices orchestration platform.*](https://temporal.io/) — Durable-execution patterns informing the checkpointing + resume design shared with `mission()` and [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts).

### LLM-pipeline composition

- Khattab, O., Singhvi, A., Maheshwari, P., Zhang, Z., Santhanam, K., Vardhamanan, S., Haq, S., Sharma, A., Joshi, T., Moazam, H., Miller, H., Zaharia, M., & Potts, C. (2023). [*DSPy: Compiling declarative language model calls into self-improving pipelines.*](https://arxiv.org/abs/2310.03714) arXiv:2310.03714. — The "compile-then-run" approach to LLM pipelines that informed the [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) IR design.

### Implementation references

- [`src/orchestration/builders/WorkflowBuilder.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts) — `workflow()` factory + chain builder
- [`src/orchestration/ir/types.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) — shared IR
