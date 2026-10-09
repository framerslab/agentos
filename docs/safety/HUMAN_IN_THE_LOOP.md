---
title: Human-in-the-Loop (HITL)
description: Five approval triggers, six handler factories (cli, slack, webhook, llmJudge, autoApprove, autoReject), the graph human node, and the runtime HumanInteractionManager. Pause AgentOS agent runs at any lifecycle event for human review.
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

Pause an agent run at specific lifecycle events, route the pending action to a human (or an LLM judge, or both), and resume with an approve / reject / modify decision. AgentOS exposes HITL on three integration surfaces: agency-level config, graph nodes, and a runtime manager. The agency config and the runtime manager share the `ApprovalRequest → handler → ApprovalDecision` shape; a graph's human node decides on its own options or suspends the run.

![Three-lane HITL architecture: Agency HitlConfig with 5 triggers and 6 handlers, the graph human node with autoAccept/autoReject/judge modes, and the runtime HumanInteractionManager with severity-aware PendingAction + escalation surface. All three converge on the ApprovalRequest → handler → ApprovalDecision → guardrail-override contract.](/img/diagrams/human-in-the-loop.svg)

## What HITL is in AgentOS

Three places HITL plugs in:

| Layer | Primitive | Source | Use when |
|---|---|---|---|
| **Agency** | [`HitlConfig`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) on `agency({ hitl: {...} })`; `agent()` accepts the field and does not read it | [`src/api/types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) | The host runs a multi-agent agency and wants declarative gates at specific lifecycle events (a tool name, the final return, a strategy override). |
| **Workflow / graph** | `humanNode({ prompt, autoAccept?, autoReject?, judge? })` in an `AgentGraph`; `workflow()`'s `step({ human: { prompt } })` | [`src/orchestration/builders/nodes.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts) + [`src/orchestration/runtime/NodeExecutor.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/runtime/NodeExecutor.ts) | The host owns an explicit graph and wants a node that suspends the run until the host resumes it. |
| **Runtime** | [`HumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts) implementing [`IHumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts) | [`src/orchestration/hitl/`](https://github.com/framerslab/agentos/tree/master/src/orchestration/hitl) | A subsystem (planner, custom orchestrator, evaluator) needs severity-aware approval with clarification, edit, and escalation flows in addition to approve/reject. |

The agency-level surface is what most apps need. Reach for a human node when you're already authoring a graph. Reach for the runtime manager when you need the full clarification/edit/escalation vocabulary outside of an `agency()` run.

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
| `beforeTool: string[]` | Any tool whose name appears in the list (`'*'`: every tool), on every tool loop of the agency's seats and nested agencies, after `onBeforeToolExecution` has run | Destructive or high-cost tool calls (`delete-file`, `send-email`, `purchase`). |
| `beforeAgent: string[]` | Any agent in the agency whose name appears in the list | Specialists that should only run after human go-ahead (`billing-agent`, `legal-review`). |
| `beforeEmergent: boolean` | Runtime synthesis of a new specialist via `spawn_specialist` | Production agencies that allow emergent capabilities but require approval before the roster grows. |
| `beforeReturn: boolean` | The final answer leaves the agency | Customer-facing channels where the last response gets a human or judge review. |
| `beforeStrategyOverride: boolean` | Nothing: no strategy makes a `strategy-override` request. Like every trigger, setting it makes `agency()` require a `handler` | Reserved; set it and nothing pauses. |

Source: [`HitlConfig.approvals` in `src/api/types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts).

## Six handler factories

The [`hitl`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) namespace exports six ready-to-use handler factories. Each returns a [`HitlHandler`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) (an async function taking [`ApprovalRequest`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) and resolving to [`ApprovalDecision`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts)), so you compose them by wrapping in your own function when you need logging, fallback chains, or conditional routing.

Source: [`src/api/hitl.ts`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts).

### `hitl.cli()`

Interactive terminal prompt. Reads from `process.stdin`. Before it asks, it prints the request's description, agent, action, type and details; for a tool call the details hold the arguments the tool will run with, so the approver sees the recipient, the path or the query being approved. Use locally and in interactive scripts; **not safe for CI or serverless**.

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

POSTs the [`ApprovalRequest`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) as JSON to your endpoint and reads back an [`ApprovalDecision`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts). Non-2xx is treated as rejection with the status code as the reason. Use this when you have an in-house approval service.

