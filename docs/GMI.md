---
description: "What a Generalized Mind Instance actually is, what it isn't, and how its parts connect — verified against the AgentOS source, not the homepage diagram."
---

# Generalized Mind Instances (GMIs)

A **Generalized Mind Instance** — GMI — is the unit of agent state in AgentOS. Each GMI owns a persona, a working memory buffer, a cognitive-memory layer with personality-modulated encoding and Ebbinghaus decay, a sentiment tracker that follows the user's mood across turns, a metaprompt executor that assembles the system prompt fresh each turn from current state, and a reasoning trace covering the last several hundred decision steps. Construct one with `agent({...})`; address it with `.session(id).send(...)`. The GMI persists across calls — `session()` history, memory traces, and trait state all survive between turns.

![GMI architecture: a thin coordinator class that delegates per-turn work to four close collaborators (ConversationHistoryManager, CognitiveMemoryBridge, SentimentTracker, MetapromptExecutor) and seven injected services (WorkingMemory, PromptEngine, ToolOrchestrator, LLMProviderManager, UtilityAI, CognitiveMemoryManager, optional RetrievalAugmentor). The GMI core itself owns persona, current mood, user context, task context, and reasoning trace, but never does retrieval, generation, or tool dispatch directly.](/img/diagrams/gmi-architecture.svg)

This page is an honest tour of the abstraction. Most descriptions of GMIs you'll see — including the concentric-ring diagram on [agentos.sh](https://agentos.sh) — are presentation. The presentation is useful but it isn't the architecture. The architecture is a delegation pattern: a coordinator class with a dozen specialized collaborators, each owning one concern. Below is what's actually in the source tree at [`packages/agentos/src/cognition/substrate/GMI.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMI.ts).

## The shortest useful example

```typescript
import { agent } from '@framers/agentos';

const analyst = agent({
  provider: 'anthropic',
  instructions: 'You are a thorough research analyst.',
  personality: {
    conscientiousness: 0.95,
    openness: 0.85,
    agreeableness: 0.7,
  },
  memory: { enabled: true, consolidation: true },
  guardrails: ['pii-redaction', 'grounding-guard'],
});

const session = analyst.session('research-q1');
const reply = await session.send(
  'Analyze Q1 market trends in AI infrastructure.'
);
console.log(reply.text);
```

Three things to notice:

1. **`agent()` is the constructor.** The same factory builds a single chat companion or a multi-agent orchestrator — the difference is configuration, not class hierarchy.
2. **`personality` is HEXACO-shaped but plainly implemented.** The six fields (`honesty`, `emotionality`, `extraversion`, `agreeableness`, `conscientiousness`, `openness`) are 0-to-1 scalars. The runtime encodes them as a human-readable trait string and appends it to the system prompt. There is no separate "personality model" running underneath. The cognitive memory mechanisms (covered below) read three of those values directly and modulate their behavior.
3. **`session()` is where state lives.** Multiple sessions on the same agent maintain independent histories. Sessions are how a GMI talks to two users at once without cross-contamination.

## What a GMI is composed of

