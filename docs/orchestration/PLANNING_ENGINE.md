---
description: "PlanningEngine — multi-step task planning for AgentOS agents. ReAct, Tree-of-Thoughts, Least-to-Most decomposition, Reflexion self-correction, autonomous loops, checkpoint/rollback, agency distribution across GMIs."
keywords: [agent planning engine, react planning, tree of thoughts, llm task decomposition, least to most prompting, reflexion, autonomous agent loop, multi-step ai planning, agentos orchestration]
---

# AgentOS Planning Engine

`PlanningEngine` is the multi-step task orchestrator for AgentOS agents. A single LLM call answers a single question; a multi-step task (research across sources, draft, critique, revise) requires goal-state retention across turns, step-by-step decomposition, intermediate result inspection, and conditional advance/backtrack logic. `PlanningEngine` provides that loop.

Three collaborators compose into the engine: a **Plan Generator** that converts a goal into a multi-step plan (ReAct or Tree-of-Thoughts), a **Task Decomposer** that further decomposes steps when needed (Least-to-Most prompting), and a **Self-Reflector** that critiques results after execution and proposes revisions (Reflexion). The **Execution Engine** runs steps, checkpoints state, rolls back on failure, and ships an autonomous-loop variant that replans and retries until a budget cap is reached. Three external systems are addressable from the engine: the LLM Provider Manager, the tool catalog, and the RAG system.

## Architecture

![PlanningEngine architecture: Plan Generator (ReAct, Tree-of-Thoughts), Task Decomposer (Least-to-Most), and Self-Reflector (Reflexion) all feed the Execution Engine, which runs Step Executor, Checkpoint Manager, Rollback Handler, and Autonomous Loop on top of three external systems: LLM Provider Manager, Tools, and the RAG System.](/img/diagrams/planning-engine.svg)

## Default Behavior

When no strategy is explicitly selected, the PlanningEngine defaults to **ReAct** (Reasoning + Acting):

```typescript
const defaultOptions = {
  maxSteps: 15,
  maxIterations: 5,
  minConfidence: 0.6,
  allowToolUse: true,
  strategy: 'react',           // <-- DEFAULT STRATEGY
  enableCheckpoints: true,
  checkpointFrequency: 5,
  maxTotalTokens: 100000,
  planningTimeoutMs: 60000,
};
```

**Strategy Fallback Chain:**
1. User-specified `options.strategy`
2. Config default from `PlanningEngineConfig.defaultOptions.strategy`
3. Built-in default: `'react'`

## Planning Strategies

| Strategy | Description | Best For |
|----------|-------------|----------|
| `react` | Interleaved Reasoning + Acting | Dynamic tasks requiring adaptation |
| `plan_and_execute` | Full plan upfront, then execute | Well-defined tasks |
| `tree_of_thought` | Explore multiple reasoning paths | Complex reasoning problems |
| `least_to_most` | Decompose into simpler subproblems | Incrementally solvable tasks |
| `self_consistency` | Generate multiple plans, vote on best | High-stakes decisions |
| `reflexion` | Plan with self-reflection loops | Learning from mistakes |

### Strategy Comparison

| Strategy | Token Cost | Speed | Adaptability | Parallelizable | Best For |
|----------|------------|-------|--------------|----------------|----------|
| **react** | High | Slow | Very High | No | Dynamic, interactive tasks |
| **plan_and_execute** | Low | Fast | Low | Yes | Predictable, batch operations |
| **tree_of_thought** | Very High | Very Slow | High | Yes (branches) | Complex reasoning |
| **least_to_most** | Medium | Medium | Medium | Yes | Hierarchical problems |
| **self_consistency** | Very High | Very Slow | High | Yes | Critical decisions |
| **reflexion** | Medium-High | Medium | High | No | Iterative improvement |

### ReAct (Default)

**How it works**: Interleaves reasoning and action in a continuous loop. At each step: Think → Act → Observe → Reflect.

**Strengths**: Highly adaptive, self-correcting, transparent reasoning, good for unpredictable environments.

**Weaknesses**: High token cost, slower execution, risk of context window exhaustion.

### Plan-and-Execute

**How it works**: Generates a complete plan upfront, validates it, then executes steps sequentially without replanning.

**Strengths**: Predictable execution path, lower token cost, enables parallelization at Agency level.

**Weaknesses**: Cannot adapt to unexpected outcomes, single point of failure if plan is wrong.

### Tree-of-Thought

**How it works**: Generates multiple reasoning branches, explores alternatives in parallel, and votes on the best solution.

**Strengths**: Comprehensive exploration, higher accuracy from multiple perspectives.

**Weaknesses**: Very expensive, slow to execute all branches.

### Self-Consistency