```typescript
handler: hitl.webhook('https://approvals.example.com/decide');
```

### `hitl.slack({ channel, token })`

Posts the request to a Slack channel and **approves it at once**. The message asks for a `:white_check_mark:` or `:x:` reaction, and the handler reads none. Use it as an audit trail, and pair it with a handler that decides when the team must answer.

```typescript
handler: hitl.slack({ channel: '#approvals', token: process.env.SLACK_BOT_TOKEN! });
```

### `hitl.llmJudge({ ... })`

Delegates the decision to a model (OpenAI and the central judge model by default). The judge replies with a structured `{approved, confidence, reasoning}` JSON object. When `confidence < confidenceThreshold` (default `0.7`), the reply lacks those fields, or the call fails, the request goes to the `fallback` handler, which rejects by default. The judge sees the request's type, agent, action, description and details.

```typescript
handler: hitl.llmJudge({
  model: 'gpt-4o-mini',
  criteria: 'Approve unless the action would delete data, send messages externally, or spend more than $1.',
  confidenceThreshold: 0.8,
  fallback: hitl.cli(),
});
```

This is the recommended production default for agencies where most actions are low-risk: a cheap judge auto-handles the easy majority, the human only sees what the judge isn't confident about.

## The [`ApprovalRequest`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) / [`ApprovalDecision`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) contract

