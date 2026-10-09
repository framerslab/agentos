# AgentGraph

When `workflow()` is too rigid and you want to lay out the topology yourself, use [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts): explicit node and edge construction with router nodes, subgraph composition, and discovery and personality edges. It compiles to the same [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) IR as the higher-level builders, but it gets you full control over the topology before compilation.

**Runtime status.** `compile({ deps })` hands the node executors to the runtime ([Unified Orchestration](../orchestration/UNIFIED_ORCHESTRATION.md)). `router` and `human` nodes run on their own. A `tool` node needs `deps.toolOrchestrator` and fails without it; a `guardrail` node needs `deps.guardrailEngine` and passes without it; a `gmi` node needs `deps.loopController` and `deps.providerCall` and otherwise succeeds with the output `'gmi-placeholder'`; an `extension` node needs `deps.extensionExecutor`, and a `subgraph` node `deps.subgraphResolver` and `deps.createSubgraphRuntime`; each otherwise succeeds with a placeholder output. The compiled graph's runtime has no discovery engine and no persona traits, so a discovery edge always takes its fallback target and a personality edge reads its trait from `scratch._personaTraits` (0.5 when absent). The runtime does not read a node's `memory`, `discovery` or `persona` policies; they stay in the IR. A node runs at most once per run, so a cycle never runs ([Compilation](#compilation)), and a graph with an `addConditionalEdge()` edge runs none of its nodes ([Conditional Edge](#conditional-edge)).

Use [`AgentGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) when you need routing on a node's output, personality or discovery edges, or subgraph composition. Use [`workflow()`](../orchestration/WORKFLOW_DSL.md) for linear pipelines. Use [`mission()`](../orchestration/MISSION_API.md) when you'd rather declare intent than topology.

![AgentGraph topology: six node types (gmi, tool, router, guardrail, human, subgraph) connected by directed edges; compiles to the same CompiledExecutionGraph IR as workflow() and mission()](/img/diagrams/agent-graph-topology.svg)

## Quick Start

```typescript
import {
  AgentGraph, START, END,
  gmiNode, toolNode, LoopController,
} from '@framers/agentos/orchestration';
import type { WorkflowRuntimeDeps } from '@framers/agentos/orchestration/builders/WorkflowBuilder';
import { z } from 'zod';

// Your application's own tool runner and model call.
declare function runMyTool(name: string, args: Record<string, unknown>): Promise<unknown>;
declare function callMyModel(instructions: string, context: unknown): Promise<string>;

// Host bindings for the node executors. The WorkflowRuntimeDeps annotation
// types every callback parameter (toolCallRequest, instructions, state).
const deps: WorkflowRuntimeDeps = {
  toolOrchestrator: {
    async processToolCall({ toolCallRequest }) {
      const output = await runMyTool(toolCallRequest.toolName, toolCallRequest.arguments);
      return { success: true, output };
    },
  },
  loopController: new LoopController(),
  async *providerCall(instructions, state) {
    // state.artifacts holds the outputs of the nodes that ran before this one.
    const text = await callMyModel(instructions, { input: state.input, artifacts: state.artifacts });
    yield { type: 'text_delta', content: text };
    // No tool calls: the node's loop ends after this turn.
    return { responseText: text, toolCalls: [], finishReason: 'stop' };
  },
};

const graph = new AgentGraph({
  input: z.object({ topic: z.string() }),
  scratch: z.object({}),
  artifacts: z.object({ search: z.unknown(), summarize: z.string() }),
})
  // A tool node sends its tool the static args and nothing from the state.
  .addNode('search', toolNode('web_search', { args: { query: 'quantum computing' } }))
  .addNode('summarize', gmiNode({ instructions: 'Summarize the search results.' }))
  .addEdge(START, 'search')
  .addEdge('search', 'summarize')
  .addEdge('summarize', END)
  // toolOrchestrator runs the tool node; loopController + providerCall run the gmi node.
  .compile({ deps });

const result = await graph.invoke({ topic: 'quantum computing' });
// { search: <the tool's output>, summarize: '...' }
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
| `config.memoryConsistency` | [`MemoryConsistencyMode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) | Recorded in the IR (default: `'snapshot'`); the runtime does not read it |
| `config.checkpointPolicy` | `'every_node' \| 'explicit' \| 'none'` | When to persist checkpoints (default: `'none'`; see [Checkpointing](../orchestration/CHECKPOINTING.md)) |

## Node Builders

All nodes are created with typed factory functions. Each accepts an optional `policies` object for memory, discovery, guardrail, persona, effect class and checkpoint configuration; the runtime reads the effect class and the checkpoint flag, and evaluates no `guardrails` policy (a `guardrailNode` is the step that checks content during a run).

### gmiNode

A node that calls an LLM through the host's `deps.providerCall`, inside the `LoopController`'s ReAct tool-use loop, capped by `maxInternalIterations` (default 10). The executor passes the node's `instructions` and the graph state to `providerCall`; `temperature` and `maxTokens` are recorded in the IR and not passed on.

```typescript
import { gmiNode } from '@framers/agentos/orchestration';

gmiNode(
  {
    instructions: 'Research the topic thoroughly.',
    executionMode: 'react_bounded', // default; recorded in the IR
    maxInternalIterations: 5,       // default 10
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

**Execution modes:** `executionMode` is `react_bounded` by default on a `gmiNode`, and `single_turn` on the other node factories and on `judgeNode`. The runtime does not read it: every `gmi` node runs the same bounded ReAct loop.

### toolNode

Invokes a registered [`ITool`](https://github.com/framerslab/agentos/blob/master/src/core/tools/ITool.ts) by name. The tool name must match a key in the tool catalogue.

```typescript
import { toolNode } from '@framers/agentos/orchestration';

toolNode(
  'web_search',
  {
    timeout: 10_000,
    // The runtime re-runs a failed node up to maxAttempts times with this backoff.
    retryPolicy: { maxAttempts: 3, backoff: 'exponential', backoffMs: 500 },
  },
  {
    effectClass: 'external',
    guardrails: { output: ['pii-redaction'], onViolation: 'sanitize' },
  }
)
```

### humanNode

Suspends execution for a human decision. With `autoAccept`, `autoReject`, or a `judge` that decides with enough confidence, the node resolves at once. Otherwise it interrupts the run: the runtime saves a checkpoint and emits an `interrupt` event. `resume()` marks the human node complete with its recorded output (`{ prompt }`), so a host that has the human's answer puts it into the state with `fork(checkpointId, patch)` and resumes the fork ([Checkpointing](../orchestration/CHECKPOINTING.md)). After an auto-accept, a judge's approval or a timeout accept (`onTimeout: 'accept'`), the node runs the guardrails `pii-redaction` and `code-safety` through `deps.guardrailEngine` when one is wired, and a block turns the decision into `approved: false`; `guardrailOverride: false` turns that check off.

```typescript
import { humanNode } from '@framers/agentos/orchestration';

humanNode({ prompt: 'Does this summary look accurate? (yes/no)', timeout: 86_400_000 })
```

### routerNode

A routing node with no LLM call and no output. Its function, or its expression over `input`, `scratch` and `artifacts`, returns the id of the node to run next; the runtime runs that node and marks the router's other targets skipped. Give the router a static edge to every node it can return: the scheduler and the validator read only edges.

```typescript
import { routerNode } from '@framers/agentos/orchestration';

// In-process function (not serializable)
routerNode((state) => Number(state.artifacts.evaluate) > 0.8 ? 'summarize' : 'search')

// Expression string (serializable to JSON/YAML)
routerNode("artifacts.evaluate > 0.8 ? 'summarize' : 'search'")
```

### guardrailNode

Runs guardrails as an explicit step in the graph. The runtime does not evaluate the `guardrails` policy of a node or an edge, so this node is how a compiled graph checks content mid-run. Use it for pre-flight checks or to gate progress through critical stages.

```typescript
import { guardrailNode } from '@framers/agentos/orchestration';

guardrailNode(['pii-redaction', 'content-safety'], {
  onViolation: 'reroute',
  rerouteTarget: 'sanitize-output',
})
```

### subgraphNode

Embeds a previously compiled [`CompiledExecutionGraph`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) as a single node. `inputMapping` keys are paths in the parent's `scratch` and its values are paths in the child's input; `outputMapping` keys are paths in the child's artifacts and its values are paths in the parent's `scratch`. Without `inputMapping` the child's input is `{}`. The child's artifacts are also the node's output.

The node records the child graph's id. At run time the executor looks the child up with `deps.subgraphResolver(graphId)` and runs it on a runtime from `deps.createSubgraphRuntime`; without both, the node succeeds with the output `'subgraph-placeholder'`.

```typescript
import { subgraphNode } from '@framers/agentos/orchestration';

subgraphNode(compiledSubgraph, {
  inputMapping: { query: 'topic' },     // parent scratch.query → child input.topic
  outputMapping: { summary: 'result' }, // child artifacts.summary → parent scratch.result
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

`addConditionalEdge(source, fn)` stores the edge with the target placeholder `__CONDITIONAL__`. The scheduler counts that placeholder as an edge from the source to every node in the graph, the source included. The source then waits on itself and every other node waits on the source, so no node runs and `invoke()` returns `{}`. Route with a [`routerNode`](#routernode) and static edges instead:

```typescript
graph
  .addNode('route', routerNode((state) => Number(state.artifacts.evaluate) > 0.8 ? 'summarize' : 'report-gap'))
  .addEdge('evaluate', 'route')
  .addEdge('route', 'summarize')
  .addEdge('route', 'report-gap');
```

### Discovery Edge

The runtime asks a discovery engine whether a capability matches the query. The compiled graph's runtime has none, so execution follows the declared fallback target.

```typescript
graph.addDiscoveryEdge('plan', {
  query: 'find a tool that can search academic papers',
  kind: 'tool',            // restrict to tools only
  fallbackTarget: 'web-search',  // use this node if discovery returns nothing
});
```

**Runtime semantics.** A [`GraphRuntime`](https://github.com/framerslab/agentos/blob/master/src/orchestration/runtime/GraphRuntime.ts) built with a `discoveryEngine` calls `discover(query, { kind })`. When the first result has an id or a name, execution continues to the edge's own target; with no engine, no result or an error, it continues to `fallbackTarget`. No node is created from the discovered capability.

### Personality Edge

Routes on a trait value: the runtime's `personaTraits[trait]`, else `scratch._personaTraits[trait]`, else 0.5. The compiled graph's runtime has no `personaTraits`, so the value comes from the scratch state or the default.

```typescript
graph.addPersonalityEdge('draft', {
  trait: 'conscientiousness',  // HEXACO trait name
  threshold: 0.7,              // decision boundary (0–1)
  above: 'human-review',       // route when trait >= threshold
  below: END,                  // route when trait < threshold
});
```

`trait` is any key of that trait map, for example `openness` or `conscientiousness`.

## State Management

[`GraphState`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts) has three partitions you control and two managed by the runtime:

```typescript
interface GraphState<TInput, TScratch, TArtifacts> {
  input: Readonly<TInput>;      // Frozen at graph start — nodes cannot write
  scratch: TScratch;            // Mutable node-to-node bag
  artifacts: TArtifacts;        // Accumulated outputs returned to caller

  // Runtime-managed:
  memory: MemoryView;           // Read-only memory view; the runtime leaves it empty
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
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration';

const compiled = graph.compile({
  checkpointStore: new InMemoryCheckpointStore(), // the default when omitted
  validate: true, // default — throws on unreachable nodes or structural errors
  deps, // the host bindings from the Quick Start
});
```

`compile()` accepts cycles (`validate: false` is needed only for orphan nodes). The runtime runs a node at most once per run, and a node in a cycle waits for the node before it in the same cycle, so a cycle never starts: the run ends when only the cycle's nodes and the nodes after them are left.

## Execution

```typescript
// Run to completion
const result = await compiled.invoke({ topic: 'quantum computing' });

// Stream events
for await (const event of compiled.stream({ topic: 'quantum computing' })) {
  console.log(event.type, event.nodeId);
  // event.type: 'run_start' | 'node_start' | 'node_end' | 'edge_transition' | 'interrupt' | 'checkpoint_saved' | 'node_timeout' | 'error' | 'run_end', among others
}

// Resume from checkpoint after interruption
const result = await compiled.resume(checkpointId);

// Export IR for debugging or visualization
const ir = compiled.toIR();
```

## Subgraph Composition

Build modular graphs by nesting compiled graphs as single nodes:

```typescript
import { GraphRuntime, NodeExecutor, InMemoryCheckpointStore } from '@framers/agentos/orchestration';

// Build the inner graph
const fetchGraph = new AgentGraph(fetchState)
  .addNode('fetch', toolNode('web_fetch', { args: { url: 'https://example.com' } }))
  .addNode('parse', toolNode('html_parser'))
  .addEdge(START, 'fetch')
  .addEdge('fetch', 'parse')
  .addEdge('parse', END)
  .compile({ deps });
const fetchIR = fetchGraph.toIR();

// Embed it in the outer graph
const outerGraph = new AgentGraph(outerState)
  .addNode('gather', subgraphNode(fetchIR, {
    outputMapping: { parse: 'rawText' }, // child artifacts.parse → parent scratch.rawText
  }))
  .addNode('analyze', gmiNode({ instructions: 'Analyze the text.' }))
  .addEdge(START, 'gather')
  .addEdge('gather', 'analyze')
  .addEdge('analyze', END)
  .compile({
    deps: {
      ...deps,
      subgraphResolver: (graphId) => (graphId === fetchIR.id ? fetchIR : undefined),
      createSubgraphRuntime: () => new GraphRuntime({
        checkpointStore: new InMemoryCheckpointStore(),
        nodeExecutor: new NodeExecutor(deps),
      }),
    },
  });
```

## Complete Example — Research Graph

```typescript
import {
  AgentGraph, START, END,
  gmiNode, toolNode, humanNode, routerNode,
} from '@framers/agentos/orchestration';
import { InMemoryCheckpointStore } from '@framers/agentos/orchestration/checkpoint';
import { z } from 'zod';

const ResearchState = {
  input: z.object({ topic: z.string() }),
  scratch: z.object({}),
  artifacts: z.object({}),
};

const graph = new AgentGraph(ResearchState, { checkpointPolicy: 'every_node' })
  .addNode('plan', gmiNode({ instructions: 'Break this research topic into sub-questions.' }))
  .addNode('search', toolNode(
    'web_search',
    { timeout: 10_000, args: { query: 'quantum computing' } },
    { effectClass: 'external' },
  ))
  .addNode('evaluate', gmiNode({
    instructions: 'Rate the quality of the search results from 0 to 1. Reply with the number only.',
  }))
  .addNode('route', routerNode("artifacts.evaluate > 0.8 ? 'summarize' : 'report-gap'"))
  .addNode('summarize', gmiNode({ instructions: 'Write a final summary from the search results.' }))
  .addNode('report-gap', gmiNode({ instructions: 'List what the search results are missing.' }))
  .addNode('review', humanNode({ prompt: 'Does this summary look accurate?' }))

  .addEdge(START, 'plan')
  .addEdge('plan', 'search')
  .addEdge('search', 'evaluate')
  .addEdge('evaluate', 'route')
  .addEdge('route', 'summarize')
  .addEdge('route', 'report-gap')
  .addEdge('summarize', 'review')
  .addEdge('report-gap', 'review')
  .addEdge('review', END)

  .compile({
    checkpointStore: new InMemoryCheckpointStore(),
    deps, // the host bindings from the Quick Start
  });

// Run: the review step interrupts the run; invoke() resolves to the artifacts so far,
// keyed by node id (plan, search, evaluate, then summarize or report-gap)
const result = await graph.invoke({ topic: 'quantum computing' });

// Stream with progress
let runId: string | undefined;
for await (const event of graph.stream({ topic: 'quantum computing' })) {
  if (event.type === 'run_start') runId = event.runId;
  if (event.type === 'node_start') console.log(`Starting: ${event.nodeId}`);
  if (event.type === 'node_end')   console.log(`Done: ${event.nodeId}`);
}

// Resume a run that the review step interrupted
const result2 = await graph.resume(runId!);
```

The router runs one of `summarize` and `report-gap` and marks the other skipped. `review` waits for both and runs after whichever ran, since a skipped node counts as done for the nodes after it.

## See Also

- [workflow() DSL](../orchestration/WORKFLOW_DSL.md) — simpler API for DAG pipelines
- [Checkpointing](../orchestration/CHECKPOINTING.md) — ICheckpointStore, resume, time-travel
- [Unified Orchestration](../orchestration/UNIFIED_ORCHESTRATION.md) — architecture overview

---

## References

### Graph-structured agent orchestration

- Wu, Q., Bansal, G., Zhang, J., Wu, Y., Li, B., Zhu, E., Jiang, L., Zhang, X., Zhang, S., Liu, J., Awadallah, A. H., White, R. W., Burger, D., & Wang, C. (2023). [*AutoGen: Enabling next-gen LLM applications via multi-agent conversation.*](https://arxiv.org/abs/2308.08155) arXiv:2308.08155. — Conversation-graph patterns that informed the `gmi` node semantics.
- LangGraph contributors. [*LangGraph: A library for building stateful, multi-actor applications with LLMs.*](https://github.com/langchain-ai/langgraph) — Reference architecture for stateful graph orchestration with cycles and conditional branches; AgentGraph deliberately differs in the edge taxonomy (adds discovery + personality edges).

### Conditional + cyclic state machines

- Harel, D. (1987). [*Statecharts: A visual formalism for complex systems.*](https://doi.org/10.1016/0167-6423(87)90035-9) *Science of Computer Programming*, 8(3), 231–274. — The state-machine formalism behind cyclic agent loops with conditional transitions.

### State reducers (functional + applied)

- Abramov, D. (2015). [*Redux: A predictable state container.*](https://redux.js.org/) — The reducer pattern AgentGraph's per-field state-merge strategies follow (concat, replace, max, etc.).

### Implementation references

- [`src/orchestration/builders/AgentGraph.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/AgentGraph.ts) — the AgentGraph class
- [`src/orchestration/builders/nodes.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts) — [`gmiNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`toolNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`humanNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`routerNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`guardrailNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`subgraphNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), [`judgeNode`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts) factories
- [`src/orchestration/ir/`](https://github.com/framerslab/agentos/tree/master/src/orchestration/ir) — shared IR types ([`START`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts), [`END`](https://github.com/framerslab/agentos/blob/master/src/orchestration/ir/types.ts), edges, reducers)
