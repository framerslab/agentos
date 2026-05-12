---
title: Human-in-the-Loop (HITL)
description: Five approval triggers, six handler factories (cli, slack, webhook, llmJudge, autoApprove, autoReject), the workflow human step, and the runtime HumanInteractionManager. Pause AgentOS agent runs at any lifecycle event for human review.
keywords:
  - human in the loop
  - hitl
  - ai approval workflow
  - llm judge approval
  - agent safety gates
  - agency hitl
  - workflow human step
  - approval handler
  - slack approval bot
  - cli approval
  - agentos hitl
  - approval request decision
  - hitl timeout policy
---

# Human-in-the-Loop (HITL)

Pause an agent run at specific lifecycle events, route the pending action to a human (or an LLM judge, or both), and resume with an approve / reject / modify decision. AgentOS exposes HITL on three integration surfaces — agency-level config, workflow / graph nodes, and a runtime manager — all converging on the same `ApprovalRequest → handler → ApprovalDecision` contract.

![Three-lane HITL architecture: Agency HitlConfig with 5 triggers and 6 handlers, Workflow human step with autoAccept/autoReject/judge modes, and the runtime HumanInteractionManager with severity-aware PendingAction + escalation surface. All three converge on the ApprovalRequest → handler → ApprovalDecision → guardrail-override contract.](/img/diagrams/human-in-the-loop.svg)

## What HITL is in AgentOS

Three places HITL plugs in:

