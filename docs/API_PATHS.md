# Two API paths: lightweight agents and the runtime

AgentOS exposes two ways to run a model, and they do not share a runtime. The lightweight path is a set of functions over a provider call; the runtime path is a server-shaped process that owns a Generalized Mind Instance (GMI) per session. Options are named the same on both, and the capability contract says what each of its three surfaces (`agent`, `generation` for `generateText()` and `streamText()`, and `runtime`) does with each one.

## The lightweight path

- [`generateText()`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts) and [`streamText()`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts) resolve a provider from the model string and the environment keys ([`resolveProvider`](https://github.com/framerslab/agentos/blob/master/src/api/model.ts), [`createProviderManager`](https://github.com/framerslab/agentos/blob/master/src/api/model.ts)), run the tool loop up to `maxSteps` (one by default), and walk a policy-aware fallback chain when a provider fails ([`buildPolicyAwareFallbackChain`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts)).
- [`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) adds a system prompt assembled from instructions, an optional soul file and the personality description, named sessions with their own history, tools, hooks and usage ledgers. Memory enters as hooks (`memoryProvider.getContext` before the call, `observe` after it). No GMI is created on this path.
- [`agency()`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts) coordinates a roster of agents with one of six strategies (see [Agencies and orchestration strategies](./AGENCIES.md)).

## The runtime path

[`AgentOS.create()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) builds the runtime and [`processRequest()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) serves each session with a GMI: a persona, a mood, a reasoning trace, sentiment-triggered metaprompts, a memory bridge when cognitive memory is attached, and the runtime's guardrails, capability discovery, retrieval, emergent tools, permissions, human-in-the-loop and channels. [Generalized Mind Instances](./GMI.md) describes the GMI; [The turn lifecycle](./TURN_LIFECYCLE.md) describes what a request goes through.

## The capability contract

[`capabilityContract.ts`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/capabilityContract.ts) records, per option, what each surface does with it. The lightweight `agent()` enforces `tools`, partially enforces `memory`, `observability` and `controls`, and accepts but defers `rag`, `discovery`, `guardrails`, `security`, `permissions`, `hitl`, `emergent`, `voice`, `channels`, `output` and `provenance`; the runtime enforces all of them. On the `generation` surface, `tools` is enforced, `guardrails`, `permissions` and `observability` are partially enforced, and the rest are runtime-only. `agent()` and `agency()` warn when they receive a `cognitiveMechanisms` config, because the lightweight helpers do not run the cognitive mechanisms.

## Choosing

Use the lightweight path for a call, a session with tools, or a roster of agents over one request. Use the runtime when the agent must keep a persona and mood across the turns of a session, run the memory bridge and metaprompts, forge tools, or sit behind guardrails and channels.