The class definition tells the cleanest story. From [`GMI.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMI.ts) (trimmed):

```typescript
export class GMI implements IGMI {
  public readonly gmiId: string;
  public readonly creationTimestamp: Date;

  // Injected dependencies
  private workingMemory!: IWorkingMemory;
  private promptEngine!: IPromptEngine;
  private retrievalAugmentor?: IRetrievalAugmentor;
  private toolOrchestrator!: IToolOrchestrator;
  private llmProviderManager!: AIModelProviderManager;
  private utilityAI!: IUtilityAI;
  private cognitiveMemory?: ICognitiveMemoryManager;

  // State
  private state: GMIPrimeState;
  private currentGmiMood: GMIMood;
  private currentUserContext!: UserContext;
  private currentTaskContext!: TaskContext;
  private reasoningTrace: ReasoningTrace;

  // Collaborators
  private conversationHistoryManager: ConversationHistoryManager;
  private memoryBridge: CognitiveMemoryBridge | null = null;
  private sentimentTracker!: SentimentTracker;
  private metapromptExecutor!: MetapromptExecutor;
  // ...
}
```

Each name is doing one specific thing:

| Collaborator | What it owns |
|---|---|
| [`ConversationHistoryManager`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/ConversationHistoryManager.ts) | The turn buffer for the active session. Compacts old turns when the window fills. |
| [`CognitiveMemoryBridge`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/CognitiveMemoryBridge.ts) | The connection to long-term cognitive memory: encoding new traces, fetching old ones, applying decay. |
| [`SentimentTracker`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/SentimentTracker.ts) | Analyzes user sentiment per turn and fires [`GMIEvent`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMIEvent.ts)s when patterns cross thresholds — those events trigger event-based metaprompt updates. |
| [`MetapromptExecutor`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/MetapromptExecutor.ts) | Assembles the system prompt every turn from persona, traits, mood, retrieved memories, and active skills. |
| [`IPromptEngine`](https://github.com/framersai/agentos/blob/master/src/core/llm/IPromptEngine.ts) | Interpolates messages and tool schemas into the final wire-format payload for the LLM. |
| [`IToolOrchestrator`](https://github.com/framersai/agentos/blob/master/src/core/tools/IToolOrchestrator.ts) | Decides which tools to expose this turn, runs them, returns results. |
| [`IRetrievalAugmentor`](https://github.com/framersai/agentos/blob/master/src/cognition/rag/IRetrievalAugmentor.ts) | RAG retrieval over corpora that aren't memory (docs, web search, etc.). |
| [`AIModelProviderManager`](https://github.com/framersai/agentos/blob/master/src/core/llm/providers/AIModelProviderManager.ts) | Routes the call to the configured provider, with fallback to others on failure. |
| [`IUtilityAI`](https://github.com/framersai/agentos/blob/master/src/cognition/nlp/ai_utilities/IUtilityAI.ts) | Smaller model jobs that don't need the main provider — JSON parsing, summarization, observations. |
| [`ICognitiveMemoryManager`](https://github.com/framersai/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) | The actual memory store with the eight cognitive mechanisms (next section). |

Lifecycle is owned by [`GMIManager`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMIManager.ts) — it constructs GMIs, hands them their persona and config, tracks active instances by ID, and routes session-to-GMI mappings. When you build an agency of multiple GMIs, the manager is the registry that knows which mind owns which session.

## The eight cognitive memory mechanisms

This is where the runtime stops looking like a thin wrapper around a chat API. From [`src/memory/mechanisms/defaults.ts`](https://github.com/framersai/agentos/blob/master/src/memory/mechanisms/defaults.ts), the eight mechanisms that operate on memory traces:

| Mechanism | What it does |
|---|---|
| **Reconsolidation** | Memories drift slightly each time they are recalled. The drift rate (default 0.05, capped at 0.4 per trace) is bounded so high-importance traces stay anchored. |
| **Retrieval-induced forgetting** | When a memory surfaces during retrieval, related-but-not-recalled memories get suppressed (similarity threshold 0.7, suppression 0.12, max 5 per query). Models the well-known psychological effect. |
| **Involuntary recall** | A small probability (default 0.08) that an old, related memory surfaces unprompted during a turn. Requires the trace to be at least 14 days old and above a minimum strength. |
| **Metacognitive feeling-of-knowing** | Surfaces "tip-of-the-tongue" partial activations: the GMI knows there's something relevant in memory even when it can't fully retrieve it. |
| **Temporal gist** | Old traces (60+ days, 2+ retrievals) collapse into compressed gist representations. Entities and emotional context are preserved; specific wording is not. |
| **Schema encoding** | New observations cluster against existing schema. Novel observations get a 1.3× encoding boost; congruent ones get a 0.85× discount. The runtime spends more strength on what surprises it. |
| **Source-confidence decay** | Different memory sources decay at different rates: a user statement holds at 1.0×, agent inference at 0.8×, reflection at 0.75×. The GMI trusts its own confabulations less over time than what the user explicitly said. |
| **Emotion regulation** | Reappraisal (rate 0.15) and suppression (above arousal 0.8) of emotionally loaded memories. Capped at 10 regulations per cycle so the GMI doesn't smooth out everything in one pass. |

All eight default to enabled. Pass `cognitiveMechanisms: {}` for defaults, or override per mechanism. Three of them — emotionality, conscientiousness, openness — are HEXACO-modulated: a more conscientious GMI consolidates more aggressively, a more open one weighs novelty harder, a more emotional one allows more involuntary recall.

The Ebbinghaus decay curve sits underneath all of this as the base decay model. The mechanisms above shape *what* gets stored, *what* gets forgotten preferentially, and *how confident* the GMI is in what it remembers. The decay rate is what determines *when*.

## Retrieval is layered, not just embedding similarity

When a GMI needs to remember something, it doesn't run a single nearest-neighbor query. From [`CognitiveMemoryManager.retrieve()`](https://github.com/framersai/agentos/blob/master/src/memory/CognitiveMemoryManager.ts):

1. **(Optional) HyDE hypothesis.** When `options.hyde` is on (or the active policy says always), [`MemoryHydeRetriever`](https://github.com/framersai/agentos/blob/master/src/memory/retrieval/hyde/MemoryHydeRetriever.ts) prompts an LLM to generate a plausible memory the GMI *would* have stored about the query. The hypothesis embedding is then used as the search vector, because it sits closer to actual stored traces than a raw query like *"that deployment thing last week"*. The source comments explicitly tie this to the **generation effect** in cognitive science.
2. **Composite-scored vector query.** Each candidate gets a weighted score combining current strength, embedding similarity, recency, emotional congruence with the user's mood, and importance. The default weights live in [`CognitiveMemoryManager`](https://github.com/framersai/agentos/blob/master/src/cognition/memory/CognitiveMemoryManager.ts) and can be overridden per policy.
3. **Spreading activation over the graph.** When a Neo4j graph backend is configured, the top-5 results seed a spreading-activation pass through [`GraphRAGEngine`](https://github.com/framersai/agentos/blob/master/src/memory/retrieval/graph/graphrag/GraphRAGEngine.ts). Connected memories get a boost; the result set is re-sorted; co-activation is recorded for Hebbian-style learning so frequently-co-recalled memories link tighter over time.
4. **(Optional) neural reranking.** When a Cohere or LLM-judge reranker is plugged in, the cognitive composite is blended 0.7 cognitive / 0.3 neural — preserving decay, mood, and graph signals while letting a cross-encoder catch what the bi-encoder missed.

This is the layer cake the GMI sits on top of. The point isn't that "GraphRAG fallback when semantic fails" — that's a marketing simplification. The point is that each retrieval is a composite query whose score blends multiple cognitive signals, and the graph and reranker enrich that composite when they're available.

## Personality, in practice

HEXACO sounds heavier than it is. The personality config is six numbers, encoded as a paragraph appended to the system prompt. That paragraph is what the LLM reads. There is no neural network "personality module" running in parallel.

What makes the trait values load-bearing is that the cognitive memory mechanisms read them directly. A high-emotionality GMI has higher involuntary-recall probability. A high-conscientiousness GMI consolidates more eagerly. A high-openness GMI gets a steeper novelty boost during schema encoding.

So the "personality" is two things stacked:

1. **Surface behavior** — how the GMI talks. This comes from the trait string in the prompt and is mediated entirely by the LLM's interpretation.
2. **Memory shape** — what the GMI remembers and forgets, and how confidently. This is enforced in code, independent of the LLM.

The first is interpretation. The second is mechanism. Both matter, but they're not the same thing, and conflating them is how you end up with prompt-engineered "personalities" that vanish on a model swap.

## Multi-GMI: agency

A single GMI is a mind. An **agency** is a set of GMIs collaborating on a goal. Agency is in [`src/agents/agency/`](https://github.com/framersai/agentos/tree/master/src/agents/agency):

- [`AgencyRegistry`](https://github.com/framersai/agentos/blob/master/src/agents/agency/AgencyRegistry.ts) — tracks active agencies and the GMIs they contain.
- [`AgencyMemoryManager`](https://github.com/framersai/agentos/blob/master/src/agents/agency/AgencyMemoryManager.ts) — shared memory across the agency's GMIs (separate from each GMI's private cognitive memory).
- [`AgentCommunicationBus`](https://github.com/framersai/agentos/blob/master/src/agents/agency/AgentCommunicationBus.ts) — the message channel GMIs use to coordinate.

Each GMI in an agency keeps its own persona, traits, and cognitive memory. The agency adds a coordination layer on top. When you write `agency({...agents})`, the runtime spins up the registry, wires up the communication bus, and lets the orchestration strategy (sequential, parallel, debate, hierarchical, review-loop, graph) decide who runs when.

When the strategy is `'hierarchical'` and `emergent.enabled` is true, the manager GMI also gets a [`spawn_specialist`](/features/emergent-capabilities) tool — synthesise a new specialist GMI mid-run when the static roster doesn't cover a sub-task. The synthesised GMI joins the live roster and becomes invokable as `delegate_to_<role>` on the manager's next turn. See [Emergent Capabilities](/features/emergent-capabilities) for the spec, runtime sequence, and tested rejection paths.

## Streaming output

`session.send()` returns a final reply. `session.stream()` returns an async iterable of typed chunks. The chunk types from [`IGMI.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/IGMI.ts):

