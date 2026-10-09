---
description: "PlanningEngine — LLM-generated step plans for AgentOS hosts: plan generation, task decomposition, reflection and refinement, step execution, an autonomous loop and in-memory checkpoints."
keywords: [agent planning engine, llm task decomposition, plan generation, reflection, autonomous agent loop, multi-step ai planning, agentos orchestration]
---

# AgentOS Planning Engine

[`PlanningEngine`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/PlanningEngine.ts) asks a model for a step-by-step plan toward a goal, runs the steps, reflects on the results and changes the plan. A host calls it directly: no other part of AgentOS creates one.

Every model call goes to one provider through an [`AIModelProviderManager`](https://github.com/framerslab/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts): `generateCompletion(defaultModelId, [userMessage], { temperature: 0.7, maxTokens: 4000 })`, with a JSON response format for the calls that parse JSON. The provider is `defaultProviderId` (`'openai'` when unset) and the model is `defaultModelId` (`'gpt-4o'` when unset).

![PlanningEngine architecture diagram: plan generation, task decomposition and reflection feeding an execution engine, with the LLM provider manager, tools and the RAG system as external systems.](/img/diagrams/planning-engine.svg)

## Creating an Engine

```typescript
import { PlanningEngine } from '@framers/agentos';

const engine = new PlanningEngine({
  llmProvider: providerManager,   // an initialised AIModelProviderManager
  defaultProviderId: 'openai',    // default 'openai'
  defaultModelId: 'gpt-4o',       // default 'gpt-4o'
  defaultOptions: { maxSteps: 10 },
});
```

`PlanningEngine` is exported from `@framers/agentos` and `@framers/agentos/orchestration`. The default options:

```typescript
{
  maxSteps: 15,
  maxIterations: 5,
  minConfidence: 0.6,
  allowToolUse: true,
  strategy: 'react',
  enableCheckpoints: true,
  checkpointFrequency: 5,
  maxTotalTokens: 100000,
  planningTimeoutMs: 60000,
}
```

`generatePlan()` reads `maxSteps`, `strategy`, `allowToolUse` and `availableTools` (see below). `maxIterations`, `minConfidence`, `enableCheckpoints`, `checkpointFrequency`, `maxTotalTokens` and `planningTimeoutMs` are not read.

## Planning Strategies

`PlanningStrategy` names six strategies: `react`, `plan_and_execute`, `tree_of_thought`, `least_to_most`, `self_consistency` and `reflexion`. All six run the same single model call: the strategy's name is written into the planning prompt as `Strategy: <name>`, and the plan records it in `plan.strategy`. No strategy generates or compares several plans (`plan.metadata.alternativesConsidered` is always 1). The strategy comes from the call's options, then `defaultOptions.strategy`, then `'react'`.

## Generating a Plan

```typescript
const plan = await engine.generatePlan(
  'Analyze customer feedback and generate an insights report',
  { domainContext: 'E-commerce platform' },
  { strategy: 'plan_and_execute', maxSteps: 8, availableTools: [searchTool] },
);

for (const step of plan.steps) {
  console.log(step.stepId, step.action.type, step.action.content);
}
```

`generatePlan(goal, context?, options?)` builds one prompt from the goal, the context (`conversationHistory`, `retrievedContext`, `domainContext` and `userConstraints`; `failedApproaches` and `capabilities` are not used), the tools in `availableTools` (name and description), `maxSteps` as a stated limit, the strategy name, and whether tool use is allowed. It parses the model's JSON into an `ExecutionPlan`; a reply that is not JSON throws `Planning failed: ...`. The step count is not checked against `maxSteps`.

Each step gets a new id, `step-<index>-<8 hex characters>`, while its `dependsOn` keeps the ids the model wrote in its reply. The model never sees the new ids, so a step whose `dependsOn` is not empty depends on ids that no step has (see [Running the Plan](#running-the-plan)). A step whose action type is `human_input` gets `requiresHumanApproval: true`.

`generatePlan()` then runs `validatePlan(plan)`, logs any issue and returns the plan either way. `validatePlan()` reports an empty plan, a cycle in `plan.dependencies`, steps with confidence below 0.5, and `tool_call` steps without a `toolId`; it suggests phases for plans over 10 steps and validation checkpoints when the overall confidence is below 0.7.

## Task Decomposition

```typescript
const decomposition = await engine.decomposeTask(
  'Build a REST API with authentication and rate limiting',
);

console.log(decomposition.subtasks);
// [
//   { subtaskId: 'subtask-0-1a2b3c4d', description: 'Design API endpoints schema', complexity: 3,
//     dependsOn: [], estimatedTokens: 500, parallelizable: false },
//   ...
// ]
```

`decomposeTask(task, depth = 3)` makes one model call and returns `{ originalTask, subtasks, reasoning, isComplete: true, executionOrder }`. `depth` is logged and not used: the subtasks are one level deep. `executionOrder` is the model's list, or the subtask ids in order when the model gives none.

## Running the Plan

### executeStep()

`executeStep(step, context?)` runs one step by its action type:

| Action type | What runs |
|---|---|
| `tool_call` | The tool in `context.tools` whose `id` equals `step.action.toolId`, with `step.action.toolArgs`; a missing tool fails the step |
| `reasoning` | A model call with the step's content and `context.previousResults` |
| `information_gathering` | `context.retrieve(step.action.query)` when both are set; otherwise nothing, and the step succeeds with no output |
| `synthesis` | A model call over `context.previousResults` |
| `validation` | A model call (JSON) that checks `context.previousResults` against the step's content |
| `subgoal`, `human_input`, `checkpoint` | Nothing: the step succeeds with the output `{ message: 'Step type not implemented', type }` |

The result's `tokensUsed` is always 0.

### runAutonomousLoop()

```typescript
const loop = engine.runAutonomousLoop('Research AI safety papers', {
  maxIterations: 20,               // default 20
  goalConfidenceThreshold: 0.9,    // default 0.9
  enableReflection: true,          // default true
  reflectionFrequency: 3,          // default 3
  requireApprovalFor: ['human_input'], // default ['human_input']
  onApprovalRequired: async (request) => confirm(`Approve: ${request.step.action.content}?`),
});

let next = await loop.next();
while (!next.done) {
  console.log(`Progress: ${(next.value.progress * 100).toFixed(1)}%`, next.value.currentStep.action.type);
  next = await loop.next();
}
console.log(next.value); // ExecutionSummary: goalAchieved, finalConfidence, iterations, outcomes, unresolvedIssues
```

The loop generates a plan with the `react` strategy, then, once per iteration, runs the first step that has not completed or failed and whose `dependsOn` ids have all completed. A step whose action type is in `requireApprovalFor` runs only after `onApprovalRequired` returns `true`; a refusal marks it failed. Steps run with `context.tools` set to an empty list and no `retrieve` function, so a `tool_call` step fails (`Tool <id> not found`) and an `information_gathering` step does nothing. After each step the loop yields a `LoopProgress` (`progress` is completed steps over plan steps, `goalConfidence` is `progress` times the plan's confidence).

Every `reflectionFrequency` iterations it calls `reflect()`. On `replan` it generates a new plan, passing the failed steps as `failedApproaches` (which the planning prompt does not include), and goes on with the old plan's execution state; on `abort` it stops. The loop ends when no step is ready (a step that depends on another step's id never is, see [Generating a Plan](#generating-a-plan)), when `maxIterations` is reached or when `goalConfidence` reaches the threshold, and returns an `ExecutionSummary` as the generator's return value. An error ends the loop with `goalAchieved: false` and the message in `unresolvedIssues`.

## Reflection and Refinement

```typescript
const reflection = await engine.reflect(plan, executionState);
// { insights, issues, adjustments, confidenceAdjustment, recommendation: 'continue' | 'adjust' | 'replan' | 'abort' }

const refined = await engine.refinePlan(plan, {
  planId: plan.planId,
  stepId: failedStep.stepId,
  feedbackType: 'step_failed',
  details: 'API rate limit exceeded',
  severity: 'error',
});
```

`reflect(plan, state)` makes one model call with the goal, the plan's actions, the completed step ids, each result and the failed step ids, and parses the reply.

`refinePlan(plan, feedback)` runs `reflect()` on the plan's execution state from `runAutonomousLoop()` (a fresh state when there is none). The feedback's `feedbackType` is logged; its `details`, `suggestedCorrection` and `severity` are not passed to the model. Of the adjustments the model proposes, `remove_step` is applied; `modify_step` needs `newStepData`, which `reflect()` never sets, and `add_step` and `reorder` are not applied. The plan's confidence moves by `confidenceAdjustment` (kept between 0.1 and 1.0) and `metadata.iterations` goes up by one.

## Checkpoints

```typescript
const checkpointId = await engine.saveCheckpoint(plan, state);
const { plan: restoredPlan, state: restoredState } = await engine.restoreCheckpoint(checkpointId);
```

Checkpoints live in a `Map` inside the engine instance and are lost with it. `saveCheckpoint()` stores a JSON copy of the plan, so the restored plan's `dependencies` is a plain object rather than a `Map` and `createdAt` is a string. `getExecutionState(planId)` returns the state `runAutonomousLoop()` keeps for a plan.

## Guardrails and Agents

`PlanningEngine` calls no guardrail: its model calls go straight to the provider, and guardrails apply to AgentOS turns ([Guardrails Usage](../safety/GUARDRAILS_USAGE.md)). It does not hand work to other agents either. A host that wants subtasks done by agents sends them itself, for example with [`AgentCommunicationBus`](../architecture/AGENT_COMMUNICATION.md):

```typescript
for (const subtask of decomposition.subtasks.filter((s) => s.parallelizable)) {
  await communicationBus.sendToRole(agencyId, 'researcher', {
    type: 'task_delegation',
    fromAgentId: 'coordinator',
    content: { description: subtask.description },
    priority: 'high',
  });
}
```

## Key Interfaces

```typescript
interface ExecutionPlan {
  planId: string;                         // 'plan-<uuid>'
  goal: string;
  steps: PlanStep[];
  dependencies: Map<string, string[]>;    // stepId -> the step's dependsOn
  estimatedTokens: number;                // sum of the steps' estimates
  confidenceScore: number;                // the model's overallConfidence, default 0.7
  createdAt: Date;
  strategy: PlanningStrategy;
  metadata: { modelId: string; iterations: number; planningDurationMs: number; alternativesConsidered: number };
}

interface PlanStep {
  stepId: string;
  index: number;
  action: { type: PlanActionType; toolId?: string; toolArgs?: Record<string, unknown>; subgoal?: string; query?: string; content?: string };
  reasoning: string;
  expectedOutcome: string;
  dependsOn: string[];
  estimatedTokens: number;                // default 500
  confidence: number;                     // default 0.7
  requiresHumanApproval: boolean;
  status: PlanStepStatus;
  result?: PlanStepResult;
}
```

[`IPlanningEngine.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/IPlanningEngine.ts) has the complete type definitions.

## Related Documentation

- [Architecture Overview](../architecture/ARCHITECTURE.md)
- [Guardrails Usage Guide](../safety/GUARDRAILS_USAGE.md)
- [Human-in-the-Loop](../safety/HUMAN_IN_THE_LOOP.md)
- [Agent Communication](../architecture/AGENT_COMMUNICATION.md)

---

## References

### Reasoning + acting in language models

- Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2023). [*ReAct: Synergizing reasoning and acting in language models.*](https://arxiv.org/abs/2210.03629) ICLR 2023. — The reasoning-and-acting pattern the default strategy is named after.
- Yao, S., Yu, D., Zhao, J., Shafran, I., Griffiths, T. L., Cao, Y., & Narasimhan, K. (2023). [*Tree of thoughts: Deliberate problem solving with large language models.*](https://arxiv.org/abs/2305.10601) NeurIPS 2023. — The search method the `tree_of_thought` strategy name refers to.
- Wei, J., Wang, X., Schuurmans, D., Bosma, M., Ichter, B., Xia, F., Chi, E. H., Le, Q. V., & Zhou, D. (2022). [*Chain-of-thought prompting elicits reasoning in large language models.*](https://arxiv.org/abs/2201.11903) NeurIPS 2022. — Chain-of-thought work behind the plan's `reasoning` field.
- Shinn, N., Cassano, F., Gopinath, A., Narasimhan, K., & Yao, S. (2023). [*Reflexion: Language agents with verbal reinforcement learning.*](https://arxiv.org/abs/2303.11366) NeurIPS 2023. — Verbal self-reflection after execution, the pattern of `reflect()`.

### Hierarchical task decomposition

- Hong, S., Zhuge, M., Chen, J., et al. (2023). [*MetaGPT: Meta programming for a multi-agent collaborative framework.*](https://arxiv.org/abs/2308.00352) ICLR 2024. — LLM-driven goal decomposition into subtasks.
- Schick, T., Dwivedi-Yu, J., Dessì, R., Raileanu, R., Lomeli, M., Zettlemoyer, L., Cancedda, N., & Scialom, T. (2023). [*Toolformer: Language models can teach themselves to use tools.*](https://arxiv.org/abs/2302.04761) NeurIPS 2023. — Models choosing tools for steps.

### Plan validation + execution

- Liu, B., Jiang, Y., Zhang, X., Liu, Q., Zhang, S., Biswas, J., & Stone, P. (2023). [*LLM+P: Empowering large language models with optimal planning proficiency.*](https://arxiv.org/abs/2304.11477) arXiv:2304.11477. — PDDL-style plan validation.
- Valmeekam, K., Marquez, M., Sreedharan, S., & Kambhampati, S. (2023). [*On the planning abilities of large language models: A critical investigation.*](https://arxiv.org/abs/2305.15771) NeurIPS 2023. — Analysis of LLM planning failure modes.

### Implementation references

- [`src/orchestration/planner/PlanningEngine.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/PlanningEngine.ts) — the engine
- [`src/orchestration/planner/IPlanningEngine.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/planner/IPlanningEngine.ts) — plan, step, option and result types
- [`src/orchestration/turn-planner/`](https://github.com/framerslab/agentos/tree/master/src/orchestration/turn-planner) — the per-turn planner, a separate component
