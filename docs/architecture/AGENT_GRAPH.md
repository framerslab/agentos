# AgentGraph

When `workflow()` is too rigid and `mission()` is too far ahead of where the runtime currently plans, the answer is [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) — explicit node and edge construction with cycles, conditional routing, subgraph composition, and the discovery and personality edges that don't exist in any other open agent framework. It compiles to the same [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) IR as the higher-level builders, but it gets you full control over the topology before compilation.

**Honest runtime status.** Compilation is complete. Execution is partial: the base runtime executes `tool`, `router`, `guardrail`, and `human` nodes directly. `gmi`, `extension`, and `subgraph` execution still requires a higher-level runtime bridge today, and the discovery and personality edges activate fully only when those integrations are wired. If your graph uses only the four direct-execution node kinds, you're in production-ready territory; if it relies heavily on `gmi` nodes inside cycles, expect to wire the bridge.

Use [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) when you need cycles, conditional fan-out, memory-driven state machines, or subgraph composition. Use [`workflow()`](../orchestration/WORKFLOW_DSL.md) for linear pipelines. Use [`mission()`](../orchestration/MISSION_API.md) when you'd rather declare intent than topology.

![AgentGraph topology: six node types (gmi, tool, router, guardrail, human, subgraph) connected by directed edges including conditional fan-out and a memory-driven retry cycle; compiles to the same CompiledExecutionGraph IR as workflow() and mission()](/img/diagrams/agent-graph-topology.svg)

## Quick Start

```typescript
import {
  AgentGraph, START, END,
  gmiNode, toolNode,
} from '@framers/agentos/orchestration';
import { z } from 'zod';

const graph = new AgentGraph(
  {
    input: z.object({ topic: z.string() }),
    scratch: z.object({ sources: z.array(z.string()).default([]) }),
    artifacts: z.object({ summary: z.string() }),
  },
  { reducers: { 'scratch.sources': 'concat' } }
)
  .addNode('search', toolNode('web_search'))
  .addNode('summarize', gmiNode({ instructions: 'Summarize the search results.' }))
  .addEdge(START, 'search')
  .addEdge('search', 'summarize')
  .addEdge('summarize', END)
  .compile();

const result = await graph.invoke({ topic: 'quantum computing' });
```

## Constructor

```typescript
new AgentGraph(stateSchema, config?)
```