**How it works**: Generates multiple independent plans, executes all paths, aggregates results via voting.

**Strengths**: Extremely robust, error resilient.

**Weaknesses**: Extremely expensive, only justified for critical decisions.

## Usage

### Basic Plan Generation

```typescript
import { PlanningEngine } from '@framers/agentos/planning/planner';

const engine = new PlanningEngine({
  llmProvider: aiModelProviderManager,
  defaultModelId: 'gpt-4-turbo',
});

const plan = await engine.generatePlan(
  'Analyze customer feedback and generate insights report',
  { domainContext: 'E-commerce platform' },
  { strategy: 'react', maxSteps: 15 }
);
```

### Task Decomposition

```typescript
const decomposition = await engine.decomposeTask(
  'Build a REST API with authentication and rate limiting',
  3 // max depth
);

console.log(decomposition.subtasks);
// [
//   { description: 'Design API endpoints schema', complexity: 3 },
//   { description: 'Implement authentication middleware', complexity: 5 },
//   { description: 'Add rate limiting logic', complexity: 4 },
//   ...
// ]
```

### Autonomous Goal Pursuit

```typescript
for await (const progress of engine.runAutonomousLoop('Research AI safety papers', {
  maxIterations: 20,
  goalConfidenceThreshold: 0.9,
  enableReflection: true,
  onApprovalRequired: async (request) => {
    // Human-in-the-loop checkpoint
    return confirm(`Approve: ${request.step.action.content}?`);
  },
})) {
  console.log(`Progress: ${(progress.progress * 100).toFixed(1)}%`);
  console.log(`Current: ${progress.currentStep.action.content}`);
}
```

### Plan Refinement

```typescript
// After a step fails
const refinedPlan = await engine.refinePlan(plan, {
  planId: plan.planId,
  stepId: failedStep.stepId,
  feedbackType: 'step_failed',
  details: 'API rate limit exceeded',
  severity: 'error',
});
```

## Task Execution Model

### Sequential Execution with Dependencies

The PlanningEngine executes steps **sequentially** with dependency-aware ordering:

```typescript
// Steps execute when all dependencies are satisfied
private getNextReadyStep(plan: ExecutionPlan, state: ExecutionState): PlanStep | null {
  for (const step of plan.steps) {
    if (state.completedSteps.includes(step.stepId)) continue;
    if (state.failedSteps.includes(step.stepId)) continue;

    const depsmet = step.dependsOn.every((depId) =>
      state.completedSteps.includes(depId)
    );
    if (depsmet) return step;
  }
  return null;
}
```

### Parallel Processing via Agency Distribution

While the PlanningEngine executes sequentially, **parallelization is achieved by distributing work across Agency GMIs**:

```typescript
// 1. Decompose task into subtasks
const decomposition = await engine.decomposeTask(complexGoal, 3);

// 2. Identify parallelizable subtasks
const parallelizable = decomposition.subtasks.filter(s => s.parallelizable);

// 3. Distribute across Agency GMIs
for (const subtask of parallelizable) {
  await communicationBus.sendToRole(agencyId, selectBestRole(subtask), {
    type: 'task_delegation',
    content: subtask,
    priority: 'high',
  });
}
```

## Guardrails Integration

Guardrails intercept at two points during plan execution:

### Input Evaluation (Before Planning)

```
User Request → [Guardrails evaluateInput] → Sanitized Input → generatePlan()
```

### Output Evaluation (During Execution) - "Changing Mind"

```
Step Execution → Output Stream → [Guardrails evaluateOutput] → Client
                                         ↓
                              Can BLOCK mid-stream
                              Can SANITIZE content
```

```typescript
// Real-time streaming evaluation - "changing mind" mid-stream
class CostCeilingGuardrail implements IGuardrailService {
  config = { evaluateStreamingChunks: true };
  private tokenCount = 0;

  async evaluateOutput({ chunk }: GuardrailOutputPayload) {
    if (chunk.type === 'TEXT_DELTA' && chunk.textDelta) {
      this.tokenCount += Math.ceil(chunk.textDelta.length / 4);
      if (this.tokenCount > 1000) {
        return { action: GuardrailAction.BLOCK, reason: 'Token budget exceeded' };
      }
    }
    return null;
  }
}
```

See [Guardrails Usage Guide](./GUARDRAILS_USAGE.md) for complete documentation.

## Integration with Agencies

The Planning Engine integrates with AgentOS Agencies for multi-agent planning:

```typescript
import { AgencyRegistry, AgentCommunicationBus } from '@framers/agentos';

// Coordinator agent generates plan
const plan = await planningEngine.generatePlan('Complete quarterly report');

// Delegate steps to specialist agents
for (const step of plan.steps) {
  if (step.action.type === 'tool_call') {
    await communicationBus.sendToRole(agencyId, 'specialist', {
      type: 'task_delegation',
      content: step,
      priority: 'high',
    });
  }
}
```

