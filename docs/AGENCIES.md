# Agencies and orchestration strategies

[`agency()`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts) returns an `Agent` that coordinates a roster. Each roster member is an agent config or a built `Agent` (so an agency can hold another agency), and a strategy decides who runs when. The strategies are compiled from [`src/api/runtime/strategies`](https://github.com/framerslab/agentos/tree/master/src/api/runtime/strategies).

| Strategy | What it does |
|---|---|
| `sequential` | Members run one after another; each receives the output of the one before. |
| `parallel` | Members run at the same time on the same prompt; a synthesizer built from the agency's own `model` or `provider` merges their outputs, leaving out a member that failed. |
| `debate` | Members argue over `maxRounds` rounds (3 by default); in each round every member sees every prior argument; a synthesizer built from the agency's own `model` or `provider` distils the result. N members over R rounds cost N×R calls plus one. |
| `review-loop` | The first member produces or revises, the second reviews and answers `{ "approved": true or false, "feedback": "..." }`; the loop runs until approval or `maxRounds` (3 by default); a reply that is not valid JSON counts as not approved. |
| `hierarchical` | A manager sees every member as a `delegate_to_<name>` tool and decides what to delegate and in what order; with `emergent.enabled` on the agency, it can also call `spawn_specialist`. |
| `graph` | Members declare `dependsOn`; the strategy sorts the roster topologically, runs each topological tier concurrently (a member waits for its whole previous tier) and feeds each the outputs of its predecessors. |

`parallel` and `debate` need `model` or `provider` on the agency itself; compiling either without one throws `AgencyConfigError`. On the `parallel` strategy, a `quorum` can require a minimum number of successful agents and of distinct providers; `onShortfall: 'proceed'` turns a shortfall into a warning, and the default throws. `agency().session()` keeps per-session message history and usage totals only. `agency()` warns when it receives `cognitiveMechanisms`, which the lightweight helper does not run. At the agency level it applies `guardrails` (input guardrails on the prompt, output guardrails on the result, both skipped with a warning when the guardrail packs are not installed), `rag` (with a `vectorStore`, retrieved chunks are prepended to the prompt), `output`, the `hitl` approval gates, `provenance` and, on `hierarchical` (or with `adaptive: true`), `emergent`. `voice.enabled` attaches a `listen()` method that takes JSON text frames over a local WebSocket, and `channels` attaches a `connect()` that always rejects. `agency()` builds no shared memory store; members share only what the strategy passes between them.

Fixed pipelines with explicit stages belong to the mission and workflow compilers ([Orchestration Guide](./orchestration/ORCHESTRATION.md), [mission() API](./orchestration/MISSION_API.md), [workflow() DSL](./orchestration/WORKFLOW_DSL.md)); the roster API is documented in [Multi-Agent Agency API](./orchestration/AGENCY_API.md).
