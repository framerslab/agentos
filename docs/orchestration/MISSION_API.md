# mission() API

> **Live run**: see `mission()` generate a step plan (gmi + tool steps) and return final artifacts with confidence in [the agentos.sh demo gallery](https://agentos.sh/#live-demo). Source: [`examples/mission-api.mjs`](https://github.com/framersai/agentos/blob/master/examples/mission-api.mjs).

`workflow()` and [`AgentGraph`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) ask you to think in terms of nodes and edges before you've thought in terms of intent. `mission()` lets you state the intent first and shape the graph later. You declare what the mission is supposed to accomplish — the goal template, the input schema, the return schema, the planner hints — and the compiler emits a working execution graph from those declarations. When the shape stabilises through use, you export it via `.toWorkflow()` and pin it as a deterministic [workflow()](./workflow-dsl.md) or [AgentGraph](./agent-graph.md) for production.

Use `mission()` when you want a goal-centric authoring API and the runtime to choose the step plan. Use `workflow()` or `AgentGraph` when you need the graph shape pinned and reviewable.

## Quick Start

```typescript
import { mission } from '@framers/agentos/orchestration';
import { z } from 'zod';

const research = mission('deep-research')
  .input(z.object({ topic: z.string() }))
  .goal('Research {{topic}} and produce a structured report with sources')
  .returns(z.object({ report: z.string(), sources: z.array(z.string()) }))
  .planner({ strategy: 'linear', maxSteps: 8 })
  .compile();

const result = await research.invoke({ topic: 'quantum computing' });
```

## Factory Function

```typescript
mission(name: string): MissionBuilder
```

Returns a new [`MissionBuilder`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts). The name is used as the graph's display name and as a prefix for run ids and checkpoint keys.

## Builder API

All methods return `this` for chaining. `.compile()` throws if `input`, `goal`, `returns`, or `planner` are missing.

### .input(schema)

Declares the input schema. Accepts a Zod schema or a plain JSON Schema object.

```typescript
.input(z.object({
  topic: z.string(),
  depth: z.enum(['brief', 'detailed']).default('detailed'),
}))
```

Variables declared in the input schema can be referenced in the goal template via `{{variable}}` syntax. The current stub compiler preserves that template verbatim in generated node instructions rather than interpolating it from runtime input.

### .goal(template)

Sets the goal template. The template is a free-form string with optional `{{variable}}` placeholders.

```typescript
.goal('Research {{topic}} at {{depth}} depth and produce a structured report')
```

The goal template is the primary authoring input for `mission()`. In the current implementation it is passed through into the generated reasoning nodes; future planner-backed compilation can use the same template for dynamic decomposition.

### .returns(schema)

Declares the output schema. Accepts a Zod schema or a plain JSON Schema object.

```typescript
.returns(z.object({
  report: z.string(),
  sources: z.array(z.string()),
  confidence: z.number(),
}))
```

### .planner(config)

Configures planner hints for the mission.

```typescript
.planner({
  strategy: 'linear',   // see strategies below
  maxSteps: 8,          // maximum nodes the planner may generate
})
```

**Planner strategies:**

| Strategy | Description |
|---|---|
| `linear` | Accepted planner hint. The current compiler still emits the same fixed stub graph. |
| `tree` | Accepted planner hint for future branching planners. No graph-shape change today. |
| `adaptive` | Accepted planner hint for future replanning support. No runtime replanning today. |
| `critic` | Accepted planner hint for future critique/refinement passes. |
| `hierarchical` | Accepted planner hint for future sub-goal decomposition. |
| `react` | Accepted planner hint for future stepwise planning loops. |

### .policy(config)

Applies mission-level policy overrides to all compiled nodes. Node-level policies take precedence over mission-level policies.

```typescript
.policy({
  guardrails: ['content-safety', 'pii-redaction'],
  memory: {
    consistency: 'snapshot',
    write: { autoEncode: true, type: 'episodic', scope: 'session' },
  },
  onViolation: 'block',
})
```

### .anchor(id, node, constraints)

Splices a pre-built [`GraphNode`](https://github.com/framersai/agentos/blob/master/src/orchestration/ir/types.ts) into the execution order at a precise position. Anchors let you inject validation steps, human checkpoints, or specialised tool calls without modifying the planner output.

```typescript
import { toolNode, humanNode } from '@framers/agentos/orchestration';

mission('research')
  .anchor(
    'source-verify',
    toolNode('citation_checker', {}, { effectClass: 'read' }),
    {
      phase: 'gather',    // inject into the 'gather' phase of the plan
      after: 'search',    // run after the 'search' step
      before: 'summarize', // run before the 'summarize' step
    }
  )
  .anchor(
    'human-review',
    humanNode({ prompt: 'Review the draft before publishing.' }),
    { phase: 'deliver', after: 'draft' }
  )
```

**Anchor constraints:**

| Field | Description |
|---|---|
| `phase` | The current compiler supports `gather`, `process`, `validate`, and `deliver` |
| `after` | Node id this anchor must run after |
| `before` | Node id this anchor must run before |

All constraint fields are optional — an anchor with no constraints is appended at the end.

## Compilation

```typescript
const compiled = mission(...).compile({
  checkpointStore: new InMemoryCheckpointStore('./missions.db'), // optional
});
```

`compile()` validates that all required fields are present and returns a [`CompiledMission`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts). The IR is compiled lazily on each invocation from the current builder config; today that means the same stub graph shape is regenerated each time with anchors and policies applied.

## Execution

```typescript
// Run to completion
const result = await compiled.invoke({ topic: 'quantum computing' });

// Stream events
for await (const event of compiled.stream({ topic: 'quantum computing' })) {
  console.log(event.type, event.nodeId);
}

// Resume after interruption
const result = await compiled.resume(checkpointId);
```

## Introspection

### explain()

Returns the compiled mission steps without running the mission. Useful for debugging, testing, and "what will happen" previews in UIs.

```typescript
const { steps, ir } = await compiled.explain({ topic: 'quantum computing' });

console.log(steps);
// [
//   { id: 'plan-1', type: 'gmi', config: { type: 'gmi', instructions: '...' } },
//   { id: 'search-1', type: 'tool', config: { type: 'tool', toolName: 'web_search' } },
//   { id: 'summarize-1', type: 'gmi', config: { ... } },
// ]
```

### toWorkflow() / toIR()

Exports the compiled mission as a static [`CompiledExecutionGraph`](https://github.com/framersai/agentos/blob/master/src/orchestration/ir/types.ts). Use this when you want to inspect or reuse the generated IR directly.

```typescript
const ir = compiled.toWorkflow();

// Now wire it directly to GraphRuntime, or use it as a subgraph:
const outerGraph = new AgentGraph(outerState)
  .addNode('research', subgraphNode(ir))
  .compile();
```

## Complete Example — Deep Research Mission

```typescript
import { mission, toolNode, humanNode } from '@framers/agentos/orchestration';
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration/checkpoint';
import { z } from 'zod';

const deepResearch = mission('deep-research')
  .input(z.object({
    topic: z.string(),
    depth: z.enum(['brief', 'detailed']).default('detailed'),
  }))
  .goal('Research {{topic}} at {{depth}} depth. Gather diverse sources, evaluate credibility, and produce a structured report with citations.')
  .returns(z.object({
    report: z.string(),
    sources: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  }))
  .planner({
    strategy: 'adaptive', // accepted today, used by planner-backed compilation later
    maxSteps: 12,
  })
  .policy({
    guardrails: ['grounding-guard', 'pii-redaction'],
    onViolation: 'warn',
    memory: {
      consistency: 'snapshot',
      write: { autoEncode: true, type: 'semantic', scope: 'session' },
    },
  })

  // Inject a citation-verification step after any search phase node
  .anchor(
    'verify-sources',
    toolNode('citation_checker', { timeout: 15_000 }, { effectClass: 'read' }),
    { phase: 'gather', after: 'search' }
  )

  // Require human review before final output
  .anchor(
    'human-review',
    humanNode({ prompt: 'Review the draft report. Approve to publish.' }),
    { phase: 'deliver', before: 'finalize' }
  )

  .compile({
    checkpointStore: new InMemoryCheckpointStore('./research.db'),
  });

// Inspect the plan before running
const { steps } = await deepResearch.explain({ topic: 'quantum computing', depth: 'detailed' });
console.log(`Plan has ${steps.length} steps:`);
steps.forEach((s, i) => console.log(`  ${i + 1}. [${s.type}] ${s.id}`));

// Run
const result = await deepResearch.invoke({ topic: 'quantum computing', depth: 'detailed' });
console.log(result.report);

// Stream with progress
for await (const event of deepResearch.stream({ topic: 'AI safety', depth: 'brief' })) {
  if (event.type === 'node_start') console.log(`Running: ${event.nodeId}`);
}

// Graduate to a static workflow once the plan shape is stable
const staticIR = deepResearch.toWorkflow();
// Save staticIR to a file or pass directly to AgentGraph as a subgraph
```

## See Also

- [AgentGraph](./agent-graph.md) — for explicit graph control
- [workflow() DSL](./workflow-dsl.md) — for deterministic DAG pipelines
- [Checkpointing](./checkpointing.md) — ICheckpointStore, resume semantics
- [Unified Orchestration](./unified-orchestration.md) — architecture overview

---

## References

### Goal-first authoring patterns

- Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2023). [*ReAct: Synergizing reasoning and acting in language models.*](https://arxiv.org/abs/2210.03629) ICLR 2023. — Reasoning-and-acting pattern the `react` planner strategy targets.
- Yao, S., Yu, D., Zhao, J., Shafran, I., Griffiths, T. L., Cao, Y., & Narasimhan, K. (2023). [*Tree of thoughts: Deliberate problem solving with large language models.*](https://arxiv.org/abs/2305.10601) NeurIPS 2023. — Branch-and-evaluate planning pattern informing the `tree` planner strategy.
- Hong, S., Zhuge, M., Chen, J., et al. (2023). [*MetaGPT: Meta programming for a multi-agent collaborative framework.*](https://arxiv.org/abs/2308.00352) ICLR 2024. — Hierarchical task decomposition informing the `hierarchical` planner strategy.

### Implementation references

- [`packages/agentos/src/orchestration/builders/MissionBuilder.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/MissionBuilder.ts) — the `mission()` factory + builder
- [`packages/agentos/src/orchestration/compiler/`](https://github.com/framersai/agentos/tree/master/src/orchestration/compiler) — IR + graph compiler shared with `workflow()` and `AgentGraph`