## Checkpointing & Recovery

```typescript
// Save checkpoint
const checkpointId = await engine.saveCheckpoint(plan, currentState);

// Restore after failure
const { plan: restoredPlan, state: restoredState } = 
  await engine.restoreCheckpoint(checkpointId);
```

## Key Interfaces

### ExecutionPlan

```typescript
interface ExecutionPlan {
  planId: string;
  goal: string;
  steps: PlanStep[];
  dependencies: Map<string, string[]>;
  estimatedTokens: number;
  confidenceScore: number;
  strategy: PlanningStrategy;
}
```

### PlanStep

```typescript
interface PlanStep {
  stepId: string;
  action: PlanAction;
  reasoning: string;
  expectedOutcome: string;
  dependsOn: string[];
  confidence: number;
  requiresHumanApproval: boolean;
}
```

See `IPlanningEngine.ts` for complete type definitions.

## Related Documentation

- [Architecture Overview](./ARCHITECTURE.md)
- [Guardrails Usage Guide](./GUARDRAILS_USAGE.md)
- [Human-in-the-Loop](./HUMAN_IN_THE_LOOP.md)
- [Agent Communication](./AGENT_COMMUNICATION.md)




---

## References

### Reasoning + acting in language models

- Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2023). [*ReAct: Synergizing reasoning and acting in language models.*](https://arxiv.org/abs/2210.03629) ICLR 2023. — The reasoning-and-acting loop the planner uses for plan-execute-reflect cycles.
- Yao, S., Yu, D., Zhao, J., Shafran, I., Griffiths, T. L., Cao, Y., & Narasimhan, K. (2023). [*Tree of thoughts: Deliberate problem solving with large language models.*](https://arxiv.org/abs/2305.10601) NeurIPS 2023. — Tree-of-thought search over planning branches; informs the multi-strategy planner config.
- Wei, J., Wang, X., Schuurmans, D., Bosma, M., Ichter, B., Xia, F., Chi, E. H., Le, Q. V., & Zhou, D. (2022). [*Chain-of-thought prompting elicits reasoning in large language models.*](https://arxiv.org/abs/2201.11903) NeurIPS 2022. — Foundational chain-of-thought work behind step-by-step decomposition prompts.
- Shinn, N., Cassano, F., Gopinath, A., Narasimhan, K., & Yao, S. (2023). [*Reflexion: Language agents with verbal reinforcement learning.*](https://arxiv.org/abs/2303.11366) NeurIPS 2023. — Self-reflection loop after plan execution; informs the reflect-and-replan path.

### Hierarchical task decomposition

- Hong, S., Zhuge, M., Chen, J., et al. (2023). [*MetaGPT: Meta programming for a multi-agent collaborative framework.*](https://arxiv.org/abs/2308.00352) ICLR 2024. — LLM-driven goal decomposition into subtasks; informs the planner's task-graph generation.
- Schick, T., Dwivedi-Yu, J., Dessì, R., Raileanu, R., Lomeli, M., Zettlemoyer, L., Cancedda, N., & Scialom, T. (2023). [*Toolformer: Language models can teach themselves to use tools.*](https://arxiv.org/abs/2302.04761) NeurIPS 2023. — Tool-selection methodology the planner uses when assigning tools to plan steps.

### Plan validation + execution

- Liu, B., Jiang, Y., Zhang, X., Liu, Q., Zhang, S., Biswas, J., & Stone, P. (2023). [*LLM+P: Empowering large language models with optimal planning proficiency.*](https://arxiv.org/abs/2304.11477) arXiv:2304.11477. — PDDL-style plan validation; informs the planner's plan-correctness gate.
- Valmeekam, K., Marquez, M., Sreedharan, S., & Kambhampati, S. (2023). [*On the planning abilities of large language models: A critical investigation.*](https://arxiv.org/abs/2305.15771) NeurIPS 2023. — Honest analysis of LLM planning failure modes; motivates the validate-before-execute and reflect-on-failure design choices.

### Implementation references

- [`packages/agentos/src/orchestration/planner/PlanningEngine.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/planner/PlanningEngine.ts) — main planner class with ReAct + plan-execute-reflect loops
- [`packages/agentos/src/orchestration/planner/`](https://github.com/framersai/agentos/tree/master/src/orchestration/planner) — plan generation, decomposition, refinement, validation
- [`packages/agentos/src/orchestration/turn-planner/`](https://github.com/framersai/agentos/tree/master/src/orchestration/turn-planner) — per-turn planning telemetry
