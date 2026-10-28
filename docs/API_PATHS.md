# Two API paths: lightweight agents and the runtime

AgentOS exposes two ways to run a model, and they do not share a runtime. The lightweight path is a set of functions over a provider call; the runtime path is a server-shaped process that owns a Generalized Mind Instance (GMI) per session. Between them, `agent({ runtime: 'gmi' })` keeps the lightweight `agent()` surface and serves each session with a GMI built in process. Options are named the same on all of them, and the capability contract says what each of its four surfaces (`agent`, `generation` for `generateText()` and `streamText()`, `runtime`, and `gmi` for `agent({ runtime: 'gmi' })` and `gmi()`) does with each one.

## The lightweight path

- [`generateText()`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts) and [`streamText()`](https://github.com/framerslab/agentos/blob/master/src/api/streamText.ts) resolve a provider from the model string and the environment keys ([`resolveProvider`](https://github.com/framerslab/agentos/blob/master/src/api/model.ts), [`createProviderManager`](https://github.com/framerslab/agentos/blob/master/src/api/model.ts)), run the tool loop up to `maxSteps` (one by default), and walk a policy-aware fallback chain when a provider fails ([`buildPolicyAwareFallbackChain`](https://github.com/framerslab/agentos/blob/master/src/api/generateText.ts)).
- [`agent()`](https://github.com/framerslab/agentos/blob/master/src/api/agent.ts) adds a system prompt assembled from instructions, an optional soul file and the personality description, named sessions with their own history, tools, hooks and usage ledgers. Memory enters as hooks (`memoryProvider.getContext` before the call, `observe` after it). Without `runtime: 'gmi'`, no GMI is created on this path.
- [`agency()`](https://github.com/framerslab/agentos/blob/master/src/api/agency.ts) coordinates a roster of agents with one of six strategies (see [Agencies and orchestration strategies](./AGENCIES.md)).

## GMIs from agent()

`agent({ runtime: 'gmi' })` returns [`gmi(opts)`](https://github.com/framerslab/agentos/blob/master/src/api/gmi.ts), also exported as `gmi()` and `createGmi()`. It keeps the `agent()` options and the `Agent` surface, and serves each session with a GMI built in process from them, with no `AgentOS` runtime: a persona from the system prompt `agent()` sends and the `personality` traits, the agent's tools, a completion gateway built from its provider and fallback options, and, as its `cognition` profile sets them, cognitive memory, sentiment tracking and metaprompts. The session store holds the history; `generate()` and `stream()` run one turn on a GMI built for that call. `rag`, `discovery`, `guardrails`, `security`, `permissions`, `hitl`, `emergent`, `output` and `provenance` are accepted with a warning and not applied, and `voice`, `avatar` and `channels` throw at construction when set (a config that sets only `enabled: false` is not). [GMIs from agent()](./GMI.md#gmis-from-agent) describes the path.

## The runtime path

[`AgentOS.create()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) builds the runtime and [`processRequest()`](https://github.com/framerslab/agentos/blob/master/src/api/AgentOS.ts) serves each session with a GMI: a persona, a mood, a reasoning trace, sentiment-triggered metaprompts, a memory bridge when cognitive memory is attached, and the runtime's guardrails, capability discovery, retrieval, emergent tools, tool permission checks, human-in-the-loop and channels. The runtime's GMIs call the provider of the turn's model directly, with no fallback chain; a host that builds a GMI itself can give it a completion gateway, which routes each model step and falls back across providers ([Model calls through a completion gateway](./GMI.md#model-calls-through-a-completion-gateway)). [Generalized Mind Instances](./GMI.md) describes the GMI; [The turn lifecycle](./TURN_LIFECYCLE.md) describes what a request goes through. Both GMI paths take a `learning` option, off by default: with it on, every GMI sends its persona's personality section as a system prompt of its own on every turn and binds each session to a learner ([Learning](./GMI.md#learning)).

## The capability contract

[`capabilityContract.ts`](https://github.com/framerslab/agentos/blob/master/src/api/runtime/capabilityContract.ts) records, per option, what each surface does with it:

| Option | `agent` | `generation` | `runtime` | `gmi` |
|---|---|---|---|---|
| `tools` | enforced | enforced | enforced | enforced |
| `memory` | partially enforced | runtime only | enforced | enforced |
| `rag` | accepted but deferred | runtime only | enforced | accepted but deferred |
| `discovery` | accepted but deferred | runtime only | enforced | accepted but deferred |
| `guardrails` | accepted but deferred | partially enforced | enforced | accepted but deferred |
| `security` | accepted but deferred | accepted but deferred | accepted but deferred | accepted but deferred |
| `permissions` | accepted but deferred | accepted but deferred | accepted but deferred | accepted but deferred |
| `hitl` | accepted but deferred | runtime only | enforced | accepted but deferred |
| `emergent` | accepted but deferred | runtime only | enforced | accepted but deferred |
| `voice` | partially enforced | runtime only | accepted but deferred | runtime only |
| `channels` | accepted but deferred | runtime only | enforced | runtime only |
| `output` | accepted but deferred | runtime only | enforced | accepted but deferred |
| `provenance` | accepted but deferred | runtime only | enforced | accepted but deferred |
| `observability` | partially enforced | partially enforced | enforced | partially enforced |
| `controls` | partially enforced | runtime only | enforced | partially enforced |

No surface acts on `security` or `permissions`: AgentOS ties no policy to a security tier and applies none of the permission fields ([`types.ts`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts), `SecurityTier` and `PermissionsConfig`), so the contract marks both deferred on every surface. `agent()`, `gmi()` and `agency()` accept them; the options of `generateText()` and `streamText()` and the runtime's `AgentOSConfig` do not declare them. To gate tools, use `hitl.approvals.beforeTool` on `agency()` or an `onBeforeToolExecution` hook; the full runtime's tool permission checks are set through its own `toolPermissionManagerConfig`.

`agent()` and `gmi()` each log one warning naming the options set that their surface accepts but defers, and `gmi()` throws at construction for `voice` and `channels` (and for `avatar`, which the contract does not list), unless the config sets only `enabled: false`. The default runtime reads a `memory.working` callback once per session send and prepends its text to the configured system text; other memory settings remain deferred and produce a warning. `agent()` applies voice only through a configured `voice.session` binding, which its `voiceSession()` method starts; other voice fields remain deferred and produce a warning, and the full runtime reads no voice field. `agent()` without `runtime: 'gmi'` and `agency()` warn when they receive a `cognitiveMechanisms` config, because they run no cognitive memory manager; with `runtime: 'gmi'` and memory on, the memory manager runs the mechanisms.

## Choosing

Use the lightweight path for a call, a session with tools, or a roster of agents over one request. Use `agent({ runtime: 'gmi' })` when an agent's sessions need a persona, mood, sentiment-triggered metaprompts or cognitive memory in process, without the runtime's guardrails, retrieval and channels. Use the runtime when the agent must sit behind guardrails and channels, retrieve from a corpus, forge tools, or serve personas loaded from definitions.