Source: [`ApprovalRequest` + `ApprovalDecision` in `src/api/types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts).

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
    toolArgs?: unknown;     // never applied: a beforeTool approval that carries it is refused
    output?: string;        // replaces the final text (beforeReturn)
    instructions?: string;  // added to the agent's input (beforeAgent)
  };
}
```

When `approved: true` and `modifications` are set, the orchestrator applies them before proceeding. This is the path for "approve but with these changes": `output` on a `beforeReturn` approval replaces the final text (the LLM judge rewrites the final answer, the webhook returns a sanitized version), and `instructions` on a `beforeAgent` approval are added to the input of the agent it lets run, under the sequential, parallel and hierarchical strategies. Tool arguments are the exception. A `beforeTool` approval approves or refuses the arguments the call will run with; it never applies `modifications.toolArgs`, and it refuses an approval that carries them (anything but `undefined` or `null`), so the call is skipped rather than run with the arguments the approver meant to replace. Rewrite tool arguments in `onBeforeToolExecution`, which runs before the handler is asked.

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

After a `beforeTool` or `beforeReturn` approval, `agency()` runs built-in pattern checks named by `postApprovalGuardrails` over the tool's name and arguments (or the final text) and vetoes the approval when one matches. These are fixed checks inside `agency()`, not the guardrail extension packs: `code-safety` looks for destructive commands and statements (`rm -rf /`, `mkfs.`, `dd ... of=/dev`, `DROP TABLE`, `TRUNCATE TABLE`, `chmod -R 777 /`, `shutdown` and others), `pii-redaction` for unredacted SSNs and card numbers, and any other id passes. A veto fires `guardrailHitlOverride` and skips the tool, or, for the final output, rejects `generate()` with an `AgencyConfigError`. This catches the case where a human (or LLM judge) approves something destructive.

```typescript
hitl: {
  approvals: { beforeTool: ['delete-file'] },
  handler: hitl.llmJudge({ /* ... */ }),
  guardrailOverride: true,                            // default
  postApprovalGuardrails: ['pii-redaction', 'code-safety'], // default
}
```

Set `guardrailOverride: false` to disable the safety net and give the handler full autonomy. Default `true` is the right setting for production.

## Graph `human` nodes

A human node suspends a graph run until the host resumes it. `workflow()` lowers `step('id', { human: { prompt } })` to `humanNode({ prompt, timeout })`: the step takes a prompt and the step's `timeout`, and nothing else, so it always suspends. The resolution modes below are options of [`humanNode()`](https://github.com/framerslab/agentos/blob/master/src/orchestration/builders/nodes.ts), which an [`AgentGraph`](../architecture/AGENT_GRAPH.md) takes as a node.

```typescript
import { humanNode } from '@framers/agentos/orchestration';

graph.addNode('human-review', humanNode({
  prompt: 'Approve the draft, or reject it with a reason.',
  judge: {
    model: 'gpt-4o-mini',
    criteria: 'Approve unless the draft contains unverified claims or PII.',
    confidenceThreshold: 0.8,
  },
}));
```

Resolution modes, checked in this order:

| Mode | Behaviour |
|---|---|
| `autoAccept: true` | Resolve at once as approved. Use in tests. |
| `autoReject: true` or `'reason string'` | Resolve at once as rejected. Use for dry-run pipelines. |
| `judge: { model?, provider?, criteria?, confidenceThreshold? }` | Ask a model for `{ approved, confidence, reasoning }`. At or above `confidenceThreshold` (default `0.7`) its decision stands; below it, or when the call fails, the node suspends as with no mode. |
| (none of the above) | Suspend: the runtime saves a checkpoint and emits an `interrupt` event. |

After an approval that no human gave (auto-accept, the judge, or `onTimeout: 'accept'`), the node runs the guardrail ids `pii-redaction` and `code-safety` through the graph's `deps.guardrailEngine` when one is wired, and a block turns the decision into `approved: false`; `guardrailOverride: false` turns that off.

`resume(checkpointId)` marks a suspended human node complete with its recorded output (`{ prompt }`). A host that has the human's answer writes it into the state with the checkpoint store's `fork(checkpointId, patch)` and resumes the fork ([Checkpointing](../orchestration/CHECKPOINTING.md)). Every human node has the effect class `human`, so on resume a node whose output is recorded is not run again.

## Runtime [`HumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts)

Source: [`src/orchestration/hitl/HumanInteractionManager.ts`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts) + interface [`IHumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts).

This is the richer surface of the full runtime: pass one as `hitlManager` in the `AgentOS` config and, with `toolOrchestratorConfig.hitl.enabled`, its `ToolOrchestrator` asks `requestApproval()` before a tool with `hasSideEffects: true` runs; the emergent step gate asks it before a composed tool's side-effecting step. Custom orchestrators can call it too. It speaks four interaction modes plus checkpoints and feedback ingestion:

```typescript
interface IHumanInteractionManager {
  requestApproval(action: PendingAction): Promise<ApprovalDecision>;
  requestClarification(request: ClarificationRequest): Promise<ClarificationResponse>;
  requestEdit(draft: DraftOutput): Promise<EditedOutput>;
  escalate(context: EscalationContext): Promise<EscalationDecision>;
  // ...checkpoint submission, feedback ingestion, status queries
}
```

[`PendingAction`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts) carries the dimensions a high-stakes approval needs: a severity level, a category, whether the action is reversible, potential consequences, and an estimated cost.

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

Escalation reasons ([`EscalationReason`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts)) cover the situations the agent should not decide unilaterally:

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

Wire a notification handler ([`HITLNotificationHandler`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/IHumanInteractionManager.ts)) to surface new pending actions to whatever channel hosts your humans — a UI queue, a Slack channel, a PagerDuty incident, etc.

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
[APPROVAL NEEDED] Approve the final agency response before returning it.
Agent: __agency__ | Action: return
Type: output
Details: { output: '<the drafted paragraph>' }
Approve? (y/n):
```

The agent line names the agency (`__agency__` when it has no `name`), and the details hold the draft being approved. Approve and the draft returns. Answer `n`, or nothing within the 60 seconds of `timeoutMs` (`onTimeout: 'reject'`), and `generate()` rejects with an `AgencyConfigError` whose message starts `Final output rejected by HITL`.

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

The Slack handler posts the approval message to the channel and approves at once; it reads no reactions. Treat Slack as an audit trail and combine it with a gating handler when you need to *wait* on the team:

```typescript
import type { HitlHandler } from '@framers/agentos';

const slackThenWebhook: HitlHandler = async (request) => {
  await hitl.slack({ channel: '#approvals', token: process.env.SLACK_BOT_TOKEN! })(request);
  return hitl.webhook('https://approvals.internal/decide')(request);
};
```

## Worked example — a graph `human` node

```typescript
import { AgentGraph, START, END, gmiNode, humanNode } from '@framers/agentos/orchestration';
import { z } from 'zod';

const draftThenReview = new AgentGraph({
  input: z.object({ topic: z.string() }),
  scratch: z.object({}),
  artifacts: z.object({}),
})
  .addNode('draft', gmiNode({ instructions: 'Draft a 2-paragraph post on the topic.' }))
  .addNode('review', humanNode({
    prompt: 'Approve the draft (yes/no).',
    judge: {
      model: 'gpt-4o-mini',
      criteria: 'Approve unless the draft contains unverified claims, PII, or marketing fluff.',
      confidenceThreshold: 0.8,
    },
  }))
  .addEdge(START, 'draft')
  .addEdge('draft', 'review')
  .addEdge('review', END)
  .compile({ deps: { /* host bindings: loopController, providerCall, guardrailEngine */ } });
```

For agencies that already use the higher-level `agency({ hitl: { approvals: { beforeReturn: true } } })`, prefer the agency-level surface; a human node is for explicit graphs that mix LLM, non-LLM, and human nodes.

## Pitfalls

**`hitl.cli()` hangs in non-interactive environments.** It reads from `process.stdin`. In CI, serverless, or any environment without a TTY, the handler never resolves and the `onTimeout` policy fires after `timeoutMs`. Use `hitl.autoApprove()` in CI and `hitl.cli()` only locally.

**`hitl.slack(...)` approves after notifying.** It does not wait for a reaction. Use it for audit, or wrap it in a webhook for blocking approval.

**`beforeEmergent: true` requires emergent to be enabled.** Setting `beforeEmergent: true` without `emergent: { enabled: true }` on the agency does nothing — there's no emergent path to gate. Pair the two.

**`postApprovalGuardrails` names built-in checks, not loaded guardrails.** The two ids it knows are `code-safety` and `pii-redaction` (the default list); any other id passes without a check, and the guardrail packs registered with a runtime are not consulted.

**A human node's resolution modes are checked in a fixed order.** `autoAccept` first, then `autoReject`, then `judge`: a node with `autoAccept: true` and a `judge` never asks the judge. Pick one mode per node.

## FAQ

**Does `beforeReturn` block streaming?** Yes — when `beforeReturn: true`, the agency's `stream.finalTextStream` does not emit until the handler resolves. `stream.textStream` (raw live chunks) continues unaffected.

**Can a handler modify the action without rejecting it?** For the final answer and for an agent run, yes. Return `{ approved: true, modifications: { output: '...' } }` from a `beforeReturn` approval to replace the final text, or `{ approved: true, modifications: { instructions: '...' } }` from a `beforeAgent` approval to add instructions to that agent's input. For a tool call, no: a `beforeTool` approval does not apply `modifications.toolArgs`, and it refuses an approval that carries them, so a handler that redacts or redirects an argument gets a skipped call, never the original one. Rewrite tool arguments in `onBeforeToolExecution`, which runs before the handler is asked.

**Do agency callbacks (`approvalRequested`, `approvalDecided`) fire for graph human nodes?** No — those callbacks are on [`AgencyCallbacks`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) and only fire for [`HitlConfig`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts)-driven pauses. A human node that suspends yields an `interrupt` event on the compiled graph's `stream()`.

**Can the LLM judge see the full agent call history?** No. The request carries it in `ApprovalRequest.context.agentCalls`, but `hitl.llmJudge()` sends the judge only the request's type, agent, action, description and details. A handler of your own can read `context` and pass it on.

## See also

- [Guardrails Usage](./GUARDRAILS_USAGE.md) — the post-approval guardrail safety net.
- [Agency API](../orchestration/AGENCY_API.md) — full `agency()` reference, including the [`HitlConfig`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) field.
- [`workflow()` DSL](../orchestration/WORKFLOW_DSL.md) and [AgentGraph](../architecture/AGENT_GRAPH.md) — graphs with human nodes.
- [Emergent Capabilities](../architecture/EMERGENT_CAPABILITIES.md) — how `beforeEmergent` gates `spawn_specialist`.
- [Streaming Semantics](../architecture/STREAMING_SEMANTICS.md) — how `beforeReturn` interacts with the streaming surfaces.
- [`src/api/hitl.ts`](https://github.com/framerslab/agentos/blob/master/src/api/hitl.ts) — source for the six handler factories.
- [`src/api/types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) — [`HitlConfig`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts), `ApprovalRequest`, `ApprovalDecision`.
- [`src/orchestration/hitl/`](https://github.com/framerslab/agentos/tree/master/src/orchestration/hitl) — runtime [`HumanInteractionManager`](https://github.com/framerslab/agentos/blob/master/src/orchestration/hitl/HumanInteractionManager.ts).