| Parameter | Type | Description |
|---|---|---|
| `stateSchema.input` | Zod schema | Shape of the frozen user input |
| `stateSchema.scratch` | Zod schema | Shape of the mutable node-to-node communication bag |
| `stateSchema.artifacts` | Zod schema | Shape of the accumulated outputs returned to the caller |
| `config.reducers` | [`StateReducers`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) | Field-level merge strategies for parallel branches |
| `config.memoryConsistency` | [`MemoryConsistencyMode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) | Graph-wide memory isolation (default: `'snapshot'`) |
| `config.checkpointPolicy` | `'every_node' \| 'explicit' \| 'none'` | When to persist checkpoints (default: `'none'`) |

## Node Builders

All nodes are created with typed factory functions. Each accepts an optional `policies` object for memory, discovery, guardrail, and persona configuration.

### gmiNode

A General Model Invocation node that calls an LLM. The default `executionMode` is `react_bounded` — an internal ReAct tool-use loop capped by `maxInternalIterations`.

```typescript
import { gmiNode } from '@framers/agentos/orchestration';

gmiNode(
  {
    instructions: 'Research the topic thoroughly.',
    executionMode: 'react_bounded', // default — bounded ReAct loop
    maxInternalIterations: 5,       // default
    parallelTools: false,
    temperature: 0.7,
    maxTokens: 2048,
  },
  {
    memory: {
      consistency: 'snapshot',
      read: { types: ['semantic'], semanticQuery: '{input.topic}', maxTraces: 10 },
      write: { autoEncode: true, type: 'episodic', scope: 'session' },
    },
    discovery: { enabled: true, kind: 'tool', maxResults: 5 },
    guardrails: { output: ['content-safety'], onViolation: 'block' },
    checkpoint: 'after',
  }
)
```

**Execution modes:**

| Mode | Description | Default for |
|---|---|---|
| `single_turn` | One LLM call, no internal tool loop | `workflow()` steps |
| `react_bounded` | ReAct loop up to `maxInternalIterations` | [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) gmi nodes |
| `planner_controlled` | PlanningEngine controls the loop | `mission()` steps |

### toolNode

Invokes a registered [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) by name. The tool name must match a key in the tool catalogue.

```typescript
import { toolNode } from '@framers/agentos/orchestration';

toolNode(
  'web_search',
  {
    timeout: 10_000,
    // Accepted by the IR today; shared-runtime retries are still being wired.
    retryPolicy: { maxAttempts: 3, backoff: 'exponential', backoffMs: 500 },
  },
  {
    effectClass: 'external',
    guardrails: { output: ['pii-redaction'], onViolation: 'sanitize' },
  }
)
```

### humanNode

Suspends execution and surfaces a prompt to a human operator. The run can be resumed with `.resume(checkpointId)` after the human responds.

```typescript
import { humanNode } from '@framers/agentos/orchestration';

humanNode({ prompt: 'Does this summary look accurate? (yes/no)', timeout: 86_400_000 })
```

### routerNode

A pure routing node with no LLM call and no output. Evaluates a condition and emits edges to the appropriate next node. Use this as the source of `addConditionalEdge()` calls when you need a dedicated branching point.

```typescript
import { routerNode } from '@framers/agentos/orchestration';

// In-process function (not serializable)
routerNode((state) => state.scratch.confidence > 0.8 ? 'summarize' : 'search')

// Expression string (serializable to JSON/YAML)
routerNode("scratch.confidence > 0.8 ? 'summarize' : 'search'")
```

### guardrailNode

Runs guardrails as an explicit step in the graph, not just on the edge. Use this for pre-flight checks or to gate progress through critical stages.

```typescript
import { guardrailNode } from '@framers/agentos/orchestration';

guardrailNode(['pii-redaction', 'content-safety'], {
  onViolation: 'reroute',
  rerouteTarget: 'sanitize-output',
})
```

### subgraphNode

Embeds a previously compiled [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) as a single node. Input and output fields are mapped between the parent and child graphs.

At the moment, this is a compile-time authoring primitive. Executing subgraphs requires a runtime bridge that knows how to resolve and invoke nested graphs.

```typescript
import { subgraphNode } from '@framers/agentos/orchestration';

subgraphNode(compiledSubgraph, {
  inputMapping: { 'scratch.query': 'input.topic' },  // parent scratch → child input
  outputMapping: { 'artifacts.summary': 'scratch.result' }, // child artifacts → parent scratch
})
```

## Edge Types

### Static Edge

Always followed. The most common edge type.

```typescript
graph.addEdge(START, 'fetch');
graph.addEdge('fetch', 'process');
graph.addEdge('process', END);
```

### Conditional Edge

Target is resolved at runtime by a function receiving the current [`GraphState`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts).

```typescript
graph.addConditionalEdge('evaluate', (state) =>
  state.scratch.confidence > 0.8 ? 'summarize' : 'search'
);
```

The function must return a valid node id. The returned id is not validated at compile time.

### Discovery Edge

Target is resolved at runtime via semantic search over the capability registry. In the shared runtime today, this remains partial: when discovery is not wired, execution follows the declared fallback target.

```typescript
graph.addDiscoveryEdge('plan', {
  query: 'find a tool that can search academic papers',
  kind: 'tool',            // restrict to tools only
  fallbackTarget: 'web-search',  // use this node if discovery returns nothing
});
```

**Runtime semantics (target state):**
1. `CapabilityDiscoveryEngine.discover(query, { kind })` is called
2. The top-1 result is selected
3. A transient executable node is instantiated
4. Execution continues through the resolved target
5. If no results: route to `fallbackTarget`, or emit `DISCOVERY_NO_RESULTS`

### Personality Edge

Routes based on the agent's current HEXACO/PAD trait value. No conditional logic required in your code once a personality source is wired into the runtime.

```typescript
graph.addPersonalityEdge('draft', {
  trait: 'conscientiousness',  // HEXACO trait name
  threshold: 0.7,              // decision boundary (0–1)
  above: 'human-review',       // route when trait >= threshold
  below: END,                  // route when trait < threshold
});
```

Available HEXACO traits: `honesty_humility`, `emotionality`, `extraversion`, `agreeableness`, `conscientiousness`, `openness`.

## State Management

[`GraphState`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) has three partitions you control and two managed by the runtime:

```typescript
interface GraphState<TInput, TScratch, TArtifacts> {
  input: Readonly<TInput>;      // Frozen at graph start — nodes cannot write
  scratch: TScratch;            // Mutable node-to-node bag
  artifacts: TArtifacts;        // Accumulated outputs returned to caller

  // Runtime-managed:
  memory: MemoryView;           // Read-only memory traces (populated by MemoryPolicy)
  diagnostics: DiagnosticsView; // Token usage, latency, discovery results
  currentNodeId: string;
  visitedNodes: string[];
  iteration: number;
  checkpointId?: string;
}
```

### State Reducers

When parallel branches or a loop writes to the same field, you need a reducer to define the merge strategy:

```typescript
const graph = new AgentGraph(stateSchema, {
  reducers: {
    'scratch.sources': 'concat',        // Arrays: [...existing, ...incoming]
    'scratch.confidence': 'max',        // Numbers: Math.max(existing, incoming)
    'artifacts.summary': 'last',        // Any: last-write-wins (default)
    'artifacts.score': (a, b) => (Number(a) + Number(b)) / 2,  // Custom
  },
});
```

**Built-in reducers:** `concat`, `merge`, `max`, `min`, `avg`, `sum`, `last`, `first`, `longest`

## Compilation

```typescript
const compiled = graph.compile({
  checkpointStore: new InMemoryCheckpointStore('./runs.db'),
  validate: true, // default — throws on unreachable nodes or structural errors
});
```

`AgentGraph` allows cycles (`validate: false` is only needed for intentional orphan nodes).

## Execution

```typescript
// Run to completion
const result = await compiled.invoke({ topic: 'quantum computing' });

// Stream events
for await (const event of compiled.stream({ topic: 'quantum computing' })) {
  console.log(event.type, event.nodeId);
  // event.type: 'run_start' | 'node_start' | 'node_end' | 'edge_transition' | 'run_end'
}

// Resume from checkpoint after interruption
const result = await compiled.resume(checkpointId);

// Export IR for debugging or visualization
const ir = compiled.toIR();
```

## Subgraph Composition

Build modular graphs by nesting compiled graphs as single nodes:

```typescript
// Build the inner graph
const fetchGraph = new AgentGraph(fetchState)
  .addNode('fetch', toolNode('web_fetch'))
  .addNode('parse', toolNode('html_parser'))
  .addEdge(START, 'fetch')
  .addEdge('fetch', 'parse')
  .addEdge('parse', END)
  .compile();

// Embed it in the outer graph
const outerGraph = new AgentGraph(outerState)
  .addNode('gather', subgraphNode(fetchGraph.toIR(), {
    inputMapping: { 'input.url': 'input.url' },
    outputMapping: { 'artifacts.text': 'scratch.rawText' },
  }))
  .addNode('analyze', gmiNode({ instructions: 'Analyze the text.' }))
  .addEdge(START, 'gather')
  .addEdge('gather', 'analyze')
  .addEdge('analyze', END)
  .compile();
```

## Complete Example — Research Graph

```typescript
import {
  AgentGraph, START, END,
  gmiNode, toolNode, humanNode,
} from '@framers/agentos/orchestration';
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration/checkpoint';
import { z } from 'zod';

const ResearchState = {
  input: z.object({ topic: z.string() }),
  scratch: z.object({
    sources: z.array(z.string()).default([]),
    confidence: z.number().default(0),
  }),
  artifacts: z.object({
    summary: z.string(),
    sources: z.array(z.string()),
  }),
};

const graph = new AgentGraph(ResearchState, {
  reducers: { 'scratch.sources': 'concat' },
  memoryConsistency: 'snapshot',
  checkpointPolicy: 'every_node',
})
  .addNode('plan', gmiNode(
    {
      instructions: 'Break this research topic into sub-questions.',
      executionMode: 'single_turn',
    },
    {
      memory: {
        consistency: 'snapshot',
        read: { types: ['semantic'], semanticQuery: '{input.topic}', maxTraces: 10 },
      },
      discovery: { enabled: true, kind: 'tool' },
      checkpoint: 'after',
    }
  ))
  .addNode('search', toolNode(
    'web_search',
    { timeout: 10_000 },
    {
      effectClass: 'external',
      guardrails: { output: ['pii-redaction'], onViolation: 'sanitize' },
    }
  ))
  .addNode('evaluate', gmiNode(
    {
      instructions: 'Evaluate source quality and assign a confidence score (0–1).',
      executionMode: 'single_turn',
    },
    {
      memory: {
        consistency: 'snapshot',
        write: { autoEncode: true, type: 'episodic', scope: 'session' },
      },
    }
  ))
  .addNode('summarize', gmiNode(
    {
      instructions: 'Write a final summary from gathered sources.',
      executionMode: 'single_turn',
    },
    {
      guardrails: {
        output: ['grounding-guard'],
        onViolation: 'reroute',
        rerouteTarget: 'search',
      },
    }
  ))
  .addNode('review', humanNode({ prompt: 'Does this summary look accurate?' }))

  .addEdge(START, 'plan')
  .addEdge('plan', 'search')
  .addEdge('search', 'evaluate')
  .addConditionalEdge('evaluate', (state) =>
    state.scratch.confidence > 0.8 ? 'summarize' : 'search'
  )
  .addPersonalityEdge('summarize', {
    trait: 'conscientiousness',
    threshold: 0.7,
    above: 'review',
    below: END,
  })
  .addEdge('review', END)

  .compile({
    checkpointStore: new InMemoryCheckpointStore('./research-checkpoints.db'),
  });

// Run
const result = await graph.invoke({ topic: 'quantum computing' });

// Stream with progress
for await (const event of graph.stream({ topic: 'quantum computing' })) {
  if (event.type === 'node_start') console.log(`Starting: ${event.nodeId}`);
  if (event.type === 'node_end')   console.log(`Done: ${event.nodeId}`);
}

// Resume after interruption at human-review step
const result2 = await graph.resume(savedCheckpointId);
```

## See Also

- [workflow() DSL](../orchestration/WORKFLOW_DSL.md) — simpler API for DAG pipelines
- [Checkpointing](../orchestration/CHECKPOINTING.md) — ICheckpointStore, resume, time-travel
- [Unified Orchestration](../orchestration/UNIFIED_ORCHESTRATION.md) — architecture overview

---

## References

### Graph-structured agent orchestration

- Wu, Q., Bansal, G., Zhang, J., Wu, Y., Li, B., Zhu, E., Jiang, L., Zhang, X., Zhang, S., Liu, J., Awadallah, A. H., White, R. W., Burger, D., & Wang, C. (2023). [*AutoGen: Enabling next-gen LLM applications via multi-agent conversation.*](https://arxiv.org/abs/2308.08155) arXiv:2308.08155. — Conversation-graph patterns that informed the `gmi` node + `delegate_to` edge semantics.
- LangGraph contributors. [*LangGraph: A library for building stateful, multi-actor applications with LLMs.*](https://github.com/langchain-ai/langgraph) — Reference architecture for stateful graph orchestration with cycles and conditional branches; AgentGraph deliberately differs in the edge taxonomy (adds discovery + personality edges).

### Conditional + cyclic state machines

- Harel, D. (1987). [*Statecharts: A visual formalism for complex systems.*](https://doi.org/10.1016/0167-6423(87)90035-9) *Science of Computer Programming*, 8(3), 231–274. — The state-machine formalism behind cyclic agent loops with conditional transitions.

### State reducers (functional + applied)

- Abramov, D. (2015). [*Redux: A predictable state container.*](https://redux.js.org/) — The reducer pattern AgentGraph's per-field state-merge strategies follow (concat, replace, max, etc.).

### Implementation references

- [`src/orchestration/builders/AgentGraph.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) — the AgentGraph class
- [`src/orchestration/builders/nodes.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts) — [`gmiNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`toolNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`humanNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`routerNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`guardrailNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`subgraphNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`judgeNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts) factories
- [`src/orchestration/ir/`](https://github.com/framerslab/agentos/tree/master/src/orchestration/ir) — shared IR types ([`START`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts), [`END`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts), edges, reducers)