```typescript
export enum GMIOutputChunkType {
  TEXT_DELTA,
  TOOL_CALL_REQUEST,
  REASONING_STATE_UPDATE,
  FINAL_RESPONSE_MARKER,
  ERROR,
  SYSTEM_MESSAGE,
  USAGE_UPDATE,
  LATENCY_REPORT,
  UI_COMMAND,
}
```

[`GMIChunkTransformer`](https://github.com/framersai/agentos/blob/master/src/api/runtime/GMIChunkTransformer.ts) maps these into the public [`AgentOSResponseChunkType`](https://github.com/framersai/agentos/blob/master/src/api/types/AgentOSResponse.ts). If you're building a UI on top of a GMI, you wire reactions to these types: stream the text deltas as they arrive, render tool calls as they fire, surface reasoning state if you're showing the GMI's thinking, finalize on the response marker. Memory formation events surface separately through the memory bridge.

## What the homepage diagram is and isn't

The seven-ring diagram on [agentos.sh](https://agentos.sh) is a visualization of *capabilities*, not architecture. The rings — channels, guardrails, tools, orchestration, memory, personality, LLM core — are useful as a mental model: the outer ones are surface area, the inner ones are cognitive substrate. They map roughly to actual collaborators in the source, but not one-to-one. The diagram exists to make a marketing point that lands in three seconds. The class structure exists to make the runtime maintainable. Both are doing different work.

If you came here looking for the seven layers as load-bearing architecture, you won't find them in the source. What you'll find is a delegation hub (the [`GMI`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMI.ts) class), a lifecycle manager ([`GMIManager`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMIManager.ts)), and the dozen specialized collaborators in the table above. That's the real shape.

## Where things live

Quick map for navigating the source:

- [`src/cognition/substrate/GMI.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMI.ts) — the class itself
- [`src/cognition/substrate/GMIManager.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMIManager.ts) — lifecycle
- [`src/cognition/substrate/personas/`](https://github.com/framersai/agentos/tree/master/src/cognition/substrate/personas) — persona definitions and loaders
- [`src/cognition/substrate/persona_overlays/`](https://github.com/framersai/agentos/tree/master/src/cognition/substrate/persona_overlays) — per-session persona overlays
- [`src/memory/mechanisms/`](https://github.com/framersai/agentos/tree/master/src/memory/mechanisms) — the eight cognitive mechanisms + persona drift
- [`src/memory/retrieval/`](https://github.com/framersai/agentos/tree/master/src/memory/retrieval) — semantic, HyDE, GraphRAG retrieval
- [`src/agents/agency/`](https://github.com/framersai/agentos/tree/master/src/agents/agency) — multi-GMI coordination
- [`src/api/`](https://github.com/framersai/agentos/tree/master/src/api) — the public `agent()`, `agency()`, `generateText()`, `streamText()` helpers

## What this means in practice

You can build perfectly functional agents on AgentOS without thinking about any of this. The `agent({...})` factory hides the GMI. `session.send(...)` hides the per-turn collaboration. The persona overlay system hides the trait propagation. The runtime works.

The moment a real production deployment surfaces a hard question — *why does my customer-support agent forget what the user said three turns ago? why does my high-extraversion persona give curt one-line replies under pressure? why is the memory layer pulling traces from a session that ended two days ago?* — the abstraction stops being an answer and starts being a question. That's when this page becomes useful. A GMI is a delegation hub. The collaborators are where the behavior actually lives. The seven-ring marketing diagram is a story; the source-tree map above is the source of truth. When you debug, you debug the collaborators.

## Further reading

- [System Architecture](/architecture/system-architecture) — full module layout and request lifecycle
- [Cognitive Memory](/features/cognitive-memory) — encoding, decay, and retrieval mechanics in depth
- [Adaptive Prompt Intelligence](/features/adaptive-prompt-intelligence) — the per-turn metaprompt loop the `MetapromptExecutor` runs, trigger types, presets, state surfaces, and cost numbers
- [Skills vs Tools vs Extensions](/architecture/skills-vs-tools-vs-extensions) — when each capability system applies
- [Emergent Capabilities](/features/emergent-capabilities) — runtime tool forging and `spawn_specialist` for multi-agent gap-filling
- [Guardrails](/features/guardrails) — how guardrails actually intercept tool calls and generation
- [LLM Providers](/architecture/llm-providers) — the eleven provider implementations and the OpenRouter fan-out

---

## References

### Cognitive architectures for language agents

- Sumers, T. R., Yao, S., Narasimhan, K., & Griffiths, T. L. (2023). [*Cognitive architectures for language agents.*](https://arxiv.org/abs/2309.02427) arXiv:2309.02427. — The CoALA framework AgentOS's memory taxonomy follows; episodic / semantic / procedural distinction at the language-agent layer.
- Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P., & Bernstein, M. S. (2023). [*Generative agents: Interactive simulacra of human behavior.*](https://arxiv.org/abs/2304.03442) arXiv:2304.03442. — Persona + memory + reflection at small scale; the "agent-of-mind" pattern that GMI productionizes.

### Personality structure

- Ashton, M. C., & Lee, K. (2007). [*Empirical, theoretical, and practical advantages of the HEXACO model of personality structure.*](https://journals.sagepub.com/doi/10.1207/S15327957PSPR0701_2) *Personality and Social Psychology Review*, 11(2), 150–166. — The six-factor HEXACO model the runtime applies.

### Memory mechanics referenced inline

The eight cognitive memory mechanisms enumerated in this page draw on classical cognitive-science papers documented in detail at [Cognitive Memory](/features/cognitive-memory#references). The most directly relevant for GMIs:

- Ebbinghaus, H. (1885). *Memory: A Contribution to Experimental Psychology.* — The decay curve `S(t) = S₀ · e^(-Δt / stability)` underpinning every trace's lifetime.
- Anderson, J. R. (1983). *A spreading activation theory of memory.* — ACT-R model behind the graph activation pass in retrieval.
- Hebb, D. O. (1949). *The Organization of Behavior: A Neuropsychological Theory.* — Co-retrieval edge strengthening.

### Implementation references

- [`src/cognition/substrate/GMI.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMI.ts) — the class itself
- [`src/cognition/substrate/GMIManager.ts`](https://github.com/framersai/agentos/blob/master/src/cognition/substrate/GMIManager.ts) — lifecycle
- [`src/api/types.ts`](https://github.com/framersai/agentos/blob/master/src/api/types.ts) — [`AgencyOptions`](https://github.com/framersai/agentos/blob/master/src/api/types.ts), [`AgencyStrategy`](https://github.com/framersai/agentos/blob/master/src/api/types.ts), [`EmergentConfig`](https://github.com/framersai/agentos/blob/master/src/api/types.ts), [`EmergentPlannerConfig`](https://github.com/framersai/agentos/blob/master/src/api/types.ts)
- [`src/agents/agency/`](https://github.com/framersai/agentos/tree/master/src/agents/agency) — multi-GMI coordination classes
- [`src/emergent/`](https://github.com/framersai/agentos/tree/master/src/emergent) — emergent tool and agent forge primitives
