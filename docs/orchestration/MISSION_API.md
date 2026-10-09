# mission() API

> Source: [`examples/mission-api.mjs`](https://github.com/framerslab/agentos/blob/master/examples/mission-api.mjs).

`mission()` builds an execution graph from a goal. You declare the goal, the input and return schemas and the planner settings; the compiler turns them into a linear graph of steps from a plan template, with any anchor nodes you add spliced in. `.toWorkflow()` exports the graph so you can inspect it or run it as a subgraph. Use [`workflow()`](./WORKFLOW_DSL.md) or [`AgentGraph`](../architecture/AGENT_GRAPH.md) when you want to write the graph yourself.

## Quick Start

```typescript
import { mission } from '@framers/agentos/orchestration';
import { z } from 'zod';

const research = mission('deep-research')
  .input(z.object({ topic: z.string() }))
  .goal('Research quantum computing and produce a structured report with sources')
  .returns(z.object({ report: z.string(), sources: z.array(z.string()) }))
  .planner({ strategy: 'linear', maxSteps: 8 })
  .compile({ deps: { loopController, providerCall, toolOrchestrator } });

const artifacts = await research.invoke({ topic: 'quantum computing' });
```

`loopController`, `providerCall` and `toolOrchestrator` are your runtime's executors (see [Compilation](#compilation)); without them the graph runs placeholders.

## Factory Function

```typescript
mission(name: string): MissionBuilder
```

Returns a new [`MissionBuilder`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts). The name becomes the compiled graph's name.

## Builder API

All methods return `this` for chaining. `.compile()` throws if `input`, `goal`, `returns` or `planner` is missing.

### .input(schema) and .returns(schema)

Declare the input and output schemas, as Zod schemas or plain JSON Schema objects. The compiler stores them as the graph's state schema; the runtime does not validate input or output against them.

### .goal(template)

Sets the goal text. The compiler wraps it in `<mission_goal>` tags (removing any such tags from the text) and puts it at the start of every reasoning step's instructions. It does not fill `{{variable}}` placeholders from the input: the instructions reach your `providerCall` as written, with the graph state beside them.

### .planner(config)

```typescript
.planner({
  strategy: 'linear',        // required; not read by the compiler
  maxSteps: 8,               // required; not read by the compiler
  style: 'research',         // 'research' | 'qa' | 'creative'; default: classified from the goal
  maxIterationsPerNode: 4,   // cap on each reasoning node's internal iterations
  parallelTools: true,       // passed to each reasoning node
  plan,                      // optional pre-built SimplePlan; replaces the template
})
```

The plan comes from `plan` when it is set (validated: at least one step, unique ids, known actions and phases), otherwise from the template `style` names:

| Style | Steps (phase) |
|---|---|
| `research` | `gather-info` (gather, 8 iterations), `process-info` (process), `deliver-result` (deliver), `refine-output` (deliver) |
| `qa` | `research-quick` (gather, 5 iterations), `answer` (deliver) |
| `creative` | `brainstorm` (gather), `develop-concept` (process), `produce-artifact` (deliver), `polish` (deliver) |

Without `style`, `MissionCompiler.classifyGoal()` picks one from the goal's wording: question openings (`what is`, `how do`, `explain`, `is ...`) give `qa`; artifact verbs (`write a`, `compose`, `draft a`, `design a`) give `creative`; a question of 120 characters or fewer ending in `?` gives `qa`; anything else gives `research`. Each template step is a reasoning (`gmi`) node whose instructions say which tools to use (the research template asks for several `web_search` calls, `image_search` and `web_scrape`). `maxIterationsPerNode` caps a step's iterations; it never raises them.

### .policy(config)

```typescript
.policy({
  guardrails: ['content-safety', 'pii-redaction'],
  memory: { consistency: 'snapshot' },
})
```

`guardrails` becomes an output guardrail policy with `onViolation: 'warn'` on every node that has none. The graph runtime does not read a node's guardrail policy, so it is recorded and not enforced; after an auto-accept, a judge's approval or a timeout accept (`onTimeout: 'accept'`), a human node runs `pii-redaction` and `code-safety` through `deps.guardrailEngine` when one is wired, whatever its policy lists, unless its `guardrailOverride` is `false`. `memory.consistency` sets the graph's memory consistency mode (default `'snapshot'`), which the runtime does not read; `discovery` and `personality` are accepted and not read.

### .anchor(id, node, constraints)

Splices a node of your own into the step order.

```typescript
import { toolNode, humanNode } from '@framers/agentos/orchestration';

mission('research')
  // ...
  .anchor('source-verify', toolNode('citation_checker', {}, { effectClass: 'read' }), {
    phase: 'gather',
    after: 'gather-info',
  })
  .anchor('human-review', humanNode({ prompt: 'Review the draft before publishing.' }), {
    phase: 'deliver',
  });
```

| Field | Effect |
|---|---|
| `phase` | `gather`, `process`, `validate` or `deliver`; the anchor joins that phase, after the phase's plan steps |
| `after` | The id of a node already placed; the anchor goes right after it. An id not placed yet puts the anchor at the phase's end |
| `before` | Accepted and not read |

An anchor without a phase goes at the end of the graph. The compiled node takes the anchor's `id`. The graph is a straight chain from the first step to the last.

### Other builder methods

`autonomy()`, `providerStrategy()`, `costCap()`, `maxAgents()`, `branches()`, `plannerModel()` and `executionModel()` store values in the mission config. The compiler does not read them.

## Compilation

```typescript
const compiled = mission('...')
  // ...
  .compile({
    checkpointStore: new InMemoryCheckpointStore(), // default: a new in-memory store
    deps: { loopController, providerCall, toolOrchestrator },
  });
```

`compile()` checks the required fields and returns a [`CompiledMission`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts). Each `invoke()`, `stream()`, `resume()`, `explain()` and `toWorkflow()` call compiles the graph again from the builder's config.

`deps` are the node executors' dependencies (`WorkflowRuntimeDeps`):

- A reasoning node needs `loopController` and `providerCall`; `providerCall(instructions, state)` makes the model call. Without them the node succeeds with the output `'gmi-placeholder'`.
- A tool node, and a tool call from a reasoning node, need `toolOrchestrator`; without it they fail.

## Execution

```typescript
const artifacts = await compiled.invoke({ topic: 'quantum computing' });

for await (const event of compiled.stream({ topic: 'quantum computing' })) {
  console.log(event.type); // run_start, node_start, node_end, ..., run_end
}

const resumed = await compiled.resume(checkpointId);
```

`invoke()` resolves to the run's artifacts: each node's output under its node id (`gather-info`, `process-info`, `deliver-result`, `refine-output` for the research template), unless an executor returns its own artifact update. The graph checkpoints after every node. `resume(checkpointId, patch)` continues from a checkpoint and ignores `patch`. `inspect()` returns `{}`.

## Introspection

`explain(input)` compiles the graph and returns its nodes without running anything:

```typescript
const { steps, ir } = await compiled.explain({ topic: 'quantum computing' });
console.log(steps.map((s) => `${s.type}:${s.id}`));
// [ 'gmi:gather-info', 'tool:source-verify', 'gmi:process-info', 'gmi:deliver-result', 'gmi:refine-output', 'human:human-review' ]
```

`toWorkflow()` and `toIR()` return the [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts), which can run as a subgraph:

```typescript
import { AgentGraph, subgraphNode, START, END } from '@framers/agentos/orchestration';

const outer = new AgentGraph({ input: z.object({ topic: z.string() }), scratch: z.object({}), artifacts: z.object({}) })
  .addNode('research', subgraphNode(compiled.toWorkflow()))
  .addEdge(START, 'research')
  .addEdge('research', END)
  .compile({ deps });
```

## See Also

- [AgentGraph](../architecture/AGENT_GRAPH.md) — explicit graph control
- [workflow() DSL](./WORKFLOW_DSL.md) — deterministic DAG pipelines
- [Checkpointing](./CHECKPOINTING.md) — `ICheckpointStore` and resume semantics
- [Unified Orchestration](./UNIFIED_ORCHESTRATION.md) — architecture overview

---

## References

- Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2023). [*ReAct: Synergizing reasoning and acting in language models.*](https://arxiv.org/abs/2210.03629) ICLR 2023. — Interleaved reasoning and tool use, the pattern of the template's reasoning nodes.
- Hong, S., Zhuge, M., Chen, J., et al. (2023). [*MetaGPT: Meta programming for a multi-agent collaborative framework.*](https://arxiv.org/abs/2308.00352) ICLR 2024. — Task decomposition into ordered roles and phases.

### Implementation references

- [`src/orchestration/builders/MissionBuilder.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts) — the `mission()` factory and builder
- [`src/orchestration/compiler/MissionCompiler.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/compiler/MissionCompiler.ts) — templates, goal classification, anchor placement
- [`src/orchestration/runtime/NodeExecutor.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/runtime/NodeExecutor.ts) — what each node type needs from `deps`