| Layer | Primitive | Source | Use when |
|---|---|---|---|
| **Agency / agent** | [`HitlConfig`](https://github.com/framersai/agentos/blob/master/src/api/types.ts) on `agency({ hitl: {...} })` or `agent({ hitl: {...} })` | [`src/api/types.ts`](https://github.com/framersai/agentos/blob/master/src/api/types.ts) | The host runs a multi-agent agency and wants declarative gates at specific lifecycle events (a tool name, the final return, a strategy override). |
| **Workflow / graph** | `step({ human: { prompt, autoAccept?, autoReject?, judge? } })` | [`src/orchestration/builders/WorkflowBuilder.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts) + [`src/orchestration/ir/types.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/ir/types.ts) | The host owns an explicit DAG and wants a typed human node that suspends the graph until a decision payload arrives. |
| **Runtime** | [`HumanInteractionManager`](https://github.com/framersai/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts) implementing [`IHumanInteractionManager`](https://github.com/framersai/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts) | [`src/orchestration/hitl/`](https://github.com/framersai/agentos/tree/master/src/orchestration/hitl) | A subsystem (planner, custom orchestrator, evaluator) needs severity-aware approval with clarification, edit, and escalation flows in addition to approve/reject. |

The agency-level surface is what most apps need. Reach for workflow nodes when you're already authoring a graph. Reach for the runtime manager when you need the full clarification/edit/escalation vocabulary outside of an `agency()` run.

## Five approval triggers

`HitlConfig.approvals` is the declarative trigger surface. Every field is optional — present a field, get a pause at that lifecycle event:

```typescript
import { agency, hitl } from '@framers/agentos';

const guarded = agency({
  agents: { worker: { instructions: 'Execute tasks.' } },
  hitl: {
    approvals: {
      beforeTool: ['delete-file', 'send-email'],
      beforeAgent: ['billing-specialist'],
      beforeEmergent: true,
      beforeReturn: true,
      beforeStrategyOverride: true,
    },
    handler: hitl.cli(),
  },
});
```

| Trigger | Pauses before | Typical use |
|---|---|---|
| `beforeTool: string[]` | Any tool whose name appears in the list | Destructive or high-cost tool calls (`delete-file`, `send-email`, `purchase`). |
| `beforeAgent: string[]` | Any agent in the agency whose name appears in the list | Specialists that should only run after human go-ahead (`billing-agent`, `legal-review`). |
| `beforeEmergent: boolean` | Runtime synthesis of a new specialist via `spawn_specialist` | Production agencies that allow emergent capabilities but require approval before the roster grows. |
| `beforeReturn: boolean` | The final answer leaves the agency | Customer-facing channels where the last response gets a human or judge review. |
| `beforeStrategyOverride: boolean` | The orchestrator wants to switch execution strategies mid-run | Adaptive agencies whose strategy drift should be reviewed before it happens. |

Source: [`HitlConfig.approvals` in `src/api/types.ts`](https://github.com/framersai/agentos/blob/master/src/api/types.ts).

## Six handler factories

The `hitl` namespace exports six ready-to-use handler factories. Each returns a `HitlHandler` (an async function taking `ApprovalRequest` and resolving to `ApprovalDecision`), so you compose them by wrapping in your own function when you need logging, fallback chains, or conditional routing.

Source: [`src/api/hitl.ts`](https://github.com/framersai/agentos/blob/master/src/api/hitl.ts).

### `hitl.cli()`

Interactive terminal prompt. Reads from `process.stdin`. Use locally and in interactive scripts; **not safe for CI or serverless**.

```typescript
handler: hitl.cli();
```

### `hitl.autoApprove()`

Approves every request immediately. Use in tests and CI.

```typescript
handler: hitl.autoApprove();
```

### `hitl.autoReject(reason?)`

Rejects every request. Use for dry-run mode where you want to confirm which actions *would* fire without permitting any.

```typescript
handler: hitl.autoReject('dry-run mode — no side effects permitted');
```

### `hitl.webhook(url)`

POSTs the `ApprovalRequest` as JSON to your endpoint and reads back an `ApprovalDecision`. Non-2xx is treated as rejection with the status code as the reason. Use this when you have an in-house approval service.

```typescript
handler: hitl.webhook('https://approvals.example.com/decide');
```

### `hitl.slack({ channel, token })`

Posts a notification to a Slack channel and **auto-approves** in the current shipping. Reaction-polling (`:white_check_mark:` / `:x:`) is a planned future enhancement. Use it today as an audit trail; gate it behind another handler if you need to wait on reactions.

```typescript
handler: hitl.slack({ channel: '#approvals', token: process.env.SLACK_BOT_TOKEN! });
```

### `hitl.llmJudge({ ... })`

Delegates the decision to a model. The judge replies with a structured `{approved, confidence, reasoning}` JSON object; if `confidence < confidenceThreshold` (default `0.7`), the request falls through to a `fallback` handler.

```typescript
handler: hitl.llmJudge({
  model: 'gpt-4o-mini',
  criteria: 'Approve unless the action would delete data, send messages externally, or spend more than $1.',
  confidenceThreshold: 0.8,
  fallback: hitl.cli(),
});
```

This is the recommended production default for agencies where most actions are low-risk: a cheap judge auto-handles the easy majority, the human only sees what the judge isn't confident about.

## The `ApprovalRequest` / `ApprovalDecision` contract

Source: [`ApprovalRequest` + `ApprovalDecision` in `src/api/types.ts`](https://github.com/framersai/agentos/blob/master/src/api/types.ts).

Every handler receives this:

```typescript
interface ApprovalRequest {
  id: string;
  type: 'tool' | 'agent' | 'emergent' | 'output' | 'strategy-override';
  agent: string;             // name of the agent that triggered the pause
  action: string;            // short label (tool/agent name)
  description: string;
  details: Record<string, unknown>; // structured args / config
  context: {
    agentCalls: AgentCallRecord[];
    totalTokens: number;
    totalCostUSD: number;
    elapsedMs: number;
  };
}
```

…and must resolve to this:

```typescript
interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  modifications?: {
    toolArgs?: unknown;     // overridden tool arguments
    output?: string;        // overridden final text
    instructions?: string;  // appended to the system prompt
  };
}
```

When `approved: true` and `modifications` are set, the orchestrator merges them over the original action before proceeding. This is the path for "approve but with these changes" — the human edits tool args, the LLM judge rewrites the final answer, the webhook returns a sanitized version.

## Timeout policy

```typescript
hitl: {
  approvals: { beforeTool: ['delete-file'] },
  handler: hitl.webhook('https://approvals.example.com/decide'),
  timeoutMs: 60_000,
  onTimeout: 'reject',
}
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30_000` | Maximum wall-clock milliseconds the handler may take. |
| `onTimeout: 'reject'` | (default) | Treat timeout as denied — action blocked. |
| `onTimeout: 'approve'` | — | Treat timeout as approved — action proceeds. Use sparingly. |
| `onTimeout: 'error'` | — | Throw and halt the run. Use for hard SLAs where neither approve nor reject is acceptable on timeout. |

## Guardrail-override post-approval safety net

A handler that returns `approved: true` doesn't bypass content safety. After approval, the orchestrator runs the guardrails in `postApprovalGuardrails` against the tool call (or output) and vetoes the approval if any guardrail returns `action: 'block'`. This catches the case where a human (or LLM judge) approves something the runtime's automated guards know is destructive.

```typescript
hitl: {
  approvals: { beforeTool: ['delete-file'] },
  handler: hitl.llmJudge({ /* ... */ }),
  guardrailOverride: true,                            // default
  postApprovalGuardrails: ['pii-redaction', 'code-safety'], // default
}
```

Set `guardrailOverride: false` to disable the safety net and give the handler full autonomy. Default `true` is the right setting for production.

## Workflow `human` step

For typed-graph workflows, the `human` step suspends the graph until a decision payload arrives. The runtime checkpoints state before suspending so resumption is exact.

Source: [`step({ human })` in `WorkflowBuilder.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/builders/WorkflowBuilder.ts), node IR in [`src/orchestration/ir/types.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/ir/types.ts).

```typescript
import { workflow } from '@framers/agentos/orchestration';
import { z } from 'zod';

const reviewPipeline = workflow('review-pipeline')
  .input(z.object({ draft: z.string() }))
  .returns(z.object({ approvedDraft: z.string() }))

  // ... earlier GMI/tool steps that produce `result.draft` ...

  .step('human-review', {
    human: {
      prompt: 'Approve the draft, or paste an edited version.',
      autoAccept: false,
      autoReject: false,
      judge: {
        model: 'gpt-4o-mini',
        criteria: 'Approve unless the draft contains unverified claims or PII.',
        confidenceThreshold: 0.8,
      },
    },
    effectClass: 'human',
    outputAs: 'approvedDraft',
  })
  .compile({ deps: { /* host deps */ } });
```

Resolution modes (mutually exclusive — pick one):

| Mode | Behaviour |
|---|---|
| `autoAccept: true` | Resolve immediately as approved. Use in tests. |
| `autoReject: true` or `'reason string'` | Resolve immediately as rejected. Use for dry-run pipelines. |
| `judge: { ... }` | Route the decision through an LLM judge. Below `confidenceThreshold`, fall through to the normal human interrupt. |
| (none of the above) | Suspend the graph and emit an approval event. The host wakes the workflow with the decision payload. |

The `effectClass: 'human'` annotation is read by the workflow planner — it pessimistically schedules around human steps so the rest of the graph can advance maximally in parallel before stopping at the gate.

## Runtime `HumanInteractionManager`

Source: [`src/orchestration/hitl/HumanInteractionManager.ts`](https://github.com/framersai/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts) + interface [`IHumanInteractionManager`](https://github.com/framersai/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts).

This is the richer surface used by the planner and custom orchestrators. It speaks four interaction modes plus checkpoints and feedback ingestion:

```typescript
interface IHumanInteractionManager {
  requestApproval(action: PendingAction): Promise<ApprovalDecision>;
  requestClarification(request: ClarificationRequest): Promise<ClarificationResponse>;
  requestEdit(draft: DraftOutput): Promise<EditedOutput>;
  escalate(context: EscalationContext): Promise<EscalationDecision>;
  // ...checkpoint submission, feedback ingestion, status queries
}
```

`PendingAction` carries the dimensions a high-stakes approval needs: a severity level, a category, whether the action is reversible, potential consequences, and an estimated cost.

```typescript
type ActionSeverity = 'low' | 'medium' | 'high' | 'critical';

interface PendingAction {
  actionId: string;
  description: string;
  severity: ActionSeverity;
  category?: 'data_modification' | 'external_api' | 'financial'
           | 'communication'    | 'system'        | 'other';
  agentId: string;
  context: Record<string, unknown>;
  potentialConsequences?: string[];
  reversible: boolean;
  estimatedCost?: { amount: number; currency: string };
  alternatives?: AlternativeAction[];
  requestedAt: Date;
  timeoutMs?: number;
}
```

Escalation reasons (`EscalationReason`) cover the situations the agent should not decide unilaterally:

```typescript
type EscalationReason =
  | 'low_confidence'         | 'repeated_failures'
  | 'ethical_concern'        | 'out_of_scope'
  | 'resource_limit'         | 'conflicting_instructions'
  | 'safety_concern'         | 'user_requested'
  | 'policy_violation'       | 'unknown_territory';
```

…and escalation decisions return one of:

```typescript
type EscalationDecision =
  | { type: 'human_takeover'; instructions?: string }
  | { type: 'agent_continue'; guidance: string; adjustedParameters?: Record<string, unknown> }
  | { type: 'abort'; reason: string }
  | { type: 'delegate'; targetAgentId: string; instructions: string };
```

Wire a notification handler (`HITLNotificationHandler`) to surface new pending actions to whatever channel hosts your humans — a UI queue, a Slack channel, a PagerDuty incident, etc.

## Worked example — CLI handler (local dev)

```typescript
import { agency, hitl } from '@framers/agentos';

const writer = agency({
  provider: 'openai',
  model: 'gpt-4o-mini',
  agents: {
    drafter: { instructions: 'Draft a paragraph based on the user input.' },
  },
  hitl: {
    approvals: { beforeReturn: true },
    handler: hitl.cli(),
    timeoutMs: 60_000,
    onTimeout: 'reject',
  },
});

const result = await writer.generate('Why AgentOS uses cognitive memory.');
console.log(result.text);
```

Running from a terminal pauses before the draft is returned and prints:

```
[APPROVAL NEEDED] Final output for return to caller
Agent: drafter | Action: return
Type: output
Approve? (y/n):
```

Approve and the draft returns. Reject and the run ends with the timeout policy applied.

## Worked example — LLM judge with CLI fallback (production default)

```typescript
import { agency, hitl } from '@framers/agentos';

const guarded = agency({
  provider: 'openai',
  model: 'gpt-4o-mini',
  agents: {
    worker: {
      instructions: 'Execute requested tasks using the available tools.',
      // ...tools, etc.
    },
  },
  hitl: {
    approvals: {
      beforeTool: ['delete-file', 'send-email'],
      beforeReturn: true,
    },
    handler: hitl.llmJudge({
      model: 'gpt-4o-mini',
      criteria: 'Approve unless the action would delete user data, send a message externally, or spend more than $1.',
      confidenceThreshold: 0.8,
      fallback: hitl.cli(),
    }),
    guardrailOverride: true,
    postApprovalGuardrails: ['pii-redaction', 'code-safety'],
  },
});
```

Routing pattern: cheap judge handles low-risk approvals; the human only sees calls the judge can't confidently decide.

## Worked example — Slack notification

```typescript
import { agency, hitl } from '@framers/agentos';

const teamAgency = agency({
  provider: 'openai',
  model: 'gpt-4o-mini',
  agents: { worker: { instructions: 'Run the requested operation.' } },
  hitl: {
    approvals: { beforeTool: ['publish-blog-post'] },
    handler: hitl.slack({
      channel: '#approvals',
      token: process.env.SLACK_BOT_TOKEN!,
    }),
  },
});
```

The current Slack handler posts a formatted approval message to the channel and auto-approves after notifying. Reaction polling (`:white_check_mark:` / `:x:`) is planned; until then, treat Slack as an audit trail and combine it with a gating handler if you need to *wait* on the team:

```typescript
import type { HitlHandler } from '@framers/agentos';

const slackThenWebhook: HitlHandler = async (request) => {
  await hitl.slack({ channel: '#approvals', token: process.env.SLACK_BOT_TOKEN! })(request);
  return hitl.webhook('https://approvals.internal/decide')(request);
};
```

## Worked example — workflow `human` step

```typescript
import { workflow } from '@framers/agentos/orchestration';
import { z } from 'zod';

const draftThenReview = workflow('draft-then-review')
  .input(z.object({ topic: z.string() }))
  .returns(z.object({ finalDraft: z.string() }))
  .step('draft', { gmi: { instructions: 'Draft a 2-paragraph post on {{topic}}.' } })
  .step('review', {
    human: {
      prompt: 'Approve the draft (y) or paste an edited version.',
      autoAccept: false,
      judge: {
        model: 'gpt-4o-mini',
        criteria: 'Approve unless the draft contains unverified claims, PII, or marketing fluff.',
        confidenceThreshold: 0.8,
      },
    },
    effectClass: 'human',
    outputAs: 'finalDraft',
  })
  .compile({ deps: { /* host-provided runtime deps */ } });
```

For agencies that already use the higher-level `agency({ hitl: { approvals: { beforeReturn: true } } })`, prefer the agency-level surface — `workflow().step({ human })` is for explicit DAGs that mix LLM, non-LLM, and human nodes.

## Pitfalls

**`hitl.cli()` hangs in non-interactive environments.** It reads from `process.stdin`. In CI, serverless, or any environment without a TTY, the handler never resolves and the `onTimeout` policy fires after `timeoutMs`. Use `hitl.autoApprove()` in CI and `hitl.cli()` only locally.

**`hitl.slack(...)` auto-approves after notifying.** The current shipping behavior does NOT block on a reaction. Use it for audit, or wrap it in a webhook for blocking approval.

**`beforeEmergent: true` requires emergent to be enabled.** Setting `beforeEmergent: true` without `emergent: { enabled: true }` on the agency does nothing — there's no emergent path to gate. Pair the two.

**`postApprovalGuardrails` defaults to `['pii-redaction', 'code-safety']`.** If the guardrail packs aren't loaded into your runtime, the post-approval check silently passes. Verify the packs are wired (`@framers/agentos-extensions`) when you depend on the override.

**Workflow `human` step resolution modes are mutually exclusive.** Setting both `autoAccept: true` and `judge: {...}` resolves to whichever the runtime evaluates first (currently `autoAccept`). Pick one mode per node.

## FAQ

**Does `beforeReturn` block streaming?** Yes — when `beforeReturn: true`, the agency's `stream.finalTextStream` does not emit until the handler resolves. `stream.textStream` (raw live chunks) continues unaffected.

**Can a handler modify the action without rejecting it?** Yes. Return `{ approved: true, modifications: { toolArgs: { ... } } }` and the orchestrator merges those over the original tool arguments before invocation. Same for `output` (overrides the final text) and `instructions` (injected into the system prompt).

**Do agency callbacks (`approvalRequested`, `approvalDecided`) fire for workflow `human` steps?** No — those callbacks are on `AgencyCallbacks` and only fire for `HitlConfig`-driven pauses. Workflow `human` nodes emit graph events instead. Subscribe via `workflow.compile({ on: { ... } })`.

**Can the LLM judge see the full agent call history?** Yes. `ApprovalRequest.context.agentCalls` is the full record so far. The judge prompt receives it as part of the input.

## See also

- [Guardrails Usage](./GUARDRAILS_USAGE.md) — the post-approval guardrail safety net.
- [Agency API](../orchestration/AGENCY_API.md) — full `agency()` reference, including the `HitlConfig` field.
- [`workflow()` DSL](../orchestration/WORKFLOW_DSL.md) — typed-graph authoring with `human` steps.
- [Emergent Capabilities](../architecture/EMERGENT_CAPABILITIES.md) — how `beforeEmergent` gates `spawn_specialist`.
- [Streaming Semantics](../architecture/STREAMING_SEMANTICS.md) — how `beforeReturn` interacts with the streaming surfaces.
- [`src/api/hitl.ts`](https://github.com/framersai/agentos/blob/master/src/api/hitl.ts) — source for the six handler factories.
- [`src/api/types.ts`](https://github.com/framersai/agentos/blob/master/src/api/types.ts) — `HitlConfig`, `ApprovalRequest`, `ApprovalDecision`.
- [`src/orchestration/hitl/`](https://github.com/framersai/agentos/tree/master/src/orchestration/hitl) — runtime `HumanInteractionManager`.
